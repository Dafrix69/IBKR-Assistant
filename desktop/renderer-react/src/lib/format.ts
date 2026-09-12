/** 数字与时间的显示格式。与旧 core.js 同一口径,迁页时逐个搬过来。
 *  日期用 dayjs(AntD 的 DatePicker 本来就用它,不额外增加体积),不自己做日历判断。 */
import dayjs from 'dayjs';

/** 定点小数,不带千分位——量表里要看清 0.0500 这种小数。 */
export function fmtNum(value: unknown, digits = 2): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

export function fmtMoney(value: unknown): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 列表里的紧凑时间:今天只显示时分,其余显示月-日 时分。年份在这里没有信息量。 */
export function fmtTimeShort(iso: unknown): string {
  if (!iso) return '—';
  const d = dayjs(String(iso));
  if (!d.isValid()) return String(iso);
  return d.isSame(dayjs(), 'day') ? d.format('HH:mm') : d.format('MM-DD HH:mm');
}

export function fmtTime(iso: unknown): string {
  if (!iso) return '—';
  const d = new Date(String(iso));
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString('zh-CN', { hour12: false });
}

/** 'YYYYMMDD' → 'YYYY-MM-DD'。到期日在合约里是紧凑格式,直接摆出来很难读。 */
export function fmtExpiry(v: unknown): string | null {
  const t = String(v ?? '').trim();
  return /^\d{8}$/.test(t) ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6)}` : t || null;
}
