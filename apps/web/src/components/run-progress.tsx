'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { RunProgressMap } from '@sanxing/contracts';
import type { ApiClient } from '../lib/api-client';

const empty: RunProgressMap = {};
const Context = createContext<RunProgressMap>(empty);

/** Only progress subscribers render on clock ticks; learning state stays independent. */
export function RunProgressProvider({ active, session, api, children }: { active: boolean; session: number; api: ApiClient; children: ReactNode }) {
  const [snapshot, setSnapshot] = useState({ session, values: empty });
  useEffect(() => {
    if (!active) { setSnapshot({ session, values: empty }); return; }
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const values = await api<RunProgressMap>('/runs/progress', { signal: controller.signal });
        if (!controller.signal.aborted) setSnapshot({ session, values });
      } catch {
        if (!controller.signal.aborted) setSnapshot({ session, values: empty });
      }
      if (!controller.signal.aborted) timeout = setTimeout(poll, 1000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timeout); };
  }, [active, session, api]);
  return <Context.Provider value={active && snapshot.session === session ? snapshot.values : empty}>{children}</Context.Provider>;
}

export function useRunProgress() { return useContext(Context); }
