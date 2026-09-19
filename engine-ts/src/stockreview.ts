/**
 * 股票交易复盘:券商逐笔成交 → "从空仓到空仓"的一段持仓(一笔交易)→ 进出场位置、持有期浮盈浮亏、
 * 平仓后走势与规则化结论。和蝴蝶复盘(tradereview.ts)并列,共用它的时间与 K 线定位口径。
 *
 * 全部是纯函数,不碰券商、不碰存储。几条口径,算错了会误导人,所以写死:
 * - **一笔交易 = 一段持仓**:同一账户同一只股票,仓位从 0 走到非 0 再回到 0。中途加仓、分批减仓都算在这一笔里,
 *   成本按移动平均(加仓摊均价,减仓不动均价),已实现盈亏 = Σ(卖价 − 均价)× 数量(做空反号)。
 *   一笔成交把仓位打穿(多 100 卖 150)就拆开:100 平掉旧的一笔,50 另起一笔反向的。
 * - **期初仓位靠当前持仓反推**:TWS 只给当天的成交,库里的成交是一天天攒的,最早那笔卖出多半卖的是更早买的货。
 *   期初仓位 = 当前持仓 − 库内成交的净额;不为 0 的那一段没有建仓成交,标 carried(成本与盈亏未知,只复盘出场)。
 *   拿不到当前持仓(没连券商)时标 opening_assumed,并且**不把"先卖"读成卖空**:卖出与平仓不是一回事,
 *   期初按"刚好够卖"的多头算(卖的是更早买的货,carried,成本与盈亏不编)。真是卖空的,连上券商后按真实持仓
 *   重算会改回来;反过来把平仓认成卖空,会凭空多出一笔"做空盈亏"和一个并不存在的空头持仓。
 * - 同一订单(permId)的几笔成交并成一次"出手",价格按数量加权、时间取最早:图上一个点,而不是一串。
 * - 标的价格用 K 线;浮盈浮亏按持有期内 K 线的最高 / 最低对**最终均价**算,数量按这一笔的最大持仓——
 *   加过仓的是估算(加仓之前的那段其实仓位更小),notes 里标明。
 */
import { groupKey } from "./ibtrades.js";
import { fmtF, pyRound } from "./py.js";
import {
  LOOKAHEAD_BARS, LOOKBACK_BARS, MAX_WINDOW, POST_ENTRY_BARS, PRE_TREND_BARS,
  ReviewError, barSeconds, barTime, etKey, indexAt, isDaily, parseWhen, utcIso,
} from "./tradereview.js";

type Rec = Record<string, any>;

export const TRIP_PREFIX = "stk:";
export const KIND_CLOSED = "closed";
export const KIND_OPEN = "open";

const EPS = 1e-9;

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const out = Number(value);
  return Number.isFinite(out) ? out : null;
}

function mask(accountId: string): string {
  const s = String(accountId ?? "");
  return s.length <= 5 ? s : `${s.slice(0, 2)}***${s.slice(-3)}`;
}

function trim(v: number, digits = 4): string {
  return fmtF(v, digits).replace(/0+$/, "").replace(/\.$/, "");
}

export function holdingKey(accountId: unknown, symbol: unknown): string {
  return `${String(accountId ?? "")}|${String(symbol ?? "").toUpperCase()}`;
}

// ----------------------------------------------------------------------
// 成交 → 一笔笔交易
// ----------------------------------------------------------------------
interface Exec { time: string; when: number; price: number; qty: number; perm: string; exec_ids: string[]; action: "BUY" | "SELL" }

interface Trip {
  firstFill: Rec; remainder: boolean; side: 1 | -1; carried: boolean; carriedQty: number;
  entries: Exec[]; exits: Exec[]; avg: number | null; pos: number; peak: number;
  realized: number | null; realizedQty: number; commission: number; hasComm: boolean;
}

function pushExec(list: Exec[], fill: Rec, when: number, qty: number, price: number, action: "BUY" | "SELL"): void {
  const perm = groupKey(fill);
  const last = list[list.length - 1];
  if (last && last.perm === perm) {
    // 同一订单分几笔成交:并成一次出手
    last.price = (last.price * last.qty + price * qty) / (last.qty + qty);
    last.qty += qty;
    last.exec_ids.push(String(fill["exec_id"] ?? ""));
    if (when < last.when) { last.when = when; last.time = String(fill["time"] ?? ""); }
    return;
  }
  list.push({ time: String(fill["time"] ?? ""), when, price, qty, perm, exec_ids: [String(fill["exec_id"] ?? "")], action });
}

