'use client';

import { Feedback } from '../../components/feedback';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Activity, ArrowUpRight, Check, Cpu, RefreshCw, Search, ShieldCheck, Users, WandSparkles, X } from 'lucide-react';
import type { AdminActivities, AdminActivity, AdminOverview, AdminUser, AdminUsers, PlatformAiSettings, PlatformAiView, ServerMetrics } from '@sanxing/contracts';
import { useApp } from '../../components/store';
import { Empty, Go } from '../../components/ui';
import { ModalShell } from '../../components/modal';
import { useBeforeUnload, useConfirm } from '../../components/confirm';
import { errorMessage } from '../../lib/api-client';
import styles from './admin.module.css';

const number = (value: number) => new Intl.NumberFormat('zh-CN').format(value);
const date = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '尚无记录';
const bytes = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : `${(value / 1024 ** 2).toFixed(0)} MB`;
const modules: Record<string, string> = { home: '首页', recite: '今日复述', recitation: '继续复述', drafts: '草稿箱', session: '学习对话', quiz: '测验', review: '每日复习', knowledge: '知识库', history: '学习足迹', library: '本地资料库', 'ai-access': 'AI 配置', 'local-data': '本地数据', week: '本周复盘', weak: '薄弱点', admin: '管理后台', other: '其他页面' };
const events: Record<string, string> = { login: '登录了学习空间', register: '注册了账号', logout: '退出了登录', page_view: '访问了' };
const audits: Record<string, string> = { bootstrap_admin: '绑定首个管理员', create_user: '创建用户', update_user: '更新用户权限', reset_password: '重置密码与权限', configure_platform_ai: '更新平台 AI 配置' };

