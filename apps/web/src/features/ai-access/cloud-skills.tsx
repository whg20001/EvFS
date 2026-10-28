'use client';

import { Feedback } from '../../components/feedback';
import { useEffect, useState } from 'react';
import { Check, CloudDownload, Download, Search } from 'lucide-react';
import type { CloudSkillCatalogView, SkillSummary } from '@sanxing/contracts';
import type { ApiClient } from '../../lib/api-client';
import { errorMessage } from '../../lib/api-client';
import styles from './ai-access.module.css';

export function CloudSkills({ api, local, busy, download }: { api: ApiClient; local: SkillSummary[]; busy: boolean; download: (name: string) => Promise<boolean> }) {
  const [catalog, setCatalog] = useState<CloudSkillCatalogView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [revision, setRevision] = useState(0);
  const [downloading, setDownloading] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(''); setCatalog(null);
    void api<CloudSkillCatalogView>('/ai/skills/cloud', { signal: controller.signal }).then(next => { if (!controller.signal.aborted) setCatalog(next); })
      .catch(cause => { if (!controller.signal.aborted) setError(errorMessage(cause, '云 Skill 列表读取失败。')); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, revision]);
  const installed = new Set(local.map(skill => skill.name));
  const items = catalog?.items.filter(skill => `${skill.name} ${skill.description}`.toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  return <div className={styles.cloudSkills}>
    <div className={styles.sectionHeading}><div><h3><CloudDownload size={18} />云 Skill</h3><p>浏览远程目录，下载后在本地管理和启用。</p></div><button type="button" className="button subtle" disabled={loading || busy} onClick={() => setRevision(value => value + 1)}>刷新云 Skill</button></div>
    {loading && <p role="status" className="small muted">正在读取云 Skill…</p>}
    {error && <Feedback title="操作提示" tone="error" className={styles.error}>{error}</Feedback>}
    {!loading && catalog?.configured === false && <div className={styles.skillEmpty}><CloudDownload size={26} /><h3>尚未配置远程目录</h3><p>在服务器设置 SKILL_CATALOG_URL 后，这里会展示可下载的 Skill。</p></div>}
    {catalog?.configured && <>
      <label className={styles.skillSearch}><Search size={16} /><span className="sr-only">搜索云 Skill</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称或学习方法…" /></label>
      {catalog.source && <p className={styles.catalogSource}>目录来源：{catalog.source}</p>}
      <div className={styles.cloudList} role="list" aria-label="云 Skill 列表">{items.map(skill => <article key={skill.name} className={styles.cloudItem} role="listitem">
        <div className={styles.cloudItemContent}><h3>{skill.name}</h3><p>{skill.description}</p>{(skill.version || skill.author) && <small>{[skill.version && `版本 ${skill.version}`, skill.author].filter(Boolean).join(' · ')}</small>}</div>
        <button type="button" className={`button ${installed.has(skill.name) ? 'subtle' : ''}`} disabled={busy || installed.has(skill.name)} aria-label={`${installed.has(skill.name) ? '已下载' : '下载到本地'} ${skill.name}`} onClick={async () => {
          setDownloading(skill.name); try { await download(skill.name); } finally { setDownloading(null); }
        }}>{installed.has(skill.name) ? <Check size={16} /> : <Download size={16} />}{installed.has(skill.name) ? '已下载' : downloading === skill.name ? '正在下载…' : '下载到本地'}</button>
      </article>)}</div>
      {!items.length && !loading && <p className="small muted">{query.trim() ? '没有匹配的云 Skill，试试其他关键词。' : '远程目录暂时没有 Skill。'}</p>}
    </>}
  </div>;
}
