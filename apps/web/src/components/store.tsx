'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { isActiveRun, type AccountIdentity, type AuthStatus, type LocalBootstrap, type CommandResult, type PublicState, type PublicStateUpdate } from '@sanxing/contracts';
import { HttpError, errorMessage, request, cloudRequest, useLocalTransport, requestId, type ApiClient, type ApiOptions, type ImportOptions } from '../lib/api-client';
import type { LocalLearning } from '../lib/local-learning';
import { useBeforeUnload, useConfirm } from './confirm';
import { reconcileState } from '../lib/state-sync';
import { RunProgressProvider } from './run-progress';

type Mutation = { result: CommandResult; state: PublicState };
type CommandOptions = ImportOptions & { errorHandling?: 'local' };
type Store = {
  state: PublicState | null; loading: boolean; authenticated: boolean; busy: boolean;
  error: string | null; setError: (message: string | null) => void;
  reload: () => Promise<PublicState>; login: (password: string, username?: string) => Promise<void>; logout: () => Promise<void>;
  register: (username: string, password: string) => Promise<void>; user: AccountIdentity | null; storageMode: 'browser' | 'server'; registrationEnabled: boolean;
  command: (path: string, body?: object | FormData, method?: string, options?: CommandOptions) => Promise<Mutation>;
  api: ApiClient;
};
const Context = createContext<Store | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PublicState | null>(null);
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<AccountIdentity | null>(null);
  const [storageMode, setStorageMode] = useState<'browser' | 'server'>('server');
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const [sessionExpiresAt, setSessionExpiresAt] = useState<number | null>(null);
  const local = useRef<LocalLearning | null>(null);
  const accountChannel = useRef<BroadcastChannel | null>(null);
  const stateRef = useRef<PublicState | null>(null);
  const locked = useRef<number | null>(null);
  const epoch = useRef(0);
  // Rotate the API identity only after a successful full reload. Readers refresh
  // their effects/caches; mounted editors keep local input and version checks.
  const [readSession, setReadSession] = useState(0);
  const router = useRouter();
  const pathname = usePathname();
  const returnPath = useRef('/recite');
  const lockLocal = () => useLocalTransport(async () => { throw new HttpError(401, 'LOCAL_STORAGE_LOCKED', '请登录后打开此账号的本地学习数据。'); });
  const notifyAccountChange = () => {
    accountChannel.current?.postMessage('session-changed');
    try { localStorage.setItem('sanxing-auth-event', requestId()); } catch { /* BroadcastChannel remains available. */ }
  };
  const prepareStorage = useCallback(async (status: AuthStatus, currentEpoch: number) => {
    if (status.storage !== 'browser') { useLocalTransport(null); setStorageMode('server'); setUser(null); setSessionExpiresAt(null); return; }
    setStorageMode('browser'); lockLocal();
    if (!status.user) throw new Error('账号身份缺失，请重新登录。');
    await local.current?.close(); local.current = null;
    const bootstrap = await cloudRequest<LocalBootstrap>('/gateway/bootstrap');
    if (bootstrap.user.id !== status.user.id) throw new Error('账号已切换，请重新登录。');
    const runtime = await (await import('../lib/local-learning')).openLocalLearning(bootstrap);
    if (epoch.current !== currentEpoch) { await runtime.close(); throw new Error('登录状态已变化。'); }
    local.current = runtime; useLocalTransport(runtime.request); setUser(bootstrap.user); setSessionExpiresAt(bootstrap.expiresAt);
  }, []);
  useEffect(() => {
    if (sessionExpiresAt === null) return;
    const timer = setTimeout(() => {
      if (!local.current) return;
      epoch.current++; lockLocal(); void local.current.close(); local.current = null;
      locked.current = null; stateRef.current = null; setAuthenticated(false); setBusy(false);
      setError('登录已到期，请重新登录；此设备的学习数据继续保留。'); router.replace('/login');
    }, Math.max(0, sessionExpiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [sessionExpiresAt, router]);
  useEffect(() => {
    const invalidate = () => {
      if (!local.current) return;
      epoch.current++; lockLocal();
      void local.current.close(); local.current = null; locked.current = null; stateRef.current = null;
      setState(null); setUser(null); setAuthenticated(false); setBusy(false);
      setError('账号状态已在其他标签页变化，请重新登录。'); router.replace('/login');
    };
    if (typeof BroadcastChannel !== 'undefined') { accountChannel.current = new BroadcastChannel('sanxing-accounts'); accountChannel.current.onmessage = invalidate; }
    const changed = (event: StorageEvent) => { if (event.key === 'sanxing-auth-event') invalidate(); };
    window.addEventListener('storage', changed);
    return () => { accountChannel.current?.close(); accountChannel.current = null; window.removeEventListener('storage', changed); };
  }, [router]);
  useEffect(() => {
    const close = () => { lockLocal(); void local.current?.close(); local.current = null; };
    const restore = (event: PageTransitionEvent) => { if (event.persisted) window.location.reload(); };
    window.addEventListener('pagehide', close); window.addEventListener('pageshow', restore);
    return () => { window.removeEventListener('pagehide', close); window.removeEventListener('pageshow', restore); close(); };
  }, []);
  const authFailure = useCallback((cause: unknown) => {
    if (cause instanceof HttpError && cause.status === 401) {
      epoch.current += 1; stateRef.current = null; locked.current = null;
      setBusy(false); setAuthenticated(false);
      // Keep the mounted editor and its unsaved input while the login overlay is shown.
      router.replace('/login');
    }
    const text = errorMessage(cause, '网络连接失败，输入已保留。');
    setError(cause instanceof HttpError && (cause.code.includes('VERSION_CONFLICT') || cause.status === 409)
      ? `${text} 请刷新服务端状态后核对版本；本地输入仍保留，不会自动覆盖。` : text);
  }, [router]);
  useEffect(() => { if (pathname !== '/login') returnPath.current = pathname; }, [pathname]);
  const reload = useCallback(async () => {
    const currentEpoch = epoch.current;
    try {
      for (let collisions = 0; collisions < 3; collisions++) {
        const baseline = stateRef.current;
        // Metadata snapshots; completed assessments are fetched on demand.
        const since = baseline && collisions < 2 ? baseline.revision : undefined;
        const response = await request<PublicState | PublicStateUpdate>(since === undefined ? '/state?compact=1' : `/state?compact=1&since=${since}`);
        if (currentEpoch !== epoch.current) throw new Error('登录状态已变化，请重新加载。');
        const next = reconcileState(stateRef.current, baseline, response);
        if (!next) continue;
        stateRef.current = next;
        setState(next);
        return next;
      }
      throw new Error('状态同步版本不一致，请刷新重试；本地输入仍保留。');
    } catch (cause) { if (currentEpoch === epoch.current) authFailure(cause); throw cause; }
  }, [authFailure]);
  useEffect(() => {
    let alive = true;
    const currentEpoch = epoch.current;
    void (async () => {
      try {
        const status = await cloudRequest<AuthStatus>('/auth/status');
        if (!alive || currentEpoch !== epoch.current) return;
        setStorageMode(status.storage === 'browser' ? 'browser' : 'server'); setRegistrationEnabled(!!status.registrationEnabled);
        if (status.storage === 'browser' && !status.authenticated) lockLocal();
        if (status.authenticated) {
          await prepareStorage(status, currentEpoch);
          if (!alive || currentEpoch !== epoch.current) return;
          setAuthenticated(true);
          await reload();
          // A valid cookie can open /login directly, without calling login().
          // Check the current URL after reload; pathname in this effect's closure
          // can be stale, and adding it as a dependency would repeat auth loading.
          if (alive && currentEpoch === epoch.current && window.location.pathname === '/login') router.replace(returnPath.current);
        } else { setAuthenticated(false); router.replace('/login'); }
      } catch (cause) { if (alive && currentEpoch === epoch.current) authFailure(cause); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [authFailure, prepareStorage, reload, router]);
  const hasActiveRuns = state?.runs.some(isActiveRun) ?? false;
  useEffect(() => {
    if (!hasActiveRuns || !authenticated) return;
    let stopped = false;
    let timeout: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await reload(); } catch { /* Visible error; retry without overlapping requests. */ }
      if (!stopped) timeout = setTimeout(poll, 1000);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timeout); };
  }, [hasActiveRuns, authenticated, reload]);

  // Feature requests share authentication, not the learning command lock/reload cycle.
  const api: ApiClient = useCallback(async <T,>(path: string, options: ApiOptions = {}): Promise<T> => {
    const currentEpoch = epoch.current;
    const method = (options.method ?? 'GET').toUpperCase();
    const writing = method !== 'GET' && method !== 'HEAD';
    const headers: Record<string, string> = {};
    if (writing) {
      headers['X-CSRF-Token'] = stateRef.current?.csrfToken ?? '';
      headers['Idempotency-Key'] = requestId();
    }
    const multipart = options.body instanceof FormData;
    if (options.body !== undefined && !multipart) headers['Content-Type'] = 'application/json';
    try {
      const result = await request<T>(path, { method, headers, signal: options.signal, onImportProgress: options.onImportProgress, body: multipart ? options.body as FormData : options.body === undefined ? undefined : JSON.stringify(options.body) });
      if (currentEpoch !== epoch.current) throw new Error('登录状态已变化，请重新读取。');
      return result;
    } catch (cause) {
      // Only identity expiry is global; feature errors belong to the feature UI.
      if (currentEpoch === epoch.current && !options.signal?.aborted && cause instanceof HttpError && cause.status === 401) authFailure(cause);
      throw cause;
    }
  }, [authFailure, readSession]);

  const command = useCallback(async (path: string, body: object | FormData = {}, method = 'POST', options: CommandOptions = {}): Promise<Mutation> => {
    if (locked.current !== null) throw new Error('另一个操作正在保存，请稍后再试。');
    const currentEpoch = epoch.current;
    locked.current = currentEpoch;
    setBusy(true);
    setError(null);
    try {
      const headers: Record<string, string> = {
        'X-CSRF-Token': stateRef.current?.csrfToken ?? '',
        'Idempotency-Key': requestId(),
      };
      const multipart = body instanceof FormData;
      if (!multipart) headers['Content-Type'] = 'application/json';
      const result = await request<CommandResult>(path, { method, headers, onImportProgress: options.onImportProgress, body: multipart ? body : JSON.stringify(body) });
      if (currentEpoch !== epoch.current) throw new Error('登录状态已变化，请核对保存结果。');
      const next = await reload();
      return { result, state: next };
    } catch (cause) { if (currentEpoch === epoch.current && (options.errorHandling !== 'local' || cause instanceof HttpError && cause.status === 401)) authFailure(cause); throw cause; }
    finally { if (locked.current === currentEpoch) { locked.current = null; setBusy(false); } }
  }, [authFailure, reload]);
  const authenticate = useCallback(async (password: string, username?: string, register = false) => {
    const currentEpoch = ++epoch.current;
    locked.current = null;
    setBusy(true); setError(null);
    try {
      const status = await cloudRequest<AuthStatus>(register ? '/auth/register' : '/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestId() }, body: JSON.stringify({ password, ...(username ? { username } : {}) }),
      });
      // A new server/session can have the same revision in a different database.
      // Keep mounted editor drafts, but never reuse that session's sync baseline.
      if (currentEpoch !== epoch.current) return;
      stateRef.current = null;
      await prepareStorage(status, currentEpoch);
      setAuthenticated(true);
      if (status.storage === 'browser') notifyAccountChange();
      await reload();
      if (currentEpoch === epoch.current) { setReadSession(currentEpoch); router.replace(returnPath.current); }
    } catch (cause) { if (currentEpoch === epoch.current) authFailure(cause); throw cause; }
    finally { if (currentEpoch === epoch.current) setBusy(false); }
  }, [authFailure, prepareStorage, reload, router]);
  const login = useCallback((password: string, username?: string) => authenticate(password, username), [authenticate]);
  const register = useCallback((username: string, password: string) => authenticate(password, username, true), [authenticate]);
  // Logout cannot reload protected state after the cookie has been revoked.
  const safeLogout = useCallback(async () => {
    const currentEpoch = epoch.current;
    setBusy(true);
    try {
      await request<CommandResult>('/auth/logout', { method: 'POST', headers: {
        'Content-Type': 'application/json', 'X-CSRF-Token': stateRef.current?.csrfToken ?? '', 'Idempotency-Key': requestId(),
      }, body: '{}' });
      if (currentEpoch !== epoch.current) return;
      await local.current?.close(); local.current = null;
      if (storageMode === 'browser') lockLocal();
      if (storageMode === 'browser') notifyAccountChange();
      epoch.current += 1; locked.current = null; stateRef.current = null; setState(null); setBusy(false); setAuthenticated(false); setError(null);
      setUser(null);
      clearDraftCache(); router.replace('/login');
    } catch (cause) { if (currentEpoch === epoch.current) authFailure(cause); throw cause; }
    finally { if (currentEpoch === epoch.current) setBusy(false); }
  }, [authFailure, router, storageMode]);
  const value = useMemo(() => ({ state, loading, authenticated, busy, error, setError, reload, login, register, user, storageMode, registrationEnabled, logout: safeLogout, command, api }),
    [state, loading, authenticated, busy, error, reload, login, register, user, storageMode, registrationEnabled, safeLogout, command, api]);
  return <Context.Provider value={value}><RunProgressProvider key={user?.id ?? 'server-owner'} active={hasActiveRuns && authenticated} session={epoch.current} api={api}>{children}</RunProgressProvider></Context.Provider>;
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
  const { user } = useApp();
  const key = `sanxing:draft:${user ? `${user.id}:` : ''}${cacheKey}`;
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
  const accept = (nextVersion: number, savedValue: T) => {
    baseVersion.current = nextVersion; baseline.current = JSON.stringify(savedValue); persistRef.current();
    setStatus(JSON.stringify(valueRef.current) === baseline.current ? 'saved' : 'dirty');
  };
  return { value, change, status, save, reset, accept, version: () => baseVersion.current, dirty: () => JSON.stringify(valueRef.current) !== baseline.current };
}

export function useLocalText(key: string, initial = ''): [string, (value: string) => void] {
  const { user } = useApp();
  const storageKey = `sanxing:input:${user ? `${user.id}:` : ''}${key}`;
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
export function useToday(timezone: string) {
  const [day, setDay] = useState(() => today(timezone));
  useEffect(() => {
    const refresh = () => setDay(today(timezone));
    refresh();
    const timer = setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [timezone]);
  return day;
}
export const sessionLabels: Record<string, string> = { CONFIRMING: '确认知识点', CLARIFYING: '追问中', QUIZ_READY: '准备测验', QUIZZING: '测验中', COMPLETED: '已完成', RECALLING: '独立回忆', READY_TO_COMPLETE: '待完成复习', ABANDONED: '已放弃' };
