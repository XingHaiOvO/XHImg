import sharp from './image-processing.js';
import { mkdir, rm, readdir, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { Context } from './context.js';
import { id, HttpError } from './security.js';
import { processImageJob } from './processing.js';
import { classificationJob, aiConfig, AIError } from './organization.js';
import { imageWork } from './policies.js';
import { finalizeUpload, expireResumable } from './resumable.js';
import { MigrationWorker, purgeMigrationCopies } from './migration-worker.js';
import { objectProtected } from './migrations.js';

export class Worker {
  busy = false;
  stopped = false;
  aiBusy = false;
  timer?: NodeJS.Timeout;
  migrations: MigrationWorker;
  constructor(public ctx: Context) {
    this.migrations = new MigrationWorker(ctx);
  }
  start() {
    this.ctx.db.run("UPDATE jobs SET state='pending' WHERE state='running'");
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 1500);
    this.timer.unref();
    void this.tick().catch(() => {});
  }
  async tick() {
    if (this.stopped) return;
    if (this.ctx.config.workers !== false) void this.migrations.tick().catch(() => {});
    const ai = this.aiTick();
    if (this.busy) return ai;
    this.busy = true;
    const { db, storage } = this.ctx;
    try {
      for (const op of db.all(
        "SELECT * FROM upload_operations WHERE state IN ('committed','abandoned') OR created_at<?",
        Date.now() - 3600_000,
      )) {
        if (op.state !== 'committed')
          db.tx(() => {
            for (const key of [op.object_key, op.thumb_key])
              db.run(
                'INSERT INTO cleanup_objects (id,storage_id,object_key) VALUES (?,?,?)',
                id('cln'),
                op.storage_id,
                key,
              );
            db.run('DELETE FROM upload_operations WHERE id=?', op.id);
          });
        else db.run('DELETE FROM upload_operations WHERE id=?', op.id);
        await rm(op.temp_path, { force: true });
      }
      const job = db.one(
        "SELECT * FROM jobs WHERE kind<>'classify' AND state='pending' AND next_run<=? AND (image_id IS NULL OR EXISTS(SELECT 1 FROM images WHERE id=jobs.image_id AND migration_lock IS NULL AND (deleted_at IS NULL OR jobs.kind='purge'))) ORDER BY created_at LIMIT 1",
        Date.now(),
      );
      if (job) {
        db.run("UPDATE jobs SET state='running' WHERE id=?", job.id);
        try {
          if (job.kind === 'finalize')
            await finalizeUpload(this.ctx, JSON.parse(job.payload).sessionId);
          const image = job.image_id
            ? db.one('SELECT * FROM images WHERE id=?', job.image_id)
            : undefined;
          if (image) {
            const adapter = storage.byId(image.storage_id);
            if (job.kind === 'process') {
              await processImageJob(this.ctx, job);
            } else if (job.kind === 'purge') {
              await purgeMigrationCopies(this.ctx, image);
              db.tx(() => {
                db.run('UPDATE folders SET cover_id=NULL WHERE cover_id=?', image.id);
                db.run('DELETE FROM images WHERE id=?', image.id);
              });
              this.ctx.invalidate();
            } else if (image.state === 'ready') {
              const tmp = join(this.ctx.config.dir, 'tmp', job.id),
                out = tmp + '.webp';
              await mkdir(join(this.ctx.config.dir, 'tmp'), { recursive: true });
              try {
                const object = await adapter.get(image.object_key);
                await pipeline(object.stream, createWriteStream(tmp));
                await imageWork(() =>
                  sharp(tmp, { limitInputPixels: 40_000_000 })
                    .rotate()
                    .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
                    .webp({ quality: 80 })
                    .toFile(out),
                );
                await adapter.put(image.thumb_key, out, 'image/webp');
                db.run("UPDATE images SET thumbnail_state='ready' WHERE id=?", image.id);
              } finally {
                // A cleanup failure must neither overwrite a successful thumbnail
                // nor mask the original processing error. The temp-file sweeper
                // retries leftover files independently.
                await Promise.allSettled([rm(tmp, { force: true }), rm(out, { force: true })]);
              }
            }
          }
          const latest = job.image_id
            ? db.one('SELECT * FROM images WHERE id=?', job.image_id)
            : undefined;
          if (
            job.kind === 'process' &&
            latest?.deleted_at &&
            ['pending', 'processing'].includes(latest.processing_status)
          )
            db.run(
              "UPDATE jobs SET state='pending',next_run=? WHERE id=?",
              Date.now() + 1500,
              job.id,
            );
          else db.run('DELETE FROM jobs WHERE id=?', job.id);
        } catch (error) {
          const attempts =
            error instanceof HttpError && error.statusCode < 500 ? 5 : job.attempts + 1;
          db.run(
            'UPDATE jobs SET state=?,attempts=?,next_run=?,error=? WHERE id=?',
            attempts >= 5 ? 'failed' : 'pending',
            attempts,
            Date.now() + Math.min(3600_000, 5000 * 2 ** attempts),
            '存储或图片处理失败，请检查存储后重试',
            job.id,
          );
          if (job.kind === 'thumbnail')
            db.run("UPDATE images SET thumbnail_state='failed' WHERE id=?", job.image_id);
          if (job.kind === 'process') {
            const payload = JSON.parse(job.payload);
            db.run(
              "UPDATE images SET processing_status='failed' WHERE id=? AND content_version=?",
              job.image_id,
              payload.version,
            );
            if (payload.sessionId)
              db.run(
                "UPDATE upload_sessions SET state='failed',error='图片处理失败，可重试或使用原图' WHERE id=?",
                payload.sessionId,
              );
          }
          if (job.kind === 'finalize')
            db.run(
              "UPDATE upload_sessions SET state='failed',error='文件校验或存储失败，请检查后重试' WHERE id=?",
              JSON.parse(job.payload).sessionId,
            );
        }
      }
      for (const obj of db.all(
        'SELECT * FROM cleanup_objects WHERE next_run<=? LIMIT 10',
        Date.now(),
      )) {
        try {
          if (objectProtected(this.ctx, obj.storage_id, obj.object_key)) continue;
          await storage.byId(obj.storage_id).delete(obj.object_key);
          db.run('DELETE FROM cleanup_objects WHERE id=?', obj.id);
        } catch {
          db.run(
            'UPDATE cleanup_objects SET attempts=attempts+1,next_run=?,error=? WHERE id=?',
            Date.now() + 60_000,
            '对象删除失败',
            obj.id,
          );
        }
      }
      db.run('DELETE FROM sessions WHERE expires<?', Date.now());
      await expireResumable(this.ctx);
      const tmpDir = join(this.ctx.config.dir, 'tmp');
      await mkdir(tmpDir, { recursive: true });
      for (const name of await readdir(tmpDir)) {
        const file = join(tmpDir, name);
        if ((await stat(file)).mtimeMs < Date.now() - 86400_000) await rm(file, { force: true });
      }
    } finally {
      this.busy = false;
    }
    await ai;
  }
  async aiTick() {
    if (this.aiBusy || this.stopped) return;
    const { db } = this.ctx;
    const job = db.one(
      "SELECT * FROM jobs WHERE kind='classify' AND state='pending' AND next_run<=? AND EXISTS(SELECT 1 FROM images WHERE id=jobs.image_id AND deleted_at IS NULL) ORDER BY created_at LIMIT 1",
      Date.now(),
    );
    if (!job) return;
    this.aiBusy = true;
    db.run("UPDATE jobs SET state='running' WHERE id=?", job.id);
    try {
      await classificationJob(this.ctx, job);
      const latest = db.one('SELECT * FROM images WHERE id=?', job.image_id);
      if (latest?.deleted_at && ['pending', 'running'].includes(latest.classification_status))
        db.run("UPDATE jobs SET state='pending',next_run=? WHERE id=?", Date.now() + 1500, job.id);
      else db.run('DELETE FROM jobs WHERE id=?', job.id);
    } catch (error) {
      const attempts = job.attempts + 1;
      const retry =
        error instanceof AIError && error.retryable && attempts <= aiConfig(this.ctx).retries;
      const message =
        error instanceof AIError ? error.safeMessage : '分类任务失败，请检查授权、模型或存储';
      db.run(
        'UPDATE jobs SET state=?,attempts=?,next_run=?,error=? WHERE id=?',
        retry ? 'pending' : 'failed',
        attempts,
        Date.now() +
          Math.max(error instanceof AIError ? error.retryAfter : 0, 5000 * 2 ** attempts),
        message,
        job.id,
      );
      const payload = JSON.parse(job.payload);
      db.run(
        'UPDATE images SET classification_status=? WHERE id=? AND organization_version=?',
        retry ? 'pending' : 'failed',
        job.image_id,
        payload.organizationVersion,
      );
      const current = db.one(
        'SELECT organization_version,content_version FROM images WHERE id=?',
        job.image_id,
      );
      if (
        payload.sessionId &&
        current?.organization_version === payload.organizationVersion &&
        current?.content_version === payload.contentVersion
      )
        db.run(
          'UPDATE upload_sessions SET state=?,error=? WHERE id=?',
          retry ? 'classifying' : 'failed',
          message,
          payload.sessionId,
        );
    } finally {
      this.aiBusy = false;
    }
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.migrations.stop();
    while (this.busy || this.aiBusy) await new Promise((r) => setTimeout(r, 25));
  }
}
