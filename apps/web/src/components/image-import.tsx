'use client';

import { Feedback } from './feedback';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { FileCheck2, LoaderCircle, RotateCcw, ScanText, X } from 'lucide-react';
import { LIMITS, imageMediaType, imageOcrPreviewSchema, isImageFilename, type ImageOcrPreview } from '@sanxing/contracts';
import { useApp } from './store';
import { ModalShell } from './modal';
import { useBeforeUnload, useConfirm } from './confirm';
import { errorMessage } from '../lib/api-client';

type Pending = { file: File; recitationId: string; opener: HTMLElement | null; resolve: (saved: boolean) => void };
type ImportImage = (file: File, recitationId: string) => Promise<boolean>;
const Context = createContext<ImportImage | null>(null);

export function ImageImportProvider({ children }: { children: ReactNode }) {
  const { authenticated } = useApp(); const [pending, setPending] = useState<Pending | null>(null); const current = useRef<Pending | null>(null);
  const finish = useCallback((saved: boolean) => { current.current?.resolve(saved); current.current = null; setPending(null); }, []);
  const request = useCallback<ImportImage>(async (file, recitationId) => {
    if (current.current) throw new Error('请先完成或取消当前图片导入。');
    if (!isImageFilename(file.name)) throw new Error('请选择 PNG、JPEG 或 WebP 图片。');
    if (file.size > LIMITS.imageUploadBytes) throw new Error('图片不能超过 10 MB。');
    if (!imageMediaType(new Uint8Array(await file.slice(0, 16).arrayBuffer()))) throw new Error('文件内容不是有效的 PNG、JPEG 或 WebP 图片。');
    if (current.current) throw new Error('请先完成或取消当前图片导入。');
    return new Promise<boolean>(resolve => {
      const value = { file, recitationId, opener: document.activeElement instanceof HTMLElement ? document.activeElement : null, resolve };
      current.current = value; setPending(value);
    });
  }, []);
  useEffect(() => { if (!authenticated) finish(false); }, [authenticated, finish]);
  useEffect(() => () => { current.current?.resolve(false); current.current = null; }, []);
  useBeforeUnload(() => !!current.current);
  return <Context.Provider value={request}>{children}{pending && <ImageImportDialog pending={pending} finish={finish} />}</Context.Provider>;
}
export function useImageImport() {
  const request = useContext(Context); if (!request) throw new Error('ImageImportProvider is required'); return request;
}