/**
 * 成交行(store.listFills() 的形状)→ 股票交易,按开始时间升序。
 * holdings:{`${account_id}|${SYMBOL}`: 当前持仓股数};null = 不知道(没连券商),期初按"刚好够卖"的多头算。
 */
export function groupStockTrips(fills: Iterable<Rec>, accounts: Rec[] = [], holdings: Record<string, number> | null = null): Rec[] {
  const aliasOf = new Map<string, Rec>(accounts.map((a) => [String(a["account_id"] ?? ""), a]));
  const groups = new Map<string, Array<{ fill: Rec; when: number; seq: number; signed: number; price: number }>>();
  let seq = 0;
  for (const fill of fills) {
    const contract = fill["contract"] ?? {};
    if (contract["secType"] !== "STK") continue;
    const shares = num(fill["shares"]) ?? 0;
    const price = num(fill["price"]);
    const when = parseWhen(fill["time"]);
    const symbol = String(contract["symbol"] ?? "").toUpperCase();
    if (shares <= 0 || price === null || when === null || !symbol) continue;
    const buy = ["BOT", "BUY"].includes(String(fill["side"] ?? "").toUpperCase());
    const key = holdingKey(fill["account_id"], symbol);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ fill, when, seq: seq += 1, signed: buy ? shares : -shares, price });
  }

  const out: Rec[] = [];
  const usedIds = new Set<string>();
  for (const [key, rows] of groups) {
    rows.sort((a, b) => a.when - b.when || a.seq - b.seq);
    let net = 0;
    let low = 0; // 从 0 起步累计到过的最低仓位:负多少,就是"至少有多少股是更早买的"
    for (const r of rows) { net += r.signed; low = Math.min(low, net); }
    const opening = holdings === null ? (low < 0 ? -low : 0) : (holdings[key] ?? 0) - net;
    let trip: Trip | null = null;
    const start = (fill: Rec, side: 1 | -1, remainder: boolean, carriedQty = 0): Trip => ({
      firstFill: fill, remainder, side, carried: carriedQty > 0, carriedQty,
      entries: [], exits: [], avg: carriedQty > 0 ? null : 0, pos: side * carriedQty, peak: carriedQty,
      realized: carriedQty > 0 ? null : 0, realizedQty: 0, commission: 0, hasComm: false,
    });
    const finish = (t: Trip): void => {
      out.push(tripRecord(t, aliasOf, holdings === null, usedIds));
    };
    if (Math.abs(opening) > EPS) trip = start(rows[0]!.fill, opening > 0 ? 1 : -1, false, Math.abs(opening));

    for (const row of rows) {
      let left = Math.abs(row.signed);
      const dir: 1 | -1 = row.signed > 0 ? 1 : -1;
      const action = dir > 0 ? "BUY" : "SELL";
      let first = true;
      while (left > EPS) {
        if (trip === null) trip = start(row.fill, dir, !first);
        const t: Trip = trip;
        if (first) {
          const comm = num(row.fill["commission"]);
          if (comm !== null) { t.commission += comm; t.hasComm = true; }
        }
        if (dir === t.side) {
          // 建仓 / 加仓:摊均价(carried 的那段没有成本,均价一直未知)
          if (t.avg !== null) t.avg = (t.avg * Math.abs(t.pos) + row.price * left) / (Math.abs(t.pos) + left);
          t.pos += dir * left;
          t.peak = Math.max(t.peak, Math.abs(t.pos));
          pushExec(t.entries, row.fill, row.when, left, row.price, action);
          left = 0;
        } else {
          const closeQty = Math.min(left, Math.abs(t.pos));
          if (t.avg !== null && t.realized !== null) {
            t.realized += (row.price - t.avg) * closeQty * t.side;
            t.realizedQty += closeQty;
          }
          t.pos += dir * closeQty;
          pushExec(t.exits, row.fill, row.when, closeQty, row.price, action);
          left -= closeQty;
          if (Math.abs(t.pos) <= EPS) {
            t.pos = 0;
            finish(t);
            trip = null;
          }
        }
        first = false;
      }
    }
    if (trip !== null) finish(trip);
  }
  out.sort((a, b) => a["started_at_ms"] - b["started_at_ms"] || (a["id"] < b["id"] ? -1 : a["id"] > b["id"] ? 1 : 0));
  for (const r of out) delete r["started_at_ms"];
  return out;
}

function vwap(list: Exec[]): number | null {
  const qty = list.reduce((acc, e) => acc + e.qty, 0);
  return qty > EPS ? pyRound(list.reduce((acc, e) => acc + e.price * e.qty, 0) / qty, 4) : null;
}

function execOut(e: Exec): Rec {
  return { time: e.time, price: pyRound(e.price, 4), qty: pyRound(e.qty, 4), action: e.action, exec_ids: e.exec_ids };
}

