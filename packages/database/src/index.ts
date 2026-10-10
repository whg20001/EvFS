import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PGlite } from '@electric-sql/pglite';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import type { AppData, Mode } from '@sanxing/contracts';
import { aggregate, documents, runTasks } from './schema.js';
import type { StoredData } from './schema.js';
import { validateData } from './validation.js';
import { acquireDirectoryLock } from '@sanxing/local-storage';

const OWNER_ID = 'local';
const openPaths = new Set<string>();

export interface Repository {
  read(): Promise<AppData>;
  revision(): Promise<number>;
  /** Tiny committed projection, avoiding aggregate cloning for /api/me. */
  learningPreferences?(): Promise<AppData['learningPreferences']>;
  transact<T>(fn: (data: AppData) => T | Promise<T>): Promise<T>;
  replace(data: AppData): Promise<void>;
  close(): Promise<void>;
}

export function emptyData(mode: Mode): AppData {
  if (mode !== 'mock' && mode !== 'live') throw new Error('Invalid database mode');
  return {
    schemaVersion: 1, ownerId: OWNER_ID, mode, revision: 0, aiModel: null,
    recitations: {}, documents: {}, sessions: {}, knowledge: {}, quizzes: {}, cards: {},
    reviewSessions: {}, reviewEvents: {}, evidence: {}, runs: {}, receipts: {},
  };
}

function storedData(data: AppData): StoredData {
  return {
    ...data,
    documents: Object.fromEntries(Object.entries(data.documents).map(([id, document]) => {
      const { text: _text, originalBase64: _original, ...metadata } = document;
      return [id, metadata];
    })),
    runs: Object.fromEntries(Object.entries(data.runs).map(([id, run]) => {
      const { task: _task, ...metadata } = run;
      return [id, metadata];
    })),
  };
}

/** Copies validated JSON data. Strings are immutable and shared, so large
 * document bodies and model inputs are not duplicated on every read/write.
 * Own keys with undefined values (optional last_review) are preserved. */
