import type { AppData, Mode } from '@sanxing/contracts';
import type { Repository } from './index.ts';
import { emptyData } from './empty.ts';
import { validateData } from './validation.ts';

export class BrowserStorageError extends Error {
  constructor(public code: string, message: string, public status = 503) { super(message); }
}

/** One private database per stable cloud account and mode; never falls back to memory. */
export async function openBrowserRepository(accountId: string, mode: Mode): Promise<Repository> {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(accountId)) throw new Error('Invalid account identifier');
  if (typeof indexedDB === 'undefined') throw new BrowserStorageError('LOCAL_STORAGE_UNAVAILABLE', '浏览器无法打开本地数据库，请使用允许保存网站数据的浏览器。');
  const name = `sanxing-learning-v1:${accountId}:${mode}`;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => { const store = request.result.createObjectStore('state'); store.put(emptyData(mode), 'app'); store.put({ revision: 0, pending: false }, 'meta'); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new BrowserStorageError('LOCAL_STORAGE_UNAVAILABLE', '无法打开本地数据库，请检查浏览器存储空间和权限。'));
    request.onblocked = () => reject(new BrowserStorageError('LOCAL_STORAGE_BLOCKED', '请关闭其他打开此网站的标签页，再重试。'));
  });
  let closed = false;
  db.onversionchange = () => { closed = true; db.close(); };
  const read = () => new Promise<AppData>((resolve, reject) => {
    if (closed) return reject(new BrowserStorageError('LOCAL_STORAGE_CLOSED', '本地数据库已关闭，请重新登录。'));
    const tx = db.transaction('state', 'readonly'); const request = tx.objectStore('state').get('app');
    request.onsuccess = () => {
      try { validateData(request.result, mode, 'local'); resolve(request.result); }
      catch { reject(new BrowserStorageError('LOCAL_STORAGE_INVALID', '本地数据库校验失败。请保留网站数据，使用有效备份恢复。')); }
    };
    request.onerror = () => reject(request.error);
  });
  function write(data: AppData, revision: number | null) {
    return new Promise<void>((resolve, reject) => {
      if (closed) return reject(new BrowserStorageError('LOCAL_STORAGE_CLOSED', '本地数据库已关闭，请重新登录。'));
      const tx = db.transaction('state', 'readwrite', { durability: 'strict' });
      const store = tx.objectStore('state'); const request = store.get('app');
      let conflict = false;
      request.onsuccess = () => {
        const current = request.result as AppData | undefined;
        if ((revision === null && current !== undefined) || (revision !== null && current?.revision !== revision)) { conflict = true; tx.abort(); return; }
        store.put(data, 'app');
        store.put({ revision: data.revision, pending: Object.values(data.runs).some(run => run.status === 'pending') }, 'meta');
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(conflict
        ? new BrowserStorageError('REVISION_CONFLICT', '另一标签页已更新数据，请刷新后核对再保存。', 409)
        : new BrowserStorageError('LOCAL_STORAGE_WRITE', '本地保存失败，请检查浏览器存储空间；未确认保存的输入仍需保留。'));
      tx.onerror = () => { /* onabort owns the result. */ };
    });
  }
  try { await read(); }
  catch (error) { db.close(); throw error; }
  async function metadata(): Promise<{ revision: number; pending: boolean }> {
    if (closed) throw new BrowserStorageError('LOCAL_STORAGE_CLOSED', '本地数据库已关闭，请重新登录。');
    const value: unknown = await new Promise((resolve, reject) => {
      const request = db.transaction('state', 'readonly').objectStore('state').get('meta');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    if (value && typeof value === 'object' && 'revision' in value && Number.isSafeInteger(value.revision) && 'pending' in value && typeof value.pending === 'boolean') return value as { revision: number; pending: boolean };
    const data = await read(); return { revision: data.revision, pending: Object.values(data.runs).some(run => run.status === 'pending') };
  }
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(action: () => Promise<T>): Promise<T> => {
    const execute = async (): Promise<T> => typeof navigator !== 'undefined' && navigator.locks
      ? await navigator.locks.request(`${name}:write`, action) as T : action();
    const result = tail.then(execute); tail = result.catch(() => undefined); return result;
  };
  async function commit<T>(action: (data: AppData) => T | Promise<T>, replacement?: AppData): Promise<T> {
    const current = await read(); const draft = structuredClone(replacement ?? current);
    draft.revision = current.revision;
    const result = await action(draft);
    if (draft.revision !== current.revision || draft.revision >= 2_147_483_647) throw new Error('Invalid local revision');
    draft.revision++;
    validateData(draft, mode, 'local');
    // Normalize only the documented optional schedule field, after validation.
    await write(JSON.parse(JSON.stringify(draft)) as AppData, current.revision);
    return structuredClone(result);
  }
  return {
    read, revision: async () => (await metadata()).revision,
    readFields: async fields => { const data = await read(); return Object.fromEntries(fields.filter(key => Object.hasOwn(data, key)).map(key => [key, data[key]])) as never; },
    readEntity: async (collection, id) => (await read())[collection][id] as never,
    aiSettings: async () => { const data = await read(); return { ownerId: data.ownerId, mode: data.mode, revision: data.revision, aiModel: data.aiModel, ...(data.learningPreferences ? { learningPreferences: data.learningPreferences } : {}) }; },
    learningPreferences: async () => (await read()).learningPreferences,
    hasPendingRuns: async () => (await metadata()).pending,
    run: async id => (await read()).runs[id],
    transact: action => enqueue(() => commit(action)),
    replace: async value => { validateData(value, mode, 'local'); const replacement = structuredClone(value); await enqueue(() => commit(() => undefined, replacement)); },
    close: async () => { await tail; closed = true; db.close(); },
  };
}
