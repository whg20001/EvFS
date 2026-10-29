'use client';

import { Feedback } from './feedback';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ArrowUpRight, Command, LogOut, Moon, Search, ShieldCheck, Sun } from 'lucide-react';
import { useApp } from './store';
import { Action, Card } from './ui';
import { useConfirm } from './confirm';
import { Composer } from './composer';
import { HomePage } from './home';
import { learningModules, ModuleMenu } from './module-menu';
import { activityModuleSchema } from '@sanxing/contracts';
import { parseLearningRoute } from '../lib/routes';

const logoutPrompt = { title: '退出登录', message: '退出后将清除本地会话缓存。请先保存需要保留的输入。', confirmLabel: '退出' };
const leavePrompt = { title: '离开当前页面', message: '仍有未保存的输入。建议先保存草稿；确定离开当前页面？', confirmLabel: '仍然离开', cancelLabel: '留在此页', tone: 'danger' } as const;

function Login() {
  const { login, register, storageMode, registrationEnabled, busy } = useApp();
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [creating, setCreating] = useState(false);
  return <div className="login-page"><div className="login-decoration" aria-hidden="true"><div /><div /><div /></div><form className="login-card" onSubmit={async event => { event.preventDefault(); try { if (creating) await register(username, password); else await login(password, storageMode === 'browser' ? username : undefined); setPassword(''); } catch { /* Preserve input for a deliberate retry. */ } }}>
    <span className="brand-mark large">省</span><p className="eyebrow">A LITTLE REFLECTION, EVERY DAY</p><h1>欢迎回到，每日三省。</h1><p className="muted">这是只属于你的学习空间。<br />让今天的所学，成为明天的所得。</p>
    {storageMode === 'browser' && <><label className="field-label" htmlFor="username">用户名</label><input id="username" autoComplete="username" autoCapitalize="none" value={username} onChange={event => setUsername(event.target.value)} minLength={3} maxLength={32} pattern="[a-zA-Z0-9_.\-]+" required autoFocus placeholder="3–32 位字母、数字或 ._-" /></>}
    <label className="field-label" htmlFor="password">访问密码</label><input id="password" type="password" autoComplete={creating ? 'new-password' : 'current-password'} value={password} onChange={event => setPassword(event.target.value)} required minLength={storageMode === 'browser' ? 12 : undefined} autoFocus={storageMode !== 'browser'} placeholder={creating ? '至少 12 位密码' : '输入你的访问密码'} />
    <button className="button primary full" type="submit" disabled={busy || !password || (storageMode === 'browser' && !username)}>{busy ? '正在进入…' : creating ? '创建账号并进入' : '进入我的学习空间'}<ArrowUpRight size={18} /></button>
    {storageMode === 'browser' && registrationEnabled && <button className="text-button" type="button" disabled={busy} onClick={() => setCreating(value => !value)}>{creating ? '已有账号，去登录' : '首次使用，创建账号'}</button>}
    <p className="small muted privacy"><ShieldCheck size={14} />{storageMode === 'browser' ? '账号保存在云端 · 学习数据保存在此浏览器' : '单用户私密访问 · 不开放注册'}</p>
  </form></div>;
}

