import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { createReadStream } from 'node:fs';
import { mkdir, stat, rename, rm, open } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { pipeline, finished } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { fail, type Secrets } from './security.js';
import type { Store, Row } from './db.js';
import { pruneObjectDirectories } from './local-directories.js';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface DownloadOptions {
  expiresAt: number;
  mime: string;
  disposition: string;
}
export interface DownloadLink {
  url: string;
  expiresAt: number;
}

export interface Objects {
  put(key: string, path: string, mime: string, signal?: AbortSignal): Promise<void>;
  get(key: string, signal?: AbortSignal): Promise<{ stream: Readable; size: number }>;
  head(key: string, signal?: AbortSignal): Promise<number>;
  delete(key: string, signal?: AbortSignal): Promise<void>;
  test(): Promise<void>;
  presign?(key: string, options: DownloadOptions): Promise<DownloadLink>;
}
export class ObjectMissing extends Error {}
export class ObjectInUse extends Error {}
export class LocalObjects implements Objects {
  constructor(public root: string) {}
  path(key: string) {
    const path = resolve(this.root, key);
    if (!path.startsWith(resolve(this.root) + sep)) fail(400, 'INVALID_OBJECT', '无效对象路径');
    return path;
  }
  async put(key: string, source: string, _mime?: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const path = this.path(key);
    const tmp = path + '.writing';
    let output;
    for (let attempt = 0; ; attempt++) {
      await mkdir(dirname(path), { recursive: true });
      try {
        output = await open(tmp, 'wx');
        break;
      } catch (error: any) {
        if (error.code !== 'ENOENT' || attempt !== 0) {
          await pruneObjectDirectories(this.root, dirname(path));
          throw error;
        }
      }
    }
    try {
      await pipeline(createReadStream(source), output.createWriteStream(), { signal });
      signal?.throwIfAborted();
      await rename(tmp, path);
    } catch (e) {
      await rm(tmp, { force: true });
      await pruneObjectDirectories(this.root, dirname(path));
      throw e;
    }
  }
  async head(key: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    try {
      return (await stat(this.path(key))).size;
    } catch (e: any) {
      if (e.code === 'ENOENT') throw new ObjectMissing();
      throw e;
    }
  }
  async get(key: string, signal?: AbortSignal) {
    const size = await this.head(key, signal);
    return { stream: createReadStream(this.path(key), { signal }), size };
  }
  async delete(key: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    await rm(this.path(key), { force: true });
    await rm(this.path(key) + '.writing', { force: true });
    await pruneObjectDirectories(this.root, dirname(this.path(key)));
  }
  async test() {
    await mkdir(this.root, { recursive: true });
    const { access } = await import('node:fs/promises');
    const { constants } = await import('node:fs');
    await access(this.root, constants.R_OK | constants.W_OK);
  }
}
export const s3ConfigSchema = z.object({
  endpoint: z.url().refine((x) => ['https:', 'http:'].includes(new URL(x).protocol)),
  region: z.string().min(1),
  bucket: z.string().min(1),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  forcePathStyle: z.boolean().default(true),
});
export class S3Objects implements Objects {
  client: S3Client;
  constructor(public config: z.infer<typeof s3ConfigSchema>) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      maxAttempts: 2,
      requestHandler: { requestTimeout: 30000, connectionTimeout: 5000 },
    });
  }
  async put(key: string, path: string, mime: string, signal?: AbortSignal) {
    const size = (await stat(path)).size;
    const body = createReadStream(path, { signal });
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: body,
          ContentLength: size,
          ContentType: mime,
        }),
        { abortSignal: signal },
      );
    } finally {
      body.destroy();
      await finished(body).catch(() => {});
    }
  }
  async head(key: string, signal?: AbortSignal) {
    try {
      return (
        (
          await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }), {
            abortSignal: signal,
          })
        ).ContentLength ?? 0
      );
    } catch (e: any) {
      if (e.$metadata?.httpStatusCode === 404) throw new ObjectMissing();
      throw e;
    }
  }
  async get(key: string, signal?: AbortSignal) {
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
        { abortSignal: signal },
      );
      return { stream: out.Body as Readable, size: out.ContentLength ?? 0 };
    } catch (e: any) {
      if (e.$metadata?.httpStatusCode === 404) throw new ObjectMissing();
      throw e;
    }
  }
  async presign(key: string, options: DownloadOptions): Promise<DownloadLink> {
    const signingDate = new Date(Math.floor(Date.now() / 1000) * 1000);
    const expiresIn = Math.min(300, Math.floor((options.expiresAt - signingDate.getTime()) / 1000));
    if (expiresIn < 1) fail(404, 'LINK_EXPIRED', '链接已失效，请重新获取');
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ResponseContentType: options.mime,
        ResponseContentDisposition: options.disposition,
        ResponseCacheControl: 'private, no-store',
      }),
      { expiresIn, signingDate },
    );
    return { url, expiresAt: signingDate.getTime() + expiresIn * 1000 };
  }
  async delete(key: string, signal?: AbortSignal) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }), {
      abortSignal: signal,
    });
  }
  async test() {
    await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
  }
}
export class Storage {
  instances = new Map<string, Objects>();
  private tracked = new WeakMap<Objects, Map<string, Objects>>();
  private wrappers = new WeakMap<Objects, string>();
  private readers = new Map<string, number>();
  private deleting = new Set<string>();
  private originCache?: { key: string; origins: string[] };
  constructor(
    public db: Store,
    public secrets: Secrets,
    public dir: string,
  ) {}
  adapter(row: Row): Objects {
    const cached = this.instances.get(row.id);
    if (cached) return cached;
    const adapter =
      row.type === 'local'
        ? new LocalObjects(resolve(this.dir, 'objects', row.id))
        : new S3Objects(s3ConfigSchema.parse(this.secrets.decrypt(row.config)));
    this.instances.set(row.id, adapter);
    return adapter;
  }
  byId(storageId: string) {
    const row = this.db.one('SELECT * FROM storage_backends WHERE id=?', storageId);
    if (!row) fail(503, 'STORAGE_UNAVAILABLE', '存储配置不存在');
    const raw = this.adapter(row);
    if (this.wrappers.get(raw) === storageId) return raw;
    let entries = this.tracked.get(raw);
    if (!entries) {
      entries = new Map();
      this.tracked.set(raw, entries);
    }
    let wrapped = entries.get(storageId);
    if (!wrapped) {
      wrapped = new Proxy(raw, {
        get: (target, property) => {
          if (property === 'get')
            return async (key: string, signal?: AbortSignal) => {
              const ref = storageId + '\0' + key;
              if (this.deleting.has(ref)) throw new ObjectInUse('对象正在清理');
              this.readers.set(ref, (this.readers.get(ref) ?? 0) + 1);
              let released = false;
              const release = () => {
                if (released) return;
                released = true;
                const n = (this.readers.get(ref) ?? 1) - 1;
                if (n) this.readers.set(ref, n);
                else this.readers.delete(ref);
              };
              try {
                const body = await target.get(key, signal);
                body.stream.once('end', release).once('close', release).once('error', release);
                if (body.stream.destroyed || body.stream.readableEnded) release();
                return body;
              } catch (error) {
                release();
                throw error;
              }
            };
          if (property === 'delete')
            return async (key: string, signal?: AbortSignal) => {
              const ref = storageId + '\0' + key;
              if (this.readers.has(ref) || this.deleting.has(ref))
                throw new ObjectInUse('对象仍在读取');
              this.deleting.add(ref);
              try {
                await target.delete(key, signal);
              } finally {
                this.deleting.delete(ref);
              }
            };
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      entries.set(storageId, wrapped);
      this.wrappers.set(wrapped, storageId);
    }
    return wrapped;
  }
  async imageOrigins() {
    const rows = this.db.all("SELECT * FROM storage_backends WHERE type='s3' ORDER BY id");
    const key = JSON.stringify(rows.map((row) => [row.id, row.config]));
    if (this.originCache?.key === key) return this.originCache.origins;
    const origins = new Set<string>();
    for (const row of rows) {
      try {
        const link = await this.adapter(row).presign!('__xhimg_origin__', {
          expiresAt: Date.now() + 300_000,
          mime: 'application/octet-stream',
          disposition: 'inline',
        });
        const url = new URL(link.url);
        if (['http:', 'https:'].includes(url.protocol)) origins.add(url.origin);
      } catch {
        /* One unavailable configuration must not prevent opening the application. */
      }
    }
    const result = [...origins];
    this.originCache = { key, origins: result };
    return result;
  }
  safe(row: Row) {
    const { config, ...rest } = row;
    let options = {};
    if (row.type === 's3') {
      const { accessKeyId, secretAccessKey, ...publicConfig } = this.secrets.decrypt(config);
      options = publicConfig;
    }
    return { ...rest, config: options };
  }
}
