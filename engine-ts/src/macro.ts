/** 宏观行情带(对应 Python macro.py)。
 *
 * TWS 流式 + 公开数据源双来源;VIX 与美债10Y 永远走公开源(没有不失真的 ETF
 * 替身:VIXY 有 contango 损耗,TLT 与收益率反向)。比特币不用 IBIT(差一个量级),
 * 连 TWS 时读 PAXOS 现货。固定清单写死在代码里,界面不可注入任意符号。
 */
import { pyRound } from "./py.js";

const ENDPOINT = "https://query1.finance.yahoo.com/v8/finance/chart/%s?interval=1d&range=5d";

// live = 已连 TWS 时改读的那个 ETF;null 表示这一格永远走公开源。
export const MACRO_SYMBOLS: Array<Record<string, any>> = [
  { key: "^GSPC", label: "标普500", fmt: "price", live: "SPY" },
  { key: "^NDX", label: "纳指100", fmt: "price", live: "QQQ" },
  { key: "^VIX", label: "VIX", fmt: "plain", live: null }, // VIXY 会失真
  { key: "^TNX", label: "美债10Y", fmt: "pct", live: null }, // TLT 方向相反
  { key: "GC=F", label: "黄金", fmt: "price", live: "GLD" },
  { key: "BZ=F", label: "布油", fmt: "price", live: "BNO" }, // 布伦特,不是 WTI
  // 比特币要的是币价本身(几万美元),IBIT 差一个量级,看着像行情崩了。
  // 连着 TWS 时读 PAXOS 现货(免订阅,真机实测);断开时公开源 BTC-USD 兜底。
  { key: "BTC-USD", label: "比特币", fmt: "price", live: "CRYPTO:BTC", liveLabel: "PAXOS" },
];

interface CacheHit {
  at: number;
  row: Record<string, any>;
}

const CACHE = new Map<string, CacheHit>();

const TTL_IDLE = 60.0;
const TTL_LIVE = 10.0;

// 陈旧即返、后台刷新(stale-while-revalidate,对应 Python 同名逻辑)。
// 引擎的 RPC 顺序处理:界面每 2 秒打一次行情带,一格公开源最多等 6 秒,
// 这段时间里用户的「解析并校验」只能排队。过期但没老到没用的格子先把旧值
// 交出去,新值在后台取;只有从来没取到过的格子才同步等。
const MAX_STALE = 600.0;
const INFLIGHT = new Set<string>();

function refreshInBackground(
  key: string, fetchRow: () => Promise<Record<string, any> | null>, now: () => number,
): void {
  if (INFLIGHT.has(key)) return; // 单飞:同一键同一时刻只允许一个后台请求
  INFLIGHT.add(key);
  fetchRow()
    .then((row) => {
      if (row && row["last"] !== null && row["last"] !== undefined) {
        CACHE.set(key, { at: now(), row });
      }
    })
    .catch(() => undefined) // 后台刷新失败只是这一轮没更新,下一轮再试
    .finally(() => INFLIGHT.delete(key));
}

export interface Router {
  streamQuotes(tickers: string[]): Record<string, { last?: number | null; change_pct?: number | null }> | null;
}

export type Fetcher = (url: string, timeoutMs: number) => Promise<unknown>;

export function liveTickers(): string[] {
  return MACRO_SYMBOLS.filter((i) => i["live"]).map((i) => i["live"] as string);
}

/** 整条宏观行情带。router 给了且连着,就优先走 TWS 流式。 */
export async function macroBoard(
  options: {
    timeout?: number;
    force?: boolean;
    router?: Router | null;
    fetcher?: Fetcher;
    now?: () => number;
  } = {},
): Promise<Record<string, any>> {
  const timeout = options.timeout ?? 6.0;
  const now = options.now ?? (() => Date.now() / 1000);
  const fetcher = options.fetcher ?? defaultFetcher;

  let quotes: Record<string, { last?: number | null; change_pct?: number | null }> = {};
  if (options.router) {
    try {
      quotes = options.router.streamQuotes(liveTickers()) ?? {};
    } catch {
      quotes = {}; // 行情带永远不该把界面搞崩
    }
  }

  const ttl = options.force ? 0.0 : Object.keys(quotes).length ? TTL_LIVE : TTL_IDLE;
  const rows: Array<Record<string, any>> = [];
  for (const item of MACRO_SYMBOLS) {
    const quote = quotes[(item["live"] as string) ?? ""] ?? {};
    if (quote.last !== null && quote.last !== undefined) {
      rows.push({
        key: item["key"], label: item["label"], fmt: item["fmt"],
        last: quote.last, change_pct: quote.change_pct ?? null,
        source: "tws", instrument: item["liveLabel"] ?? item["live"],
      });
    } else {
      // 用户点了强制刷新才同步等;周期轮询一律"旧值先给、后台去取"
      const row = await cachedFetch(item, timeout, ttl, fetcher, now, !options.force);
      row["source"] = "public";
      // 主源挂掉、由 Cboe 兜回来的格子已经自报了 instrument,别在这里抹掉
      row["instrument"] = row["instrument"] ?? null;
      rows.push(row);
    }
  }

  return {
    rows,
    at: now(),
    live_count: rows.filter((r) => r["source"] === "tws").length,
  };
}

