export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** 取某时刻所在自然日的 00:00:00.000（本地时区）。 */
export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 取某时刻所在自然周的周一 00:00（本地时区，以周一为一周起点）。 */
export function startOfWeek(ts) {
  const d = new Date(ts);
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 取某时刻所在自然月的 1 日 00:00（本地时区）。 */
export function startOfMonth(ts) {
  const d = new Date(ts);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "2026-09-27" → 当日 00:00 的时间戳，支持 "today"/"yesterday"。 */
export function parseDateBoundary(input, now = Date.now()) {
  if (!input || input === 'today') return startOfDay(now);
  if (input === 'yesterday') return startOfDay(now - DAY);
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const [y, m, d] = input.split('-').map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  }
  throw new Error(`无法识别的日期: ${input}（支持 YYYY-MM-DD/today/yesterday）`);
}

export function hourKey(ts) {
  return new Date(ts).getHours();
}

export function weekdayKey(ts) {
  return (new Date(ts).getDay() + 6) % 7;
}

export function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${s % 60}秒`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小时${m % 60}分`;
  return `${Math.floor(h / 24)}天${h % 24}小时`;
}
