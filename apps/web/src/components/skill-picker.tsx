'use client';

import { Feedback } from './feedback';
import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, RefreshCw, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { SKILL_LIMITS, SKILL_TASK_LABELS, type SkillSelection, type SkillSummary, type SkillTask } from '@sanxing/contracts';
import { useApp } from './store';
import { errorMessage } from '../lib/api-client';

export function useTaskSkills(task: SkillTask) {
  const { api } = useApp(); const [items, setItems] = useState<SkillSummary[]>([]); const [selection, setSelection] = useState<SkillSelection>([]);
  const [error, setError] = useState(''); const [loading, setLoading] = useState(true); const [refresh, setRefresh] = useState(0);
  const current = useRef(selection); current.current = selection;
  useEffect(() => {
    const controller = new AbortController(); setLoading(true);
    void api<{ items: SkillSummary[] }>('/ai/skills', { signal: controller.signal }).then(data => { if (!controller.signal.aborted) { setItems(data.items); setError(''); } })
      .catch(cause => { if (!controller.signal.aborted) setError(errorMessage(cause, '无法读取 Skill。')); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, refresh]);
  return { task, items, selection, current, setSelection, error, loading, refresh: () => { setSelection([]); setRefresh(value => value + 1); } };
}
export function SkillPicker({ skills, disabled = false }: { skills: ReturnType<typeof useTaskSkills>; disabled?: boolean }) {
  const [open, setOpen] = useState(false); const [above, setAbove] = useState(false); const id = useId(); const root = useRef<HTMLDivElement>(null); const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', dismiss); return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  const available = skills.items.filter(item => item.enabled && item.tasks.includes(skills.task));
  const selected = skills.selection.map(item => skills.items.find(skill => skill.id === item.id)?.name ?? '已变更 Skill');
  return <div className="task-skill-picker" ref={root} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={event => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); button.current?.focus(); } }}>
    {skills.error && <Feedback title="Skill 列表读取失败" tone="error">{skills.error}</Feedback>}
    <button ref={button} type="button" className="task-skill-trigger" disabled={disabled} aria-expanded={open} aria-controls={id} aria-haspopup="dialog" aria-label={`${SKILL_TASK_LABELS[skills.task]}使用的 Skill${selected.length ? `，已选 ${selected.length} 个` : '，未选择'}`} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setAbove(rect.bottom + 340 > innerHeight && rect.top > 340); setOpen(value => !value); }}><Sparkles size={14} /><span>{selected.length ? `Skill · ${selected.length} 个已选` : 'Skill · 不使用'}</span><ChevronDown size={13} /></button>
    {open && <div className="task-skill-menu" data-above={above || undefined} role="dialog" aria-label={`${SKILL_TASK_LABELS[skills.task]} Skill 选择`} id={id}>
      <div className="task-skill-heading"><strong>本次{SKILL_TASK_LABELS[skills.task]}使用哪些 Skill</strong><button type="button" className="quiet-icon" aria-label="刷新可选 Skill" disabled={skills.loading || disabled} onClick={skills.refresh}><RefreshCw size={14} /></button></div>
      <p>默认不使用，最多选择 {SKILL_LIMITS.active} 个。仅随本次任务调用。</p>
      {skills.loading && <p role="status">正在读取 Skill…</p>}
      <div className="task-skill-options">{available.map(item => {
        const checked = skills.selection.some(selected => selected.id === item.id);
        return <label key={item.id}><input type="checkbox" checked={checked} disabled={disabled || !checked && skills.selection.length >= SKILL_LIMITS.active} onChange={event => skills.setSelection(current => event.target.checked ? [...current, { id: item.id, version: item.version }] : current.filter(selected => selected.id !== item.id))} /><span><strong>{item.name}<small>v{item.version}</small></strong><span>{item.description}</span></span></label>;
      })}</div>
      {!skills.loading && !available.length && <p>没有适用于本任务的可选 Skill。请先导入并启用对应任务。</p>}
      <div className="task-skill-bottom"><Link href="/ai-access">管理 Skill</Link><button type="button" className="text-button" disabled={disabled || !skills.selection.length} onClick={() => skills.setSelection([])}>清空选择</button><button type="button" className="button subtle" onClick={() => { setOpen(false); button.current?.focus(); }}>完成</button></div>
    </div>}
    {!!selected.length && <span className="task-skill-selected" title={selected.join('、')}>{selected.join('、')}</span>}
  </div>;
}
