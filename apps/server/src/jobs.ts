import sharp from './image-processing.js';
import { mkdir, rm, readdir, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { Context } from './context.js';
import { id } from './security.js';

export class Worker {
  busy = false;
  stopped = false;
  timer?: NodeJS.Timeout;
  constructor(public ctx: Context) {}
  start() {
    this.ctx.db.run("UPDATE jobs SET state='pending' WHERE state='running'");
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 1500);
    this.timer.unref();
    void this.tick().catch(() => {});
  }
  async tick() {
    if (this.busy || this.stopped) return;
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
        "SELECT * FROM jobs WHERE state='pending' AND next_run<=? ORDER BY created_at LIMIT 1",
        Date.now(),
      );
      if (job) {
        db.run("UPDATE jobs SET state='running' WHERE id=?", job.id);
        try {
          const image = db.one('SELECT * FROM images WHERE id=?', job.image_id);
          if (image) {
            const adapter = storage.byId(image.storage_id);
            if (job.kind === 'purge') {
              await adapter.delete(image.object_key);
              await adapter.delete(image.thumb_key);
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
                await sharp(tmp, { limitInputPixels: 40_000_000 })
                  .rotate()
                  .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
                  .webp({ quality: 80 })
                  .toFile(out);
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
          db.run('DELETE FROM jobs WHERE id=?', job.id);
        } catch {
          const attempts = job.attempts + 1;
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
        }
      }
      for (const obj of db.all(
        'SELECT * FROM cleanup_objects WHERE next_run<=? LIMIT 10',
        Date.now(),
      )) {
        try {
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
      const tmpDir = join(this.ctx.config.dir, 'tmp');
      await mkdir(tmpDir, { recursive: true });
      for (const name of await readdir(tmpDir)) {
        const file = join(tmpDir, name);
        if ((await stat(file)).mtimeMs < Date.now() - 86400_000) await rm(file, { force: true });
      }
    } finally {
      this.busy = false;
    }
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    while (this.busy) await new Promise((r) => setTimeout(r, 25));
  }
}
