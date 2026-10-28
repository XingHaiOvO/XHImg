import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, rename, rm } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { fail, type Secrets } from './security.js';
import type { Store, Row } from './db.js';

export interface Objects {
  put(key: string, path: string, mime: string): Promise<void>;
  get(key: string): Promise<{ stream: Readable; size: number }>;
  head(key: string): Promise<number>;
  delete(key: string): Promise<void>;
  test(): Promise<void>;
}
export class ObjectMissing extends Error {}
export class LocalObjects implements Objects {
  constructor(public root: string) {}
  path(key: string) {
    const path = resolve(this.root, key);
    if (!path.startsWith(resolve(this.root) + sep)) fail(400, 'INVALID_OBJECT', '无效对象路径');
    return path;
  }
  async put(key: string, source: string) {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = path + '.writing';
    try {
      await pipeline(createReadStream(source), createWriteStream(tmp, { flags: 'wx' }));
      await rename(tmp, path);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }
  async head(key: string) {
    try {
      return (await stat(this.path(key))).size;
    } catch (e: any) {
      if (e.code === 'ENOENT') throw new ObjectMissing();
      throw e;
    }
  }
  async get(key: string) {
    const size = await this.head(key);
    return { stream: createReadStream(this.path(key)), size };
  }
  async delete(key: string) {
    await rm(this.path(key), { force: true });
    await rm(this.path(key) + '.writing', { force: true });
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
  async put(key: string, path: string, mime: string) {
    const size = (await stat(path)).size;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: createReadStream(path),
        ContentLength: size,
        ContentType: mime,
      }),
    );
  }
  async head(key: string) {
    try {
      return (
        (await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key })))
          .ContentLength ?? 0
      );
    } catch (e: any) {
      if (e.$metadata?.httpStatusCode === 404) throw new ObjectMissing();
      throw e;
    }
  }
  async get(key: string) {
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      return { stream: out.Body as Readable, size: out.ContentLength ?? 0 };
    } catch (e: any) {
      if (e.$metadata?.httpStatusCode === 404) throw new ObjectMissing();
      throw e;
    }
  }
  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }
  async test() {
    await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
  }
}
export class Storage {
  instances = new Map<string, Objects>();
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
    return this.adapter(row);
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
