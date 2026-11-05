import { mkdir, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import sharp from './image-processing.js';
import type { Context } from './context.js';
import type { Row } from './db.js';
import { fail, id, type Actor } from './security.js';
import {
  imageWork,
  inspectImage,
  cleanupObject,
  resolvePolicy,
  persistedActor,
  checkUpload,
  type ProcessingPolicy,
} from './policies.js';
import { enqueueClassification } from './organization.js';
import { imageFilename } from './image-filename.js';
import { assertNotMigrating } from './migrations.js';

export function queueProcessing(ctx: Context, image: Row, actor: Actor, override?: unknown) {
  assertNotMigrating(image);
  if (image.deleted_at || image.state === 'purging') fail(409, 'NOT_AVAILABLE', '图片已删除');
  if (image.format === 'gif') fail(409, 'GIF_PROCESSING_UNSUPPORTED', 'GIF 原样保存，不能重新处理');
  if (image.format === 'mp4')
    fail(409, 'VIDEO_PROCESSING_UNSUPPORTED', '视频原样保存，不能使用图片处理');
  if (
    image.processing_status !== 'failed' &&
    ctx.db.one(
      "SELECT id FROM jobs WHERE image_id=? AND kind='process' AND state<>'failed'",
      image.id,
    )
  )
    fail(409, 'PROCESSING', '已有图片处理任务');
  const policy = resolvePolicy(ctx, image.folder_id, override);
  policy.enabled = true;
  const version = image.content_version + 1;
  const classify =
    !!image.publication_hold &&
    ['pending', 'running', 'failed'].includes(image.classification_status);
  const sessionId = image.publication_hold
    ? ctx.db.one('SELECT id FROM upload_sessions WHERE image_id=?', image.id)?.id
    : undefined;
  ctx.db.tx(() => {
    ctx.db.run("DELETE FROM jobs WHERE image_id=? AND kind='process'", image.id);
    ctx.db.run(
      "UPDATE images SET content_version=?,processing_status='pending',organization_version=organization_version+1,classification_status=CASE WHEN ?=0 AND classification_status IN ('pending','running') THEN 'canceled' ELSE classification_status END WHERE id=?",
      version,
      +classify,
      image.id,
    );
    ctx.db.run(
      'INSERT INTO jobs (id,image_id,kind,payload,created_at) VALUES (?,?,?,?,?)',
      id('job'),
      image.id,
      'process',
      JSON.stringify({
        policy,
        version,
        newImage: !!image.publication_hold,
        classify,
        organizationVersion: image.organization_version + 1,
        sessionId,
        actorKind: actor.type === 'admin' ? 'admin' : 'key',
        actorId: actor.type === 'key' ? actor.key.id : 'admin',
      }),
      Date.now(),
    );
    if (sessionId)
      ctx.db.run("UPDATE upload_sessions SET state='processing',error=NULL WHERE id=?", sessionId);
  });
}
export async function processImageJob(ctx: Context, job: Row) {
  const image = ctx.image(job.image_id),
    payload = JSON.parse(job.payload),
    policy = payload.policy as ProcessingPolicy;
  if (image.deleted_at || image.content_version !== payload.version) return;
  ctx.db.run("UPDATE images SET processing_status='processing' WHERE id=?", image.id);
  const actor = persistedActor(ctx, payload.actorKind, payload.actorId);
  checkUpload(ctx, actor, image.folder_id);
  const adapter = ctx.storage.byId(image.storage_id),
    source = image.source_key ?? image.object_key;
  const work = join(ctx.config.dir, 'work', job.id);
  await mkdir(work, { recursive: true });
  const input = join(work, 'input'),
    output = join(work, 'output');
  let written: string | undefined;
  try {
    const body = await adapter.get(source);
    await pipeline(body.stream, createWriteStream(input));
    const result = await imageWork(async () => {
      const before = await inspectImage(input);
      if (before.checksum !== (image.source_checksum ?? image.checksum))
        fail(400, 'SOURCE_CORRUPT', '原文件内容与记录不符');
      const format = policy.targetFormat === 'keep' ? before.format : policy.targetFormat;
      let op = sharp(input, { limitInputPixels: 40_000_000, failOn: 'warning' })
        .rotate()
        .toColourspace('srgb');
      if (policy.maxWidth || policy.maxHeight)
        op = op.resize({
          width: policy.maxWidth ?? undefined,
          height: policy.maxHeight ?? undefined,
          fit: 'inside',
          withoutEnlargement: true,
        });
      if (format === 'jpg')
        op = op
          .flatten({ background: '#ffffff' })
          .jpeg({ quality: policy.compress ? policy.quality : 100 });
      else if (format === 'webp')
        op = op.webp(policy.compress ? { quality: policy.quality } : { lossless: true });
      else op = op.png({ compressionLevel: policy.compress ? 9 : 0 });
      await op.toFile(output);
      return inspectImage(output);
    });
    const key =
      result.checksum === (image.source_checksum ?? image.checksum)
        ? source
        : `processed/${image.id}/${job.id}.${result.format}`;
    if (key !== source) {
      written = key;
      cleanupObject(ctx, image.storage_id, key);
      await adapter.put(key, output, result.mime);
      if ((await adapter.head(key)) !== result.size)
        fail(503, 'STORAGE_VERIFY_FAILED', '处理结果写入失败');
    }
    const current = ctx.image(image.id);
    if (current.deleted_at || current.content_version !== payload.version)
      fail(409, 'STALE_JOB', '图片已修改，忽略旧处理结果');
    const currentActor = persistedActor(ctx, payload.actorKind, payload.actorId);
    checkUpload(ctx, currentActor, current.folder_id);
    const originalSize = image.source_key ? image.source_size : image.size,
      originalFormat = image.source_format ?? image.format,
      originalHash = image.source_checksum ?? image.checksum;
    const retain = policy.preserveOriginal && source !== key;
    const classify =
      !!payload.classify && current.organization_version === payload.organizationVersion;
    ctx.db.tx(() => {
      ctx.db.run(
        "UPDATE images SET name=?,object_key=?,format=?,mime=?,size=?,width=?,height=?,checksum=?,source_key=?,source_size=?,source_format=?,source_checksum=?,processing_status='completed',processing_info=?,state='ready',publication_hold=?,access_version=access_version+1,thumb_key=?,thumbnail_state='pending' WHERE id=?",
        imageFilename(current.name, result.format),
        key,
        result.format,
        result.mime,
        result.size,
        result.width,
        result.height,
        result.checksum,
        retain ? source : null,
        retain ? originalSize : 0,
        retain ? originalFormat : null,
        retain ? originalHash : null,
        JSON.stringify(policy),
        classify ? 1 : 0,
        `thumbnails/${image.id}-${payload.version}.webp`,
        image.id,
      );
      ctx.db.run(
        "INSERT INTO jobs (id,image_id,kind,created_at) VALUES (?,?,?,?) ON CONFLICT(image_id,kind) DO UPDATE SET state='pending',attempts=0,next_run=0,error=NULL",
        id('job'),
        image.id,
        'thumbnail',
        Date.now(),
      );
      if (classify) enqueueClassification(ctx, image.id, currentActor, true, payload.sessionId);
      if (payload.sessionId)
        ctx.db.run(
          'UPDATE upload_sessions SET state=?,error=NULL WHERE id=?',
          classify ? 'classifying' : 'ready',
          payload.sessionId,
        );
      ctx.db.run(
        'DELETE FROM cleanup_objects WHERE storage_id=? AND object_key=?',
        image.storage_id,
        key,
      );
      for (const old of new Set([image.object_key, image.thumb_key, source]))
        if (old !== key && !(retain && old === source)) cleanupObject(ctx, image.storage_id, old);
    });
    ctx.invalidate();
    written = undefined;
  } finally {
    // Registered objects remain in the cleanup journal until the DB switch commits.
    if (written) ctx.invalidate();
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
