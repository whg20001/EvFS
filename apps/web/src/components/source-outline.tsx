'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { sourceOutline } from '../lib/source-outline';
import type { SourceView } from '../lib/source-view';
import SourceMarkdown from './source-markdown';
import { SourceLines } from './source-lines';

export default function SourceOutline({ text, view }: { text: string; view: SourceView }) {
  const headings = useMemo(() => sourceOutline(text), [text]);
  const lines = useMemo(() => new Set(headings.map(item => item.line)), [headings]);
  const [expanded, setExpanded] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const jump = useRef<(line: number) => void>(() => {});
  const navId = useId();
  useEffect(() => {
    const root = content.current;
    if (!root || !headings.length) return;
    const targets = [...root.querySelectorAll<HTMLElement>('[data-source-line]')].filter(node => lines.has(Number(node.dataset.sourceLine)));
    const byLine = new Map(targets.map(node => [Number(node.dataset.sourceLine), node]));
    let frame = 0; let jumpFrame = 0; let settleFrame = 0; let settleTimer = 0; let timer = 0; let highlighted: HTMLElement | undefined;
    let lockedLine: number | null = null; let destination = 0;
    let selection: { line: number; top: number } | undefined;
    const clearHighlight = () => { window.clearTimeout(timer); highlighted?.removeAttribute('data-outline-highlight'); highlighted = undefined; };
    const clearJump = () => {
      cancelAnimationFrame(jumpFrame); jumpFrame = 0;
      cancelAnimationFrame(settleFrame); settleFrame = 0;
      window.clearTimeout(settleTimer); lockedLine = null;
    };
    const update = () => {
      frame = 0;
      if (lockedLine !== null) return;
      if (selection && root.scrollTop !== selection.top) selection = undefined;
      // DOM order also handles headings moved to the footnote section by GFM.
      const top = root.getBoundingClientRect().top + 32;
      let low = 0; let high = targets.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (targets[middle]!.getBoundingClientRect().top <= top) low = middle + 1;
        else high = middle;
      }
      const index = root.scrollTop > 0 && root.scrollTop + root.clientHeight >= root.scrollHeight - 2 ? targets.length - 1 : Math.max(0, low - 1);
      // A bottom-clamped jump may leave several headings visible. Keep the
      // clicked heading until the reader scrolls, including late scroll events.
      setActive(selection?.line ?? (Number(targets[index]?.dataset.sourceLine) || null));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const finishJump = () => {
      if (lockedLine === null) return;
      selection = Math.abs(root.scrollTop - destination) < 2 ? { line: lockedLine, top: root.scrollTop } : undefined;
      clearJump(); schedule();
    };
    const interrupt = () => { if (lockedLine !== null) { clearJump(); schedule(); } };
    const onKeyDown = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) interrupt();
    };
    jump.current = line => {
      const target = byLine.get(line);
      if (!target) return;
      clearJump(); selection = undefined; lockedLine = line; setActive(line);
      setExpanded(false);
      jumpFrame = requestAnimationFrame(() => {
        jumpFrame = 0;
        target.focus({ preventScroll: true });
        destination = Math.max(0, Math.min(root.scrollHeight - root.clientHeight, root.scrollTop + target.getBoundingClientRect().top - root.getBoundingClientRect().top - 16));
        const instant = matchMedia('(prefers-reduced-motion: reduce)').matches;
        root.scrollTo({ top: destination, behavior: instant ? 'instant' : 'smooth' });
        clearHighlight();
        if (view === 'raw') { highlighted = target; target.dataset.outlineHighlight = 'true'; timer = window.setTimeout(clearHighlight, 1800); }
        // Complete smooth, instant and zero-distance jumps through the same path.
        let lastTop = root.scrollTop; let stableFrames = 0;
        const started = performance.now();
        const settle = (now: number) => {
          stableFrames = root.scrollTop === lastTop ? stableFrames + 1 : 0;
          lastTop = root.scrollTop;
          if (stableFrames >= 4 && now - started >= 120) finishJump();
          else settleFrame = requestAnimationFrame(settle);
        };
        settleFrame = requestAnimationFrame(settle);
        settleTimer = window.setTimeout(finishJump, 3000);
      });
    };
    root.addEventListener('scroll', schedule, { passive: true });
    for (const event of ['wheel', 'touchstart', 'pointerdown']) root.addEventListener(event, interrupt, { passive: true });
    root.addEventListener('keydown', onKeyDown);
    const resize = new ResizeObserver(schedule);
    resize.observe(root);
    if (root.firstElementChild) resize.observe(root.firstElementChild);
    schedule();
    return () => {
      root.removeEventListener('scroll', schedule);
      for (const event of ['wheel', 'touchstart', 'pointerdown']) root.removeEventListener(event, interrupt);
      root.removeEventListener('keydown', onKeyDown);
      resize.disconnect(); cancelAnimationFrame(frame);
      if (lockedLine !== null) root.scrollTo({ top: root.scrollTop, behavior: 'instant' });
      clearJump(); clearHighlight(); jump.current = () => {};
    };
  }, [headings, lines, view]);
  return <>
    {headings.length > 0 && <aside className="source-outline" data-expanded={expanded}>
      <button type="button" className="button source-outline-toggle" aria-expanded={expanded} aria-controls={navId} onClick={() => setExpanded(value => !value)}>大纲</button>
      <nav id={navId} aria-label="笔记大纲"><p className="source-outline-title">大纲</p><ol>{headings.map(item => <li key={item.line}><button type="button" data-depth={item.depth} style={{ paddingLeft: `${12 + (item.depth - 1) * 14}px` }} title={item.text || '（无标题）'} aria-current={active === item.line ? 'location' : undefined} onClick={() => jump.current(item.line)}>{item.text || '（无标题）'}</button></li>)}</ol></nav>
    </aside>}
    <div ref={content} className="source-modal-content" tabIndex={0} aria-label="笔记内容">{view === 'formatted' ? <SourceMarkdown text={text} outline /> : <SourceLines text={text} headingLines={lines} />}</div>
  </>;
}
