'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { LIMITS, documentUploadLimit, isUploadFilename } from '@sanxing/contracts';
import { useApp, today } from './store';
import { useConfirm } from './confirm';

export type ComposerInput = { text: string; attachment?: boolean; file?: File };
type Target = { path: string; accept: (input: ComposerInput) => void | Promise<void> };
type Bridge = { send: (input: ComposerInput) => Promise<void>; register: (target: Target) => () => void; pending: boolean; recovery: ComposerInput | null; clearRecovery: () => void; text: string; setText: Dispatch<SetStateAction<string>> };
const Context = createContext<Bridge | null>(null);

export function ComposerProvider({ children }: { children: ReactNode }) {
  const { state, command, setError } = useApp();
  const path = usePathname();
  const router = useRouter();
  const confirm = useConfirm();
  const target = useRef<Target | null>(null);
  const queued = useRef<ComposerInput | null>(null);
  const locked = useRef(false);
  const [pending, setPending] = useState(false);
  const [recovery, setRecovery] = useState<ComposerInput | null>(null);
  const [text, setText] = useState('');
  const clearRecovery = useCallback(() => setRecovery(null), []);
  const register = useCallback((next: Target) => {
    target.current = next;
    if (queued.current && next.path === '/recite') {
      const input = queued.current;
      queued.current = null;
      void Promise.resolve().then(() => next.accept(input)).catch(cause => { setRecovery(input); setError(cause instanceof Error ? cause.message : '输入未能加入草稿，请重试。'); })
        .finally(() => { locked.current = false; setPending(false); });
    }
    return () => { if (target.current === next) target.current = null; };
  }, [setError]);
  async function send(input: ComposerInput) {
    if (locked.current || !state) throw new Error('正在处理上一条输入，请稍候。');
    if (input.file && (!isUploadFilename(input.file.name) || input.file.size > documentUploadLimit(input.file.name, state.capabilities.maxUploadBytes))) throw new Error('请选择符合大小限制的文件：PDF 最大 20 MB，图片最大 10 MB，文本笔记按页面限制。');
    if (!input.file && !input.attachment && input.text.length > LIMITS.recitationFieldChars) throw new Error('内容较长，请以粘贴笔记附件的方式加入。');
    locked.current = true; setPending(true);
    try {
      if (target.current?.path === path && (!input.file && !input.attachment || path === '/recite')) {
        await target.current.accept(input);
        locked.current = false; setPending(false);
      } else {
        if (document.querySelector('[data-unsaved="true"]') && !await confirm({ title: '前往今日复述', message: '当前页面还有未保存内容。请先保存，或确认前往今日复述添加这条输入。', confirmLabel: '前往复述', cancelLabel: '留在此页' })) throw new Error('输入已保留，请先保存当前页面。');
        const day = today(state.timezone);
        if (!state.recitations.some(item => item.learningDate === day)) await command('/recitations', { learningDate: day });
        queued.current = input;
        router.push('/recite');
      }
    } catch (cause) { locked.current = false; setPending(false); throw cause; }
  }
  return <Context.Provider value={{ send, register, pending, recovery, clearRecovery, text, setText }}>{children}</Context.Provider>;
}

export function useComposer() {
  const context = useContext(Context);
  if (!context) throw new Error('ComposerProvider is required');
  return context;
}

export function useComposerTarget(accept: Target['accept']) {
  const { register } = useComposer();
  const path = usePathname();
  const latest = useRef(accept);
  latest.current = accept;
  useEffect(() => register({ path, accept: input => latest.current(input) }), [path, register]);
}
