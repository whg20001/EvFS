'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Check, FileText, Lightbulb, Paperclip, Plus, Save, Send, Trash2, Upload } from 'lucide-react';
import { LIMITS, isDocumentFilename, type Recitation, type RecitationInput } from '@sanxing/contracts';
import { useApp, useData, useDraft, useLocalText, today, sessionLabels } from './store';
import { Action, Badge, Card, Empty, Go, Heading, SaveState, Source } from './ui';
import { InputBudget, useInputBudget, type InputBudgetState } from './input-budget';
import { LibrarySearch } from './library';
import { useConfirm } from './confirm';

export function Documents({ recitation, beforeChange, historical, budget }: { recitation: Recitation; beforeChange?: () => Promise<boolean>; historical?: boolean; budget?: InputBudgetState }) {
  const data = useData();
  const { command, setError, busy, reload } = useApp();
  const confirm = useConfirm();
  const [pasting, setPasting] = useState(false);
  const [references, setReferences] = useState<string[]>([]);
  const [name, setName] = useLocalText(`document-name:${recitation.id}`);
  const [text, setText] = useLocalText(`document-text:${recitation.id}`);
  const input = useRef<HTMLInputElement>(null);
  const docs = data.documents.filter(document => recitation.documentIds.includes(document.id));
  const maxMB = (data.capabilities.maxUploadBytes / 1024 / 1024).toLocaleString('zh-CN', { maximumFractionDigits: 3 });
  const pasteBytes = new TextEncoder().encode(text).byteLength;
  // Save a pending draft first, then target exactly the version that save persisted.
  async function freshVersion() {
    if (beforeChange && !await beforeChange()) return undefined;
    return (await reload()).recitations.find(item => item.id === recitation.id)?.version;
  }
  async function upload(file: File) {
    if (!isDocumentFilename(file.name)) { setError('仅支持 UTF-8 编码的 TXT / Markdown 文件。'); return; }
    if (file.size > data.capabilities.maxUploadBytes) { setError(`文件不能超过 ${maxMB} MB。`); return; }
    if (beforeChange && !await beforeChange()) return;
    const form = new FormData(); form.append('file', file);
    await command(`/documents?recitationId=${encodeURIComponent(recitation.id)}`, form);
    if (input.current) input.current.value = '';
  }
  return <Card title="给记忆一点参考" caption="先独立复述，再补充笔记。资料不会替代你的原始表达。">
    {budget ? <InputBudget budget={budget} /> : <p className="small muted">此处仅管理参考资料，不是历史会话快照的输入预算。请在今日复述中查看当前草稿的服务端完整预检。{historical && '历史快照保持不变。'}</p>}
    <div className="stack compact">{docs.map(document => <div key={document.id} className="document-row"><div className="grow"><Source document={document} /><p className="small muted">{document.textLength === undefined ? '资料长度未知（旧记录）' : `原文 ${document.textLength.toLocaleString('zh-CN')} 个字符`} · AI 可能仅使用节选</p></div><Action variant="icon-button" title={`移除 ${document.name}`} onClick={async () => {
      if (!await confirm({ title: '移除资料', message: '从当前草稿移除此资料？历史学习快照仍会保留原始来源。', confirmLabel: '移除', tone: 'danger' })) return;
      const version = await freshVersion();
      if (version !== undefined) await command(`/recitations/${recitation.id}/documents/${document.id}`, { version }, 'DELETE');
    }}><Trash2 size={15} /><span className="sr-only">移除资料</span></Action></div>)}</div>
    <input ref={input} className="sr-only" tabIndex={-1} type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" aria-label="上传 TXT 或 Markdown 笔记" onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file).catch(() => undefined); }} />
    <button type="button" className="upload-zone" disabled={busy || docs.length >= data.capabilities.maxDocuments} onClick={() => input.current?.click()} onDragOver={event => event.preventDefault()} onDrop={event => {
      event.preventDefault(); if (busy || docs.length >= data.capabilities.maxDocuments) return;
      const file = event.dataTransfer.files[0]; if (file) void upload(file).catch(() => undefined);
    }}><span className="icon-tile"><Upload size={21} /></span><strong>拖放笔记到这里，或点击上传</strong><span>TXT、MD、Markdown · UTF-8 · 单文件 ≤ {maxMB} MB · 最多 {data.capabilities.maxDocuments} 份</span></button>
    <div className="row between"><span className="small muted"><Paperclip size={14} /> 已附加 {docs.length} 份资料</span><button type="button" className="text-button" disabled={docs.length >= data.capabilities.maxDocuments} onClick={() => setPasting(!pasting)}><Plus size={15} />{pasting ? '收起粘贴区' : '直接粘贴笔记'}</button></div>
    <details className="paste-panel"><summary>搜索历史资料并附加</summary><div className="stack compact"><p className="small muted">仅引用已有文档，不复制原文，也不改变上传归属；与上传共享资料数量上限，移除只解绑。下次提取或范围确认后，相关片段可能外发给 AI。</p><LibrarySearch kind="document" selectedIds={references} onSelection={setReferences} maxSelected={1} excludedIds={recitation.documentIds} disabled={busy || docs.length >= data.capabilities.maxDocuments} /><Action disabled={references.length !== 1 || docs.length >= data.capabilities.maxDocuments} onClick={async () => {
      if (!await confirm({ title: '附加历史资料', message: '将所选历史资料引用到当前草稿？下次提取或范围确认后，相关片段可能发给 AI。', confirmLabel: '确认附加' })) return;
      const version = await freshVersion();
      if (version !== undefined) {
        await command(`/recitations/${recitation.id}/references`, { version, documentId: references[0], confirm: true });
        setReferences([]);
      }
    }}>确认附加所选资料</Action></div></details>
    {pasting && <div className="paste-panel stack"><label className="field-label">资料名称<input value={name} maxLength={116} onChange={event => setName(event.target.value)} placeholder="例如：今天的阅读摘录.md" /></label><label className="field-label">笔记原文<textarea value={text} onChange={event => setText(event.target.value)} placeholder="粘贴需要参考的原始内容，不执行 Markdown 中的脚本或外链。" rows={6} /></label><p className="small muted">粘贴资料：{pasteBytes.toLocaleString('zh-CN')} / {data.capabilities.maxUploadBytes.toLocaleString('zh-CN')} UTF-8 字节（存储上限，非 AI 输入额度）</p><Action variant="primary" disabled={!name.trim() || !text.trim() || pasteBytes > data.capabilities.maxUploadBytes} onClick={async () => {
      if (beforeChange && !await beforeChange()) return;
      await command('/documents', { recitationId: recitation.id, name: isDocumentFilename(name) ? name : `${name}.md`, text });
      setName(''); setText(''); setPasting(false);
    }}><FileText size={16} />保存粘贴资料</Action></div>}
  </Card>;
}

