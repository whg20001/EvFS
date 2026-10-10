'use client';

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ModalShell } from './modal';
import { CircleAlert, CircleHelp } from 'lucide-react';

export interface ConfirmOptions {
  title: string;
  /** Plain text; each line becomes a paragraph. */
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive or irreversible: red confirm button, initial focus on cancel. */
  tone?: 'danger';
}
type Pending = ConfirmOptions & { resolve: (ok: boolean) => void; opener: HTMLElement | null };

const Context = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null);

/** In-page replacement for window.confirm: same yes/no contract, resolved asynchronously. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const current = useRef<Pending | null>(null);
  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>(resolve => {
    current.current?.resolve(false); // a newer question supersedes an unanswered one
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    current.current = { ...options, resolve, opener };
    setPending(current.current);
  }), []);
  const close = useCallback((ok: boolean) => {
    current.current?.resolve(ok); current.current = null; setPending(null);
  }, []);
  return <Context.Provider value={confirm}>{children}{pending && <ConfirmDialog key={pending.title + pending.message} options={pending} close={close} />}</Context.Provider>;
}

/** Native tab-close warning while `dirty()` holds; browsers do not allow an in-page dialog here. */
export function useBeforeUnload(dirty: () => boolean) {
  const check = useRef(dirty);
  check.current = dirty;
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (check.current()) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
}

export function useConfirm() {
  const confirm = useContext(Context);
  if (!confirm) throw new Error('ConfirmProvider missing');
  return confirm;
}

function ConfirmDialog({ options, close }: { options: Pending; close: (ok: boolean) => void }) {
  const id = useId();
  const danger = options.tone === 'danger';
  const Icon = danger ? CircleAlert : CircleHelp;
  return <ModalShell className="modal" role="alertdialog" labelledBy={`${id}-title`} describedBy={`${id}-message`} opener={options.opener} initialFocus={danger ? '[data-cancel]' : '[data-confirm]'} close={() => close(false)}>
      <div className="modal-head"><span className={`modal-icon ${danger ? 'danger' : ''}`}><Icon size={20} /></span><h2 id={`${id}-title`}>{options.title}</h2></div>
      <div id={`${id}-message`} className="modal-message">{options.message.split('\n').filter(Boolean).map((line, index) => <p key={index}>{line}</p>)}</div>
      <div className="modal-actions">
        <button type="button" className="button" data-cancel onClick={() => close(false)}>{options.cancelLabel ?? '取消'}</button>
        <button type="button" className={`button ${danger ? 'danger' : 'primary'}`} data-confirm onClick={() => close(true)}>{options.confirmLabel ?? '确定'}</button>
      </div>
  </ModalShell>;
}
