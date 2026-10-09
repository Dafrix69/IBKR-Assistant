/** 盯盘一轮里和"怎么出场"有关的那几样状态:推峰值用的价、标的止损的确认计时、分批止盈的档位。
 *
 * 判定本身是纯函数(tracker.ts、trackerExits.ts);这里只管它们要的状态与落库。和托管单那一块(hosted.ts)一样,
 * 别的一律从宿主现取。计时、上一轮的价只在内存里:引擎重建后计时从头数、峰值下一轮再推——偏保守的那一侧。
 * 分批止盈的档位在库里(追踪的 targets),重建、重启都接得上。
 */
import type { EtNow } from "../config.js";
import type { AutoClose, SpotStop, SpotTarget, Targets } from "../contract/tracker.js";
import type { Notifier } from "../notify.js";
import type { Rec, TradeStore } from "../store.js";
import * as tk from "../tracker.js";

export interface ExitsHost {
  readonly store: TradeStore;
  readonly notifier: Notifier;
}

interface Mark { round: number; cur: number | null; out: number | null }

export class TrackExits {
  constructor(private readonly host: ExitsHost) {}

  // ---- 推峰值用的价 ----------------------------------------------------
  private readonly marks = new Map<string, Mark>();
  private round = 0;

  /** 新的一轮。盯盘每轮开头叫一次;托管对账和盯盘同一轮时不叫(它问到的是盯盘这一轮算好的那个)。 */
  nextRound(): void {
    this.round += 1;
  }

  /**
   * 推峰值用的价。默认就是这一轮的价。追踪打开了「峰值要连续两秒确认」(auto_close.peak_confirm)的期权与组合,
   * 要**连续两轮**都见到才算:多头取这一轮与上一轮里低的那个,空头取高的。
   *
   * 组合的现价是几条腿的中间价拼出来的,远翼买价为 0 时那条腿按「卖价的一半」记——一笔挂得高的卖价、
   * 一条腿晚到半秒的报价,都能把组合现价抬一截又落回去。峰值只朝有利方向走、还落库:抬上去一次,
   * 之后拿正常的价一比就是一次利润回撤,把一份好好的仓平掉。两轮是能挡住"只出现一笔"的最小确认,代价是峰值晚一秒,
   * 而且真的只出现了一秒的高点也不算——所以它是一个要人自己打开的选项,不是默认。
   * 这一轮或上一轮没有价,这一轮不推。同一轮问第二次给同一个答案。
   */
  peakMark(tid: string, position: tk.Position, price: number | null, confirm = false): number | null {
    if (!confirm || position.sec_type === "STK") return price;
    const last = this.marks.get(tid);
    if (last !== undefined && last.round === this.round) return last.out;
    const prev = last?.cur ?? null;
    const out = price === null || prev === null
      ? null : tk.isLong(position) ? Math.min(prev, price) : Math.max(prev, price);
    this.marks.set(tid, { round: this.round, cur: price, out });
    return out;
  }

  // ---- 标的止损价的确认 --------------------------------------------------
  private readonly breaches = new Map<string, tk.BreachClock>();

  /** 设了确认秒数的:越线之后待够了才算(trackerExits.confirmSpotStop)。没设的原样返回。 */
  confirmSpot(tid: string, targets: Targets, row: SpotStop | null, nowMs: number): SpotStop | null {
    if (row === null) return null;
    const [out, clock] = tk.confirmSpotStop(row, targets.spot_stop_confirm_s, this.breaches.get(tid) ?? null, nowMs);
    if (clock === null) this.breaches.delete(tid);
    else this.breaches.set(tid, clock);
    return out;
  }

