/**
 * 蝴蝶测算的表单:输入框里的字符串 ↔ 引擎要的数字,以及把测算过的那只蝶写成一句下单指令。纯函数,不碰桥。
 *
 * 输入框里留空 = 这一项交给引擎定(现价、IV 从券商取;成本按盘口中间价;看涨看跌按中心与现价推断;
 * 日期默认今天、当日到期)。引擎那边的 schema 是 strict 的、数值只认数字,所以这里把字符串转好再发。
 */
import type { FlyPlanIvMode, FlyPlanParams, FlyPlanResult } from '../bridge';

export interface FlyForm {
  center: string;
  width: string;
  right: '' | 'C' | 'P';
  quantity: string;
  cost: string;
  targetSpot: string;
  /** 美东 HH:MM */
  targetTime: string;
  /** 美东 YYYY-MM-DD;空 = 今天(已收盘则下一个交易日) */
  targetDate: string;
  /** YYYY-MM-DD;空 = 目标那一天(当日到期) */
  expiry: string;
  spot: string;
  /** 百分数:18 = 18% */
  iv: string;
  ivMode: FlyPlanIvMode;
  ivShiftPct: string;
}

export const EMPTY_FORM: FlyForm = {
  center: '', width: '25', right: '', quantity: '1', cost: '', targetSpot: '', targetTime: '', targetDate: '', expiry: '',
  spot: '', iv: '', ivMode: 'auto', ivShiftPct: '',
};

/** 空 → null;写了但不是数 → NaN(交给 formProblems 报) */
function num(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : NaN;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

/** 发给引擎之前就能看出来的问题。范围与先后(目标时刻过没过、在不在到期之前)由引擎按它的时钟判 */
export function formProblems(form: FlyForm): string[] {
  const out: string[] = [];
  const need = (label: string, text: string, check: (v: number) => string | null): void => {
    const v = num(text);
    if (v === null) out.push(`${label}还没填`);
    else if (Number.isNaN(v)) out.push(`${label}不是数字`);
    else {
      const why = check(v);
      if (why) out.push(`${label}${why}`);
    }
  };
  const maybe = (label: string, text: string, check: (v: number) => string | null): void => {
    const v = num(text);
    if (v === null) return;
    if (Number.isNaN(v)) out.push(`${label}不是数字`);
    else {
      const why = check(v);
      if (why) out.push(`${label}${why}`);
    }
  };
  const positive = (v: number): string | null => (v > 0 ? null : '要大于 0');

  const width = num(form.width);
  need('中心行权价', form.center, (v) => (v > 0 ? (width !== null && v <= width ? '要大于翼宽' : null) : '要大于 0'));
  need('翼宽', form.width, positive);
  need('目标点位', form.targetSpot, positive);
  if (!form.targetTime.trim()) out.push('到达时刻还没填');
  else if (!TIME_RE.test(form.targetTime.trim())) out.push('到达时刻要写成 HH:MM(美东时间)');
  maybe('张数', form.quantity, (v) => (Number.isInteger(v) && v >= 1 ? null : '要是不小于 1 的整数'));
  maybe('成本', form.cost, (v) => (v > 0 ? (width !== null && width > 0 && v >= width ? '不应该超过翼宽' : null) : '要大于 0'));
  maybe('现价', form.spot, positive);
  maybe('IV', form.iv, (v) => (v > 0 && v <= 500 ? null : '要在 0 到 500% 之间'));
  if (form.targetDate.trim() && !DATE_RE.test(form.targetDate.trim())) out.push('目标日期要写成 YYYY-MM-DD');
  if (form.expiry.trim() && !DATE_RE.test(form.expiry.trim())) out.push('到期日要写成 YYYY-MM-DD');
  if (form.ivMode === 'shift') need('IV 变化', form.ivShiftPct, (v) => (v > -100 ? null : '不能小于 −100%'));
  return out;
}

/** formProblems 为空时才调。留空的项不带,交给引擎定 */
export function toParams(form: FlyForm): FlyPlanParams {
  const out: FlyPlanParams = {
    center: Number(form.center),
    width: Number(form.width),
    target_spot: Number(form.targetSpot),
    target_time: form.targetTime.trim(),
    iv_mode: form.ivMode,
  };
  const put = <K extends 'quantity' | 'cost' | 'spot' | 'iv'>(key: K, text: string): void => {
    const v = num(text);
    if (v !== null) out[key] = v;
  };
  put('quantity', form.quantity);
  put('cost', form.cost);
  put('spot', form.spot);
  put('iv', form.iv);
  if (form.right) out.right = form.right;
  if (form.targetDate.trim()) out.target_date = form.targetDate.trim();
  if (form.expiry.trim()) out.expiry = form.expiry.trim().replace(/-/g, '');
  if (form.ivMode === 'shift') out.iv_shift_pct = Number(form.ivShiftPct);
  return out;
}

// ---- 美东时间 ----------------------------------------------------------------
/** 此刻在美东是哪一天、当天第几分钟。输入框里的时刻一律是美东的,快捷按钮要从它起算 */
export function etClock(nowMs: number): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(nowMs));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '0';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')) };
}

