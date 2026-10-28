'use client';

import { Feedback } from '../../components/feedback';
import { useEffect, useRef, useState } from 'react';
import { SKILL_LIMITS, SKILL_TASKS, SKILL_TASK_LABELS, type LearningSkill, type Mode, type SkillDocument, type SkillPreview, type SkillSummary, type SkillTask } from '@sanxing/contracts';
import { useApp } from '../../components/store';
import { useConfirm } from '../../components/confirm';
import { Badge, Card } from '../../components/ui';
import { errorMessage, type ApiClient } from '../../lib/api-client';
import styles from './ai-access.module.css';
import { CloudSkills } from './cloud-skills';
import { FolderArchive, Upload } from 'lucide-react';
import { readSkillImport, skillArchiveFilename, type SkillImportFile, type SkillArchiveCandidate } from '../../lib/skill-archive';

type Overview = { mode: Mode; items: SkillSummary[] };
type Perform = (action: (signal: AbortSignal) => Promise<void>, refresh?: boolean) => Promise<boolean>;
const example = '---\nname: explain-with-examples\ndescription: 在追问和出题时，用贴近已确认知识范围的例子帮助理解。\n---\n优先使用简短、具体的例子。先说明适用条件，再检查边界情况。\n保持当前任务要求的 JSON 格式、知识范围和评分标准。\n';

function SkillContent({ document }: { document: SkillDocument }) {
  return <div className={styles.skillContent}>
    {document.compatibility && <p className="small">环境要求：{document.compatibility}</p>}
    {document.license && <p className="small">许可：{document.license}</p>}
    {document.allowedTools && <p className="small">文件声明的工具：{document.allowedTools}（本应用不启用工具）</p>}
    <pre className={styles.skillInstructions}>{document.instructions}</pre>
    {document.resources?.map(file => <details key={file.path}><summary>参考文本 · {file.path}</summary><pre className={styles.skillInstructions}>{file.text}</pre></details>)}
  </div>;
}

function SkillItem({ skill, api, perform, busy }: { skill: SkillSummary; api: ApiClient; perform: Perform; busy: boolean }) {
  const confirm = useConfirm();
  const [tasks, setTasks] = useState<SkillTask[]>(skill.tasks);
  const [cachedDetail, setDetail] = useState<{ value: LearningSkill; api: ApiClient } | null>(null);
  const detail = cachedDetail?.api === api ? cachedDetail.value : null;
  const changed = SKILL_TASKS.some(task => tasks.includes(task) !== skill.tasks.includes(task));
  const save = (enabled: boolean) => perform(async signal => {
    await api(`/ai/skills/${skill.id}`, { method: 'PUT', body: { version: skill.version, enabled, tasks }, signal });
  }, true);
  return <Card className={styles.provider}>
    <div className={styles.row}><h3>{skill.name}</h3><Badge tone={skill.enabled ? 'green' : 'amber'}>{skill.enabled ? '可供选择' : '未启用'}</Badge></div>
    <p className="small">{skill.description}</p>
    <p className="small muted">版本 {skill.version} · 指令 {skill.instructionChars} 字</p>
    <fieldset className={styles.skillTasks} disabled={busy}>
      <legend>适用任务 · {skill.name}</legend>
      {SKILL_TASKS.map(task => <label key={task}><input type="checkbox" checked={tasks.includes(task)} onChange={event => setTasks(current => event.target.checked ? [...current, task] : current.filter(item => item !== task))} />{SKILL_TASK_LABELS[task]}</label>)}
    </fieldset>
    {!tasks.length && <Feedback title="Skill 设置提示" tone="info">请至少选择一种适用任务。</Feedback>}
    <div className={styles.actions}>
      <button className="button primary" type="button" disabled={busy || !tasks.length} onClick={() => { void save(!skill.enabled); }}>{skill.enabled ? '停用' : '启用'} {skill.name}</button>
      {changed && <button className="button" type="button" disabled={busy || !tasks.length} onClick={() => { void save(skill.enabled); }}>保存适用任务</button>}
      <button className="button" type="button" disabled={busy} aria-expanded={!!detail} onClick={() => {
        if (detail) setDetail(null);
        else void perform(async signal => { const value = await api<LearningSkill>(`/ai/skills/${skill.id}`, { signal }); if (!signal.aborted) setDetail({ value, api }); });
      }}>{detail ? '收起' : '查看'}指令 · {skill.name}</button>
      <button className="button" type="button" disabled={busy} onClick={async () => {
        if (await confirm({ title: `删除 ${skill.name}`, message: '删除后新任务不能选择此 Skill。已经排队和历史任务仍保留当时的指令快照。', confirmLabel: '删除 Skill', tone: 'danger' })) {
          void perform(async signal => { await api(`/ai/skills/${skill.id}`, { method: 'DELETE', body: { version: skill.version }, signal }); }, true);
        }
      }}>删除 {skill.name}</button>
    </div>
    {detail && <SkillContent document={detail.document} />}
  </Card>;
}

