'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AiAccessOverview, OAuthSessionView } from '@sanxing/contracts';
import { HttpError, errorMessage, type ApiClient } from '../../lib/api-client';

export const isWaiting = (session: OAuthSessionView | null) => !!session && ['starting', 'waiting', 'working'].includes(session.status);
export function accessError(cause: unknown): string {
  if (cause instanceof HttpError && cause.status === 401) return '本站密码登录已失效，请重新登录；这不表示 AI 厂商授权失效。';
  return errorMessage(cause, '网络连接失败，请重试。');
}

/** OAuth state is separate from learning state. Nothing here persists submitted input. */
export function useOAuth(api: ApiClient) {
  const [overview, setOverview] = useState<AiAccessOverview | null>(null);
  const latest = useRef<AiAccessOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ providerId: string; message: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const locked = useRef(false);
  const scope = useRef<AbortController | null>(null);
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision(value => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    return () => { controller.abort(); scope.current = null; };
  }, []);

  useEffect(() => {
    if (busy) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    const poll = async () => {
      if (controller.signal.aborted || locked.current) return;
      let authenticationExpired = false;
      try {
        const next = await api<AiAccessOverview>('/ai/access', { signal: controller.signal });
        if (controller.signal.aborted || locked.current) return;
        latest.current = next;
        setOverview(next);
        setError(null);
      } catch (cause) {
        if (controller.signal.aborted || locked.current) return;
        authenticationExpired = cause instanceof HttpError && cause.status === 401;
        setError(accessError(cause));
      } finally {
        if (!controller.signal.aborted && !locked.current) setLoading(false);
      }
      // No background OAuth starts; only read the server's in-progress session.
      if (!controller.signal.aborted && !locked.current && !authenticationExpired && latest.current?.providers.some(provider => isWaiting(provider.session))) {
        timer = setTimeout(() => { void poll(); }, 2000);
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, busy, revision]);

  const perform = useCallback(async (providerId: string, path: string, body: unknown = {}): Promise<boolean> => {
    const controller = scope.current;
    if (!controller || controller.signal.aborted || locked.current) return false;
    locked.current = true;
    setBusy(providerId);
    setActionError(null);
    try {
      const result = await api<OAuthSessionView | { ok: true }>(path, { method: 'POST', body, signal: controller.signal });
      if (controller.signal.aborted) return false;
      const current = latest.current;
      if (current) {
        const next: AiAccessOverview = { ...current, providers: current.providers.map(provider => provider.id !== providerId ? provider : (
          'status' in result ? { ...provider, session: result } : { ...provider, connected: false, expiresAt: null, session: null }
        )) };
        latest.current = next;
        setOverview(next);
      }
      return true;
    } catch (cause) {
      if (!controller.signal.aborted) setActionError({ providerId, message: accessError(cause) });
      return false;
    } finally {
      locked.current = false;
      if (!controller.signal.aborted) { setBusy(null); retry(); }
    }
  }, [api, retry]);

  return { overview, loading, error, actionError, busy, retry, perform };
}
