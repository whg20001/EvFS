'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const focusableSelector = 'a[href],area[href],button,input,select,textarea,summary,[tabindex],[contenteditable="true"],audio[controls],video[controls]';
const stack: HTMLElement[] = [];
const originalInert = new Map<HTMLElement, boolean>();
let originalOverflow = '';
function synchronizeModals() {
  const top = stack.at(-1);
  if (!top) {
    document.body.style.overflow = originalOverflow;
    for (const [node, inert] of originalInert) if (node.isConnected) node.inert = inert;
    originalInert.clear(); return;
  }
  document.body.style.overflow = 'hidden';
  for (const node of document.body.children) if (node instanceof HTMLElement) {
    if (!originalInert.has(node)) originalInert.set(node, node.inert);
    node.inert = !node.contains(top);
  }
}

export function ModalShell({ children, close, opener, initialFocus, className, backdropClass = '', role = 'dialog', labelledBy, describedBy }: {
  children: ReactNode; close: () => void; opener: HTMLElement | null; initialFocus: string; className: string;
  backdropClass?: string; role?: 'dialog' | 'alertdialog'; labelledBy: string; describedBy?: string;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = dialog.current!;
    if (!stack.length) originalOverflow = document.body.style.overflow;
    stack.push(root); synchronizeModals();
    (root.querySelector<HTMLElement>(initialFocus) ?? root).focus({ preventScroll: true });
    return () => {
      const index = stack.indexOf(root); if (index >= 0) stack.splice(index, 1);
      synchronizeModals();
      // An Action opener may stay disabled until its async handler settles.
      let frames = 0;
      const restore = () => {
        if (!opener?.isConnected || document.activeElement === opener || frames++ >= 30) return;
        if (document.activeElement !== document.body) return;
        opener.focus({ preventScroll: true });
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
