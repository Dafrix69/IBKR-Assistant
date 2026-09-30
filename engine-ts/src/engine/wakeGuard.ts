/** 盯盘停过:认出来、醒来先别判断、一整段停完之后说一声。
 *
 * 用电池时合上笔记本,macOS 直接睡眠,应用挡不住。进程在睡眠里被冻住,节拍器的计时器也不走:醒来只是接着排下一轮,
 * 引擎自己看不出中间过了多久——只有墙钟看得出(见 docs/journal/stale-streams-after-sleep.md)。
 *
 *  · 相邻两轮开始的墙钟差超过 GAP_MS,算一次停摆。墙钟差减单调时钟差 = 其间睡着的时长(macOS 的单调时钟在睡眠里不走):
 *    占一半以上算"电脑睡着了",否则是"引擎卡住了"(进程被挂起、一轮卡在券商那头、事件循环被占住)。
 *  · 睡着过的,醒来先不判断:醒来那一秒 TWS 给新订阅的可能是睡前的缓存盘口,紧接着又断线重连。跟踪止损的峰值是落库的,
 *    一轮旧价、或新旧腿拼出来的净价,就能把峰值抬上去,之后拿真价一比就是一次假回撤。券商连接(连着的连接名不变、不为空)
 *    连续稳住 SETTLE_MS 才恢复判断,最长等 SETTLE_MAX_MS。卡住的不等:那段时间行情一直在走,等只会更晚。
 *  · 睡着以后系统每十几分钟维护唤醒一次、每次几秒,每一次都是一次停摆。连着跑满 QUIET_MS 没再停才算真醒了,
 *    这之间的停摆并成一段,结束时只报一次。
 *
 * 判断全在 WakeGuard 里,时钟与连接由调用方每一轮给,离线测试直接喂数。
 */
import type { Track } from "../contract/tracker.js";
import { logStderr } from "../ibLink.js";
import { ET, pad2, wallParts } from "../tz.js";

/** 两轮开始之间超过这么久算停摆。正常是 1 秒;一轮卡在券商那头二十几秒的见过,不算 */
export const GAP_MS = 30_000;
/** 连着跑满这么久没再停,才算真醒了。维护唤醒一次 2–21 秒(2026-09-29 的 pmset 日志) */
export const QUIET_MS = 60_000;
/** 睡醒之后,券商连接连续稳住这么久才恢复判断。09-29 醒来 1 秒断线、5 秒后重连 */
export const SETTLE_MS = 20_000;
/** 醒后最多等这么久,之后连接稳不稳都照常判断:静默停摆比慢更危险 */
export const SETTLE_MAX_MS = 120_000;
/** 停得比这短的只留痕,不弹通知 */
export const NOTIFY_MIN_MS = 60_000;
/** 提醒里最多列几个代码 */
const SYMBOLS_SHOWN = 5;

export const HOLD_REASON =
  `电脑刚醒,先不判断:醒来头几秒的报价可能还是睡前的。等券商连接稳住 ${SETTLE_MS / 1000} 秒(最长 ${SETTLE_MAX_MS / 60_000} 分钟)再恢复`;

export type GapKind = "sleep" | "stall";

/** 此刻在盯的追踪:启用着、还没触发的,加上平仓单正在追价的。 */
export interface LiveTracks {
  total: number;
  /** 其中托管到券商的:券商那边的单睡着也有效 */
  hosted: number;
  symbols: string[];
}

export interface WakeSample {
  /** 这一轮开始时的墙钟(Date.now()) */
  wall: number;
  /** 同一刻的单调时钟(performance.now()) */
  mono: number;
  /** 此刻连着的连接名,排好序拼成一串;一条都没连是空串 */
  link: string;
  live: LiveTracks;
}

export interface WakeGap {
  kind: GapKind;
  /** 停摆前最后一轮开始的墙钟 */
  from: number;
  /** 停摆后第一轮(就是这一轮)开始的墙钟 */
  to: number;
  stopped_ms: number;
  asleep_ms: number;
}

/** 一整段停摆:一次合盖,加上其间每一次维护唤醒。 */
export interface WakeEpisode {
  kind: GapKind;
  from: number;
  to: number;
  gaps: number;
  stopped_ms: number;
  asleep_ms: number;
  /** 其间短暂醒着的总时长:节拍器跑了,但在等连接稳住,没判断 */
  awake_ms: number;
  live: LiveTracks;
}