function tripRecord(t: Trip, aliasOf: Map<string, Rec>, openingAssumed: boolean, usedIds: Set<string>): Rec {
  const fill = t.firstFill;
  const contract = fill["contract"] ?? {};
  const symbol = String(contract["symbol"] ?? "").toUpperCase();
  const accountId = String(fill["account_id"] ?? "");
  const acct = aliasOf.get(accountId);
  const alias = acct ? String(acct["alias"]) : `未配置账户 ${mask(accountId)}`;
  const isPaper = acct ? Boolean(acct["is_paper"]) : accountId.toUpperCase().startsWith("DU");

  let id = `${TRIP_PREFIX}${groupKey(fill)}${t.remainder ? ":r" : ""}`;
  for (let n = 2; usedIds.has(id); n += 1) id = `${TRIP_PREFIX}${groupKey(fill)}${t.remainder ? ":r" : ""}:${n}`;
  usedIds.add(id);

  const entryQty = t.entries.reduce((acc, e) => acc + e.qty, 0);
  const exitQty = t.exits.reduce((acc, e) => acc + e.qty, 0);
  const openQty = Math.abs(t.pos);
  const closed = openQty <= EPS;
  const all = [...t.entries, ...t.exits].sort((a, b) => a.when - b.when);
  const firstExec = all[0]!;
  const lastExit = t.exits.length ? t.exits.reduce((a, b) => (b.when > a.when ? b : a)) : null;
  const avgEntry = t.avg === null ? null : pyRound(t.avg, 4);
  const avgExit = vwap(t.exits);
  const long = t.side > 0;

  const unit = `${trim(t.peak)} 股`;
  let summary: string;
  if (t.carried && !t.entries.length) {
    const why = openingAssumed ? "期初持仓未核对,按卖出更早买的货算" : "建仓早于已同步的成交";
    summary = `${long ? "卖出" : "买回"} ${symbol} ${trim(exitQty)} 股 @ ${avgExit === null ? "—" : trim(avgExit)}(${why})`;
  } else {
    summary = `${long ? "做多" : "做空"} ${symbol} ${unit} @ ${avgEntry === null ? "—" : trim(avgEntry)}`
      + (avgExit === null ? "" : ` → ${closed ? "平仓" : "已减仓"} @ ${trim(avgExit)}`);
  }

  return {
    id,
    kind: "stock",
    source: "ibkr",
    symbol,
    currency: String(contract["currency"] || "USD"),
    account: { alias, account_id: accountId, is_paper: isPaper },
    side: long ? "LONG" : "SHORT",
    status: closed ? KIND_CLOSED : KIND_OPEN,
    carried: t.carried,
    carried_qty: pyRound(t.carriedQty, 4),
    opening_assumed: openingAssumed,
    entries: t.entries.map(execOut),
    exits: t.exits.map(execOut),
    qty: pyRound(t.peak, 4),
    entry_qty: pyRound(entryQty, 4),
    exit_qty: pyRound(exitQty, 4),
    open_qty: pyRound(openQty, 4),
    avg_entry: avgEntry,
    avg_exit: avgExit,
    realized_pnl: t.realized === null ? null : pyRound(t.realized, 2),
    realized_qty: pyRound(t.realizedQty, 4),
    commission: t.hasComm ? pyRound(t.commission, 4) : null,
    created_at: firstExec.time,
    closed_at: closed && lastExit ? lastExit.time : null,
    summary,
    started_at_ms: firstExec.when,
  };
}