  // ---- 这一轮的结论 ------------------------------------------------------
  /**
   * 一条追踪这一轮的结论:价格触发 → 标的触发 → 分批止盈 → 到点平仓,后面的只在前面都没触发时生效。
   * `natural`:stop_basis = natural 的期权 / 组合给这一轮的立刻成交价;别的不给。
   * 拿不到(null:腿没报价,或者盘口宽到合成出来不是正数)的那一轮**退回中间价**判止损类、峰值不推:
   * 可成交价不会比中间价好,中间价都破了线,可成交价一定也破了——退回去不会多出一次假触发,只是那一轮没有提前量。
   * 以前那一轮止损类干脆不判,盘口一宽(正是最需要止损的时候)这条追踪就瞎了。
   */
  judge(args: {
    track: Rec; position: tk.Position; targets: Targets; auto: AutoClose; price: number | null; natural?: number | null;
    at: EtNow; spotTarget: SpotTarget | null; spotStop: SpotStop | null;
  }): tk.EvaluateResult & { tier?: number; stop_fallback?: boolean } {
    const { track, position, price, at } = args;
    const targets = this.lapseTimeExit(track, args.targets, at.epochMs);
    const tid = String(track["id"]);
    const fallback = args.natural === null;
    const stopPrice = args.natural === undefined || fallback ? price : args.natural;
    const opts: tk.EvaluateOpts = { peakPrice: fallback ? null : this.peakMark(tid, position, stopPrice, args.auto.peak_confirm) };
    if (args.natural !== undefined) opts.stopPrice = stopPrice;
    const byPrice = tk.withSpotTriggers(
      tk.evaluate(position, targets, price, track["peak"] ?? null, at.minutes, opts),
      String(track["symbol"]), targets, args.spotTarget, args.spotStop,
    );
    const out = tk.withTimeExit(tk.withTier(byPrice, targets, tk.isLong(position)), targets, at.epochMs);
    return fallback ? { ...out, stop_fallback: true } : out;
  }

  /**
   * 到点平仓过了那一天还没执行(软件没开着、休市、被闸门挡着):这一次作废,库里把时刻清掉(钟点留着给人看),提醒一次。
   * 回这一轮用的目标。要再用,重新设置或点「恢复」(那时会换成下一次到这个钟点的时刻)。
   */
  private lapseTimeExit(track: Rec, targets: Targets, nowMs: number): Targets {
    if (!tk.timeExitLapsed(targets, nowMs)) return targets;
    const stored = tk.makeTargets((track["targets"] ?? {}) as Partial<Targets>);
    this.host.store.updateTrack(String(track["id"]), { targets: { ...stored, exit_at_ms: null } });
    this.host.store.audit("engine", "time_exit_lapsed", { track: track["id"], symbol: track["symbol"], exit_at: targets.exit_at });
    this.host.notifier.warning(
      `${track["symbol"]} 的到点平仓(美东 ${String(targets.exit_at ?? "")})已经过期、没有执行:到点那天软件没在盯、休市或被闸门挡着。`
      + "持仓还在的话请自己处理;要再用,重新设置。",
    );
    return { ...targets, exit_at_ms: null };
  }

  // ---- 到价了却发不出去:提醒一次 ------------------------------------------
  private readonly blockedSeen = new Map<string, Set<string>>();

  /**
   * 「到价了但没有平仓」该不该提醒。同一条追踪、同一种触发只说一次;换了一种触发(先是到点、后来止损也到了)再说一次。
   * 库里已经记着"提醒过"(fired_state 不空)而这个引擎还没见过它——重启之后——不重复说。
   */
  warnBlocked(track: Rec, state: string): boolean {
    const tid = String(track["id"]);
    const seen = this.blockedSeen.get(tid) ?? new Set<string>();
    this.blockedSeen.set(tid, seen);
    const first = !track["fired_state"];
    const fresh = first || (seen.size > 0 && !seen.has(state));
    seen.add(state);
    return fresh;
  }

  // ---- 分批止盈 ----------------------------------------------------------
  /**
   * 这一轮触发的是分批止盈的某一档:先把这一档记成"在等成交"(落库在发单之前,和"先标记再发单"同一条规矩),
   * 回这一次平仓用的设置——平的比例换成这一档的。不是分批止盈的触发,原样返回。
   */
  tierAuto(track: Rec, targets: Targets, result: { tier?: number }, auto: AutoClose, position: tk.Position): AutoClose {
    const tiers = targets.take_profit_tiers ?? [];
    const tier = result.tier === undefined ? undefined : tiers[result.tier];
    if (result.tier === undefined || tier === undefined) return auto;
    const stored = tk.makeTargets((track["targets"] ?? {}) as Partial<Targets>);
    this.host.store.updateTrack(String(track["id"]), {
      targets: {
        ...stored,
        take_profit_tiers: tk.markTier(tiers, result.tier, { pending: true, pending_qty: Math.abs(position.quantity) }),
      },
    });
    return { ...auto, close_fraction_pct: tier.fraction_pct };
  }

