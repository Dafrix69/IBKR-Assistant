/** 行情快照的标的抽取(对应 Python market.py,§3 轻量正则预处理)。 */
import type { Settings } from "./config.js";

const TICKER_RE = /[A-Za-z]{1,5}/g;

const STOPWORDS = new Set([
  "BUY", "SELL", "CALL", "PUT", "LMT", "MKT", "STP", "GTC", "DAY", "USD",
  "AT", "TO", "THE", "AND", "OR", "IF", "ON", "OF", "IN", "FOR", "WITH",
  "LIMIT", "MARKET", "STOP", "SPREAD", "OPEN", "CLOSE", "DTE", "ITM", "OTM",
  "A", "AN", "IS", "BE", "PM", "AM", "ET",
]);

// 即使紧贴中文/数字也绝不当 ticker 的记号:'25cm' 是本系统用户的翼宽行话
const HARD_EXCLUDE = new Set(["CM"]);

function isLatin(ch: string): boolean {
  return /^[A-Za-z]$/.test(ch);
}

function cjkAdjacent(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1]! : "";
  const after = end < text.length ? text[end]! : "";
  const hit = (ch: string): boolean =>
    Boolean(ch) && ((ch >= "一" && ch <= "鿿") || /^\d$/.test(ch));
  return hit(before) || hit(after);
}

/** 抽出指令里出现的候选标的:显式 ticker + 中文别名表命中 + 常驻指数。 */
export function extractSymbols(
  text: string,
  settings: Settings,
  extra?: string[] | null,
  defaultIndex = true,
): string[] {
  const found: string[] = [];
  const add = (symbol: string): void => {
    symbol = symbol.toUpperCase();
    if (symbol && !found.includes(symbol)) found.push(symbol);
  };

  const known = new Set(Object.values(settings.symbol_aliases));
  for (const m of text.matchAll(TICKER_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (
      (start > 0 && isLatin(text[start - 1]!)) ||
      (end < text.length && isLatin(text[end]!))
    ) {
      continue; // 长英文单词的一部分,不是 ticker
    }
    const raw = m[0];
    const token = raw.toUpperCase();
    const cjkCtx = cjkAdjacent(text, start, end);
    if (HARD_EXCLUDE.has(token)) continue;
    if (STOPWORDS.has(token) && !cjkCtx) continue;
    if (token in settings.index_symbols || known.has(token)) {
      add(token);
    } else if (token.length >= 2 && (raw === raw.toUpperCase() || cjkCtx)) {
      add(token);
    }
  }

  for (const [name, ticker] of Object.entries(settings.symbol_aliases)) {
    if (name && text.includes(name)) add(ticker);
  }

  const upper = text.toUpperCase();
  for (const symbol of Object.keys(settings.index_symbols)) {
    if (upper.includes(symbol)) add(symbol);
  }

  for (const symbol of extra ?? []) add(symbol);

  // 兜底:什么标的都没抽到时补 SPX
  if (defaultIndex && !found.length && "SPX" in settings.index_symbols) add("SPX");
  return found;
}

/** 按抽出的标的拉现价。任何一个失败都只是少一行快照,不中断解析。 */
export function buildSnapshot(
  symbols: string[],
  priceLookup: (symbol: string) => number | null | undefined,
  cached?: Record<string, number> | null,
): Record<string, number> {
  const snapshot: Record<string, number> = {};
  for (const symbol of symbols) {
    if (cached && symbol in cached) {
      snapshot[symbol] = Number(cached[symbol]);
      continue;
    }
    let price: number | null | undefined;
    try {
      price = priceLookup(symbol);
    } catch {
      price = null; // 行情失败不阻断解析
    }
    if (price) snapshot[symbol] = Number(price);
  }
  return snapshot;
}