export function AppShell({ children }: { children: ReactNode }) {
  const { state, loading, authenticated, error, setError, reload, logout, user, storageMode, api } = useApp();
  const path = usePathname();
  const retainedContentPath = useRef('/recite');
  if (path !== '/login') retainedContentPath.current = path;
  const router = useRouter();
  const confirm = useConfirm();
  const [menu, setMenu] = useState(false);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const [atEnd, setAtEnd] = useState(false);
  const [dark, setDark] = useState(false);
  const [trail, setTrail] = useState<{ href: string; title: string }[]>([]);
  const trailUser = useRef(false);
  const home = path === '/';
  const canEdit = authenticated && path !== '/login';
  const modules = learningModules(state, user?.role === 'admin');
  useEffect(() => {
    if (!authenticated || storageMode !== 'browser' || path === '/login') return;
    const route = parseLearningRoute(path); const parsed = activityModuleSchema.safeParse(route.page);
    const module = parsed.success ? parsed.data : 'other';
    const controller = new AbortController();
    const send = () => { if (document.visibilityState === 'visible') void api('/activity/heartbeat', { method: 'POST', body: { module }, signal: controller.signal }).catch(() => undefined); };
    send(); const timer = setInterval(send, 45000); document.addEventListener('visibilitychange', send);
    return () => { clearInterval(timer); controller.abort(); document.removeEventListener('visibilitychange', send); };
  }, [authenticated, storageMode, path, api]);
  const routeTitle = parseLearningRoute(path).page === 'not-found' ? '' : modules.find(item => item.href === path)?.title
    ?? (path.startsWith('/sessions/') ? state?.sessions.find(item => path.includes(item.id))?.status === 'CONFIRMING' ? '确认知识点' : 'AI 追问'
      : path.startsWith('/recite/') ? '继续复述'
      : path.startsWith('/quizzes/') ? path.endsWith('/result') ? '测验结果' : '每日测验'
      : path.startsWith('/knowledge/') ? '知识点详情' : path.startsWith('/review-sessions/') ? '单项复习' : '');
  useEffect(() => {
    if (!authenticated) { trailUser.current = false; setTrail([]); return; }
    if (!trailUser.current) { trailUser.current = true; setTrail([]); }
    if (home || !routeTitle || path === '/login') return;
    setTrail(items => items.some(item => item.href === path && item.title === routeTitle) ? items : [...items.filter(item => item.href !== path), { href: path, title: routeTitle }].slice(-7));
  }, [authenticated, path, home, routeTitle]);
  useEffect(() => {
    const scroll = () => { setScrolled(window.scrollY > 4); setAtEnd(window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4); };
    scroll(); window.addEventListener('scroll', scroll, { passive: true }); window.addEventListener('resize', scroll);
    const observer = new ResizeObserver(scroll); observer.observe(document.body);
    return () => { window.removeEventListener('scroll', scroll); window.removeEventListener('resize', scroll); observer.disconnect(); };
  }, []);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    let preference: string | null = null;
    try { preference = localStorage.getItem('sanxing-theme'); } catch { /* System theme remains available without storage. */ }
    const apply = () => { const enabled = preference ? preference === 'dark' : media.matches; setDark(enabled); document.documentElement.dataset.theme = enabled ? 'dark' : 'light'; };
    apply(); media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, []);
  useEffect(() => {
    if (!canEdit) return;
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setOpener(document.activeElement as HTMLElement); setMenu(value => !value); }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [canEdit]);
  const leave = (go: () => void) => {
    if (!document.querySelector('[data-unsaved="true"]')) { go(); return; }
    void confirm(leavePrompt).then(ok => { if (ok) go(); });
  };
  const navigate = (href: string) => leave(() => router.push(href));
  function toggleTheme() {
    const next = !dark; setDark(next); document.documentElement.dataset.theme = next ? 'dark' : 'light';
    try { localStorage.setItem('sanxing-theme', next ? 'dark' : 'light'); } catch { /* Theme remains usable for this visit. */ }
  }
  if (loading) return <div className="boot"><span className="brand-mark large">省</span><h1>每日三省</h1><p className="muted">正在打开你的学习空间…</p></div>;
  return <>{!authenticated && <Login />}{authenticated && !canEdit && <div className="boot" role="status">正在返回学习空间…</div>}
    {error && <Feedback title={authenticated ? '操作未完成' : '登录提示'} tone="error" dedupeKey={error} onDismiss={() => setError(null)}><p>{error}</p>{authenticated && <Action variant="subtle" onClick={async () => { await reload(); setError(null); }}>刷新状态</Action>}</Feedback>}
    <div hidden={!canEdit} inert={!canEdit} className={`app-shell journal-shell ${home ? 'is-home' : 'is-module'} ${atEnd ? 'at-end' : ''}`} onClickCapture={event => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(link instanceof HTMLAnchorElement) || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target === '_blank' || link.hasAttribute('download') || !document.querySelector('[data-unsaved="true"]')) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin === window.location.origin && url.pathname === window.location.pathname && url.search === window.location.search && url.hash) return;
      event.preventDefault(); event.stopPropagation();
      leave(() => { if (url.origin === window.location.origin) router.push(url.pathname + url.search + url.hash); else window.location.assign(url.href); });
    }}>
      <a className="skip-link" href="#main-content">跳至主要内容</a>
      <header className={`journal-topbar ${scrolled ? 'scrolled' : ''}`}><Link href="/" className="journal-brand" aria-label="每日三省首页"><span className="brand-mark">省</span><span className="text-brand">每日三省</span></Link>
        <nav className="journal-trail" aria-label="今日轨迹"><span className="trail-label">今日轨迹</span>{trail.map(item => <Link href={item.href} key={item.href} aria-current={item.href === path ? 'page' : undefined}>{item.title}</Link>)}</nav>
        <div className="journal-tools"><button type="button" className="module-trigger" aria-label="全部模块" title="全部模块" onClick={event => { setOpener(event.currentTarget); setMenu(true); }}><Search size={16} strokeWidth={1.6} /><span>全部模块</span><kbd><Command size={11} /> K</kbd></button><span className="tool-divider" /><button type="button" className="quiet-icon" aria-label={dark ? '切换浅色模式' : '切换深色模式'} title={dark ? '切换浅色模式' : '切换深色模式'} onClick={toggleTheme}>{dark ? <Sun size={17} /> : <Moon size={17} />}</button><button type="button" className="quiet-icon logout-trigger" aria-label="退出登录" title="退出登录" onClick={() => { void (async () => { if (await confirm(logoutPrompt)) await logout(); })(); }}><LogOut size={16} /></button></div>
      </header>
      {state?.mode === 'mock' && <div className="journal-demo" role="status"><span className="status-dot amber">演示模式 · 脚本化回答，不代表真实学习评价</span></div>}
      <main id="main-content" className={`journal-stage ${home ? 'journal-home-stage' : ''} ${path === '/ai-access' ? 'journal-settings-stage' : ''} ${path === '/admin' ? 'journal-admin-stage' : ''}`} aria-label={home ? '今日三省' : routeTitle || '学习页面'}>{state ? home ? <HomePage input={<Composer home navigate={navigate} />} /> : <div key={retainedContentPath.current} className="module-enter">{children}</div> : <Card title="还没能连接学习空间"><p className="muted">请确认 API 服务正在运行，然后重试。</p><Action onClick={reload}>重新连接</Action></Card>}</main>
      <footer className="journal-footer" aria-hidden="true" />
    </div>
    {menu && canEdit && <ModuleMenu opener={opener} close={() => setMenu(false)} navigate={navigate} />}
  </>;
}
