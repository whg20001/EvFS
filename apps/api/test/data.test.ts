import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { emptyData, openRepository } from '@sanxing/database';
import { PGlite } from '@electric-sql/pglite';
import type { AppData } from '@sanxing/contracts';
const exec = promisify(execFile);
const cli = (directory: string, args: string[]) => exec(process.execPath, ['--import', 'tsx', 'scripts/database.ts', ...args], { env: { ...process.env, AI_MODE: 'mock', DATA_DIR: directory } });

it('backup CLI roundtrips data and never auto-replays restored pending requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sanxing-backup-test-')); const directory = join(root, 'database'); const backup = join(root, 'backup.json');
  try {
    await cli(directory, ['migrate']);
    const repository = await openRepository(directory, 'mock');
    await repository.transact(data => {
      data.receipts.marker = { hash: 'hash', result: { text: '中文笔记与原始答案' }, createdAt: '2026-01-01T00:00:00.000Z' };
      data.runs.pending = { id: 'pending', status: 'pending', task: { kind: 'extract', recitation: { topic: '', learned: '待确认资料', unclear: '', application: '' }, sources: [] },
        sessionId: null, reviewSessionId: null, quizId: null, questionId: null, attempt: 0, attemptId: null, expectedVersion: 0,
        createdAt: '2026-01-01T00:00:00.000Z', startedAt: null, finishedAt: null, error: null, usage: null, reservationUsd: 0, promptVersion: 'learning-v1' };
    });
    await repository.close();
    await cli(directory, ['export', backup]);
    if (process.platform !== 'win32') expect((await stat(backup)).mode & 0o777).toBe(0o600);
    await expect(cli(directory, ['delete'])).rejects.toThrow('explicitly pass --confirm');
    await cli(directory, ['delete', '--confirm']);
    await expect(cli(directory, ['import', backup])).rejects.toThrow('explicitly pass --confirm');
    await cli(directory, ['import', backup, '--confirm']);
    const restored = await openRepository(directory, 'mock');
    try {
      const data = await restored.read(); expect(data.receipts.marker!.result).toEqual({ text: '中文笔记与原始答案' });
      expect(data.runs.pending!.status).toBe('failed'); expect(data.runs.pending!.error).toContain('BACKUP_RESTORED');
    } finally { await restored.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('can export a legacy database before upgrading its physical schema', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sanxing-pre-migration-'));
  const directory = join(root, 'legacy');
  const backup = join(root, 'before.json');
  try {
    const data = emptyData('mock');
    data.receipts.marker = { hash: 'legacy', result: { text: 'upgrade safety' }, createdAt: '2026-01-01T00:00:00.000Z' };
    const legacy = new PGlite(directory);
    try {
      await legacy.exec(`CREATE TABLE app_schema_version (id integer PRIMARY KEY, version integer NOT NULL);
        INSERT INTO app_schema_version VALUES (1, 1);
        CREATE TABLE app_aggregate (id text PRIMARY KEY, revision integer NOT NULL, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());`);
      await legacy.query('INSERT INTO app_aggregate (id, revision, data) VALUES ($1, $2, $3::jsonb)', ['local', 0, JSON.stringify(data)]);
    } finally { await legacy.close(); }
    await cli(directory, ['export', backup, '--before-migration']);
    expect(JSON.parse(await readFile(backup, 'utf8'))).toEqual(data);
    if (process.platform !== 'win32') expect((await stat(backup)).mode & 0o777).toBe(0o600);
    const inspection = new PGlite(directory);
    try {
      expect((await inspection.query<{ version: number }>('SELECT version FROM app_schema_version')).rows).toEqual([{ version: 1 }]);
      expect((await inspection.query<{ name: string | null }>("SELECT to_regclass('app_documents')::text AS name")).rows).toEqual([{ name: null }]);
    } finally { await inspection.close(); }
    await expect(cli(directory, ['export', backup, '--before-migration'])).rejects.toThrow('EEXIST');
    await expect(cli(directory, ['delete', '--confirm', '--before-migration'])).rejects.toThrow('only valid for export');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('backup CLI refuses overwrite, invalid restores and cross-mode restores', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sanxing-backup-test-')); const directory = join(root, 'database'); const backup = join(root, 'backup.json');
  try {
    await cli(directory, ['export', backup]);
    const original = await readFile(backup, 'utf8');
    await expect(cli(directory, ['export', backup])).rejects.toThrow('EEXIST'); expect(await readFile(backup, 'utf8')).toBe(original);
    const data = JSON.parse(original) as AppData; data.mode = 'live'; await writeFile(backup, JSON.stringify(data));
    await expect(cli(directory, ['import', backup, '--confirm'])).rejects.toThrow('mode mismatch');
    await writeFile(backup, '{}'); await expect(cli(directory, ['import', backup, '--confirm'])).rejects.toThrow('Invalid aggregate');
    const repository = await openRepository(directory, 'mock');
    try { expect((await repository.read()).revision).toBe(0); } finally { await repository.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
