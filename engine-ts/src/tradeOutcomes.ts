/**
 * 交易结果 → 知识总结的事实(docs/features/idea-retrieval.md「边界」一节的那条路:数字由代码算,叙事才交给模型)。
 *
 * 输入是交易分析页用的同一批记录——`ibtrades.groupButterflies` 合成的蝴蝶、`stockreview.groupStockTrips` 切出的股票持仓段,
 * 输出每笔一条 `IdeaTradeFact`:成 / 败 / 持平 / 持仓中 / 不明,以及对成本的收益率。纯函数,不碰券商、不碰存储;
 * 到期结算要的标的收盘价由调用方查好了传进来(`settleClose`),查不到就是「不明」,**不猜**。
 *
 * 只出单价与比例,不出数量、金额、账户:这些事实要发给模型,而账户与持仓不出本机(ideas.md)。
 */
import type { IdeaTradeFact, IdeaTradeHow, IdeaTradeResult } from "./contract/ideas.js";
import { pyRound } from "./py.js";
import type { ImportedOptionTrade } from "./store.js";
import { butterflyProfile, etKey, expiryClose, pairButterflies, parseWhen, payoffPerUnit } from "./tradereview.js";
import { ET, utcIso, wallToEpoch } from "./tz.js";

/** 交易分析页的一条蝴蝶记录(`ibtrades.groupButterflies`)。结构由 tradereview 按整条记录认,这里只读列出的几项。 */
export type ButterflyRecord = {
  id?: unknown;
  created_at?: unknown;
  ibkr?: { avg_fill_price?: unknown } | null;
  account?: { is_paper?: unknown } | null;
  [key: string]: unknown;
};

/** 一段股票持仓(`stockreview.groupStockTrips`)里这里要读的字段。 */
export type StockTrip = {
  id?: unknown;
  symbol?: unknown;
  side?: unknown;
  status?: unknown;
  carried?: unknown;
  opening_assumed?: unknown;
  avg_entry?: unknown;
  avg_exit?: unknown;
  realized_pnl?: unknown;
  realized_qty?: unknown;
  created_at?: unknown;
  closed_at?: unknown;
  account?: { is_paper?: unknown } | null;
};

/** 一次总结最多附多少笔(新的优先)。一笔一行约 80 字,200 笔几千 token;再多只是烧 token。 */
export const MAX_TRADE_FACTS = 200;

/** 收益率绝对值小于这个(%)算持平:蝴蝶 0.05 的价差、股票几分钱的来回,不该被读成「赢了」「输了」。 */
export const FLAT_PCT = 0.5;

/** 导入的期权每份盈亏(点)绝对值小于这个算持平:0.05 点 = 每份 5 美元,不到一次来回的佣金。 */
export const FLAT_POINTS = 0.05;

/** 标的在某个美东日期的收盘价;查不到回 null。 */
export type SettleClose = (symbol: string, date: string) => number | null;

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const out = Number(value);
  return Number.isFinite(out) ? out : null;
}

function isoOf(value: unknown): string | null {
  const when = parseWhen(value);
  return when === null ? null : utcIso(when);
}

function resultOf(pct: number | null): IdeaTradeResult {
  if (pct === null) return "unknown";
  if (Math.abs(pct) < FLAT_PCT) return "flat";
  return pct > 0 ? "win" : "loss";
}

/** 蝴蝶:开仓那条一行,平仓单并进来;没平仓的过了到期日按收盘结算,没到期的是持仓中。 */
export function butterflyFacts(records: ButterflyRecord[], settleClose: SettleClose, now: number): IdeaTradeFact[] {
  const pairs = pairButterflies(records);
  const out: IdeaTradeFact[] = [];
  for (const record of records) {
    const id = String(record.id ?? "");
    const link = pairs[id];
    if (link && link["role"] === "exit") continue; // 平仓单并进开仓那一笔
    const profile = butterflyProfile(record);
    if (profile === null) continue;
    const debit = num(profile["debit"]);
    const sign = profile["action"] === "BUY" ? 1 : -1;
    const verb = profile["action"] === "BUY" ? "买入" : "卖出";
    const label = `${profile["symbol"]} ${profile["lower"]}/${profile["center"]}/${profile["upper"]} ` +
      `${profile["right_label"]}蝴蝶 ${verb}`;

    let how: IdeaTradeHow;
    let exitPrice: number | null = null;
    let closedAt: string | null = null;
    const notes: string[] = [];
    if (link) {
      const peer = records.find((r) => r.id === link["peer"]);
      how = "closed";
      exitPrice = num(peer?.ibkr?.avg_fill_price);
      closedAt = isoOf(peer?.created_at);
      if (exitPrice === null) notes.push("平仓单没有成交均价");
    } else if (now >= expiryClose(profile)) {
      how = "expired";
      closedAt = utcIso(expiryClose(profile));
      const close = settleClose(String(profile["symbol"]), String(profile["expiry"]));
      if (close === null) notes.push(`取不到 ${profile["symbol"]} ${profile["expiry"]} 的收盘价,结算结果不明`);
      else exitPrice = payoffPerUnit(profile, close);
    } else {
      how = "open";
    }
    if (debit === null) notes.push("没有成交价,成本不明");

    let pct: number | null = null;
    if (how !== "open" && debit && exitPrice !== null) pct = pyRound((sign * (exitPrice - debit) / debit) * 100, 1);
    out.push({
      id,
      kind: "butterfly",
      symbol: String(profile["symbol"]),
      opened_at: isoOf(record.created_at) ?? "",
      closed_at: closedAt,
      label,
      entry_price: debit,
      exit_price: exitPrice === null ? null : pyRound(exitPrice, 4),
      how,
      result: how === "open" ? "open" : resultOf(pct),
      return_pct: pct,
      paper: Boolean(record.account?.is_paper),
      note: notes.join(";"),
    });
  }
  return out;
}

