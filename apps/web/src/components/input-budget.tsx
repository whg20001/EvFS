'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Lightbulb } from 'lucide-react';
import type { TaskInputPreview } from '@sanxing/contracts';
import { useApp, useData } from './store';
import { errorMessage } from '../lib/api-client';

/** Only numeric host preflight data crosses this boundary; never fetch source text/rubrics. */
export function useInputBudget(path: string, body: object, scope: unknown, enabled = true) {
  const { api, authenticated } = useApp();
  const data = useData();
  const serialized = JSON.stringify(body);
  const available = enabled && authenticated;
  const key = JSON.stringify([path, serialized, scope, data.revision, data.csrfToken, available]);
  const latest = useRef({ key, path, serialized, revision: data.revision, available });
  latest.current = { key, path, serialized, revision: data.revision, available };
  const epoch = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(false);
  const [result, setResult] = useState<{ key: string; preview: TaskInputPreview | null; error: string | null }>({ key: '', preview: null, error: null });

  const request = useCallback(async (): Promise<TaskInputPreview | null> => {
    if (timer.current) clearTimeout(timer.current);
    controller.current?.abort();
    const current = latest.current;
    const ticket = ++epoch.current;
    if (!mounted.current || !current.available) return null;
    const abort = new AbortController();
    controller.current = abort;
    setResult({ key: current.key, preview: null, error: null });
    const isCurrent = () => mounted.current && !abort.signal.aborted && ticket === epoch.current && current.key === latest.current.key;
    try {
      const preview = await api<TaskInputPreview>(current.path, { method: 'POST', body: JSON.parse(current.serialized), signal: abort.signal });
      if (!isCurrent()) return null;
      if (preview.revision < current.revision) throw new Error('服务端预检版本已过期，请重试。');
      setResult({ key: current.key, preview, error: null });
      return preview;
    } catch (cause) {
      if (isCurrent()) setResult({ key: current.key, preview: null, error: errorMessage(cause, '连接失败') });
      return null;
    }
  }, [api]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; ++epoch.current; controller.current?.abort(); if (timer.current) clearTimeout(timer.current); };
  }, []);
  useEffect(() => {
    ++epoch.current;
    controller.current?.abort();
    if (available) timer.current = setTimeout(() => { void request(); }, 250);
    return () => { if (timer.current) clearTimeout(timer.current); controller.current?.abort(); };
  }, [key, available, request]);

  // A draft save can commit its new revision while preflight is starting. Retry
  // that invalidated request, but NEVER silently switch to newly edited input.
  const refresh = useCallback(async () => {
    const input = latest.current.serialized;
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = latest.current.key;
      const preview = await request();
      if (latest.current.serialized !== input || !mounted.current) return null;
      if (preview || latest.current.key === before) return preview;
    }
    return null;
  }, [request]);
  // Synchronous key comparison hides stale balances before effects run.
  const current = available && result.key === key ? result : null;
  const preview = current?.preview ?? null;
  return { preview, error: current?.error ?? null, pending: available && !preview && !current?.error, canSubmit: Boolean(preview?.canSubmit), refresh };
}

export type InputBudgetState = ReturnType<typeof useInputBudget>;
const number = (value: number | null) => value === null ? '未知' : value.toLocaleString('zh-CN');

export function InputBudget({ budget }: { budget: InputBudgetState }) {
  const { storageMode } = useApp();
  const { mode } = useData();
  const preview = budget.preview;
  return <div className="notice" role="note" aria-label="AI 输入预算"><Lightbulb size={18} /><div><strong>AI 输入预算 · {storageMode === 'browser' ? '本地' : '服务端'}完整预检</strong>
    {!preview ? <><p className="small">{budget.pending ? '正在预检，当前预算未知；请稍候再正式提交。' : `当前预算未知，不能正式提交。${budget.error ?? '请重新预检。'}`}</p>{!budget.pending && <button type="button" className="text-button" onClick={() => { void budget.refresh(); }}>重试预算预检</button>}</> : <>
      <p className="small">{preview.kind === 'extract' ? `包含 ${preview.documentCount} 份资料${preview.retrieval?.mode === 'excerpt' ? '的本地检索片段' : '原文'}及元数据` : storageMode === 'browser' ? '包含当前题目及评分规则' : '包含当前题目及服务端私有评分规则（不返回答案）'}：实际 JSON 已用 {number(preview.sentChars)} / {number(preview.maxChars)} 字符；节选前 {number(preview.originalChars)}。字符按 UTF-16 计数（含 JSON 转义），不是 token。</p>
      {mode === 'live' ? <><p className="small">模型 {preview.model ? `${preview.model.providerId} / ${preview.model.modelId}` : '未知'} · 完整输入保守估算 {number(preview.estimatedInputTokens)} tokens · 上下文窗口 {number(preview.contextWindow)} · 输出预留 {number(preview.outputReserveTokens)} · 安全余量 {number(preview.safetyMarginTokens)} · 剩余输入预算 {number(preview.remainingInputTokens)} tokens。</p><p className="small">按 UTF-8 字节保守估算，包含系统提示，不是精确分词，也不是费用承诺。OpenAI/Codex OAuth 不保证上游输出硬上限；输出预留只是规划，不保证实际输出或费用，也不保证上游接受。</p></> : <p className="small">Mock 为脚本演示，不承诺真实模型 token 预算或费用。</p>}
      {preview.retrieval && <p className="small">{preview.retrieval.mode === 'full' ? `全文发送：${preview.retrieval.sourceCount} 个来源共 ${number(preview.retrieval.originalChars)} 字符均在预算内，未做检索节选。` : `检索节选 ${number(preview.retrieval.selectedChars)} / ${number(preview.retrieval.originalChars)} 字符：${preview.retrieval.sourceCount} 个来源超出预算，按本地关键词命中选段，不代表模型阅读了全文。`}</p>}
      <p className="small">{preview.truncated ? '本次会节选发送：超预算时使用分布 / 相关选段，不是摘要，也不是全文评估。' : preview.canSubmit ? preview.retrieval?.mode === 'excerpt' ? '检索节选已按预算选入，不再做预算截断。' : '预算足够，本次全文发送，不节选。' : '当前无法形成可提交的完整输入。'}完整资料和草稿仍会保留；截断字符数不代表遗漏知识的比例或准确率。</p>
      {preview.fields.filter(field => field.truncated).map(field => <p className="small" key={field.path}>{field.label}：原文 {number(field.originalChars)} 字符 → 发送片段 {number(field.sentChars)} 字符（含节选标记）</p>)}
      {!preview.canSubmit && <p className="small danger-text">不能正式提交：{preview.reason ?? '当前输入预算不足'}。仍可保存草稿、调整资料或跳过题目。</p>}
    </>}
    <p className="small">预检不调用模型、不验证账号连通；正式提交和执行时仍会重新校验。</p>
  </div></div>;
}
