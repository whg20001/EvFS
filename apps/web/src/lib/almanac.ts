const digits = '零一二三四五六七八九';
export function chineseNumber(value: number): string {
  if (value < 10) return digits[value]!;
  if (value < 20) return `十${value % 10 ? digits[value % 10] : ''}`;
  if (value < 100) return `${digits[Math.floor(value / 10)]}十${value % 10 ? digits[value % 10] : ''}`;
  if (value < 1000) {
    const remainder = value % 100;
    return `${digits[Math.floor(value / 100)]}百${remainder === 0 ? '' : remainder < 10 ? '零' : remainder < 20 ? '一' : ''}${remainder ? chineseNumber(remainder) : ''}`;
  }
  return String(value);
}

export function almanac(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const part = (name: string) => Number(parts.find(item => item.type === name)?.value ?? 0);
  const year = part('year'), month = part('month'), day = part('day'), hour = part('hour');
  const minute = part('minute');
  const shichen = '子丑寅卯辰巳午未申酉戌亥'[Math.floor((hour + 1) / 2) % 12];
  // Number the fifteen-minute intervals within each two-hour period, including midnight.
  const quarter = Math.floor((((hour + 1) % 2) * 60 + minute) / 15) + 1;
  const dayOfYear = Math.round((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 0)) / 86_400_000);
  let lunar = '';
  try {
    const chinese = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { timeZone: timezone, year: 'numeric', month: 'long', day: 'numeric' }).formatToParts(date);
    const lunarDay = Number(chinese.find(item => item.type === 'day')?.value ?? day);
    const dayName = lunarDay <= 10 ? `初${chineseNumber(lunarDay)}` : lunarDay < 20 ? chineseNumber(lunarDay) : lunarDay === 20 ? '二十' : lunarDay < 30 ? `廿${chineseNumber(lunarDay - 20)}` : '三十';
    lunar = `${chinese.find(item => String(item.type) === 'yearName')?.value ?? year}年${chinese.find(item => item.type === 'month')?.value ?? month + '月'}${dayName}`;
  } catch { lunar = `${year}年${chineseNumber(month)}月${chineseNumber(day)}日`; }
  return {
    lunar, dayOfYear,
    time: `${shichen}时 · ${chineseNumber(hour)}时${chineseNumber(minute)}分`,
    compactTime: `${shichen}时${chineseNumber(quarter)}刻`,
    date: new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(date),
    weekday: new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, weekday: 'long' }).format(date),
    greeting: hour < 6 ? '夜深了' : hour < 12 ? '上午好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好',
  };
}
