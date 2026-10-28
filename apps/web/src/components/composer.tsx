'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUp, LoaderCircle, Mic, Plus, Square } from 'lucide-react';
import { useApp } from './store';
import { useComposer } from './composer-context';
import { learningModules, matchModules } from './module-menu';

type Speech = { lang: string; continuous: boolean; interimResults: boolean; start: () => void; stop: () => void; onresult: ((event: { results: { transcript: string }[][] }) => void) | null; onerror: (() => void) | null; onend: (() => void) | null };

export function Composer({ home = false, navigate }: { home?: boolean; navigate: (href: string) => void }) {
  const { state, busy, setError } = useApp();
  const { send, pending, recovery, clearRecovery, text: value, setText: setValue } = useComposer();
  const [dismissed, setDismissed] = useState(false);
  const [selected, setSelected] = useState(0);
  const [decoration, setDecoration] = useState('lark');
  const [pageHidden, setPageHidden] = useState(false);
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [listening, setListening] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const speech = useRef<Speech | null>(null);
  const slash = value.startsWith('/');
  const modules = learningModules(state);
  const intent = !slash && value.trim().length > 0 && value.trim().length <= 8 ? modules.find(item => item.href && (item.title === value.trim() || item.keywords.split(' ').some(keyword => value.trim().toLowerCase() === keyword.toLowerCase() || item.id !== 'recite' && keyword.length > 1 && value.trim().toLowerCase().includes(keyword.toLowerCase())))) : undefined;
  const suggestions = dismissed ? [] : slash ? matchModules(modules, value).filter(item => item.href) : intent ? [intent] : [];
  const locked = busy || pending;
  useEffect(() => {
    if (recovery && !recovery.file) { setValue(recovery.text); clearRecovery(); }
  }, [recovery, clearRecovery]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || (event.target instanceof HTMLElement && (event.target.matches('input,textarea,select') || event.target.isContentEditable)) || document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault(); setValue('/'); setDismissed(false); setSelected(0); textarea.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    const browser = window as unknown as { SpeechRecognition?: new () => Speech; webkitSpeechRecognition?: new () => Speech };
    setVoiceAvailable(Boolean(browser.SpeechRecognition || browser.webkitSpeechRecognition));
    return () => { document.removeEventListener('keydown', onKey); speech.current?.stop(); };
  }, []);
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let index = 0;
    const motion = () => { if (reduced.matches) { index = 0; setDecoration('lark'); } };
    const visibility = () => setPageHidden(document.hidden);
    visibility(); motion();
    reduced.addEventListener('change', motion); document.addEventListener('visibilitychange', visibility);
    const timer = setInterval(() => { if (!document.hidden && !reduced.matches) { index = (index + 1) % 4; setDecoration(['lark', 'plum', 'lark', 'orchid'][index]!); } }, 8000);
    return () => { clearInterval(timer); reduced.removeEventListener('change', motion); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  useEffect(() => { if (textarea.current) { textarea.current.style.height = 'auto'; textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 168)}px`; } }, [value]);
  async function submit() {
    if (locked || !value.trim()) return;
    if (suggestions.length) { const item = suggestions[Math.min(selected, suggestions.length - 1)]!; if (item.href) { navigate(item.href); setValue(''); } return; }
    if (slash && !dismissed) return;
    try { await send({ text: value, ...(value.length > 400 ? { attachment: true } : {}) }); setValue(''); setDismissed(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '输入未能保存，请重试。'); }
  }
  function toggleVoice() {
    if (listening) { speech.current?.stop(); return; }
    const browser = window as unknown as { SpeechRecognition?: new () => Speech; webkitSpeechRecognition?: new () => Speech };
    const Constructor = browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
    if (!Constructor) return;
    const recognition = new Constructor(); speech.current = recognition;
    recognition.lang = 'zh-CN'; recognition.continuous = false; recognition.interimResults = false;
    recognition.onresult = event => { const text = event.results[0]?.[0]?.transcript; if (text) setValue(current => current ? `${current} ${text}` : text); };
    recognition.onerror = () => { setListening(false); setError('语音输入未能开始，请检查浏览器的麦克风权限。'); };
    recognition.onend = () => setListening(false);
    try { recognition.start(); setListening(true); } catch { setListening(false); setError('浏览器暂时无法启动语音输入，请改用文字。'); }
  }
  return <div className={`composer-placement ${home ? 'composer-home' : 'composer-fixed'}`}><div className="composer-container">
    <div className="composer-perch" aria-hidden="true"><img key={decoration} src={`/design/${decoration}.svg`} alt="" width="56" height="42" style={{ animationPlayState: pageHidden ? 'paused' : 'running' }} /></div>
    {suggestions.length > 0 && <div className="composer-popover" id="composer-suggestions" role="listbox" aria-label={slash ? '切换模块' : '输入意图'}><div className="composer-popover-label"><span>{slash ? '切换模块' : '你是想打开'}</span><span>↑ ↓ 选择 · ↵ 打开 · Esc 继续复述</span></div>{suggestions.slice(0, 8).map((item, index) => <button type="button" key={item.id} id={`suggestion-${item.id}`} role="option" aria-selected={index === selected} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setSelected(index)} onClick={() => { if (item.href) { navigate(item.href); setValue(''); } }}><item.icon size={18} /><span><strong>{item.title}</strong><small>{item.description}</small></span><ArrowRight size={15} /></button>)}</div>}
    {slash && !dismissed && !suggestions.length && <div className="composer-popover"><p className="module-no-results">没有匹配的模块 · 按 Esc 作为复述输入</p></div>}
    <form className="composer-input" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <input className="sr-only" type="file" ref={file} tabIndex={-1} aria-label="输入框上传笔记" accept=".txt,.md,.markdown,.pdf,.png,.jpg,.jpeg,.webp" onChange={async event => {
        const selectedFile = event.target.files?.[0]; if (!selectedFile) return;
        try { await send({ text: '', file: selectedFile }); } catch (cause) { setError(cause instanceof Error ? cause.message : '上传失败，请重试。'); }
        event.target.value = '';
      }} />
      <button type="button" className="composer-icon" aria-label="上传笔记附件" title="上传笔记、PDF 或图片（OCR）" disabled={locked} onClick={() => file.current?.click()}><Plus size={23} strokeWidth={1.5} /></button>
      <textarea ref={textarea} rows={1} aria-label="学习输入" placeholder={home ? '今天学到了什么？试着用自己的话讲一遍…' : '继续写下你的理解，或输入 / 切换功能…'} value={value} disabled={pending} role="combobox" aria-expanded={suggestions.length > 0} aria-controls={suggestions.length ? 'composer-suggestions' : undefined} aria-autocomplete="list" aria-activedescendant={suggestions[selected] ? `suggestion-${suggestions[selected]!.id}` : undefined} onChange={event => { setValue(event.target.value); setSelected(0); setDismissed(false); }} onPaste={event => {
        const text = event.clipboardData.getData('text/plain');
        if (text.length <= 400 || locked) return;
        event.preventDefault();
        void send({ text, attachment: true }).catch(cause => { setValue(text); setError(cause instanceof Error ? cause.message : '笔记未能附加，请重试。'); });
      }} onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape') { setDismissed(true); return; }
        if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && suggestions.length) { event.preventDefault(); setSelected(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + Math.min(suggestions.length, 8)) % Math.min(suggestions.length, 8)); }
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); }
      }} />
      <button type="button" className={`composer-icon ${listening ? 'listening' : ''}`} aria-label={listening ? '停止语音输入' : '语音输入'} aria-pressed={listening} title={voiceAvailable ? '使用浏览器语音输入' : '当前浏览器不支持语音输入'} disabled={!voiceAvailable || locked} onClick={toggleVoice}>{listening ? <Square size={17} /> : <Mic size={19} strokeWidth={1.5} />}</button>
      <button type="submit" className="composer-send" aria-label="发送学习输入" disabled={locked || !value.trim()}>{pending ? <LoaderCircle size={19} className="spin" /> : <ArrowUp size={21} strokeWidth={1.7} />}</button>
    </form>
    {recovery?.file && <button type="button" className="composer-retry text-button" disabled={locked} onClick={async () => {
      try { await send(recovery); clearRecovery(); } catch (cause) { setError(cause instanceof Error ? cause.message : '附件未能保存，请重试。'); }
    }}>重试上传 · {recovery.file.name}</button>}
    <p className="composer-hint">{home ? <>直接复述，也可以问「今天复习什么」<span>·</span>输入 <kbd>/</kbd> 探索全部功能</> : <>输入交给当前模块<span>·</span><kbd>Shift ↵</kbd> 换行<span>·</span><kbd>/</kbd> 切换功能</>}</p>
  </div></div>;
}
