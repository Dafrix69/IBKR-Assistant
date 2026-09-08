/** 标的情报采集(对应 Python research.py)。数字由代码算,叙事才交给 LLM。 */
import { macdHist, realizedVol, rsi, sma } from "./backtest.js";
import { fmtSF, pyFloat, pyRound } from "./py.js";
import { dateOrdinal, ordinalToDate, weekdayOfDate } from "./tz.js";

const WEEKDAY_MAP: Record<string, number> = {
  "一": 0, "二": 1, "三": 2, "四": 3, "五": 4, "六": 5, "日": 6, "天": 6,
};

/** 把想法里的相对时间解析成具体的价格锚点。解析不出就 null,绝不瞎猜。 */
export function resolveAnchor(
  text: string, bars: Array<Record<string, any>>, todayIso: string,
): Record<string, unknown> | null {
  if (!bars.length) return null;

  let targetOrdinal: number | null = null;
  let label = "";
  const todayOrd = dateOrdinal(todayIso);
  const todayWd = weekdayOfDate(todayIso);

  let m = /上周([一二三四五])/.exec(text);
  const thisWeek = /(?<!上)(?:本?周)([一二三四五])/.exec(text);
  if (m) {
    const wd = WEEKDAY_MAP[m[1]!]!;
    const thisMonday = todayOrd - todayWd;
    targetOrdinal = thisMonday - 7 + wd;
    label = `上周${m[1]}`;
  } else if (thisWeek) {
    const wd = WEEKDAY_MAP[thisWeek[1]!]!;
    const back = (((todayWd - wd) % 7) + 7) % 7;
    targetOrdinal = todayOrd - back;
    label = `周${thisWeek[1]}`;
  } else if (text.includes("前天")) {
    targetOrdinal = todayOrd - 2;
    label = "前天";
  } else if (text.includes("昨天") || text.includes("昨日")) {
    targetOrdinal = todayOrd - 1;
    label = "昨天";
  }
  if (targetOrdinal === null) return null;

  const targetIso = ordinalToDate(targetOrdinal);
  let bar: Record<string, any> | null = null;
  for (const b of bars) {
    // bars 升序:取 ≤ 目标日的最后一根(ISO 字符串可直接比较)
    if (String(b["date"]) <= targetIso) bar = b;
    else break;
  }
  if (bar === null) return null;

  const useOpen = text.includes("开盘");
  const price = Number(bar[useOpen ? "open" : "close"]);
  const last = Number(bars[bars.length - 1]!["close"]);
  return {
    label: `${label}(${bar["date"]})${useOpen ? "开盘价" : "收盘价"}`,
    date: bar["date"],
    price: pyRound(price, 2),
    chg_from_anchor_pct: price ? pyRound((last / price - 1.0) * 100.0, 2) : null,
  };
}

/** 从日线(升序 OHLC)计算标的情报。数据不足的项直接省略。 */
export function symbolBrief(bars: Array<Record<string, any>>): Record<string, unknown> {
  const closes = bars.map((b) => Number(b["close"]));
  const highs = bars.map((b) => Number(b["high"]));
  const lows = bars.map((b) => Number(b["low"]));
  if (closes.length < 2) return {};

  const last = closes[closes.length - 1]!;
  const out: Record<string, unknown> = { last: pyRound(last, 2), bars: bars.length };

  for (const [n, key] of [
    [1, "chg_1d_pct"], [5, "chg_5d_pct"], [20, "chg_20d_pct"], [60, "chg_60d_pct"],
  ] as Array<[number, string]>) {
    if (closes.length > n) {
      out[key] = pyRound((last / closes[closes.length - 1 - n]! - 1.0) * 100.0, 2);
    }
  }

  out["vol20_annual_pct"] = pyRound(realizedVol(closes) * 100.0, 1);

  const rsiLast = closes.length > 15 ? rsi(closes, 14)[closes.length - 1] : null;
  if (rsiLast !== null) out["rsi14"] = pyRound(rsiLast!, 1);

  for (const [window, key] of [[50, "vs_sma50_pct"], [200, "vs_sma200_pct"]] as Array<[number, string]>) {
    const smaLast = closes.length >= window ? sma(closes, window)[closes.length - 1] : null;
    if (smaLast) out[key] = pyRound((last / smaLast - 1.0) * 100.0, 2);
  }

  const macd = closes.length > 40 ? macdHist(closes)[closes.length - 1] : null;
  if (macd !== null && macd !== undefined) out["macd_hist"] = pyRound(macd, 3);

  const lookback = Math.min(bars.length, 252);
  const hi = Math.max(...highs.slice(-lookback));
  const lo = Math.min(...lows.slice(-lookback));
  if (hi) out["from_52w_high_pct"] = pyRound((last / hi - 1.0) * 100.0, 2);
  if (lo) out["from_52w_low_pct"] = pyRound((last / lo - 1.0) * 100.0, 2);
  return out;
}

/** 把情报拼成给模型看的中文块。没有数据时明说。 */
export function briefText(
  symbol: string | null, brief: Record<string, unknown> | null,
): string {
  if (!symbol) return "标的行情情报:(想法中未识别出标的,无行情数据)";
  if (!brief || !Object.keys(brief).length) {
    return `标的行情情报:(未连接券商网关或无法获取 ${symbol} 的行情数据)`;
  }
  if (brief["error"]) return `标的行情情报:(获取 ${symbol} 行情失败:${brief["error"]})`;

  const lines = [`标的行情情报(${symbol},软件按日线计算,最新价可能有 15 分钟延迟):`];
  const labelMap: Array<[string, string, string]> = [
    ["last", "现价", ""],
    ["chg_1d_pct", "1日涨跌", "%"],
    ["chg_5d_pct", "5日涨跌", "%"],
    ["chg_20d_pct", "20日涨跌", "%"],
    ["chg_60d_pct", "60日涨跌", "%"],
    ["vol20_annual_pct", "20日已实现波动率(年化)", "%"],
    ["rsi14", "RSI(14)", ""],
    ["vs_sma50_pct", "相对50日均线", "%"],
    ["vs_sma200_pct", "相对200日均线", "%"],
    ["macd_hist", "MACD柱(12/26/9)", ""],
    ["from_52w_high_pct", "距52周最高", "%"],
    ["from_52w_low_pct", "距52周最低", "%"],
  ];
  const parts = labelMap
    .filter(([key]) => key in brief)
    .map(([key, label, unit]) => {
      const v = brief[key];
      return `${label} ${typeof v === "number" ? pyFloat(v) : v}${unit}`;
    });
  lines.push(parts.join(";"));

  const anchor = brief["anchor"] as Record<string, unknown> | undefined;
  if (anchor) {
    lines.push(
      `价格锚点(按想法里的时间引用解析):${anchor["label"]} = ${pyFloat(anchor["price"] as number)};` +
      `现价较锚点 ${fmtSF((anchor["chg_from_anchor_pct"] as number) || 0.0, 2)}%。` +
      "想法中的买入价指的是这个锚点价位,不是现价——请围绕锚点评估:" +
      "按锚点算浮盈浮亏多少、现在追与等回调到锚点各意味着什么。",
    );
  }
  return lines.join("\n");
}
