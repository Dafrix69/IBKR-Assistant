/** 一句话里提到了哪几只标的(docs/features/intel.md)。纯函数,零依赖:Discord 消息、自定义事件、想法原文都走它。
 *
 * 红线和本地速记一样:**不猜方向、不猜意图**,这里只回答"提到了谁"。认的办法按可靠程度分五档(MentionHow):
 *   cashtag  `$NVDA`——写了美元号的一定是代码
 *   known    名单里有的代码(持仓、股票池、板块、提醒、指数、别名表的值):大小写都认,「spx 7700 蝴蝶」是 SPX
 *   alias    中文名或常用叫法(「英伟达」「标普」「Nvidia」):内置一张小表,配置里的 symbol_aliases 盖在上面
 *   implied  没写标的、但按行话能定的:「7700 7725 bear call」「15蝴蝶 15CM」在 SPX 的频道里就是 SPX
 *   guess    像代码的大写词(2 ~ 5 个字母)但名单里没有:只作参考,时间线上单独列、不算"提到"
 * 同一只认出几次只留最可靠的那一次;顺序按原文里出现的先后。
 */
import type { Mention, MentionHow } from "./contract/intel.js";

export interface MentionUniverse {
  /** 名单里的代码(大写) */
  known: ReadonlySet<string>;
  /** 叫法 → 代码(大写)。中文按子串找;拉丁字母的按整词、不分大小写 */
  aliases: Readonly<Record<string, string>>;
  /** 没写标的的行话默认算谁的;null = 不推断 */
  implied: string | null;
}

/** 内置的叫法表:常见的中文名与英文名。配置里的 symbol_aliases 优先级更高(同一个叫法以配置为准)。 */
export const BUILTIN_ALIASES: Readonly<Record<string, string>> = {
  苹果: "AAPL", 英伟达: "NVDA", 特斯拉: "TSLA", 微软: "MSFT", 谷歌: "GOOGL", 亚马逊: "AMZN", 奈飞: "NFLX", 网飞: "NFLX",
  台积电: "TSM", 阿里巴巴: "BABA", 拼多多: "PDD", 京东: "JD", 百度: "BIDU", 蔚来: "NIO", 小鹏: "XPEV", 理想汽车: "LI",
  博通: "AVGO", 英特尔: "INTC", 美光: "MU", 甲骨文: "ORCL", 迪士尼: "DIS", 波音: "BA", 可口可乐: "KO", 麦当劳: "MCD",
  沃尔玛: "WMT", 开市客: "COST", 摩根大通: "JPM", 小摩: "JPM", 大摩: "MS", 高盛: "GS", 微策略: "MSTR", 超威: "AMD", 超微: "SMCI",
  标普: "SPX", 标普500: "SPX", 标普五百: "SPX", 纳指: "NDX", 纳斯达克: "NDX", 恐慌指数: "VIX",
  Nvidia: "NVDA", Tesla: "TSLA", Apple: "AAPL", Amazon: "AMZN", Google: "GOOGL", Alphabet: "GOOGL", Microsoft: "MSFT",
  Netflix: "NFLX", Broadcom: "AVGO", Micron: "MU", Palantir: "PLTR", Coinbase: "COIN", Meta: "META", Oracle: "ORCL",
};

/** 不用名单也认的几只:指数、最常见的 ETF 与期货。 */
export const BUILTIN_KNOWN: readonly string[] = ["SPX", "SPY", "QQQ", "NDX", "VIX", "IWM", "DIA", "TLT", "GLD", "ES", "NQ", "RUT"];

