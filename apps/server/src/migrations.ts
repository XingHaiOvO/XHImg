import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Context, paging, params, query } from './context.js';
import type { Row } from './db.js';
import { fail, hash, id } from './security.js';

export const terminalMigrationStates = ['completed', 'completed_with_errors', 'failed', 'canceled'];
export const storageFingerprint = (row: Row) => hash(JSON.stringify([row.type, row.config]));
export function migrationTask(ctx: Context, taskId: string) {
  const row = ctx.db.one('SELECT * FROM storage_migrations WHERE id=?', taskId);
  if (!row) fail(404, 'NOT_FOUND', '迁移任务不存在');
  return row;
}
export function migrationSummary(ctx: Context, row: Row) {
  const { target_fingerprint, ...safe } = row;
  return {
    ...safe,
    selection: JSON.parse(row.selection),
    skipReasons: ctx.db.all(
      "SELECT error reason,COUNT(*) count FROM migration_items WHERE task_id=? AND state='skipped' GROUP BY error",
      row.id,
    ),
    ...ctx.db.one(
      "SELECT COUNT(*) retained_count,COALESCE(SUM(o.size),0) retained_bytes FROM migration_objects o JOIN migration_items i ON i.id=o.item_id WHERE i.task_id=? AND o.source_state IN ('retained','cleaning','failed')",
      row.id,
    ),
  };
}
export function migrationStorageUsed(ctx: Context, storageId: string) {
  return !!(
    ctx.db.one(
      "SELECT i.id FROM migration_items i JOIN storage_migrations t ON t.id=i.task_id WHERE (i.source_id=? OR t.target_id=?) AND i.state IN ('pending','copying','paused') LIMIT 1",
      storageId,
      storageId,
    ) ||
    ctx.db.one(
      "SELECT id FROM migration_objects WHERE (source_id=? AND source_state IN ('retained','cleaning','failed')) OR (target_id=? AND state IN ('writing','verified','cleanup')) LIMIT 1",
      storageId,
      storageId,
    )
  );
}
export function objectReferenced(
  ctx: Context,
  storageId: string,
  key: string,
  exceptImage?: string,
) {
  return !!ctx.db.one(
    'SELECT id FROM images WHERE storage_id=? AND (object_key=? OR source_key=? OR thumb_key=?) AND id<>? LIMIT 1',
    storageId,
    key,
    key,
    key,
    exceptImage ?? '',
  );
}
export function objectProtected(ctx: Context, storageId: string, key: string) {
  return (
    objectReferenced(ctx, storageId, key) ||
    !!ctx.db.one(
      "SELECT o.id FROM migration_objects o JOIN migration_items i ON i.id=o.item_id WHERE (o.source_id=? AND o.source_key=? AND o.source_state IN ('retained','cleaning','failed')) OR (o.target_id=? AND o.target_key=? AND o.state IN ('writing','verified') AND i.state IN ('pending','copying','paused')) LIMIT 1",
      storageId,
      key,
      storageId,
      key,
    )
  );
}
export function assertNotMigrating(image: Row) {
  if (image.migration_lock) fail(409, 'IMAGE_MIGRATING', '图片正在迁移，请完成后重试');
}
export function settleMigration(ctx: Context, taskId: string) {
  const t = migrationTask(ctx, taskId);
  if (!['queued', 'running'].includes(t.state)) return;
  if (
    ctx.db.one(
      "SELECT id FROM migration_items WHERE task_id=? AND state IN ('pending','copying') LIMIT 1",
      taskId,
    )
  )
    return;
  ctx.db.run(
    'UPDATE storage_migrations SET state=?,updated_at=? WHERE id=?',
    t.failed_count ? (t.success_count ? 'completed_with_errors' : 'failed') : 'completed',
    Date.now(),
    taskId,
  );
}
const selectionSchema = z
  .object({
    targetStorageId: z.string(),
    imageIds: z.array(z.string()).min(1).max(100).optional(),
    sourceStorageId: z.string().optional(),
    folderId: z.string().optional(),
    includeChildren: z.boolean().default(false),
    includeTrash: z.boolean().default(false),
  })
  .refine((b) => !!b.imageIds !== !!b.sourceStorageId, '请选择图片或来源存储其中一种范围')
  .refine((b) => !b.imageIds || !b.folderId, '勾选图片不能同时指定文件夹');