export function Skills() {
  const { api } = useApp();
  const [tab, setTab] = useState<'local' | 'cloud'>('local');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [busy, setBusy] = useState(true);
  const locked = useRef(true);
  const lifetime = useRef<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [file, setFile] = useState<SkillImportFile | null>(null);
  const [preview, setPreview] = useState<SkillPreview | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [archives, setArchives] = useState<SkillArchiveCandidate[]>([]);
  const [selectedPath, setSelectedPath] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [archiveWarnings, setArchiveWarnings] = useState<string[]>([]);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    locked.current = true; setBusy(true);
    void api<Overview>('/ai/skills', { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setOverview(value); })
      .catch(cause => { if (!controller.signal.aborted) setError(errorMessage(cause, '读取 Skill 失败')); })
      .finally(() => { if (!controller.signal.aborted) { locked.current = false; setBusy(false); } });
    return () => controller.abort();
  }, [api]);
  const perform: Perform = async (action, refresh = false) => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || locked.current) return false;
    locked.current = true; setBusy(true); setError(null); setNotice(null);
    let saved = false;
    try {
      await action(signal);
      saved = refresh;
      if (refresh) { const next = await api<Overview>('/ai/skills', { signal }); if (!signal.aborted) setOverview(next); }
      return !signal.aborted;
    } catch (cause) {
      if (!signal.aborted) setError((saved ? '操作已保存，但列表刷新失败，请刷新列表。' : '') + errorMessage(cause, 'Skill 操作失败'));
      return false;
    } finally { if (!signal.aborted) { locked.current = false; setBusy(false); } }
  };
  const clearFile = () => { setFile(null); setPreview(null); setArchives([]); setSelectedPath(''); setSourceName(''); setArchiveWarnings([]); if (input.current) input.current.value = ''; };
  const showCandidate = async (candidate: SkillArchiveCandidate, signal: AbortSignal) => {
    const result = await api<SkillPreview>('/ai/skills/preview', { method: 'POST', body: candidate.file, signal });
    if (!signal.aborted) { setFile(candidate.file); setPreview(result); setSelectedPath(candidate.path); setArchiveWarnings(candidate.warnings); }
  };
  return <section className={styles.providers} aria-labelledby="ai-skills-title">
    <div className={styles.row}><h2 id="ai-skills-title">学习 Skill</h2>
      <button className="button subtle" type="button" disabled={busy} onClick={() => { void perform(async signal => { const next = await api<Overview>('/ai/skills', { signal }); if (!signal.aborted) setOverview(next); }); }}>刷新 Skill 列表</button></div>
    <p className="small muted">导入文件或从云目录下载，为学习任务添加教学方法。最多保存 20 个，每次 Agent 任务可通过下拉框选择最多 3 个。</p>
    <details className={styles.help}><summary>Skill 使用说明</summary><p className="small muted">导入、下载和更新后默认停用；请查看指令并选择适用任务后启用。启用仅表示可供选择，不会自动调用。请在知识提取、追问、出题或评分前选择本次要使用的 Skill；未选择则不使用。压缩包在当前设备解包，指令及已导入的参考文本会随所选任务使用，附带脚本不执行。历史任务重试沿用原快照。</p>{overview?.mode === 'mock' && <p className="small muted">当前为模拟模式，模拟回复不会体现 Skill 指令效果。</p>}</details>
    {error && <Feedback title="操作提示" tone="error" className={styles.error}>{error}</Feedback>}
    {notice && <Feedback onDismiss={() => setNotice('')} title="操作提示" tone="success" className="small">{notice}</Feedback>}
    {busy && <p role="status" className="small muted">正在处理 Skill…</p>}
    <div className={styles.skillTabs} role="tablist" aria-label="Skill 来源"><button type="button" role="tab" id="skills-local-tab" aria-selected={tab === 'local'} aria-controls="skills-local-panel" onClick={() => setTab('local')}>本地 Skill{overview ? ` · ${overview.items.length}` : ''}</button><button type="button" role="tab" id="skills-cloud-tab" aria-selected={tab === 'cloud'} aria-controls="skills-cloud-panel" onClick={() => setTab('cloud')}>云 Skill</button></div>
    {tab === 'cloud' && <div role="tabpanel" id="skills-cloud-panel" aria-labelledby="skills-cloud-tab"><CloudSkills api={api} local={overview?.items ?? []} busy={busy} download={name => perform(async signal => {
      await api(`/ai/skills/cloud/${encodeURIComponent(name)}/download`, { method: 'POST', body: {}, signal });
      if (!signal.aborted) setNotice(`${name} 已下载到本地，请在本地 Skill 中选择适用任务并启用。`);
    }, true)} /></div>}
    <div role="tabpanel" id="skills-local-panel" aria-labelledby="skills-local-tab" hidden={tab !== 'local'} className={styles.localSkills}>
    <Card className={styles.provider}>
      <label className="field-label" htmlFor="skill-file">导入 Skill 文件或压缩包</label>
      <div className={styles.skillUpload}>
        <span className={styles.skillUploadIcon}><FolderArchive size={24} strokeWidth={1.4} /></span>
        <div><strong>{sourceName || 'SKILL.md 或 Skill 压缩包'}</strong><p>ZIP / 7Z / TAR / TAR.GZ / TGZ · 压缩包最大 10 MiB</p></div>
        <input ref={input} id="skill-file" type="file" className="sr-only" accept=".md,.zip,.7z,.tar,.gz,.tgz" disabled={busy} onChange={event => {
          const selected = event.target.files?.[0]; clearFile();
          if (!selected) return;
          setSourceName(selected.name);
          void perform(async signal => {
            const candidates = await readSkillImport(selected, signal);
            signal.throwIfAborted(); setArchives(candidates);
            await showCandidate(candidates[0]!, signal);
          });
        }} />
        <button type="button" className="button" disabled={busy} onClick={() => input.current?.click()}><Upload size={15} />选择文件</button>
      </div>
      <p className="small muted">包含 SKILL.md 即可识别；可附带最多 8 份 UTF-8 参考文本，合计 8000 字。原文件与导入操作不发送给模型。</p>
      {!!archives.length && skillArchiveFilename(sourceName) && <label className="field-label">压缩包内的 Skill<select disabled={busy} value={selectedPath} onChange={event => {
        const candidate = archives.find(item => item.path === event.target.value);
        if (candidate) void perform(signal => showCandidate(candidate, signal));
      }}><option value="" disabled>请选择包内 Skill</option>{archives.map(candidate => <option key={candidate.path} value={candidate.path}>{candidate.path}</option>)}</select></label>}
      <a className="small" download="SKILL.md" href={`data:text/markdown;charset=utf-8,${encodeURIComponent(example)}`}>下载 SKILL.md 示例</a>
      {preview && file && <div className={styles.skillPreview}>
        <h3>导入预览 · {preview.document.name}</h3>
        <p className="small">{preview.document.description}</p>
        {[...preview.warnings, ...archiveWarnings].map(warning => <p className="small" key={warning}>{warning}</p>)}
        {preview.existing && <p className="small">同名 Skill 已存在。更新会替换文件内容并停用，需重新启用。</p>}
        <SkillContent document={preview.document} />
        <div className={styles.actions}>
          <button type="button" className="button primary" disabled={busy} onClick={() => {
            void perform(async signal => {
              await api('/ai/skills', { method: 'POST', body: { ...file, ...(preview.existing ? { replace: preview.existing } : {}) }, signal });
              if (!signal.aborted) {
                const remaining = archives.filter(candidate => candidate.path !== selectedPath);
                if (remaining.length) { setArchives(remaining); setFile(null); setPreview(null); setSelectedPath(''); setArchiveWarnings([]); } else clearFile();
                setNotice('Skill 已保存，当前未启用。启用后可在 Agent 任务的下拉框中选择；不会自动调用。');
              }
            }, true);
          }}>{preview.existing ? '更新已有 Skill' : '确认导入 Skill'}</button>
          <button type="button" className="button" disabled={busy} onClick={clearFile}>取消导入</button>
        </div>
      </div>}
    </Card>
    {overview && !overview.items.length && <p className="small muted">尚未导入 Skill。</p>}
    {overview?.items.map(skill => <SkillItem key={`${skill.id}:${skill.version}`} skill={skill} api={api} perform={perform} busy={busy} />)}
    </div>
  </section>;
}