export function hhmm(minutes: number): string {
  const m = Math.max(0, Math.min(23 * 60 + 59, Math.round(minutes)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 「N 分钟后」:不越过收盘(16:00)——过了收盘当日到期的蝶已经结算了 */
export function minutesFromNow(nowMs: number, ahead: number): string {
  return hhmm(Math.min(16 * 60, etClock(nowMs).minutes + ahead));
}

// ---- 写成指令 ----------------------------------------------------------------
function plain(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** 'YYYY-MM-DD' 之后的下一个工作日(只跳周末,和本地速记对「明天」的理解一致) */
function nextWeekday(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  do dt.setUTCDate(dt.getUTCDate() + 1);
  while (dt.getUTCDay() === 0 || dt.getUTCDay() === 6);
  return dt.toISOString().slice(0, 10);
}

/**
 * 把测算过的这只蝶写成一句下单指令,放进「交易指令」的输入框——**只是填字**,发不发、什么时候发还是那两个按钮的事。
 *
 * 当日与下一个交易日到期的写成本地速记认得的样子(engine-ts/src/shorthand.ts:「7750蝴蝶」「25cm」「看涨」「2张」、
 * 句尾的孤立数字 = 净权利金上限),毫秒级解析、不经大模型;别的到期日写明日期,交给大模型。
 * 权利金用测算时的成本:那是"按这个价买才有这个盈利"的价。
 */
export function instructionFor(r: FlyPlanResult, todayEt: string): string {
  const expiry = `${r.expiry.slice(0, 4)}-${r.expiry.slice(4, 6)}-${r.expiry.slice(6, 8)}`;
  const side = r.right === 'C' ? '看涨' : '看跌';
  const body = `${plain(r.center)}蝴蝶 ${plain(r.width)}cm ${side} ${r.quantity}张`;
  if (expiry === todayEt) return `${r.symbol} ${body} ${plain(r.cost)}`;
  if (expiry === nextWeekday(todayEt)) return `${r.symbol} 明天 ${body} ${plain(r.cost)}`;
  return `买入 ${r.quantity} 张 ${r.symbol} ${expiry} 到期的 ${plain(r.lower)}/${plain(r.center)}/${plain(r.upper)} ${side}蝴蝶,权利金不超过 ${plain(r.cost)}`;
}

// ---- 给人看的话 --------------------------------------------------------------
export const PACE_LABEL: Record<FlyPlanResult['move']['pace'], string> = { calm: '平缓', brisk: '偏急', sharp: '很急' };
export const IV_SOURCE_LABEL: Record<FlyPlanResult['iv']['source'], string> = {
  ibkr: 'IBKR 模型 IV', quote: '盘口反解', input: '手动填写',
};
export const COST_SOURCE_LABEL: Record<FlyPlanResult['cost_source'], string> = { input: '你填的', mid: '盘口中间价', model: '模型价(无盘口)' };

/** 带符号的美元:+$1,234 / −$567 */
export function signedUsd(value: number): string {
  const abs = Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 0 });
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}$${abs}`;
}

export function signedPct(value: number, digits = 1): string {
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(digits)}%`;
}

export function pct(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}
