import type { Mode, Usage, TokenUsageDay, TokenUsageHeatmap, TokenUsageTotals } from '@sanxing/contracts';

export interface UsageRecord { startedAt: string | null; usage: Usage | null }

const empty = (): TokenUsageTotals => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, attempts: 0, knownUsageAttempts: 0, unknownUsageAttempts: 0 });
const sum = (target: TokenUsageTotals, value: TokenUsageTotals) => {
  for (const key of Object.keys(target) as (keyof TokenUsageTotals)[]) target[key] += value[key];
};

/** Pure projection. No database, clock, credential, HTTP or Provider dependency. */
export function tokenUsageHeatmap(input: { runs: readonly UsageRecord[]; mode: Mode; timezone: string; year: number; now: Date }): TokenUsageHeatmap {
  const { runs, mode, timezone, year, now } = input;
  if (!Number.isInteger(year) || year < 1970 || year > 2100) throw new Error('Invalid usage calendar year');
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  function dateKey(date: Date) {
    const parts = formatter.formatToParts(date);
    return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
  }
  const days: TokenUsageDay[] = [];
  const end = Date.UTC(year + 1, 0, 1);
  for (let time = Date.UTC(year, 0, 1); time < end; time += 86_400_000) days.push({ date: new Date(time).toISOString().slice(0, 10), ...empty(), level: 0 });
  const index = new Map(days.map(day => [day.date, day]));
  const cache = { readTokens: 0, writeTokens: 0, unknownAttempts: 0 };
  const years = new Set([Number(dateKey(now).slice(0, 4)), year]);
  for (const run of runs) {
    // Budget-denied and still-queued jobs did not start a model execution.
    if (!run.startedAt) continue;
    const date = dateKey(new Date(run.startedAt));
    years.add(Number(date.slice(0, 4)));
    const day = index.get(date);
    if (!day) continue;
    day.attempts++;
    // Cache counters are subsets of total input, never extra billable tokens.
    if (run.usage?.cacheReadTokens === undefined || run.usage?.cacheWriteTokens === undefined) cache.unknownAttempts++;
    cache.readTokens += run.usage?.cacheReadTokens ?? 0;
    cache.writeTokens += run.usage?.cacheWriteTokens ?? 0;
    if (run.usage === null) { day.unknownUsageAttempts++; continue; }
    day.knownUsageAttempts++;
    day.inputTokens += run.usage.inputTokens;
    day.outputTokens += run.usage.outputTokens;
    day.totalTokens += run.usage.inputTokens + run.usage.outputTokens;
  }
  const totals = empty();
  const maximum = Math.max(0, ...days.map(day => day.totalTokens));
  for (const day of days) {
    day.level = day.totalTokens === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(day.totalTokens / maximum * 4))) as TokenUsageDay['level'];
    sum(totals, day);
  }
  return { mode, timezone, year, availableYears: [...years].sort((a, b) => b - a), totals, days, cache };
}
