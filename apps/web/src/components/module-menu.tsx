'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpRight, BookOpen, CalendarDays, CheckCheck, Command, Feather, FilePenLine, History, KeyRound, Layers3, MessageCircle, Search, X } from 'lucide-react';
import type { PublicState } from '@sanxing/contracts';
import { ModalShell } from './modal';
import { useApp } from './store';

export function learningModules(state: PublicState | null, admin = false) {
  const sessions = state?.sessions ?? [];
  const confirming = sessions.findLast(item => item.status === 'CONFIRMING');
  const asking = sessions.findLast(item => item.status === 'CLARIFYING');
  const quiz = state?.quizzes.findLast(item => !item.submittedAt);
  const result = state?.quizzes.findLast(item => item.submittedAt);
  return [
    { id: 'recite', href: '/recite', title: '今日复述', description: '用自己的话，留下今天的所学', keywords: '复述 今天 学习 记录', group: '每日流程', icon: Feather },
    { id: 'drafts', href: '/drafts', title: '草稿箱', description: '继续编辑未提交的复述，跨天保留', keywords: '草稿 draft 未提交 未发出 继续 编辑', group: '每日流程', icon: FilePenLine },
    { id: 'confirm', href: confirming ? `/sessions/${confirming.id}/ask` : null, title: '确认知识点', description: confirming ? '核对 AI 整理的知识范围' : '提交今日复述后开启', keywords: '确认 知识点 整理', group: '每日流程', icon: CheckCheck },
    { id: 'ask', href: asking ? `/sessions/${asking.id}/ask` : null, title: 'AI 追问', description: asking ? '把说不清楚的地方，慢慢讲清楚' : '确认知识范围后开启', keywords: '追问 提问 问答', group: '每日流程', icon: MessageCircle },
    { id: 'quiz', href: quiz ? `/quizzes/${quiz.id}` : null, title: '每日测验', description: quiz ? '合上笔记，检验这一次的理解' : '完成追问后准备测验', keywords: '测验 考试 做题', group: '每日流程', icon: BookOpen },
    { id: 'result', href: result ? `/quizzes/${result.id}/result` : null, title: '测验结果', description: result ? '回看作答与评价依据' : '完成一次测验后开启', keywords: '结果 分数 成绩', group: '每日流程', icon: CheckCheck },
    { id: 'review', href: '/review', title: '复习计划', description: '在遗忘之前，再次遇见', keywords: '复习 到期 计划 遗忘 曲线', group: '复习', icon: CalendarDays },
    { id: 'weak', href: '/weak', title: '薄弱知识点', description: '从需要巩固的地方开始', keywords: '薄弱 弱项 失分', group: '复习', icon: Layers3 },
    { id: 'week', href: '/week', title: '本周复盘', description: '回头看看，这一周走过的路', keywords: '复盘 本周 周报 统计', group: '复盘', icon: History },
    { id: 'knowledge', href: '/knowledge', title: '我的知识库', description: '连接每一次理解与学习证据', keywords: '知识库 知识 查找 搜索', group: '复盘', icon: Layers3 },
    { id: 'history', href: '/history', title: '学习足迹', description: '回到每一次复述、追问与测验', keywords: '历史 足迹 记录', group: '复盘', icon: History },
    { id: 'library', href: '/library', title: '本地资料库', description: '找回资料与旧知识', keywords: '资料 笔记 文件', group: '工具', icon: Search },
    { id: 'ai-access', href: '/ai-access', title: 'AI 配置', description: '模型、学习设置与用量', keywords: '设置 配置 模型 AI', group: '工具', icon: KeyRound },
    { id: 'local-data', href: '/local-data', title: '本地数据与备份', description: '导出、导入与迁移学习数据', keywords: '数据 备份 导出 导入 本地 存储', group: '工具', icon: Layers3 },
    ...(admin ? [{ id: 'admin', href: '/admin', title: '管理后台', description: '用户、活动、服务器与平台 AI', keywords: '后台 管理 用户 服务器 平台 AI', group: '工具', icon: Layers3 }] : []),
  ];
}
export type LearningModule = ReturnType<typeof learningModules>[number];
export function matchModules(modules: LearningModule[], query: string) {
  const term = query.replace(/^\//, '').trim().toLowerCase();
  return modules.filter(item => !term || `${item.title} ${item.keywords}`.toLowerCase().includes(term));
}

export function ModuleMenu({ opener, close, navigate }: { opener: HTMLElement | null; close: () => void; navigate: (href: string) => void }) {
  const { state, user } = useApp();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const results = matchModules(learningModules(state, user?.role === 'admin'), query);
  const available = results.filter(item => item.href);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const pane = list.current;
    const active = pane?.querySelector('[data-selected="true"]');
    if (!pane || !active) return;
    // Scroll only the results pane; scrollIntoView can also move the page behind the dialog.
    const bounds = pane.getBoundingClientRect();
    const item = active.getBoundingClientRect();
    if (item.top < bounds.top) pane.scrollTop += item.top - bounds.top;
    else if (item.bottom > bounds.bottom) pane.scrollTop += item.bottom - bounds.bottom;
  }, [selected]);
  return <ModalShell close={close} opener={opener} initialFocus="input" className="module-dialog" backdropClass="module-scrim" labelledBy="module-menu-title">
    <div className="module-search"><Search size={19} /><label className="sr-only" htmlFor="module-query">搜索模块</label><input id="module-query" placeholder="想去哪里？搜索模块…" value={query} onChange={event => { setQuery(event.target.value); setSelected(0); }} onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSelected(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + available.length) % Math.max(available.length, 1)); }
      if (event.key === 'Enter') { event.preventDefault(); const href = available[selected]?.href; if (href) { close(); navigate(href); } }
    }} /><button type="button" className="quiet-icon" aria-label="关闭全部模块" onClick={close}><X size={18} /></button></div>
    <h2 id="module-menu-title" className="sr-only">全部模块</h2>
    <div className="module-results" ref={list}>{['每日流程', '复习', '复盘', '工具'].map(group => {
      const items = results.filter(item => item.group === group);
      return items.length ? <section key={group}><h3>{group}</h3>{items.map(item => <button type="button" className="module-item" key={item.id} disabled={!item.href} data-selected={available[selected]?.id === item.id} onMouseEnter={() => { const index = available.findIndex(entry => entry.id === item.id); if (index >= 0) setSelected(index); }} onClick={() => { if (item.href) { close(); navigate(item.href); } }}><item.icon size={19} strokeWidth={1.6} /><span><strong>{item.title}</strong><small>{item.description}</small></span>{item.href && <ArrowUpRight size={15} />}</button>)}</section> : null;
    })}{!results.length && <p className="module-no-results">没有找到这个模块，试试「复习」或「复盘」。</p>}</div>
    <div className="module-keyboard"><span><ArrowUp size={12} /><ArrowDown size={12} /> 选择 <kbd>↵</kbd> 打开</span><span><Command size={12} /> K 随时唤起</span></div>
  </ModalShell>;
}
