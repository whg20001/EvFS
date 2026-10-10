import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { AgentRun, AppData, KnowledgePoint } from '@sanxing/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyData, openRepository } from './index.js';
import type { Repository } from './index.js';

const now = '2026-01-01T00:00:00.000Z';
function point(id = 'k1'): KnowledgePoint {
  return { id, title: 'Title', description: 'Description', sourceIds: [], understanding: '', version: 1, createdAt: now, updatedAt: now };
}
function run(): AgentRun {
  return { id: 'run1', status: 'pending', task: { kind: 'extract', recitation: { learned: '', unclear: '', application: '', topic: '' }, sources: [] }, sessionId: null, reviewSessionId: null, quizId: null, questionId: null, attempt: 0, attemptId: null, expectedVersion: 1, createdAt: now, startedAt: null, finishedAt: null, error: null, usage: null, reservationUsd: 0, promptVersion: 'v1' };
}
const repositories: Repository[] = [];
const directories: string[] = [];
async function open(path = ':memory:', mode: 'mock' | 'live' = 'mock') {
  const repository = await openRepository(path, mode);
  repositories.push(repository);
  return repository;
}
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'sanxing-database-'));
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.close()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('aggregate repository', () => {
  it('persists explicit preferences and isolates the tiny committed settings projection', async () => {
    const path = await directory(); const repository = await open(path);
    expect(await repository.learningPreferences!()).toBeUndefined();
    await repository.transact(data => { data.learningPreferences = { schedulingEnabled: true, promptCacheRetention: 'short' }; });
    const projected = await repository.learningPreferences!(); projected!.schedulingEnabled = false;
    expect(await repository.learningPreferences!()).toEqual({ schedulingEnabled: true, promptCacheRetention: 'short' });
    await expect(repository.transact(data => { data.learningPreferences!.schedulingEnabled = false; throw new Error('rollback'); })).rejects.toThrow('rollback');
    expect((await repository.learningPreferences!())!.schedulingEnabled).toBe(true);
    await repository.close(); const reopened = await open(path);
    expect(await reopened.learningPreferences!()).toEqual({ schedulingEnabled: true, promptCacheRetention: 'short' });
    const backup = JSON.parse(JSON.stringify(await reopened.read())); const restored = await open(); await restored.replace(backup);
    expect(await restored.learningPreferences!()).toEqual({ schedulingEnabled: true, promptCacheRetention: 'short' });
  });

  it('creates independent, complete initial aggregates', () => {
    const first = emptyData('mock');
    first.knowledge.k1 = point();
    expect(emptyData('mock').knowledge).toEqual({});
    expect(emptyData('live')).toMatchObject({ schemaVersion: 1, ownerId: 'local', revision: 0, mode: 'live' });
  });

  it('isolates reads, callback return values and retained draft references', async () => {
    const repository = await open();
    const returned = await repository.transact((data) => {
      data.knowledge.k1 = point();
      return data;
    });
    returned.knowledge.k1!.title = 'outside mutation';
    const first = await repository.read();
    expect(first.knowledge.k1!.title).toBe('Title');
    first.knowledge.k1!.sourceIds.push('outside');
    first.revision = 100;
    expect((await repository.read()).knowledge.k1!.sourceIds).toEqual([]);
    expect((await repository.read()).revision).toBe(1);
  });

  it('commits business state, task and receipt atomically and returns callback result', async () => {
    const repository = await open();
    const result = await repository.transact(async (data) => {
      data.knowledge.k1 = point();
      data.runs.run1 = run();
      data.receipts.command1 = { hash: 'hash', result: { id: 'k1' }, createdAt: now };
      await Promise.resolve();
      return 42;
    });
    expect(result).toBe(42);
    expect(await repository.read()).toMatchObject({ revision: 1, knowledge: { k1: point() }, runs: { run1: run() }, receipts: { command1: { result: { id: 'k1' } } } });
  });

  it('rolls back synchronous and asynchronous failures without poisoning the queue', async () => {
    const repository = await open();
    for (const asynchronous of [false, true]) {
      await expect(repository.transact((data) => {
        data.knowledge.k1 = point();
        data.runs.run1 = run();
        data.receipts.command1 = { hash: 'hash', result: null, createdAt: now };
        if (asynchronous) return Promise.reject(new Error('abort'));
        throw new Error('abort');
      })).rejects.toThrow('abort');
      expect(await repository.read()).toEqual(emptyData('mock'));
    }
    await repository.transact((data) => { data.knowledge.k1 = point(); });
    expect((await repository.read()).revision).toBe(1);
  });

  it('serializes concurrent writes and reads across async callbacks', async () => {
    const repository = await open();
    await repository.transact((data) => { data.knowledge.k1 = point(); });
    const operations = Array.from({ length: 24 }, (_, index) => repository.transact(async (data) => {
      const version = data.knowledge.k1!.version;
      await new Promise((resolve) => setTimeout(resolve, index % 3));
      data.knowledge.k1!.version = version + 1;
    }));
    const read = repository.read();
    await Promise.all(operations);
    expect((await read).knowledge.k1!.version).toBe(25);
    expect((await read).revision).toBe(25);
  });

  it('persists aggregate, revision and receipts across disk reopen', async () => {
    const path = join(await directory(), 'nested', 'database');
    let repository = await open(path);
    await repository.transact((data) => {
      data.knowledge.k1 = point();
      data.runs.run1 = run();
      data.receipts.command1 = { hash: 'hash', result: { ok: true }, createdAt: now };
    });
    const expected = await repository.read();
    await repository.close();
    repository = await open(path);
    expect(await repository.read()).toEqual(expected);
    await repository.transact((data) => { data.knowledge.k1!.version += 1; });
    expect((await repository.read()).revision).toBe(2);
  });

  it('rejects a different database mode without modifying existing data', async () => {
    const path = await directory();
    const repository = await open(path, 'mock');
    await repository.close();
    await expect(openRepository(path, 'live')).rejects.toThrow('mode mismatch');
    expect(await (await open(path, 'mock')).read()).toEqual(emptyData('mock'));
    const live = await open(':memory:', 'live');
    await expect(live.replace(emptyData('mock'))).rejects.toThrow('mode mismatch');
    expect((await live.read()).mode).toBe('live');
  });

  it('restores valid backups in one commit with a local monotonic revision', async () => {
    const repository = await open();
    await repository.transact(() => undefined);
    const backup = emptyData('mock');
    backup.revision = 50;
    backup.knowledge.k1 = point();
    const pending = repository.replace(backup);
    backup.knowledge.k1.title = 'mutated after replace call';
    await pending;
    expect((await repository.read()).knowledge.k1!.title).toBe('Title');
    expect((await repository.read()).revision).toBe(2);
    expect(backup.revision).toBe(50);
  });

  it('accepts legacy snapshots without model settings and restores only non-secret model selections', async () => {
    const repository = await open(); const legacy = emptyData('mock'); delete legacy.aiModel;
    await repository.replace(legacy); expect((await repository.read()).aiModel).toBeUndefined();
    const selection = { providerId: 'openai-codex', modelId: 'test-model', authMethod: 'oauth' as const, allowUnboundedOutput: true };
    await repository.transact(data => { data.aiModel = selection; });
    const backup = await repository.read(); await repository.replace(backup);
    expect((await repository.read()).aiModel).toEqual(selection);
    expect((await repository.read()).revision).toBeGreaterThan(backup.revision);
    const unsafe = { ...backup, aiModel: { ...selection, apiKey: 'must-never-be-saved' } };
    await expect(repository.replace(unsafe)).rejects.toThrow('Invalid aggregate');
    expect((await repository.read()).aiModel).toEqual(selection);
  });

  it('rejects invalid schema, owner, mode, entity maps, ids and lossy JSON restores', async () => {
    const repository = await open();
    const invalid: unknown[] = [
      { ...emptyData('mock'), schemaVersion: 2 },
      { ...emptyData('mock'), ownerId: 'another-user' },
      emptyData('live'),
      { ...emptyData('mock'), revision: -1 },
      { ...emptyData('mock'), runs: undefined },
      { ...emptyData('mock'), knowledge: [] },
      { ...emptyData('mock'), knowledge: { wrong: point() } },
      { ...emptyData('mock'), knowledge: { k1: { id: 'k1' } } },
      { ...emptyData('mock'), receipts: { key: { hash: 'h', createdAt: now } } },
      { ...emptyData('mock'), receipts: { key: { hash: 'h', result: { value: NaN }, createdAt: now } } },
      { ...emptyData('mock'), receipts: { key: { hash: 'h', result: new Date(), createdAt: now } } },
    ];
    for (const data of invalid) await expect(repository.replace(data as AppData)).rejects.toThrow();
    expect(await repository.read()).toEqual(emptyData('mock'));
  });

  it('accepts the contract’s optional undefined schedule.last_review without losing required fields', async () => {
    const repository = await open();
    await repository.transact((data) => {
      data.knowledge.k1 = point();
      data.cards.card1 = { id: 'card1', knowledgeId: 'k1', version: 1, createdAt: now, schedule: {
        due: now, stability: 0, difficulty: 0, elapsed_days: 0, scheduled_days: 0,
        reps: 0, lapses: 0, state: 0, learning_steps: 0, last_review: undefined,
      } };
    });
    const data = await repository.read();
    expect(data.cards.card1!.schedule.last_review).toBeUndefined();
    expect(data.cards.card1!.schedule.reps).toBe(0);
    expect(data.revision).toBe(1);
  });

  it('rejects identity and revision changes inside callbacks', async () => {
    const repository = await open();
    for (const mutate of [
      (data: AppData) => { data.mode = 'live'; },
      (data: AppData) => { data.ownerId = 'other'; },
      (data: AppData) => { data.revision += 1; },
    ]) await expect(repository.transact(mutate)).rejects.toThrow();
    expect(await repository.read()).toEqual(emptyData('mock'));
  });

  it('rejects nested operations instead of deadlocking', async () => {
    const repository = await open();
    await expect(repository.transact(() => repository.read())).rejects.toThrow('nested');
    await expect(repository.transact(() => repository.close())).rejects.toThrow('inside');
    expect((await repository.read()).revision).toBe(0);
  });

  it('drains pending operations before close and rejects later operations', async () => {
    const repository = await open();
    const transaction = repository.transact(async (data) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      data.knowledge.k1 = point();
      return 'committed';
    });
    const close = repository.close();
    expect(repository.close()).toBe(close);
    await expect(repository.read()).rejects.toThrow('closed');
    expect(await transaction).toBe('committed');
    await close;
  });

  it('rejects multiple simultaneous handles for the same disk directory', async () => {
    const path = await directory();
    const repository = await open(path);
    await expect(openRepository(join(path, '.'), 'mock')).rejects.toThrow('already open');
    await repository.close();
    expect((await (await open(path)).read()).revision).toBe(0);
  });

  it('fails closed on corrupt or missing aggregate rows, never reseeding them', async () => {
    const path = await directory();
    await (await open(path)).close();
    let raw = new PGlite(path);
    await raw.query("UPDATE app_aggregate SET data = jsonb_set(data, '{schemaVersion}', '2')");
    await raw.close();
    await expect(openRepository(path, 'mock')).rejects.toThrow('Invalid aggregate');
    raw = new PGlite(path);
    const rows = await raw.query<{ data: { schemaVersion: number } }>('SELECT data FROM app_aggregate');
    expect(rows.rows[0]!.data.schemaVersion).toBe(2);
    await raw.query('DELETE FROM app_aggregate');
    await raw.close();
    await expect(openRepository(path, 'mock')).rejects.toThrow('exactly one owner row');
  });

  it('rejects unknown migration versions without resetting', async () => {
    const path = await directory();
    await (await open(path)).close();
    const raw = new PGlite(path);
    await raw.query('UPDATE app_schema_version SET version = 99');
    await raw.close();
    await expect(openRepository(path, 'mock')).rejects.toThrow('Unsupported database schema version');
  });

  it('fails the CAS if the expected update does not affect exactly one row', async () => {
    const path = await directory();
    await (await open(path)).close();
    const raw = new PGlite(path);
    // Simulate a rejected write at the database boundary, not a JS mock.
    await raw.exec(`CREATE FUNCTION reject_aggregate_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER reject_update BEFORE UPDATE ON app_aggregate FOR EACH ROW EXECUTE FUNCTION reject_aggregate_update();`);
    await raw.close();
    const repository = await open(path);
    await expect(repository.transact((data) => { data.knowledge.k1 = point(); })).rejects.toThrow('revision conflict');
    expect(await repository.read()).toEqual(emptyData('mock'));
  });
});
