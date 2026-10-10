import { describe, expect, it } from 'vitest';
import { usageSchema } from '@sanxing/contracts';
import { tokenUsageHeatmap, type UsageRecord } from './index.ts';
const known = (inputTokens: number, outputTokens: number) => ({ provider: 'test', model: 'test', inputTokens, outputTokens, cost: null });
const calendar = (runs: UsageRecord[], year = 2026, timezone = 'Asia/Shanghai') => tokenUsageHeatmap({ runs, mode: 'live', timezone, year, now: new Date('2026-01-01T00:00:00Z') });

describe('token calendar projection', () => {
  it('returns every calendar day without inventing activity', () => {
    const result = calendar([]);
    expect(result.days).toHaveLength(365); expect(result.totals.totalTokens).toBe(0);
    expect(result.days.every(day => day.attempts === 0 && day.level === 0)).toBe(true);
  });
  it('attributes an execution to its starting day in the configured timezone', () => {
    const result = calendar([{ startedAt: '2025-12-31T16:30:00Z', usage: known(40, 10) }]);
    expect(result.days[0]).toMatchObject({ date: '2026-01-01', totalTokens: 50, attempts: 1 });
    expect(calendar([{ startedAt: '2025-12-31T16:30:00Z', usage: known(40, 10) }], 2026, 'UTC').totals.attempts).toBe(0);
  });
  it('separates unknown usage from zero usage and excludes jobs never started', () => {
    const result = calendar([
      { startedAt: null, usage: null },
      { startedAt: '2026-01-01T00:00:00Z', usage: null },
      { startedAt: '2026-01-01T01:00:00Z', usage: known(0, 0) },
      { startedAt: '2026-01-01T02:00:00Z', usage: known(120, 30) },
    ]);
    expect(result.totals).toEqual({ inputTokens: 120, outputTokens: 30, totalTokens: 150, attempts: 3, knownUsageAttempts: 2, unknownUsageAttempts: 1 });
  });
  it('handles leap years, relative intensity and year choices', () => {
    const result = calendar([{ startedAt: '2024-02-29T00:00:00Z', usage: known(10, 0) }, { startedAt: '2024-03-01T00:00:00Z', usage: known(40, 0) }], 2024);
    expect(result.days).toHaveLength(366);
    expect(result.days.find(day => day.date === '2024-02-29')!.level).toBe(1);
    expect(result.days.find(day => day.date === '2024-03-01')!.level).toBe(4);
    expect(result.availableYears).toEqual([2026, 2024]); expect(result.totals.totalTokens).toBe(50);
  });
  it('rejects cache counters that exceed the total input instead of displaying impossible savings', () => {
    expect(usageSchema.safeParse({ ...known(10, 2), cacheReadTokens: 9, cacheWriteTokens: 2 }).success).toBe(false);
    expect(usageSchema.safeParse({ ...known(10, 2), cacheReadTokens: 10 }).success).toBe(true);
    expect(usageSchema.safeParse(known(10, 2)).success).toBe(true);
  });

  it('reports cache subsets without counting them twice and keeps legacy counters unknown', () => {
    const result = calendar([
      { startedAt: '2026-01-01T00:00:00Z', usage: { ...known(100, 20), cacheReadTokens: 60, cacheWriteTokens: 10 } },
      { startedAt: '2026-01-02T00:00:00Z', usage: known(50, 5) },
      { startedAt: '2026-01-03T00:00:00Z', usage: null },
      { startedAt: '2025-01-01T00:00:00Z', usage: { ...known(999, 0), cacheReadTokens: 999, cacheWriteTokens: 0 } },
      { startedAt: null, usage: { ...known(999, 0), cacheReadTokens: 999, cacheWriteTokens: 0 } },
    ]);
    expect(result.cache).toEqual({ readTokens: 60, writeTokens: 10, unknownAttempts: 2 });
    expect(result.totals).toMatchObject({ inputTokens: 150, outputTokens: 25, totalTokens: 175, attempts: 3 });
  });

  it('labels mock output and rejects invalid calendar inputs', () => {
    const result = tokenUsageHeatmap({ runs: [], mode: 'mock', timezone: 'UTC', year: 2026, now: new Date('2026-01-01') });
    expect(result.mode).toBe('mock'); expect(() => calendar([], 2026.5)).toThrow(); expect(() => calendar([], 2026, 'invalid/timezone')).toThrow();
  });
});