/** 股票:一段持仓(从空仓到空仓)一笔。成本在记录之前(carried)的算不出盈亏,是「不明」。 */
export function stockFacts(trips: StockTrip[]): IdeaTradeFact[] {
  return trips.map((trip): IdeaTradeFact => {
    const closed = trip.status === "closed";
    const entry = num(trip.avg_entry);
    const realized = num(trip.realized_pnl);
    const realizedQty = num(trip.realized_qty) ?? 0;
    const notes: string[] = [];
    let pct: number | null = null;
    if (trip.carried) notes.push("建仓在成交记录之前,成本不明");
    else if (closed && entry && realized !== null && realizedQty > 0) {
      pct = pyRound((realized / (entry * realizedQty)) * 100, 1);
    }
    if (trip.opening_assumed) notes.push("期初持仓未核对");
    return {
      id: String(trip.id ?? ""),
      kind: "stock",
      symbol: String(trip.symbol ?? ""),
      opened_at: isoOf(trip.created_at) ?? "",
      closed_at: closed ? isoOf(trip.closed_at) : null,
      label: `${trip.symbol} ${trip.side === "SHORT" ? "做空" : "做多"}`,
      entry_price: entry,
      exit_price: num(trip.avg_exit),
      how: closed ? "closed" : "open",
      result: closed ? resultOf(pct) : "open",
      return_pct: pct,
      paper: Boolean(trip.account?.is_paper),
      note: notes.join(";"),
    };
  });
}

/** 券商成交行里读得到的几项(broker_fills 的行;只看期权属于哪个账户、哪个美东日)。 */
export type FillDay = {
  account_id?: unknown;
  time?: unknown;
  contract?: { secType?: unknown } | null;
};

/** 库里已经有完整期权成交的 (账户, 美东日期):这些天的导入期权事件不再用,免得同一笔算两遍。 */
export function optionDaysCovered(fills: readonly FillDay[]): Set<string> {
  const out = new Set<string>();
  for (const f of fills) {
    if (!["OPT", "BAG", "FOP"].includes(String(f.contract?.secType ?? ""))) continue;
    const when = parseWhen(f.time);
    if (when !== null) out.add(`${String(f.account_id ?? "")}|${etKey(when, true)}`);
  }
  return out;
}

/** "2026-07-17 10:23:05"(美东墙钟)→ UTC ISO */
function etIso(timeEt: string): string {
  const [d = "", t = ""] = timeEt.split(" ");
  const [year, month, day] = d.split("-").map(Number) as [number, number, number];
  const [hour, minute, second] = t.split(":").map(Number) as [number, number, number];
  return utcIso(wallToEpoch({ year, month, day, hour, minute, second }, ET));
}

/**
 * 导入的期权(按结构整理的成交导出):**一次出场一条**(平仓、逐腿平仓、拆腿平仓、到期结算),开仓行不单列。
 * 成败看 IBKR 的已实现盈亏(已扣佣金,是准的),幅度给每份结构的点数;开仓没配对,所以没有收益率。
 * 结构是按同一秒成交推断的、没有行权价,每条都写明。导出里的 note / legs 带金额,不发。
 * `covered` 里的 (账户, 日期) 已有完整成交,跳过。
 */
export function optionFacts(
  rows: readonly ImportedOptionTrade[], isPaper: (accountId: string) => boolean, covered: ReadonlySet<string> = new Set(),
): IdeaTradeFact[] {
  const out: IdeaTradeFact[] = [];
  for (const r of rows) {
    if (r.action === "开仓" || covered.has(`${r.account_id}|${r.date_et}`)) continue;
    const points = r.qty !== null && r.qty > 0 ? pyRound(r.realized_pnl / 100 / r.qty, 2) : null;
    // 份数不明时没有点数,成败只看盈亏的正负(盈亏本身是准的)
    const result: IdeaTradeResult = points === null
      ? (r.realized_pnl === 0 ? "flat" : r.realized_pnl > 0 ? "win" : "loss")
      : Math.abs(points) < FLAT_POINTS ? "flat" : points > 0 ? "win" : "loss";
    const notes = ["结构按同一秒成交推断、无行权价", "已扣佣金"];
    if (points === null) notes.push("份数不明,不给点数");
    if (r.structure === "多个仓位同时结算") notes.push("多只同时到期,合在一起算");
    const when = etIso(r.time_et);
    out.push({
      id: r.id,
      kind: "option",
      symbol: r.symbol,
      opened_at: when,
      closed_at: when,
      label: `${r.symbol} ${r.structure}${r.direction ? `(${r.direction})` : ""} · ${r.action}`,
      entry_price: null,
      exit_price: null,
      how: r.action.includes("到期") ? "expired" : "closed",
      result,
      return_pct: null,
      pnl_points: points,
      paper: isPaper(r.account_id),
      note: notes.join(";"),
    });
  }
  return out;
}

