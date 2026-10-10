'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const focusableSelector = 'a[href],area[href],button,input,select,textarea,summary,[tabindex],[contenteditable="true"],audio[controls],video[controls]';

export function ModalShell({ children, close, opener, initialFocus, className, backdropClass = '', role = 'dialog', labelledBy, describedBy }: {
  children: ReactNode; close: () => void; opener: HTMLElement | null; initialFocus: string; className: string;
  backdropClass?: string; role?: 'dialog' | 'alertdialog'; labelledBy: string; describedBy?: string;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = dialog.current!;
    const overflow = document.body.style.overflow;
    const background = [...document.body.children].filter((node): node is HTMLElement => node instanceof HTMLElement && !node.contains(root)).map(node => ({ node, inert: node.inert }));
    background.forEach(({ node }) => { node.inert = true; });
    document.body.style.overflow = 'hidden';
    (root.querySelector<HTMLElement>(initialFocus) ?? root).focus();
    return () => {
      document.body.style.overflow = overflow;
      background.forEach(({ node, inert }) => { node.inert = inert; });
      // An Action opener may stay disabled until its async handler settles.
      let frames = 0;
      const restore = () => {
        if (!opener?.isConnected || document.activeElement === opener || frames++ >= 30) return;
        if (document.activeElement !== document.body) return;
        opener.focus();
        if (document.activeElement !== opener) requestAnimationFrame(restore);
      };
      requestAnimationFrame(restore);
    };
  }, [opener, initialFocus]);
  return createPortal(<div className={`modal-backdrop ${backdropClass}`} onMouseDown={event => { if (event.target === event.currentTarget) { event.preventDefault(); close(); } }}>
    <div ref={dialog} className={className} role={role} aria-modal="true" aria-labelledby={labelledBy} aria-describedby={describedBy} tabIndex={-1} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key !== 'Tab') return;
      const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])].filter(node => node.tabIndex >= 0 && !node.matches(':disabled') && !node.closest('[inert]') && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden');
      const index = focusable.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey ? (index <= 0 ? focusable.length - 1 : index - 1) : (index + 1) % focusable.length;
      event.preventDefault(); (focusable[next] ?? dialog.current)?.focus();
    }}>{children}</div>
  </div>, document.body);
}