/** 速记解析要现价 → 公开源。固定清单:界面不可注入任意符号。
 * 首选 Cboe 官方延迟接口(SPX/VIX 本来就是 Cboe 的指数,免鉴权、15 分钟延迟);
 * Yahoo 只作备用——它对非浏览器 UA 经常直接 403。 */
const CBOE_INDEX = new Set(["SPX", "NDX", "VIX", "RUT"]);
const CBOE_ENDPOINT = "https://cdn.cboe.com/api/global/delayed_quotes/quotes/_%s.json";
const PUBLIC_INDEX: Record<string, string> = {
  SPX: "^GSPC", NDX: "^NDX", VIX: "^VIX", RUT: "^RUT", DJI: "^DJI",
};

/** Cboe delayed_quotes 载荷 → 最新价(纯函数,单测用)。 */
export function cboeLast(payload: any): number | null {
  const data = payload?.data ?? {};
  return num(data["current_price"]) ?? num(data["close"]);
}

/** 公开源的指数现价(延迟 15 分钟内,30 秒缓存)。
 *
 * 给本地速记解析兜底用:没连 TWS 时「15蝴蝶」的中心(现价百位+N)也要算得出。
 * 只认固定清单;取不到回 null,由调用方决定回落到大模型。 */
export async function publicIndexPrice(
  symbol: string, timeout = 4.0, fetcher: Fetcher = defaultFetcher,
): Promise<number | null> {
  const sym = (symbol ?? "").toUpperCase();
  if (CBOE_INDEX.has(sym)) {
    const now = Date.now() / 1000;
    const cacheKey = `cboe:${sym}`;
    const hit = CACHE.get(cacheKey);
    if (hit && now - hit.at < 30.0) return num(hit.row["last"]);
    const fetchCboe = async (): Promise<Record<string, any> | null> => {
      try {
        const payload = await fetcher(CBOE_ENDPOINT.replace("%s", sym), timeout * 1000);
        const price = cboeLast(payload);
        return price === null ? null : { last: price };
      } catch {
        return null;
      }
    };
    if (hit && now - hit.at < MAX_STALE) {
      // 速记解析等在这条线上:旧值(本来就是 15 分钟延迟的数)先给,后台换新
      refreshInBackground(cacheKey, fetchCboe, () => Date.now() / 1000);
      return num(hit.row["last"]);
    }
    const fresh = await fetchCboe();
    if (fresh !== null) {
      CACHE.set(cacheKey, { at: now, row: fresh });
      return num(fresh["last"]);
    }
    if (hit) return num(hit.row["last"]);
  }
  const key = PUBLIC_INDEX[sym];
  if (key === undefined) return null;
  const row = await cachedFetch(
    { key, label: symbol, fmt: "price" }, timeout, 30.0, fetcher, () => Date.now() / 1000,
  );
  const last = row["last"];
  return last === null || last === undefined ? null : Number(last);
}

/** 带缓存的单格取数。取失败时保留上一次的值并标记陈旧。
 * background=true 时过期的旧值先返回(标 refreshing),新值后台去取;
 * 只有从没取到过、或旧得超过 MAX_STALE 的才同步等。 */
