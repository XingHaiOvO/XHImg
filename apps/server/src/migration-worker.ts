import { createWriteStream } from 'node:fs';
import { mkdir, rm, statfs, readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import type { Context } from './context.js';
import type { Row } from './db.js';
import { id } from './security.js';
import { ObjectMissing, ObjectInUse } from './storage.js';
import {
  migrationTask,
  objectReferenced,
  settleMigration,
  storageFingerprint,
} from './migrations.js';

export class MigrationError extends Error {
  constructor(
    message: string,
    public retryable = false,
    public skip = false,
    public space = false,
  ) {
    super(message);
  }
}
const mimeFor = (format: string) => (format === 'jpg' ? 'image/jpeg' : `image/${format}`);
const pointers = (image: Row) =>
  JSON.stringify([
    image.storage_id,
    image.storage_version,
    image.content_version,
    image.object_key,
    image.source_key,
    image.thumb_key,
    image.checksum,
    image.source_checksum,
  ]);
export function recoverMigrations(ctx: Context) {
  ctx.db.tx(() => {
    ctx.db.run(
      "UPDATE migration_items SET state='paused',phase='paused' WHERE state='copying' AND task_id IN (SELECT id FROM storage_migrations WHERE state='pausing')",
    );
    ctx.db.run(
      "UPDATE migration_items SET state='canceled',phase='canceled' WHERE state='copying' AND task_id IN (SELECT id FROM storage_migrations WHERE state='canceling')",
    );
    ctx.db.run("UPDATE migration_items SET state='pending',phase='waiting' WHERE state='copying'");
    ctx.db.run(
      "UPDATE storage_migrations SET state=CASE state WHEN 'running' THEN 'queued' WHEN 'pausing' THEN 'paused' WHEN 'canceling' THEN 'canceled' ELSE state END",
    );
    ctx.db.run('UPDATE images SET migration_lock=NULL WHERE migration_lock IS NOT NULL');
    ctx.db.run(
      "UPDATE migration_objects SET state='cleanup',next_run=0 WHERE state IN ('writing','verified') AND item_id IN (SELECT id FROM migration_items WHERE state IN ('failed','skipped','canceled'))",
    );
  });
}
export async function purgeMigrationCopies(ctx: Context, image: Row) {
  const refs = new Map<string, { storageId: string; key: string }>();
  const add = (sid: string | null, key: string | null) => {
    if (sid && key) refs.set(sid + '\0' + key, { storageId: sid, key });
  };
  for (const key of [image.object_key, image.source_key, image.thumb_key])
    add(image.storage_id, key);
  for (const o of ctx.db.all(
    'SELECT o.* FROM migration_objects o JOIN migration_items i ON i.id=o.item_id WHERE i.image_id=?',
    image.id,
  )) {
    if (o.source_state !== 'cleaned') add(o.source_id, o.source_key);
    if (o.state !== 'cleaned') add(o.target_id, o.target_key);
  }
  for (const { storageId, key } of refs.values()) {
    if (objectReferenced(ctx, storageId, key, image.id))
      throw new ObjectInUse('对象仍被其他图片引用');
    await ctx.storage.byId(storageId).delete(key);
  }
  ctx.db.tx(() => {
    ctx.db.run(
      "UPDATE migration_objects SET state='cleaned',source_state='cleaned',error=NULL WHERE item_id IN (SELECT id FROM migration_items WHERE image_id=?)",
      image.id,
    );
    ctx.db.run(
      "UPDATE migration_items SET state='canceled',error='图片已彻底删除',phase='canceled' WHERE image_id=? AND state<>'committed'",
      image.id,
    );
  });
}
export class MigrationWorker {
  busy = false;
  stopped = false;
  active?: { taskId: string; imageId: string; controller: AbortController };
  constructor(public ctx: Context) {
    ctx.migrationControl = {
      task: (taskId) => {
        if (this.active?.taskId === taskId) this.active.controller.abort();
      },
      image: (imageId) => {
        if (this.active?.imageId !== imageId) return;
        const image = ctx.db.one('SELECT * FROM images WHERE id=?', imageId),
          task = migrationTask(ctx, this.active.taskId);
        if (
          !image ||
          image.state === 'purging' ||
          (image.deleted_at && !JSON.parse(task.selection).includeTrash)
        )
          this.active.controller.abort();
      },
    };
  }
  async stop() {
    this.stopped = true;
    this.active?.controller.abort();
    while (this.busy) await new Promise((r) => setTimeout(r, 25));
  }
  target(task: Row) {
    const row = this.ctx.db.one(
      'SELECT * FROM storage_backends WHERE id=? AND enabled=1',
      task.target_id,
    );
    if (!row || storageFingerprint(row) !== task.target_fingerprint)
      throw new MigrationError('目标存储已停用或连接已变化');
    return this.ctx.storage.byId(row.id);
  }
  current(item: Row, task: Row) {
    const image = this.ctx.db.one('SELECT * FROM images WHERE id=?', item.image_id),
      snapshot = JSON.parse(item.snapshot);
    if (
      !image ||
      image.state !== 'ready' ||
      image.publication_hold ||
      (image.deleted_at && !JSON.parse(task.selection).includeTrash)
    )
      throw new MigrationError('图片已删除或当前不可用', false, true);
    if (pointers(image) !== pointers(snapshot))
      throw new MigrationError('图片内容或存储版本已变化，请重新预览', false, true);
    if (
      image.thumbnail_state !== 'ready' ||
      ['pending', 'processing'].includes(image.processing_status)
    )
      throw new MigrationError('图片正在处理或缩略图未就绪', false, true);
    if (image.migration_lock && image.migration_lock !== item.id)
      throw new MigrationError('图片正在其他迁移任务中', false, true);
    return image;
  }
  ensureObjects(item: Row, task: Row) {
    if (this.ctx.db.one('SELECT id FROM migration_objects WHERE item_id=?', item.id)) return;
    const s = JSON.parse(item.snapshot),
      refs = new Map<
        string,
        { roles: string[]; size: number | null; checksum: string | null; mime: string }
      >();
    for (const role of ['object_key', 'source_key', 'thumb_key']) {
      const key = s[role];
      if (!key) continue;
      const old = refs.get(key);
      if (old) {
        old.roles.push(role);
        continue;
      }
      refs.set(key, {
        roles: [role],
        size: role === 'thumb_key' ? null : role === 'source_key' ? s.source_size : s.size,
        checksum:
          role === 'thumb_key' ? null : role === 'source_key' ? s.source_checksum : s.checksum,
        mime:
          role === 'thumb_key'
            ? 'image/webp'
            : role === 'source_key'
              ? mimeFor(s.source_format)
              : s.mime,
      });
    }
    this.ctx.db.tx(() => {
      let n = 0;
      for (const [key, ref] of refs)
        this.ctx.db.run(
          'INSERT INTO migration_objects(id,item_id,source_id,source_key,target_id,target_key,roles,mime,size,checksum) VALUES (?,?,?,?,?,?,?,?,?,?)',
          id('mob'),
          item.id,
          item.source_id,
          key,
          task.target_id,
          `migrations/${item.id}/${++n}`,
          JSON.stringify(ref.roles),
          ref.mime,
          ref.size,
          ref.checksum,
        );
    });
  }
  async digest(
    storageId: string,
    key: string,
    expectedSize: number | null,
    expectedHash: string | null,
    signal?: AbortSignal,
  ) {
    const body = await this.ctx.storage.byId(storageId).get(key, signal);
    if (expectedSize !== null && body.size !== expectedSize) {
      body.stream.destroy();
      throw new MigrationError('对象大小校验失败');
    }
    let size = 0;
    const digest = createHash('sha256');
    await pipeline(
      body.stream,
      new Writable({
        write(chunk, _encoding, done) {
          size += chunk.length;
          if (size > body.size) {
            done(new MigrationError('对象返回内容超出声明长度'));
            return;
          }
          digest.update(chunk);
          done();
        },
      }),
      { signal },
    );
    const checksum = digest.digest('hex');
    if (size !== body.size || (expectedHash && checksum !== expectedHash))
      throw new MigrationError('对象内容校验失败');
    return { size, checksum };
  }
  async disk(size: number) {
    const space = await statfs(this.ctx.config.dir),
      reserved = this.ctx.db.one(
        "SELECT COALESCE(SUM(length-confirmed_offset),0) n FROM upload_sessions WHERE tus_metadata IS NOT NULL AND state IN ('created','uploading','received','validating')",
      )!.n;
    if (space.bavail * space.bsize < size + reserved + 512 * 1024 ** 2)
      throw new MigrationError('本地磁盘空间不足，任务已暂停', false, false, true);
  }
  async copyObject(item: Row, task: Row, object: Row, signal: AbortSignal) {
    const { db } = this.ctx;
    if (['verified', 'writing'].includes(object.state) && object.size !== null && object.checksum) {
      try {
        await this.digest(task.target_id, object.target_key, object.size, object.checksum, signal);
        db.run("UPDATE migration_objects SET state='verified',error=NULL WHERE id=?", object.id);
        return;
      } catch (error) {
        if (signal.aborted) throw error;
      }
    }
    signal.throwIfAborted();
    this.target(task);
    const source = await this.ctx.storage.byId(item.source_id).get(object.source_key, signal);
    let work: string | undefined;
    try {
      if (object.size !== null && source.size !== object.size)
        throw new MigrationError('来源对象大小与记录不符');
      await this.disk(source.size);
      signal.throwIfAborted();
      const root = resolve(this.ctx.config.dir, 'migration-work');
      work = resolve(root, item.id);
      if (!work.startsWith(root + sep)) throw new MigrationError('无效工作目录');
      await mkdir(work, { recursive: true });
      const path = join(work, 'object');
      db.run("UPDATE migration_items SET phase='copying' WHERE id=?", item.id);
      let size = 0;
      const digest = createHash('sha256');
      await pipeline(
        source.stream,
        new Transform({
          transform(chunk, _encoding, done) {
            size += chunk.length;
            if (size > source.size) {
              done(new MigrationError('来源对象超出声明长度'));
              return;
            }
            digest.update(chunk);
            done(null, chunk);
          },
        }),
        createWriteStream(path),
        { signal },
      );
      const checksum = digest.digest('hex');
      if (size !== source.size || (object.checksum && object.checksum !== checksum))
        throw new MigrationError('来源对象内容校验失败');
      signal.throwIfAborted();
      db.run(
        "UPDATE migration_objects SET state='writing',size=?,checksum=?,error=NULL WHERE id=?",
        size,
        checksum,
        object.id,
      );
      if (objectReferenced(this.ctx, task.target_id, object.target_key))
        throw new MigrationError('目标对象仍被有效图片引用');
      const target = this.target(task);
      await target.delete(object.target_key, signal);
      await target.put(object.target_key, path, object.mime, signal);
      db.run("UPDATE migration_items SET phase='verifying' WHERE id=?", item.id);
      await this.digest(task.target_id, object.target_key, size, checksum, signal);
      signal.throwIfAborted();
      db.run("UPDATE migration_objects SET state='verified' WHERE id=?", object.id);
    } finally {
      source.stream.destroy();
      if (work) await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }
  async run(item: Row) {
    const { ctx } = this,
      { db } = ctx,
      controller = new AbortController();
    const task = migrationTask(ctx, item.task_id);
    this.active = { taskId: task.id, imageId: item.image_id, controller };
    try {
      db.tx(() => {
        this.target(task);
        const image = this.current(item, task);
        if (
          db.one(
            "SELECT id FROM jobs WHERE image_id=? AND kind IN ('process','thumbnail','purge') AND state IN ('pending','running')",
            image.id,
          )
        )
          throw new MigrationError('图片有未完成的文件任务', false, true);
        db.run('UPDATE images SET migration_lock=? WHERE id=?', item.id, image.id);
        db.run(
          "UPDATE migration_items SET state='copying',phase='copying',error=NULL WHERE id=?",
          item.id,
        );
        db.run(
          "UPDATE storage_migrations SET state='running',updated_at=? WHERE id=?",
          Date.now(),
          task.id,
        );
      });
      this.ensureObjects(item, task);
      for (const object of db.all(
        'SELECT * FROM migration_objects WHERE item_id=? ORDER BY id',
        item.id,
      )) {
        controller.signal.throwIfAborted();
        this.current(item, task);
        await this.copyObject(item, task, object, controller.signal);
      }
      controller.signal.throwIfAborted();
      db.tx(() => {
        const latest = migrationTask(ctx, task.id);
        if (latest.state !== 'running') throw new MigrationError('任务控制状态已变化');
        this.target(latest);
        const image = this.current(item, latest);
        if (image.migration_lock !== item.id) throw new MigrationError('迁移锁已失效', false, true);
        const keys: Record<string, string | null> = {
          object_key: null,
          source_key: null,
          thumb_key: null,
        };
        for (const o of db.all('SELECT * FROM migration_objects WHERE item_id=?', item.id)) {
          if (o.state !== 'verified') throw new MigrationError('目标对象尚未通过校验');
          for (const role of JSON.parse(o.roles)) keys[role] = o.target_key;
        }
        db.run("UPDATE migration_items SET phase='switching' WHERE id=?", item.id);
        db.run(
          'UPDATE images SET storage_id=?,object_key=?,source_key=?,thumb_key=?,storage_version=storage_version+1,migration_lock=NULL WHERE id=?',
          task.target_id,
          keys.object_key,
          keys.source_key,
          keys.thumb_key,
          image.id,
        );
        db.run(
          "UPDATE migration_objects SET state='committed',source_state='retained',error=NULL WHERE item_id=?",
          item.id,
        );
        db.run(
          "UPDATE migration_items SET state='committed',phase='completed',error=NULL WHERE id=?",
          item.id,
        );
      });
      ctx.invalidate();
    } catch (error) {
      const latest = migrationTask(ctx, task.id),
        image = db.one('SELECT * FROM images WHERE id=?', item.image_id);
      const unavailable =
        !image ||
        image.state === 'purging' ||
        (image.deleted_at && !JSON.parse(task.selection).includeTrash);
      const controlled =
        controller.signal.aborted || ['pausing', 'canceling'].includes(latest.state);
      let state: string,
        phase = 'failed',
        message: string | null = null,
        nextRun = 0,
        attempts = item.attempts;
      if (unavailable) {
        state = 'skipped';
        message = '图片已删除或不在迁移范围';
      } else if (latest.state === 'canceling') {
        state = 'canceled';
        phase = 'canceled';
      } else if (latest.state === 'pausing' || (error instanceof MigrationError && error.space)) {
        state = 'paused';
        phase = 'paused';
        message = error instanceof MigrationError ? error.message : null;
      } else if (controlled && this.stopped) {
        state = 'pending';
        phase = 'waiting';
      } else {
        const permanent = error instanceof MigrationError || error instanceof ObjectMissing;
        const status = (error as any).$metadata?.httpStatusCode;
        const retryable =
          error instanceof ObjectInUse ||
          (!permanent && (!status || status === 429 || status >= 500));
        attempts++;
        state =
          error instanceof MigrationError && error.skip
            ? 'skipped'
            : retryable && attempts < 3
              ? 'pending'
              : 'failed';
        message =
          error instanceof MigrationError
            ? error.message
            : error instanceof ObjectMissing
              ? '来源或目标对象不存在'
              : '存储读写失败，请检查连接后重试';
        nextRun = Date.now() + (attempts === 1 ? 5000 : 30000);
      }
      db.tx(() => {
        db.run(
          'UPDATE images SET migration_lock=NULL WHERE id=? AND migration_lock=?',
          item.image_id,
          item.id,
        );
        db.run(
          'UPDATE migration_items SET state=?,phase=?,error=?,attempts=?,next_run=? WHERE id=?',
          state,
          phase,
          message,
          attempts,
          nextRun,
          item.id,
        );
        if (['failed', 'skipped', 'canceled'].includes(state))
          db.run(
            "UPDATE migration_objects SET state='cleanup',next_run=0 WHERE item_id=? AND state IN ('writing','verified')",
            item.id,
          );
        if (state === 'paused') {
          db.run(
            "UPDATE migration_items SET state='paused' WHERE task_id=? AND state='pending'",
            task.id,
          );
          db.run(
            "UPDATE storage_migrations SET state='paused',error=?,updated_at=? WHERE id=?",
            message,
            Date.now(),
            task.id,
          );
        } else if (latest.state === 'pausing')
          db.run(
            "UPDATE storage_migrations SET state=CASE WHEN EXISTS(SELECT 1 FROM migration_items WHERE task_id=? AND state='paused') THEN 'paused' ELSE 'queued' END,updated_at=? WHERE id=?",
            task.id,
            Date.now(),
            task.id,
          );
        else if (latest.state === 'canceling')
          db.run(
            "UPDATE storage_migrations SET state='canceled',updated_at=? WHERE id=?",
            Date.now(),
            task.id,
          );
        else if (controlled && this.stopped)
          db.run("UPDATE storage_migrations SET state='queued' WHERE id=?", task.id);
      });
    } finally {
      this.active = undefined;
      settleMigration(ctx, task.id);
    }
  }
  async verifyCurrent(image: Row) {
    if (
      image.migration_lock ||
      ['pending', 'processing'].includes(image.processing_status) ||
      image.state === 'purging'
    )
      throw new ObjectInUse('图片正在变更');
    if (image.state !== 'ready' || image.thumbnail_state !== 'ready')
      throw new MigrationError('当前图片或缩略图尚不可用，保留源副本');
    const seen = new Set<string>();
    for (const role of ['object_key', 'source_key', 'thumb_key']) {
      const key = image[role];
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const known =
        role === 'thumb_key'
          ? this.ctx.db.one(
              'SELECT size,checksum FROM migration_objects WHERE target_id=? AND target_key=? AND checksum IS NOT NULL LIMIT 1',
              image.storage_id,
              key,
            )
          : {
              size: role === 'source_key' ? image.source_size : image.size,
              checksum: role === 'source_key' ? image.source_checksum : image.checksum,
            };
      await this.digest(image.storage_id, key, known?.size ?? null, known?.checksum ?? null);
    }
  }
  async cleanup() {
    const { ctx } = this,
      { db } = ctx;
    for (const o of db.all(
      "SELECT * FROM migration_objects WHERE state='cleanup' AND next_run<=? LIMIT 6",
      Date.now(),
    )) {
      try {
        if (!o.target_id) throw new MigrationError('清理目标存储配置不存在');
        if (objectReferenced(ctx, o.target_id, o.target_key))
          throw new ObjectInUse('目标对象仍被图片引用');
        await ctx.storage.byId(o.target_id).delete(o.target_key);
        db.run("UPDATE migration_objects SET state='cleaned',error=NULL WHERE id=?", o.id);
      } catch {
        db.run(
          'UPDATE migration_objects SET attempts=attempts+1,next_run=?,error=? WHERE id=?',
          Date.now() + 60000,
          '未提交目标对象清理失败',
          o.id,
        );
      }
    }
    const candidate = db.one(
      "SELECT o.item_id FROM migration_objects o WHERE o.source_state='cleaning' AND o.next_run<=? LIMIT 1",
      Date.now(),
    );
    if (candidate) {
      const item = db.one('SELECT * FROM migration_items WHERE id=?', candidate.item_id)!;
      const objects = db.all(
        "SELECT * FROM migration_objects WHERE item_id=? AND source_state='cleaning' AND next_run<=?",
        item.id,
        Date.now(),
      );
      try {
        const image = db.one('SELECT * FROM images WHERE id=?', item.image_id);
        if (!image) throw new MigrationError('当前图片记录不存在，源副本需人工检查');
        const version = pointers(image);
        await this.verifyCurrent(image);
        for (const o of objects) {
          const current = db.one('SELECT * FROM images WHERE id=?', item.image_id);
          if (
            !current ||
            pointers(current) !== version ||
            current.migration_lock ||
            current.state === 'purging'
          )
            throw new ObjectInUse('图片已发生变化');
          if (!o.source_id) throw new MigrationError('源存储配置不存在');
          if (objectReferenced(ctx, o.source_id, o.source_key))
            throw new ObjectInUse('源副本仍被有效图片引用');
          await ctx.storage.byId(o.source_id).delete(o.source_key);
          db.run("UPDATE migration_objects SET source_state='cleaned',error=NULL WHERE id=?", o.id);
        }
      } catch (error) {
        for (const o of objects) {
          if (
            db.one('SELECT source_state FROM migration_objects WHERE id=?', o.id)?.source_state !==
            'cleaning'
          )
            continue;
          const wait = error instanceof ObjectInUse,
            attempts = wait ? o.attempts : o.attempts + 1;
          const status = (error as any).$metadata?.httpStatusCode;
          const transient =
            wait ||
            (!(error instanceof MigrationError || error instanceof ObjectMissing) &&
              (!status || status === 429 || status >= 500));
          db.run(
            'UPDATE migration_objects SET source_state=?,attempts=?,next_run=?,error=? WHERE id=?',
            transient && attempts < 3 ? 'cleaning' : 'failed',
            attempts,
            Date.now() + (wait ? 1500 : 30000),
            wait ? '等待图片读取或变更结束' : '当前对象验证或源副本清理失败，副本仍保留',
            o.id,
          );
        }
      }
    }
    db.run(
      "UPDATE storage_migrations SET cleanup_state=CASE WHEN EXISTS(SELECT 1 FROM migration_objects o JOIN migration_items i ON i.id=o.item_id WHERE i.task_id=storage_migrations.id AND o.source_state='cleaning') THEN 'cleaning' WHEN EXISTS(SELECT 1 FROM migration_objects o JOIN migration_items i ON i.id=o.item_id WHERE i.task_id=storage_migrations.id AND o.source_state='failed') THEN 'partial_failed' WHEN EXISTS(SELECT 1 FROM migration_objects o JOIN migration_items i ON i.id=o.item_id WHERE i.task_id=storage_migrations.id AND o.source_state='retained') THEN 'retained' ELSE 'cleaned' END WHERE cleanup_state IN ('cleaning','partial_failed','retained') AND state<>'draft'",
    );
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    let continueQueue = false;
    try {
      await this.cleanupWork();
      const { db } = this.ctx;
      db.run(
        "UPDATE storage_migrations SET state='expired',error='草稿已过期，请重新预览' WHERE state='draft' AND expires_at<=?",
        Date.now(),
      );
      const task = db.one(
        "SELECT t.id FROM storage_migrations t WHERE t.state IN ('queued','running') AND EXISTS(SELECT 1 FROM migration_items i INDEXED BY migration_items_task WHERE i.task_id=t.id AND i.state='pending' AND i.next_run<=?) ORDER BY t.created_at,t.id LIMIT 1",
        Date.now(),
      );
      const item = task
        ? db.one(
            "SELECT * FROM migration_items INDEXED BY migration_items_task WHERE task_id=? AND state='pending' AND next_run<=? ORDER BY created_at,id LIMIT 1",
            task.id,
            Date.now(),
          )
        : undefined;
      if (item) {
        await this.run(item);
        continueQueue = ['committed', 'skipped'].includes(
          db.one('SELECT state FROM migration_items WHERE id=?', item.id)?.state,
        );
      }
      if (!this.stopped) await this.cleanup();
    } finally {
      this.busy = false;
      if (continueQueue && !this.stopped && this.ctx.config.workers !== false)
        setImmediate(() => {
          void this.tick().catch(() => {});
        });
    }
  }
  async cleanupWork() {
    const root = resolve(this.ctx.config.dir, 'migration-work');
    await mkdir(root, { recursive: true }).catch(() => {});
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !/^mit_[a-f\d]{24}$/.test(entry.name)) continue;
      const path = resolve(root, entry.name);
      if (!path.startsWith(root + sep)) continue;
      if (
        this.ctx.db.one('SELECT state FROM migration_items WHERE id=?', entry.name)?.state !==
        'copying'
      )
        await rm(path, { recursive: true, force: true }).catch(() => {});
    }
  }
}
