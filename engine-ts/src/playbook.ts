/** SPX 日内剧本的纯计算:预期波动区间、剧本状态机、目标位、加速档。不认识券商,离线能跑。
 *
 * 口径(docs/features/playbook.md):
 * * **预期波动 EM = 平值跨式 × √(π/2)。** 平值跨式的价格约等于「到期前波动的平均绝对值」,正态下它是一个标准差的
 *   √(2/π) 倍,反过来乘 √(π/2) 就是一个标准差。这是恒等式,不是调出来的系数。
 * * **三条取价的区间**:昨日(上一个收盘后十分钟取的、今天到期的跨式,锚是昨收)、盘初(09:35,锚是当时现价)、
 *   当前剩余(每五分钟重取,锚是当时现价)。
 * * **今日区间 = 盘初的锚 ± 当前剩余的预期波动**(todayBand)。锚是 09:35 的指数价,整天不动;半宽是期权市场此刻给剩下这段时间定的价,
 *   不是一条画出来的衰减曲线。跨式取在现价旁边那一档而不是锚那一档:偏离平值的跨式里掺着内在价值,
 *   × √(π/2) 就不再是一个标准差。半宽量的是「从现在到收盘还会走多远」,和围着谁画无关,所以直接搬到锚上:
 *   「现价高过锚 + 半宽」和「锚掉到了 现价 − 半宽 之下」是同一句话——回到盘初价已经需要一个比剩余预期波动还大的反向波动。
 * * **状态**:跌破昨日区间下沿 = B3,站上今日区间上沿 = B2,两条线之间 = R。进了 B2 / B3 之后记住触发它的那条线,
 *   回到线的另一侧才算失效。
 *   - **B3 每一笔现价都判**(那条线整天不动),而且压过 B2:现价在昨日下沿之下就是 B3。
 *   - **B2 只在取到新一格的那一笔判**(进入与失效都是)。那句等式要的是同一时刻的现价与剩余预期波动,上沿也只在这时变;
 *     效果相当于按五分钟收盘判——格子中间刺上去又回来的不算进入,刺下去又回来的不算失效。
 *   - B2 失效之后记着丢掉的那条线:要么回到区间里(不高于上沿)再站上去,要么重新站回那条线之上,才算新的一次。
 *     区间随时间收窄,失效的那一格现价多半还在新的上沿之上;不设这一条,每次失效都紧跟着一条「又进入」。
 * * 止损位与概率分流不在这里:还没有能反推出算法的样本,不编。
 */
import type {
  OptionWallStrike, PlaybookAccel, PlaybookAnchor, PlaybookBand, PlaybookEvent, PlaybookState,
} from "./contract/options.js";
import type { PlaybookMachineMark } from "./playbookLog.js";

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

/**
 * 今日区间:09:35 的锚 ± 当前剩余的预期波动。取价的那几样(时刻、行权价、两条腿)是当前剩余那一条的;
 * 锚与当前剩余里有一样是事后补的,它就标成补的。缺哪一样都拼不出来。
 * 只要锚,不要盘初那一条区间:盘初的跨式补不到的日子,B2 照样判得了。
 */
export function todayBand(anchor: PlaybookAnchor | null, current: PlaybookBand | null): PlaybookBand | null {
  if (anchor === null || current === null || !(anchor.price > 0)) return null;
  return {
    ...current, anchor: anchor.price, lower: anchor.price - current.em, upper: anchor.price + current.em,
    source: anchor.source === "live" && current.source === "live" ? "live" : "backfill",
  };
}

/**
 * 期权墙要看到现价上下各多少点:规则会去读的每一条线都得落在窗口里,取离现价最远的那一条的距离。
 * 规则读的线是:昨日下沿(B3)、盘初区间的两条边(T1)、当前剩余区间的两条边(加速档在里面找)、今日区间上沿(B2,T2 从它往上找)。
 * 昨日上沿与今日下沿没有规则读,不算进来——它们离得远的日子(跳空)会白白把现价附近的档抽稀。
 * 一条线都没有就是 null(用期权链默认的窗口)。
 */
export function wallSpan(spot: number, levels: ReadonlyArray<number | null | undefined>): number | null {
  let span = 0;
  for (const level of levels) {
    if (typeof level === "number" && Number.isFinite(level)) span = Math.max(span, Math.abs(level - spot));
  }
  return span > 0 ? span : null;
}

// ---------------------------------------------------------------- 状态机
export interface PlaybookMachine {
  state: PlaybookState;
  /** 触发现在这个状态的那条线(进入那一刻的值,之后区间换了也不跟着变) */
  trigger: number | null;
  since: number | null;
  /** B2 失效时丢掉的那条线。不是 null = 还没重新上膛:回到区间里、或重新站回这条线之上之前,不算新的 B2 */
  lost: number | null;
  /** 加速档:上一笔现价在它的哪一侧;armed = 可以报 */
  accel: { strike: number; side: "above" | "below"; armed: boolean } | null;
  /** 事件键(quietKey)→ 上次报的时刻 */
  fired: Record<string, number>;
}

export function newMachine(): PlaybookMachine {
  return { state: "none", trigger: null, since: null, lost: null, accel: null, fired: {} };
}

