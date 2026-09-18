/**
 * 交易复盘:一张蝴蝶 + 标的在开仓/平仓前后的 K 线 → 结构、盈亏区间、走势统计与规则化结论。
 * 行为规格 = ../engine-python 的 tradereview.py,逐字段对拍(baseline/golden/tradereview.json)。
 *
 * 全部是纯函数,不碰券商、不碰存储。几条口径:
 * - 标的价格用 K 线收盘价,开仓/平仓时点对齐到"该时刻或之前最后一根 K 线";时间戳全系统按美东。
 * - 理论价值 = 到期内在价值(蝴蝶的"帐篷"),是下界,不是当时能卖到的价。
 * - 盈亏平衡与最大盈亏按成交均价算,没成交就用限价并标注"估算"。
 */
import { fmtF, pyRound } from "./py.js";
import { ET, ibWallTime, wallParts, wallToEpoch, zonedEpoch } from "./tz.js";

type Rec = Record<string, any>;

export const LOOKBACK_BARS = 40;
export const LOOKAHEAD_BARS = 20;
export const MAX_WINDOW = 240;
export const PRE_TREND_BARS = 20;
export const POST_ENTRY_BARS = 6;

export const KIND_CLOSED = "closed";
export const KIND_EXPIRED = "expired";
export const KIND_OPEN = "open";

export class ReviewError extends Error {}

// ----------------------------------------------------------------------
// 结构
// ----------------------------------------------------------------------
function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const out = Number(value);
  return Number.isFinite(out) ? out : null;
}

export function fmtExpiry(raw: unknown): string {
  const s = String(raw ?? "");
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s;
}

export function butterflyProfile(record: Rec): Rec | null {
  const contract = record["contract"] ?? {};
  if (contract["secType"] !== "BAG") return null;
  const legs: Rec[] = [...(contract["legs"] ?? [])];
  if (legs.length !== 3) return null;
  const rows: Array<[number, number, string, Rec]> = [];
  for (const leg of legs) {
    const strike = num(leg["strike"]);
    if (strike === null) return null;
    rows.push([strike, Math.trunc(Number(leg["ratio"] ?? 1) || 1), String(leg["action"] ?? ""), leg]);
  }
  rows.sort((a, b) => a[0] - b[0]);
  const [[k1, r1, a1, l1], [k2, r2, a2, l2], [k3, r3, a3, l3]] = rows as [
    [number, number, string, Rec], [number, number, string, Rec], [number, number, string, Rec],
  ];
  if (r1 !== 1 || r2 !== 2 || r3 !== 1 || a1 !== a3 || a2 === a1) return null;
  const rights = new Set([l1, l2, l3].map((l) => String(l["right"] ?? "")));
  const expiries = new Set([l1, l2, l3].map((l) => String(l["lastTradeDateOrContractMonth"] ?? "")));
  if (rights.size !== 1 || expiries.size !== 1) return null;

  const order = record["order"] ?? {};
  const ibkr = record["ibkr"] ?? {};
  const action = String(order["action"] ?? "BUY").toUpperCase();
  const fill = num(ibkr["avg_fill_price"]);
  const limit = num(order["lmtPrice"]);
  const debit = fill !== null ? fill : limit;
  const qty = Math.trunc(num(order["totalQuantity"]) || 1);
  const multiplier = num(contract["multiplier"]) || num(l1["multiplier"]) || 100.0;
  const right = [...rights][0]!;
  const expiryRaw = [...expiries][0]!;
  return {
    symbol: String(contract["symbol"] ?? ""),
    right,
    right_label: right === "P" ? "看跌" : "看涨",
    expiry: fmtExpiry(expiryRaw),
    expiry_raw: expiryRaw,
    lower: k1, center: k2, upper: k3,
    width: pyRound(k2 - k1, 4),
    width_upper: pyRound(k3 - k2, 4),
    symmetric: Math.abs((k2 - k1) - (k3 - k2)) < 1e-9,
    action,
    qty,
    multiplier,
    debit,
    price_estimated: fill === null,
    trading_class: String(l1["tradingClass"] ?? ""),
  };
}

