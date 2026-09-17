/** 保护规则:比"连续失败熔断"细一档的自动执行暂停(思路来自 freqtrade 的 Protections)。
 *
 * 熔断(killswitch.ts)管的是**软件坏了**:连续下单失败、连续解析失败,到阈值就整体停,人工解除。
 * 这里管的是**今天不顺**:接连止损、盈亏回撤过大、刚平掉的标的立刻又要进——都不是故障,
 * 是该歇一会儿。所以它不写状态文件、不需要人工解除:**规则从库里现算,到点自己就过去了**。
 *
 * 三条边界,任何时候都不许越:
 *  · **只挡新单,永不挡平仓**。持仓追踪发的平仓单、追价改价、托管单对账都不经过这里——
 *    保护期内挡住平仓等于让持仓裸奔,那比多亏一笔严重得多。
 *  · **不落终态**。被保护挡下的单停在"仅校验未发送",保护期过了还能再发;不像熔断那样判死。
 *  · **算不出来就放行**。库里读不到数据、配置关着,一律不拦——保护规则误拦是妨碍交易,
 *    而它本身并不能避免任何一笔已经发生的亏损。
 */

/** 单条规则的开关与参数。全部默认关闭:老用户升级后行为一字不变。 */
export interface StoplossGuardConfig {
  enabled: boolean;
  /** 往回看多少分钟。 */
  lookback_minutes: number;
  /** 窗口内几次止损算数。 */
  trigger_count: number;
  /** 触发后暂停多久(从最后一次止损算起)。 */
  pause_minutes: number;
}

export interface MaxDrawdownConfig {
  enabled: boolean;
  lookback_minutes: number;
  /** 已实现盈亏从窗口内峰值回撤多少美元算触发。 */
  max_drawdown_usd: number;
  pause_minutes: number;
}

export interface CooldownConfig {
  enabled: boolean;
  /** 一只标的平仓后,多少分钟内不再对它下新单。 */
  minutes: number;
}

export interface ProtectionsConfig {
  stoploss_guard: StoplossGuardConfig;
  max_drawdown: MaxDrawdownConfig;
  cooldown: CooldownConfig;
}

/** 一次平仓(来自 audit_log 的 auto_close / hosted_sweep)。 */
export interface CloseEvent {
  atMs: number;
  symbol: string;
  /** tracker 的 STATE_*:take_profit / stop_loss / profit_trail(可能带 sweep: 前缀)。 */
  state: string;
}

/** 一笔已实现盈亏(来自 record_events 的 commission 事件)。 */
export interface PnlEvent {
  atMs: number;
  pnl: number;
}

export interface ProtectionPause {
  rule: string;
  reason: string;
  untilMs: number;
}

export interface ProtectionState {
  /** 全局暂停(止损护栏 / 回撤护栏)。没有就是 null。 */
  pause: ProtectionPause | null;
  /** 按标的的冷却期。键是标的代码。 */
  cooldowns: Record<string, ProtectionPause>;
}

export const NO_PROTECTION: ProtectionState = { pause: null, cooldowns: {} };

/** 止损类的平仓状态:止损、跟踪止损、利润回撤。止盈不算——赚着钱离场不是"今天不顺"。
 * 追价平仓会给状态加 sweep: 前缀(tracker.SWEEP_PREFIX),按后缀认。 */
export function isStopLike(state: string): boolean {
  const bare = state.includes(":") ? state.slice(state.lastIndexOf(":") + 1) : state;
  return bare === "stop_loss" || bare === "profit_trail";
}

