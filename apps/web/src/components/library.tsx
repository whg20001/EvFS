'use client';

import { useEffect, useRef, useState } from 'react';
import type { LibrarySearchResult } from '@sanxing/contracts';
import { useApp, useData } from './store';
import { Action, Badge, Card, Go, Heading, Sources } from './ui';
import { errorMessage } from '../lib/api-client';

/** Searching is read-only. Selection is always explicit and owned by the caller. */
export function LibrarySearch({ kind, defaultQuery = '', searchLabel = '搜索本地资料', selectedIds, onSelection, maxSelected = 3, excludedIds = [], disabled = false }: {
  kind?: 'document' | 'knowledge'; defaultQuery?: string; searchLabel?: string;
  selectedIds?: string[]; onSelection?: (ids: string[]) => void; maxSelected?: number; excludedIds?: string[]; disabled?: boolean;
}) {
  const { api } = useApp();
  const data = useData();
  const [editedQuery, setQuery] = useState<string | null>(null);
  const query = editedQuery ?? defaultQuery.slice(0, 2000);
  const [result, setResult] = useState<LibrarySearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const ticket = useRef(0);
  useEffect(() => () => { ++ticket.current; controller.current?.abort(); }, []);
  async function search() {
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    const current = ++ticket.current;
    setSearching(true); setError(null); setResult(null);
    try {
      const next = await api<LibrarySearchResult>('/library/search', { method: 'POST', body: { query: query.trim(), ...(kind ? { kind } : {}) }, signal: abort.signal });
      if (current === ticket.current) setResult(next);
    } catch (cause) { if (!abort.signal.aborted) setError(errorMessage(cause, '本地检索失败，请重试。')); }
    finally { if (current === ticket.current) setSearching(false); }
  }
  return <div className="stack compact">
    <p className="small muted">本地 BM25 关键词检索，不请求模型或 embedding。结果默认不选，不会自动把旧内容发给 AI。</p>
    <label className="field-label">检索关键词<input value={query} maxLength={2000} onChange={event => {
      setQuery(event.target.value); ++ticket.current; controller.current?.abort(); setSearching(false); setResult(null);
    }} placeholder="输入名称或描述中的关键词…" /></label>
    <Action disabled={disabled || searching || !query.trim()} onClick={search}>{searchLabel}</Action>
    {error && <p role="alert" className="danger-text">{error}</p>}
    {searching && <p role="status">正在本地检索…</p>}
    {selectedIds && onSelection && <div className="stack compact" aria-label="已选择的检索结果"><p className="small muted">已选择 {selectedIds.length} / {maxSelected} 项</p>{selectedIds.map(id => <label className="check-label" key={id}><input type="checkbox" checked disabled={disabled} onChange={() => onSelection(selectedIds.filter(value => value !== id))} />已选：{data.knowledge.find(point => point.id === id)?.title ?? data.documents.find(document => document.id === id)?.name ?? id}</label>)}</div>}
    {result && <><p className="small muted" role="status">“{result.query}” · {result.hits.length} 个结果 · {result.strategy}</p>{!result.hits.length && <p className="muted">没有匹配结果，试试描述中的其他关键词。</p>}{result.hits.map(hit => {
      const checked = selectedIds?.includes(hit.id) ?? false;
      const excluded = excludedIds.includes(hit.id);
      return <div className="candidate" key={`${hit.kind}:${hit.id}:${hit.startLine}`}>
        <div className="row wrap"><h3>{hit.title}</h3><Badge>{hit.kind === 'document' ? '历史资料' : '旧知识'}</Badge>{hit.contentVersion !== null && <Badge>内容版本 {hit.contentVersion}</Badge>}</div>
        <p className="prose">{hit.excerpt}</p><p className="small muted">来源：{hit.id} · 第 {hit.startLine}–{hit.endLine} 行 · 相关度 {hit.score.toFixed(2)}</p>
        {onSelection && selectedIds && <label className="check-label"><input type="checkbox" aria-label={`选择 ${hit.title}`} checked={checked} disabled={disabled || excluded || (!checked && selectedIds.length >= maxSelected)} onChange={event => onSelection(event.target.checked ? [...selectedIds, hit.id] : selectedIds.filter(id => id !== hit.id))} />{excluded ? '当前草稿已附加' : '选择此结果'}</label>}
        {hit.kind === 'document' ? <Sources ids={[hit.id]} /> : <><Go href={`/knowledge/${encodeURIComponent(hit.id)}`}>查看知识详情</Go>{hit.contentVersion !== null && <Sources ids={[`knowledge:${hit.id}:v${hit.contentVersion}`]} />}</>}
      </div>;
    })}</>}
  </div>;
}

export function LibraryPage() {
  const [kind, setKind] = useState<'' | 'document' | 'knowledge'>('');
  return <><Heading eyebrow="FIND, THEN CONNECT" title="本地资料库" description="找回已有资料与旧知识。检索不会创建草稿、关联知识或调用 AI。" /><Card title="搜索已有资料与旧知识"><label className="field-label">检索范围<select value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="">全部</option><option value="document">历史资料</option><option value="knowledge">旧知识</option></select></label><LibrarySearch key={kind} kind={kind || undefined} /><p className="small muted">要引用资料，请在今日复述的“搜索历史资料并附加”中明确选择；要比较旧知识，请在确认学习范围时选择。</p></Card></>;
}