export function RecitePage() {
  const data = useData();
  const { command } = useApp();
  const day = today(data.timezone);
  const recitation = data.recitations.find(item => item.learningDate === day);
  return <><Heading eyebrow="REFLECT, CONNECT, GROW" title="今日复述" description="合上笔记，用自己的话，重新遇见今天的所学。"><Badge tone="blue">{day}</Badge></Heading>
    {recitation ? <ReciteEditor key={recitation.id} recitation={recitation} /> : <><div className="welcome-card"><div><span className="eyebrow">从一个小小的回忆开始</span><h2>今天，有什么值得留下？</h2><p>不必写得完整，也不必一开始就正确。<br />试着回忆，就是理解的第一步。</p><Action variant="primary" onClick={() => command('/recitations', { learningDate: day })}>开始今天的三省<ArrowRight size={17} /></Action></div><div className="reflection-art" aria-hidden="true"><div className="art-sheet"><i /><i /><i /><span>省</span></div><span className="art-orbit" /><Lightbulb size={32} /></div></div><Card><Empty title="一省所学，二省不解，三省所用">每天留一点时间，把接收过的知识，变成自己真正理解的内容。</Empty></Card></>}
  </>;
}
function ReciteEditor({ recitation }: { recitation: Recitation }) {
  const data = useData();
  const { command, busy, setError, authenticated } = useApp();
  const router = useRouter();
  const [active, setActive] = useState<keyof Pick<RecitationInput, 'learned' | 'unclear' | 'application'>>('learned');
  const draft = useDraft<RecitationInput>({ learned: recitation.learned, unclear: recitation.unclear, application: recitation.application, topic: recitation.topic }, recitation.version, async (value, version) => {
    const response = await command(`/recitations/${recitation.id}/draft`, { version, ...value }, 'PUT');
    return response.state.recitations.find(item => item.id === recitation.id)?.version ?? response.result.version ?? version;
  }, !busy && authenticated, `recitation:${recitation.id}`);
  const budget = useInputBudget(`/recitations/${recitation.id}/input-preview`, { input: draft.value }, [recitation.version, recitation.documentIds]);
  const steps = [
    { field: 'learned' as const, number: '一', title: '今天学了什么', caption: '用自己的话讲一遍', placeholder: '不看笔记，试着复述今天学到的内容。\n\n你能解释其中的关键概念吗？它们之间有什么联系？' },
    { field: 'unclear' as const, number: '二', title: '哪里还说不清', caption: '给模糊的地方做个标记', placeholder: '哪些概念还解释不清？哪些结论你还拿不准？\n\n把卡住的地方写下来，就是往前走了一步。' },
    { field: 'application' as const, number: '三', title: '明天怎么用上', caption: '让知识走进真实场景', placeholder: '想一个可以用上它的场景。\n\n你会如何向别人解释，或者用它解决一个实际问题？' },
  ];
  const current = steps.find(step => step.field === active)!;
  const sessions = data.sessions.filter(session => session.recitationId === recitation.id);
  const total = draft.value.learned.length + draft.value.unclear.length + draft.value.application.length;
  return <div className="stack" data-unsaved={draft.status !== 'saved'}>
    {sessions.length > 0 && <div className="resume-strip"><span><Check size={16} />今天已有 {sessions.length} 次提交，修改草稿不会改变历史快照。</span><Go href={`/sessions/${sessions[sessions.length - 1]!.id}/ask`}>继续学习 · {sessionLabels[sessions[sessions.length - 1]!.status]}</Go></div>}
    <div className="reflection-tabs" role="tablist" aria-label="三省输入">{steps.map(step => <button key={step.field} type="button" role="tab" id={`tab-${step.field}`} aria-controls={`panel-${step.field}`} aria-selected={active === step.field} className={active === step.field ? 'selected' : ''} onClick={() => setActive(step.field)}><span className="step-number">{step.number}</span><span><strong>{step.title}</strong><small>{step.caption}</small></span>{draft.value[step.field].trim() && <Check size={13} className="tab-check" />}</button>)}</div>
    <section className="card editor-card"><div className="editor-toolbar"><div className="row"><span className="icon-tile small-tile"><FileText size={17} /></span><strong>{current.number}省 · {current.title}</strong></div><SaveState status={draft.status} reset={draft.reset} /></div>
      <div className="topic-field"><label htmlFor="topic">今日主题</label><input id="topic" value={draft.value.topic} maxLength={LIMITS.topicChars} onChange={event => draft.change({ ...draft.value, topic: event.target.value })} placeholder="给今天的所学起个名字（选填）" /></div>
      {steps.map(step => <div role="tabpanel" key={step.field} id={`panel-${step.field}`} aria-labelledby={`tab-${step.field}`} hidden={active !== step.field}><textarea className="reflection-input" aria-label={step.title} maxLength={LIMITS.recitationFieldChars} value={draft.value[step.field]} onChange={event => draft.change({ ...draft.value, [step.field]: event.target.value })} placeholder={step.placeholder} /></div>)}
      <div className="editor-footer"><span><Lightbulb size={15} />先回忆，再参考。不完整也没关系。</span><span>本段已用 {draft.value[active].length.toLocaleString('zh-CN')} / {LIMITS.recitationFieldChars.toLocaleString('zh-CN')} 字符 · 剩余 {(LIMITS.recitationFieldChars - draft.value[active].length).toLocaleString('zh-CN')}</span></div>
    </section>
    <Documents recitation={recitation} beforeChange={draft.save} budget={budget} />
    <div className="submit-bar"><div><Send size={20} /><div><strong>让复述，成为理解的开始</strong><p>提交后先确认知识点，再进行追问与检验。</p></div></div><div className="row"><Action onClick={draft.save}><Save size={16} />保存草稿</Action><Action variant="primary" disabled={!draft.value.learned.trim() || draft.status === 'saving' || !budget.canSubmit} onClick={async () => {
      if (!await draft.save()) return;
      if (draft.dirty()) { setError('保存过程中内容发生变化，请稍后再次提交。'); return; }
      const preview = await budget.refresh();
      if (!preview?.canSubmit) return;
      if (draft.dirty()) { setError('预检过程中内容发生变化，请保存后再次提交。'); return; }
      const { result } = await command(`/recitations/${recitation.id}/submit`, { version: draft.version() });
      if (result.sessionId) router.push(`/sessions/${result.sessionId}/ask`);
    }}>提交复述<ArrowRight size={16} /></Action></div></div>
    <p className="center small muted">三段内容共 {total.toLocaleString()} 字 · 自动保存仅在服务端确认后显示成功</p>
  </div>;
}
