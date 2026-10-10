import { open, readFile, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

function code(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}
const busy = () => new Error('Storage directory is locked by another process. Stop the owning service before using this directory. Unknown lock files require manual inspection.');
async function stale(path: string) {
  let value: unknown;
  try { const text = await readFile(path, 'utf8'); if (text.length > 1024) return false; value = JSON.parse(text); } catch { return false; }
  if (!value || typeof value !== 'object' || !('pid' in value) || !('host' in value) || value.host !== hostname() || typeof value.pid !== 'number' || !Number.isInteger(value.pid) || value.pid < 1) return false;
  try { process.kill(value.pid, 0); return false; } catch (error) { return code(error) === 'ESRCH'; }
}

/** Shared local-filesystem ownership; only one cooperating process may own a directory. */
export async function acquireDirectoryLock(directory: string): Promise<() => Promise<void>> {
  const path = join(directory, '.sanxing.lock');
  const recoveryPath = join(directory, '.sanxing-recovery.lock');
  const token = randomUUID();
  let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (error) {
    if (code(error) !== 'EEXIST') throw error;
    let recovery;
    try { recovery = await open(recoveryPath, 'wx', 0o600); } catch { throw busy(); }
    try {
      // Serializing stale reclamation prevents one reclaimer from deleting a fresh lock.
      if (!await stale(path)) throw busy();
      await unlink(path);
      try { handle = await open(path, 'wx', 0o600); } catch { throw busy(); }
    } finally { await recovery.close(); await unlink(recoveryPath); }
  }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), token })); }
  catch (error) { await handle.close(); await unlink(path); throw error; }
  await handle.close();
  return async () => {
    const text = await readFile(path, 'utf8').catch(() => '');
    try { const value: unknown = JSON.parse(text); if (value && typeof value === 'object' && 'token' in value && value.token === token) await unlink(path); } catch { /* Never remove a different or damaged lock. */ }
  };
}
