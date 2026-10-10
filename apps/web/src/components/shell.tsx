'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ArrowUpRight, BookOpen, CalendarDays, ChevronRight, Feather, History, KeyRound, Layers3, LogOut, Search, ShieldCheck, Sparkles } from 'lucide-react';
import { useApp, dateLabel } from './store';
import { Action, Badge, Card, Go } from './ui';
import { useConfirm } from './confirm';
import aiAccessStyles from '../features/ai-access/ai-access.module.css';

const navigation = [
  { href: '/recite', title: '今日复述', icon: Feather, sub: '从回忆开始' },
  { href: '/review', title: '复习计划', icon: CalendarDays, sub: '让记忆更长久' },
  { href: '/knowledge', title: '我的知识库', icon: Layers3, sub: '连接每一次理解' },
  { href: '/history', title: '学习足迹', icon: History, sub: '看见自己的积累' },
  { href: '/library', title: '本地资料库', icon: Search, sub: '找回资料与旧知识' },
  { href: '/ai-access', title: 'AI 配置', icon: KeyRound, sub: '模型选择、OAuth 与用量' },
];

const logoutPrompt = { title: '退出登录', message: '退出后将清除本地会话缓存。请先保存需要保留的输入。', confirmLabel: '退出' };
const leavePrompt = { title: '离开当前页面', message: '仍有未保存的输入。建议先保存草稿；确定离开当前页面？', confirmLabel: '仍然离开', cancelLabel: '留在此页', tone: 'danger' } as const;

function Login() {
  const { login, error, busy } = useApp();
  const [password, setPassword] = useState('');
  return <div className="login-page"><div className="login-decoration" aria-hidden="true"><div /><div /><div /></div><form className="login-card" onSubmit={async event => { event.preventDefault(); try { await login(password); setPassword(''); } catch { /* Preserve password for a deliberate retry. */ } }}>
    <span className="brand-mark large">省</span><p className="eyebrow">A LITTLE REFLECTION, EVERY DAY</p><h1>欢迎回到，每日三省。</h1><p className="muted">这是只属于你的学习空间。<br />让今天的所学，成为明天的所得。</p>
    <label className="field-label" htmlFor="password">访问密码</label><input id="password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required autoFocus placeholder="输入你的访问密码" />
    {error && <p role="alert" className="danger-text">{error}</p>}<button className="button primary full" type="submit" disabled={busy || !password}>{busy ? '正在进入…' : '进入我的学习空间'}<ArrowUpRight size={18} /></button>
    <p className="small muted privacy"><ShieldCheck size={14} />单用户私密访问 · 不开放注册</p>
  </form></div>;
}