export function sameButterfly(a: Rec, b: Rec): boolean {
  return a["symbol"] === b["symbol"] && a["right"] === b["right"] && a["expiry_raw"] === b["expiry_raw"]
    && a["lower"] === b["lower"] && a["center"] === b["center"] && a["upper"] === b["upper"];
}

export function payoffPerUnit(profile: Rec, s: number): number {
  const k1 = profile["lower"], k2 = profile["center"], k3 = profile["upper"];
  let v: number;
  if (profile["right"] === "P") {
    v = Math.max(k1 - s, 0) - 2 * Math.max(k2 - s, 0) + Math.max(k3 - s, 0);
  } else {
    v = Math.max(s - k1, 0) - 2 * Math.max(s - k2, 0) + Math.max(s - k3, 0);
  }
  return pyRound(v, 4);
}

export function pnlAt(profile: Rec, s: number): number | null {
  const debit = profile["debit"];
  if (debit === null || debit === undefined) return null;
  const sign = profile["action"] === "BUY" ? 1.0 : -1.0;
  return pyRound(sign * (payoffPerUnit(profile, s) - debit) * profile["multiplier"] * profile["qty"], 2);
}

export function zone(profile: Rec): Rec {
  const debit = profile["debit"];
  const mult = profile["multiplier"], qty = profile["qty"];
  if (debit === null || debit === undefined) {
    return { lower_be: null, upper_be: null, max_profit: null, max_loss: null, known: false };
  }
  const width = Math.min(profile["width"], profile["width_upper"]);
  const tent = (width - debit) * mult * qty;
  const premium = debit * mult * qty;
  const long = profile["action"] === "BUY";
  return {
    lower_be: pyRound(profile["lower"] + debit, 4),
    upper_be: pyRound(profile["upper"] - debit, 4),
    max_profit: pyRound(long ? tent : premium, 2),
    max_loss: pyRound(long ? premium : tent, 2),
    known: true,
  };
}

// ----------------------------------------------------------------------
// 时间(全部用 epoch 毫秒表示时刻)
// ----------------------------------------------------------------------
function etEpoch(y: number, mo: number, d: number, h: number, mi: number, se: number): number | null {
  return zonedEpoch({ year: y, month: mo, day: d, hour: h, minute: mi, second: se }, ET);
}

/** 记录里的时间 → epoch 毫秒。认:IB 成交时间(ibkr.fills[].time 存的是 execution.time 原文——
 * 实时推送 '20260910-10:00:01' 是 UTC,reqExecutions 回的 '20260910 05:00:01 US/Central' 按所带时区,
 * 不带时区的 '20260910 05:00:01' 按美东)、美东墙钟 'YYYY-MM-DD[ HH:MM[:SS]]'、带时区的 ISO。
 * 认不出或日期不合法回 null。 */
