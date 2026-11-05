import { z } from 'zod';
import type { Context } from './context.js';
import type { Actor } from './security.js';
import { fail } from './security.js';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import sharp from './image-processing.js';
import { inspectGif } from './gif.js';

export const policyPatch = z.object({
  enabled: z.boolean().optional(),
  compress: z.boolean().optional(),
  targetFormat: z.enum(['keep', 'jpg', 'png', 'webp']).optional(),
  quality: z.number().int().min(1).max(100).optional(),
  maxWidth: z.number().int().min(1).max(40000).nullable().optional(),
  maxHeight: z.number().int().min(1).max(40000).nullable().optional(),
  preserveOriginal: z.boolean().optional(),
});
export type ProcessingPolicy = Required<z.infer<typeof policyPatch>>;
export const defaultPolicy: ProcessingPolicy = {
  enabled: false,
  compress: true,
  targetFormat: 'keep',
  quality: 80,
  maxWidth: null,
  maxHeight: null,
  preserveOriginal: true,
};
export const uploadLimit = (ctx: Context) => ctx.db.setting('maxUploadMB', 100) * 1024 * 1024;
export function resolvePolicy(
  ctx: Context,
  folderId: string,
  override?: unknown,
): ProcessingPolicy {
  const folder = ctx.folder(folderId);
  return {
    ...defaultPolicy,
    ...ctx.db.setting('processing', {}),
    ...(folder.processing_policy ? JSON.parse(folder.processing_policy) : {}),
    ...policyPatch.parse(override ?? {}),
  };
}
export function persistedActor(ctx: Context, kind: string, actorId: string): Actor {
  if (kind === 'admin') return { type: 'admin', session: '' };
  const key = ctx.db.one('SELECT * FROM api_keys WHERE id=? AND revoked=0', actorId);
  if (!key || (key.expires && key.expires <= Date.now()))
    fail(403, 'AUTH_CHANGED', '上传密钥已失效');
  return {
    type: 'key',
    key,
    permissions: JSON.parse(key.permissions),
    grants: ctx.db.all('SELECT * FROM api_grants WHERE key_id=?', key.id),
  };
}
export function checkUpload(ctx: Context, actor: Actor, folderId: string, storageId?: string) {
  if (!ctx.access.has(actor, 'upload') || !ctx.access.scope(actor, folderId))
    fail(403, 'UPLOAD_FORBIDDEN', '没有目标文件夹的上传权限');
  if (storageId && !ctx.access.storage(actor, storageId))
    fail(403, 'STORAGE_FORBIDDEN', '没有指定存储的使用权限');
}
export async function fileHash(path: string) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
const MAX_IMAGE_PIXELS = 40_000_000;
export async function inspectImage(path: string) {
  const handle = await open(path, 'r');
  const signature = Buffer.alloc(6);
  try {
    await handle.read(signature);
  } finally {
    await handle.close();
  }
  const gif = ['GIF87a', 'GIF89a'].includes(signature.toString('latin1'))
    ? inspectGif(await readFile(path), MAX_IMAGE_PIXELS)
    : undefined;
  let metadata: sharp.Metadata | undefined;
  if (!gif) {
    try {
      metadata = await sharp(path, {
        limitInputPixels: MAX_IMAGE_PIXELS,
        animated: true,
        failOn: 'warning',
      }).metadata();
    } catch {
      fail(400, 'INVALID_IMAGE', '图片损坏或超过4000万像素');
    }
    if (!['jpeg', 'png', 'webp'].includes(metadata.format!))
      fail(415, 'UNSUPPORTED_FORMAT', '仅支持 JPG、PNG、WebP、GIF');
    if ((metadata.pages ?? 1) > 1) fail(415, 'ANIMATED_IMAGE', '仅 GIF 支持动画');
  }
  try {
    await sharp(path, {
      limitInputPixels: MAX_IMAGE_PIXELS,
      animated: !!gif && gif.pages > 1,
      failOn: 'warning',
    }).stats();
  } catch {
    fail(400, 'INVALID_IMAGE', '图片无法完整解码');
  }
  const format = gif ? 'gif' : metadata?.format === 'jpeg' ? 'jpg' : metadata!.format!;
  return {
    format,
    mime: format === 'jpg' ? 'image/jpeg' : `image/${format}`,
    width: gif?.width ?? metadata?.autoOrient?.width ?? metadata?.width ?? 0,
    height: gif?.height ?? metadata?.autoOrient?.height ?? metadata?.height ?? 0,
    size: (await stat(path)).size,
    checksum: await fileHash(path),
  };
}
// All CPU image operations share this gate, including upload validation.
let tail: Promise<unknown> = Promise.resolve();
export function imageWork<T>(work: () => Promise<T>): Promise<T> {
  const result = tail.then(work, work);
  tail = result.catch(() => {});
  return result;
}
export function cleanupObject(ctx: Context, storageId: string, key: string) {
  if (
    !ctx.db.one(
      'SELECT id FROM cleanup_objects WHERE storage_id=? AND object_key=?',
      storageId,
      key,
    )
  )
    ctx.db.run(
      'INSERT INTO cleanup_objects (id,storage_id,object_key) VALUES (?,?,?)',
      `cln_${createHash('sha256')
        .update(storageId + key)
        .digest('hex')
        .slice(0, 24)}`,
      storageId,
      key,
    );
}
