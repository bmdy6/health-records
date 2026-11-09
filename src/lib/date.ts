// 本地日期 helper（批次 3）：一律用本地时区的年月日，不再用 toISOString() 的 UTC 日期
// 日期统一为 YYYY-MM-DD / YYYY-MM 字符串，字典序即时间序，可直接比较

// timestamp → 本地年月日 YYYY-MM-DD
export function localDateOfTs(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// 本地今天 YYYY-MM-DD
export function localToday(): string {
  return localDateOfTs(Date.now());
}

// YYYY-MM 月加减（跨年/负数安全），返回 'YYYY-MM'
export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12 + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

// YYYY-MM 该月最后一天 → 'YYYY-MM-DD'
export function lastDayOfMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(y, m, 0).getDate(); // m 月 0 日 = m-1 月最后一天（JS 月 0 基）
  return `${month}-${String(last).padStart(2, '0')}`;
}
