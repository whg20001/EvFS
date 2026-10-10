'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { PUBLIC_STATE_COLLECTIONS, isActiveRun, type CommandResult, type PublicState, type PublicStateUpdate } from '@sanxing/contracts';
import { HttpError, errorMessage, request, requestId, type ApiClient, type ApiOptions } from '../lib/api-client';
import { useBeforeUnload, useConfirm } from './confirm';

type Mutation = { result: CommandResult; state: PublicState };
type Store = {
  state: PublicState | null; loading: boolean; authenticated: boolean; busy: boolean;
  error: string | null; setError: (message: string | null) => void;
  reload: () => Promise<PublicState>; login: (password: string) => Promise<void>; logout: () => Promise<void>;
  command: (path: string, body?: object | FormData, method?: string) => Promise<Mutation>;
  api: ApiClient;
};
const Context = createContext<Store | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PublicState | null>(null);
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef<PublicState | null>(null);
  const locked = useRef(false);
  const epoch = useRef(0);
  const router = useRouter();
  const pathname = usePathname();
  const returnPath = useRef('/recite');
  const authFailure = useCallback((cause: unknown) => {
    if (cause instanceof HttpError && cause.status === 401) {
      setAuthenticated(false);
      // Keep the mounted editor and its unsaved input while the login overlay is shown.
      router.replace('/login');
    }
    const text = errorMessage(cause, '网络连接失败，输入已保留。');
    setError(cause instanceof HttpError && (cause.code.includes('VERSION_CONFLICT') || cause.status === 409)
      ? `${text} 请刷新服务端状态后核对版本；本地输入仍保留，不会自动覆盖。` : text);
  }, [router]);
  useEffect(() => { if (pathname !== '/login') returnPath.current = pathname === '/' ? '/recite' : pathname; }, [pathname]);
  const reload = useCallback(async () => {
    const currentEpoch = epoch.current;
    try {
      for (let collisions = 0; ; collisions++) {
        const baseline = stateRef.current;
        // First load and bounded contention fallback remain full snapshots (not pagination).
        const since = baseline && collisions < 2 ? baseline.revision : undefined;
        const response = await request<PublicState | PublicStateUpdate>(since === undefined ? '/state' : `/state?since=${since}`);
        if (currentEpoch !== epoch.current) throw new Error('登录状态已变化，请重新加载。');
        const current = stateRef.current;
        let next: PublicState;
        if (!('kind' in response)) next = response;
        else if (response.kind === 'snapshot') next = response.state;
        else {
          // A late delta cannot be applied to a different baseline. Even a newer
          // revision can omit an entity which changed and reverted in between.
          if (!current || current !== baseline || (response.kind === 'delta' && response.fromRevision !== current.revision)) {
            if (current && response.revision <= current.revision) return current;
            continue;
          }
          if (response.kind === 'unchanged') {
            if (response.revision !== current.revision) continue;
            if (response.csrfToken === current.csrfToken) return current;
            next = { ...current, csrfToken: response.csrfToken };
          } else {
            next = { ...current, revision: response.revision, csrfToken: response.csrfToken };
            for (const name of PUBLIC_STATE_COLLECTIONS) {
              const change = response.changes[name];
              if (!change) continue;
              const entities = new Map<string, { id: string }>(current[name].map(entity => [entity.id, entity]));
              for (const id of change.remove) entities.delete(id);
              for (const entity of change.upsert) entities.set(entity.id, entity);
              Object.assign(next, { [name]: [...entities.values()] });
            }
          }
        }
        if (current && next.revision < current.revision) return current;
        stateRef.current = next;
        setState(next);
        return next;
      }
    } catch (cause) { if (currentEpoch === epoch.current) authFailure(cause); throw cause; }
  }, [authFailure]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const status = await request<{ authenticated: boolean }>('/auth/status');
        if (!alive) return;
        setAuthenticated(status.authenticated);
        if (status.authenticated) {
          await reload();
          // A valid cookie can open /login directly, without calling login().
          // Check the current URL after reload; pathname in this effect's closure
          // can be stale, and adding it as a dependency would repeat auth loading.
          if (alive && window.location.pathname === '/login') router.replace(returnPath.current);
        } else router.replace('/login');
      } catch (cause) { if (alive) authFailure(cause); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [authFailure, reload, router]);
  const hasActiveRuns = state?.runs.some(isActiveRun) ?? false;
  useEffect(() => {
    if (!hasActiveRuns || !authenticated) return;
    let stopped = false;
    let timeout: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await reload(); } catch { /* Visible error, retry without overlapping requests. */ }
      if (!stopped) timeout = setTimeout(poll, 1000);
    };
    timeout = setTimeout(poll, 1000);
    return () => { stopped = true; clearTimeout(timeout); };
  }, [hasActiveRuns, authenticated, reload]);

  // Feature requests share authentication, not the learning command lock/reload cycle.
  const api: ApiClient = useCallback(async <T,>(path: string, options: ApiOptions = {}): Promise<T> => {
    const method = (options.method ?? 'GET').toUpperCase();
    const writing = method !== 'GET' && method !== 'HEAD';
    const headers: Record<string, string> = {};
    if (writing) {
      headers['X-CSRF-Token'] = stateRef.current?.csrfToken ?? '';
      headers['Idempotency-Key'] = requestId();
    }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      return await request<T>(path, { method, headers, signal: options.signal, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    } catch (cause) {
      // Only identity expiry is global; feature errors belong to the feature UI.
      if (!options.signal?.aborted && cause instanceof HttpError && cause.status === 401) authFailure(cause);
      throw cause;
    }
  }, [authFailure]);

  const command = useCallback(async (path: string, body: object | FormData = {}, method = 'POST'): Promise<Mutation> => {
    if (locked.current) throw new Error('另一个操作正在保存，请稍后再试。');
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      const headers: Record<string, string> = {
        'X-CSRF-Token': stateRef.current?.csrfToken ?? '',
        'Idempotency-Key': requestId(),
      };
      const multipart = body instanceof FormData;
      if (!multipart) headers['Content-Type'] = 'application/json';
      const result = await request<CommandResult>(path, { method, headers, body: multipart ? body : JSON.stringify(body) });
      const next = await reload();
      return { result, state: next };
    } catch (cause) { authFailure(cause); throw cause; }
    finally { locked.current = false; setBusy(false); }
  }, [authFailure, reload]);
  const login = useCallback(async (password: string) => {
    setBusy(true); setError(null);
    try {
      await request<{ csrfToken: string }>('/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestId() }, body: JSON.stringify({ password }),
      });
      // A new server/session can have the same revision in a different database.
      // Keep mounted editor drafts, but never reuse that session's sync baseline.
      epoch.current += 1; stateRef.current = null;
      setAuthenticated(true);
      await reload();
      router.replace(returnPath.current);
    } catch (cause) { authFailure(cause); throw cause; }
    finally { setBusy(false); }
  }, [authFailure, reload, router]);
  // Logout cannot reload protected state after the cookie has been revoked.
  const safeLogout = useCallback(async () => {
    setBusy(true);
    try {
      await request<CommandResult>('/auth/logout', { method: 'POST', headers: {
        'Content-Type': 'application/json', 'X-CSRF-Token': stateRef.current?.csrfToken ?? '', 'Idempotency-Key': requestId(),
      }, body: '{}' });
      epoch.current += 1; stateRef.current = null; setState(null); setAuthenticated(false); setError(null);
      clearDraftCache(); router.replace('/login');
    } catch (cause) { authFailure(cause); throw cause; }
    finally { setBusy(false); }
  }, [authFailure, router]);
  return <Context.Provider value={{ state, loading, authenticated, busy, error, setError, reload, login, logout: safeLogout, command, api }}>{children}</Context.Provider>;
}
export function useApp() {
  const context = useContext(Context);
  if (!context) throw new Error('AppProvider missing');
  return context;
}
export function useData(): PublicState {
  const { state } = useApp();
  if (!state) throw new Error('State has not loaded');
  return state;
}

