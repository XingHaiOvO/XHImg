import { basename } from 'node:path';
import { stat } from 'node:fs/promises';
import type { Context } from './context.js';
import { fail, id, type Actor } from './security.js';
import {
  imageWork,
  inspectImage,
  resolvePolicy,
  persistedActor,
  checkUpload,
  uploadLimit,
  fileHash,
  type MediaType,
} from './policies.js';
import { enqueueClassification, wantsClassification } from './organization.js';
import { inspectMp4 } from './video.js';

export interface UploadOptions {
  folderId?: string;
  visibility?: 'public' | 'private';
  storageId?: string;
  processing?: unknown;
  classify?: boolean;
  mediaType?: MediaType;
}
export function uploadIdentity(actor: Actor) {
  if (actor.type === 'anonymous') fail(401, 'UPLOAD_AUTH_REQUIRED', '请先授权上传');
  return { kind: actor.type, actorId: actor.type === 'admin' ? 'admin' : actor.key.id };
}
export function prepareUpload(ctx: Context, actor: Actor, options: UploadOptions) {
  const folderId = options.folderId || 'uncategorized',
    folder = ctx.folder(folderId);
  checkUpload(ctx, actor, folderId, options.storageId);
  const storageId =
    options.storageId ||
    folder.storage_id ||
    ctx.db.one('SELECT id FROM storage_backends WHERE is_default=1')?.id;
  if (
    !storageId ||
    !ctx.db.one('SELECT id FROM storage_backends WHERE id=? AND enabled=1', storageId)
  )
    fail(503, 'STORAGE_DISABLED', '目标存储不可用');
  const video = options.mediaType === 'video';
  const policy = resolvePolicy(ctx, folderId, video ? undefined : options.processing);
  if (video) policy.enabled = false;
  const classify = !video && wantsClassification(ctx, actor, options.classify, !!options.folderId);
  return {
    folderId,
    storageId,
    policy,
    classify,
    visibility: options.visibility ?? 'private',
    ...uploadIdentity(actor),
  };
}
export async function acceptFile(
  ctx: Context,
  path: string,
  name: string,
  actor: Actor,
  options: UploadOptions,
  existingId?: string,
) {
  const prepared = prepareUpload(ctx, actor, options);
  const { size } = await stat(path);
  if (size > uploadLimit(ctx, options.mediaType))
    fail(413, 'FILE_TOO_LARGE', '文件超过当前上传上限');
  const info = await imageWork(async () =>
    options.mediaType === 'video'
      ? { ...(await inspectMp4(path)), size, checksum: await fileHash(path) }
      : inspectImage(path),
  );
  const shouldProcess = prepared.policy.enabled && info.format !== 'gif';
  const hold = shouldProcess || prepared.classify;
  const uploadId = existingId ?? id('upl'),
    imageId = existingId
      ? ctx.db.one('SELECT image_id FROM upload_sessions WHERE id=?', uploadId)!.image_id
      : id('img');
  const objectKey = `originals/${imageId}.${info.format}`,
    thumbKey = `thumbnails/${imageId}.webp`;
  if (!existingId)
    ctx.db.run(
      'INSERT INTO upload_sessions (id,image_id,actor_kind,actor_id,folder_id,storage_id,name,visibility,length,state,policy,classify,explicit_folder,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      uploadId,
      imageId,
      prepared.kind,
      prepared.actorId,
      prepared.folderId,
      prepared.storageId,
      basename(name).slice(0, 120),
      prepared.visibility,
      info.size,
      'validating',
      JSON.stringify(prepared.policy),
      +prepared.classify,
      +!!options.folderId,
      Date.now(),
      Date.now() + 86400_000,
    );
  const session = ctx.db.one('SELECT * FROM upload_sessions WHERE id=?', uploadId)!;
  if (existingId) {
    prepared.storageId = session.storage_id;
    if (!ctx.db.one('SELECT id FROM storage_backends WHERE id=? AND enabled=1', prepared.storageId))
      fail(503, 'STORAGE_DISABLED', '目标存储不可用');
  }
  if (session.expected_hash && session.expected_hash !== info.checksum)
    fail(400, 'FILE_CHECKSUM_MISMATCH', '完整文件校验失败');
  if (ctx.db.one('SELECT id FROM images WHERE id=?', imageId))
    return {
      async: hold,
      uploadId,
      image: ctx.imageInfo(ctx.image(imageId)),
    };
  ctx.db.run(
    'INSERT INTO upload_operations VALUES (?,?,?,?,?,?,?)',
    uploadId,
    prepared.storageId,
    objectKey,
    thumbKey,
    path,
    'writing',
    Date.now(),
  );
  try {
    const adapter = ctx.storage.byId(prepared.storageId);
    await adapter.put(objectKey, path, info.mime);
    if ((await adapter.head(objectKey)) !== info.size)
      fail(503, 'STORAGE_VERIFY_FAILED', '存储文件校验失败');
    const latest = persistedActor(ctx, prepared.kind, prepared.actorId);
    checkUpload(ctx, latest, prepared.folderId, options.storageId);
    if (prepared.classify && !ctx.access.has(latest, 'ai:classify'))
      fail(403, 'AUTH_CHANGED', '分类权限已失效');
    if (!ctx.db.one('SELECT id FROM storage_backends WHERE id=? AND enabled=1', prepared.storageId))
      fail(503, 'STORAGE_DISABLED', '上传期间存储已禁用');
    const folder = ctx.folder(prepared.folderId);
    if (
      ['canceled', 'expired'].includes(
        ctx.db.one('SELECT state FROM upload_sessions WHERE id=?', uploadId)!.state,
      )
    )
      fail(409, 'UPLOAD_CANCELED', '上传已取消或过期');
    ctx.db.tx(() => {
      ctx.db.run(
        'INSERT INTO images (id,folder_id,storage_id,object_key,thumb_key,name,format,mime,size,width,height,checksum,visibility,effective_visibility,created_at,state,publication_hold,processing_status,classification_status,source_key,source_size,source_format,source_checksum) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        imageId,
        folder.id,
        prepared.storageId,
        objectKey,
        thumbKey,
        basename(name).slice(0, 120),
        info.format,
        info.mime,
        info.size,
        info.width,
        info.height,
        info.checksum,
        prepared.visibility,
        prepared.visibility === 'public' && folder.effective_visibility === 'public'
          ? 'public'
          : 'private',
        Date.now(),
        shouldProcess ? 'processing' : 'ready',
        +hold,
        shouldProcess ? 'pending' : 'skipped',
        prepared.classify ? 'pending' : 'skipped',
        shouldProcess ? objectKey : null,
        shouldProcess ? info.size : 0,
        shouldProcess ? info.format : null,
        shouldProcess ? info.checksum : null,
      );
      if (shouldProcess)
        ctx.db.run(
          'INSERT INTO jobs (id,image_id,kind,payload,created_at) VALUES (?,?,?,?,?)',
          id('job'),
          imageId,
          'process',
          JSON.stringify({
            policy: prepared.policy,
            sessionId: uploadId,
            actorKind: prepared.kind,
            actorId: prepared.actorId,
            classify: prepared.classify,
            version: 1,
            newImage: true,
            organizationVersion: 1,
          }),
          Date.now(),
        );
      else {
        ctx.db.run(
          'INSERT INTO jobs (id,image_id,kind,created_at) VALUES (?,?,?,?)',
          id('job'),
          imageId,
          'thumbnail',
          Date.now(),
        );
        if (prepared.classify) enqueueClassification(ctx, imageId, latest, true, uploadId);
      }
      ctx.db.run(
        'UPDATE upload_sessions SET state=?,confirmed_offset=length WHERE id=?',
        shouldProcess ? 'processing' : prepared.classify ? 'classifying' : 'ready',
        uploadId,
      );
      ctx.db.run("UPDATE upload_operations SET state='committed' WHERE id=?", uploadId);
    });
    ctx.invalidate();
    return { async: !!hold, uploadId, image: ctx.imageInfo(ctx.image(imageId)) };
  } catch (error) {
    ctx.db.run(
      "UPDATE upload_operations SET state='abandoned' WHERE id=? AND state='writing'",
      uploadId,
    );
    ctx.db.run(
      "UPDATE upload_sessions SET state='failed',error='文件存储或校验失败' WHERE id=?",
      uploadId,
    );
    throw error;
  }
}
