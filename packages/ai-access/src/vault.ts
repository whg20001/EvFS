import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuthOperationOptions, Credential, CredentialStore, OAuthCredential } from '@earendil-works/pi-ai';
import { acquireDirectoryLock } from '@sanxing/local-storage';
import { AiAccessError } from './errors.ts';

export const VAULT_FILENAME = 'credentials.enc';
interface Payload { version: 1; deviceId: string; credentials: Record<string, OAuthCredential> }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function copyOAuth(value: unknown): OAuthCredential {
  if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'oauth'
      || !('access' in value) || typeof value.access !== 'string' || !value.access
      || !('refresh' in value) || typeof value.refresh !== 'string' || !value.refresh
      || !('expires' in value) || typeof value.expires !== 'number' || !Number.isFinite(value.expires)) {
    throw new AiAccessError('storage', 500);
  }
  return structuredClone(value) as OAuthCredential;
}
function validate(value: unknown): Payload {
  if (!value || typeof value !== 'object') throw new Error();
  const p = value as Payload;
  if (p.version !== 1 || typeof p.deviceId !== 'string' || !uuid.test(p.deviceId)
      || !p.credentials || typeof p.credentials !== 'object' || Array.isArray(p.credentials)) throw new Error();
  for (const credential of Object.values(p.credentials)) copyOAuth(credential);
  return p;
}

/** The directory lock lives as long as this store. No plaintext export or ambient credential import. */
export async function openCredentialVault(options: { directory: string; secret: string }): Promise<{
  credentials: CredentialStore; deviceId: string; close(): Promise<void>;
}> {
  if (options.secret.length < 32) throw new AiAccessError('storage', 500);
  let release: (() => Promise<void>) | undefined;
  try {
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    await chmod(options.directory, 0o700);
    release = await acquireDirectoryLock(options.directory);
    const key = Buffer.from(hkdfSync('sha256', options.secret, 'sanxing.ai-access.v1', 'oauth-credential-vault', 32));
    const aad = Buffer.from('sanxing.ai-access.vault.v1');
    const path = join(options.directory, VAULT_FILENAME);
    async function persist(payload: Payload) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
      const bytes = Buffer.concat([Buffer.from('SXAV1'), nonce, cipher.getAuthTag(), ciphertext]);
      const temporary = join(options.directory, `.credentials-${randomUUID()}.tmp`);
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, path);
      } finally { await unlink(temporary).catch(() => undefined); }
    }
    let payload: Payload;
    let bytes: Buffer | undefined;
    try { bytes = await readFile(path); }
    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
    if (bytes) {
      if (bytes.length < 34 || bytes.subarray(0, 5).toString() !== 'SXAV1') throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(5, 17));
      decipher.setAAD(aad); decipher.setAuthTag(bytes.subarray(17, 33));
      payload = validate(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(33)), decipher.final()]).toString('utf8')));
      await chmod(path, 0o600);
    } else {
      payload = { version: 1, deviceId: randomUUID(), credentials: {} };
      await persist(payload);
    }
    let closed = false;
    let tail: Promise<unknown> = Promise.resolve();
    let closing: Promise<void> | undefined;
    function enqueue<T>(task: () => Promise<T>, operation?: AuthOperationOptions): Promise<T> {
      if (closed) return Promise.reject(new AiAccessError('closed', 503));
      const result = tail.then(async () => {
        // Cancellation applies before entering the mutation, never after token rotation starts.
        operation?.signal?.throwIfAborted();
        return task();
      });
      tail = result.catch(() => undefined);
      return result;
    }
    const credentials: CredentialStore = {
      read: (id, operation) => enqueue(async () => Object.hasOwn(payload.credentials, id) ? copyOAuth(payload.credentials[id]) : undefined, operation),
      list: (operation) => enqueue(async () => Object.keys(payload.credentials).map(providerId => ({ providerId, type: 'oauth' as const })), operation),
      modify: (id, fn, operation) => enqueue(async () => {
        const current = Object.hasOwn(payload.credentials, id) ? copyOAuth(payload.credentials[id]) : undefined;
        const next: Credential | undefined = await fn(current);
        if (next !== undefined) {
          const credential = copyOAuth(next);
          const updated = { ...payload, credentials: { ...payload.credentials, [id]: credential } };
          try { await persist(updated); } catch { throw new AiAccessError('storage', 500); }
          payload = updated;
        }
        return Object.hasOwn(payload.credentials, id) ? copyOAuth(payload.credentials[id]) : undefined;
      }, operation),
      delete: (id, operation) => enqueue(async () => {
        if (!Object.hasOwn(payload.credentials, id)) return;
        const updated = { ...payload, credentials: { ...payload.credentials } };
        delete updated.credentials[id];
        try { await persist(updated); } catch { throw new AiAccessError('storage', 500); }
        payload = updated;
      }, operation),
    };
    const unlock = release;
    return {
      credentials, deviceId: payload.deviceId,
      close() {
        if (!closing) {
          closed = true;
          closing = tail.then(async () => { key.fill(0); await unlock(); });
        }
        return closing;
      },
    };
  } catch {
    await release?.().catch(() => undefined);
    throw new AiAccessError('storage', 500);
  }
}