// A single writer per editor; the saved revision belongs to the captured input, not newer keystrokes.
// Failed/conflicting autosaves pause until an explicit retry or reload. No silent version rebasing.
export function useDraft<T>(initial: T, version: number, saveRemote: (value: T, version: number) => Promise<number>, enabled = true, cacheKey = '') {
  const key = `sanxing:draft:${cacheKey}`;
  const confirm = useConfirm();
  const [restored] = useState(() => readDraft<T>(key, initial));
  const [value, setValue] = useState(restored?.value ?? initial);
  const [status, setStatus] = useState<'saved' | 'dirty' | 'saving' | 'error'>(restored ? 'error' : 'saved');
  const valueRef = useRef(value);
  const baseline = useRef(restored?.baseline ?? JSON.stringify(initial));
  const baseVersion = useRef(restored?.version ?? version);
  const persist = () => {
    try {
      if (!cacheKey) return;
      if (JSON.stringify(valueRef.current) === baseline.current) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, JSON.stringify({ value: valueRef.current, baseline: baseline.current, version: baseVersion.current }));
    } catch { /* Storage may be disabled; the mounted editor still retains its input. */ }
  };
  const persistRef = useRef(persist);
  persistRef.current = persist;
  const saving = useRef<Promise<boolean> | null>(null);
  const remoteRef = useRef(saveRemote);
  const enabledRef = useRef(enabled);
  const initialRef = useRef({ initial, version });
  remoteRef.current = saveRemote;
  enabledRef.current = enabled;
  initialRef.current = { initial, version };
  useEffect(() => {
    if (JSON.stringify(valueRef.current) === baseline.current && !saving.current && (JSON.stringify(initial) !== baseline.current || baseVersion.current !== version)) {
      valueRef.current = initial;
      baseline.current = JSON.stringify(initial);
      baseVersion.current = version;
      setValue(initial);
    }
  }, [initial, version]);
  const change = useCallback((next: T) => {
    valueRef.current = next; setValue(next); persistRef.current();
    setStatus(previous => previous === 'error' ? 'error' : 'dirty');
  }, []);
  const save = useCallback(async (): Promise<boolean> => {
    if (saving.current) return saving.current;
    const snapshot = valueRef.current;
    const serialized = JSON.stringify(snapshot);
    if (serialized === baseline.current) { setStatus('saved'); return true; }
    if (!enabledRef.current) return false;
    setStatus('saving');
    const pending = (async () => {
      try {
        const nextVersion = await remoteRef.current(snapshot, baseVersion.current);
        baseVersion.current = nextVersion; baseline.current = serialized; persistRef.current();
        setStatus(JSON.stringify(valueRef.current) === serialized ? 'saved' : 'dirty');
        return true;
      } catch { setStatus('error'); return false; }
      finally { saving.current = null; }
    })();
    saving.current = pending;
    return pending;
  }, []);
  useEffect(() => {
    if (status !== 'dirty' || !enabled) return;
    const timer = setTimeout(() => { void save(); }, 1000);
    return () => clearTimeout(timer);
  }, [value, status, enabled, save]);
  useBeforeUnload(() => JSON.stringify(valueRef.current) !== baseline.current);
  const reset = async () => {
    if (!await confirm({ title: '重新载入草稿', message: '重新载入会替换本地未保存输入，确定继续？建议先复制保留。', confirmLabel: '重新载入', tone: 'danger' })) return;
    const current = initialRef.current;
    valueRef.current = current.initial; baseline.current = JSON.stringify(current.initial); baseVersion.current = current.version;
    setValue(current.initial); setStatus('saved'); persistRef.current();
  };
  return { value, change, status, save, reset, version: () => baseVersion.current, dirty: () => JSON.stringify(valueRef.current) !== baseline.current };
}

