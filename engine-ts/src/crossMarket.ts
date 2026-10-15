/** 跨市场跟跌套利(P0):美股大跌,而美股市场上的韩股 / A 股 ETF **没有同步跌**——它们的价还停在高处,
 * 等韩股 / A 股一开盘就会补跌,这段差价就是用户要的套利区间。纯计算,不联网、不读库;口径见 docs/features/events.md「跨市场」。
 *
 *  · 量"跟没跟"用不带杠杆的 ETF(韩股 EWY、A 股 ASHR):差 = ETF 当日涨跌 − 美股当日涨跌。美股跌 2.5%、EWY 只跌 0.5%,差就是 2.0 个点。
 *    差 ≥ lag_pct 才算没跟;ETF 跌得比指数还多(差为负)说明已经提前反映了,不报。上涨那一侧同样算(没跟涨 → 开盘补涨)。
 *  · 时间窗:从这一天美股开盘(09:30 美东)起——盘中差距一出现就该报,等收盘就晚了——到 A 股开盘后一小时。周五的隔着周末也报,挂到周一开盘。
 *  · 做成一条事件挂在最早开盘的那个市场上(韩股 09:00 首尔 = 美东 20:00 / 19:00),提前提醒、挂顶、过期都和别的事一样。
 *  · 这里不判断"套利一定成立":跟跌有时间差是经验,不是规律;报的是差了几个点,决定由人下。
 */
import type { CrossMarketLag, EconEvent } from "./contract/events.js";
import { ET, wallParts, wallToEpoch } from "./tz.js";

export interface CrossMarketCfg {
  /** 美股当日涨跌幅 % 的绝对值超过它才看 */
  pct: number;
  /** ETF 比指数少跌(少涨)这么多个点才算没跟 */
  lag_pct: number;
}

export interface CrossQuote {
  symbol: string;
  last: number | null;
  change_pct: number | null;
}

/** 两个市场:开盘的墙钟(都没有夏令时)、量跟没跟的 ETF、可以拿来做的 ETF */
export const CROSS_MARKETS = [
  { key: "kr", name: "韩股", offset: "+09:00", open: "09:00", measure: "EWY", instruments: ["EWY", "KORU"] },
  { key: "cn", name: "A 股", offset: "+08:00", open: "09:30", measure: "ASHR", instruments: ["ASHR", "FXI", "KWEB", "YINN"] },
] as const;

/** 要报价的全部 ETF */
export const CROSS_SYMBOLS: readonly string[] = [...new Set(CROSS_MARKETS.flatMap((m) => [...m.instruments]))];

/** 最晚开的市场开了一小时之后这件事就过去了 */
export const CROSS_LINGER_MIN = 60;

function offsetMs(offset: string): number {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
}

/** 下一次 open(HH:MM,固定偏移 offset 的墙钟)在 now − grace 之后的那一天;落在周六日的顺延到周一 */
export function nextOpen(now: number, offset: string, open: string, graceMs = 0): number {
  const dayStr = (t: number): string => new Date(t + offsetMs(offset)).toISOString().slice(0, 10);
  let day = dayStr(now - graceMs);
  for (let i = 0; i < 8; i += 1) {
    const at = Date.parse(`${day}T${open}:00${offset}`);
    const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (at >= now - graceMs && dow !== 0 && dow !== 6) return at;
    day = dayStr(Date.parse(`${day}T12:00:00Z`) + 86_400_000);
  }
  return Date.parse(`${day}T${open}:00${offset}`);
}

export interface CrossWindow {
  /** 各市场下一次开盘(同一个日历日的早上) */
  opens: Array<{ key: string; name: string; at: number }>;
  first: number;
  last: number;
  /** 对应的那个美股交易日的开盘(09:30 美东) */
  start: number;
}

/** 这个亚洲开盘对应的美股交易日的开盘(09:30 美东):A 股开盘往前 6 小时落在哪个美东日就是那一天,落在周末的退到周五 */
export function usSessionStart(lastOpen: number): number {
  let p = wallParts(lastOpen - 6 * 3600_000, ET);
  for (let i = 0; i < 3; i += 1) {
    const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
    if (dow !== 0 && dow !== 6) break;
    p = wallParts(wallToEpoch({ year: p.year, month: p.month, day: p.day, hour: 12, minute: 0, second: 0 }, ET) - 24 * 3600_000, ET);
  }
  return wallToEpoch({ year: p.year, month: p.month, day: p.day, hour: 9, minute: 30, second: 0 }, ET);
}

