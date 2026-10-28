'use client';

import { Feedback } from '../../components/feedback';
import type { AiConnectionTestView, AiModelConfiguration, AiProviderView, Mode } from '@sanxing/contracts';
import type { ApiClient } from '../../lib/api-client';
import { testInProgress, useConnectionTest } from './use-connection-test';
import { isWaiting } from './use-oauth';
import styles from './ai-access.module.css';
import { useConfirm } from '../../components/confirm';

const labels: Record<AiConnectionTestView['status'], string> = {
  pending: '测试排队中', running: '正在测试', succeeded: '本次连接测试成功', failed: '本次连接测试失败', cancelled: '本次测试已取消',
};

export function ConnectionTest({ api, provider, mode, configuration, onComplete }: {
  api: ApiClient; provider: AiProviderView; mode: Mode; configuration: AiModelConfiguration | null; onComplete: () => void;
}) {
  const actions = useConnectionTest(api, provider.id, onComplete);
  const confirm = useConfirm();
  const selection = configuration?.selection;
  const reason = mode === 'mock' || configuration?.mode === 'mock'
    ? 'MOCK 模式不能进行真实连接测试；faux 演示不代表厂商连通。'
    : isWaiting(provider.session) ? '请先完成或取消当前重新授权流程。'
    : !configuration ? '请先读取模型配置。'
      : !selection || selection.authMethod !== 'oauth' || selection.providerId !== provider.id
        ? '请先在模型选择中保存此 Provider 的 OAuth 模型。'
        : !configuration.ready ? `当前配置尚不能测试：${configuration.problem || '请核对模型与授权。'}` : null;
  const test = actions.test;
  const active = testInProgress(test);
  const disabled = !!reason || actions.busy || actions.loading || !!actions.readError || active;
  const sameModel = test && selection?.providerId === test.providerId && selection.modelId === test.modelId && selection.authMethod === 'oauth' && configuration?.mode === test.mode;
  const start = async () => {
    if (disabled || !selection) return;
    const message = `模型：${provider.name}（${provider.id}） / ${selection.modelId}\n使用服务器当前已保存的模型，不使用未保存的编辑。\n将发送固定的最小请求，不携带任何学习笔记或学习资料；可能产生费用或消耗订阅额度。\n${configuration?.providers.find(item => item.id === provider.id)?.requiresOAuthOutputAcknowledgement ? '此厂商 OAuth 没有上游输出 token 硬上限。\n' : ''}测试不会自动重试，成功仅代表本次请求。`;
    if (await confirm({ title: `测试 ${provider.name} 连接`, message, confirmLabel: '开始测试' })) void actions.start({ ...selection });
  };
  return <div className={styles.test}>
    <div className={styles.actions}>
      <button type="button" className="button primary" aria-label={`测试 ${provider.name} 连接`} aria-describedby={`test-hint-${provider.id}`} disabled={disabled} onClick={start}>测试连接</button>
      {active && <button type="button" className="button" aria-label={`取消 ${provider.name} 本次连接测试`} disabled={actions.busy} onClick={() => { void actions.cancel(); }}>取消测试</button>}
      {(actions.readError || actions.actionError) && <button type="button" className="button subtle" disabled={actions.busy || actions.loading} onClick={actions.refresh}>刷新测试状态</button>}
    </div>
    <p id={`test-hint-${provider.id}`} className="small muted">{reason || `测试已保存模型：${selection!.modelId}；不会测试未保存的编辑。`}</p>
    {(actions.loading || actions.busy) && <p role="status" className="small muted">{actions.busy ? '正在提交测试操作…' : '正在读取最近测试…'}</p>}
    {actions.readError && <Feedback title="操作提示" tone="error" className={styles.error}>{actions.readError} 状态读取已暂停，未重新发送测试。</Feedback>}
    {actions.actionError && <Feedback title="操作提示" tone="error" className={styles.error}>{actions.actionError}</Feedback>}
    {test && <div className={styles.testResult} role="status" aria-live="polite">
      <strong>{test.mode === 'mock' ? 'MOCK · 演示记录，不代表真实连通' : labels[test.status]}</strong>
      <p className="small muted">{test.mode.toUpperCase()} · {test.providerId} / {test.modelId} · {new Date(test.createdAt).toLocaleString('zh-CN', { hour12: false })}</p>
      {!sameModel && <p className="small muted">这是其他模型选择或模式的历史测试，不代表当前选择已通过。</p>}
      {test.error && <p className={styles.error}>{test.error}</p>}
      <p className="small muted">耗时：{test.durationMs === null ? '未知 / 尚未完成' : `${test.durationMs.toLocaleString('zh-CN')} ms`} · {test.usage
        ? `已知 token：输入 ${test.usage.inputTokens.toLocaleString('zh-CN')}（含缓存），输出 ${test.usage.outputTokens.toLocaleString('zh-CN')}`
        : 'token 用量未知，不代表 0 消耗'}</p>
      <p className="small muted">{active ? '取消仅请求停止任务；离开页面或登出只停止等待和轮询，不能撤销已发送的厂商请求。' : '结果仅对应此模型与此时间的一次请求，不保证账号持续可用。'}</p>
    </div>}
  </div>;
}
