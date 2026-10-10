import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireDirectoryLock as acquireDatabaseLock } from '@sanxing/local-storage';
import { openRepository } from './index.js';

async function temporary() { return mkdtemp(join(tmpdir(), 'sanxing-lock-test-')); }
describe('local database process lock', () => {
  it('rejects an actual second process opening the same persistent database', async () => {
    const directory = await temporary(); const repository = await openRepository(directory, 'mock');
    try {
      const program = `import { openRepository } from '@sanxing/database'; try { const db = await openRepository(process.argv[1], 'mock'); await db.close(); process.exitCode=0; } catch(error) { console.log(error.message); process.exitCode=7; }`;
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program, directory], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', chunk => output += String(chunk)); child.stderr.on('data', chunk => output += String(chunk));
      const [code] = await once(child, 'close'); expect(code).toBe(7); expect(output).toContain('locked by another process');
    } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it('reclaims only a known dead local PID, then releases its own lock', async () => {
    const directory = await temporary();
    try {
      const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
      const pid = child.pid!; await once(child, 'close');
      await writeFile(join(directory, '.sanxing.lock'), JSON.stringify({ pid, host: hostname(), token: 'old' }));
      const release = await acquireDatabaseLock(directory);
      const value = JSON.parse(await readFile(join(directory, '.sanxing.lock'), 'utf8')) as { pid: number; token: string };
      expect(value.pid).toBe(process.pid); expect(value.token).not.toBe('old');
      await expect(acquireDatabaseLock(directory)).rejects.toThrow('locked');
      await release(); await expect(readFile(join(directory, '.sanxing.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('refuses a live child PID lock without touching either lock file', async () => {
    const directory = await temporary();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const closed = once(child, 'close');
    try {
      const lock = JSON.stringify({ pid: child.pid!, host: hostname(), token: 'live-child' });
      await writeFile(join(directory, '.sanxing.lock'), lock);
      await writeFile(join(directory, 'postmaster.pid'), 'do not touch');
      await expect(openRepository(directory, 'mock')).rejects.toThrow('locked by another process');
      expect(await readFile(join(directory, '.sanxing.lock'), 'utf8')).toBe(lock);
      expect(await readFile(join(directory, 'postmaster.pid'), 'utf8')).toBe('do not touch');
    } finally { child.kill('SIGKILL'); await closed; await rm(directory, { recursive: true, force: true }); }
  });
  it('recovers committed state after an actual process crash leaves both PGlite and application locks', async () => {
    const directory = await temporary();
    const program = `import { openRepository } from '@sanxing/database';
      const db = await openRepository(process.argv[1], 'mock');
      await db.transact(data => { data.receipts.crash = { hash: 'h', result: 'committed', createdAt: '2026-01-01T00:00:00.000Z' }; });
      console.log('READY'); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program, directory], { stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(child, 'close'); let output = ''; let errors = '';
    child.stderr.on('data', chunk => errors += String(chunk));
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('READY')) resolve(); });
        child.once('error', reject);
        child.once('close', code => reject(new Error(`Child exited before READY: ${code}: ${errors}`)));
      });
      expect(await readFile(join(directory, 'postmaster.pid'), 'utf8')).not.toBe('');
      expect(JSON.parse(await readFile(join(directory, '.sanxing.lock'), 'utf8')).pid).toBe(child.pid);
      child.kill('SIGKILL'); await closed;
      expect(await readFile(join(directory, 'postmaster.pid'), 'utf8')).not.toBe('');
      const recovered = await openRepository(directory, 'mock');
      try {
        expect(await recovered.revision()).toBe(1);
        expect((await recovered.read()).receipts.crash!.result).toBe('committed');
        await recovered.transact(() => undefined);
      } finally { await recovered.close(); }
      const reopened = await openRepository(directory, 'mock');
      try { expect(await reopened.revision()).toBe(2); } finally { await reopened.close(); }
    } finally { child.kill('SIGKILL'); await closed; await rm(directory, { recursive: true, force: true }); }
  });
  it('fails closed on an unknown lock and never deletes a replaced lock', async () => {
    const directory = await temporary(); const path = join(directory, '.sanxing.lock');
    try {
      await writeFile(path, ''); await expect(acquireDatabaseLock(directory)).rejects.toThrow('locked');
      await rm(path); const release = await acquireDatabaseLock(directory);
      await writeFile(path, JSON.stringify({ pid: process.pid, host: hostname(), token: 'another-owner' }));
      await release(); expect(await readFile(path, 'utf8')).toContain('another-owner');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
