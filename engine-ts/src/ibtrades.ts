/**
 * 券商成交明细 → 交易记录:把 IBKR 报回来的逐腿成交按订单合成一张蝴蝶。
 * 行为规格 = ../engine-python 的 ibtrades.py,逐字段对拍(baseline/golden/ibtrades.json)。
 *
 * 口径:净权利金优先用 BAG 行的价格;没有 BAG 行才从腿上算 Σ(买腿 价×比例) − Σ(卖腿 价×比例) 取绝对值;
 * 同一条腿分几笔成交按数量加权、时间取最早;只认 1:2:1 同到期同方向三腿;账号不在别名表里的也保留(脱敏)。
 */
import { fmtF, pyRound } from "./py.js";

type Rec = Record<string, any>;

export const FILL_SOURCE = "ibkr";

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const out = Number(value);
  return Number.isFinite(out) ? out : null;
}

function mask(accountId: string): string {
  const s = String(accountId ?? "");
  return s.length <= 5 ? s : `${s.slice(0, 2)}***${s.slice(-3)}`;
}

export function fmtExpiry(raw: unknown): string {
  const s = String(raw ?? "");
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s;
}

function fmt(v: number): string {
  return fmtF(v, 4).replace(/0+$/, "").replace(/\.$/, "");
}

/** 同一订单的成交行共用 permId;拿不到就退到 orderId + 首笔 execId。 */
export function groupKey(fill: Rec): string {
  const perm = fill["perm_id"];
  if (perm) return `p${Math.trunc(Number(perm))}`;
  const order = fill["order_id"];
  if (order) return `o${Math.trunc(Number(order))}`;
  return `e${String(fill["exec_id"] ?? "")}`;
}

interface LegAgg {
  bot: number; sld: number; value: number; shares: number; times: string[];
  commission: number; hasComm: boolean; contract: Rec;
}

