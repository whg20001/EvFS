'use client';

import { Feedback } from '../../components/feedback';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, KeyRound, Unplug } from 'lucide-react';
import type { AiModelConfiguration, AiProviderView, OAuthSessionView } from '@sanxing/contracts';
import { useApp } from '../../components/store';
import { Badge, Card, Heading } from '../../components/ui';
import { TokenHeatmap } from './token-heatmap';
import { ModelConfiguration } from './model-configuration';
import { Skills } from './skills';
import { ConnectionTest } from './connection-test';
import { isWaiting, useOAuth } from './use-oauth';
import styles from './ai-access.module.css';
import { useConfirm } from '../../components/confirm';

type OAuthActions = ReturnType<typeof useOAuth>;
const statuses: Record<OAuthSessionView['status'], string> = {
  starting: '正在准备授权', waiting: '等待完成授权', working: '正在验证授权',
  succeeded: '授权成功', failed: '授权失败', cancelled: '授权已取消', expired: '授权会话已到期',
};
function timestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间不可用' : date.toLocaleString('zh-CN', { hour12: false });
}
function safeExternalUrl(value: string | null): string | null {
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
}

function SessionInput({ session, disabled, submit }: { session: OAuthSessionView; disabled: boolean; submit: (promptId: string, value: string) => Promise<boolean> }) {
  // Prompt-keyed forms keep secrets/codes/URLs in memory only, never draft storage.
  const [value, setValue] = useState('');
  const input = session.input;
  if (!input) return null;
  const fieldId = `oauth-input-${session.id}-${input.id}`;
  const options = input.options ?? [];
  const selectedOption = options.find(option => option.id === value);
  const valid = (!value && input.allowEmpty) || (input.type === 'select' ? !!selectedOption : !!value.trim());
  return <form className={styles.inputForm} autoComplete="off" onSubmit={async event => {
    event.preventDefault();
    if (disabled || !valid) return;
    if (await submit(input.id, value)) setValue('');
  }}>
    <label className="field-label" htmlFor={fieldId}>{input.label}</label>
    {input.type === 'select' ? <>
      <select id={fieldId} value={value} disabled={disabled} required={!input.allowEmpty}
        aria-describedby={selectedOption?.description ? `${fieldId}-description` : undefined} onChange={event => setValue(event.target.value)}>
        <option value="" disabled={!input.allowEmpty}>{input.placeholder || '请选择授权方式'}</option>
        {options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
      {selectedOption?.description && <p id={`${fieldId}-description`} className="small muted">{selectedOption.description}</p>}
      {!options.length && <p role="status" className="small muted">服务端暂未提供可选项，请刷新授权状态。</p>}
    </> : <input id={fieldId} type={input.type === 'secret' ? 'password' : 'text'} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
      placeholder={input.placeholder} value={value} disabled={disabled} required={!input.allowEmpty} onChange={event => setValue(event.target.value)} />}
    {input.type === 'manual_code' && <p className="small muted">按厂商指引粘贴授权码或完整最终回调 URL，不要删改参数。</p>}
    <p className="small muted">输入仅保留在页面内存中，提交成功、切换步骤或关闭流程后清空。{input.allowEmpty ? '此步骤允许留空提交。' : ''}</p>
    <button type="submit" className="button primary" disabled={disabled || !valid}>提交授权信息</button>
  </form>;
}

function AuthorizationFlow({ provider, actions, onComplete }: { provider: AiProviderView; actions: OAuthActions; onComplete: () => void }) {
  const session = provider.session;
  const waiting = isWaiting(session);
  const wasActive = useRef(waiting);
  useEffect(() => {
    if (waiting) wasActive.current = true;
    if (wasActive.current && session?.status === 'succeeded' && provider.connected) onComplete();
  }, [waiting, session?.status, provider.connected, onComplete]);
  const expired = !!session && (session.status === 'expired' || (waiting && Date.parse(session.expiresAt) <= Date.now()));
  const url = safeExternalUrl(session?.url ?? null);
  const disabled = !!actions.busy;
  return <div className={styles.flow}>
    <h3>{provider.name} · {provider.connected ? '重新授权' : '添加授权'}</h3>
    <p className="small muted">授权仅保存凭据，不切换模式或模型；不保证免费或可调用。重新授权前请停止在途或排队的真实任务。</p>
    {provider.notice && <p className={styles.instructions}>{provider.notice}</p>}
    <details className={styles.help}>
      <summary>安全与浏览器 / WSL 提示</summary>
      <p className="small muted">HTTP 无 HTTPS 传输保护，仅在可信本机或网络中提交信息；公网必须使用 HTTPS。OAuth 不绕过厂商权限、会员或额度限制；各厂商的回调方式与输出上限见上方说明。</p>
      <p className="small muted">网页 3010 端口可访问不代表回调端口可访问。在 WSL 中优先选择不需要本地回调的 copy_code / device_code；仅使用服务端实际提供的方式。</p>
    </details>
    {!waiting && <button type="button" className="button primary" disabled={disabled || !provider.oauthAvailable}
      onClick={() => { void actions.perform(provider.id, `/ai/oauth/${encodeURIComponent(provider.id)}/start`); }}><KeyRound size={15} />{provider.connected ? '开始重新授权' : '开始授权'}</button>}
    {!provider.oauthAvailable && <p className="small muted">此 Provider 当前不支持发起 OAuth 授权。</p>}
    {actions.busy === provider.id && <p role="status" className="small muted">正在提交授权操作…</p>}
    {actions.actionError?.providerId === provider.id && <Feedback title="操作提示" tone="error" className={styles.error}>{actions.actionError.message} 请核对状态后重试。</Feedback>}
    {session && session.status !== 'succeeded' && <div className={styles.session}>
      {waiting && !expired ? <p role="status"><strong>{statuses[session.status]}</strong></p> : <Feedback title={expired ? '授权会话已到期' : statuses[session.status]} tone={session.status === 'failed' ? 'error' : 'info'}>{session.error || (expired ? '请取消本次流程后重新授权。' : statuses[session.status])}</Feedback>}
      {waiting && !expired && <>
        <p className="small muted">会话到期：{timestamp(session.expiresAt)}（本地时间）</p>
        {session.instructions && <p className={styles.instructions}>{session.instructions}</p>}
        {url && <a className="button" href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"><ExternalLink size={15} />打开厂商授权页（新窗口）</a>}
        {session.url && !url && <Feedback title="操作提示" tone="error" className={styles.error}>授权链接格式无效，请取消后重试。</Feedback>}
        {session.input && <SessionInput key={`${session.id}:${session.input.id}`} session={session} disabled={disabled}
          submit={(promptId, value) => actions.perform(provider.id, `/ai/oauth/sessions/${encodeURIComponent(session.id)}/input`, { promptId, value })} />}
      </>}
      {waiting && <button type="button" className="button" disabled={disabled} onClick={() => {
        void actions.perform(provider.id, `/ai/oauth/sessions/${encodeURIComponent(session.id)}/cancel`);
      }}>取消本次授权</button>}
    </div>}
    {waiting && <p className="small muted">本页自动刷新状态；收起流程不取消授权，可再次打开继续。离开页面停止刷新。</p>}
  </div>;
}

function AuthenticatedAccess() {
  const { api } = useApp();
  const confirm = useConfirm();
  const actions = useOAuth(api);
  const overview = actions.overview;
  const [configuration, setConfiguration] = useState<AiModelConfiguration | null>(null);
  const [notice, setNotice] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const onTestComplete = useCallback(() => { setRefreshKey(value => value + 1); actions.retry(); }, [actions.retry]);
  const [adding, setAdding] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const selected = overview?.providers.find(provider => provider.id === selectedId);
  const disconnected = overview?.providers.filter(provider => !provider.connected) ?? [];
  const continuing = disconnected.filter(provider => isWaiting(provider.session));
  // Only credential changes invalidate model configuration, never ordinary session polling.
  const connectionKey = overview ? JSON.stringify(overview.providers.map(provider => [provider.id, provider.connected, provider.expiresAt]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))) + `:test-${refreshKey}` : null;
  const closeFlow = useCallback(() => { setAdding(false); setSelectedId(''); }, []);
  return <div className={styles.page}>
    <Heading eyebrow="AI CONFIGURATION" title="AI 配置" description="自行选择模型，明确授权，按需调用。" />
    <Card title="模型与授权" caption="在这里选择模型、连接 Provider，并保存本次配置。" className={styles.modelAccess}>
    <div className={styles.modelAccessGrid}>
    <ModelConfiguration connectionKey={connectionKey} onConfigurationChange={setConfiguration} />
    <section className={styles.providers} aria-labelledby="ai-providers-title">
      <div className={styles.sectionHeading}>
        <div><h3 id="ai-providers-title">Provider 授权</h3><p>{overview ? `${overview.providers.filter(provider => provider.connected).length} 个已连接账号 · ` : ''}管理账号连接与授权状态</p></div>
        <button type="button" className="button subtle" disabled={!!actions.busy || actions.loading} onClick={actions.retry}>刷新授权状态</button>
      </div>
      {actions.error && <Feedback title="操作提示" tone="error" className={styles.failure}><p>{actions.error}{overview ? ' 下方保留上次读取的状态。' : ''}</p>
        <button type="button" className="button" disabled={!!actions.busy || actions.loading} onClick={actions.retry}>重试读取授权状态</button></Feedback>}
      {actions.loading && !overview && <p role="status" className="muted">正在读取授权状态…</p>}
      {overview && <>
        <div className={styles.providerList}>
        {overview.providers.filter(provider => provider.connected).map(provider => {
          const tokenExpired = !!provider.expiresAt && Date.parse(provider.expiresAt) <= Date.now();
          return <Card key={provider.id} className={styles.provider}>
            <div className={styles.row}><div className={styles.providerTitle}><KeyRound size={19} /><h3>{provider.name}</h3></div>
              <Badge tone={tokenExpired ? 'amber' : 'green'}>{tokenExpired ? '已连接 · 令牌已到期' : '已连接'}</Badge></div>
            <p className="small muted">{provider.expiresAt ? `令牌到期：${timestamp(provider.expiresAt)}` : '未提供到期时间，不代表永久有效。'}</p>
            <ConnectionTest api={api} provider={provider} mode={overview.mode} configuration={configuration} onComplete={onTestComplete} />
            <div className={styles.actions}>
              <button type="button" className="button" aria-label={`${isWaiting(provider.session) ? '继续' : '重新'}授权 ${provider.name}`} disabled={!!actions.busy}
                onClick={() => { setAdding(false); setSelectedId(provider.id); }}>{isWaiting(provider.session) ? '继续授权' : '重新授权'}</button>
              <button type="button" className="button" aria-label={`断开 ${provider.name} 连接`} disabled={!!actions.busy || isWaiting(provider.session)} onClick={async () => {
                if (await confirm({ title: `断开 ${provider.name}`, message: '仅移除本应用保存的凭据，不代表在厂商处撤销授权，也不能保证已开始的请求停止。如需撤销，请前往厂商账号设置。', confirmLabel: '断开连接', tone: 'danger' })) {
                  if (await actions.perform(provider.id, `/ai/providers/${encodeURIComponent(provider.id)}/disconnect`)) setNotice(`${provider.name} 已断开连接。`);
                }
              }}><Unplug size={15} />断开连接</button>
            </div>
            {actions.actionError?.providerId === provider.id && selectedId !== provider.id && <Feedback title="操作提示" tone="error" className={styles.error}>{actions.actionError.message}</Feedback>}
          </Card>;
        })}
        </div>
        {!overview.providers.some(provider => provider.connected) && <p className="small muted">尚无已连接的 Provider，可展开“添加授权”。</p>}
        <div className={styles.authorization}>
          <button type="button" className="button" aria-expanded={adding} aria-controls="ai-add-authorization" onClick={() => {
            if (adding) closeFlow(); else { setAdding(true); setSelectedId(''); }
          }}>添加授权{continuing.length ? ` · ${continuing.length} 项进行中` : ''}</button>
          {adding && <div id="ai-add-authorization" className={styles.inputForm}>
            <label className="field-label" htmlFor="ai-oauth-provider">选择要授权的 Provider</label>
            <select id="ai-oauth-provider" value={selectedId} onChange={event => setSelectedId(event.target.value)}>
              <option value="">请选择 Provider</option>
              {disconnected.map(provider => <option key={provider.id} value={provider.id}>{provider.name}{isWaiting(provider.session) ? ' · 继续授权' : ''}</option>)}
              {selected?.connected && <option value={selected.id}>{selected.name} · 已连接</option>}
            </select>
            {!disconnected.length && <p className="small muted">当前没有未连接的 Provider。</p>}
          </div>}
          {selected && <>
            <AuthorizationFlow key={selected.id} provider={selected} actions={actions} onComplete={() => { setNotice(`${selected.name} 授权成功。`); closeFlow(); }} />
            <button type="button" className="button subtle" onClick={closeFlow}>收起授权流程</button>
          </>}
        </div>
      </>}
    </section>
    </div>
    </Card>
    <Skills />
    {notice && <Feedback title="授权状态已更新" tone="success" onDismiss={() => setNotice('')}>{notice}</Feedback>}
    {overview && <TokenHeatmap api={api} mode={overview.mode} refreshKey={refreshKey} />}
  </div>;
}

export function AiAccessPage() {
  const { authenticated } = useApp();
  return authenticated ? <AuthenticatedAccess /> : <p role="status">本站密码会话已失效，请重新登录。授权输入已清空，测试及授权状态刷新已停止；已发送的请求不会因此撤销。</p>;
}