/**
 * 两类合起来:只留给定标的的(空 = 全部),新的在前,封顶 `MAX_TRADE_FACTS`。
 * 次序与想法一致(新的在前);喂给模型时再倒成从早到晚。
 */
export function collectFacts(
  butterflies: ButterflyRecord[], trips: StockTrip[], settleClose: SettleClose, now: number, symbols: readonly string[] = [],
  extra: readonly IdeaTradeFact[] = [],
): IdeaTradeFact[] {
  const want = new Set(symbols.map((s) => s.toUpperCase()));
  const all = [...butterflyFacts(butterflies, settleClose, now), ...stockFacts(trips), ...extra]
    .filter((f) => !want.size || want.has(f.symbol.toUpperCase()));
  all.sort((a, b) => (a.opened_at < b.opened_at ? 1 : a.opened_at > b.opened_at ? -1 : a.id < b.id ? -1 : 1));
  return all.slice(0, MAX_TRADE_FACTS);
}

/** 到期结算要查哪些(标的, 日期):没平仓、已过到期日的蝴蝶。调用方据此去取日线。 */
export function settlementsNeeded(butterflies: ButterflyRecord[], now: number): Array<{ symbol: string; date: string }> {
  const pairs = pairButterflies(butterflies);
  const seen = new Map<string, { symbol: string; date: string }>();
  for (const record of butterflies) {
    if (pairs[String(record.id ?? "")]) continue;
    const profile = butterflyProfile(record);
    if (profile === null || now < expiryClose(profile)) continue;
    const key = `${profile["symbol"]}|${profile["expiry"]}`;
    if (!seen.has(key)) seen.set(key, { symbol: String(profile["symbol"]), date: String(profile["expiry"]) });
  }
  return [...seen.values()];
}

const HOW_LABEL: Record<IdeaTradeHow, string> = { closed: "平仓", expired: "到期", open: "持仓中" };
const RESULT_LABEL: Record<IdeaTradeResult, string> = {
  win: "赚", loss: "亏", flat: "持平", open: "未了结", unknown: "结果不明",
};

function priceText(v: number | null): string {
  return v === null ? "?" : String(pyRound(v, 4));
}

/** 喂给模型的一行。例:「[2026-09-10 | 蝴蝶 | 模拟] SPX 7625/7650/7675 看跌蝴蝶 买入 @5.4 → 平仓 @4.55:亏 -15.7%」 */
export function factLine(f: IdeaTradeFact): string {
  const kindLabel = f.kind === "butterfly" ? "蝴蝶" : f.kind === "stock" ? "股票" : "期权";
  const tags = [etKey(parseWhen(f.opened_at) ?? 0, true), kindLabel, ...(f.paper ? ["模拟"] : [])];
  if (f.kind === "option") {
    const pts = f.pnl_points === null || f.pnl_points === undefined ? "" : ` ${f.pnl_points > 0 ? "+" : ""}${f.pnl_points} 点/份`;
    return `[${tags.join(" | ")}] ${f.label}:${RESULT_LABEL[f.result]}${pts}(${f.note})`;
  }
  let text = `[${tags.join(" | ")}] ${f.label} @${priceText(f.entry_price)}`;
  if (f.how !== "open") {
    const exitWord = f.how === "expired" ? "到期结算价值" : "平仓";
    text += ` → ${exitWord} @${priceText(f.exit_price)}`;
    if (f.closed_at) text += `(${f.closed_at.slice(0, 10)})`;
  } else {
    text += ` → ${HOW_LABEL.open}`;
  }
  text += `:${RESULT_LABEL[f.result]}`;
  if (f.return_pct !== null) text += ` ${f.return_pct > 0 ? "+" : ""}${f.return_pct}%`;
  if (f.note) text += `(${f.note})`;
  return text;
}

/** 代码数好的胜负:模型拿去用,不许自己重数。 */
export function tallyLine(facts: IdeaTradeFact[]): string {
  const count = (r: IdeaTradeResult): number => facts.filter((f) => f.result === r).length;
  return `共 ${facts.length} 笔:赚 ${count("win")}、亏 ${count("loss")}、持平 ${count("flat")}、` +
    `未了结 ${count("open")}、结果不明 ${count("unknown")}`;
}