/** 成交行(router.executions() / store.listFills() 的形状)→ 蝴蝶交易记录,按时间升序。 */
export function groupButterflies(fills: Iterable<Rec>, accounts: Rec[] = []): Rec[] {
  const aliasOf = new Map<string, Rec>(accounts.map((a) => [String(a["account_id"] ?? ""), a]));
  const groups = new Map<string, Rec[]>();
  for (const fill of fills) {
    const contract = fill["contract"] ?? {};
    if (!["BAG", "OPT", "FOP"].includes(contract["secType"])) continue;
    const key = `${String(fill["account_id"] ?? "")}|${groupKey(fill)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(fill);
  }
  const out: Rec[] = [];
  for (const rows of groups.values()) {
    const record = butterflyFromRows(rows, aliasOf);
    if (record !== null) out.push(record);
  }
  out.sort((a, b) => {
    const ka = `${a["created_at"]}`, kb = `${b["created_at"]}`;
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a["id"] < b["id"] ? -1 : a["id"] > b["id"] ? 1 : 0;
  });
  return out;
}

function butterflyFromRows(rows: Rec[], aliasOf: Map<string, Rec>): Rec | null {
  const legs = new Map<string, { key: [number, string, string]; agg: LegAgg }>();
  const bags: Rec[] = [];
  for (const row of rows) {
    const c = row["contract"] ?? {};
    const shares = num(row["shares"]) ?? 0;
    const price = num(row["price"]);
    if (shares <= 0 || price === null) continue;
    if (c["secType"] === "BAG") { bags.push(row); continue; }
    const strike = num(c["strike"]);
    if (strike === null) continue;
    const key: [number, string, string] = [strike, String(c["right"] ?? ""), String(c["expiry"] ?? "")];
    const id = key.join("|");
    if (!legs.has(id)) {
      legs.set(id, { key, agg: { bot: 0, sld: 0, value: 0, shares: 0, times: [], commission: 0, hasComm: false, contract: c } });
    }
    const leg = legs.get(id)!.agg;
    if (["BOT", "BUY"].includes(String(row["side"] ?? "").toUpperCase())) leg.bot += shares;
    else leg.sld += shares;
    leg.value += price * shares;
    leg.shares += shares;
    leg.times.push(String(row["time"] ?? ""));
    const comm = num(row["commission"]);
    if (comm !== null) { leg.commission += comm; leg.hasComm = true; }
  }
  if (legs.size !== 3) return null;
  const entries = [...legs.values()].sort((a, b) =>
    a.key[0] - b.key[0] || (a.key[1] < b.key[1] ? -1 : a.key[1] > b.key[1] ? 1 : 0) || (a.key[2] < b.key[2] ? -1 : a.key[2] > b.key[2] ? 1 : 0));
  if (new Set(entries.map((e) => e.key[1])).size !== 1 || new Set(entries.map((e) => e.key[2])).size !== 1) return null;

  const sized: Array<{ key: [number, string, string]; action: string; size: number; leg: LegAgg }> = [];
  for (const e of entries) {
    const net = e.agg.bot - e.agg.sld;
    if (Math.abs(net) < 1e-9) return null;
    sized.push({ key: e.key, action: net > 0 ? "BUY" : "SELL", size: Math.abs(net), leg: e.agg });
  }
  const qtyF = Math.min(...sized.map((s) => s.size));
  const ratios = sized.map((s) => Math.round(s.size / qtyF));
  if (ratios[0] !== 1 || ratios[1] !== 2 || ratios[2] !== 1) return null;
  const [s1, s2, s3] = sized as [typeof sized[0], typeof sized[0], typeof sized[0]];
  if (s1.action !== s3.action || s2.action === s1.action) return null;
  const qty = Math.round(qtyF);
  if (qty <= 0) return null;

  const contract0 = s1.leg.contract;
  const multiplier = num(contract0["multiplier"]) || 100.0;
  const right = s1.key[1], expiryRaw = s1.key[2];
  const symbol = String(contract0["symbol"] ?? "");
  const legPrice = (l: LegAgg): number => l.value / l.shares;

  let premium: number;
  if (bags.length) {
    const bagShares = bags.reduce((acc, b) => acc + (num(b["shares"]) ?? 0), 0);
    const net = bags.reduce((acc, b) => acc + (num(b["price"]) ?? 0) * (num(b["shares"]) ?? 0), 0) / bagShares;
    premium = pyRound(Math.abs(net), 4);
  } else {
    let signed = 0;
    sized.forEach((s, i) => { signed += (s.action === "BUY" ? 1 : -1) * legPrice(s.leg) * ratios[i]!; });
    premium = pyRound(Math.abs(signed), 4);
  }

  const times = sized.flatMap((s) => s.leg.times).filter((t) => t).sort();
  const firstTime = times[0] ?? "";
  const accountId = String((rows[0] ?? {})["account_id"] ?? "");
  const acct = aliasOf.get(accountId);
  const alias = acct ? String(acct["alias"]) : `未配置账户 ${mask(accountId)}`;
  const isPaper = acct ? Boolean(acct["is_paper"]) : accountId.toUpperCase().startsWith("DU");

  let commission: number | null = null;
  if (sized.some((s) => s.leg.hasComm)) {
    commission = pyRound(sized.reduce((acc, s) => acc + s.leg.commission, 0), 4);
  }

  const fillsOut: Rec[] = bags.length
    ? bags.map((b) => ({ time: String(b["time"] ?? firstTime), price: num(b["price"]), qty: num(b["shares"]), exec_id: String(b["exec_id"] ?? "") }))
    : [{ time: firstTime, price: premium, qty, exec_id: "(合成)" }];

  const verb = s1.action === "BUY" ? "买入" : "卖出";
  const rightLabel = right === "P" ? "看跌" : "看涨";
  const width = pyRound(s2.key[0] - s1.key[0], 4);
  const summary = `${verb} ${qty} 张 ${symbol} ${fmt(s1.key[0])}/${fmt(s2.key[0])}/${fmt(s3.key[0])} ${rightLabel}蝴蝶(翼宽 ${fmt(width)})@ ${fmt(premium)}`;
  const permRaw = rows[0]!["perm_id"];
  const perm = permRaw ? permRaw : null;
  const rid = `ib:${perm ? Math.trunc(Number(perm)) : groupKey(rows[0]!)}`;
  const multStr = Number.isInteger(multiplier) ? String(Math.trunc(multiplier)) : String(multiplier);

  const legsOut = sized.map((s, i) => ({
    action: s.action, ratio: ratios[i], strike: s.key[0], right,
    lastTradeDateOrContractMonth: expiryRaw,
    tradingClass: String(s.leg.contract["tradingClass"] ?? ""),
    multiplier: multStr,
    conId: s.leg.contract["conId"] ?? null,
    fill_price: pyRound(legPrice(s.leg), 4),
  }));
  return {
    id: rid,
    source: FILL_SOURCE,
    created_at: firstTime,
    contract: {
      secType: "BAG", symbol, exchange: "SMART",
      currency: String(contract0["currency"] || "USD"),
      combo_strategy: "BUTTERFLY", multiplier: multStr, legs: legsOut,
    },
    order: { action: s1.action, totalQuantity: qty, orderType: "", lmtPrice: null, price_mode: "EXPLICIT", tif: "", outsideRth: false },
    ibkr: {
      avg_fill_price: premium, fills: fillsOut, perm_id: perm,
      order_id: rows[0]!["order_id"] || null, total_commission: commission,
      status_timeline: [{ status: "Filled", at: firstTime }],
    },
    final_status: "filled",
    account: { alias, account_id: accountId, is_paper: isPaper },
    llm: { intent_summary: summary },
    input: { raw_instruction: "", reason: "券商成交记录", input_channel: FILL_SOURCE },
    execution_type: "IMMEDIATE",
    expiry: fmtExpiry(expiryRaw),
  };
}