export function parseWhen(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const s = String(value).trim();
  if (!s) return null;
  const ib = ibWallTime(s);
  if (ib) return zonedEpoch(ib.wall, ib.tz);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) {
    return etEpoch(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  }
  // ISO 带时区:Python fromisoformat 接受 "2026-08-12 14:36:10+00:00",Date.parse 要 T 分隔
  const iso = s.replace(" ", "T").replace(/Z$/, "+00:00");
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

export function etKey(epochMs: number, daily: boolean): string {
  const p = wallParts(epochMs, ET);
  const date = `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
  return daily ? date : `${date} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** Python `datetime.astimezone(utc).isoformat()` 同形:秒精度,+00:00 后缀。 */
export function utcIso(epochMs: number): string {
  const d = new Date(epochMs);
  const base = d.toISOString().slice(0, 19);
  const ms = d.getUTCMilliseconds();
  return ms ? `${base}.${String(ms).padStart(3, "0")}000+00:00` : `${base}+00:00`;
}

export function entryOf(record: Rec): { time: number; estimated: boolean } {
  const fills: Rec[] = (record["ibkr"] ?? {})["fills"] ?? [];
  const times = fills.map((f) => parseWhen(f["time"])).filter((t): t is number => t !== null);
  if (times.length) return { time: Math.min(...times), estimated: false };
  const created = parseWhen(record["created_at"]);
  if (created === null) throw new ReviewError("这条记录既没有成交时间也没有提交时间,无法定位开仓时刻。");
  return { time: created, estimated: true };
}

export function findExit(profile: Rec, entryTime: number, others: Rec[], excludeId: unknown): Rec | null {
  let best: Rec | null = null;
  for (const other of others) {
    if (other["id"] === excludeId) continue;
    const p = butterflyProfile(other);
    if (p === null || !sameButterfly(p, profile) || p["action"] === profile["action"]) continue;
    const ibkr = other["ibkr"] ?? {};
    const fill = num(ibkr["avg_fill_price"]);
    if (fill === null && other["final_status"] !== "filled") continue;
    const times = ((ibkr["fills"] ?? []) as Rec[]).map((f) => parseWhen(f["time"])).filter((t): t is number => t !== null);
    const when = times.length ? Math.min(...times) : parseWhen(other["created_at"]);
    if (when === null || when < entryTime) continue;
    if (best === null || when < best["time"]) {
      best = { time: when, price: fill, record_id: other["id"] ?? null, estimated: fill === null };
    }
  }
  return best;
}

export function expiryClose(profile: Rec): number {
  const [y, m, d] = String(profile["expiry"]).split("-").map(Number) as [number, number, number];
  return wallToEpoch({ year: y, month: m, day: d, hour: 16, minute: 0, second: 0 }, ET);
}

// ----------------------------------------------------------------------
// K 线定位与统计
// ----------------------------------------------------------------------
export function isDaily(bars: Rec[]): boolean {
  return bars.length > 0 && String(bars[0]!["time"] ?? bars[0]!["date"] ?? "").length <= 10;
}

export function barTime(bar: Rec): string {
  return String(bar["time"] ?? bar["date"] ?? "");
}

export function indexAt(bars: Rec[], when: number, daily: boolean): number | null {
  const key = etKey(when, daily);
  let out: number | null = null;
  for (let i = 0; i < bars.length; i += 1) {
    if (barTime(bars[i]!) <= key) out = i;
    else break;
  }
  return out;
}

function closest(profile: Rec, bars: Rec[], lo: number, hi: number): [number, number, number] | null {
  let best: [number, number, number] | null = null;
  for (let i = lo; i <= hi; i += 1) {
    const c = num(bars[i]!["close"]);
    if (c === null) continue;
    const d = Math.abs(c - profile["center"]);
    if (best === null || d < best[0]) best = [d, i, c];
  }
  return best;
}

export function barSeconds(timeframe: string, daily: boolean): number {
  if (daily) return 86400;
  const m = /^(\d+)([mhd])$/.exec(String(timeframe ?? ""));
  if (!m) return 300;
  const n = Number(m[1]);
  const unit = m[2] as "m" | "h" | "d";
  return n * ({ m: 60, h: 3600, d: 86400 } as const)[unit];
}

export function pickTimeframe(entryTime: number, now: number): string {
  const age = (now - entryTime) / 86_400_000;
  if (age <= 1.5) return "1m";
  if (age <= 4.5) return "5m";
  if (age <= 9.5) return "15m";
  if (age <= 28) return "1h";
  return "1d";
}

export function review(record: Rec, others: Rec[], bars: Rec[], timeframe: string, now: number): Rec {
  const profile = butterflyProfile(record);
  if (profile === null) throw new ReviewError("这条记录不是蝴蝶组合(需要 1:2:1 三腿、同到期、同方向)。");
  if (!bars.length) throw new ReviewError("没有 K 线,无法复盘。");
  const daily = isDaily(bars);
  const z = zone(profile);
  const notes: string[] = [];
  if (profile["price_estimated"]) {
    notes.push(profile["debit"] !== null ? "这笔单没有成交均价,盈亏区间与最大盈亏按限价估算"
      : "这笔单没有成交价也没有限价,算不出盈亏区间与盈亏");
  }

  const entry = entryOf(record);
  if (entry.estimated) notes.push("没有成交时间,开仓时刻按提交时间算");
  const entryIdx = indexAt(bars, entry.time, daily);
  const lastTime = parseWhen(barTime(bars[bars.length - 1]!));
  const covered = entryIdx !== null && (
    lastTime === null || entry.time <= lastTime + barSeconds(timeframe, daily) * 1000
  );
  if (!covered || entryIdx === null) {
    throw new ReviewError(`K 线窗口没有覆盖到开仓时刻(${etKey(entry.time, daily)}),换更长的周期再试。`);
  }

  // ---- 结局:平仓 / 到期 / 持仓中
  const exitRec = findExit(profile, entry.time, others, record["id"]);
  const lastIdx = bars.length - 1;
  let kind: string;
  let exitTime: number | null;
  let exitIdx: number;
  if (exitRec !== null) {
    kind = KIND_CLOSED;
    exitTime = exitRec["time"];
    const idx = indexAt(bars, exitTime!, daily);
    exitIdx = idx === null || idx < entryIdx ? entryIdx : idx;
    if (exitRec["estimated"]) notes.push("平仓单没有成交均价,平仓价按记录估算不出,盈亏留空");
  } else if (now >= expiryClose(profile)) {
    kind = KIND_EXPIRED;
    exitTime = expiryClose(profile);
    const idx = indexAt(bars, exitTime, daily);
    exitIdx = idx === null || idx < entryIdx ? entryIdx : idx;
  } else {
    kind = KIND_OPEN;
    exitTime = null;
    exitIdx = lastIdx;
  }

  const entryClose = num(bars[entryIdx]!["close"]);
  const exitClose = num(bars[exitIdx]!["close"]);
  if (entryClose === null || exitClose === null) throw new ReviewError("K 线里有空收盘价,无法复盘。");

  // ---- 持有期统计
  const hold = bars.slice(entryIdx, exitIdx + 1);
  const highs = hold.map((b) => num(b["high"])).filter((h): h is number => h !== null);
  const lows = hold.map((b) => num(b["low"])).filter((l): l is number => l !== null);
  const hiVal = Math.max(...highs);
  const loVal = Math.min(...lows);
  const near = closest(profile, bars, entryIdx, exitIdx);
  let farthest: [number, number] | null = null;
  for (let i = entryIdx; i <= exitIdx; i += 1) {
    const c = num(bars[i]!["close"]);
    if (c === null) continue;
    const d = Math.abs(c - profile["center"]);
    if (farthest === null || d > farthest[0]) farthest = [d, i];
  }
  let inZone = 0, touched = 0;
  if (z["known"]) {
    for (const b of hold) {
      const c = num(b["close"]), h = num(b["high"]), l = num(b["low"]);
      if (c !== null && z["lower_be"] <= c && c <= z["upper_be"]) inZone += 1;
      if (h !== null && l !== null && l <= z["upper_be"] && h >= z["lower_be"]) touched += 1;
    }
  }
  let bestPnl: number | null = null;
  let bestIdx: number | null = null;
  if (z["known"]) {
    for (let i = entryIdx; i <= exitIdx; i += 1) {
      const c = num(bars[i]!["close"]);
      if (c === null) continue;
      const p = pnlAt(profile, c);
      if (bestPnl === null || (p !== null && p > bestPnl)) { bestPnl = p; bestIdx = i; }
    }
  }

  const preIdx = Math.max(entryIdx - PRE_TREND_BARS, 0);
  const preClose = num(bars[preIdx]!["close"]);
  const preMove = preClose === null || preIdx === entryIdx ? null : pyRound(entryClose - preClose, 4);
  const postIdx = Math.min(entryIdx + POST_ENTRY_BARS, exitIdx);
  const postClose = num(bars[postIdx]!["close"]);
  const postMove = postClose === null || postIdx === entryIdx ? null : pyRound(postClose - entryClose, 4);

  const distEntry = pyRound(entryClose - profile["center"], 4);
  const distExit = pyRound(exitClose - profile["center"], 4);
  const width = profile["width"] || 1.0;

  // ---- 结局数字
  const settleValue = payoffPerUnit(profile, exitClose);
  const exitPrice: number | null = exitRec !== null ? exitRec["price"] : (kind === KIND_EXPIRED ? settleValue : null);
  let pnl: number | null = null;
  let pnlPct: number | null = null;
  if (profile["debit"] !== null && exitPrice !== null) {
    const sign = profile["action"] === "BUY" ? 1.0 : -1.0;
    pnl = pyRound(sign * (exitPrice - profile["debit"]) * profile["multiplier"] * profile["qty"], 2);
    const basis = profile["debit"] * profile["multiplier"] * profile["qty"];
    pnlPct = basis ? pyRound((pnl / basis) * 100.0, 1) : null;
  }
  const pnlIfNow = kind === KIND_OPEN ? pnlAt(profile, exitClose) : null;

  const stats: Rec = {
    entry_underlying: entryClose,
    exit_underlying: exitClose,
    move_points: pyRound(exitClose - entryClose, 4),
    dist_entry: distEntry,
    dist_entry_widths: pyRound(distEntry / width, 2),
    dist_exit: distExit,
    dist_exit_widths: pyRound(distExit / width, 2),
    moved_toward_center: Math.abs(distExit) < Math.abs(distEntry),
    hold_bars: hold.length,
    hold_high: hiVal,
    hold_low: loVal,
    closest: near === null ? null : { price: near[2], distance: pyRound(near[0], 4), time: barTime(bars[near[1]]!) },
    farthest: { distance: pyRound(farthest![0], 4), time: barTime(bars[farthest![1]]!) },
    in_zone_bars: z["known"] ? inZone : null,
    in_zone_ratio: z["known"] && hold.length ? pyRound(inZone / hold.length, 3) : null,
    touched_zone_bars: z["known"] ? touched : null,
    best_theoretical: bestIdx === null ? null : {
      pnl: bestPnl, time: barTime(bars[bestIdx]!), underlying: num(bars[bestIdx]!["close"]),
    },
    pre_entry_move: preMove,
    pre_entry_bars: entryIdx - preIdx,
    post_entry_move: postMove,
    post_entry_bars: postIdx - entryIdx,
    settle_value: settleValue,
  };

  const outcome: Rec = {
    kind,
    time: exitTime === null ? null : utcIso(exitTime),
    time_et: exitTime === null ? null : etKey(exitTime, false),
    price: exitPrice,
    underlying: exitClose,
    pnl,
    pnl_pct: pnlPct,
    pnl_if_expired_now: pnlIfNow,
    record_id: exitRec === null ? null : exitRec["record_id"],
  };
  const entryOut: Rec = {
    time: utcIso(entry.time),
    time_et: etKey(entry.time, false),
    estimated: entry.estimated,
    price: profile["debit"],
    price_estimated: profile["price_estimated"],
    underlying: entryClose,
    bar_time: barTime(bars[entryIdx]!),
  };

  // ---- 图:窗口 + 标记 + 关键位
  const loI = Math.max(entryIdx - LOOKBACK_BARS, 0);
  const hiI = Math.min(exitIdx + LOOKAHEAD_BARS, lastIdx);
  let window = bars.slice(loI, hiI + 1);
  if (window.length > MAX_WINDOW) {
    const step = Math.ceil(window.length / MAX_WINDOW);
    const keep = window.filter((_, i) => i % step === 0);
    for (const must of [entryIdx - loI, exitIdx - loI]) {
      if (!keep.includes(window[must]!)) keep.push(window[must]!);
    }
    keep.sort((a, b) => (barTime(a) < barTime(b) ? -1 : barTime(a) > barTime(b) ? 1 : 0));
    window = keep;
  }
  const markers: Rec[] = [{ kind: "entry", time: barTime(bars[entryIdx]!), price: entryClose }];
  if (kind !== KIND_OPEN) {
    markers.push({ kind: kind === KIND_CLOSED ? "exit" : "expiry", time: barTime(bars[exitIdx]!), price: exitClose });
  }
  const levels: Rec[] = [
    { kind: "lower", price: profile["lower"] },
    { kind: "center", price: profile["center"] },
    { kind: "upper", price: profile["upper"] },
  ];
  if (z["known"]) {
    levels.push({ kind: "lower_be", price: z["lower_be"] });
    levels.push({ kind: "upper_be", price: z["upper_be"] });
  }

  const findings = buildFindings(profile, z, entryOut, outcome, stats);
  return {
    profile,
    zone: z,
    entry: entryOut,
    outcome,
    stats,
    findings,
    series: { timeframe, daily, bars: window, markers, levels },
    notes,
    reviewed_at: utcIso(now),
  };
}

// ----------------------------------------------------------------------
// 结论(规则化文字)
// ----------------------------------------------------------------------
function pts(v: number): string {
  return fmtF(v, 2).replace(/0+$/, "").replace(/\.$/, "");
}

function money(v: number | null): string {
  if (v === null || v === undefined) return "—";
  return v < 0 ? fmtF(v, 2) : `+${fmtF(v, 2)}`;
}

export function buildFindings(profile: Rec, z: Rec, entry: Rec, outcome: Rec, stats: Rec): Rec[] {
  const out: Rec[] = [];
  const long = profile["action"] === "BUY";
  const verb = long ? "买入" : "卖出";
  const what = `${verb} ${profile["symbol"]} ${pts(profile["lower"])}/${pts(profile["center"])}/${pts(profile["upper"])} ${profile["right_label"]}蝴蝶(翼宽 ${pts(profile["width"])})`;
  if (z["known"]) {
    out.push({ tone: "info", title: "结构", text:
      `${what},权利金 ${pts(profile["debit"])}${profile["price_estimated"] ? "(估算)" : ""};到期盈利区 ${pts(z["lower_be"])} ~ ${pts(z["upper_be"])},最大盈利 ${fmtF(z["max_profit"], 2)},最大亏损 ${fmtF(z["max_loss"], 2)}。` });
  } else {
    out.push({ tone: "info", title: "结构", text: `${what},没有成交价,盈亏区间未知。` });
  }

  const d: number = stats["dist_entry"];
  const side = d > 0 ? "上方" : "下方";
  const need = long ? (d > 0 ? "下跌" : "上涨") : "远离中心";
  const favor = (toward: boolean): boolean => (long ? toward : !toward);
  const dw = Math.abs(stats["dist_entry_widths"]);
  let pos: string;
  let tone: string;
  if (dw <= 0.5) {
    pos = `开仓时标的 ${pts(entry["underlying"])} 就在中心附近(偏 ${side} ${pts(Math.abs(d))} 点),结构一开始就在帐篷里。`;
    tone = "good";
  } else if (dw <= 2) {
    pos = `开仓时标的 ${pts(entry["underlying"])} 在中心${side} ${pts(Math.abs(d))} 点(${fmtF(dw, 1)} 个翼宽),需要标的${need}到区间内。`;
    tone = "info";
  } else {
    pos = `开仓时标的 ${pts(entry["underlying"])} 离中心 ${pts(Math.abs(d))} 点(${fmtF(dw, 1)} 个翼宽),这是一张押方向的远端蝴蝶,靠标的${need}才有价值。`;
    tone = "warn";
  }
  out.push({ tone, title: "开仓位置", text: pos });

  if (stats["pre_entry_move"] !== null) {
    const mv: number = stats["pre_entry_move"];
    const toward = (mv < 0) === (d > 0);
    out.push({ tone: favor(toward) ? "good" : "warn", title: "开仓前走势",
      text: `开仓前 ${stats["pre_entry_bars"]} 根 K 线标的${mv > 0 ? "上涨" : "下跌"} ${pts(Math.abs(mv))} 点,${favor(toward) ? "顺着蝴蝶要的方向" : "与蝴蝶要的方向相反(逆势进场)"}。` });
  }
  if (stats["post_entry_move"] !== null) {
    const mv: number = stats["post_entry_move"];
    const toward = (mv < 0) === (d > 0);
    out.push({ tone: favor(toward) ? "good" : "warn", title: "开仓后走势",
      text: `开仓后 ${stats["post_entry_bars"]} 根 K 线标的${mv > 0 ? "上涨" : "下跌"} ${pts(Math.abs(mv))} 点,${toward ? "朝中心走" : "背离中心"}。` });
  }

  const c = stats["closest"];
  if (c !== null && stats["hold_bars"] > 1) {
    let text = `持有期间标的区间 ${pts(stats["hold_low"])} ~ ${pts(stats["hold_high"])};最接近中心 ${pts(c["price"])}(${c["time"]},距中心 ${pts(c["distance"])} 点)。`;
    if (stats["in_zone_ratio"] !== null) {
      text += ` 收盘落在盈利区内的 K 线 ${stats["in_zone_bars"]}/${stats["hold_bars"]}(${fmtF(stats["in_zone_ratio"] * 100, 0)}%)。`;
    }
    out.push({ tone: "info", title: "持有期", text });
  }

  const bt = stats["best_theoretical"];
  if (bt !== null && bt["pnl"] !== null && bt["pnl"] > 0 && outcome["kind"] !== KIND_OPEN) {
    const realized: number | null = outcome["pnl"];
    if (realized === null || bt["pnl"] > realized) {
      out.push({ tone: "warn", title: "曾有的机会",
        text: `${bt["time"]} 标的到 ${pts(bt["underlying"])},若当时到期理论盈利 ${money(bt["pnl"])}(内在价值口径,是下界);最终结果 ${money(realized)}。` });
    }
  }

  const k = outcome["kind"];
  if (k === KIND_CLOSED) {
    out.push({ tone: (outcome["pnl"] ?? 0) > 0 ? "good" : "bad", title: "平仓",
      text: `${outcome["time_et"]} 以 ${outcome["price"] === null ? "—" : pts(outcome["price"])} 平仓,盈亏 ${money(outcome["pnl"])}(${outcome["pnl_pct"] === null ? "—" : fmtF(outcome["pnl_pct"], 1)}%),平仓时标的 ${pts(outcome["underlying"])}(距中心 ${pts(Math.abs(stats["dist_exit"]))} 点)。` });
  } else if (k === KIND_EXPIRED) {
    const inside = z["known"] && z["lower_be"] <= outcome["underlying"] && outcome["underlying"] <= z["upper_be"];
    out.push({ tone: (outcome["pnl"] ?? 0) > 0 ? "good" : "bad", title: "到期",
      text: `到期结算标的 ${pts(outcome["underlying"])},${z["known"] ? (inside ? "落在盈利区内" : "落在盈利区外") : "盈利区未知"},结构价值 ${pts(stats["settle_value"])},盈亏 ${money(outcome["pnl"])}(${outcome["pnl_pct"] === null ? "—" : fmtF(outcome["pnl_pct"], 1)}%)。` });
  } else {
    out.push({ tone: "info", title: "持仓中",
      text: `尚未到期,最新标的 ${pts(outcome["underlying"])}(距中心 ${pts(Math.abs(stats["dist_exit"]))} 点),若此刻到期盈亏 ${money(outcome["pnl_if_expired_now"])}。` });
  }

  if (k !== KIND_OPEN) {
    if (favor(stats["moved_toward_center"])) {
      out.push({ tone: "good", title: "方向", text: `方向判断正确:标的从开仓到结局朝中心靠近了 ${pts(Math.abs(stats["dist_entry"]) - Math.abs(stats["dist_exit"]))} 点。` });
    } else {
      out.push({ tone: "bad", title: "方向", text: `方向判断有误:标的从开仓到结局离中心更远了 ${pts(Math.abs(stats["dist_exit"]) - Math.abs(stats["dist_entry"]))} 点。` });
    }
  }
  return out;
}