// ----------------------------------------------------------------------
// 复盘
// ----------------------------------------------------------------------
function extreme(bars: Rec[], lo: number, hi: number, field: "high" | "low"): { value: number; index: number } | null {
  let best: { value: number; index: number } | null = null;
  for (let i = lo; i <= hi; i += 1) {
    const v = num(bars[i]![field]);
    if (v === null) continue;
    if (best === null || (field === "high" ? v > best.value : v < best.value)) best = { value: v, index: i };
  }
  return best;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function firstWhen(list: Rec[]): number | null {
  const times = list.map((e) => parseWhen(e["time"])).filter((t): t is number => t !== null);
  return times.length ? Math.min(...times) : null;
}

function lastWhen(list: Rec[]): number | null {
  const times = list.map((e) => parseWhen(e["time"])).filter((t): t is number => t !== null);
  return times.length ? Math.max(...times) : null;
}

export function tripStart(trip: Rec): number {
  const when = firstWhen([...(trip["entries"] ?? []), ...(trip["exits"] ?? [])]);
  if (when === null) throw new ReviewError("这笔交易没有可用的成交时间,无法定位。");
  return when;
}

export function reviewStock(trip: Rec, bars: Rec[], timeframe: string, now: number): Rec {
  if (trip["kind"] !== "stock") throw new ReviewError("这条记录不是股票交易。");
  if (!bars.length) throw new ReviewError("没有 K 线,无法复盘。");
  const daily = isDaily(bars);
  const long = trip["side"] === "LONG";
  const sign = long ? 1 : -1;
  const entries: Rec[] = trip["entries"] ?? [];
  const exits: Rec[] = trip["exits"] ?? [];
  const hasEntry = entries.length > 0;
  const closed = trip["status"] === KIND_CLOSED;
  const avgEntry: number | null = trip["avg_entry"] ?? null;
  const avgExit: number | null = trip["avg_exit"] ?? null;
  const notes: string[] = [];

  if (trip["carried"]) {
    notes.push(hasEntry
      ? `这段持仓里有${trip["opening_assumed"] ? "至少" : ""} ${trim(trip["carried_qty"])} 股建仓早于已同步的成交,没有成本价:均价与盈亏算不出,只看走势与进出位置`
      : "建仓早于已同步的成交(TWS 只给当天的成交),没有买入价:成本与盈亏未知,只复盘出场");
  }
  if (trip["opening_assumed"]) {
    notes.push("没连券商,核对不了期初持仓:先卖出的部分按“卖的是更早买的货”算(卖出不等于卖空),其余当作从空仓开始;"
      + "之前要是有这只股票的空头仓位,方向可能认反。连上券商后按真实持仓重算");
  }
  if (entries.length > 1) notes.push("中途加过仓:浮盈浮亏按最终均价与最大持仓估算,加仓之前的那段实际仓位更小");

  const startTime = tripStart(trip);
  const startIdx = indexAt(bars, startTime, daily);
  const lastBarTime = parseWhen(barTime(bars[bars.length - 1]!));
  const covered = startIdx !== null && (lastBarTime === null || startTime <= lastBarTime + barSeconds(timeframe, daily) * 1000);
  if (!covered || startIdx === null) {
    throw new ReviewError(`K 线窗口没有覆盖到这笔交易的开始时刻(${etKey(startTime, daily)}),换更长的周期再试。`);
  }
  const lastIdx = bars.length - 1;
  const at = (when: number | null): number | null => {
    if (when === null) return null;
    const idx = indexAt(bars, when, daily);
    return idx === null || idx < startIdx ? startIdx : idx;
  };
  const entryIdx = hasEntry ? at(firstWhen(entries)) : null;
  const firstExitIdx = at(firstWhen(exits));
  const lastExitIdx = at(lastWhen(exits));
  const endIdx = closed && lastExitIdx !== null ? lastExitIdx : lastIdx;

  const startClose = num(bars[startIdx]!["close"]);
  const endClose = num(bars[endIdx]!["close"]);
  if (startClose === null || endClose === null) throw new ReviewError("K 线里有空收盘价,无法复盘。");

  // ---- 持有期:只有知道从哪儿开始持有才算得出(carried 且没有加仓成交的,不知道)
  const stats: Rec = {
    start_underlying: startClose,
    end_underlying: endClose,
    hold_bars: null, hold_high: null, hold_low: null,
    mfe: null, mae: null,
    entry_position: null, exit_position: null, capture_ratio: null, capture_pct: null,
    pre_entry_move: null, pre_entry_pct: null, pre_entry_bars: null,
    post_entry_move: null, post_entry_pct: null, post_entry_bars: null,
    pre_exit_move: null, pre_exit_pct: null, pre_exit_bars: null,
    post_exit: null,
  };
  const pct = (move: number, base: number | null): number | null => (base ? pyRound((move / base) * 100, 2) : null);

  if (entryIdx !== null) {
    const hi = extreme(bars, entryIdx, endIdx, "high");
    const lo = extreme(bars, entryIdx, endIdx, "low");
    stats["hold_bars"] = endIdx - entryIdx + 1;
    if (hi && lo) {
      // 成交价可能落在 K 线之外(盘前盘后成交、K 线只有常规时段):区间把成交价也算进去
      const prices = [...entries, ...exits].map((e) => num(e["price"])).filter((p): p is number => p !== null);
      const top = Math.max(hi.value, ...prices);
      const bottom = Math.min(lo.value, ...prices);
      stats["hold_high"] = top;
      stats["hold_low"] = bottom;
      if (avgEntry !== null) {
        const fav = long ? hi : lo;
        const adv = long ? lo : hi;
        const favMove = Math.max((fav.value - avgEntry) * sign, 0);
        const advMove = Math.max((avgEntry - adv.value) * sign, 0);
        stats["mfe"] = {
          per_share: pyRound(favMove, 4), pct: pct(favMove, avgEntry), amount: pyRound(favMove * trip["qty"], 2),
          price: fav.value, time: barTime(bars[fav.index]!),
        };
        stats["mae"] = {
          per_share: pyRound(advMove, 4), pct: pct(advMove, avgEntry), amount: pyRound(advMove * trip["qty"], 2),
          price: adv.value, time: barTime(bars[adv.index]!),
        };
        const range = top - bottom;
        if (range > EPS) {
          // 1 = 买在区间最低(做空:卖在最高),0 = 买在最高
          stats["entry_position"] = pyRound(clamp01(long ? (top - avgEntry) / range : (avgEntry - bottom) / range), 3);
          if (avgExit !== null) {
            stats["exit_position"] = pyRound(clamp01(long ? (avgExit - bottom) / range : (top - avgExit) / range), 3);
          }
        }
        if (avgExit !== null && favMove > EPS) {
          stats["capture_ratio"] = pyRound(((avgExit - avgEntry) * sign) / favMove, 3);
          stats["capture_pct"] = Math.round((((avgExit - avgEntry) * sign) / favMove) * 100); // 文字与界面共用这一个整数,免得两头各自取整对不上
        }
      }
    }
    const preIdx = Math.max(entryIdx - PRE_TREND_BARS, 0);
    const preClose = num(bars[preIdx]!["close"]);
    const entryClose = num(bars[entryIdx]!["close"]);
    if (preClose !== null && entryClose !== null && preIdx !== entryIdx) {
      stats["pre_entry_move"] = pyRound(entryClose - preClose, 4);
      stats["pre_entry_pct"] = pct(entryClose - preClose, preClose);
      stats["pre_entry_bars"] = entryIdx - preIdx;
    }
    const postIdx = Math.min(entryIdx + POST_ENTRY_BARS, endIdx);
    const postClose = num(bars[postIdx]!["close"]);
    // 对第一次出手的成交价比,不对最终均价比:加过仓的话,最终均价是后来才有的,拿它衡量"一进场走得怎么样"会冤枉人
    const base = num(entries[0]!["price"]) ?? entryClose;
    if (postClose !== null && base !== null && postIdx !== entryIdx) {
      stats["post_entry_move"] = pyRound(postClose - base, 4);
      stats["post_entry_pct"] = pct(postClose - base, base);
      stats["post_entry_bars"] = postIdx - entryIdx;
    }
  }

  if (firstExitIdx !== null && lastExitIdx !== null && avgExit !== null) {
    const preIdx = Math.max(firstExitIdx - PRE_TREND_BARS, 0);
    const preClose = num(bars[preIdx]!["close"]);
    if (preClose !== null && preIdx !== firstExitIdx) {
      stats["pre_exit_move"] = pyRound(avgExit - preClose, 4);
      stats["pre_exit_pct"] = pct(avgExit - preClose, preClose);
      stats["pre_exit_bars"] = firstExitIdx - preIdx;
    }
    const afterHi = Math.min(lastExitIdx + LOOKAHEAD_BARS, lastIdx);
    if (afterHi > lastExitIdx) {
      const hi = extreme(bars, lastExitIdx + 1, afterHi, "high");
      const lo = extreme(bars, lastExitIdx + 1, afterHi, "low");
      const lastClose = num(bars[afterHi]!["close"]);
      if (hi && lo && lastClose !== null) {
        // 对"要是没走"的人有利的方向:多头看之后的最高,空头看之后的最低
        const fav = long ? hi : lo;
        const adv = long ? lo : hi;
        const missed = Math.max((fav.value - avgExit) * sign, 0);
        const avoided = Math.max((avgExit - adv.value) * sign, 0);
        stats["post_exit"] = {
          bars: afterHi - lastExitIdx,
          close: lastClose,
          move: pyRound(lastClose - avgExit, 4),
          move_pct: pct(lastClose - avgExit, avgExit),
          missed: { per_share: pyRound(missed, 4), pct: pct(missed, avgExit), price: fav.value, time: barTime(bars[fav.index]!) },
          avoided: { per_share: pyRound(avoided, 4), pct: pct(avoided, avgExit), price: adv.value, time: barTime(bars[adv.index]!) },
        };
      }
    }
  }

  // ---- 结局
  const realized: number | null = trip["realized_pnl"] ?? null;
  let unrealized: number | null = null;
  if (!closed && avgEntry !== null) unrealized = pyRound((endClose - avgEntry) * sign * trip["open_qty"], 2);
  const total = realized === null ? null : pyRound(realized + (unrealized ?? 0), 2);
  const basis = avgEntry !== null ? avgEntry * (closed ? trip["realized_qty"] : trip["qty"]) : 0;
  const endTime = closed ? lastWhen(exits) : null;
  const outcome: Rec = {
    kind: closed ? KIND_CLOSED : KIND_OPEN,
    time: endTime === null ? null : utcIso(endTime),
    time_et: endTime === null ? null : etKey(endTime, false),
    price: avgExit,
    underlying: endClose,
    realized_pnl: realized,
    unrealized_pnl: unrealized,
    pnl: total,
    pnl_pct: total !== null && basis ? pyRound((total / basis) * 100, 2) : null,
    commission: trip["commission"] ?? null,
    open_qty: trip["open_qty"],
  };
  const entryOut: Rec = {
    time: utcIso(startTime),
    time_et: etKey(startTime, false),
    price: avgEntry,
    known: hasEntry && avgEntry !== null,
    underlying: startClose,
    bar_time: barTime(bars[startIdx]!),
  };

  // ---- 图:窗口 + 每次出手一个标记 + 均价线
  const loI = Math.max(startIdx - LOOKBACK_BARS, 0);
  const hiI = Math.min(endIdx + LOOKAHEAD_BARS, lastIdx);
  let window = bars.slice(loI, hiI + 1);
  const markers: Rec[] = [];
  const mustKeep: number[] = [startIdx - loI, endIdx - loI];
  const mark = (list: Rec[], role: string): void => {
    for (const e of list) {
      const idx = at(parseWhen(e["time"]));
      if (idx === null) continue;
      mustKeep.push(idx - loI);
      markers.push({ kind: role, action: e["action"], time: barTime(bars[idx]!), price: e["price"], qty: e["qty"] });
    }
  };
  mark(entries, "entry");
  mark(exits, "exit");
  if (window.length > MAX_WINDOW) {
    const step = Math.ceil(window.length / MAX_WINDOW);
    const keep = window.filter((_, i) => i % step === 0);
    for (const must of mustKeep) {
      if (!keep.includes(window[must]!)) keep.push(window[must]!);
    }
    keep.sort((a, b) => (barTime(a) < barTime(b) ? -1 : barTime(a) > barTime(b) ? 1 : 0));
    window = keep;
  }
  const levels: Rec[] = [];
  if (avgEntry !== null) levels.push({ kind: "avg_entry", price: avgEntry });
  if (avgExit !== null) levels.push({ kind: "avg_exit", price: avgExit });

  const profile: Rec = {
    symbol: trip["symbol"], side: trip["side"], side_label: long ? "做多" : "做空",
    qty: trip["qty"], entry_qty: trip["entry_qty"], exit_qty: trip["exit_qty"], open_qty: trip["open_qty"],
    avg_entry: avgEntry, avg_exit: avgExit, carried: Boolean(trip["carried"]), carried_qty: trip["carried_qty"] ?? 0,
    currency: trip["currency"] ?? "USD",
    cost: avgEntry === null ? null : pyRound(avgEntry * trip["qty"], 2),
    entries: entries.map(withEt), exits: exits.map(withEt),
  };
  const findings = buildStockFindings(profile, entryOut, outcome, stats);
  return {
    kind: "stock",
    profile,
    entry: entryOut,
    outcome,
    stats,
    findings,
    series: { timeframe, daily, bars: window, markers, levels },
    notes,
    reviewed_at: utcIso(now),
  };
}

/** 每次出手补一个美东时间:界面上别的时刻都是美东,成交原文是 UTC。 */
function withEt(e: Rec): Rec {
  const when = parseWhen(e["time"]);
  return { ...e, time_et: when === null ? null : etKey(when, false) };
}

// ----------------------------------------------------------------------
// 结论(规则化文字)
// ----------------------------------------------------------------------
function px(v: number): string {
  return trim(v, 4);
}

function money(v: number | null): string {
  if (v === null || v === undefined) return "—";
  return v < 0 ? fmtF(v, 2) : `+${fmtF(v, 2)}`;
}

function pctText(v: number | null): string {
  if (v === null || v === undefined) return "—";
  return `${v > 0 ? "+" : ""}${fmtF(v, 2)}%`;
}

export function buildStockFindings(profile: Rec, entry: Rec, outcome: Rec, stats: Rec): Rec[] {
  const out: Rec[] = [];
  const long = profile["side"] === "LONG";
  const open = long ? "买入" : "卖空";
  const close = long ? "卖出" : "买回";
  const symbol = profile["symbol"];
  const entries: Rec[] = profile["entries"] ?? [];
  const exits: Rec[] = profile["exits"] ?? [];
  const sign = long ? 1 : -1;
  // 涨跌不到万分之五就别硬分方向:真机上见过「下跌 0(0.00%),是逆着走势接回调的」
  const flat = (p: number | null): boolean => p !== null && Math.abs(p) < 0.05;

  if (!entry["known"] && !exits.length) {
    out.push({ tone: "warn", title: "成本未知", text:
      `${symbol} 在已同步的成交之前就有 ${px(profile["carried_qty"])} 股,之后又${open} ${px(profile["entry_qty"])} 股(${entries.length} 次出手)。` +
      "老仓位没有建仓价,整段持仓的均价与盈亏算不出,下面只看这几次出手前后的走势。" });
  } else if (!entry["known"]) {
    out.push({ tone: "warn", title: "只有出场", text:
      `${close} ${symbol} ${px(profile["exit_qty"])} 股,均价 ${profile["avg_exit"] === null ? "—" : px(profile["avg_exit"])}(${exits.length} 次出手)。` +
      "这段持仓建立在已同步的成交之前,没有建仓价,成本与盈亏算不出,下面只看出场的位置。" });
  } else {
    const parts = [`${profile["side_label"]} ${symbol} ${px(profile["qty"])} 股,${open}均价 ${px(profile["avg_entry"])}(${entries.length} 次出手),成本 ${fmtF(profile["cost"], 2)}`];
    if (profile["avg_exit"] !== null) parts.push(`${close}均价 ${px(profile["avg_exit"])}(${exits.length} 次出手,共 ${px(profile["exit_qty"])} 股)`);
    out.push({ tone: "info", title: "结构", text: `${parts.join(";")}。` });
  }

  if (stats["pre_entry_move"] !== null) {
    const mv: number = stats["pre_entry_move"];
    const withTrend = (mv > 0) === long;
    if (flat(stats["pre_entry_pct"])) {
      out.push({ tone: "info", title: "开仓前走势", text: `开仓前 ${stats["pre_entry_bars"]} 根 K 线基本没动(${pctText(stats["pre_entry_pct"])}),是在横盘里进的。` });
    } else out.push({ tone: "info", title: "开仓前走势", text:
      `开仓前 ${stats["pre_entry_bars"]} 根 K 线${mv > 0 ? "上涨" : "下跌"} ${px(Math.abs(mv))}(${pctText(stats["pre_entry_pct"])}),` +
      (withTrend ? `是顺着走势${long ? "追进去" : "追空"}的。` : `是逆着走势${long ? "接回调" : "摸顶做空"}的。`) });
  }

  if (stats["entry_position"] !== null) {
    const p: number = stats["entry_position"];
    const where = `${open}均价 ${px(profile["avg_entry"])} 落在持有期区间 ${px(stats["hold_low"])} ~ ${px(stats["hold_high"])} 的`;
    const rank = fmtF((1 - p) * 100, 0);
    if (p >= 0.7) out.push({ tone: "good", title: "进场位置", text: `${where}${long ? "低位" : "高位"}(从${long ? "低" : "高"}往${long ? "高" : "低"}数第 ${rank}%),进得不错。` });
    else if (p <= 0.3) out.push({ tone: "warn", title: "进场位置", text: `${where}${long ? "高位" : "低位"}(从${long ? "低" : "高"}往${long ? "高" : "低"}数第 ${rank}%),之后有过更好的价格。` });
    else out.push({ tone: "info", title: "进场位置", text: `${where}中段(从${long ? "低" : "高"}往${long ? "高" : "低"}数第 ${rank}%)。` });
  }

  if (stats["post_entry_move"] !== null) {
    const mv: number = stats["post_entry_move"];
    const favorable = (mv > 0) === long && mv !== 0;
    if (flat(stats["post_entry_pct"])) {
      out.push({ tone: "info", title: "开仓后走势", text: `开仓后 ${stats["post_entry_bars"]} 根 K 线相对首次成交价基本没动(${pctText(stats["post_entry_pct"])})。` });
    } else out.push({ tone: favorable ? "good" : "warn", title: "开仓后走势", text:
      `开仓后 ${stats["post_entry_bars"]} 根 K 线相对首次成交价${mv > 0 ? "上涨" : "下跌"} ${px(Math.abs(mv))}(${pctText(stats["post_entry_pct"])}),${favorable ? "一进场就朝有利方向走" : "一进场就先被套"}。` });
  }

  const mfe = stats["mfe"], mae = stats["mae"];
  if (mfe !== null && mae !== null && stats["hold_bars"] > 1) {
    const heavy = mae["per_share"] > mfe["per_share"] * 2 && mae["per_share"] > 0;
    out.push({ tone: heavy ? "warn" : "info", title: "持有期", text:
      `持有 ${stats["hold_bars"]} 根 K 线。最大浮盈 ${money(mfe["amount"])}(${pctText(mfe["pct"])},${mfe["time"]} 到 ${px(mfe["price"])});` +
      `最大浮亏 ${money(-mae["amount"])}(${pctText(mae["pct"] === null ? null : -mae["pct"])},${mae["time"]} 到 ${px(mae["price"])})。` +
      (heavy ? "扛过的浮亏是拿到过的浮盈的两倍以上。" : "") });
  }

  if (entry["known"] && profile["avg_exit"] !== null && stats["exit_position"] !== null) {
    const cap: number | null = stats["capture_ratio"];
    const capPct: number | null = stats["capture_pct"];
    let text = `${close}均价 ${px(profile["avg_exit"])} 落在持有期区间的 ${fmtF(stats["exit_position"] * 100, 0)}% 位置(100% = ${long ? "最高" : "最低"})`;
    let tone = "info";
    if (cap !== null) {
      if (cap >= 0.6) { tone = "good"; text += `,兑现了最大浮盈的 ${capPct}%`; }
      else if (cap > 0) { text += `,只兑现了最大浮盈的 ${capPct}%`; if (cap < 0.3) tone = "warn"; }
      else { tone = "warn"; text += `,曾经浮盈 ${money(mfe === null ? null : mfe["amount"])},最后却${cap < 0 ? "亏着" : "平着"}出来`; }
    }
    out.push({ tone, title: "出场位置", text: `${text}。` });
  } else if (!entry["known"] && stats["pre_exit_move"] !== null) {
    const mv: number = stats["pre_exit_move"];
    const intoStrength = (mv > 0) === long;
    if (flat(stats["pre_exit_pct"])) {
      out.push({ tone: "info", title: "出场前走势", text: `${close}前 ${stats["pre_exit_bars"]} 根 K 线到成交价基本没动(${pctText(stats["pre_exit_pct"])})。` });
    } else out.push({ tone: intoStrength ? "good" : "info", title: "出场前走势", text:
      `${close}前 ${stats["pre_exit_bars"]} 根 K 线到成交价${mv > 0 ? "上涨" : "下跌"} ${px(Math.abs(mv))}(${pctText(stats["pre_exit_pct"])}),` +
      (intoStrength ? `是${long ? "趁涨" : "趁跌"}出的。` : `是${long ? "跌下来之后" : "涨上去之后"}才出的。`) });
  }

  const pe = stats["post_exit"];
  if (pe !== null) {
    const missed = pe["missed"], avoided = pe["avoided"];
    const early = missed["per_share"] > avoided["per_share"];
    out.push({ tone: early ? "warn" : "good", title: `${close}之后`, text:
      `${close}后 ${pe["bars"]} 根 K 线,${long ? "最高" : "最低"}到 ${px(missed["price"])}(比${close}价${long ? "高" : "低"} ${px(missed["per_share"])},${pctText(missed["pct"] === null ? null : missed["pct"] * sign)}),` +
      `${long ? "最低" : "最高"}到 ${px(avoided["price"])}(${long ? "低" : "高"} ${px(avoided["per_share"])},${pctText(avoided["pct"] === null ? null : -avoided["pct"] * sign)});` +
      (early ? `走了之后还有一段${long ? "涨" : "跌"}幅没吃到。` : `走了之后${long ? "回落" : "反弹"}更多,这一下躲开了。`) });
  }

  if (outcome["kind"] === KIND_CLOSED) {
    if (outcome["pnl"] === null) {
      out.push({ tone: "info", title: "平仓", text: `${outcome["time_et"]} 全部${close},均价 ${outcome["price"] === null ? "—" : px(outcome["price"])};没有建仓价,盈亏未知。` });
    } else {
      out.push({ tone: outcome["pnl"] > 0 ? "good" : "bad", title: "平仓", text:
        `${outcome["time_et"]} 全部平仓,已实现盈亏 ${money(outcome["pnl"])}(${pctText(outcome["pnl_pct"])})` +
        (outcome["commission"] ? `,佣金 ${fmtF(outcome["commission"], 2)} 未扣` : "") + "。" });
    }
  } else {
    const bits = [`还持有 ${px(outcome["open_qty"])} 股,最新 ${px(outcome["underlying"])}`];
    if (outcome["unrealized_pnl"] !== null) bits.push(`浮动盈亏 ${money(outcome["unrealized_pnl"])}`);
    if (outcome["realized_pnl"] !== null && exits.length) bits.push(`已实现 ${money(outcome["realized_pnl"])}`);
    out.push({ tone: "info", title: "持仓中", text: `${bits.join(",")}。` });
  }
  return out;
}
