import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { AppData } from '@sanxing/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireDirectoryLock } from '@sanxing/local-storage';
import { emptyData, openRepository, readBackupWithoutMigration } from './index.js';
import type { Repository } from './index.js';
import * as validation from './validation.js';

const directories: string[] = [];
const repositories: Repository[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'sanxing-storage-v3-'));
  directories.push(path);
  return path;
}
async function open(path = ':memory:', mode: 'mock' | 'live' = 'mock') {
  const repository = await openRepository(path, mode);
  repositories.push(repository);
  return repository;
}
function fixture(): AppData {
  const data = emptyData('mock');
  data.revision = 7;
  data.documents.doc1 = {
    id: 'doc1', recitationId: 'r1', name: 'notes.txt', hash: 'hash', lineCount: 2,
    text: 'first line\n第二行', originalBase64: Buffer.from('first line\n第二行').toString('base64'),
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  data.runs.run1 = {
    id: 'run1', status: 'succeeded',
    task: { kind: 'extract', recitation: { learned: '长输入'.repeat(100), unclear: '', application: '', topic: '' }, sources: [] },
    sessionId: null, reviewSessionId: null, quizId: null, questionId: null, attempt: 1, attemptId: null, expectedVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z', startedAt: null, finishedAt: null, error: null, usage: null, reservationUsd: 0, promptVersion: 'v1',
  };
  return data;
}
async function legacy(path: string, data = fixture(), extraSql = '') {
  const raw = new PGlite(path);
  try {
    await raw.exec(`CREATE TABLE app_schema_version (id integer PRIMARY KEY CHECK (id = 1), version integer NOT NULL);
      INSERT INTO app_schema_version VALUES (1, 1);
      CREATE TABLE app_aggregate (id text PRIMARY KEY CHECK (id = 'local'), revision integer NOT NULL CHECK (revision >= 0), data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());`);
    await raw.query('INSERT INTO app_aggregate (id, revision, data) VALUES ($1, $2, $3)', ['local', data.revision, JSON.stringify(data)]);
    if (extraSql) await raw.exec(extraSql);
  } finally { await raw.close(); }
}
/** Physical v2: document bodies out of line, run tasks still inline. */
async function legacyV2(path: string, data = fixture(), extraSql = '') {
  const raw = new PGlite(path);
  try {
    await raw.exec(`CREATE TABLE app_schema_version (id integer PRIMARY KEY CHECK (id = 1), version integer NOT NULL);
      INSERT INTO app_schema_version VALUES (1, 2);
      CREATE TABLE app_aggregate (id text PRIMARY KEY CHECK (id = 'local'), revision integer NOT NULL CHECK (revision >= 0), data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE app_documents (id text PRIMARY KEY, text text NOT NULL, original_base64 text NOT NULL);`);
    const stored = { ...data, documents: Object.fromEntries(Object.entries(data.documents).map(([id, { text: _text, originalBase64: _original, ...metadata }]) => [id, metadata])) };
    await raw.query('INSERT INTO app_aggregate (id, revision, data) VALUES ($1, $2, $3)', ['local', data.revision, JSON.stringify(stored)]);
    for (const document of Object.values(data.documents)) {
      await raw.query('INSERT INTO app_documents VALUES ($1, $2, $3)', [document.id, document.text, document.originalBase64]);
    }
    if (extraSql) await raw.exec(extraSql);
  } finally { await raw.close(); }
}
const NO_TABLE = [{ name: null }];
async function table(raw: PGlite, name: string) {
  return (await raw.query('SELECT to_regclass($1) AS name', [name])).rows;
}
async function inspect<T>(path: string, fn: (raw: PGlite) => Promise<T>) {
  const raw = new PGlite(path);
  try { return await fn(raw); } finally { await raw.close(); }
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(repositories.splice(0).map((repository) => repository.close()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('backup without physical migration', () => {
  it('exports complete v1 data without changing its version, rows or tables', async () => {
    const path = await directory(); const expected = fixture(); await legacy(path, expected);
    expect(await readBackupWithoutMigration(path, 'mock')).toEqual(expected);
    // A second call also checks that the client and both ownership guards released.
    expect(await readBackupWithoutMigration(path, 'mock')).toEqual(expected);
    await inspect(path, async raw => {
      expect((await raw.query('SELECT version FROM app_schema_version')).rows).toEqual([{ version: 1 }]);
      expect((await raw.query<{ data: AppData }>('SELECT data FROM app_aggregate')).rows[0]!.data).toEqual(expected);
      expect((await raw.query("SELECT to_regclass('app_documents') AS name")).rows).toEqual([{ name: null }]);
      expect(await table(raw, 'app_run_tasks')).toEqual(NO_TABLE);
    });
    await expect(readFile(join(path, '.sanxing.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('exports complete v2 data without creating the v3 task table', async () => {
    const path = await directory(); const expected = fixture(); await legacyV2(path, expected);
    expect(await readBackupWithoutMigration(path, 'mock')).toEqual(expected);
    await inspect(path, async raw => {
      expect((await raw.query('SELECT version FROM app_schema_version')).rows).toEqual([{ version: 2 }]);
      expect(await table(raw, 'app_run_tasks')).toEqual(NO_TABLE);
    });
  });

  it('exports complete v3 data identical to read(), without incrementing revision', async () => {
    const path = await directory(); const repository = await open(path);
    await repository.replace(fixture()); const expected = await repository.read(); await repository.close();
    expect(await readBackupWithoutMigration(path, 'mock')).toEqual(expected);
    expect(await (await open(path)).read()).toEqual(expected);
  });

  it.each([1, 2, 3] as const)('rejects wrong mode on v%i without migration or retaining locks', async version => {
    const path = await directory();
    if (version === 1) await legacy(path);
    else if (version === 2) await legacyV2(path);
    else { const repository = await open(path); await repository.replace(fixture()); await repository.close(); }
    await expect(readBackupWithoutMigration(path, 'live')).rejects.toThrow('mode mismatch');
    await inspect(path, async raw => {
      expect((await raw.query('SELECT version FROM app_schema_version')).rows).toEqual([{ version }]);
    });
    expect((await readBackupWithoutMigration(path, 'mock')).documents).toEqual(fixture().documents);
  });

  it('rejects an open repository and an existing live PID directory lock', async () => {
    const path = await directory(); const repository = await open(path);
    await expect(readBackupWithoutMigration(path, 'mock')).rejects.toThrow('already open');
    await repository.close();
    const release = await acquireDirectoryLock(path);
    try {
      const before = await readFile(join(path, '.sanxing.lock'), 'utf8');
      await expect(readBackupWithoutMigration(path, 'mock')).rejects.toThrow('locked by another process');
      expect(await readFile(join(path, '.sanxing.lock'), 'utf8')).toBe(before);
    } finally { await release(); }
    expect(await readBackupWithoutMigration(path, 'mock')).toEqual(emptyData('mock'));
  });

  it('never initializes absent, empty, in-memory or unknown directories', async () => {
    const empty = await directory(); const absent = join(empty, 'does-not-exist');
    await expect(readBackupWithoutMigration(absent, 'mock')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(absent)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readBackupWithoutMigration(empty, 'mock')).rejects.toThrow('missing PG_VERSION');
    expect(await readdir(empty)).toEqual([]);
    await expect(readBackupWithoutMigration(':memory:', 'mock')).rejects.toThrow('existing database directory');
    await expect(readBackupWithoutMigration('', 'mock')).rejects.toThrow('existing database directory');
    await writeFile(join(empty, 'unknown'), 'keep me');
    await expect(readBackupWithoutMigration(empty, 'mock')).rejects.toThrow('missing PG_VERSION');
    expect(await readdir(empty)).toEqual(['unknown']);
  });

  it('does not seed an existing PGlite database without an application schema', async () => {
    const path = await directory(); await inspect(path, async raw => { await raw.query('SELECT 1'); });
    await expect(readBackupWithoutMigration(path, 'mock')).rejects.toThrow();
    await inspect(path, async raw => {
      expect((await raw.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows).toEqual([]);
    });
  });

  it.each([
    { name: 'unknown schema', sql: 'UPDATE app_schema_version SET version = 99' },
    { name: 'missing version row', sql: 'DELETE FROM app_schema_version' },
    { name: 'missing aggregate row', sql: 'DELETE FROM app_aggregate' },
    { name: 'bad inline document', sql: "UPDATE app_aggregate SET data = data #- '{documents,doc1,text}'" },
  ])('fails closed on v1 $name without upgrading', async ({ sql }) => {
    const path = await directory(); await legacy(path, fixture(), sql);
    const before = await inspect(path, async raw => ({
      versions: (await raw.query('SELECT * FROM app_schema_version')).rows,
      aggregate: (await raw.query('SELECT * FROM app_aggregate')).rows,
    }));
    await expect(readBackupWithoutMigration(path, 'mock')).rejects.toThrow();
    await inspect(path, async raw => {
      expect((await raw.query('SELECT * FROM app_schema_version')).rows).toEqual(before.versions);
      expect((await raw.query('SELECT * FROM app_aggregate')).rows).toEqual(before.aggregate);
      expect((await raw.query("SELECT to_regclass('app_documents') AS name")).rows).toEqual([{ name: null }]);
      expect(await table(raw, 'app_run_tasks')).toEqual(NO_TABLE);
    });
    await expect(readFile(join(path, '.sanxing.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    { name: 'missing body', sql: 'DELETE FROM app_documents', error: 'missing document content' },
    { name: 'orphan body', sql: "INSERT INTO app_documents VALUES ('orphan', '', '')", error: 'orphan document content' },
    { name: 'missing run task', sql: 'DELETE FROM app_run_tasks', error: 'missing run task content' },
    { name: 'orphan run task', sql: "INSERT INTO app_run_tasks VALUES ('orphan', '{}')", error: 'orphan run task content' },
  ])('rejects v3 $name instead of returning a partial backup', async ({ sql, error }) => {
    const path = await directory(); const repository = await open(path);
    await repository.replace(fixture()); await repository.close();
    await inspect(path, async raw => { await raw.exec(sql); });
    await expect(readBackupWithoutMigration(path, 'mock')).rejects.toThrow(error);
    await expect(readFile(join(path, '.sanxing.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('physical schema v3 and validated snapshot cache', () => {
  it.each([
    { version: 1, create: legacy },
    { version: 2, create: legacyV2 },
  ])('migrates v$version to v3 atomically without changing exported schema, revision or source bytes', async ({ create }) => {
    const path = await directory(); const expected = fixture();
    await create(path, expected);
    const repository = await open(path);
    expect(await repository.read()).toEqual(expected);
    expect(await repository.revision()).toBe(7);
    await repository.close();
    await inspect(path, async (raw) => {
      expect((await raw.query('SELECT version FROM app_schema_version')).rows).toEqual([{ version: 3 }]);
      const stored = (await raw.query<{ data: AppData }>('SELECT data FROM app_aggregate')).rows[0]!.data;
      expect(stored.schemaVersion).toBe(1);
      expect(stored.documents.doc1).not.toHaveProperty('text');
      expect(stored.documents.doc1).not.toHaveProperty('originalBase64');
      expect(stored.runs.run1).not.toHaveProperty('task');
      expect(stored.runs.run1).toMatchObject({ id: 'run1', status: 'succeeded' });
      expect((await raw.query('SELECT * FROM app_documents')).rows).toEqual([{
        id: 'doc1', text: expected.documents.doc1!.text, original_base64: expected.documents.doc1!.originalBase64,
      }]);
      expect((await raw.query('SELECT * FROM app_run_tasks')).rows).toEqual([{ id: 'run1', task: expected.runs.run1!.task }]);
    });
    expect(await (await open(path)).read()).toEqual(expected);
  });

  it('rolls back a failed v2 migration: task table, inline tasks and version stay unchanged', async () => {
    const path = await directory(); const expected = fixture();
    await legacyV2(path, expected, `CREATE FUNCTION fail_migration() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'migration rejected'; END $$;
      CREATE TRIGGER fail_migration BEFORE UPDATE ON app_aggregate FOR EACH ROW EXECUTE FUNCTION fail_migration();`);
    await expect(openRepository(path, 'mock')).rejects.toThrow();
    await inspect(path, async (raw) => {
      expect((await raw.query('SELECT version FROM app_schema_version')).rows).toEqual([{ version: 2 }]);
      expect((await raw.query<{ data: AppData }>('SELECT data FROM app_aggregate')).rows[0]!.data.runs).toEqual(expected.runs);
      expect(await table(raw, 'app_run_tasks')).toEqual(NO_TABLE);
      await raw.exec('DROP TRIGGER fail_migration ON app_aggregate');
    });
    expect(await (await open(path)).read()).toEqual(expected);
  });

  it('rolls back failed migration DDL, bodies, aggregate and version together', async () => {
    const path = await directory(); const expected = fixture();
    await legacy(path, expected, `CREATE FUNCTION fail_migration() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'migration rejected'; END $$;
      CREATE TRIGGER fail_migration BEFORE UPDATE ON app_aggregate FOR EACH ROW EXECUTE FUNCTION fail_migration();`);
    await expect(openRepository(path, 'mock')).rejects.toThrow();
    await inspect(path, async (raw) => {
      expect((await raw.query('SELECT version FROM app_schema_version')).rows).toEqual([{ version: 1 }]);
      expect((await raw.query<{ data: AppData }>('SELECT data FROM app_aggregate')).rows[0]!.data).toEqual(expected);
      expect((await raw.query('SELECT to_regclass(\'app_documents\') AS name')).rows).toEqual([{ name: null }]);
      expect(await table(raw, 'app_run_tasks')).toEqual(NO_TABLE);
      await raw.exec('DROP TRIGGER fail_migration ON app_aggregate');
    });
    expect(await (await open(path)).read()).toEqual(expected);
  });

  it('refuses invalid and wrong-mode v1 data before migration', async () => {
    const path = await directory(); await legacy(path);
    await expect(openRepository(path, 'live')).rejects.toThrow('mode mismatch');
    await inspect(path, async (raw) => {
      expect((await raw.query('SELECT version FROM app_schema_version')).rows).toEqual([{ version: 1 }]);
      await raw.exec("UPDATE app_aggregate SET data = data #- '{documents,doc1,text}'");
    });
    await expect(openRepository(path, 'mock')).rejects.toThrow('Invalid aggregate');
    await inspect(path, async (raw) => {
      expect((await raw.query('SELECT version FROM app_schema_version')).rows).toEqual([{ version: 1 }]);
      expect((await raw.query('SELECT to_regclass(\'app_documents\') AS name')).rows).toEqual([{ name: null }]);
    });
  });

  it('round-trips a complete export/import and removes bodies and tasks on delete or replace', async () => {
    const path = await directory(); let repository = await open(path);
    await repository.replace(fixture());
    const backup = await repository.read();
    const imported = await open(); await imported.replace(backup);
    expect(await imported.read()).toEqual(backup);
    await repository.transact((data) => { delete data.documents.doc1; delete data.runs.run1; });
    await repository.close();
    await inspect(path, async (raw) => {
      expect((await raw.query('SELECT * FROM app_documents')).rows).toEqual([]);
      expect((await raw.query('SELECT * FROM app_run_tasks')).rows).toEqual([]);
    });
    repository = await open(path); await repository.replace(backup);
    expect((await repository.read()).documents).toEqual(backup.documents);
    expect((await repository.read()).runs).toEqual(backup.runs);
    await repository.replace(emptyData('mock')); await repository.close();
    await inspect(path, async (raw) => {
      expect((await raw.query('SELECT * FROM app_documents')).rows).toEqual([]);
      expect((await raw.query('SELECT * FROM app_run_tasks')).rows).toEqual([]);
    });
  });

  it('persists a changed run task and keeps undefined last_review keys out of storage', async () => {
    const path = await directory(); let repository = await open(path);
    await repository.replace(fixture());
    await repository.transact((data) => {
      const task = data.runs.run1!.task;
      if (task.kind === 'extract') task.recitation.topic = 'edited';
    });
    const committed = await repository.read(); await repository.close();
    repository = await open(path);
    expect(await repository.read()).toEqual(committed);
    expect(committed.runs.run1!.task).toMatchObject({ recitation: { topic: 'edited' } });
  });

  it('persists changed text/Base64 and optional content history across reopen and restore', async () => {
    const path = await directory(); let repository = await open(path);
    await repository.replace(fixture());
    await repository.transact((data) => {
      data.documents.doc1!.text = 'edited text'; data.documents.doc1!.originalBase64 = 'AAECAw==';
      data.knowledge.k1 = { id: 'k1', title: 'Current', description: 'Description', sourceIds: ['doc1'], understanding: '', version: 4,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', contentVersion: 2,
        contentHistory: [{ version: 1, title: 'Old', description: 'Old description', sourceIds: [], createdAt: '2026-01-01T00:00:00.000Z' }] };
    });
    const backup = await repository.read(); await repository.close();
    repository = await open(path); expect(await repository.read()).toEqual(backup);
    await repository.replace(backup);
    expect(await repository.read()).toEqual({ ...backup, revision: backup.revision + 1 });
    const live = await open(':memory:', 'live');
    await expect(live.replace(backup)).rejects.toThrow('mode mismatch');
    expect((await live.read()).documents).toEqual({});
  });

  it('fails closed on future content history at restore, write, reopen and migration boundaries', async () => {
    const path = await directory(); const repository = await open(path);
    const valid = fixture();
    valid.knowledge.k1 = { id: 'k1', title: 'Current', description: 'Description', sourceIds: [], understanding: '', version: 1,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', contentVersion: 1,
      contentHistory: [{ version: 1, title: 'Current', description: 'Description', sourceIds: [], createdAt: '2026-01-01T00:00:00.000Z' }] };
    await repository.replace(valid);
    const committed = await repository.read(); const invalid = structuredClone(committed);
    invalid.knowledge.k1!.contentHistory!.push({ version: 2, title: 'Unrelated future', description: 'Other', sourceIds: [], createdAt: '2026-01-01T00:00:00.000Z' });
    await expect(repository.replace(invalid)).rejects.toThrow('future knowledge');
    await expect(repository.transact(data => { data.knowledge = structuredClone(invalid.knowledge); })).rejects.toThrow('future knowledge');
    expect(await repository.read()).toEqual(committed);
    expect(await repository.revision()).toBe(committed.revision);
    await repository.close();
    const reopened = await open(path); expect(await reopened.read()).toEqual(committed); await reopened.close();
    await inspect(path, async raw => {
      await raw.query("UPDATE app_aggregate SET data = jsonb_set(data, '{knowledge}', $1::jsonb)", [JSON.stringify(invalid.knowledge)]);
    });
    await expect(openRepository(path, 'mock')).rejects.toThrow('future knowledge');
    await inspect(path, async raw => {
      expect((await raw.query<{ knowledge: AppData['knowledge'] }>("SELECT data->'knowledge' AS knowledge FROM app_aggregate")).rows[0]!.knowledge).toEqual(invalid.knowledge);
    });
    const legacyPath = await directory(); await legacy(legacyPath, invalid);
    await expect(openRepository(legacyPath, 'mock')).rejects.toThrow('future knowledge');
    await inspect(legacyPath, async raw => {
      expect((await raw.query('SELECT version FROM app_schema_version')).rows).toEqual([{ version: 1 }]);
      expect((await raw.query<{ data: AppData }>('SELECT data FROM app_aggregate')).rows[0]!.data).toEqual(invalid);
      expect((await raw.query("SELECT to_regclass('app_documents') AS name")).rows).toEqual([{ name: null }]);
    });
  });

  it('does not UPDATE unchanged bodies even when document metadata or business state changes', async () => {
    const path = await directory(); let repository = await open(path);
    await repository.replace(fixture()); await repository.close();
    await inspect(path, async (raw) => {
      await raw.exec(`CREATE FUNCTION forbid_body_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'body write forbidden'; END $$;
        CREATE TRIGGER forbid_body_write BEFORE INSERT OR UPDATE OR DELETE ON app_documents FOR EACH ROW EXECUTE FUNCTION forbid_body_write();
        CREATE TRIGGER forbid_task_write BEFORE INSERT OR UPDATE OR DELETE ON app_run_tasks FOR EACH ROW EXECUTE FUNCTION forbid_body_write();`);
    });
    repository = await open(path);
    await repository.transact((data) => {
      data.documents.doc1!.name = 'renamed.txt'; data.receipts.x = { hash: 'h', result: true, createdAt: '2026-01-01T00:00:00.000Z' };
      data.runs.run1!.status = 'failed'; data.runs.run1!.error = 'stopped';
    });
    const before = await repository.read();
    await repository.replace(before);
    expect(await repository.revision()).toBe(before.revision + 1);
    const committed = await repository.read();
    await expect(repository.transact((data) => { data.documents.doc1!.text = 'changed'; })).rejects.toThrow();
    expect(await repository.read()).toEqual(committed);
    await expect(repository.transact((data) => { delete data.documents.doc1; })).rejects.toThrow();
    expect(await repository.read()).toEqual(committed);
    await expect(repository.transact((data) => { data.documents.doc2 = { ...data.documents.doc1!, id: 'doc2' }; })).rejects.toThrow();
    expect(await repository.read()).toEqual(committed);
    await expect(repository.transact((data) => { const task = data.runs.run1!.task; if (task.kind === 'extract') task.recitation.topic = 'changed'; })).rejects.toThrow('app_run_tasks');
    expect(await repository.read()).toEqual(committed);
    await expect(repository.transact((data) => { delete data.runs.run1; })).rejects.toThrow('app_run_tasks');
    expect(await repository.read()).toEqual(committed);
    await expect(repository.transact((data) => { data.runs.run2 = { ...structuredClone(data.runs.run1!), id: 'run2' }; })).rejects.toThrow('app_run_tasks');
    expect(await repository.read()).toEqual(committed);
    await repository.close();
    expect(await (await open(path)).read()).toEqual(committed);
  });

  it('rolls back changed body and aggregate when COMMIT fails, without updating cache', async () => {
    const path = await directory(); let repository = await open(path);
    await repository.replace(fixture()); await repository.close();
    await inspect(path, async (raw) => {
      await raw.exec(`CREATE FUNCTION reject_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'commit rejected'; END $$;
        CREATE CONSTRAINT TRIGGER reject_commit AFTER UPDATE ON app_aggregate DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_commit();`);
    });
    repository = await open(path); const before = await repository.read();
    await expect(repository.transact((data) => { data.documents.doc1!.text = 'changed'; })).rejects.toThrow();
    expect(await repository.read()).toEqual(before);
    expect(await repository.revision()).toBe(before.revision);
    await repository.close();
    expect(await (await open(path)).read()).toEqual(before);
  });

  it('uses cached validated reads/revision with no SQL, but validates every write and restore', async () => {
    const repository = await open();
    await repository.replace(fixture());
    const validate = vi.spyOn(validation, 'validateData');
    const query = vi.spyOn(PGlite.prototype, 'query');
    for (let index = 0; index < 3; index++) {
      const data = await repository.read(); data.documents.doc1!.text = 'outside';
      const task = data.runs.run1!.task; if (task.kind === 'extract') task.recitation.learned = 'outside';
      expect(await repository.revision()).toBe(1);
    }
    expect(validate).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
    expect((await repository.read()).documents.doc1!.text).toBe(fixture().documents.doc1!.text);
    expect((await repository.read()).runs.run1!.task).toEqual(fixture().runs.run1!.task);
    await expect(repository.transact((data) => { data.documents.doc1!.text = 42 as unknown as string; })).rejects.toThrow('Invalid aggregate');
    await expect(repository.replace({ ...fixture(), schemaVersion: 2 } as unknown as AppData)).rejects.toThrow('Invalid aggregate');
    expect(validate).toHaveBeenCalledTimes(2);
    expect(await repository.revision()).toBe(1);
    await expect(repository.transact(() => repository.revision())).rejects.toThrow('nested');
  });

  it('rejects missing/orphan/inline v3 run tasks', async () => {
    const path = await directory(); const repository = await open(path);
    await repository.replace(fixture()); await repository.close();
    await inspect(path, async (raw) => { await raw.exec("UPDATE app_run_tasks SET id = 'orphan'"); });
    await expect(openRepository(path, 'mock')).rejects.toThrow('missing run task content');
    await inspect(path, async (raw) => { await raw.exec("UPDATE app_run_tasks SET id = 'run1'; INSERT INTO app_run_tasks VALUES ('orphan', '{}')"); });
    await expect(openRepository(path, 'mock')).rejects.toThrow('orphan run task content');
    await inspect(path, async (raw) => { await raw.exec("DELETE FROM app_run_tasks WHERE id = 'orphan'; UPDATE app_aggregate SET data = jsonb_set(data, '{runs,run1,task}', '{}')"); });
    await expect(openRepository(path, 'mock')).rejects.toThrow('inline content');
    await inspect(path, async (raw) => { await raw.exec("UPDATE app_aggregate SET data = data #- '{runs,run1,task}'; UPDATE app_run_tasks SET task = '{\"kind\":\"unknown\"}'"); });
    await expect(openRepository(path, 'mock')).rejects.toThrow('Invalid aggregate');
  });

  it('rejects missing/orphan/inline v3 bodies and never reseeds bad storage', async () => {
    const path = await directory(); let repository = await open(path);
    await repository.replace(fixture()); await repository.close();
    await inspect(path, async (raw) => { await raw.exec("UPDATE app_documents SET id = 'orphan'"); });
    await expect(openRepository(path, 'mock')).rejects.toThrow('missing document content');
    await inspect(path, async (raw) => { await raw.exec("UPDATE app_documents SET id = 'doc1'; INSERT INTO app_documents VALUES ('orphan', '', '')"); });
    await expect(openRepository(path, 'mock')).rejects.toThrow('orphan document content');
    await inspect(path, async (raw) => { await raw.exec("DELETE FROM app_documents WHERE id = 'orphan'; UPDATE app_aggregate SET data = jsonb_set(data, '{documents,doc1,text}', '\"inline\"')"); });
    await expect(openRepository(path, 'mock')).rejects.toThrow('inline content');
    await inspect(path, async (raw) => { await raw.exec("UPDATE app_aggregate SET data = data #- '{documents,doc1,text}'; DELETE FROM app_schema_version"); });
    await expect(openRepository(path, 'mock')).rejects.toThrow('Unsupported database schema version');
  });

  it('fails closed on unknown directory contents, unknown tables and damaged physical databases', async () => {
    const unknown = await directory(); const file = join(unknown, 'unrecognized');
    await writeFile(file, 'keep me');
    await expect(openRepository(unknown, 'mock')).rejects.toThrow('unknown or incomplete files');
    expect(await readFile(file, 'utf8')).toBe('keep me');
    const tables = await directory();
    await inspect(tables, async (raw) => { await raw.exec('CREATE TABLE unknown (value integer)'); });
    await expect(openRepository(tables, 'mock')).rejects.toThrow('tables exist without schema version');
    const damaged = await directory(); await (await open(damaged)).close();
    await rm(join(damaged, 'PG_VERSION'));
    await expect(openRepository(damaged, 'mock')).rejects.toThrow('unknown or incomplete files');
  });
});