async function cachedFetch(
  item: Record<string, any>, timeout: number, ttl: number, fetcher: Fetcher, now: () => number,
  background = true,
): Promise<Record<string, any>> {
  const ts = now();
  const hit = CACHE.get(item["key"]);
  if (hit && ts - hit.at < ttl) return { ...hit.row, cached: true };
  if (background && hit && ts - hit.at < MAX_STALE) {
    refreshInBackground(item["key"], () => fetchOne(item, timeout, fetcher), now);
    return { ...hit.row, cached: true, refreshing: true };
  }

  const row = await fetchOne(item, timeout, fetcher);
  if (row["last"] !== null && row["last"] !== undefined) {
    CACHE.set(item["key"], { at: ts, row });
    return row;
  }
  if (hit) return { ...hit.row, cached: true, stale: true };
  return row;
}

// Yahoo 挂了还能救回来的格子:同一条指数、同一个量纲,Cboe 官方延迟接口就有。
// (publicIndexPrice 早就在走这条路了,这里只是让行情带也用上。)
// 不含 ^TNX:Cboe 的 _TNX 是另一路报价,量纲对不上 Yahoo 的百分数,而且实测 close
// 与 current_price 相等、price_change 恒为 0——没法在本机交叉验证,宁可空着。
const MACRO_CBOE: Record<string, string> = { "^GSPC": "SPX", "^NDX": "NDX", "^VIX": "VIX" };

async function fetchCboeRow(
  macroKey: string, timeout: number, fetcher: Fetcher,
): Promise<{ last: number; change_pct: number | null } | null> {
  const sym = MACRO_CBOE[macroKey];
  if (!sym) return null;
  const payload: any = await fetcher(CBOE_ENDPOINT.replace("%s", sym), timeout * 1000);
  const last = cboeLast(payload);
  if (last === null) return null;
  const prev = num(payload?.data?.["close"]);
  const change = num(payload?.data?.["price_change"]);
  const changePct = prev && change !== null ? pyRound((change / prev) * 100.0, 2) : null;
  return { last, change_pct: changePct };
}

async function fetchOne(
  item: Record<string, any>, timeout: number, fetcher: Fetcher,
): Promise<Record<string, any>> {
  const row: Record<string, any> = {
    key: item["key"], label: item["label"], fmt: item["fmt"], last: null, change_pct: null,
  };
  let payload: any;
  try {
    payload = await fetcher(ENDPOINT.replace("%s", encodeURIComponent(item["key"])), timeout * 1000);
  } catch (exc) {
    // 记消息不记 name:name 一律是 'Error' / 'SyntaxError',说不出到底为什么取不到
    const e = exc as Error;
    row["error"] = (e?.message || e?.name || "Error").slice(0, 120);
    try {
      const alt = await fetchCboeRow(item["key"], timeout, fetcher);
      if (alt) {
        row["last"] = alt.last;
        row["change_pct"] = alt.change_pct;
        row["instrument"] = "Cboe";
        delete row["error"]; // 备用源救回来了,不必再往界面上报错
      }
    } catch {
      /* 备用源也不通:保留上面那条主源的错误原因 */
    }
    return row;
  }
  const meta = payload?.chart?.result?.[0]?.meta ?? {};
  const last = num(meta["regularMarketPrice"]);
  const prev = num(meta["chartPreviousClose"]) ?? num(meta["previousClose"]);
  row["last"] = last;
  if (last !== null && prev) row["change_pct"] = pyRound((last / prev - 1.0) * 100.0, 2);
  return row;
}

/** 测试用:直接拿默认取数器,核对被挡时的报错文字。 */
export const defaultFetcherForTest: Fetcher = (url, timeoutMs) => defaultFetcher(url, timeoutMs);

async function defaultFetcher(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "dafri-trading/0.2 (macro board)" },
      signal: controller.signal,
    });
    // 数据源被挡时回的是 HTML 错误页,直接 .json() 只会抛 SyntaxError——界面上就成了
    // 一行看不出所以然的 "SyntaxError",分不清是被限流、被地区封禁,还是端点改了。
    // 先按状态码给一句人话。
    if (!response.ok) {
      throw new Error(`数据源返回 HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
    }
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`数据源返回的不是 JSON(前 60 字:${text.slice(0, 60).replace(/\s+/g, " ")})`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function num(value: unknown): number | null {
  const v = Number(value);
  if (value === null || value === undefined || Number.isNaN(v)) return null;
  return v;
}

/** 测试用:清空缓存。 */
export function clearMacroCache(): void {
  CACHE.clear();
  INFLIGHT.clear();
}
