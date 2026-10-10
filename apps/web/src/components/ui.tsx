'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { ArrowRight, BookOpen, Check, FileText, LoaderCircle, Maximize2, RotateCcw, Save, ShieldCheck, X } from 'lucide-react';
import { isActiveRun, recitationSourceText, type PublicDocument } from '@sanxing/contracts';
import { useApp, useData } from './store';
import { errorMessage } from '../lib/api-client';
import { documentFormat } from '@sanxing/contracts';
import { defaultSourceView, type SourceView } from '../lib/source-view';
import { SourceDialog } from './source-dialog';
import { SourceLines } from './source-lines';

const SourceMarkdown = dynamic(() => import('./source-markdown'), { ssr: false, loading: () => <p role="status">正在排版…</p> });
const SourceOutline = dynamic(() => import('./source-outline'), { ssr: false, loading: () => <p role="status">正在排版…</p> });

function SourceViews({ view, change }: { view: SourceView; change: (view: SourceView) => void }) {
  return <div className="source-views" role="group" aria-label="笔记视图"><button type="button" aria-pressed={view === 'formatted'} onClick={() => change('formatted')}>排版</button><button type="button" aria-pressed={view === 'raw'} onClick={() => change('raw')}>原文（行号）</button></div>;
}

export function Action({ children, onClick, disabled, variant = '', className = '', title }: { children: ReactNode; onClick: () => void | Promise<unknown>; disabled?: boolean; variant?: string; className?: string; title?: string }) {
  const { busy } = useApp();
  const [working, setWorking] = useState(false);
  return <button type="button" title={title} className={`button ${variant} ${className}`} disabled={disabled || busy || working} onClick={async () => {
    setWorking(true); try { await onClick(); } catch { /* API errors are announced by the shared error region. */ } finally { setWorking(false); }
  }}>{working ? <LoaderCircle size={16} className="spin" /> : null}{children}</button>;
}
export function Go({ href, children, primary = false }: { href: string; children: ReactNode; primary?: boolean }) {
  return <Link className={`button ${primary ? 'primary' : ''}`} href={href}>{children}<ArrowRight size={16} /></Link>;
}
export function Heading({ eyebrow, title, description, children }: { eyebrow?: string; title: string; description: string; children?: ReactNode }) {
  return <div className="page-heading"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1><p className="muted">{description}</p></div>{children}</div>;
}
export function Card({ title, caption, children, className = '' }: { title?: string; caption?: string; children: ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{title && <header className="card-heading"><h2>{title}</h2>{caption && <p className="muted small">{caption}</p>}</header>}{children}</section>;
}
export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty"><span className="empty-icon"><BookOpen size={28} strokeWidth={1.4} /></span><h2>{title}</h2><p className="muted">{children}</p>{action}</div>;
}
export function Badge({ children, tone = '' }: { children: ReactNode; tone?: string }) { return <span className={`badge ${tone}`}>{children}</span>; }
export function SaveState({ status, reset }: { status: string; reset?: () => void }) {
  return <span className={`save-state ${status === 'error' ? 'danger-text' : ''}`} role="status">{status === 'saved' ? <Check size={14} /> : status === 'saving' ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}
    {{ saved: '已保存', dirty: '等待保存', saving: '正在保存', error: '未保存 · 自动保存已暂停' }[status]}
    {status === 'error' && reset && <button type="button" className="text-button" onClick={reset}>重新载入草稿</button>}
  </span>;
}
export function Assisted({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="check-label"><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />我查阅了笔记或使用了辅助 <span className="muted small">（如实记录，不影响继续学习）</span></label>;
}
export function Source({ document }: { document: Pick<PublicDocument, 'name' | 'text' | 'lineCount'> & { id?: string } }) {
  const { api } = useApp();
  const [open, setOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const maximizeButton = useRef<HTMLButtonElement>(null);
  const [selection, setSelection] = useState<{ id: string | undefined; view: SourceView } | null>(null);
  const view = document.id ? (selection?.id === document.id ? selection.view : defaultSourceView(document.name)) : 'raw';
  const changeView = (next: SourceView) => setSelection({ id: document.id, view: next });
  const [loaded, setLoaded] = useState<{ id: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const text = document.text ?? (loaded?.id === document.id ? loaded?.text : undefined);
  const reading = open || maximized;
  useEffect(() => {
    if (!reading || text !== undefined || !document.id) return;
    const controller = new AbortController();
    setError(null);
    void api<PublicDocument>(`/documents/${encodeURIComponent(document.id)}`, { signal: controller.signal }).then(source => {
      if (!controller.signal.aborted) setLoaded({ id: source.id, text: source.text ?? '' });
    }).catch(cause => {
      if (!controller.signal.aborted) setError(errorMessage(cause, '原文加载失败，请关闭并收起后重试。'));
    });
    return () => controller.abort();
  }, [api, document.id, reading, text]);
  const controls = document.id ? <SourceViews view={view} change={changeView} /> : null;
  const content = text === undefined ? <p role="status">{error ?? '正在加载原文…'}</p> : view === 'formatted' ? <SourceMarkdown text={text} /> : <SourceLines text={text} />;
  const modalContent = document.id && documentFormat(document.name) === 'markdown' && text !== undefined ? <SourceOutline text={text} view={view} /> : <div className="source-modal-content" tabIndex={0} aria-label="笔记内容">{content}</div>;
  return <><details className="source" onToggle={event => setOpen(event.currentTarget.open)}><summary><FileText size={16} /><span>{document.name}</span><button ref={maximizeButton} type="button" className="button icon-button source-maximize" aria-label={`最大化查看 ${document.name}`} title={`最大化查看 ${document.name}`} onClick={event => { event.preventDefault(); event.stopPropagation(); setMaximized(true); }} onKeyDown={event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); setMaximized(true); }
  }}><Maximize2 size={16} /></button><span className="muted small">{document.lineCount} 行 · 查看原文</span></summary>{open && <div className="source-body">{controls}<div className="source-content">{content}</div></div>}</details>{maximized && <SourceDialog name={document.name} lineCount={document.lineCount} controls={controls} opener={maximizeButton} close={() => setMaximized(false)}>{modalContent}</SourceDialog>}</>;
}
export function Sources({ ids }: { ids: string[] }) {
  const data = useData();
  if (!ids.length) return <p className="muted small">依据：本次复述。未关联补充笔记。</p>;
  return <div className="stack compact">{ids.map(id => {
    const knowledgeSource = /^knowledge:(.+):v(\d+)$/.exec(id);
    if (knowledgeSource) {
      const knowledgeId = knowledgeSource[1];
      const version = Number(knowledgeSource[2]);
      const history = data.knowledge.find(item => item.id === knowledgeId)?.contentHistory?.find(item => item.version === version);
      const frozen = data.sessions.flatMap(item => item.relatedKnowledge ?? []).find(item => item.id === knowledgeId && item.knowledgeVersion === version);
      const snapshot = history ?? frozen;
      if (snapshot) {
        const text = `${snapshot.title}\n${snapshot.description}`;
        return <Source key={id} document={{ name: `旧知识 · ${snapshot.title} · 内容版本 ${version}`, text, lineCount: text.split('\n').length }} />;
      }
      return <p key={id} className="muted small">知识来源版本未知 / 快照不可用：{id}；不以当前内容代替旧版本。</p>;
    }
    const document = data.documents.find(item => item.id === id);
    if (document) return <Source key={id} document={document} />;
    const session = data.sessions.find(item => `recitation:${item.id}` === id);
    if (session) {
      const text = recitationSourceText(session.snapshot);
      return <Source key={id} document={{ name: '原始复述 · 已提交快照', text, lineCount: text.split('\n').length }} />;
    }
    return <p key={id} className="muted small">此来源的原文暂不可用：{id}</p>;
  })}</div>;
}
export function Runs({ sessionId, reviewSessionId, all = false }: { sessionId?: string; reviewSessionId?: string; all?: boolean }) {
  const data = useData();
  const { command } = useApp();
  const runs = data.runs.filter(run => run.kind !== 'connection_test' && (all || (sessionId && run.sessionId === sessionId) || (reviewSessionId && run.reviewSessionId === reviewSessionId)) && run.status !== 'succeeded');
  if (!runs.length) return null;
  const kinds = { connection_test: '连接测试', extract: '提取知识点', followup: '准备追问', quiz: '准备测验', grade: '评价作答' };
  return <div className="stack compact" aria-live="polite">{runs.map(run => { const active = isActiveRun(run); return <div key={run.id} className={`run-state ${run.status === 'failed' ? 'failed' : ''}`}>
    <span className="run-icon">{active ? <LoaderCircle size={19} className="spin" /> : <ShieldCheck size={19} />}</span>
    <div><strong>{kinds[run.kind]} · {{ pending: '等待处理', running: '处理中', failed: '未完成', cancelled: '已取消', succeeded: '已完成' }[run.status]}</strong><p className="muted small">{run.error || (active ? '完成后自动更新，可以暂时离开。' : '原有输入与作答记录仍保留。')}</p></div>
    <Action variant="subtle" onClick={() => command(`/runs/${run.id}/${active ? 'cancel' : 'retry'}`)}>{active ? <><X size={14} />取消</> : <><RotateCcw size={14} />重试</>}</Action>
  </div>; })}</div>;
}
export function EvidenceLabel({ status, score, maxScore, simulated }: { status: string; score: number | null; maxScore: number; simulated?: boolean }) {
  return <Badge tone={status === 'graded' ? 'green' : 'amber'}>{simulated ? '演示 · ' : ''}{status === 'graded' && score !== null ? `${score} / ${maxScore} 分` : ({ pending: '待评估', needs_verification: '待核对', skipped: '已跳过' }[status] ?? '待评估')}</Badge>;
}
