'use client';

import { Feedback } from '../../components/feedback';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AiModelConfiguration, AiModelSelection } from '@sanxing/contracts';
import { useApp } from '../../components/store';
import { Badge } from '../../components/ui';
import { HttpError } from '../../lib/api-client';
import { accessError } from './use-oauth';
import styles from './ai-access.module.css';
import { useBeforeUnload, useConfirm } from '../../components/confirm';

type Draft = Omit<AiModelSelection, 'authMethod'> & { authMethod: AiModelSelection['authMethod'] | '' };
const emptyDraft = (): Draft => ({ providerId: '', modelId: '', authMethod: '', allowUnboundedOutput: false });
const sources: Record<AiModelConfiguration['source'], string> = {
  saved: '已保存 · 当前模式学习数据库（saved）', environment: '旧环境变量 MODEL_*（environment）', none: '尚未选择（none）',
};

export function ModelConfiguration({ connectionKey, onConfigurationChange }: { connectionKey: string | null; onConfigurationChange?: (configuration: AiModelConfiguration | null) => void }) {
  const { api, storageMode } = useApp();
  const [configuration, setConfiguration] = useState<AiModelConfiguration | null>(null);
  const confirm = useConfirm();
  useEffect(() => { onConfigurationChange?.(configuration); }, [configuration, onConfigurationChange]);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<'read' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const request = useRef<{ controller: AbortController; kind: 'read' | 'save' } | null>(null);
  const dirtyRef = useRef(false);
  const conflict = useRef(false);
  const edits = useRef(0);
  const revision = useRef<number | null>(null);
  const pendingConnectionRead = useRef(false);
  const previousConnectionKey = useRef<string | null>(null);

  const adopt = useCallback((next: AiModelConfiguration) => {
    setConfiguration(next);
    setDraft(next.selection ? { ...next.selection } : emptyDraft());
    revision.current = next.revision;
    dirtyRef.current = false;
    conflict.current = false;
    setDirty(false);
    setNeedsRefresh(false);
  }, []);

  const load = useCallback(async (explicit = false): Promise<void> => {
    if (request.current?.kind === 'save') { pendingConnectionRead.current = true; return; }
    request.current?.controller.abort();
    const current = { controller: new AbortController(), kind: 'read' as const };
    request.current = current;
    const startedAtEdit = edits.current;
    setBusy('read');
    if (!conflict.current) setError(null);
    setMessage(null);
    setSaved(false);
    try {
      const next = await api<AiModelConfiguration>('/ai/configuration', { signal: current.controller.signal });
      if (current.controller.signal.aborted || request.current !== current) return;
      setConfiguration(next);
      // Neither an OAuth refresh nor a late manual GET may overwrite newer edits.
      // Keep the edit's original revision until an explicit, confirmed refresh.
      if (edits.current === startedAtEdit && (explicit || (!dirtyRef.current && !conflict.current))) {
        adopt(next);
        setError(null);
      } else if (!conflict.current) {
        setMessage('已更新连接状态与模型目录；未提交的输入及其原版本已保留。');
      }
    } catch (cause) {
      if (!current.controller.signal.aborted && request.current === current) setError(accessError(cause));
    } finally {
      if (request.current === current) { request.current = null; setBusy(null); }
    }
  }, [adopt, api]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const previous = previousConnectionKey.current;
    previousConnectionKey.current = connectionKey;
    // The initial OAuth overview establishes a baseline; it is not a connection change.
    if (previous !== null && connectionKey !== null && previous !== connectionKey) void load();
  }, [load, connectionKey]);
  useEffect(() => () => {
    request.current?.controller.abort();
    request.current = null;
    pendingConnectionRead.current = false;
  }, []);
  useBeforeUnload(() => dirtyRef.current);

  const change = (next: Draft) => {
    edits.current += 1;
    dirtyRef.current = true;
    setDirty(true);
    setDraft(next);
    setMessage(null);
    setSaved(false);
  };
  const provider = configuration?.providers.find(item => item.id === draft.providerId);
  const model = provider?.models.find(item => item.id === draft.modelId);
  const usesUnboundedOutput = draft.authMethod === 'oauth' && !!provider?.requiresOAuthOutputAcknowledgement;
  const platformSelected = draft.authMethod === 'platform';
  const authAvailable = platformSelected ? provider?.platformAvailable : draft.authMethod === 'oauth' ? provider?.oauthConnected : draft.authMethod === 'api_key' ? provider?.apiKeyAvailable : false;
  const valid = !!provider && !!model && !!draft.authMethod && !!authAvailable;
  // The same model id can be listed by several providers (e.g. OpenAI and Codex) whose authorizations never interchange.
  const authorizedAlternative = draft.authMethod === 'oauth' && provider && !provider.oauthConnected && draft.modelId
    ? configuration?.providers.find(item => item.oauthConnected && item.models.some(entry => entry.id === draft.modelId)) : undefined;

  // The server may have committed: keep the input and require an explicit refresh before saving again.
  const markConflict = (text: string) => { conflict.current = true; setNeedsRefresh(true); setError(text); };
  const save = async () => {
    if (request.current || conflict.current || revision.current === null || !valid || !draft.authMethod) return;
    const current = { controller: new AbortController(), kind: 'save' as const };
    request.current = current;
    setBusy('save'); setError(null); setMessage(null); setSaved(false);
    try {
      const next = await api<AiModelConfiguration>('/ai/configuration', {
        method: 'POST', signal: current.controller.signal,
        body: { expectedRevision: revision.current, ...draft, allowUnboundedOutput: usesUnboundedOutput },
      });
      if (current.controller.signal.aborted || request.current !== current) return;
      adopt(next);
      setSaved(true);
      setMessage(next.mode === 'mock' ? '候选模型已保存；实际任务仍使用 faux，不会启用真实调用。' : '模型配置已保存，仅影响随后由你发起的新任务；未发送测试请求。');
    } catch (cause) {
      if (current.controller.signal.aborted || request.current !== current) return;
      markConflict(cause instanceof HttpError && cause.status === 409
        ? `${accessError(cause)} 输入已保留，不会自动更新版本重试。若有排队（pending）或执行中（running）的任务，请先结束或取消；然后显式刷新配置并确认。`
        // A transport failure may occur after the server committed the selection.
        : `${accessError(cause)} 输入已保留；保存结果可能尚未确认，请显式刷新配置后再操作。`);
    } finally {
      if (request.current === current) {
        request.current = null; setBusy(null);
        if (pendingConnectionRead.current) { pendingConnectionRead.current = false; void load(); }
      }
    }
  };
  const cancelRequest = () => {
    const current = request.current;
    if (!current) return;
    current.controller.abort(); request.current = null; pendingConnectionRead.current = false; setBusy(null);
    if (current.kind === 'save') markConflict('已取消等待保存结果；服务器可能已经保存，取消请求不能撤销保存。输入已保留，请显式刷新配置确认。');
    else setMessage('已取消读取配置，当前输入保留。');
  };
  const refresh = async () => {
    if ((dirtyRef.current || conflict.current) && !await confirm({ title: '刷新模型配置', message: '刷新将以服务器已保存的选择替换当前输入，并确认最新版本。未提交内容会丢失，确定刷新？', confirmLabel: '刷新', tone: 'danger' })) return;
    void load(true);
  };

  return <section className={styles.environment} aria-labelledby="ai-model-title">
    <h3 id="ai-model-title">模型选择</h3>
    <div className={styles.row}>
      {configuration && <Badge tone={configuration.mode === 'mock' ? 'amber' : 'blue'}>{configuration.mode === 'mock' ? 'MOCK · 演示模式' : 'LIVE · 真实模式'}</Badge>}
      <button type="button" className="button subtle" disabled={!!busy} onClick={refresh}>刷新模型配置</button>
    </div>
    {busy && <div className={styles.row}><p role="status" className="small muted">{busy === 'save' ? '正在保存模型配置…' : '正在读取模型配置…'}</p><button type="button" className="button subtle" onClick={cancelRequest}>取消请求</button></div>}
    {error && <Feedback title="操作提示" tone="error" className={styles.error}>{error}</Feedback>}
    {configuration && <>
      <dl className={styles.model}>
        <div><dt>保存来源</dt><dd>{configuration.source === 'saved' && storageMode === 'browser' ? '已保存 · 此账号在当前浏览器的数据库' : sources[configuration.source]}</dd></div>
        <div><dt>已保存 / 当前选择</dt><dd>{configuration.selection?.authMethod === 'platform' ? `${configuration.platform?.label ?? '平台 AI'} · 由平台提供` : configuration.selection ? `${configuration.selection.providerId} / ${configuration.selection.modelId} · ${configuration.selection.authMethod === 'oauth' ? 'OAuth' : 'API key'}` : '未选择 Provider 或模型'}</dd></div>
      </dl>
      {configuration.budget.enabled && <p className="small muted">每日预算：{configuration.budget.dailyUsd ?? '未提供'} USD · 任务预留：{configuration.budget.reservationUsd ?? '未提供'} USD</p>}
      {configuration.mode === 'live' && !configuration.ready && <Feedback title="操作提示" tone="error" className={styles.error}>API 已启动，但尚不能提交模型任务：{configuration.problem || '请先完成可用的模型配置。'} 配置完成后才能提交模型任务。</Feedback>}
      {configuration.mode === 'mock' && <p className={styles.mock}><strong>当前只保存候选模型；实际任务仍使用 faux，不会启用真实调用。</strong>{configuration.problem && ` 候选配置提示：${configuration.problem}`}</p>}
      <form className={styles.inputForm} data-unsaved={dirty ? 'true' : undefined} onSubmit={event => { event.preventDefault(); void save(); }}>
        {configuration.platform && <fieldset disabled={busy === 'save'} className={styles.sourceChoice}><legend>AI 服务来源</legend>
          <label><input type="radio" name="ai-source" checked={platformSelected} onChange={() => change({ providerId: 'platform', modelId: 'managed', authMethod: 'platform', allowUnboundedOutput: false })} />使用平台 AI <small>无需自行授权</small></label>
          <label><input type="radio" name="ai-source" checked={!platformSelected} onChange={() => change(emptyDraft())} />自行配置 <small>使用个人 Provider 授权</small></label>
        </fieldset>}
        {platformSelected ? <div className={styles.platformNotice}><strong>{configuration.platform?.label ?? '平台 AI'}</strong><p>{configuration.platform?.message}</p><span className="small muted">每账号每日最多 {configuration.platform?.perUserDailyCalls ?? '—'} 次平台调用。选择保存在当前设备，后续新任务使用平台服务。</span></div> : <>
        <fieldset className={styles.modelFields} disabled={busy === 'save'}>
          <label className="field-label" htmlFor="ai-model-provider">Provider</label>
          <select id="ai-model-provider" required value={draft.providerId} onChange={event => change({ providerId: event.target.value, modelId: '', authMethod: '', allowUnboundedOutput: false })}>
            <option value="" disabled>请选择 Provider</option>
            {draft.providerId && !provider && <option value={draft.providerId}>{draft.providerId}（已不在目录中，请重选）</option>}
            {configuration.providers.filter(item => item.id !== 'platform').map(item => <option key={item.id} value={item.id}>{item.name}{item.oauthConnected ? ' · OAuth 已授权' : ''}</option>)}
          </select>
          <label className="field-label" htmlFor="ai-model-auth">认证方式</label>
          <select id="ai-model-auth" required disabled={!provider} value={draft.authMethod} onChange={event => change({ ...draft, authMethod: event.target.value as Draft['authMethod'], allowUnboundedOutput: false })}>
            <option value="" disabled>请选择认证方式</option>
            <option value="oauth">OAuth{provider?.oauthConnected ? ' · 已连接' : ' · 尚未授权'}</option>
            <option value="api_key">API key{provider?.apiKeyAvailable ? ' · 服务端已有密钥' : ' · 服务端无可用密钥'}</option>
          </select>
          {dirty && provider && draft.authMethod === 'oauth' && !provider.oauthConnected && <Feedback title="Provider 尚未授权" tone="info" className={styles.authHint}>
            <p>{provider.name} 尚未 OAuth 授权，连接后才能保存。{authorizedAlternative
              ? `该模型同时由已授权的 ${authorizedAlternative.name} 提供，但不同 Provider 的授权不可互换。`
              : '请在同一模块的 Provider 授权区连接此 Provider。'}</p>
            {authorizedAlternative && <button type="button" className="button subtle" onClick={() => change({ ...draft, providerId: authorizedAlternative.id, allowUnboundedOutput: false })}>改用已授权的 {authorizedAlternative.name}</button>}
          </Feedback>}
          {dirty && provider && draft.authMethod === 'api_key' && !provider.apiKeyAvailable && <Feedback title="API key 尚未配置" tone="info">服务端没有可用的 API key，不能保存此认证方式；本页不收集密钥。也可选择 OAuth 并在 Provider 授权区连接。</Feedback>}
          <label className="field-label" htmlFor="ai-model-id">模型</label>
          <select id="ai-model-id" required disabled={!provider} value={draft.modelId} onChange={event => change({ ...draft, modelId: event.target.value, allowUnboundedOutput: false })}>
            <option value="" disabled>请选择模型</option>
            {draft.modelId && !model && <option value={draft.modelId}>{draft.modelId}（已不在目录中，请重选）</option>}
            {provider?.models.map(item => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}
          </select>
          {provider && !provider.models.length && <p className="small muted">此 Provider 当前没有服务端可选模型。</p>}
          <p className="small muted">Provider 与模型来自服务端实际 Pi 目录；列入目录不保证你的账号具有调用权限。API key 仅使用服务器已有密钥，不在浏览器输入。</p>
        </fieldset>
        </>}
        {needsRefresh && <p role="status" className="small muted">保存已暂停：请点击“刷新模型配置”，明确确认服务器选择与版本后重新编辑。</p>}
        <button type="submit" className="button primary" disabled={!!busy || needsRefresh || !valid}>{configuration.mode === 'mock' ? '保存候选模型' : '保存模型配置'}</button>
      </form>
    </>}
    {message && <Feedback title={saved ? '模型配置保存成功' : '模型配置提示'} tone={saved ? 'success' : 'info'} onDismiss={() => setMessage(null)}>{message}</Feedback>}
  </section>;
}