function ImageImportDialog({ pending, finish }: { pending: Pending; finish: (saved: boolean) => void }) {
  const { api, command, storageMode } = useApp(); const confirm = useConfirm();
  const [phase, setPhase] = useState<'recognizing' | 'ready' | 'saving' | 'error'>('recognizing');
  const [result, setResult] = useState<ImageOcrPreview | null>(null); const [text, setText] = useState(''); const [error, setError] = useState(''); const [attempt, setAttempt] = useState(0);
  const controller = useRef<AbortController | null>(null); const mounted = useRef(true);
  const [preview, setPreview] = useState('');
  useEffect(() => { const url = URL.createObjectURL(pending.file); setPreview(url); return () => URL.revokeObjectURL(url); }, [pending.file]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => {
    const abort = new AbortController(); controller.current = abort; setPhase('recognizing'); setError('');
    const form = new FormData(); form.set('file', pending.file);
    void Promise.resolve().then(() => { if (!abort.signal.aborted) return api<ImageOcrPreview>('/ocr/recognize', { method: 'POST', body: form, signal: abort.signal }); }).then(raw => {
      if (abort.signal.aborted || !raw) return; const next = imageOcrPreviewSchema.parse(raw); setResult(next); setText(next.text); setPhase('ready');
    }).catch(cause => { if (!abort.signal.aborted) { setPhase('error'); setError(errorMessage(cause, '图片识别未完成，请重试。')); } });
    return () => abort.abort();
  }, [api, pending.file, attempt]);
  const close = async () => {
    if (phase === 'saving') return;
    if (result && text !== result.text && !await confirm({ title: '放弃图片导入', message: '校对后的文字尚未保存，确定放弃本次导入？', confirmLabel: '放弃导入', tone: 'danger' })) return;
    controller.current?.abort(); finish(false);
  };
  const save = async () => {
    if (!result || !text.trim() || phase !== 'ready') return; setPhase('saving'); setError('');
    const form = new FormData();
    form.set('ocr', JSON.stringify({ text, import: { ...result.import, reviewed: true, edited: text !== result.text } }));
    form.set('file', pending.file);
    try { await command(`/documents?recitationId=${encodeURIComponent(pending.recitationId)}`, form); if (mounted.current) finish(true); }
    catch (cause) { if (mounted.current) { setPhase('ready'); setError(errorMessage(cause, '导入结果尚未确认，请保留文字并重试。')); } }
  };
  return <ModalShell className="ocr-dialog" backdropClass="ocr-backdrop" labelledBy="ocr-dialog-title" initialFocus="[data-ocr-close]" opener={pending.opener} close={() => void close()}>
    <div className="ocr-dialog-header"><div><span className="eyebrow">IMAGE TO TEXT</span><h2 id="ocr-dialog-title"><ScanText size={20} />图片文字识别</h2><p>{pending.file.name}</p></div><button data-ocr-close type="button" className="quiet-icon" aria-label="关闭图片识别" disabled={phase === 'saving'} onClick={() => void close()}><X size={18} /></button></div>
    <div className="ocr-dialog-body"><figure className="ocr-original"><img src={preview || undefined} alt={`待识别原图：${pending.file.name}`} /><figcaption>对照原图核对，尤其是公式、数字与专有名词。</figcaption></figure>
    <div className="ocr-recognition"><div className="row between"><h3>识别文字</h3>{result && <span className="small muted">{result.import.width} × {result.import.height}{result.import.confidence !== null ? ` · 置信度 ${(result.import.confidence * 100).toFixed(0)}%` : ''}</span>}</div>
      {phase === 'recognizing' && <div className="ocr-progress" role="status"><LoaderCircle size={24} className="spin" /><strong>正在识别图片中的文字…</strong><p>图片仅发往已配置的 BBC_OCR 服务，识别完成后可校对再保存。</p></div>}
      {error && <Feedback title="操作提示" tone="error" className="ocr-error">{error}</Feedback>}
      {result && phase !== 'recognizing' && <><label className="sr-only" htmlFor="ocr-text">校对识别文字</label><textarea id="ocr-text" value={text} maxLength={LIMITS.ocrTextChars} disabled={phase === 'saving'} onChange={event => setText(event.target.value)} rows={14} placeholder="未识别到可用文字。可重新识别，或对照原图补充文字后保存。" /><div className="row between small muted"><span>{text.length.toLocaleString('zh-CN')} / {LIMITS.ocrTextChars.toLocaleString('zh-CN')} 字符</span><span>{text !== result.text ? '已手动校对' : '待你核对'}</span></div>{result.import.warnings.map(warning => <p key={warning} className="ocr-warning">{warning}</p>)}</>}
      <p className="ocr-privacy">{storageMode === 'browser' ? '确认后，原图与校对文字保存在当前设备的资料库。' : '确认后，原图与校对文字保存到当前学习资料库。'}提交学习时才会使用这些文字。</p>
    </div></div>
    <div className="ocr-dialog-footer"><button type="button" className="button subtle" disabled={phase === 'saving'} onClick={() => void close()}>{phase === 'recognizing' ? '取消等待' : '取消导入'}</button><div>{phase !== 'recognizing' && <button type="button" className="button" disabled={phase === 'saving'} onClick={async () => {
      if (result && text !== result.text && !await confirm({ title: '重新识别图片', message: '重新识别会替换当前未保存的校对文字。', confirmLabel: '重新识别' })) return;
      setResult(null); setText(''); setAttempt(value => value + 1);
    }}><RotateCcw size={15} />{phase === 'error' ? '重试识别' : '重新识别'}</button>}<button type="button" className="button primary" disabled={phase !== 'ready' || !text.trim()} onClick={() => void save()}>{phase === 'saving' ? <LoaderCircle size={15} className="spin" /> : <FileCheck2 size={15} />}确认导入图片资料</button></div></div>
  </ModalShell>;
}