export function useLocalText(key: string, initial = ''): [string, (value: string) => void] {
  const storageKey = `sanxing:input:${key}`;
  const [value, setValue] = useState(() => {
    try { return sessionStorage.getItem(storageKey) ?? initial; } catch { return initial; }
  });
  const change = (next: string) => {
    setValue(next);
    try { if (next) sessionStorage.setItem(storageKey, next); else sessionStorage.removeItem(storageKey); } catch { /* Retain in memory. */ }
  };
  return [value, change];
}

function clearDraftCache() {
  try { for (const key of Object.keys(sessionStorage)) if (key.startsWith('sanxing:')) sessionStorage.removeItem(key); } catch { /* Private mode may disable storage. */ }
}
function readDraft<T>(key: string, initial: T): { value: T; baseline: string; version: number } | null {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (!stored || typeof stored !== 'object' || !('value' in stored) || !('version' in stored) || !('baseline' in stored)) return null;
    if (typeof stored.version !== 'number' || !Number.isInteger(stored.version) || typeof stored.baseline !== 'string') return null;
    const value = stored.value;
    const matches = typeof initial === 'string' ? typeof value === 'string' : initial && typeof initial === 'object' && value && typeof value === 'object' && Object.keys(initial).every(field => field in value && typeof Reflect.get(value, field) === 'string');
    if (!matches || JSON.stringify(value) === JSON.stringify(initial)) return null;
    return { value: value as T, baseline: stored.baseline, version: stored.version };
  } catch { return null; }
}

export function dateLabel(value: string, timezone = 'Asia/Shanghai', short = false) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, month: 'long', day: 'numeric', ...(short ? {} : { year: 'numeric' as const }) }).format(new Date(value));
}
export function today(timezone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
export const sessionLabels: Record<string, string> = { CONFIRMING: '确认知识点', CLARIFYING: '追问中', QUIZ_READY: '准备测验', QUIZZING: '测验中', COMPLETED: '已完成', RECALLING: '独立回忆', READY_TO_COMPLETE: '待完成复习', ABANDONED: '已放弃' };