export function AppShell({ children }: { children: ReactNode }) {
  const { state, loading, authenticated, error, setError, reload, logout } = useApp();
  const path = usePathname();
  const router = useRouter();
  const confirm = useConfirm();
  const [search, setSearch] = useState('');
  const due = state?.cards.filter(card => new Date(card.schedule.due).getTime() <= Date.now()) ?? [];
  const canEdit = authenticated && path !== '/login';
  const confirmLogout = async () => { if (await confirm(logoutPrompt)) await logout(); };
  // In-app navigation away from unsaved input waits for the dialog, then replays.
  const leave = (go: () => void) => {
    if (!document.querySelector('[data-unsaved="true"]')) { go(); return; }
    void confirm(leavePrompt).then(ok => { if (ok) go(); });
  };
  if (loading) return <div className="boot"><span className="brand-mark large">省</span><h1>每日三省</h1><p className="muted">正在打开你的学习空间…</p></div>;
  // Authentication can finish before the return navigation commits. Retain the
  // editor, but never let input target a page which that navigation will replace.
  return <>{!authenticated && <Login />}{authenticated && !canEdit && <div className="boot" role="status">正在返回学习空间…</div>}<div hidden={!canEdit} inert={!canEdit} className="app-shell" onClickCapture={event => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    // New tabs, downloads and in-page anchors keep this page's input; let the browser handle them.
    if (!(link instanceof HTMLAnchorElement) || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
      || link.target === '_blank' || link.hasAttribute('download') || !document.querySelector('[data-unsaved="true"]')) return;
    const url = new URL(link.href, window.location.href);
    if (url.origin === window.location.origin && url.pathname === window.location.pathname && url.search === window.location.search && url.hash) return;
    event.preventDefault(); event.stopPropagation();
    leave(() => { if (url.origin === window.location.origin) router.push(url.pathname + url.search + url.hash); else window.location.assign(url.href); });
  }}>
    <a className="skip-link" href="#main-content">跳至主要内容</a>
    <aside className="sidebar"><Link href="/recite" className="brand"><span className="brand-mark">省</span><div><strong>每日三省</strong><span>吾日三省吾身</span></div></Link>
      <div className="nav-caption">我的学习空间</div><nav aria-label="主导航" className={aiAccessStyles.navigation}>{navigation.map(item => {
        const selected = item.href === '/recite' ? path === '/' || path.startsWith('/recite') || path.startsWith('/sessions') || path.startsWith('/quizzes') : path.startsWith(item.href);
        return <Link key={item.href} href={item.href} className={`nav-item ${selected ? 'active' : ''}`} aria-current={selected ? 'page' : undefined}><item.icon size={20} strokeWidth={1.7} /><span>{item.title}</span>{item.href === '/review' && due.length > 0 && <span className="nav-count">{due.length}</span>}</Link>;
      })}</nav>
      <div className="sidebar-bottom"><div className="quiet-note"><Sparkles size={21} /><p>不急于记住一切，<br />只让每一天有所沉淀。</p><span>日拱一卒，功不唐捐。</span></div><div className="profile"><span className="avatar">我</span><div><strong>我的学习空间</strong><span>保持好奇，慢慢生长</span></div><Action variant="icon-button" title="退出登录" onClick={confirmLogout}><LogOut size={17} /><span className="sr-only">退出登录</span></Action></div></div>
    </aside>
    <div className="workspace"><header className="topbar"><div className="breadcrumb"><BookOpen size={16} /><span>学习空间</span><ChevronRight size={14} /><strong>{navigation.find(item => path.startsWith(item.href))?.title ?? '学习进行中'}</strong></div><form className="search" role="search" onSubmit={event => { event.preventDefault(); leave(() => router.push(`/knowledge?q=${encodeURIComponent(search)}`)); }}><Search size={16} /><input aria-label="搜索知识点" placeholder="搜索你的知识…" value={search} onChange={event => setSearch(event.target.value)} /><button aria-label="搜索" type="submit"><ArrowUpRight size={15} /></button></form><span className="top-date">{state ? dateLabel(new Date().toISOString(), state.timezone) : ''}</span><span className="mobile-logout"><Action variant="icon-button" title="退出登录" onClick={confirmLogout}><LogOut size={16} /><span className="sr-only">退出登录</span></Action></span></header>
      {state?.mode === 'mock' && <div className="demo-banner" role="status"><ShieldCheck size={16} /><strong>演示模式 · 脚本化回答，不代表真实学习评价</strong><span>仅用于验证学习流程</span></div>}
      {error && <div className="error-banner" role="alert"><span>{error}</span><div><Action variant="subtle" onClick={async () => { await reload(); setError(null); }}>刷新状态</Action><button className="text-button" onClick={() => setError(null)}>收起</button></div></div>}
      <div className="content-layout"><main id="main-content" className="main-content">{state ? children : <Card title="还没能连接学习空间"><p className="muted">请确认 API 服务正在运行，然后重试。不会创建任何模拟学习记录。</p><Action onClick={reload}>重新连接</Action></Card>}</main>{state && <aside className="overview" aria-label="学习概览">
        <Card className="today-card"><div className="section-title"><span className="icon-tile"><CalendarDays size={19} /></span><h2>记忆，值得再见</h2></div><div className="big-stat"><strong>{due.length}</strong><span>个知识点等待复习</span></div><p className="muted small">先试着回忆，再翻开答案。<br />每一次提取，都让理解更扎实。</p>{due.slice(0, 3).map(card => <Link key={card.id} href={`/knowledge/${card.knowledgeId}`} className="due-item"><span className="dot" /><span>{state.knowledge.find(point => point.id === card.knowledgeId)?.title ?? '知识点'}</span><ChevronRight size={14} /></Link>)}<Go href="/review">{due.length ? '查看今日复习' : '查看复习计划'}</Go></Card>
        <Card title="让学习形成一个小闭环"><ol className="journey"><li><span>01</span><div><strong>用自己的话复述</strong><p>不照抄笔记，先找回记忆</p></div></li><li><span>02</span><div><strong>确认与追问</strong><p>让模糊的地方，逐渐清楚</p></div></li><li><span>03</span><div><strong>独立检验，再次回忆</strong><p>让理解留下可核对的证据</p></div></li></ol></Card>
        <Card className="evidence-card"><div className="section-title"><ShieldCheck size={18} /><h2>真实的积累</h2></div><div className="overview-stat"><span>知识点</span><strong>{state.knowledge.length}<small> 个</small></strong></div><div className="overview-stat"><span>已提交测验</span><strong>{state.quizzes.filter(quiz => quiz.submittedAt).length}<small> 次</small></strong></div><div className="overview-stat"><span>复习记录</span><strong>{state.reviewEvents.length}<small> 次</small></strong></div><p className="small muted">没有足够证据时，掌握情况显示为 <Badge>待评估</Badge>，而不是一个猜测的百分比。</p></Card>
        <p className="aside-footer">复述是起点，理解是过程。<br />今天，也向前一点。</p>
      </aside>}</div><footer className="page-footer"><span>每日三省 · 把所学变成所得</span><span>独立回忆 / 有据评价 / 长期积累</span></footer>
    </div>
  </div></>;
}
