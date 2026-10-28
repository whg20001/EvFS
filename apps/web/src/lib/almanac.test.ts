import { expect, test } from 'vitest';
import { almanac, chineseNumber } from './almanac';

test('the issue date and painting rotation follow the learning timezone across midnight and leap years', () => {
  const date = new Date('2024-02-29T16:30:00Z');
  expect(almanac(date, 'Asia/Shanghai').dayOfYear).toBe(61);
  expect(almanac(date, 'UTC').dayOfYear).toBe(60);
  expect(almanac(date, 'Asia/Shanghai').time).toBe('子时 · 零时三十分');
  expect(almanac(new Date('2026-10-25T04:42:00Z'), 'Asia/Shanghai').lunar).toBe('丙午年九月十六');
  expect(almanac(new Date('2026-10-25T04:42:00Z'), 'Asia/Shanghai').weekday).toBe('星期日');
});

test.each([[1, '一'], [10, '十'], [19, '十九'], [37, '三十七'], [100, '一百'], [101, '一百零一'], [110, '一百一十'], [298, '二百九十八']])('writes issue number %i as %s', (number, expected) => {
  expect(chineseNumber(number as number)).toBe(expected);
});

test.each([
  ['2026-10-26T01:00:00Z', '巳时一刻'],
  ['2026-10-26T01:35:00Z', '巳时三刻'],
  ['2026-10-26T02:59:00Z', '巳时八刻'],
  ['2026-10-26T03:00:00Z', '午时一刻'],
  ['2026-10-25T15:00:00Z', '子时一刻'],
  ['2026-10-25T16:00:00Z', '子时五刻'],
  ['2026-10-25T16:59:00Z', '子时八刻'],
  ['2026-10-25T17:00:00Z', '丑时一刻'],
])('formats a compact shichen for %s, including quarter boundaries and midnight', (date, expected) => {
  expect(almanac(new Date(date), 'Asia/Shanghai').compactTime).toBe(expected);
});
