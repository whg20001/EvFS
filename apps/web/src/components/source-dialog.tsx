'use client';

import { useId, type ReactNode, type RefObject } from 'react';
import { ModalShell } from './modal';
import { Minimize2 } from 'lucide-react';

export function SourceDialog({ name, lineCount, controls, children, close, opener }: { name: string; lineCount: number; controls: ReactNode; children: ReactNode; close: () => void; opener: RefObject<HTMLButtonElement | null> }) {
  const id = useId();
  return <ModalShell className="source-modal" backdropClass="source-backdrop" labelledBy={id} opener={opener.current} initialFocus="[data-close]" close={close}>
      <header className="source-modal-header"><div className="source-modal-title"><h2 id={id}>{name}</h2><p className="muted small">{lineCount} 行</p></div>{controls}<button data-close type="button" className="button icon-button" aria-label="退出最大化" title="退出最大化" onClick={close}><Minimize2 size={18} /></button></header>
      <div className="source-modal-body">{children}</div>
  </ModalShell>;
}
