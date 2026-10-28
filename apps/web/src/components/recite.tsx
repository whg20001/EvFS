'use client';

import { Feedback } from './feedback';
import { SkillPicker, useTaskSkills } from './skill-picker';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Check, FileText, Lightbulb, LoaderCircle, Paperclip, Plus, Save, Send, Trash2, Upload } from 'lucide-react';
import { LIMITS, documentUploadLimit, isDocumentFilename, isPdfFilename, isUploadFilename, isImageFilename, type Recitation, type RecitationInput } from '@sanxing/contracts';
import { useApp, useData, useDraft, useLocalText, useToday, sessionLabels } from './store';
import { recitationDrafts } from '../lib/recitation-drafts';
import { Action, Badge, Card, Empty, Go, Heading, SaveState, Source } from './ui';
import { useInputBudget } from './input-budget';
import { LibrarySearch } from './library';
import { useConfirm } from './confirm';
import { useComposerTarget } from './composer-context';
import { useImageImport } from './image-import';
import { errorMessage, type DocumentImportProgress } from '../lib/api-client';

type FileImportState = { name: string; status: 'working' | 'done' | 'error' | 'cancelled'; message: string; progress?: DocumentImportProgress };

export function Documents({ recitation, beforeChange, historical }: { recitation: Recitation; beforeChange?: () => Promise<boolean>; historical?: boolean }) {
  const data = useData();
  const { command, setError, busy, reload } = useApp();
  const confirm = useConfirm();
  const importImage = useImageImport();
  const [pasting, setPasting] = useState(false);
  const [references, setReferences] = useState<string[]>([]);
  const [name, setName] = useLocalText(`document-name:${recitation.id}`);
  const [text, setText] = useLocalText(`document-text:${recitation.id}`);
  const input = useRef<HTMLInputElement>(null);
  const importing = useRef(false);
  const [fileImport, setFileImport] = useState<FileImportState | null>(null);
  const importBusy = fileImport?.status === 'working';
  const docs = data.documents.filter(document => recitation.documentIds.includes(document.id));
  const maxMB = (data.capabilities.maxUploadBytes / 1024 / 1024).toLocaleString('zh-CN', { maximumFractionDigits: 3 });
  const pasteBytes = new TextEncoder().encode(text).byteLength;
  // Save a pending draft first, then target exactly the version that save persisted.
  async function freshVersion() {
    if (beforeChange && !await beforeChange()) return undefined;
    return (await reload()).recitations.find(item => item.id === recitation.id)?.version;
  }
  async function upload(file: File) {
    if (importing.current) return;
    importing.current = true;
    setError(null);
    setFileImport({ name: file.name, status: 'working', message: '正在准备导入并保存当前草稿…' });
    try {
      if (!isUploadFilename(file.name)) throw new Error('支持 TXT / Markdown、文本型 PDF，以及 PNG / JPEG / WebP 图片。');
      if (file.size > documentUploadLimit(file.name, data.capabilities.maxUploadBytes)) throw new Error(isImageFilename(file.name) ? '图片不能超过 10 MB。' : isPdfFilename(file.name) ? 'PDF 不能超过 20 MB。' : `文本笔记不能超过 ${maxMB} MiB。`);
      if (docs.length >= data.capabilities.maxDocuments) throw new Error('附件数量已达上限，请先移除不需要的资料。');
      if (beforeChange && !await beforeChange()) throw new Error('当前草稿尚未保存，文件还未导入。请先保存草稿后重试。');
      if (isImageFilename(file.name)) {
        setFileImport({ name: file.name, status: 'working', message: '正在识别图片，请在识别窗口中校对并确认导入。' });
        if (!await importImage(file, recitation.id)) { setFileImport({ name: file.name, status: 'cancelled', message: '已取消图片导入，未添加资料。' }); return; }
      } else {
        const form = new FormData(); form.append('file', file);
        await command(`/documents?recitationId=${encodeURIComponent(recitation.id)}`, form, 'POST', { errorHandling: 'local', onImportProgress: progress => {
          const message = progress.phase === 'parsing' ? progress.total ? `正在解析 PDF · ${progress.completed ?? 0} / ${progress.total} 页` : '正在加载 PDF 解析器…'
            : progress.phase === 'reading' ? '正在读取文件…' : progress.phase === 'uploading' ? '正在上传并处理文件…' : '正在保存资料…';
          setFileImport({ name: file.name, status: 'working', message, progress });
        } });
      }
      setFileImport({ name: file.name, status: 'done', message: '导入成功，已附加到当前复述。' });
    } catch (cause) {
      const message = errorMessage(cause, '文件导入失败，请重试。');
      setFileImport({ name: file.name, status: 'error', message });
    } finally { importing.current = false; if (input.current) input.current.value = ''; }
  }
  return <Card title="给记忆一点参考" caption="先独立复述，再补充笔记。资料不会替代你的原始表达。">
    {historical && <p className="small muted">历史快照保持不变，新增资料需确认更新学习范围后使用。</p>}
    <div className="stack compact">{docs.map(document => <div key={document.id} className="document-row"><div className="grow"><Source document={document} /><p className="small muted">{document.textLength === undefined ? '资料长度未知（旧记录）' : `原文 ${document.textLength.toLocaleString('zh-CN')} 个字符`} · AI 可能仅使用节选</p></div><Action variant="icon-button" title={`移除 ${document.name}`} onClick={async () => {
      if (!await confirm({ title: '移除资料', message: '从当前草稿移除此资料？历史学习快照仍会保留原始来源。', confirmLabel: '移除', tone: 'danger' })) return;
      const version = await freshVersion();
      if (version !== undefined) await command(`/recitations/${recitation.id}/documents/${document.id}`, { version }, 'DELETE');
    }}><Trash2 size={15} /><span className="sr-only">移除资料</span></Action></div>)}</div>
    <input ref={input} className="sr-only" tabIndex={-1} type="file" accept=".txt,.md,.markdown,.pdf,.png,.jpg,.jpeg,.webp,text/plain,text/markdown,application/pdf,image/png,image/jpeg,image/webp" aria-label="上传笔记、PDF 或图片" disabled={importBusy} onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); }} />
    {fileImport && !importBusy && <Feedback title={fileImport.status === 'error' ? '文件导入失败' : fileImport.status === 'done' ? '文件导入成功' : '文件导入已取消'} tone={fileImport.status === 'error' ? 'error' : fileImport.status === 'done' ? 'success' : 'info'} dedupeKey={fileImport.message}><p>文件：{fileImport.name}</p><p>{fileImport.message}</p></Feedback>}
    {fileImport && importBusy && <div id={`file-import-${recitation.id}`} className="file-import-status working" role="status" aria-live="polite" aria-atomic="true">
      <div className="row"><span aria-hidden="true"><LoaderCircle size={17} className="spin" /></span><div><strong>文件：{fileImport.name}</strong><p>{fileImport.message}</p></div></div>
      <progress aria-label="文件导入进度" max={fileImport.progress?.total ?? 1} value={fileImport.progress?.completed} />
    </div>}
    <button type="button" className="upload-zone" aria-busy={importBusy} aria-describedby={importBusy ? `file-import-${recitation.id}` : undefined} disabled={busy || importBusy || docs.length >= data.capabilities.maxDocuments} onClick={() => input.current?.click()} onDragOver={event => event.preventDefault()} onDrop={event => {
      event.preventDefault(); if (busy || importBusy || docs.length >= data.capabilities.maxDocuments) return;
      const file = event.dataTransfer.files[0]; if (file) void upload(file);
    }}><span className="icon-tile">{importBusy ? <LoaderCircle size={21} className="spin" /> : <Upload size={21} />}</span><strong>{importBusy ? '正在导入文件，请稍候…' : '拖放笔记到这里，或点击上传'}</strong><span>文本型 PDF ≤ 20 MB · 图片 PNG / JPEG / WebP ≤ 10 MB，OCR 后校对导入 · TXT / Markdown（UTF-8）≤ {maxMB} MiB · 最多 {data.capabilities.maxDocuments} 份</span></button>
    <div className="row between"><span className="small muted"><Paperclip size={14} /> 已附加 {docs.length} 份资料</span><button type="button" className="text-button" disabled={docs.length >= data.capabilities.maxDocuments} onClick={() => setPasting(!pasting)}><Plus size={15} />{pasting ? '收起粘贴区' : '直接粘贴笔记'}</button></div>
    <details className="paste-panel"><summary>搜索历史资料并附加</summary><div className="stack compact"><p className="small muted">仅引用已有文档，不复制原文，也不改变上传归属；与上传共享资料数量上限，移除只解绑。下次提取或范围确认后，相关片段可能外发给 AI。</p><LibrarySearch kind="document" selectedIds={references} onSelection={setReferences} maxSelected={1} excludedIds={recitation.documentIds} disabled={busy || docs.length >= data.capabilities.maxDocuments} /><Action disabled={references.length !== 1 || docs.length >= data.capabilities.maxDocuments} onClick={async () => {
      if (!await confirm({ title: '附加历史资料', message: '将所选历史资料引用到当前草稿？下次提取或范围确认后，相关片段可能发给 AI。', confirmLabel: '确认附加' })) return;
      const version = await freshVersion();
      if (version !== undefined) {
        await command(`/recitations/${recitation.id}/references`, { version, documentId: references[0], confirm: true });
        setReferences([]);
      }
    }}>确认附加所选资料</Action></div></details>
    <p className="small muted">图片会发送到已配置的 BBC_OCR 服务识别，确认前不会保存为资料，也不会调用学习模型。PDF 在本地解析，最多 100 页、200,000 字符；保留原文件和页码。扫描页需要先做 OCR，多栏排版、公式或表格请对照原文件核对。导入只附加到草稿，提交学习时才会按已确认范围发送解析文本。</p>
    {pasting && <div className="paste-panel stack"><label className="field-label">资料名称<input value={name} maxLength={116} onChange={event => setName(event.target.value)} placeholder="例如：今天的阅读摘录.md" /></label><label className="field-label">笔记原文<textarea value={text} onChange={event => setText(event.target.value)} placeholder="粘贴需要参考的原始内容，不执行 Markdown 中的脚本或外链。" rows={6} /></label><p className="small muted">粘贴资料：{pasteBytes.toLocaleString('zh-CN')} / {data.capabilities.maxUploadBytes.toLocaleString('zh-CN')} UTF-8 字节（存储上限，非 AI 输入额度）</p><Action variant="primary" disabled={!name.trim() || !text.trim() || pasteBytes > data.capabilities.maxUploadBytes} onClick={async () => {
      if (beforeChange && !await beforeChange()) return;
      await command('/documents', { recitationId: recitation.id, name: isDocumentFilename(name) ? name : `${name}.md`, text });
      setName(''); setText(''); setPasting(false);
    }}><FileText size={16} />保存粘贴资料</Action></div>}
  </Card>;
}

