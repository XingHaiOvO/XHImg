import {
  randomBytes,
  createHash,
  scrypt as scryptCb,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
  createHmac,
} from 'node:crypto';
import { promisify } from 'node:util';
import type { Store, Row } from './db.js';
const scrypt = promisify(scryptCb);
export const token = () => randomBytes(32).toString('hex');
export const id = (prefix: string) => `${prefix}_${randomBytes(12).toString('hex')}`;
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export async function passwordHash(value: string) {
  const salt = token();
  const result = (await scrypt(value, salt, 64)) as Buffer;
  return `${salt}:${result.toString('hex')}`;
}
export async function passwordVerify(value: string, stored: string) {
  const [salt, digest] = stored.split(':');
  if (!salt || !digest) return false;
  return equal(((await scrypt(value, salt, 64)) as Buffer).toString('hex'), digest);
}
export class Secrets {
  key: Buffer;
  constructor(key: string) {
    if (!/^[a-f\d]{64}$/i.test(key))
      throw new Error('MASTER_KEY must contain exactly 64 hexadecimal characters');
    this.key = Buffer.from(key, 'hex');
  }
  encrypt(value: unknown) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((x) => x.toString('base64url')).join('.');
  }
  decrypt(value: string): any {
    const [iv, tag, data] = value.split('.').map((x) => Buffer.from(x, 'base64url'));
    if (!iv || !tag || !data) throw new Error('Invalid encrypted configuration');
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString());
  }
  sign(payload: object) {
    const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${data}.${createHmac('sha256', this.key).update(data).digest('base64url')}`;
  }
  verify(value: string): any {
    const [data, signature] = value.split('.');
    if (
      !data ||
      !signature ||
      !equal(signature, createHmac('sha256', this.key).update(data).digest('base64url'))
    )
      return null;
    try {
      const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
      return payload.expires > Date.now() ? payload : null;
    } catch {
      return null;
    }
  }
}
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function fail(status: number, code: string, message: string): never {
  throw new HttpError(status, code, message);
}
export type Actor =
  | { type: 'anonymous' }
  | { type: 'admin'; session: string }
  | { type: 'key'; key: Row; permissions: string[]; grants: Row[] };
export class Access {
  revision = 0;
  constructor(public db: Store) {}
  ancestors(folderId: string): string[] {
    return this.db
      .all(
        'WITH RECURSIVE a(id,parent_id) AS (SELECT id,parent_id FROM folders WHERE id=? UNION ALL SELECT f.id,f.parent_id FROM folders f JOIN a ON f.id=a.parent_id) SELECT id FROM a',
        folderId,
      )
      .map((x) => x.id);
  }
  descendants(folderId: string): string[] {
    return this.db
      .all(
        'WITH RECURSIVE d(id) AS (SELECT id FROM folders WHERE id=? UNION ALL SELECT f.id FROM folders f JOIN d ON f.parent_id=d.id) SELECT id FROM d',
        folderId,
      )
      .map((x) => x.id);
  }
  scope(actor: Actor, folderId: string) {
    if (actor.type === 'admin') return true;
    if (actor.type !== 'key') return false;
    return actor.grants.some(
      (g) =>
        g.kind === 'all' ||
        (g.kind === 'folder' &&
          (g.resource_id === folderId ||
            (g.descendants && this.ancestors(folderId).includes(g.resource_id)))),
    );
  }
  has(actor: Actor, permission: string) {
    return (
      actor.type === 'admin' || (actor.type === 'key' && actor.permissions.includes(permission))
    );
  }
  read(actor: Actor, image: Row) {
    if (image.deleted_at || image.state !== 'ready') return false;
    if (image.publication_hold && actor.type !== 'admin') return false;
    if (image.effective_visibility === 'public') return true;
    return (
      this.has(actor, 'read') &&
      this.has(actor, 'private:read') &&
      this.scope(actor, image.folder_id)
    );
  }
  service(actor: Actor, endpoint: Row) {
    return (
      actor.type === 'admin' ||
      (actor.type === 'key' &&
        this.has(actor, 'random') &&
        actor.grants.some(
          (g) =>
            g.kind === 'all' ||
            (g.kind === 'service' && g.resource_id === endpoint.id) ||
            (endpoint.kind === 'folder' && this.scope(actor, endpoint.folder_id)),
        ))
    );
  }
  storage(actor: Actor, storageId: string) {
    return (
      actor.type === 'admin' ||
      (actor.type === 'key' &&
        actor.grants.some(
          (g) => g.kind === 'all' || (g.kind === 'storage' && g.resource_id === storageId),
        ))
    );
  }
  refresh() {
    this.db.run(
      `WITH RECURSIVE tree(id,ev) AS (SELECT id,visibility FROM folders WHERE parent_id IS NULL UNION ALL SELECT f.id,CASE WHEN t.ev='private' THEN 'private' ELSE f.visibility END FROM folders f JOIN tree t ON f.parent_id=t.id) UPDATE folders SET effective_visibility=(SELECT ev FROM tree WHERE tree.id=folders.id)`,
    );
    this.db.run(
      `UPDATE images SET effective_visibility=CASE WHEN visibility='public' AND (SELECT effective_visibility FROM folders WHERE id=folder_id)='public' THEN 'public' ELSE 'private' END, access_version=access_version+1`,
    );
    this.revision++;
  }
}
export class Limiter {
  entries = new Map<string, { count: number; until: number }>();
  check(key: string, limit: number, duration = 60_000) {
    if (limit === 0) {
      this.entries.delete(key);
      return;
    }
    const now = Date.now();
    let entry = this.entries.get(key);
    if (!entry || entry.until <= now) {
      if (this.entries.size > 10_000)
        for (const [k, v] of this.entries) if (v.until <= now) this.entries.delete(k);
      if (this.entries.size > 20_000) fail(503, 'BUSY', '服务繁忙，请稍后重试');
      entry = { count: 0, until: now + duration };
      this.entries.set(key, entry);
    }
    if (++entry.count > limit) fail(429, 'RATE_LIMITED', '请求过于频繁，请稍后重试');
  }
}