function useResource<T>(path: string, interval = 0) {
  const { api } = useApp(); const [data, setData] = useState<T | null>(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(true); const [key, setKey] = useState(0);
  const reload = useCallback(() => setKey(value => value + 1), []);
  useEffect(() => {
    let stopped = false; let pending = false; const controller = new AbortController();
    const load = async () => {
      if (pending || stopped) return; pending = true; setLoading(true);
      try { const next = await api<T>(path, { signal: controller.signal }); if (!stopped) { setData(next); setError(''); } }
      catch (cause) { if (!stopped) setError(errorMessage(cause, '读取失败，请稍后重试。')); }
      finally { pending = false; if (!stopped) setLoading(false); }
    };
    void load(); const timer = interval ? setInterval(() => { if (document.visibilityState === 'visible') void load(); }, interval) : null;
    return () => { stopped = true; controller.abort(); if (timer) clearInterval(timer); };
  }, [api, path, key, interval]);
  return { data, error, loading, reload };
}
function Notice({ error, loading, retry }: { error: string; loading: boolean; retry: () => void }) {
  return error ? <Feedback title="操作提示" tone="error" className={styles.error}>{error} <button type="button" className="text-button" onClick={retry}>重试</button></Feedback> : loading ? <p role="status" className={styles.loading}>正在更新…</p> : null;
}
function Panel({ title, eyebrow, children, aside }: { title: string; eyebrow?: string; children: ReactNode; aside?: ReactNode }) {
  return <section className={styles.panel}><div className={styles.panelHead}><div>{eyebrow && <span className={styles.eyebrow}>{eyebrow}</span>}<h2>{title}</h2></div>{aside}</div>{children}</section>;
}
function Stat({ title, value, note, accent }: { title: string; value: string; note: string; accent?: boolean }) {
  return <div className={`${styles.stat} ${accent ? styles.accent : ''}`}><span>{title}</span><strong>{value}</strong><small>{note}</small></div>;
}
function ActivityList({ items }: { items: AdminActivity[] }) {
  return items.length ? <ol className={styles.activity}>{items.map(item => <li key={item.id}><span className={styles.eventDot} /><div><strong>{item.username}</strong> <span>{events[item.type] ?? item.type}{item.module ? ` ${modules[item.module] ?? item.module}` : ''}</span><time dateTime={item.createdAt}>{date(item.createdAt)}</time></div></li>)}</ol> : <p className={styles.empty}>还没有云端活动记录。</p>;
}
const tabs = [{ id: 'overview', label: '运行总览', icon: Activity }, { id: 'users', label: '用户管理', icon: Users }, { id: 'activity', label: '活动记录', icon: ShieldCheck }, { id: 'server', label: '服务器', icon: Cpu }, { id: 'ai', label: '平台 AI', icon: WandSparkles }] as const;
type Tab = typeof tabs[number]['id'];

export function AdminPage() {
  const { user, storageMode } = useApp();
  if (storageMode !== 'browser' || user?.role !== 'admin') return <Empty title="此页面仅对管理员开放" action={<Go href="/">回到学习空间</Go>}>请使用已绑定管理权限的账号登录。</Empty>;
  return <AdminWorkspace />;
}
function AdminWorkspace() {
  const { user } = useApp(); const [tab, setTab] = useState<Tab>('overview'); const confirm = useConfirm();
  const select = async (next: Tab) => {
    if (next === tab) return;
    if (document.querySelector('[data-unsaved="true"]') && !await confirm({ title: '离开当前设置', message: '当前输入尚未保存，离开将丢弃这些输入。', confirmLabel: '离开', tone: 'danger' })) return;
    setTab(next);
  };
  return <div className={styles.admin}>
    <div className={styles.intro}><div><p className={styles.eyebrow}>SANXING · ADMINISTRATION</p><h1>管理后台<span className={styles.seal}>省</span></h1><p className={styles.description}>照看每一次连接，让学习安静发生。</p></div><div className={styles.identity}><ShieldCheck size={16} /><span>{user?.username}<small>管理员</small></span></div></div>
    <nav className={styles.tabs} aria-label="后台模块">{tabs.map(item => <button type="button" key={item.id} aria-current={tab === item.id ? 'page' : undefined} onClick={() => void select(item.id)}><item.icon size={16} strokeWidth={1.5} />{item.label}</button>)}</nav>
    <div className={styles.content} key={tab}>{tab === 'overview' ? <Overview onUsers={() => void select('users')} /> : tab === 'users' ? <UserManagement /> : tab === 'activity' ? <ActivityLog /> : tab === 'server' ? <ServerMonitor /> : <PlatformSettings />}</div>
    <p className={styles.footnote}>云端仅展示账号与使用元数据。复述、笔记、知识库及学习进度保留在用户设备。</p>
  </div>;
}
function Overview({ onUsers }: { onUsers: () => void }) {
  const resource = useResource<AdminOverview>('/admin/overview', 15000); const data = resource.data;
  const maxCalls = Math.max(1, ...data?.series.map(day => day.calls) ?? []);
  return <><div className={styles.sectionLine}><span className={styles.live}>每 15 秒更新 · {data?.timezone ?? '服务器时区'}</span><button type="button" className={styles.refresh} disabled={resource.loading} onClick={resource.reload}><RefreshCw size={14} />刷新</button></div><Notice {...resource} retry={resource.reload} />
    {data && <><div className={styles.stats}><Stat title="用户总数" value={number(data.users)} note={`今日新增 ${data.registrationsToday} · 停用 ${data.disabledUsers}`} /><Stat title="当前在线" value={number(data.onlineUsers)} note={`今日活跃 ${data.activeToday} 人`} accent /><Stat title="今日 AI 调用" value={number(data.callsToday)} note={`平台 ${data.platformCallsToday} · 执行中 ${data.runningCalls}`} /><Stat title="今日失败调用" value={number(data.failedToday)} note={data.mode === 'mock' ? '当前为演示模式' : '包括中断与超时'} /></div>
    <div className={styles.overviewGrid}><Panel title="近两周的连接" eyebrow="ACTIVITY / 14 DAYS" aside={<span className={styles.legend}><i />AI 调用次数</span>}><div className={styles.chart} role="img" aria-label={`近14日 AI 调用共${data.series.reduce((sum, day) => sum + day.calls, 0)}次`}>{data.series.map(day => <div className={styles.barColumn} key={day.date}><span className={styles.barValue}>{day.calls || ''}</span><div className={styles.barTrack}><div className={styles.bar} style={{ height: `${day.calls / maxCalls * 100}%` }} title={`${day.date}：调用 ${day.calls} 次，失败 ${day.failed} 次，活跃 ${day.activeUsers} 人`} /></div><span>{day.date.slice(5).replace('-', '.')}</span></div>)}</div><div className={styles.chartFooter}><span>每日调用记录 · {data.timezone}</span><span>失败 {data.series.reduce((sum, day) => sum + day.failed, 0)} 次</span></div></Panel>
    <Panel title="最近的足迹" eyebrow="RECENT ACTIVITY" aside={<button type="button" className={styles.textLink} onClick={onUsers}>管理用户<ArrowUpRight size={13} /></button>}><ActivityList items={data.recent} /></Panel></div>
    <Panel title="今日 AI 用量" eyebrow="TOKEN ACCOUNTING"><div className={styles.usageGrid}><div><small>输入 Token</small><strong>{number(data.inputTokens)}</strong></div><div><small>输出 Token</small><strong>{number(data.outputTokens)}</strong></div><div><small>已知费用 / USD</small><strong>${data.costUsd.toFixed(4)}</strong></div><p>用量已回报 {data.knownUsageCalls} / {data.callsToday} 次<br />费用已回报 {data.knownCostCalls} / {data.callsToday} 次<br />未回报部分不计入已知合计</p></div></Panel></>}
  </>;
}
function Pagination({ page, total, size, change }: { page: number; total: number; size: number; change: (page: number) => void }) {
  return <div className={styles.pagination}><span>共 {number(total)} 条 · 第 {page} / {Math.max(1, Math.ceil(total / size))} 页</span><div><button type="button" className="button subtle" disabled={page <= 1} onClick={() => change(page - 1)}>上一页</button><button type="button" className="button subtle" disabled={page * size >= total} onClick={() => change(page + 1)}>下一页</button></div></div>;
}
function UserManagement() {
  const [search, setSearch] = useState(''); const [query, setQuery] = useState(''); const [status, setStatus] = useState(''); const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<AdminUser | 'new' | null>(null); const [opener, setOpener] = useState<HTMLElement | null>(null); const [message, setMessage] = useState('');
  const resource = useResource<AdminUsers>(`/admin/users?search=${encodeURIComponent(query)}&status=${status}&page=${page}`);
  return <><Panel title="用户管理" eyebrow="PEOPLE" aside={<button type="button" className="button primary" onClick={event => { setOpener(event.currentTarget); setEditing('new'); }}>创建用户</button>}>
    <form className={styles.filters} onSubmit={event => { event.preventDefault(); setQuery(search.trim().toLowerCase()); setPage(1); }}><div className={styles.search}><Search size={16} /><input aria-label="搜索用户名" placeholder="搜索用户名…" value={search} maxLength={32} onChange={event => setSearch(event.target.value)} /></div><select aria-label="账号状态筛选" value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><option value="">全部状态</option><option value="active">已启用</option><option value="disabled">已停用</option></select><button type="submit" className="button subtle">搜索</button><button type="button" className={styles.refresh} aria-label="刷新用户" onClick={resource.reload}><RefreshCw size={15} /></button></form>
    {message && <Feedback onDismiss={() => setMessage('')} title="操作提示" tone="success" className={styles.success}><Check size={15} />{message}</Feedback>}<Notice {...resource} retry={resource.reload} />
    {resource.data && <><div className={styles.tableWrap} tabIndex={0} role="region" aria-label="用户列表"><table><thead><tr><th>用户</th><th>状态</th><th>最近活动</th><th>今日调用</th><th>平台 AI</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{resource.data.items.map(user => <tr key={user.id}><td><div className={styles.person}><span className={styles.avatar}>{user.username[0]?.toUpperCase()}</span><span><strong>{user.username}</strong><small>{user.role === 'admin' ? '管理员' : '用户'} · {date(user.createdAt)} 注册</small></span></div></td><td><span className={`${styles.badge} ${user.status === 'disabled' ? styles.disabled : user.online ? styles.online : ''}`}>{user.status === 'disabled' ? '已停用' : user.online ? '在线' : '已启用'}</span></td><td>{date(user.lastActiveAt)}<small>{user.lastModule ? modules[user.lastModule] ?? user.lastModule : '—'}</small></td><td className={styles.mono}>{user.callsToday}<small>上限 {user.dailyLimit ?? '服务默认'}</small></td><td>{user.platformAccess ? '已开通' : '未开通'}</td><td><button type="button" className={styles.textLink} aria-label={`管理 ${user.username}`} onClick={event => { setOpener(event.currentTarget); setEditing(user); }}>管理<ArrowUpRight size={13} /></button></td></tr>)}</tbody></table>{!resource.data.items.length && <p className={styles.empty}>没有符合条件的用户。</p>}</div><Pagination page={page} total={resource.data.total} size={resource.data.pageSize} change={setPage} /></>}
    <p className={styles.hint}>在线指最近 2 分钟内有前台页面心跳。停用、改权或重置密码后，该用户所有登录会话立即失效。</p>
  </Panel>{editing && <UserDialog user={editing} opener={opener} close={() => setEditing(null)} saved={() => { setEditing(null); setMessage('用户已保存。'); resource.reload(); }} />}</>;
}
function UserDialog({ user, opener, close, saved }: { user: AdminUser | 'new'; opener: HTMLElement | null; close: () => void; saved: () => void }) {
  const { api, user: currentUser } = useApp(); const confirm = useConfirm(); const existing = user === 'new' ? null : user;
  const [username, setUsername] = useState(''); const [password, setPassword] = useState(''); const [role, setRole] = useState(existing?.role ?? 'user'); const [status, setStatus] = useState(existing?.status ?? 'active'); const [limit, setLimit] = useState(existing?.dailyLimit?.toString() ?? ''); const [platformAccess, setPlatformAccess] = useState(existing?.platformAccess ?? true);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [dirty, setDirty] = useState(false); const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []); useBeforeUnload(() => dirty);
  const dismiss = async () => { if (busy) return; if (!dirty || await confirm({ title: '关闭用户设置', message: '尚未保存的输入将丢弃。', confirmLabel: '关闭', tone: 'danger' })) close(); };
  const save = async () => {
    setBusy(true); setError('');
    try {
      if (existing) await api(`/admin/users/${existing.id}`, { method: 'PATCH', body: { role, status, dailyLimit: limit ? Number(limit) : null, platformAccess, expectedVersion: existing.version, ...(password ? { newPassword: password } : {}) } });
      else await api('/admin/users', { method: 'POST', body: { username, password } });
      if (alive.current) { setPassword(''); saved(); }
    } catch (cause) { if (alive.current) setError(errorMessage(cause, '保存失败，请重试。')); }
    finally { if (alive.current) setBusy(false); }
  };
  return <ModalShell className={`${styles.dialog} ${styles.admin}`} opener={opener} close={() => void dismiss()} initialFocus="input" labelledBy="manage-user-title"><form data-unsaved={dirty ? 'true' : undefined} onChange={() => setDirty(true)} onSubmit={event => { event.preventDefault(); void save(); }}><div className={styles.panelHead}><h2 id="manage-user-title">{existing ? `管理 ${existing.username}` : '创建用户'}</h2><button type="button" className="quiet-icon" aria-label="关闭用户设置" disabled={busy} onClick={() => void dismiss()}><X size={18} /></button></div>
    <fieldset disabled={busy} className={styles.formFields}>{!existing && <label>用户名<input autoComplete="off" required minLength={3} maxLength={32} pattern="[a-zA-Z0-9_.\-]+" value={username} onChange={event => setUsername(event.target.value)} placeholder="3–32 位字母、数字或 ._-" /></label>}
    {existing && <><div className={styles.formGrid}><label>权限<select value={role} disabled={existing.id === currentUser?.id} onChange={event => setRole(event.target.value as typeof role)}><option value="user">用户</option><option value="admin">管理员</option></select></label><label>账号状态<select value={status} disabled={existing.id === currentUser?.id} onChange={event => setStatus(event.target.value as typeof status)}><option value="active">已启用</option><option value="disabled">已停用</option></select></label></div><label>每日网关调用上限<input type="number" min={1} max={10000} value={limit} placeholder="留空使用服务默认值" onChange={event => setLimit(event.target.value)} /></label><label className={styles.checkbox}><input type="checkbox" checked={platformAccess} onChange={event => setPlatformAccess(event.target.checked)} />允许使用平台 AI</label></>}
    <label>{existing ? '重置密码（留空则保留）' : '初始密码'}<input type="password" autoComplete="new-password" required={!existing} minLength={12} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} placeholder="至少 12 位" /></label></fieldset>
    {existing && <p className={styles.hint}>保存后，此账号需要重新登录。{existing.id === currentUser?.id ? '你正在修改自己的账号。' : ''}</p>}{error && <Feedback title="操作提示" tone="error" className={styles.error}>{error}</Feedback>}<div className={styles.formActions}><button type="button" className="button subtle" disabled={busy} onClick={() => void dismiss()}>取消</button><button type="submit" className="button primary" disabled={busy || !dirty}>{busy ? '正在保存…' : existing ? '保存用户设置' : '创建用户'}</button></div></form></ModalShell>;
}
function ActivityLog() {
  const [page, setPage] = useState(1); const [search, setSearch] = useState(''); const [query, setQuery] = useState('');
  const resource = useResource<AdminActivities>(`/admin/activity?page=${page}&search=${encodeURIComponent(query)}`, 15000);
  return <><Panel title="云端活动记录" eyebrow="ACTIVITY LOG"><form className={styles.filters} onSubmit={event => { event.preventDefault(); setQuery(search.toLowerCase().trim()); setPage(1); }}><div className={styles.search}><Search size={16} /><input aria-label="活动用户名" value={search} onChange={event => setSearch(event.target.value)} placeholder="按用户名查找活动…" maxLength={32} /></div><button type="submit" className="button subtle">搜索</button><button type="button" className={styles.refresh} onClick={resource.reload}><RefreshCw size={14} />刷新</button></form><Notice {...resource} retry={resource.reload} />{resource.data && <><ActivityList items={resource.data.items} /><Pagination page={page} size={resource.data.pageSize} total={resource.data.total} change={setPage} /></>}<p className={styles.hint}>活动记录保留 90 天，仅包含账号、模块与时间；相同页面的心跳会合并。</p></Panel>
    {resource.data && <><Panel title="最近 30 次 AI 调用" eyebrow="GATEWAY"><div className={styles.tableWrap} tabIndex={0} role="region" aria-label="AI 调用记录"><table><thead><tr><th>账号 / 时间</th><th>来源</th><th>模型</th><th>状态</th><th>Token 输入 / 输出</th><th>耗时</th></tr></thead><tbody>{resource.data.calls.map((call, index) => <tr key={index}><td>{call.username}<small>{date(call.createdAt)}</small></td><td>{call.source === 'platform' ? '平台 AI' : '个人 / 演示'}</td><td><span className={styles.modelId}>{call.model}</span><small>{call.provider}</small></td><td><span className={`${styles.badge} ${call.status === 'failed' ? styles.disabled : ''}`}>{({ succeeded: '已完成', failed: '失败', running: '执行中' } as Record<string, string>)[call.status] ?? call.status}</span></td><td className={styles.mono}>{call.inputTokens ?? '—'} / {call.outputTokens ?? '—'}</td><td className={styles.mono}>{call.durationMs === null ? '—' : `${(call.durationMs / 1000).toFixed(1)}s`}</td></tr>)}</tbody></table>{!resource.data.calls.length && <p className={styles.empty}>还没有调用记录。</p>}</div></Panel><Panel title="管理员操作" eyebrow="AUDIT / 最近 30 条"><div className={styles.auditList}>{resource.data.audits.map(item => <div key={item.id}><span><strong>{item.actor}</strong> · {audits[item.action] ?? item.action}{item.target ? ` · ${item.target}` : ''}</span><time>{date(item.createdAt)}</time></div>)}{!resource.data.audits.length && <p className={styles.empty}>暂无管理操作。</p>}</div><p className={styles.hint}>管理操作记录保留一年。密钥、密码与学习内容不会写入操作记录。</p></Panel></>}
  </>;
}
function Sparkline({ values, label, fixedMax }: { values: number[]; label: string; fixedMax?: number }) {
  if (values.length < 2) return <div className={styles.sampleEmpty}>正在积累真实采样，约 20 秒后显示曲线。</div>;
  const max = fixedMax ?? Math.max(1, ...values); const points = values.map((value, index) => `${index / (values.length - 1) * 600},${100 - Math.min(1, value / max) * 90}`).join(' ');
  return <svg className={styles.sparkline} viewBox="0 0 600 110" role="img" aria-label={label} preserveAspectRatio="none"><path d="M0 100H600 M0 55H600 M0 10H600" stroke="var(--color-line-default)" strokeDasharray="3 5" fill="none" /><polygon points={`0,110 ${points} 600,110`} fill="var(--color-accent-ambient-soft)" opacity=".5" /><polyline points={points} stroke="var(--color-heat-3)" strokeWidth="2" fill="none" vectorEffect="non-scaling-stroke" /></svg>;
}
function ServerMonitor() {
  const resource = useResource<ServerMetrics>('/admin/metrics', 10000); const data = resource.data;
  return <><div className={styles.sectionLine}><span className={styles.live}>API 所在主机 · 每 10 秒采样</span><button type="button" className={styles.refresh} onClick={resource.reload}><RefreshCw size={14} />刷新</button></div><Notice {...resource} retry={resource.reload} />{data && <><div className={styles.stats}><Stat title="主机 CPU" value={data.history.length ? `${data.cpuPercent.toFixed(1)}%` : '采样中'} note={`${data.cpuCores} 个逻辑核心`} accent /><Stat title="主机内存" value={`${(data.usedMemoryBytes / data.totalMemoryBytes * 100).toFixed(1)}%`} note={`${bytes(data.usedMemoryBytes)} / ${bytes(data.totalMemoryBytes)}`} /><Stat title="API 进程内存" value={bytes(data.processRssBytes)} note={`堆内存 ${bytes(data.heapUsedBytes)} / ${bytes(data.heapTotalBytes)}`} /><Stat title="运行时间" value={`${Math.floor(data.uptimeSeconds / 3600)}h ${Math.floor(data.uptimeSeconds % 3600 / 60)}m`} note={`登录会话 ${data.sessions} · 模型请求 ${data.activeRequests}`} /></div>
    <div className={styles.twoColumns}><Panel title="CPU 使用率" eyebrow="HOST CPU" aside={<span className={styles.hint}>0–100%</span>}><Sparkline values={data.history.map(item => item.cpuPercent)} label="主机 CPU 使用率采样曲线" fixedMax={100} /><div className={styles.chartFooter}><span>{data.history.length ? date(data.history[0]!.at) : '等待首个采样'}</span><span>最多保留 30 分钟</span></div></Panel><Panel title="主机内存" eyebrow="HOST MEMORY" aside={<span className={styles.hint}>0–100%</span>}><Sparkline values={data.history.map(item => item.memoryPercent)} label="主机内存使用率采样曲线" fixedMax={100} /><div className={styles.chartFooter}><span>真实主机采样</span><span>进程重启后重新积累</span></div></Panel></div>
    <Panel title="服务运行指标" eyebrow="RUNTIME"><div className={styles.runtimeGrid}><div><span>系统平均负载 · 1 / 5 / 15 分钟</span><strong>{data.loadAverage.map(value => value.toFixed(2)).join(' / ')}</strong></div><div><span>事件循环平均延迟</span><strong>{data.history.length ? `${data.eventLoopDelayMs.toFixed(1)} ms` : '采样中'}</strong></div><div><span>数据读取时间</span><strong>{date(data.sampledAt)}</strong></div></div><p className={styles.hint}>当前监测这一 API 实例及其所在主机；容器内主机读数受运行环境影响。多实例汇总、磁盘、带宽与告警可在部署时接入监控服务。</p></Panel></>}</>;
}
function PlatformSettings() {
  const { api } = useApp(); const confirm = useConfirm(); const resource = useResource<PlatformAiView>('/admin/platform-ai');
  const [view, setView] = useState<PlatformAiView | null>(null); const [draft, setDraft] = useState<PlatformAiSettings | null>(null); const [apiKey, setApiKey] = useState(''); const [clearKey, setClearKey] = useState(false);
  const [dirty, setDirty] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []); useBeforeUnload(() => dirty);
  useEffect(() => { if (!resource.data || dirty || (view && view.revision > resource.data.revision)) return; setView(resource.data); const { enabled, label, providerId, modelId, perUserDailyCalls, globalDailyCalls, maxConcurrent } = resource.data; setDraft({ enabled, label, providerId, modelId, perUserDailyCalls, globalDailyCalls, maxConcurrent }); }, [resource.data, dirty, view]);
  const edit = (patch: Partial<PlatformAiSettings>) => { setDirty(true); setMessage(''); setDraft(value => value ? { ...value, ...patch } : value); };
  const refresh = async () => { if (dirty && !await confirm({ title: '刷新平台配置', message: '刷新将丢弃尚未保存的输入。', confirmLabel: '刷新', tone: 'danger' })) return; setApiKey(''); setClearKey(false); setDirty(false); resource.reload(); };
  const save = async () => {
    if (!draft || !view) return; setBusy(true); setError(''); setMessage('');
    try { const next = await api<PlatformAiView>('/admin/platform-ai', { method: 'PUT', body: { ...draft, expectedRevision: view.revision, ...(apiKey ? { apiKey } : {}), clearKey } }); if (alive.current) { setView(next); setDraft({ enabled: next.enabled, label: next.label, providerId: next.providerId, modelId: next.modelId, perUserDailyCalls: next.perUserDailyCalls, globalDailyCalls: next.globalDailyCalls, maxConcurrent: next.maxConcurrent }); setApiKey(''); setClearKey(false); setDirty(false); setMessage('平台 AI 配置已保存，随后发起的新任务生效。'); } }
    catch (cause) { if (alive.current) setError(errorMessage(cause, '保存结果未确认，请刷新配置后核对。')); }
    finally { if (alive.current) setBusy(false); }
  };
  const provider = view?.providers.find(item => item.id === draft?.providerId);
  return <Panel title="平台 AI" eyebrow="MANAGED AI" aside={<button type="button" className={styles.refresh} disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} />刷新配置</button>}><Notice {...resource} retry={resource.reload} />{view && draft && <form data-unsaved={dirty ? 'true' : undefined} onSubmit={event => { event.preventDefault(); void save(); }}>
    <div className={styles.platformIntro}><span className={styles.platformIcon}><WandSparkles size={24} strokeWidth={1.2} /></span><div><strong>一处配置，为用户提供 AI</strong><p>用户在「AI 配置」选择「使用平台 AI」后，由这里统一提供模型与额度。</p></div><span className={`${styles.badge} ${draft.enabled ? styles.online : ''}`}>{draft.enabled ? '已启用' : '未启用'}</span></div>
    <fieldset disabled={busy} className={styles.formFields}><label className={styles.checkbox}><input type="checkbox" checked={draft.enabled} onChange={event => edit({ enabled: event.target.checked })} />向已开通的用户提供平台 AI</label><div className={styles.formGrid}><label>服务名称<input required maxLength={60} value={draft.label} onChange={event => edit({ label: event.target.value })} /></label><div className={styles.keyState}><span>密钥状态</span><strong>{view.keyConfigured ? `已配置 · ${view.keySource === 'saved' ? '后台保存' : '环境变量'}` : '尚未配置'}</strong></div></div>
    <div className={styles.formGrid}><label>平台 Provider<select required={draft.enabled} value={draft.providerId} onChange={event => { edit({ providerId: event.target.value, modelId: '' }); setApiKey(''); setClearKey(false); }}><option value="">请选择 Provider</option>{view.providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>平台模型<select required={draft.enabled} disabled={!provider} value={draft.modelId} onChange={event => edit({ modelId: event.target.value })}><option value="">请选择模型</option>{provider?.models.map(item => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}</select></label></div>
    <label>平台 API key<input type="password" autoComplete="new-password" value={apiKey} maxLength={4096} placeholder={view.keyConfigured ? '已配置；留空保留，输入则替换' : '输入平台 API key'} onChange={event => { setApiKey(event.target.value); setClearKey(false); setDirty(true); }} /></label><p className={styles.hint}>密钥加密存于服务器，保存后不再回显。更换 Provider 需重新提供对应密钥；保存配置不发送测试请求。</p>
    {view.keySource === 'saved' && <label className={styles.checkbox}><input type="checkbox" checked={clearKey} onChange={event => { setClearKey(event.target.checked); setApiKey(''); setDirty(true); }} />清除后台保存的密钥</label>}
    <div className={styles.formGridThree}><label>每用户每日平台调用<input type="number" min={1} max={10000} required value={draft.perUserDailyCalls} onChange={event => edit({ perUserDailyCalls: Number(event.target.value) })} /></label><label>全站每日平台调用<input type="number" min={1} max={1000000} required value={draft.globalDailyCalls} onChange={event => edit({ globalDailyCalls: Number(event.target.value) })} /></label><label>平台并发上限<input type="number" min={1} max={100} required value={draft.maxConcurrent} onChange={event => edit({ maxConcurrent: Number(event.target.value) })} /></label></div></fieldset>
    <p className={styles.hint}>每次提交模型任务计一次调用，包括失败与中断。额度按服务器时区的自然日计算，同时受账号网关上限约束。{view.mode === 'mock' ? '当前为演示模式，任务仍使用模拟引擎。' : ''}</p>
    {error && <Feedback title="操作提示" tone="error" className={styles.error}>{error}</Feedback>}{message && <Feedback onDismiss={() => setMessage('')} title="操作提示" tone="success" className={styles.success}><Check size={15} />{message}</Feedback>}<div className={styles.formActions}><span className={styles.hint}>配置版本 {view.revision}</span><button type="submit" className="button primary" disabled={busy || !dirty}>{busy ? '正在保存…' : '保存平台 AI 配置'}</button></div>
  </form>}</Panel>;
}
