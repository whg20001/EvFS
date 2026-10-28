'use client';

import { Children, createContext, isValidElement, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info } from 'lucide-react';
import { ModalShell } from './modal';

type Entry = { id: string; key: string };
type Queue = { active: string | undefined; enqueue: (entry: Entry) => void; dismiss: (id: string) => void };
const Context = createContext<Queue | null>(null);

/** One notice at a time; duplicate messages from a command and its screen share one dialog. */
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Entry[]>([]);
  const enqueue = useCallback((entry: Entry) => setQueue(current => {
    if (current.some(item => item.id === entry.id || item.key === entry.key)) return current;
    return [...current, entry];
  }), []);
  const dismiss = useCallback((id: string) => setQueue(current => current.some(item => item.id === id) ? current.filter(item => item.id !== id) : current), []);
  return <Context.Provider value={{ active: queue[0]?.id, enqueue, dismiss }}>{children}</Context.Provider>;
}

function messageText(children: ReactNode): string {
  return Children.toArray(children).map(child => {
    if (typeof child === 'string' || typeof child === 'number') return String(child);
    if (!isValidElement<{ children?: ReactNode }>(child) || child.type === 'button' || child.type === 'a') return '';
    return messageText(child.props.children);
  }).join('').trim();
}

export function Feedback({ children, title = '提示', tone = 'info', className = '', dedupeKey, onDismiss }: {
  children: ReactNode; title?: string; tone?: 'info' | 'success' | 'error'; className?: string; dedupeKey?: string; onDismiss?: () => void;
}) {
  const queue = useContext(Context); if (!queue) throw new Error('FeedbackProvider is required');
  const id = useId(); const opener = useRef<HTMLElement | null>(null);
  const key = dedupeKey ?? (messageText(children) || title);
  const { enqueue, dismiss, active } = queue;
  useEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    enqueue({ id, key });
    return () => dismiss(id);
  }, [enqueue, dismiss, id, key]);
  if (active !== id) return null;
  const close = () => { dismiss(id); onDismiss?.(); };
  const Icon = tone === 'success' ? CircleCheck : tone === 'error' ? CircleAlert : Info;
  return <ModalShell className={`modal feedback-dialog ${tone}`} role="alertdialog" labelledBy={`${id}-title`} describedBy={`${id}-message`} opener={opener.current} initialFocus="[data-feedback-close]" close={close}>
    <div className="modal-head"><span className={`modal-icon ${tone}`}><Icon size={22} /></span><h2 id={`${id}-title`}>{title}</h2></div>
    <div id={`${id}-message`} className={`modal-message ${className}`}>{children}</div>
    <div className="modal-actions"><button type="button" className="button primary" data-feedback-close onClick={close}>知道了</button></div>
  </ModalShell>;
}
