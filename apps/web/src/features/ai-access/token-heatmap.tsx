'use client';

import { Feedback } from '../../components/feedback';
import { useEffect, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import type { Mode, TokenUsageDay, TokenUsageHeatmap } from '@sanxing/contracts';
import { Card } from '../../components/ui';
import { type ApiClient } from '../../lib/api-client';
import { accessError } from './use-oauth';
import styles from './ai-access.module.css';

const number = (value: number) => value.toLocaleString('zh-CN');
function detail(date: string, day: TokenUsageDay | undefined): string {
  if (!day) return `${date}：未收到该日统计，不能视为零消耗。`;
  const usage = day.knownUsageAttempts > 0
    ? `已知总数 ${number(day.totalTokens)} tokens；输入 ${number(day.inputTokens)}（含缓存），输出 ${number(day.outputTokens)}`
    : day.unknownUsageAttempts > 0 ? '用量未知，不能视为零消耗' : '无模型执行记录';
  return `${date}：${usage}；执行 ${number(day.attempts)} 次，已知用量 ${number(day.knownUsageAttempts)} 次，未知用量 ${number(day.unknownUsageAttempts)} 次。`;
}

function Calendar({ data }: { data: TokenUsageHeatmap }) {
  const [selected, setSelected] = useState<string | null>(null);
  // UTC is only used to lay out plain YYYY-MM-DD calendar labels. The server's
  // date keys and totals are used verbatim; browser timezone never regroups usage.
  const start = Date.UTC(data.year, 0, 1);
  const count = (Date.UTC(data.year + 1, 0, 1) - start) / 86400000;
  const offset = (new Date(start).getUTCDay() + 6) % 7;
  const weeks = Math.ceil((count + offset) / 7);
  const days = new Map(data.days.map(day => [day.date, day]));
  const dates = Array.from({ length: count }, (_, index) => new Date(start + index * 86400000).toISOString().slice(0, 10));
  const columns = `repeat(${weeks}, var(--usage-cell-size))`;
  return <>
    <div className={styles.calendarFrame}>
      <div className={styles.weekdays} aria-hidden="true">{['一', '二', '三', '四', '五', '六', '日'].map(day => <span key={day}>{day}</span>)}</div>
      <div className={styles.calendarScroll} tabIndex={0} role="region" aria-label={`${data.year} 年每日 token 用量，按周排列，周一开始，可横向滚动`}>
        <div className={styles.months} style={{ gridTemplateColumns: columns }} aria-hidden="true">
          {dates.map((date, index) => date.endsWith('-01') ? <span key={date} style={{ gridColumn: Math.floor((offset + index) / 7) + 1 }}>{Number(date.slice(5, 7))}月</span> : null)}
        </div>
        <div className={styles.calendar} style={{ gridTemplateColumns: columns }}>
          {dates.map((date, index) => {
            const day = days.get(date);
            const unknown = !day || day.unknownUsageAttempts > 0;
            const text = detail(date, day);
            return <button key={date} type="button" className={`${styles.cell} ${unknown ? styles.unknown : ''}`}
              data-level={day?.level ?? 0} data-selected={selected === date} aria-pressed={selected === date} style={{ gridColumn: Math.floor((offset + index) / 7) + 1, gridRow: (offset + index) % 7 + 1 }}
              title={text} aria-label={text} onMouseEnter={() => setSelected(date)} onFocus={() => setSelected(date)} onClick={() => setSelected(date)}>
              {unknown && <span aria-hidden="true">?</span>}
            </button>;
          })}
        </div>
      </div>
    </div>
    <div className={styles.legend} aria-label="用量等级图例"><span>已知用量等级（服务端分级）</span>
      {[0, 1, 2, 3, 4].map(level => <span key={level} className={styles.legendItem}><i className={styles.cell} data-level={level} aria-hidden="true" />{level}</span>)}
      <span className={styles.legendItem}><i className={`${styles.cell} ${styles.unknown}`} aria-hidden="true">?</i>含未知 / 缺失统计</span>
    </div>
    <p className={styles.dayDetail} aria-live="polite" aria-atomic="true">{selected ? detail(selected, days.get(selected)) : '悬停、聚焦或点击日期，查看当日详情。条纹表示存在未知用量，不代表 0 消耗。'}</p>
  </>;
}

export function TokenHeatmap({ api, mode, refreshKey = 0 }: { api: ApiClient; mode: Mode; refreshKey?: number }) {
  // Omit year initially: only the server knows its timezone's current year.
  const [year, setYear] = useState<number | undefined>();
  const [years, setYears] = useState<number[]>([]);
  const [data, setData] = useState<TokenUsageHeatmap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setData(null);
    void (async () => {
      try {
        const next = await api<TokenUsageHeatmap>(`/ai/usage${year === undefined ? '' : `?year=${year}`}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (next.mode !== mode) throw new Error('运行模式已变化，请先刷新上方授权状态，再读取当前模式用量。');
        setData(next);
        setYears(next.availableYears);
      } catch (cause) { if (!controller.signal.aborted) setError(accessError(cause)); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [api, mode, year, revision, refreshKey]);
  const visible = data?.mode === mode && (year === undefined || data.year === year) ? data : null;
  const selectedYear = year ?? visible?.year ?? '';
  return <Card className={styles.heatmap}>
    <div className={styles.sectionHeading}>
      <div><h2><CalendarDays size={19} />Token 使用热力图</h2><p>按日查看本应用的模型用量</p></div>
      <div className={styles.yearControls}>
        <label htmlFor="ai-usage-year">年份</label>
        <select id="ai-usage-year" value={selectedYear} disabled={loading || !years.length} onChange={event => setYear(Number(event.target.value))}>
          {!selectedYear && <option value="">服务器当前年</option>}
          {years.map(item => <option key={item} value={item}>{item} 年</option>)}
        </select>
        <button type="button" className="button subtle" disabled={loading} onClick={() => setRevision(value => value + 1)}>刷新</button>
      </div>
    </div>
    <details className={styles.help}><summary>统计口径</summary><p className="small muted">仅统计本应用的模型执行，不是厂商账号全局用量、订阅剩余额度，也不统计 OAuth access token 字符串。</p><p className="small muted">包含失败或取消执行中已报告的 token；旧记录缺失用量显示未知。已知总数不包含未知部分，不是厂商账单。执行次数指已开始的任务尝试，不保证已发出厂商请求。</p></details>
    {mode === 'mock' && <p className={styles.mock}><strong>MOCK · 以下仅为估计 / 演示用量，不是真实模型消耗。</strong></p>}
    {loading && <p role="status" className="muted">正在读取用量记录…</p>}
    {error && <Feedback title="操作提示" tone="error" className={styles.failure}><p>{error}</p><button type="button" className="button" onClick={() => setRevision(value => value + 1)}>重试读取用量</button></Feedback>}
    {visible && <>
      <p className="small muted">仅显示 {visible.mode} 模式 · 时区 {visible.timezone} · 按请求开始日归属统计。</p>
      <dl className={styles.totals}>
        {([
          ['输入 token（包含缓存）', visible.totals.inputTokens], ['输出 token', visible.totals.outputTokens],
          ['已知 token 总数', visible.totals.totalTokens], ['执行次数', visible.totals.attempts],
          ['已知用量次数', visible.totals.knownUsageAttempts], ['未知用量次数', visible.totals.unknownUsageAttempts],
        ] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{number(value)}</dd></div>)}
      </dl>
      {visible.cache && <><dl className={`${styles.totals} ${styles.cacheTotals}`}>{([
        ['年度缓存读取 token', visible.cache.readTokens], ['年度缓存写入 token', visible.cache.writeTokens], ['缓存用量未知次数', visible.cache.unknownAttempts],
      ] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{number(value)}</dd></div>)}</dl><p className="small muted">缓存读写已含在总输入中，不重复相加；未知不代表零，缓存不保证免费或命中。</p></>}
      {visible.totals.unknownUsageAttempts > 0 && <p className={styles.mock}>存在 {number(visible.totals.unknownUsageAttempts)} 次未知用量，不能将年度或对应日期的已知总数视为完整消耗。</p>}
      {visible.totals.attempts === 0 && <p role="status" className="muted">{visible.year} 年暂无本应用的模型执行记录。</p>}
      <Calendar key={`${visible.mode}:${visible.year}`} data={visible} />
    </>}
  </Card>;
}