const snapshotFields = [
  'storage_id',
  'storage_version',
  'content_version',
  'object_key',
  'source_key',
  'thumb_key',
  'checksum',
  'source_checksum',
  'size',
  'source_size',
  'format',
  'source_format',
  'mime',
  'thumbnail_state',
];
export function createMigration(ctx: Context, input: unknown) {
  const b = selectionSchema.parse(input),
    target = ctx.db.one(
      'SELECT * FROM storage_backends WHERE id=? AND enabled=1',
      b.targetStorageId,
    );
  if (!target) fail(400, 'INVALID_TARGET', '请选择已启用的目标存储');
  if (
    b.sourceStorageId &&
    !ctx.db.one('SELECT id FROM storage_backends WHERE id=?', b.sourceStorageId)
  )
    fail(404, 'NOT_FOUND', '来源存储不存在');
  if (b.folderId) ctx.folder(b.folderId);
  const taskId = id('mig'),
    now = Date.now(),
    conditions: string[] = [],
    args: any[] = [];
  if (b.imageIds) {
    conditions.push('im.id IN (SELECT value FROM json_each(?))');
    args.push(JSON.stringify([...new Set(b.imageIds)]));
  } else {
    conditions.push('im.storage_id=?');
    args.push(b.sourceStorageId);
    if (!b.includeTrash) conditions.push('im.deleted_at IS NULL');
  }
  if (b.folderId) {
    conditions.push('im.folder_id IN (SELECT value FROM json_each(?))');
    args.push(
      JSON.stringify(b.includeChildren ? ctx.access.descendants(b.folderId) : [b.folderId]),
    );
  }
  const reason = `CASE WHEN im.storage_id=? THEN '已在目标存储' WHEN im.deleted_at IS NOT NULL AND ?=0 THEN '图片在回收站' WHEN im.state<>'ready' OR im.publication_hold=1 OR im.processing_status IN ('pending','processing') THEN '图片尚不可用或正在处理' WHEN im.thumbnail_state<>'ready' THEN '请先完成缩略图生成' WHEN im.migration_lock IS NOT NULL OR EXISTS(SELECT 1 FROM migration_items r WHERE r.image_id=im.id AND r.state IN ('pending','copying','paused')) THEN '已被其他迁移任务占用' WHEN EXISTS(SELECT 1 FROM jobs j WHERE j.image_id=im.id AND j.kind IN ('process','thumbnail','purge') AND j.state IN ('pending','running')) THEN '图片有未完成的文件任务' ELSE NULL END`;
  const snapshot = `json_object(${snapshotFields.map((f) => `'${f}',im.${f}`).join(',')})`;
  ctx.db.tx(() => {
    ctx.db.run(
      'INSERT INTO storage_migrations(id,target_id,target_name,target_fingerprint,selection,created_at,expires_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      taskId,
      target.id,
      target.name,
      storageFingerprint(target),
      JSON.stringify(b),
      now,
      now + 1800_000,
      now,
    );
    ctx.db.run(
      `INSERT INTO migration_items(id,task_id,image_id,name,source_id,source_name,snapshot,estimated_bytes,state,error,created_at) SELECT 'mit_'||lower(hex(randomblob(12))),?,im.id,im.name,im.storage_id,s.name,${snapshot},im.size+CASE WHEN im.source_key IS NOT NULL AND im.source_key<>im.object_key THEN im.source_size ELSE 0 END,CASE WHEN (${reason}) IS NULL THEN 'draft' ELSE 'skipped' END,${reason},? FROM images im JOIN storage_backends s ON s.id=im.storage_id WHERE ${conditions.join(' AND ')}`,
      taskId,
      b.targetStorageId,
      +b.includeTrash,
      b.targetStorageId,
      +b.includeTrash,
      now,
      ...args,
    );
    for (const imageId of b.imageIds ?? []) {
      if (
        !ctx.db.one(
          'SELECT id FROM migration_items WHERE task_id=? AND image_id=?',
          taskId,
          imageId,
        )
      )
        ctx.db.run(
          "INSERT INTO migration_items(id,task_id,image_id,name,source_name,snapshot,state,error,created_at) VALUES (?,?,?,?,?,'{}','skipped','图片不存在',?)",
          id('mit'),
          taskId,
          imageId,
          imageId,
          '',
          now,
        );
    }
    ctx.db.run(
      "UPDATE storage_migrations SET estimated_bytes=(SELECT COALESCE(SUM(estimated_bytes),0) FROM migration_items WHERE task_id=? AND state='draft') WHERE id=?",
      taskId,
      taskId,
    );
  });
  return migrationSummary(ctx, migrationTask(ctx, taskId));
}
export function migrationAction(ctx: Context, taskId: string, action: string) {
  const task = migrationTask(ctx, taskId),
    now = Date.now();
  ctx.db.tx(() => {
    if (action === 'start') {
      if (task.state !== 'draft' || task.expires_at <= now)
        fail(409, 'DRAFT_EXPIRED', '草稿已失效，请重新预览');
      const target = ctx.db.one(
        'SELECT * FROM storage_backends WHERE id=? AND enabled=1',
        task.target_id,
      );
      if (!target || storageFingerprint(target) !== task.target_fingerprint)
        fail(409, 'TARGET_CHANGED', '目标连接已变化，请重新预览');
      ctx.db.run(
        "UPDATE migration_items SET state='skipped',error='已被其他迁移任务占用' WHERE task_id=? AND state='draft' AND EXISTS(SELECT 1 FROM migration_items r WHERE r.image_id=migration_items.image_id AND r.task_id<>? AND r.state IN ('pending','copying','paused'))",
        taskId,
        taskId,
      );
      if (!ctx.db.one("SELECT id FROM migration_items WHERE task_id=? AND state='draft'", taskId))
        fail(409, 'NO_CANDIDATES', '没有可迁移图片，请重新选择范围');
      ctx.db.run(
        "UPDATE migration_items SET state='pending' WHERE task_id=? AND state='draft'",
        taskId,
      );
      ctx.db.run(
        "UPDATE storage_migrations SET state='queued',error=NULL,updated_at=? WHERE id=?",
        now,
        taskId,
      );
    } else if (action === 'pause') {
      if (!['queued', 'running'].includes(task.state))
        fail(409, 'INVALID_STATE', '任务当前不能暂停');
      ctx.db.run(
        "UPDATE migration_items SET state='paused' WHERE task_id=? AND state='pending'",
        taskId,
      );
      const busy = ctx.db.one(
        "SELECT id FROM migration_items WHERE task_id=? AND state='copying'",
        taskId,
      );
      ctx.db.run(
        'UPDATE storage_migrations SET state=?,updated_at=? WHERE id=?',
        busy ? 'pausing' : 'paused',
        now,
        taskId,
      );
    } else if (action === 'resume' || action === 'retry') {
      if (
        (action === 'resume' && task.state !== 'paused') ||
        (action === 'retry' && !terminalMigrationStates.includes(task.state))
      )
        fail(409, 'INVALID_STATE', '任务当前不能继续或重试');
      const target = ctx.db.one(
        'SELECT * FROM storage_backends WHERE id=? AND enabled=1',
        task.target_id,
      );
      if (!target || storageFingerprint(target) !== task.target_fingerprint)
        fail(409, 'TARGET_CHANGED', '请恢复原目标存储连接');
      const state = action === 'resume' ? 'paused' : 'failed';
      ctx.db.run(
        `UPDATE migration_items SET state='skipped',error='已被其他迁移任务占用' WHERE task_id=? AND state=? AND EXISTS(SELECT 1 FROM migration_items r WHERE r.image_id=migration_items.image_id AND r.id<>migration_items.id AND r.state IN ('pending','copying','paused'))`,
        taskId,
        state,
      );
      if (!ctx.db.one('SELECT id FROM migration_items WHERE task_id=? AND state=?', taskId, state))
        fail(409, 'NO_CANDIDATES', '没有可继续或重试的图片');
      ctx.db.run(
        "UPDATE migration_items SET state='pending',attempts=0,next_run=0,error=NULL WHERE task_id=? AND state=?",
        taskId,
        state,
      );
      ctx.db.run(
        "UPDATE storage_migrations SET state='queued',error=NULL,updated_at=? WHERE id=?",
        now,
        taskId,
      );
    } else if (action === 'cancel') {
      if (!['draft', 'queued', 'running', 'paused', 'pausing'].includes(task.state))
        fail(409, 'INVALID_STATE', '任务当前不能取消');
      ctx.db.run(
        "UPDATE migration_items SET state='canceled',phase='canceled' WHERE task_id=? AND state IN ('draft','pending','paused')",
        taskId,
      );
      ctx.db.run(
        "UPDATE migration_objects SET state='cleanup',next_run=0 WHERE item_id IN (SELECT id FROM migration_items WHERE task_id=? AND state='canceled') AND state IN ('writing','verified')",
        taskId,
      );
      const busy = ctx.db.one(
        "SELECT id FROM migration_items WHERE task_id=? AND state='copying'",
        taskId,
      );
      ctx.db.run(
        'UPDATE storage_migrations SET state=?,updated_at=? WHERE id=?',
        busy ? 'canceling' : 'canceled',
        now,
        taskId,
      );
    } else if (action === 'cleanup') {
      if (!terminalMigrationStates.includes(task.state))
        fail(409, 'INVALID_STATE', '请先结束迁移任务后清理源副本');
      ctx.db.run(
        "UPDATE migration_objects SET source_state='cleaning',attempts=0,next_run=0,error=NULL WHERE item_id IN (SELECT id FROM migration_items WHERE task_id=? AND state='committed') AND source_state IN ('retained','failed')",
        taskId,
      );
      ctx.db.run(
        "UPDATE storage_migrations SET cleanup_state='cleaning',updated_at=? WHERE id=?",
        now,
        taskId,
      );
    }
  });
  if (action === 'pause' || action === 'cancel') ctx.migrationControl?.task(taskId);
  return migrationSummary(ctx, migrationTask(ctx, taskId));
}
export function registerMigrations(app: FastifyInstance, ctx: Context) {
  app.post('/api/v1/admin/storage-migrations', async (req, reply) => {
    const result = createMigration(ctx, req.body);
    reply.code(201);
    return result;
  });
  app.get('/api/v1/admin/storage-migrations', async (req) => {
    const p = paging(req);
    return {
      items: ctx.db
        .all(
          'SELECT * FROM storage_migrations ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?',
          p.limit,
          p.offset,
        )
        .map((t) => migrationSummary(ctx, t)),
      total: ctx.db.one('SELECT COUNT(*) n FROM storage_migrations')!.n,
      page: p.page,
      limit: p.limit,
    };
  });
  app.get('/api/v1/admin/storage-migrations/:id', async (req) =>
    migrationSummary(ctx, migrationTask(ctx, params(req).id!)),
  );
  app.get('/api/v1/admin/storage-migrations/:id/items', async (req) => {
    const t = migrationTask(ctx, params(req).id!),
      p = paging(req),
      state = query(req).state;
    const filter = state ? ' AND state=?' : '',
      args = state
        ? [
            t.id,
            z
              .enum([
                'draft',
                'pending',
                'copying',
                'paused',
                'committed',
                'failed',
                'skipped',
                'canceled',
              ])
              .parse(state),
          ]
        : [t.id];
    return {
      items: ctx.db.all(
        `SELECT id,image_id,name,source_name,state,phase,estimated_bytes,attempts,error FROM migration_items INDEXED BY ${state ? 'migration_items_task' : 'migration_items_pages'} WHERE task_id=?${filter} ORDER BY created_at,id LIMIT ? OFFSET ?`,
        ...args,
        p.limit,
        p.offset,
      ),
      total: ctx.db.one(`SELECT COUNT(*) n FROM migration_items WHERE task_id=?${filter}`, ...args)!
        .n,
      page: p.page,
      limit: p.limit,
    };
  });
  app.post('/api/v1/admin/storage-migrations/:id/:action', async (req) =>
    migrationAction(
      ctx,
      params(req).id!,
      z.enum(['start', 'pause', 'resume', 'cancel', 'retry', 'cleanup']).parse(params(req).action),
    ),
  );
}