export interface MachineInput {
  at: number;
  price: number;
  /** 昨日区间下沿(B3 的触发线);没有就判不了 B3 */
  b3: number | null;
  /** 今日区间上沿(B2 的触发线);没有就判不了 B2 */
  b2: number | null;
  /** 这一笔是不是刚取到新的一格:今日区间的上沿只在这时变,B2 进不进、失不失效也只在这时判 */
  frame: boolean;
  accelStrike: number | null;
}

/**
 * 静默期按什么分:进入 / 失效按「哪种事件 + 哪个状态」,不带那条线的数——今日区间的上沿每一格都在变,带上它静默期就形同虚设。
 * 加速档带行权价:换了一档是另一件事。
 */
export function quietKey(event: Pick<PlaybookEvent, "kind" | "state" | "level">): string {
  return event.kind === "accel" ? `accel|${event.state}|${event.level}` : `${event.kind}|${event.state}`;
}

/**
 * 重启之后状态机从哪儿接着判。落盘的那一条状态(mark)就是答案;没有它的底账(加这一种记录之前写的),
 * 或者它之后还有更晚的进入 / 失效事件,就照最后一条事件推:进入 → 那个状态与那条线;B2 失效 → 记着丢掉的线。
 */
export function restoreMachine(
  mark: PlaybookMachineMark | null, events: readonly PlaybookEvent[],
): Pick<PlaybookMachine, "state" | "trigger" | "since" | "lost"> {
  let last: PlaybookEvent | null = null;
  for (const e of events) if (e.kind !== "accel") last = e;
  if (mark !== null && (last === null || last.at <= mark.at)) {
    return { state: mark.state, trigger: mark.trigger, since: mark.since, lost: mark.lost };
  }
  if (last === null) return { state: "none", trigger: null, since: null, lost: null };
  if (last.kind === "enter") return { state: last.state, trigger: last.level, since: last.at, lost: null };
  return { state: "R", trigger: null, since: last.at, lost: last.state === "B2" ? last.level : null };
}

/**
 * 喂一笔现价,得到新的状态与这一笔该报的事件。不改传进来的那一份。
 * 状态照变、事件不一定报:静默期里的那一次不进 events(调用方另把状态落盘,重启才接得上)。
 */
export function stepMachine(prev: PlaybookMachine, input: MachineInput): { next: PlaybookMachine; events: PlaybookEvent[] } {
  const next: PlaybookMachine = { ...prev, fired: { ...prev.fired }, accel: prev.accel ? { ...prev.accel } : null };
  const events: PlaybookEvent[] = [];
  const { at, price, b2, b3 } = input;
  const report = (event: PlaybookEvent): void => {
    const key = quietKey(event);
    if (at - (next.fired[key] ?? -Infinity) < QUIET_MS) return;
    next.fired[key] = at;
    events.push(event);
  };
  const become = (state: PlaybookState, trigger: number | null): void => {
    if (state === next.state && trigger === next.trigger) return;
    next.state = state;
    next.trigger = trigger;
    next.since = at;
  };
  // 昨日下沿是整天的结构线:现价在它之下就是 B3,不管今日区间怎么说
  const below = b3 !== null && price < b3;

  // 一、现在这个状态还站不站得住
  if (next.state === "B3" && next.trigger !== null && price > next.trigger) {
    report({ at, kind: "invalid", state: "B3", level: next.trigger, price });
    become("R", null);
  } else if (next.state === "B2" && next.trigger !== null && (below || (input.frame && price < next.trigger))) {
    // 跌回了进入时那条线之下才报失效、才记下丢掉的线;只是被 B3 压过去(线还没丢)就悄悄让位,那句「跌回…下方」不成立
    if (price < next.trigger) {
      report({ at, kind: "invalid", state: "B2", level: next.trigger, price });
      next.lost = next.trigger;
    }
    become("R", null);
  }

  // 二、手上没有状态:看进不进
  if (next.state !== "B2" && next.state !== "B3") {
    if (below && b3 !== null) {
      become("B3", b3);
      report({ at, kind: "enter", state: "B3", level: b3, price });
    } else {
      if (input.frame && b2 !== null && next.lost !== null && price <= b2) next.lost = null; // 回到区间里:重新上膛
      if (input.frame && b2 !== null && price > b2 && (next.lost === null || price > next.lost)) {
        next.lost = null;
        become("B2", b2);
        report({ at, kind: "enter", state: "B2", level: b2, price });
      } else {
        become(b3 === null && b2 === null ? "none" : "R", null);
      }
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

/** 区间(当前剩余那一条:围着现价,是剩下这段时间够得着的范围)里负 gamma 最大的行权价;没有负 gamma 的行权价就没有加速档 */
export function accelerator(strikes: readonly OptionWallStrike[], band: PlaybookBand | null): PlaybookAccel | null {
  if (band === null) return null;
  let best: PlaybookAccel | null = null;
  for (const s of strikes) {
    if (s.strike < band.lower || s.strike > band.upper || !(s.net_gex < 0)) continue;
    if (best === null || s.net_gex < best.net_gex) best = { strike: s.strike, net_gex: s.net_gex };
  }
  return best;
}
