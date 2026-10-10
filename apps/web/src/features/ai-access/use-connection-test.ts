'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isActiveRun, type AiConnectionTestView, type AiModelSelection } from '@sanxing/contracts';
import type { ApiClient } from '../../lib/api-client';
import { accessError } from './use-oauth';

export const testInProgress = (test: AiConnectionTestView | null) => !!test && isActiveRun(test);

/** Reads never start a test. Mutations have a feature-local lock and are never retried. */
export function useConnectionTest(api: ApiClient, providerId: string, onComplete: () => void) {
  const [test, setTest] = useState<AiConnectionTestView | null>(null);
  const latest = useRef<AiConnectionTestView | null>(null);
  const completed = useRef(new Set<string>());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const locked = useRef(false);
  const scope = useRef<AbortController | null>(null);
  const reader = useRef<AbortController | null>(null);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  const path = `/ai/providers/${encodeURIComponent(providerId)}/test`;

  const accept = useCallback((next: AiConnectionTestView | null, justStarted = false) => {
    const previous = latest.current;
    latest.current = next;
    setTest(next);
    if (next && !testInProgress(next) && (justStarted || (previous?.id === next.id && testInProgress(previous))) && !completed.current.has(next.id)) {
      completed.current.add(next.id);
      onComplete();
    }
  }, [onComplete]);

  useEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    return () => { controller.abort(); scope.current = null; };
  }, []);

  useEffect(() => {
    if (busy) return;
    const controller = new AbortController();
    reader.current = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    const poll = async () => {
      try {
        const next = await api<{ test: AiConnectionTestView | null }>(path, { signal: controller.signal });
        if (controller.signal.aborted || locked.current) return;
        accept(next.test);
        setReadError(null);
        if (testInProgress(next.test)) timer = setTimeout(() => { void poll(); }, 1500);
      } catch (cause) {
        // Stop on read failure; an explicit refresh resumes observing, never resubmits.
        if (!controller.signal.aborted && !locked.current) setReadError(accessError(cause));
      } finally {
        if (!controller.signal.aborted && !locked.current) setLoading(false);
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, path, busy, revision, accept]);

  const perform = async (selection?: AiModelSelection) => {
    const controller = scope.current;
    const current = latest.current;
    if (!controller || controller.signal.aborted || locked.current) return;
    if (selection ? testInProgress(current) : !current || !testInProgress(current)) return;
    locked.current = true;
    reader.current?.abort();
    setBusy(true);
    setActionError(null);
    try {
      if (selection) {
        const next = await api<AiConnectionTestView>(path, {
          method: 'POST', body: { confirm: true, expectedSelection: selection }, signal: controller.signal,
        });
        if (!controller.signal.aborted) accept(next, true);
      } else {
        await api(`/runs/${encodeURIComponent(current!.id)}/cancel`, { method: 'POST', body: {}, signal: controller.signal });
      }
    } catch (cause) {
      if (!controller.signal.aborted) setActionError(`${accessError(cause)} 操作不会自动重试；请求可能已被接收，请刷新测试状态确认。`);
    } finally {
      locked.current = false;
      if (!controller.signal.aborted) { setLoading(true); setBusy(false); refresh(); }
    }
  };

  return { test, loading, busy, readError, actionError, refresh, start: (selection: AiModelSelection) => perform(selection), cancel: () => perform() };
}
