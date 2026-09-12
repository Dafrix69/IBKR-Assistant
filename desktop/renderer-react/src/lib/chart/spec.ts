// 图表描述(spec)。图上出现的每一条线都对应引擎算出的一个字段,图表层不新算任何东西:
// 调用方把引擎结果翻译成一份 spec,这里只负责画。所有元素都按 time 定位,不用下标。
//
//   times     x 轴的时间序列(缺省取 bars 的 time)
//   bars      蜡烛,可以是 times 的子集(稀疏)
//   lines     折线:values 与 times 对齐,或 points:[{time,value}]
//   hlines    水平线:tag = 轴上价格标签,fit = 是否撑开价格区间,label = 写在线左端的名字
//   bands     区域 {from,to,top,bottom} 或竖带 {v:true,from,to}
//   vlines    竖线(开仓 / 平仓),顶部写字
//   markers   圆点 / 三角 + 文字,落在精确价位上
//   last      现价:点线 + 轴上钉住的标签
//   legend    [[glyph, color, text]];header(i) 顶部第一行读数;readout(i) 十字光标读数
//   volume    是否画量能子图(缺省:有成交量就画);yMin 价格区间下限(蝶价不会小于 0)
// 颜色写 token 名('up' / 'down' / 'blue' / 'orange' / 'purple' / 'label' / 'label2')或字面量。
import type { Palette } from './palette';

export interface SpecBar {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
}

export interface SpecLine {
  values?: Array<number | null | undefined>;
  points?: Array<{ time: string; value: number | null | undefined }>;
  color?: string;
  width?: number;
  dash?: number[];
  alpha?: number;
  step?: boolean;
  label?: string;
}

export interface SpecHLine {
  price: number;
  color?: string;
  dash?: number[];
  alpha?: number;
  width?: number;
  label?: string;
  tag?: boolean;
  fit?: boolean;
}

export interface SpecBand {
  v?: boolean;
  from?: string | null;
  to?: string | null;
  top?: number;
  bottom?: number;
  color?: string;
  fill?: number | null;
  stroke?: number | null;
  dash?: number[];
  label?: string;
  fit?: boolean;
}

export interface SpecVLine {
  time: string;
  color?: string;
  dash?: number[];
  label?: string;
}

export interface SpecMarker {
  time: string;
  price: number;
  shape?: 'dot' | 'tri-up' | 'tri-down';
  color?: string;
  label?: string;
  labelPos?: 'above' | 'below';
  labelColor?: string;
  labelAlpha?: number;
  fit?: boolean;
}

/** 一行读数:[[文字, 颜色]] */
export type Parts = Array<[string, string]>;

export interface ChartHelpers {
  fmt(v: number): string;
  fmtVol(v: number | null | undefined): string;
  P: Palette;
  col(c?: string | null): string;
  timeLabel(t: string, withDate?: boolean): string;
}

export interface ChartSpec {
  ariaLabel?: string;
  /** 视口身份:刷新时这个不变就保留用户缩放 / 平移到的位置(缺省 ariaLabel + 第一根的时间) */
  viewKey?: string;
  times?: string[];
  bars?: SpecBar[];
  lines?: SpecLine[];
  hlines?: SpecHLine[];
  bands?: SpecBand[];
  vlines?: SpecVLine[];
  markers?: SpecMarker[];
  last?: number | null;
  legend?: Array<[string, string, string]>;
  header?: ((i: number, h: ChartHelpers) => Parts | null | undefined) | null;
  readout?: ((i: number, h: ChartHelpers) => Parts | null | undefined) | null;
  volume?: boolean;
  yMin?: number | null;
  decimals?: number | null;
  padPct?: number;
}

// ---------------------------------------------------------------- 格式

/** "好看的"刻度步长:1 / 2 / 2.5 / 5 × 10^k,目标约 target 个刻度。 */
export function niceStep(span: number, target: number): number {
  const raw = span / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (raw <= m * mag) return m * mag;
  }
  return 10 * mag;
}

export function decimalsFor(step: number): number {
  if (!(step > 0) || step >= 1) return 2;
  return Math.min(4, Math.max(2, -Math.floor(Math.log10(step))));
}

export function fmtPrice(p: number, dec: number): string {
  return Number(p).toFixed(dec);
}

