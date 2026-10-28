'use client';

import { Feedback } from './feedback';
import { useEffect, useState } from 'react';
import { Database, Download, Upload } from 'lucide-react';
import type { AccountIdentity, AppData, Mode } from '@sanxing/contracts';
import { useApp } from './store';
import { Card, Heading } from './ui';
import { useConfirm } from './confirm';
import { errorMessage } from '../lib/api-client';
import { downloadFile } from '../lib/download';

type Status = { user: AccountIdentity; mode: Mode; revision: number; persisted: boolean;
  counts: { recitations: number; documents: number; knowledge: number; quizzes: number; skills: number } };
export function LocalDataPage() {
  const { api, reload, storageMode } = useApp(); const confirm = useConfirm();
  const [status, setStatus] = useState<Status | null>(null); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [message, setMessage] = useState('');
  useEffect(() => {
    if (storageMode !== 'browser') return;
    const controller = new AbortController();
    void api<Status>('/local-data/status', { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setStatus(value); })
      .catch(error => { if (!controller.signal.aborted) setError(errorMessage(error, '本地存储读取失败。')); });
    return () => controller.abort();
  }, [api, storageMode]);
  const perform = async (action: () => Promise<void>) => {
    if (busy) return; setBusy(true); setError(''); setMessage('');
    try { await action(); setStatus(await api<Status>('/local-data/status')); }
    catch (error) { setError(errorMessage(error, '本地数据操作失败。')); }
    finally { setBusy(false); }
  };
  return <div className="stack">
    <Heading eyebrow="LOCAL LEARNING DATA" title="本地数据与备份" description="学习资料由你保管，随时导出和迁移。" />
    {storageMode !== 'browser' ? <Card title="服务器学习库"><p>当前实例使用服务器存储。迁移到本地模式前，请先在服务器导出学习数据，再到新账号的本页导入备份。</p><pre>npm run data:export -- ./backup.json</pre></Card> : <>
      <Card title="此浏览器的学习数据库"><p className="small muted">账号 {status?.user.username ?? '正在读取…'} · {status?.mode ?? '…'} 模式。笔记、资料、学习记录与 Skill 保存在此浏览器；登录其他设备时需要导入备份。</p>
        <p className="small muted">清理网站数据、删除浏览器配置或丢失设备可能导致本地数据丢失，请定期导出备份。</p>
        {status && <div className="stats-grid">{Object.entries({ 复述: status.counts.recitations, 资料: status.counts.documents, 知识点: status.counts.knowledge, 测验: status.counts.quizzes, Skill: status.counts.skills }).map(([name, count]) => <div key={name}><span className="small muted">{name}</span><p>{count}</p></div>)}</div>}
        <button type="button" className="button subtle" disabled={busy || !status || status.persisted} onClick={() => { void perform(async () => {
          const retained = await navigator.storage?.persist?.() ?? false;
          setMessage(retained ? '浏览器已允许持久保留网站数据，仍建议保留导出备份。' : '浏览器未授予持久存储，可继续使用并定期导出备份。');
        }); }}><Database size={16} />{status?.persisted ? '已获浏览器持久存储权限' : '申请浏览器持久存储'}</button>
      </Card>
      <Card title="导出备份"><p className="small muted">导出包含资料原件、笔记、答案、任务记录、模型选择及 Skill 的 JSON 文件。文件未加密，请保存在你信任的位置。云端 OAuth 凭据不包含在内。</p>
        <button type="button" className="button primary" disabled={busy || !status} onClick={() => { void perform(async () => {
          const data = await api<AppData>('/local-data/export');
          downloadFile(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `sanxing-${status!.mode}-${new Date().toISOString().slice(0, 10)}.json`);
          setMessage('备份已生成，请妥善保管。');
        }); }}><Download size={16} />导出学习备份</button>
      </Card>
      <Card title="导入或迁移"><p className="small muted">支持原服务器导出的 schemaVersion 1 备份。导入会替换此账号在当前浏览器、当前模式的数据；未完成的模型任务需要手动重试。</p>
        <label className="field-label" htmlFor="learning-backup"><Upload size={16} />选择 JSON 备份（最大 256 MiB）</label>
        <input id="learning-backup" type="file" accept=".json,application/json" disabled={busy} onChange={event => {
          const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
          void (async () => {
            if (file.size > 256 * 1024 * 1024) { setError('备份不能超过 256 MiB。'); return; }
            if (!await confirm({ title: '导入学习备份', message: '将覆盖此账号在当前浏览器、当前模式的学习数据。请先导出当前备份；确定导入？', confirmLabel: '覆盖并导入', tone: 'danger' })) return;
            await perform(async () => { await api('/local-data/import', { method: 'POST', body: JSON.parse(await file.text()) }); await reload(); setMessage('备份已导入，未自动调用模型。'); });
          })();
        }} />
      </Card>
      <Card title="清空此设备的数据"><p className="small muted">仅清空当前账号、当前模式的本地学习数据。云端账号、Provider 授权和已导出的备份继续保留。</p>
        <button type="button" className="button" disabled={busy || !status} onClick={() => { void (async () => {
          if (!await confirm({ title: '清空本地学习数据', message: '此操作会删除当前账号、当前模式在此浏览器的全部学习记录，请确认已经导出备份。', confirmLabel: '清空本地数据', tone: 'danger' })) return;
          await perform(async () => { await api('/local-data', { method: 'DELETE', body: {} }); await reload(); setMessage('当前账号在此浏览器的学习数据已清空。'); });
        })(); }}>清空本地学习数据</button>
      </Card>
    </>}
    {error && <Feedback title="操作提示" tone="error" className="danger-text">{error}</Feedback>}{message && <Feedback onDismiss={() => setMessage('')} title="操作提示" tone="info">{message}</Feedback>}
  </div>;
}
