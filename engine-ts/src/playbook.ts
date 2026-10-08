/** SPX 日内剧本的纯计算:预期波动区间、剧本状态机、目标位、加速档。不认识券商,离线能跑。
 *
 * 口径(docs/features/playbook.md):
 * * **预期波动 EM = 平值跨式 × √(π/2)。** 平值跨式的价格约等于「到期前波动的平均绝对值」,正态下它是一个标准差的
 *   √(2/π) 倍,反过来乘 √(π/2) 就是一个标准差。这是恒等式,不是调出来的系数。
 * * **三条区间**:昨日(上一个收盘后十分钟取的、今天到期的跨式,锚是昨收)、盘初(09:35,锚是当时现价)、
 *   当前剩余(每五分钟重取,锚是当时现价)。
 * * **状态**:跌破昨日区间下沿 = B3,站上当前区间上沿 = B2,两条线之间 = R。进了 B2 / B3 之后记住触发它的那条线,
 *   回到线的另一侧才算失效——当前区间每五分钟换一次,不记住的话状态会跟着新区间自己变回去。
 * * 止损位与概率分流不在这里:还没有能反推出算法的样本,不编。
 */
import type {
  OptionWallStrike, PlaybookAccel, PlaybookBand, PlaybookEvent, PlaybookState,
} from "./contract/options.js";

export const EM_FACTOR = Math.sqrt(Math.PI / 2);
export const STRIKE_STEP = 5;
/** 同一条线上同一种事件,这么久之内只报一次:现价贴着线来回蹭的时候不连着响 */
export const QUIET_MS = 5 * 60_000;
/** 穿过加速档之后,现价离开它这么远才重新上膛(半档行权价) */
export const ACCEL_REARM = STRIKE_STEP / 2;

export interface LegQuote { bid: number | null; ask: number | null }

/** 一条腿的中间价。买卖价缺一个、卖价不是正数、买价高过卖价(倒挂的盘口)都不算数 */
export function legMid(q: LegQuote): number | null {
  if (q.bid === null || q.ask === null) return null;
  if (!Number.isFinite(q.bid) || !Number.isFinite(q.ask) || q.bid < 0 || q.ask <= 0 || q.bid > q.ask) return null;
  return (q.bid + q.ask) / 2;
}

export function atmStrike(spot: number, step: number = STRIKE_STEP): number {
  return Math.round(spot / step) * step;
}

export function expectedMove(call: number, put: number): number {
  return EM_FACTOR * (call + put);
}

export function makeBand(
  spec: { at: number; anchor: number; strike: number; expiry: string; call: number; put: number; source: PlaybookBand["source"] },
): PlaybookBand | null {
  const { anchor, call, put } = spec;
  if (!(anchor > 0) || !(call > 0) || !(put > 0)) return null;
  const em = expectedMove(call, put);
  return { ...spec, em, lower: anchor - em, upper: anchor + em };
}

// ---------------------------------------------------------------- 状态机
export interface PlaybookMachine {
  state: PlaybookState;
  /** 触发现在这个状态的那条线(进入那一刻的值,之后区间换了也不跟着变) */
  trigger: number | null;
  since: number | null;
  /** 加速档:上一笔现价在它的哪一侧;armed = 可以报 */
  accel: { strike: number; side: "above" | "below"; armed: boolean } | null;
  /** 事件键 → 上次报的时刻 */
  fired: Record<string, number>;
}

export function newMachine(): PlaybookMachine {
  return { state: "none", trigger: null, since: null, accel: null, fired: {} };
}

export interface MachineInput {
  at: number;
  price: number;
  /** 昨日区间下沿(B3 的触发线);没有就判不了 B3 */
  b3: number | null;
  /** 当前区间上沿(B2 的触发线);没有就判不了 B2 */
  b2: number | null;
  accelStrike: number | null;
}

function fresh(input: MachineInput): { state: PlaybookState; trigger: number | null } {
  // 两样同时成立(跌破昨日下沿之后反弹过了当前上沿)按 B3:昨日下沿是整天的结构线,收不回去就还是失守
  if (input.b3 !== null && input.price < input.b3) return { state: "B3", trigger: input.b3 };
  if (input.b2 !== null && input.price > input.b2) return { state: "B2", trigger: input.b2 };
  return { state: input.b3 === null && input.b2 === null ? "none" : "R", trigger: null };
}