/** 大写词里不是代码的那些:交易行话、单位、月份、聊天缩写。guess 这一档不收它们;名单里有的照样认(名单是人填的)。 */
const STOPLIST = new Set([
  "AM", "PM", "ET", "EST", "EDT", "PT", "CT", "GTC", "DAY", "DTE", "CM", "CALL", "CALLS", "PUT", "PUTS", "BUY", "SELL", "LONG", "SHORT",
  "BULL", "BEAR", "SPREAD", "ITM", "OTM", "ATM", "IV", "HV", "RSI", "MACD", "VWAP", "EMA", "SMA", "MA", "ATR", "ADR", "HOD", "LOD", "PDH",
  "PDL", "ORB", "EOD", "BTD", "FOMO", "YOLO", "LOL", "LMAO", "OMG", "OK", "OKAY", "FYI", "IMO", "IMHO", "TBH", "BTW", "ASAP", "CPI", "PPI",
  "PCE", "GDP", "FOMC", "FED", "NFP", "ISM", "PMI", "JOLTS", "CEO", "CFO", "CTO", "IPO", "ETF", "AI", "ML", "USD", "CNY", "RMB", "HKD",
  "JPY", "EUR", "GBP", "TV", "PC", "NYSE", "NASDAQ", "CBOE", "CME", "NY", "US", "USA", "UK", "EU", "CN", "HK", "CA", "FY", "YOY", "QOQ",
  "MOM", "EPS", "PE", "PEG", "ROE", "ROI", "RTH", "ETH", "AH", "BPS", "BCS", "IC", "IB", "TWS", "API", "APP", "LMT", "MKT", "STP", "SL",
  "TP", "TL", "BE", "RR", "RVOL", "VOL", "OI", "DD", "TA", "FA", "PA", "BOS", "CHOCH", "FVG", "OB", "SMC", "ICT", "MAX", "MIN", "AVG", "EM",
  "STD", "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "SEPT", "OCT", "NOV", "DEC", "MON", "TUE", "WED", "THU", "FRI",
  "SAT", "SUN", "TODAY", "NOW", "NEW", "OLD", "HIGH", "LOW", "OPEN", "CLOSE", "GAP", "UP", "DOWN", "AND", "OR", "THE", "FOR", "NOT", "BUT",
  "YES", "NO", "ALL", "ANY", "GO", "ON", "OFF", "IN", "OUT", "AT", "TO", "BY", "IT", "IS", "AS", "WE", "ME", "MY", "SO", "DO", "IF", "GM",
  "GN", "LFG", "ATH", "ATL", "DCA", "HODL", "PNL", "P/L", "EV", "NFA", "DYOR", "JPOW", "FEDS", "QE", "QT", "YTD", "MTD", "WTD",
]);

/** 名单里的代码被小写着写的时候,这些普通英文词不算(「all in」里的 all 不是 Allstate)。 */
const COMMON_WORDS = new Set([
  "all", "for", "are", "the", "and", "but", "not", "you", "can", "now", "out", "put", "call", "buy", "sell", "long", "short", "open",
  "close", "high", "low", "big", "run", "gap", "new", "old", "one", "two", "day", "week", "hold", "stop", "loss", "win", "gain", "see",
  "add", "cut", "key", "pay", "net", "max", "min", "top", "bid", "ask", "mid", "fly", "wing", "leg", "legs", "play", "trade", "size",
  "it", "is", "in", "on", "at", "to", "by", "me", "my", "so", "do", "if", "go", "no", "or", "as", "an", "be", "up", "ok",
]);

const PRIORITY: Record<MentionHow, number> = { cashtag: 0, known: 1, alias: 2, implied: 3, guess: 4 };

interface Candidate extends Mention {
  index: number;
}