export interface WakeStep {
  /** 这一轮刚结束一次停摆 */
  gap: WakeGap | null;
  /** 非空 = 这一轮不判断,原因给界面 */
  hold: string;
  /** 这一轮恢复判断了:等了多久、是连接稳住了还是等满了 */
  released: { waited_ms: number; steady: boolean } | null;
  /** 一整段停摆到这一轮才算结束 */
  episode: WakeEpisode | null;
}

interface Settle {
  since: number;
  link: string;
  /** 现在这组连接从什么时候起连着;一条都没连时是 null */
  linkSince: number | null;
}

export class WakeGuard {
  private prevWall: number | null = null;
  private prevMono: number | null = null;
  private open: WakeEpisode | null = null;
  private settle: Settle | null = null;

  step(s: WakeSample): WakeStep {
    const gap = this.gapOf(s);
    this.prevWall = s.wall;
    this.prevMono = s.mono;
    if (gap !== null) {
      this.extend(gap, s.live);
      if (gap.kind === "sleep") this.settle = { since: s.wall, link: s.link, linkSince: s.link ? s.wall : null };
    }
    const [hold, released] = this.holdAt(s);
    let episode: WakeEpisode | null = null;
    if (gap === null && this.open !== null && s.wall - this.open.to >= QUIET_MS) {
      episode = this.open;
      this.open = null;
    }
    return { gap, hold, released, episode };
  }

  /** 节拍器是被有意停掉的(引擎重建、断开券商):下一次开始不算停摆。没结束的那一段与醒后的等待都留着。 */
  pause(): void {
    this.prevWall = null;
    this.prevMono = null;
  }

  private gapOf(s: WakeSample): WakeGap | null {
    if (this.prevWall === null || this.prevMono === null) return null;
    const stopped = s.wall - this.prevWall;
    if (!(stopped > GAP_MS)) return null; // 墙钟往回拨也走这里
    const asleep = Math.min(stopped, Math.max(0, stopped - (s.mono - this.prevMono)));
    return { kind: asleep * 2 >= stopped ? "sleep" : "stall", from: this.prevWall, to: s.wall, stopped_ms: stopped, asleep_ms: asleep };
  }

  private extend(gap: WakeGap, live: LiveTracks): void {
    const ep = this.open;
    if (ep === null) {
      this.open = { ...gap, gaps: 1, awake_ms: 0, live };
      return;
    }
    ep.awake_ms += gap.from - ep.to;
    ep.to = gap.to;
    ep.gaps += 1;
    ep.stopped_ms += gap.stopped_ms;
    ep.asleep_ms += gap.asleep_ms;
    ep.kind = ep.asleep_ms * 2 >= ep.stopped_ms ? "sleep" : "stall";
    if (live.total > ep.live.total) ep.live = live;
  }

  private holdAt(s: WakeSample): [string, WakeStep["released"]] {
    const st = this.settle;
    if (st === null) return ["", null];
    if (s.link !== st.link) {
      st.link = s.link;
      st.linkSince = s.link ? s.wall : null;
    }
    const steady = st.linkSince !== null && s.wall - st.linkSince >= SETTLE_MS;
    if (!steady && s.wall - st.since < SETTLE_MAX_MS) return [HOLD_REASON, null];
    this.settle = null;
    return ["", { waited_ms: s.wall - st.since, steady }];
  }
}

export function liveTracksOf(tracks: readonly Track[], chasing: (id: string) => boolean): LiveTracks {
  const live = tracks.filter((t) => (Boolean(t.enabled) && !t.fired_at) || chasing(String(t.id)));
  return {
    total: live.length,
    hosted: live.filter((t) => Boolean(t.auto_close?.host_at_broker)).length,
    symbols: [...new Set(live.map((t) => String(t.symbol)))],
  };
}

/** 此刻连着的连接名。没有 connectedNames 的券商(测试里的假券商)按连着的会话数算。 */
export function linkOf(router: { connectedNames?(): string[]; sessions(): unknown[] } | null): string {
  if (router === null) return "";
  if (typeof router.connectedNames === "function") return router.connectedNames().join(",");
  return router.sessions().length ? String(router.sessions().length) : "";
}

// ---- 给人看的话 -------------------------------------------------------------