export function RecitePage({ id }: { id?: string }) {
  const data = useData();
  const { command, setError } = useApp();
  const day = useToday(data.timezone);
  // Keep the open day's editor mounted through midnight, including unsaved input.
  const [editorDate, setEditorDate] = useState(day);
  const recitation = data.recitations.find(item => id ? item.id === id : item.learningDate === editorDate);
  const historical = Boolean(recitation && recitation.learningDate !== day);
  const drafts = recitationDrafts(data);
  const switchToToday = () => {
    if (document.querySelector('[data-unsaved="true"]')) { setError('请先保存当前复述草稿，再切换到今日复述。'); return; }
    setEditorDate(day);
  };
  return <><Heading eyebrow="REFLECT, CONNECT, GROW" title={id || historical ? '继续复述' : '今日复述'} description={id || historical ? '接着写下当时的思考，准备好后再提交。' : '合上笔记，用自己的话，重新遇见今天的所学。'}><div className="row wrap recite-heading-actions"><Badge tone="blue">{recitation?.learningDate ?? editorDate}</Badge><Go href="/drafts">草稿箱{drafts.length > 0 ? ` · ${drafts.length}` : ''}</Go></div></Heading>
    {historical && <div className="resume-strip draft-origin"><span>正在编辑 {recitation!.learningDate} 的复述，提交后仍归属于这一天。内容和参考资料会继续保存。</span>{id ? <Go href="/recite">回到今日复述</Go> : <Action onClick={switchToToday}>切换到今日复述</Action>}</div>}
    {!id && editorDate !== day && !recitation && <div className="resume-strip draft-origin"><span>新的一天开始了，可以继续记录今天的所学。</span><Action onClick={switchToToday}>切换到今日复述</Action></div>}
    {!id && drafts.some(draft => draft.learningDate !== day && draft.id !== recitation?.id) && <div className="draft-reminder"><p>之前还有未提交的复述，已经保留在草稿箱。</p><Go href="/drafts">继续之前的草稿</Go></div>}
    {recitation ? <ReciteEditor key={recitation.id} recitation={recitation} /> : id ? <Card><Empty title="没有找到这份复述" action={<Go href="/drafts">返回草稿箱</Go>}>请在当前账号和运行模式的草稿箱中选择要继续编辑的复述。</Empty></Card> : <><div className="welcome-card"><div><span className="eyebrow">从一个小小的回忆开始</span><h2>今天，有什么值得留下？</h2><p>不必写得完整，也不必一开始就正确。<br />试着回忆，就是理解的第一步。</p><Action variant="primary" onClick={async () => { setEditorDate(day); await command('/recitations', { learningDate: day }); }}>开始今天的三省<ArrowRight size={17} /></Action></div><div className="reflection-art" aria-hidden="true"><div className="art-sheet"><i /><i /><i /><span>省</span></div><span className="art-orbit" /><Lightbulb size={32} /></div></div><Card><Empty title="一省所学，二省不解，三省所用">每天留一点时间，把接收过的知识，变成自己真正理解的内容。</Empty></Card></>}
  </>;
}
function ReciteEditor({ recitation }: { recitation: Recitation }) {
  const skills = useTaskSkills('extract');
  const importImage = useImageImport();
  const data = useData();
  const { command, busy, setError, authenticated, storageMode } = useApp();
  const router = useRouter();
  const [active, setActive] = useState<keyof Pick<RecitationInput, 'learned' | 'unclear' | 'application'>>('learned');
  const draft = useDraft<RecitationInput>({ learned: recitation.learned, unclear: recitation.unclear, application: recitation.application, topic: recitation.topic }, recitation.version, async (value, version) => {
    const response = await command(`/recitations/${recitation.id}/draft`, { version, ...value }, 'PUT');
    return response.state.recitations.find(item => item.id === recitation.id)?.version ?? response.result.version ?? version;
  }, !busy && authenticated, `recitation:${recitation.id}`);
  const activeInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const input = activeInput.current;
    if (input) { input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`; }
  }, [active, draft.value]);
  useComposerTarget(async input => {
    if (input.file || input.attachment) {
      if (recitation.documentIds.length >= data.capabilities.maxDocuments) throw new Error('附件数量已达上限，请先移除不需要的资料。');
      if (!await draft.save()) throw new Error('请先保存当前草稿，再添加笔记。');
      if (input.file && isImageFilename(input.file.name)) { await importImage(input.file, recitation.id); }
      else if (input.file) {
        const form = new FormData(); form.set('file', input.file);
        await command(`/documents?recitationId=${encodeURIComponent(recitation.id)}`, form);
      } else {
        if (new TextEncoder().encode(input.text).byteLength > data.capabilities.maxUploadBytes) throw new Error('笔记超过文件大小限制，请分段添加。');
        await command('/documents', { recitationId: recitation.id, name: '粘贴的笔记.md', text: input.text });
      }
      return;
    }
    const text = draft.value[active] ? `${draft.value[active]}\n\n${input.text}` : input.text;
    if (text.length > LIMITS.recitationFieldChars) throw new Error('本段已到字符上限，请切换到另一省或将内容作为笔记上传。');
    draft.change({ ...draft.value, [active]: text });
  });
  const budget = useInputBudget(`/recitations/${recitation.id}/input-preview`, { input: { ...draft.value, skillSelections: skills.selection } }, [recitation.version, recitation.documentIds]);
  const steps = [
    { field: 'learned' as const, number: '一', title: '今天学了什么', caption: '用自己的话讲一遍', placeholder: '不看笔记，试着复述今天学到的内容。\n\n你能解释其中的关键概念吗？它们之间有什么联系？' },
    { field: 'unclear' as const, number: '二', title: '哪里还说不清', caption: '给模糊的地方做个标记', placeholder: '哪些概念还解释不清？哪些结论你还拿不准？\n\n把卡住的地方写下来，就是往前走了一步。' },
    { field: 'application' as const, number: '三', title: '明天怎么用上', caption: '让知识走进真实场景', placeholder: '想一个可以用上它的场景。\n\n你会如何向别人解释，或者用它解决一个实际问题？' },
  ];
  const current = steps.find(step => step.field === active)!;
  const sessions = data.sessions.filter(session => session.recitationId === recitation.id);
  const total = draft.value.learned.length + draft.value.unclear.length + draft.value.application.length;
  return <div className="stack" data-unsaved={draft.status !== 'saved'}>
    {sessions.length > 0 && <div className="resume-strip"><span><Check size={16} />本次复述已有 {sessions.length} 次提交，修改草稿不会改变历史快照。</span><Go href={`/sessions/${sessions[sessions.length - 1]!.id}/ask`}>继续学习 · {sessionLabels[sessions[sessions.length - 1]!.status]}</Go></div>}
    <div className="reflection-tabs" role="tablist" aria-label="三省输入">{steps.map(step => <button key={step.field} type="button" role="tab" id={`tab-${step.field}`} aria-controls={`panel-${step.field}`} aria-selected={active === step.field} className={active === step.field ? 'selected' : ''} onClick={() => setActive(step.field)}><span className="step-number">{step.number}</span><span><strong>{step.title}</strong><small>{step.caption}</small></span>{draft.value[step.field].trim() && <Check size={13} className="tab-check" />}</button>)}</div>
    <section className="card editor-card"><div className="editor-toolbar"><div className="row"><span className="icon-tile small-tile"><FileText size={17} /></span><strong>{current.number}省 · {current.title}</strong></div><SaveState status={draft.status} reset={draft.reset} /></div>
      <div className="topic-field"><label htmlFor="topic">今日主题</label><input id="topic" value={draft.value.topic} maxLength={LIMITS.topicChars} onChange={event => draft.change({ ...draft.value, topic: event.target.value })} placeholder="给今天的所学起个名字（选填）" /></div>
      {steps.map(step => <div role="tabpanel" key={step.field} id={`panel-${step.field}`} aria-labelledby={`tab-${step.field}`} hidden={active !== step.field}><textarea ref={active === step.field ? activeInput : undefined} className="reflection-input" aria-label={step.title} maxLength={LIMITS.recitationFieldChars} value={draft.value[step.field]} onChange={event => draft.change({ ...draft.value, [step.field]: event.target.value })} placeholder={step.placeholder} /></div>)}
      <div className="editor-footer"><span><Lightbulb size={15} />先回忆，再参考。不完整也没关系。</span><span>本段已用 {draft.value[active].length.toLocaleString('zh-CN')} / {LIMITS.recitationFieldChars.toLocaleString('zh-CN')} 字符 · 剩余 {(LIMITS.recitationFieldChars - draft.value[active].length).toLocaleString('zh-CN')}</span></div>
    </section>
    <Documents recitation={recitation} beforeChange={draft.save} />
    {budget.error ? <Feedback title="操作提示" tone="error" className="small danger-text">暂时无法检查提交条件：{budget.error} <button type="button" className="text-button" onClick={() => { void budget.refresh(); }}>重试检查</button></Feedback>
      : budget.preview && !budget.preview.canSubmit && draft.value.learned.trim() && <Feedback title="操作提示" tone="error" className="small danger-text">暂时无法提交：{budget.preview.reason ?? '请检查输入内容或模型配置。'}</Feedback>}
    <SkillPicker skills={skills} disabled={busy} />
    <div className="submit-bar"><div><Send size={20} /><div><strong>让复述，成为理解的开始</strong><p>提交后先确认知识点，再进行追问与检验。</p></div></div><div className="row"><Action onClick={draft.save}><Save size={16} />保存草稿</Action><Action variant="primary" disabled={!draft.value.learned.trim() || draft.status === 'saving' || !budget.canSubmit} onClick={async () => {
      if (!await draft.save()) return;
      if (draft.dirty()) { setError('保存过程中内容发生变化，请稍后再次提交。'); return; }
      const preview = await budget.refresh();
      if (!preview?.canSubmit) return;
      if (JSON.stringify(skills.current.current) !== JSON.stringify(skills.selection)) { setError('Skill 选择已变化，请确认后重新提交。'); return; }
      if (draft.dirty()) { setError('预检过程中内容发生变化，请保存后再次提交。'); return; }
      const { result } = await command(`/recitations/${recitation.id}/submit`, { version: draft.version(), skillSelections: skills.selection });
      if (result.sessionId) router.push(`/sessions/${result.sessionId}/ask`);
    }}>提交复述<ArrowRight size={16} /></Action></div></div>
    <p className="center small muted">三段内容共 {total.toLocaleString()} 字 · 自动保存仅在{storageMode === 'browser' ? '本地数据库' : '服务端'}确认后显示成功 · 未提交的内容跨天保留在草稿箱</p>
  </div>;
}