/** 摘掉提及、链接、表情代码:它们里面的字母不是代码。 */
function stripNoise(text: string): string {
  return text
    .replace(/<a?:[A-Za-z0-9_]+:\d+>/g, " ")
    .replace(/<[@#][!&]?\d+>/g, " ")
    .replace(/@(?:everyone|here)(?![A-Za-z])/gi, " ")
    .replace(/https?:\/\/\S+/gi, " ");
}

/** 这句话像不像一张期权单(没写标的时拿来推断):蝴蝶、翼宽记号、价差类型词、两个挨着的行权价。 */
export function looksLikeOptionTalk(text: string): boolean {
  if (/蝴蝶|铁鹰|价差/.test(text)) return true;
  if (/\d\s*cm(?![A-Za-z])|翼宽\s*\d|±\s*\d+(?:\.\d+)?\s*点/i.test(text)) return true;
  if (/(?<![A-Za-z])(bull\s*put|bear\s*call|call\s*spread|put\s*spread)(?![A-Za-z])/i.test(text)) return true;
  if (/(?<![\d.])\d{4}\s+\d{4}(?![\d.])/.test(text)) return true;
  if (/(?<![\d.])\d{3,4}\s*[CP](?![A-Za-z])/i.test(text)) return true;
  return false;
}

function pushBest(out: Map<string, Candidate>, c: Candidate): void {
  const prev = out.get(c.symbol);
  if (prev === undefined || PRIORITY[c.how] < PRIORITY[prev.how] || (PRIORITY[c.how] === PRIORITY[prev.how] && c.index < prev.index)) {
    out.set(c.symbol, c);
  }
}

export function extractMentions(rawText: string, universe: MentionUniverse): Mention[] {
  const text = stripNoise((rawText ?? "").normalize("NFKC"));
  const found = new Map<string, Candidate>();

  // 1. cashtag
  for (const m of text.matchAll(/\$([A-Za-z]{1,5}(?:\.[A-Za-z])?)(?![A-Za-z])/g)) {
    pushBest(found, { symbol: m[1]!.toUpperCase(), how: "cashtag", term: m[0], index: m.index ?? 0 });
  }

  // 2. 叫法:长的先找(「标普500」先于「标普」),找到的那一段不再参与别的匹配
  const aliasEntries = Object.entries(universe.aliases).sort((a, b) => b[0].length - a[0].length);
  let masked = text;
  for (const [term, symbol] of aliasEntries) {
    if (!term) continue;
    const latin = /^[A-Za-z][A-Za-z.&' -]*$/.test(term);
    const re = latin
      ? new RegExp(`(?<![A-Za-z])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z])`, "gi")
      : new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    masked = masked.replace(re, (hit: string, offset: number) => {
      pushBest(found, { symbol: symbol.toUpperCase(), how: "alias", term: hit, index: offset });
      return " ".repeat(hit.length);
    });
  }

  // 3. 名单里的代码与像代码的词
  const tokens = [...masked.matchAll(/(?<![A-Za-z$])[A-Za-z][A-Za-z]{0,5}(?:\.[A-Za-z])?(?![A-Za-z])/g)];
  const letterTokens = tokens.filter((m) => m[0].length >= 2);
  const upperCount = letterTokens.filter((m) => m[0] === m[0].toUpperCase()).length;
  // 整句都在喊(大写词占多数、又不止几个)时,大写不说明是代码:这一句不猜
  const shouting = letterTokens.length > 4 && upperCount / letterTokens.length > 0.6;
  for (const m of tokens) {
    const word = m[0];
    const upper = word.toUpperCase();
    const index = m.index ?? 0;
    // 「15CM」「0dte」「7700C」这种紧贴着数字的字母是单位或方向,不是代码
    const before = index > 0 ? masked[index - 1] ?? "" : "";
    if (/\d/.test(before)) continue;
    const isUpper = word === upper;
    if (universe.known.has(upper)) {
      if (!isUpper && (word.length < 3 || COMMON_WORDS.has(word.toLowerCase()))) continue;
      pushBest(found, { symbol: upper, how: "known", term: word, index });
      continue;
    }
    if (isUpper && word.length >= 2 && word.length <= 5 && !STOPLIST.has(upper) && !shouting) {
      pushBest(found, { symbol: upper, how: "guess", term: word, index });
    }
  }

  // 4. 没写标的的行话
  const confident = [...found.values()].some((c) => c.how !== "guess");
  if (!confident && universe.implied && looksLikeOptionTalk(masked)) {
    pushBest(found, { symbol: universe.implied.toUpperCase(), how: "implied", term: "", index: Number.MAX_SAFE_INTEGER });
  }

  return [...found.values()]
    .sort((a, b) => a.index - b.index)
    .map(({ symbol, how, term }) => ({ symbol, how, term }));
}

/** 一份名单 + 叫法表 + 默认标的。调用方把持仓、股票池、板块、提醒、指数、配置里的别名都递进来。 */
export function makeUniverse(
  known: Iterable<string>, aliases: Readonly<Record<string, string>> = {}, implied: string | null = "SPX",
): MentionUniverse {
  const set = new Set<string>(BUILTIN_KNOWN);
  for (const s of known) {
    const u = String(s ?? "").trim().toUpperCase();
    if (u) set.add(u);
  }
  for (const v of Object.values(aliases)) set.add(String(v).toUpperCase());
  for (const v of Object.values(BUILTIN_ALIASES)) set.add(v);
  return { known: set, aliases: { ...BUILTIN_ALIASES, ...aliases }, implied };
}

/** 只要认出来的那几只(不含 guess),去重、按先后。 */
export function confidentSymbols(mentions: readonly Mention[]): string[] {
  return [...new Set(mentions.filter((m) => m.how !== "guess").map((m) => m.symbol))];
}

export function guessedSymbols(mentions: readonly Mention[]): string[] {
  return [...new Set(mentions.filter((m) => m.how === "guess").map((m) => m.symbol))];
}
