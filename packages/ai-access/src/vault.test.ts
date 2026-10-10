import { mkdtemp, readFile, rm, stat, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { openCredentialVault, VAULT_FILENAME } from './vault.ts';
import type { OAuthCredential } from '@earendil-works/pi-ai';

const secret = 'test-session-secret-not-production-123456';
const token: OAuthCredential = { type: 'oauth', access: 'very-private-access-token', refresh: 'very-private-refresh-token', expires: 123,
  clientId: 'issued-client', scopes: ['scope-a'], accountId: 'account', extension: { nested: ['retained'] } };
const directories: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'ai-vault-')); directories.push(dir); return dir; }
async function vault(directory: string) { const store = await openCredentialVault({ directory, secret }); closers.push(() => store.close()); return store; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

describe('private credential vault', () => {
  it('encrypts full credentials, uses private permissions, preserves installation UUID on reopen', async () => {
    const dir = await directory(); const first = await vault(dir);
    await first.credentials.modify('openai', async () => token);
    const bytes = await readFile(join(dir, VAULT_FILENAME));
    expect(bytes.includes(Buffer.from(token.access))).toBe(false);
    expect(bytes.includes(Buffer.from(token.refresh))).toBe(false);
    expect(bytes.includes(Buffer.from(first.deviceId))).toBe(false);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, VAULT_FILENAME))).mode & 0o777).toBe(0o600);
    await first.close(); const second = await vault(dir);
    expect(second.deviceId).toBe(first.deviceId);
    expect(await second.credentials.read('openai')).toEqual(token);
    const read = await second.credentials.read('openai') as OAuthCredential;
    (read.extension as { nested: string[] }).nested.push('mutated');
    const list = await second.credentials.list(); (list[0] as { providerId: string }).providerId = 'changed';
    expect(await second.credentials.read('openai')).toEqual(token);
    expect(await second.credentials.list()).toEqual([{ providerId: 'openai', type: 'oauth' }]);
  });
  it('fails closed for wrong keys and damaged files without overwriting', async () => {
    const dir = await directory(); const first = await vault(dir); await first.close();
    const before = await readFile(join(dir, VAULT_FILENAME));
    await expect(openCredentialVault({ directory: dir, secret: 'another-secret-at-least-thirty-two-characters' })).rejects.toMatchObject({ code: 'storage' });
    expect(await readFile(join(dir, VAULT_FILENAME))).toEqual(before);
    await writeFile(join(dir, VAULT_FILENAME), 'corrupt');
    await expect(vault(dir)).rejects.toMatchObject({ code: 'storage' });
    expect(await readFile(join(dir, VAULT_FILENAME), 'utf8')).toBe('corrupt');
  });
  it('holds its process directory lock until close and rejects short secrets', async () => {
    const dir = await directory(); const first = await vault(dir);
    await expect(vault(dir)).rejects.toMatchObject({ code: 'storage' });
    await expect(openCredentialVault({ directory: dir, secret: 'short' })).rejects.toMatchObject({ code: 'storage' });
    await first.close(); await vault(dir);
  });
  it('serializes the whole awaited modify against delete; undefined means unchanged', async () => {
    const store = await vault(await directory()); const gate = deferred(); const entered = deferred();
    await store.credentials.modify('openai', async () => token);
    const refreshing = store.credentials.modify('openai', async current => {
      entered.resolve(); await gate.promise;
      return { ...current as OAuthCredential, refresh: 'rotated' };
    });
    await entered.promise;
    let deleted = false;
    const deleting = store.credentials.delete('openai').then(() => { deleted = true; });
    await Promise.resolve(); expect(deleted).toBe(false);
    gate.resolve(); await refreshing; await deleting;
    expect(await store.credentials.read('openai')).toBeUndefined();
    await store.credentials.modify('openai', async () => token);
    expect(await store.credentials.modify('openai', async current => { current!.type = 'api_key'; return undefined; })).toEqual(token);
  });
  it('does not discard a rotated token after an in-flight cancellation; close waits and rejects new work', async () => {
    const store = await vault(await directory()); const gate = deferred(); const entered = deferred(); const abort = new AbortController();
    const modifying = store.credentials.modify('openai', async () => { entered.resolve(); await gate.promise; return token; }, { signal: abort.signal });
    await entered.promise; abort.abort(); let closed = false;
    const closing = store.close().then(() => { closed = true; });
    await expect(store.credentials.read('openai')).rejects.toMatchObject({ code: 'closed' });
    expect(closed).toBe(false); gate.resolve(); await modifying; await closing;
  });
  it('keeps old memory and data if atomic replacement fails', async () => {
    const dir = await directory(); const store = await vault(dir);
    await store.credentials.modify('openai', async () => token);
    const file = join(dir, VAULT_FILENAME); const saved = `${file}.saved`;
    const bytes = await readFile(file); await rename(file, saved); await mkdir(file);
    await expect(store.credentials.modify('openai', async () => ({ ...token, access: 'new' }))).rejects.toMatchObject({ code: 'storage' });
    expect(await store.credentials.read('openai')).toEqual(token);
    expect(await readFile(saved)).toEqual(bytes);
    await rm(file, { recursive: true }); await rename(saved, file);
  });
});