  /** 这一档的平仓单没发出去、追踪也没落闩(拼不出单、账户没了):把"在等成交"摘掉,下一轮照常再判。 */
  tierNotSent(track: Rec): void {
    const tid = String(track["id"]);
    const fresh = this.host.store.getTrack(tid);
    if (fresh === null || fresh["fired_at"]) return;
    const targets = tk.makeTargets(fresh["targets"] ?? {});
    const index = tk.pendingTier(targets.take_profit_tiers);
    if (index < 0) return;
    this.host.store.updateTrack(tid, {
      targets: { ...targets, take_profit_tiers: tk.markTier(targets.take_profit_tiers ?? [], index, {}) },
    });
  }

  /**
   * 分批止盈的一档成交了:这一档划掉、把闩解开,追踪接着盯剩下的仓。回 true = 这一轮刚解开(调用方这一轮不再判它)。
   *
   * 只认**这张平仓单整张成交**(记录的终态是 filled)。被撤、被拒、只成交了一部分的不解:持仓和预想的不一样,
   * 该由人看一眼再决定,不能由软件接着按原计划往下平。每一轮从库里现查,引擎重启、成交发生在软件关着的时候都接得上
   * (执行对账会把终态补回记录)——那种情形下追踪的状态还停在「追价平仓中」(sweep:take_profit:成交回报到的不是
   * 这个引擎),所以带不带追价前缀都认。
   *
   * 还要等**读到的持仓真的少了**:成交回报先到、持仓推送晚一拍的那一轮就解开,下一档会按还没减的数量去平,平过头就是反向开仓。
   */
  rearmTier(track: Rec, position: tk.Position): boolean {
    const targets = tk.makeTargets((track["targets"] ?? {}) as Partial<Targets>);
    const index = tk.pendingTier(targets.take_profit_tiers);
    const fired = tk.sweepReason(track) ?? track["fired_state"];
    if (index < 0 || track["enabled"] || fired !== tk.STATE_TAKE_PROFIT) return false;
    const recordId = String(track["fired_record"] ?? "");
    if (!recordId || this.host.store.getRecord(recordId)?.["final_status"] !== "filled") return false;
    const before = (targets.take_profit_tiers ?? [])[index]?.pending_qty;
    if (before !== undefined && !(Math.abs(position.quantity) < before)) return false;
    const tiers = tk.markTier(targets.take_profit_tiers ?? [], index, { done: true });
    this.host.store.updateTrack(String(track["id"]), {
      targets: { ...targets, take_profit_tiers: tiers }, enabled: true, fired_at: null, fired_state: "", fired_record: "",
    });
    this.host.store.audit("engine", "tier_rearm", { track: track["id"], symbol: track["symbol"], tier: index + 1, record: recordId });
    const left = tiers.filter((t) => !t.done).length;
    this.host.notifier.notify(
      "分批止盈", `${track["symbol"]}:第 ${index + 1} 档已成交,${left ? `还有 ${left} 档` : "各档都做完了"},剩下的仓接着盯`,
    );
    return true;
  }

  /** 已经删掉的追踪:把它们的计时与上一轮的价丢掉。 */
  forget(alive: Set<string>): void {
    for (const tid of [...this.marks.keys()]) if (!alive.has(tid)) this.marks.delete(tid);
    for (const tid of [...this.breaches.keys()]) if (!alive.has(tid)) this.breaches.delete(tid);
    for (const tid of [...this.blockedSeen.keys()]) if (!alive.has(tid)) this.blockedSeen.delete(tid);
  }
}