/** 现算一遍当前的保护状态。纯函数:同样的输入永远同样的输出,时间也由调用方给。 */
export function evaluateProtections(
  cfg: ProtectionsConfig, closes: CloseEvent[], pnl: PnlEvent[], nowMs: number,
): ProtectionState {
  const pauses: ProtectionPause[] = [];

  const guard = cfg.stoploss_guard;
  if (guard.enabled && guard.trigger_count > 0) {
    const since = nowMs - guard.lookback_minutes * 60_000;
    const hits = closes
      .filter((c) => c.atMs > since && c.atMs <= nowMs && isStopLike(c.state))
      .sort((a, b) => a.atMs - b.atMs);
    if (hits.length >= guard.trigger_count) {
      const last = hits[hits.length - 1]!;
      const untilMs = last.atMs + guard.pause_minutes * 60_000;
      if (untilMs > nowMs) {
        pauses.push({
          rule: "stoploss_guard",
          reason:
            `${guard.lookback_minutes} 分钟内止损 ${hits.length} 次` +
            `(阈值 ${guard.trigger_count} 次),自动执行先停 ${guard.pause_minutes} 分钟`,
          untilMs,
        });
      }
    }
  }

  const dd = cfg.max_drawdown;
  if (dd.enabled && dd.max_drawdown_usd > 0) {
    const since = nowMs - dd.lookback_minutes * 60_000;
    const rows = pnl
      .filter((p) => p.atMs > since && p.atMs <= nowMs && Number.isFinite(p.pnl))
      .sort((a, b) => a.atMs - b.atMs);
    // 窗口内的累计已实现盈亏曲线:峰值到当前的落差就是回撤
    let running = 0;
    let peak = 0;
    let worst = 0;
    let worstAtMs = 0;
    for (const row of rows) {
      running += row.pnl;
      if (running > peak) peak = running;
      const drop = peak - running;
      if (drop > worst) {
        worst = drop;
        worstAtMs = row.atMs;
      }
    }
    if (worst >= dd.max_drawdown_usd) {
      const untilMs = worstAtMs + dd.pause_minutes * 60_000;
      if (untilMs > nowMs) {
        pauses.push({
          rule: "max_drawdown",
          reason:
            `${dd.lookback_minutes} 分钟内已实现盈亏从峰值回撤 ${worst.toFixed(2)} 美元` +
            `(阈值 ${dd.max_drawdown_usd}),自动执行先停 ${dd.pause_minutes} 分钟`,
          untilMs,
        });
      }
    }
  }

  const cooldowns: Record<string, ProtectionPause> = {};
  const cool = cfg.cooldown;
  if (cool.enabled && cool.minutes > 0) {
    for (const close of closes) {
      if (!close.symbol) continue;
      const untilMs = close.atMs + cool.minutes * 60_000;
      if (untilMs <= nowMs) continue;
      const cur = cooldowns[close.symbol];
      if (cur !== undefined && cur.untilMs >= untilMs) continue;
      cooldowns[close.symbol] = {
        rule: "cooldown",
        reason: `${close.symbol} 刚平过仓,冷却 ${cool.minutes} 分钟内不再下新单`,
        untilMs,
      };
    }
  }

  // 同时触发就取解除得最晚的那条:两条规则都说该停,听更保守的
  pauses.sort((a, b) => b.untilMs - a.untilMs);
  return { pause: pauses[0] ?? null, cooldowns };
}

/** 这张单现在能不能发。返回拦截原因(给用户看的话),放行是 null。 */
export function protectionBlock(
  state: ProtectionState, symbol: string, nowMs: number,
): string | null {
  if (state.pause !== null && state.pause.untilMs > nowMs) {
    return `${state.pause.reason},${remaining(state.pause.untilMs, nowMs)}后自动恢复`;
  }
  const cool = symbol ? state.cooldowns[symbol] : undefined;
  if (cool !== undefined && cool.untilMs > nowMs) {
    return `${cool.reason},${remaining(cool.untilMs, nowMs)}后自动恢复`;
  }
  return null;
}

function remaining(untilMs: number, nowMs: number): string {
  const mins = Math.ceil((untilMs - nowMs) / 60_000);
  return mins >= 60 ? `${Math.floor(mins / 60)} 小时 ${mins % 60} 分钟` : `${mins} 分钟`;
}

/** 给界面的摘要(system.status 里带出去)。 */
export function protectionsSummary(state: ProtectionState, nowMs: number): Record<string, unknown> {
  const cooling = Object.entries(state.cooldowns)
    .filter(([, p]) => p.untilMs > nowMs)
    .map(([symbol, p]) => ({ symbol, until_ms: p.untilMs, reason: p.reason }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  const pause = state.pause !== null && state.pause.untilMs > nowMs ? state.pause : null;
  return {
    paused: pause !== null,
    rule: pause?.rule ?? "",
    reason: pause?.reason ?? "",
    until_ms: pause?.untilMs ?? null,
    cooldowns: cooling,
  };
}
