import { lstat, opendir, rmdir } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

// Never traverse a link/junction, including any ancestor below the storage root.
async function plainDirectory(root: string, path: string): Promise<boolean> {
  if (path !== root && !path.startsWith(root + sep)) return false;
  for (let current = path; ; current = dirname(current)) {
    const info = await lstat(current).catch(() => undefined);
    if (!info?.isDirectory() || info.isSymbolicLink()) return false;
    if (current === root) return true;
  }
}

export async function pruneObjectDirectories(root: string, path: string) {
  root = resolve(root);
  let removed = 0;
  for (let current = resolve(path); current !== root; current = dirname(current)) {
    if (!(await plainDirectory(root, current))) break;
    try {
      await rmdir(current);
      removed++;
    } catch {
      break; // Nonempty, in use, or no longer accessible: object deletion still succeeded.
    }
  }
  return removed;
}

export async function cleanupLocalDirectories(dataDir: string) {
  const objects = resolve(dataDir, 'objects');
  let removed = 0;
  async function visit(root: string, path: string) {
    if (!(await plainDirectory(objects, path))) return;
    const entries = await opendir(path).catch(() => undefined);
    if (!entries) return;
    for await (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink())
        await visit(root, resolve(path, entry.name));
    }
    if (path !== root && (await plainDirectory(objects, path))) {
      try {
        await rmdir(path);
        removed++;
      } catch {
        // Empty directories are optional housekeeping; never remove their contents.
      }
    }
  }
  if (!(await plainDirectory(objects, objects))) return removed;
  const roots = await opendir(objects).catch(() => undefined);
  if (!roots) return removed;
  for await (const entry of roots) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const root = resolve(objects, entry.name);
      await visit(root, root);
    }
  }
  return removed;
}