/** 喂一笔现价,得到新的状态与这一笔该报的事件。不改传进来的那一份 */
export function stepMachine(prev: PlaybookMachine, input: MachineInput): { next: PlaybookMachine; events: PlaybookEvent[] } {
  const next: PlaybookMachine = { ...prev, fired: { ...prev.fired }, accel: prev.accel ? { ...prev.accel } : null };
  const events: PlaybookEvent[] = [];
  const report = (event: PlaybookEvent): void => {
    const key = `${event.kind}|${event.state}|${event.level}`;
    if (input.at - (next.fired[key] ?? -Infinity) < QUIET_MS) return;
    next.fired[key] = input.at;
    events.push(event);
  };

  const held = prev.trigger !== null && (
    (prev.state === "B3" && input.price <= prev.trigger) || (prev.state === "B2" && input.price >= prev.trigger));
  if (!held) {
    if ((prev.state === "B2" || prev.state === "B3") && prev.trigger !== null) {
      report({ at: input.at, kind: "invalid", state: prev.state, level: prev.trigger, price: input.price });
    }
    const now = fresh(input);
    if (now.state !== prev.state || now.trigger !== prev.trigger) {
      next.state = now.state;
      next.trigger = now.trigger;
      next.since = input.at;
      if (now.trigger !== null) report({ at: input.at, kind: "enter", state: now.state, level: now.trigger, price: input.price });
    }
  }

  // 加速档:换了行权价只登记,不报;穿过去报一次,走开半档再上膛
  if (input.accelStrike === null) {
    next.accel = null;
  } else if (input.price !== input.accelStrike) {
    const side = input.price > input.accelStrike ? "above" : "below";
    if (next.accel === null || next.accel.strike !== input.accelStrike) {
      next.accel = { strike: input.accelStrike, side, armed: true };
    } else {
      if (!next.accel.armed && Math.abs(input.price - input.accelStrike) >= ACCEL_REARM) next.accel.armed = true;
      if (side !== next.accel.side) {
        if (next.accel.armed) {
          report({ at: input.at, kind: "accel", state: next.state, level: input.accelStrike, price: input.price });
          next.accel.armed = false;
        }
        next.accel.side = side;
      }
    }
  }
  return { next, events };
}

// ---------------------------------------------------------------- 目标位与加速档
/**
 * B2:T1 = 盘初区间上沿,T2 = 再往上最近的正 gamma 行权价。B3:T1 = 盘初区间下沿,T2 = 再往下的下一档行权价。
 * T1 已经在触发线的身后(盘初区间比触发线窄)就不给 T1,T2 从触发线起算。
 */
export function targets(
  state: PlaybookState, trigger: number | null, open: PlaybookBand | null, strikes: readonly OptionWallStrike[],
): { t1: number | null; t2: number | null } {
  if (trigger === null || (state !== "B2" && state !== "B3")) return { t1: null, t2: null };
  if (state === "B2") {
    const t1 = open !== null && open.upper > trigger ? open.upper : null;
    const from = t1 ?? trigger;
    const above = strikes.filter((s) => s.strike > from && s.net_gex > 0).map((s) => s.strike);
    return { t1, t2: above.length ? Math.min(...above) : null };
  }
  const t1 = open !== null && open.lower < trigger ? open.lower : null;
  const from = t1 ?? trigger;
  const t2 = Math.ceil(from / STRIKE_STEP) * STRIKE_STEP - STRIKE_STEP;
  return { t1, t2: t2 > 0 ? t2 : null };
}

/** 区间里负 gamma 最大的行权价;区间里没有负 gamma 的行权价就没有加速档 */
export function accelerator(strikes: readonly OptionWallStrike[], band: PlaybookBand | null): PlaybookAccel | null {
  if (band === null) return null;
  let best: PlaybookAccel | null = null;
  for (const s of strikes) {
    if (s.strike < band.lower || s.strike > band.upper || !(s.net_gex < 0)) continue;
    if (best === null || s.net_gex < best.net_gex) best = { strike: s.strike, net_gex: s.net_gex };
  }
  return best;
}