export function fmtVol(v: number | null | undefined): string {
  if (v == null) return '—';
  if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(1) + '万';
  return String(Math.round(v));
}

/** 'YYYY-MM-DD HH:MM' → 轴上 / 读数里的时间;日内只写时分,跨日或 withDate 时带月日。 */
export function timeLabel(t: string, withDate = false): string {
  const s = String(t || '');
  const hm = s.length >= 16 ? s.slice(11, 16) : '';
  const md = s.length >= 10 ? s.slice(5, 10) : s;
  if (!hm) return md;
  return withDate ? `${md} ${hm}` : hm;
}

// ---------------------------------------------------------------- 归一化

export interface Normalized {
  /** 去重、升序后的时间序列;下标 i 就是图表库里的 logical 下标 */
  times: string[];
  idx: Map<string, number>;
  /** 与 times 对齐的库内时间戳(秒) */
  stamps: number[];
  /** 时间串能按墙钟解析:轴刻度交给库按真实时间挑(跨日写日期);否则按下标造时间戳 */
  realTime: boolean;
  /** 有没有日内时分(决定轴上与十字光标要不要写时分) */
  intraday: boolean;
  barAt: Array<SpecBar | null>;
  lines: Array<SpecLine & { values: Array<number | null> }>;
  /** 最后一个有数据(蜡烛或折线)的下标:区域只画到这里,不铺到轴上 */
  lastIdx: number;
}

const TIME_RE = /^(\d{4})-?(\d{2})-?(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/;

/** 墙钟时间串 → 当 UTC 解释的秒数。图表库按 UTC 显示,于是轴上看到的正好是原来的墙钟。 */
export function wallClockSeconds(t: string): number | null {
  const m = TIME_RE.exec(String(t || '').trim());
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function normalize(spec: ChartSpec): Normalized {
  const raw = spec.times ?? (spec.bars ?? []).map((b) => b.time);
  // 库要求时间严格递增且不重复。调用方给的本来就是升序,这里只是兜底
  const parsed = raw.map((t) => ({ t: String(t), s: wallClockSeconds(String(t)) }));
  let realTime = parsed.length > 0 && parsed.every((p) => p.s !== null);
  const seen = new Set<string>();
  const uniq = parsed.filter((p) => (seen.has(p.t) ? false : (seen.add(p.t), true)));
  if (realTime) uniq.sort((a, b) => (a.s as number) - (b.s as number));
  const times = uniq.map((p) => p.t);
  let stamps = realTime ? uniq.map((p) => p.s as number) : times.map((_, i) => 86400 * (i + 1));
  // 解析后撞车(比如同一分钟出现两种写法):退回按下标,轴上的字也得跟着改成按下标取原串
  if (realTime && stamps.some((s, i) => i > 0 && s <= stamps[i - 1])) {
    stamps = times.map((_, i) => 86400 * (i + 1));
    realTime = false;
  }
  const idx = new Map(times.map((t, i) => [t, i] as const));
  const intraday = times.some((t) => t.length >= 16);

  const barAt: Array<SpecBar | null> = new Array(times.length).fill(null);
  for (const b of spec.bars ?? []) {
    const i = idx.get(String(b.time));
    if (i !== undefined && finite(b.open) && finite(b.high) && finite(b.low) && finite(b.close)) barAt[i] = b;
  }
  const lines = (spec.lines ?? []).map((ln) => {
    const values: Array<number | null> = new Array(times.length).fill(null);
    if (ln.values) {
      // values 与调用方给的 times 对齐;上面若去过重,要按原下标取
      raw.forEach((t, k) => {
        const i = idx.get(String(t));
        const v = ln.values?.[k];
        if (i !== undefined && finite(v)) values[i] = v;
      });
    } else if (ln.points) {
      for (const p of ln.points) {
        const i = idx.get(String(p.time));
        if (i !== undefined && finite(p.value)) values[i] = p.value;
      }
    }
    return { ...ln, values };
  });
  let lastIdx = times.length - 1;
  for (let i = times.length - 1; i >= 0; i -= 1) {
    if (barAt[i] || lines.some((l) => l.values[i] != null)) {
      lastIdx = i;
      break;
    }
  }
  return { times, idx, stamps, realTime, intraday, barAt, lines, lastIdx };
}