function cloneJson<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneJson) as T;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) copy[key] = cloneJson((value as Record<string, unknown>)[key]);
  return copy as T;
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) =>
    Object.hasOwn(right, key) && sameJson((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

type SchemaVersion = 1 | 2 | 3;
const CURRENT_SCHEMA_VERSION = 3;

type Transaction = Parameters<Parameters<ReturnType<typeof drizzle>['transaction']>[0]>[0];

async function lockDirectory(path: string, create: boolean) {
  if (!path || path === ':memory:') throw new Error('An existing database directory is required');
  if (create) await mkdir(resolve(path), { recursive: true, mode: 0o700 });
  const diskPath = await realpath(resolve(path));
  if (openPaths.has(diskPath)) throw new Error('Database directory is already open in this process');
  openPaths.add(diskPath);
  let releaseLock: (() => Promise<void>) | undefined;
  const release = async () => {
    try { await releaseLock?.(); } finally { openPaths.delete(diskPath); }
  };
  try {
    releaseLock = await acquireDirectoryLock(diskPath);
    // PGlite may initialize directories lacking PG_VERSION. Backups must never
    // initialize, and normal opens must not mistake unknown files for empty DBs.
    const entries = (await readdir(diskPath)).filter((name) => name !== '.sanxing.lock');
    if (!entries.includes('PG_VERSION')) {
      if (!create || entries.length) throw new Error('Invalid database directory: unknown or incomplete files (missing PG_VERSION)');
    } else if (!(await lstat(join(diskPath, 'PG_VERSION'))).isFile()) {
      throw new Error('Invalid database directory: PG_VERSION must be a regular file');
    }
    return { diskPath, release };
  } catch (error) {
    await release();
    throw error;
  }
}

function checkedRow(rows: (typeof aggregate.$inferSelect)[], mode: Mode, data?: unknown): AppData {
  const row = rows[0];
  if (rows.length !== 1 || !row || row.id !== OWNER_ID) throw new Error('Invalid aggregate: expected exactly one owner row');
  const complete = data ?? row.data;
  validateData(complete, mode, OWNER_ID);
  if (complete.revision !== row.revision) throw new Error('Invalid aggregate: revision mismatch');
  if (!Number.isFinite(row.updatedAt.getTime())) throw new Error('Invalid aggregate: updatedAt');
  return complete;
}

async function schemaVersion(tx: Transaction): Promise<SchemaVersion> {
  const versions = await tx.execute<{ id: number; version: number }>(sql`SELECT id, version FROM app_schema_version`);
  const version = versions.rows[0];
  if (versions.rows.length !== 1 || version?.id !== 1 || ![1, 2, 3].includes(version.version)) {
    throw new Error('Unsupported database schema version');
  }
  return version.version as SchemaVersion;
}

/** Joins entity metadata from the aggregate with its out-of-line content rows. */
function attach<Body extends { id: string }>(
  metadata: unknown, bodies: Body[], name: string, inline: string[], merge: (entity: object, body: Body) => object,
): Record<string, object> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error(`Invalid aggregate: ${name}s`);
  const byId = new Map(bodies.map((body) => [body.id, body]));
  const complete = Object.fromEntries(Object.entries(metadata).map(([id, entity]: [string, unknown]) => {
    if (!entity || typeof entity !== 'object' || Array.isArray(entity) || inline.some((key) => Object.hasOwn(entity, key))) {
      throw new Error(`Invalid aggregate: ${name} metadata contains invalid or inline content`);
    }
    const body = byId.get(id);
    if (!body) throw new Error(`Invalid aggregate: missing ${name} content for ${id}`);
    byId.delete(id);
    return [id, merge(entity, body)];
  }));
  if (byId.size) throw new Error(`Invalid aggregate: orphan ${name} content`);
  return complete;
}

async function load(tx: Transaction, mode: Mode, version: SchemaVersion): Promise<AppData> {
  const rows = await tx.select().from(aggregate);
  const row = rows[0];
  if (version === 1 || rows.length !== 1 || !row) return checkedRow(rows, mode);
  const data: Record<string, unknown> = { ...row.data };
  data.documents = attach(row.data?.documents, await tx.select().from(documents), 'document', ['text', 'originalBase64'],
    (document, body) => ({ ...document, text: body.text, originalBase64: body.originalBase64 }));
  if (version === 3) {
    data.runs = attach(row.data?.runs, await tx.select().from(runTasks), 'run task', ['task'],
      (run, body) => ({ ...run, task: body.task }));
  }
  return checkedRow(rows, mode, data);
}

/** Export an existing physical v1/v2/v3 database without logical writes or migration.
 * PGlite may perform WAL recovery and other engine filesystem writes on opening.
 */
export async function readBackupWithoutMigration(path: string, mode: Mode): Promise<AppData> {
  if (mode !== 'mock' && mode !== 'live') throw new Error('Invalid database mode');
  const { diskPath, release } = await lockDirectory(path, false);
  let client: PGlite | undefined;
  try {
    client = new PGlite(diskPath);
    return await drizzle(client).transaction(async (tx) => {
      // In addition to issuing only SELECTs, enforce the logical read-only
      // boundary in PostgreSQL. Engine recovery happens before this transaction.
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      return load(tx, mode, await schemaVersion(tx));
    });
  } finally {
    try { await client?.close(); } finally { await release(); }
  }
}

export async function openRepository(path: string, mode: Mode): Promise<Repository> {
  const initial = emptyData(mode);
  if (!path) throw new Error('Database path must not be empty');
  const storage = path === ':memory:' ? undefined : await lockDirectory(path, true);
  const releaseLock = storage?.release;
  let client: PGlite;
  try {
    client = new PGlite(storage?.diskPath);
  } catch (error) {
    await releaseLock?.();
    throw error;
  }
  const db = drizzle(client);

  const createDocuments = sql`CREATE TABLE app_documents (
    id text PRIMARY KEY, text text NOT NULL, original_base64 text NOT NULL
  )`;
  const createRunTasks = sql`CREATE TABLE app_run_tasks (id text PRIMARY KEY, task jsonb NOT NULL)`;
  let snapshot: AppData;
  try {
    // Both the migration and its final full validation must commit before the
    // cached snapshot becomes available. AppData.schemaVersion stays at 1.
    snapshot = await db.transaction(async (tx) => {
      const tables = await tx.execute<{ name: string }>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'`);
      if (!tables.rows.some((table) => table.name === 'app_schema_version')) {
        if (tables.rows.length) throw new Error('Invalid database: tables exist without schema version');
        await tx.execute(sql`CREATE TABLE app_schema_version (
          id integer PRIMARY KEY CHECK (id = 1), version integer NOT NULL
        )`);
        await tx.execute(sql`CREATE TABLE app_aggregate (
          id text PRIMARY KEY CHECK (id = 'local'),
          revision integer NOT NULL CHECK (revision >= 0),
          data jsonb NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        )`);
        await tx.execute(createDocuments);
        await tx.execute(createRunTasks);
        await tx.insert(aggregate).values({ id: OWNER_ID, revision: 0, data: storedData(initial) });
        await tx.execute(sql`INSERT INTO app_schema_version (id, version) VALUES (1, ${CURRENT_SCHEMA_VERSION})`);
      } else {
        const version = await schemaVersion(tx);
        if (version !== CURRENT_SCHEMA_VERSION) {
          // v1 -> v3 and v2 -> v3 run in this one transaction: either every
          // body moves out of the aggregate and the ledger advances, or nothing does.
          const legacy = await load(tx, mode, version);
          if (version === 1) {
            await tx.execute(createDocuments);
            for (const document of Object.values(legacy.documents)) {
              await tx.insert(documents).values({ id: document.id, text: document.text, originalBase64: document.originalBase64 });
            }
          }
          await tx.execute(createRunTasks);
          for (const run of Object.values(legacy.runs)) await tx.insert(runTasks).values({ id: run.id, task: run.task });
          const migrated = await tx.update(aggregate).set({ data: storedData(legacy) })
            .where(and(eq(aggregate.id, OWNER_ID), eq(aggregate.revision, legacy.revision))).returning({ id: aggregate.id });
          if (migrated.length !== 1) throw new Error('Aggregate revision conflict during migration');
          const migratedVersion = await tx.execute(sql`UPDATE app_schema_version SET version = ${CURRENT_SCHEMA_VERSION} WHERE id = 1 AND version = ${version} RETURNING id`);
          if (migratedVersion.rows.length !== 1) throw new Error('Schema version conflict during migration');
        }
      }
      return load(tx, mode, CURRENT_SCHEMA_VERSION);
    });
  } catch (error) {
    try { await client.close(); } finally { await releaseLock?.(); }
    throw error;
  }

  // The exclusive directory lock permits caching validated committed state.
  // Bypassing it with raw PGlite/external writes is unsupported. CAS is retained
  // as additional protection; reads, writes and shutdown still share one queue.
  let tail: Promise<unknown> = Promise.resolve();
  let closePromise: Promise<void> | undefined;
  const callbackContext = new AsyncLocalStorage<boolean>();
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (callbackContext.getStore()) return Promise.reject(new Error('Repository operations cannot be nested inside a transaction callback'));
    if (closePromise) return Promise.reject(new Error('Repository is closed'));
    const result = tail.then(operation);
    tail = result.catch(() => undefined);
    return result;
  }

  async function commit<T>(fn: (data: AppData) => T | Promise<T>, replacement?: AppData): Promise<T> {
    const current = snapshot;
    const revision = current.revision;
    const draft = cloneJson(replacement ?? current);
    // Restores keep the local revision monotonic, not the backup's revision.
    draft.revision = revision;
    const result = await callbackContext.run(true, () => fn(draft));
    validateData(draft, mode, OWNER_ID);
    if (draft.revision !== revision) throw new Error('Transaction callback cannot change revision');
    if (revision === 2_147_483_647) throw new Error('Aggregate revision exhausted');
    draft.revision = revision + 1;
    // Neither callback return values nor retained drafts may alias the cache.
    const committed = cloneJson(draft);
    for (const schedule of [
      ...Object.values(committed.cards).map((card) => card.schedule),
      ...Object.values(committed.reviewEvents).flatMap((event) => [event.before, event.after]),
    ]) if (schedule.last_review === undefined) delete schedule.last_review;

    await db.transaction(async (tx) => {
      const rows = await tx.update(aggregate)
        .set({ revision: committed.revision, data: storedData(committed), updatedAt: new Date() })
        .where(and(eq(aggregate.id, OWNER_ID), eq(aggregate.revision, revision)))
        .returning({ id: aggregate.id });
      if (rows.length !== 1) throw new Error('Aggregate revision conflict');
      for (const id of Object.keys(current.documents)) {
        if (!Object.hasOwn(committed.documents, id)) {
          const removed = await tx.delete(documents).where(eq(documents.id, id)).returning({ id: documents.id });
          if (removed.length !== 1) throw new Error('Document deletion conflict');
        }
      }
      for (const document of Object.values(committed.documents)) {
        const before = Object.hasOwn(current.documents, document.id) ? current.documents[document.id] : undefined;
        if (before && before.text === document.text && before.originalBase64 === document.originalBase64) continue;
        const body = { id: document.id, text: document.text, originalBase64: document.originalBase64 };
        const written = before
          ? await tx.update(documents).set(body).where(eq(documents.id, document.id)).returning({ id: documents.id })
          : await tx.insert(documents).values(body).returning({ id: documents.id });
        if (written.length !== 1) throw new Error('Document write conflict');
      }
      for (const id of Object.keys(current.runs)) {
        if (!Object.hasOwn(committed.runs, id)) {
          const removed = await tx.delete(runTasks).where(eq(runTasks.id, id)).returning({ id: runTasks.id });
          if (removed.length !== 1) throw new Error('Run task deletion conflict');
        }
      }
      for (const run of Object.values(committed.runs)) {
        const before = Object.hasOwn(current.runs, run.id) ? current.runs[run.id] : undefined;
        // Cloned drafts share task strings with the snapshot, so this is cheap.
        if (before && sameJson(before.task, run.task)) continue;
        const written = before
          ? await tx.update(runTasks).set({ task: run.task }).where(eq(runTasks.id, run.id)).returning({ id: runTasks.id })
          : await tx.insert(runTasks).values({ id: run.id, task: run.task }).returning({ id: runTasks.id });
        if (written.length !== 1) throw new Error('Run task write conflict');
      }
    });
    // SQL failure (including COMMIT failure) leaves the old snapshot intact.
    snapshot = committed;
    return result;
  }

  return {
    read: () => enqueue(async () => cloneJson(snapshot)),
    revision: () => enqueue(async () => snapshot.revision),
    learningPreferences: () => enqueue(async () => cloneJson(snapshot.learningPreferences)),
    transact: (fn) => enqueue(() => commit(fn)),
    async replace(data) {
      validateData(data, mode, OWNER_ID);
      const replacement = cloneJson(data);
      await enqueue(() => commit(() => undefined, replacement));
    },
    close() {
      if (callbackContext.getStore()) return Promise.reject(new Error('Repository cannot be closed inside a transaction callback'));
      closePromise ??= tail.then(async () => {
        try { await client.close(); } finally { await releaseLock?.(); }
      });
      return closePromise;
    },
  };
}