export function durationText(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`;
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

function etTime(ms: number, seconds = false): string {
  const p = wallParts(ms, ET);
  return `${pad2(p.hour)}:${pad2(p.minute)}` + (seconds ? `:${pad2(p.second)}` : "");
}

/** 美东的起止。跨了日子带上月日(合盖过夜)。 */
export function spanText(from: number, to: number, seconds = false): string {
  const a = wallParts(from, ET), b = wallParts(to, ET);
  if (a.year === b.year && a.month === b.month && a.day === b.day) {
    return `${etTime(from, seconds)}–${etTime(to, seconds)}`;
  }
  const md = (p: typeof a): string => `${pad2(p.month)}-${pad2(p.day)}`;
  return `${md(a)} ${etTime(from, seconds)} – ${md(b)} ${etTime(to, seconds)}`;
}

export function gapLogLine(g: WakeGap): string {
  const why = g.kind === "sleep"
    ? `其中约 ${durationText(g.asleep_ms)}电脑在睡眠;醒来先不判断,等券商连接稳住`
    : "电脑没睡,是引擎被挂起或卡住了";
  return `[盯盘] 节拍停了 ${durationText(g.stopped_ms)}(美东 ${spanText(g.from, g.to, true)},${why})`;
}

export function releasedLogLine(r: NonNullable<WakeStep["released"]>): string {
  return `[盯盘] 醒后等了 ${durationText(r.waited_ms)},${r.steady ? "券商连接已稳住" : "连接一直没稳住,等满了"},恢复判断`;
}

export function episodeLogLine(ep: WakeEpisode): string {
  const woke = ep.gaps > 1 ? `,其间短暂醒过 ${ep.gaps - 1} 次、共 ${durationText(ep.awake_ms)},都没有判断` : "";
  return `[盯盘] 这一段停摆结束:美东 ${spanText(ep.from, ep.to, true)},共停 ${durationText(ep.stopped_ms)}` +
    `(${ep.kind === "sleep" ? `睡眠约 ${durationText(ep.asleep_ms)}` : "不是睡眠"}${woke});当时在盯的追踪 ${ep.live.total} 条`;
}

export function episodeAudit(ep: WakeEpisode): Record<string, unknown> {
  return {
    kind: ep.kind, from: new Date(ep.from).toISOString(), to: new Date(ep.to).toISOString(),
    stopped_s: Math.round(ep.stopped_ms / 1000), asleep_s: Math.round(ep.asleep_ms / 1000),
    awake_s: Math.round(ep.awake_ms / 1000), gaps: ep.gaps,
    live: ep.live.total, hosted: ep.live.hosted, symbols: ep.live.symbols,
  };
}

/** 一整段停摆结束时要不要弹通知、说什么。没有在盯的追踪、停得很短的,只留痕。
 * 时长按整段的起止算:其间维护唤醒的那几秒也没有判断。 */
export function episodeNotice(ep: WakeEpisode): { title: string; body: string } | null {
  const span = ep.to - ep.from;
  if (ep.live.total === 0 || span < NOTIFY_MIN_MS) return null;
  const title = ep.kind === "sleep"
    ? `电脑睡了 ${durationText(span)},本机盯盘没有运行`
    : `盯盘停了 ${durationText(span)}`;
  const shown = ep.live.symbols.slice(0, SYMBOLS_SHOWN).join("、") + (ep.live.symbols.length > SYMBOLS_SHOWN ? " 等" : "");
  const hosted = ep.live.hosted ? `其中 ${ep.live.hosted} 条托管在券商,券商那边的单照常有效。` : "";
  const hint = ep.kind === "sleep" ? "用电池时合盖电脑会睡着:离开时请接电源,或打开「托管到券商」。" : "";
  return {
    title,
    body: `美东 ${spanText(ep.from, ep.to)},${ep.live.total} 条追踪(${shown})没人盯:止盈止损、跟踪止损、利润回撤都没有判断。` +
      `${hosted}请核对持仓与挂单。${hint}`,
  };
}

/** 引擎每一轮调一次:日志(进 main.log)、留痕、通知(系统通知 + 界面的通知流)。判断在上面,这里只把结论送出去。 */
export function reportWake(
  step: WakeStep,
  store: { audit(actor: string, action: string, detail: Record<string, unknown>): void },
  notifier: { notify(title: string, body: string, subtitle?: string): void },
  log: (line: string) => void = logStderr,
): void {
  if (step.gap !== null) log(gapLogLine(step.gap));
  if (step.released !== null) log(releasedLogLine(step.released));
  if (step.episode === null) return;
  log(episodeLogLine(step.episode));
  store.audit("engine", "monitor_gap", episodeAudit(step.episode));
  const notice = episodeNotice(step.episode);
  if (notice !== null) notifier.notify(notice.title, notice.body, "盯盘");
}