/**
 * 此刻在不在"这个美股交易日开盘之后、亚洲还没开完"的窗口里;不在回 null。
 * 最晚开的是 A 股,先算它下一次开盘(开盘后一小时内还算这一次),别的市场取同一个日历日的早上——各算各的话,
 * 韩股刚开过一小时而 A 股还没开的那半小时里会把韩股算到明天去。
 */
export function crossWindow(now: number): CrossWindow | null {
  const grace = CROSS_LINGER_MIN * 60_000;
  const cn = CROSS_MARKETS.find((m) => m.key === "cn") ?? CROSS_MARKETS[1];
  const last = nextOpen(now, cn.offset, cn.open, grace);
  const day = new Date(last + offsetMs(cn.offset)).toISOString().slice(0, 10);
  const opens = CROSS_MARKETS.map((m) => ({ key: m.key, name: m.name, at: Date.parse(`${day}T${m.open}:00${m.offset}`) }));
  const first = Math.min(...opens.map((o) => o.at));
  const start = usSessionStart(last);
  if (now < start || now > last + grace) return null;
  return { opens, first, last, start };
}

function signed(p: number, digits = 1): string {
  return `${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p).toFixed(digits)}%`;
}

/**
 * 判一次:美股当日涨跌 + 各 ETF 当日涨跌 → 要不要报、报什么。没在窗口里、美股没大动、ETF 都跟上了、量不到 ETF 的价,都回 null。
 * 两个市场只要有一个没跟就报,挂在没跟的市场里最早开的那个上。
 */
export function evaluateCrossMarket(
  usPct: number | null, quotes: Record<string, CrossQuote>, now: number, cfg: CrossMarketCfg,
): EconEvent | null {
  const window = crossWindow(now);
  if (!window || usPct === null || !Number.isFinite(usPct) || Math.abs(usPct) < cfg.pct) return null;
  const direction = usPct < 0 ? "down" : "up";
  const lags: CrossMarketLag[] = [];
  for (const m of CROSS_MARKETS) {
    const measure = quotes[m.measure];
    const etfPct = measure?.change_pct;
    if (etfPct === null || etfPct === undefined || !Number.isFinite(etfPct)) continue;
    // 差 = ETF − 指数;跌的时候差为正是没跟跌,涨的时候差为负是没跟涨
    const gap = Math.round((etfPct - usPct) * 100) / 100;
    const lagging = direction === "down" ? gap >= cfg.lag_pct : -gap >= cfg.lag_pct;
    if (!lagging) continue;
    const open = window.opens.find((o) => o.key === m.key);
    lags.push({
      key: m.key, name: m.name, symbol: m.measure, etf_pct: etfPct, gap: Math.abs(gap), open_at: open?.at ?? window.first,
      instruments: m.instruments.map((s) => ({ symbol: s, change_pct: quotes[s]?.change_pct ?? null, last: quotes[s]?.last ?? null })),
    });
  }
  if (!lags.length) return null;
  const at = Math.min(...lags.map((l) => l.open_at));
  const date = new Date(at).toLocaleDateString("en-CA", { timeZone: ET });
  const time = new Date(at).toLocaleTimeString("en-GB", { timeZone: ET, hour: "2-digit", minute: "2-digit", hour12: false });
  const verb = direction === "down" ? "跌" : "涨";
  const names = lags.map((l) => l.name).join(" / ");
  const detail = lags.map((l) => `${l.name} ${l.symbol} ${signed(l.etf_pct)}(差 ${l.gap.toFixed(1)} 点)`).join(";");
  return {
    id: `cross:${date}:${direction}`,
    kind: "cross",
    title: `美股 ${signed(usPct)},${names} ETF 没跟${verb}:开盘可能补${verb}`,
    at,
    date_et: date,
    time_et: time,
    stars: 5,
    impact: "high",
    source: "builtin",
    linger_min: Math.round((window.last - at) / 60_000) + CROSS_LINGER_MIN,
    note: `${detail}。开盘前${direction === "down" ? "做空" : "做多"}这些 ETF(${lags.map((l) => l.instruments.map((i) => i.symbol).join(" / ")).join(";")})是套利区间;3 倍杠杆的一天能走 10% 以上,先看 TWS 里的盘后价。`,
    cross: { direction, us_pct: usPct, markets: lags },
  };
}
