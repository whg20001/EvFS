'use client';

import { Feedback } from './feedback';
import { useEffect, useState } from 'react';
import { CODE_LANGUAGES, DEFAULT_CODE_LANGUAGES, isActiveRun, type LearningPreferences as Preferences, type LearningPreferencesView } from '@sanxing/contracts';
import { useApp, useData } from './store';
import { languageLabels } from './code-exercise';
import { Action, Badge } from './ui';
import { useBeforeUnload, useConfirm } from './confirm';
import { errorMessage } from '../lib/api-client';

function normalize(value: Required<Preferences>): Required<Preferences> {
  return { schedulingEnabled: value.schedulingEnabled, promptCacheRetention: value.promptCacheRetention, associationEnabled: value.associationEnabled,
    reviewOrder: value.reviewOrder ?? 'due', reviewBatchSize: value.reviewBatchSize ?? null,
    codeExercisesEnabled: value.codeExercisesEnabled, codeLanguages: CODE_LANGUAGES.filter(language => value.codeLanguages.includes(language)) };
}

export function LearningPreferences() {
  const { api, command } = useApp();
  const data = useData();
  const confirm = useConfirm();
  const [saved, setSaved] = useState<LearningPreferencesView | null>(null);
  const [form, setForm] = useState(() => normalize({ schedulingEnabled: false, promptCacheRetention: 'none', associationEnabled: false, codeExercisesEnabled: false, codeLanguages: [...DEFAULT_CODE_LANGUAGES], reviewOrder: 'due', reviewBatchSize: null }));
  const { schedulingEnabled, promptCacheRetention: retention, associationEnabled, codeExercisesEnabled, codeLanguages } = form;
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fetchKey, setFetchKey] = useState(0);
  const active = data.runs.some(isActiveRun);
  const dirty = !!saved && JSON.stringify(normalize(form)) !== JSON.stringify(normalize(saved));
  const locked = !saved || loading || saving || active;
  useBeforeUnload(() => dirty);
  const adopt = (next: LearningPreferencesView) => { setSaved(next); setForm(normalize(next)); };
  const update = (patch: Partial<Preferences>) => { setForm(current => normalize({ ...current, ...patch })); setMessage(''); };
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    void api<LearningPreferencesView>('/learning/preferences', { signal: controller.signal }).then(next => {
      if (!controller.signal.aborted) adopt(next);
    }).catch(cause => { if (!controller.signal.aborted) setError(errorMessage(cause, '读取设置失败。')); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, fetchKey]);
  return <details className="card" id="learning-preferences"><summary>学习、复习与缓存设置</summary><div className="stack" data-unsaved={dirty}>
    <p className="small muted">仅保存应用设置，不自动选择模型、切换 live 或请求厂商。启用排期不会自动为历史知识补卡；请在知识详情逐项确认加入复习。</p>
    <p className="small muted">真实模式下，后续复习出题与评分可能请求厂商并产生费用。短缓存不是免费额度，不保证命中；选择 none 也不能承诺厂商完全不缓存，请核对厂商政策。</p>
    {saved && <p className="small muted"><Badge>{saved.source === 'saved' ? '已保存的应用设置' : '继承环境设置'}</Badge> · 设置版本 {saved.revision}</p>}
    {loading && <p role="status">正在读取设置…</p>}
    {error && <Feedback title="操作提示" tone="error" className="danger-text">{error} 本地选择仍保留，不会自动覆盖。</Feedback>}
    {message && <Feedback onDismiss={() => setMessage('')} title="操作提示" tone="success">{message}</Feedback>}
    <label className="check-label"><input type="checkbox" checked={schedulingEnabled} disabled={locked} onChange={event => { update({ schedulingEnabled: event.target.checked }); }} />启用复习排期</label>
    <label className="field-label">连续复习顺序<select disabled={locked} value={form.reviewOrder} onChange={event => update({ reviewOrder: event.target.value as 'due' | 'weakness' })}><option value="due">到期时间优先</option><option value="weakness">近期失分优先</option></select></label>
    <label className="field-label">每轮最多复习卡数<input type="number" min={1} max={100} disabled={locked} placeholder="不限制" value={form.reviewBatchSize ?? ''} onChange={event => update({ reviewBatchSize: event.target.value === '' ? null : Number(event.target.value) })} /></label>
    <p className="small muted">仅调整已到期卡的队列顺序和每轮数量，不改变到期时间。近期失分优先使用近 30 天最近 3—5 次同类独立作答，优先延迟证据；证据不足时按到期时间。辅助、人工自评和有争议的记录不参与。不会自动训练排期参数。</p>
    <label className="field-label">厂商提示缓存<select value={retention} disabled={locked} onChange={event => { update({ promptCacheRetention: event.target.value as 'none' | 'short' }); }}><option value="none">none · 不请求提示缓存</option><option value="short">short · 允许厂商短缓存</option></select></label>
    <label className="check-label"><input type="checkbox" checked={associationEnabled} disabled={locked} onChange={event => { update({ associationEnabled: event.target.checked }); }} />旧知识联想</label>
    <p className="small muted">开启后，确认学习范围时会在本地按关键词自动找出最多 3 个相关的已确认旧知识点，供追问和出题结合；复习出题时同样会结合相关旧知识。不提前展示，结合题只计入当前知识点的证据与排期，不会推进旧知识点的排期。旧知识点的标题与描述会随请求发给 AI。默认关闭。</p>
    <label className="check-label"><input type="checkbox" checked={codeExercisesEnabled} disabled={locked} onChange={event => { update({ codeExercisesEnabled: event.target.checked }); }} />代码题</label>
    <fieldset className="code-languages" disabled={locked}><legend>代码题语言（至少一种）</legend><div className="row wrap">{CODE_LANGUAGES.map(language => <label className="check-label" key={language}><input type="checkbox" checked={codeLanguages.includes(language)} disabled={codeLanguages.length === 1 && codeLanguages.includes(language)} onChange={event => { update({ codeLanguages: CODE_LANGUAGES.filter(item => item === language ? event.target.checked : codeLanguages.includes(item)) }); }} />{languageLabels[language]}</label>)}</div></fieldset>
    <p className="small muted">默认关闭。开启后由 AI 判断知识点是否适合代码题，与单选、简答混合；代码在浏览器内运行。Python 科学计算包需先按 README 安装。</p>
    <p className="small muted">缓存说明：Anthropic 仅在同一学习会话的追问与出题之间复用资料段时标记缓存（写入约 1.25 倍计费，命中约 0.1 倍；过短内容不会被缓存）；OpenAI API 由厂商自动前缀缓存，short 仅额外提供路由亲和标识；Codex 与 xAI（Grok，含 SuperGrok/X Premium 订阅授权）同样由上游自动前缀缓存，short 提供亲和标识（prompt_cache_key），xAI 命中部分按约 0.25 倍计费；上游报告的缓存读取会照实记录，但订阅额度下节省无法换算成金额，也不保证命中。</p>
    <p className="small muted">关闭排期后仍可完成已交卷复习、保留证据，但不会推进排期。尚未保存时继承环境配置（live 默认排期关闭、缓存 none）；环境变量可作为后备配置。</p>
    {active && <p role="note" className="small danger-text">有等待或运行中的任务，暂不能修改设置。请等待完成或取消任务；服务端仍会核对冲突。</p>}
    <div className="row wrap"><Action variant="primary" disabled={locked || !dirty || (form.reviewBatchSize !== null && (!Number.isInteger(form.reviewBatchSize) || form.reviewBatchSize < 1 || form.reviewBatchSize > 100))} onClick={async () => {
      if (!saved || !await confirm({ title: '保存学习、复习与缓存设置', confirmLabel: '确认保存', message: `连续复习：${form.reviewOrder === 'due' ? '到期时间优先' : '近期失分优先'}；每轮 ${form.reviewBatchSize ?? '不限'} 张\n复习排期：${schedulingEnabled ? '开启（不自动补历史卡）' : '关闭（不推进排期）'}\n旧知识联想：${associationEnabled ? '开启（自动结合，旧知识标题与描述会发给 AI）' : '关闭'}\n代码题：${codeExercisesEnabled ? '开启' : '关闭'}；语言：${codeLanguages.map(language => languageLabels[language]).join('、')}\n厂商短缓存：${retention === 'short' ? '允许' : '不请求'}\n后续真实模型任务可能收费；缓存非免费、不保证命中，none 也不能保证厂商完全不缓存。` })) return;
      setSaving(true); setError(null); setMessage('');
      try {
        await command('/learning/preferences', { expectedRevision: saved.revision, ...normalize(form), confirm: true }, 'PUT', { errorHandling: 'local' });
        const next = await api<LearningPreferencesView>('/learning/preferences');
        adopt(next); setMessage('学习、复习与缓存设置已保存。');
      } catch (cause) { setError(errorMessage(cause, '保存失败，请核对版本后重试。')); }
      finally { setSaving(false); }
    }}>确认保存设置</Action><Action disabled={loading || saving} onClick={async () => {
      if (dirty && !await confirm({ title: '重新读取设置', message: '重新读取将替换本地设置选择，是否继续？', confirmLabel: '重新读取', tone: 'danger' })) return;
      setMessage(''); setFetchKey(value => value + 1);
    }}>重新读取设置</Action></div>
  </div></details>;
}
