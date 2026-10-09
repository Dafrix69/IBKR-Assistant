/** 保护规则:比"连续失败熔断"细一档的自动执行暂停(思路来自 freqtrade 的 Protections)。
 *
 * 熔断(killswitch.ts)管的是**软件坏了**:连续下单失败、连续解析失败,到阈值就整体停,人工解除。
 * 这里管的是**今天不顺**:接连止损、盈亏回撤过大、当天亏到了上限、刚平掉的标的立刻又要进——都不是故障,
 * 是该歇一会儿。所以它不写状态文件、不需要人工解除:**规则从库里现算,到点自己就过去了**。
 *
 * 三条边界,任何时候都不许越:
 *  · **只挡新单,永不挡平仓**。持仓追踪发的平仓单、追价改价、托管单对账都不经过这里——
 *    保护期内挡住平仓等于让持仓裸奔,那比多亏一笔严重得多。
 *  · **不落终态**。被保护挡下的单停在"仅校验未发送",保护期过了还能再发;不像熔断那样判死。
 *  · **算不出来就放行**。库里读不到数据、配置关着,一律不拦——保护规则误拦是妨碍交易,
 *    而它本身并不能避免任何一笔已经发生的亏损。
 */
// 各条规则的配置形状界面也要用,定义在 contract/settings.ts;这里转出,老的 import 不用改。
export type {
  CooldownConfig, DailyLossConfig, MaxDrawdownConfig, ProtectionsConfig, StoplossGuardConfig,
} from "./contract/settings.js";
import type { ProtectionsConfig } from "./contract/settings.js";
import type { ProtectionsSummary } from "./contract/system.js";
import { ET, wallParts, wallToEpoch } from "./tz.js";





/** 一次平仓(来自 audit_log 的 auto_close / hosted_sweep)。 */
export interface CloseEvent {
  atMs: number;
  symbol: string;
  /** tracker 的 STATE_*:take_profit / stop_loss / profit_trail(可能带 sweep: 前缀)。 */
  state: string;
  /** 平掉的那份持仓的腿身份(到期|各腿);正股是空串。冷却按「同一个结构」算时用;不给按空串 */
  leg?: string;
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
  /** 冷却期。键是标的代码(cooldown.scope = symbol),或 cooldownKey(标的, 腿身份)(scope = position)。 */
  cooldowns: Record<string, ProtectionPause>;
  /** 只停某个账户的暂停(日内亏损上限按账户当日盈亏算时)。键是账户别名。 */
  accountPauses: Record<string, ProtectionPause>;
}

export const NO_PROTECTION: ProtectionState = { pause: null, cooldowns: {}, accountPauses: {} };

/** 冷却按「同一个结构」算时的键:标的 + 那份持仓的腿身份。标的代码里不会有 |,和按标的的键撞不上。 */
export function cooldownKey(symbol: string, leg: string): string {
  return `${symbol}|${leg}`;
}

/** 止损类的平仓状态:止损、跟踪止损、利润回撤。止盈不算——赚着钱离场不是"今天不顺"。
 * 追价平仓会给状态加 sweep: 前缀(tracker.SWEEP_PREFIX),按后缀认。 */
export function isStopLike(state: string): boolean {
  const bare = state.includes(":") ? state.slice(state.lastIndexOf(":") + 1) : state;
  return bare === "stop_loss" || bare === "profit_trail";
}

/** 美东某一天的零点;`offsetDays` = 1 就是第二天零点。日内亏损上限按美东日历切日子。 */
export function etDayStart(nowMs: number, offsetDays = 0): number {
  const p = wallParts(nowMs, ET);
  const day = new Date(Date.UTC(p.year, p.month - 1, p.day + offsetDays));
  return wallToEpoch(
    { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour: 0, minute: 0, second: 0 }, ET,
  );
}

/** 有没有哪条开着:全关时一次库都不查。 */
export function protectionsEnabled(cfg: ProtectionsConfig): boolean {
  return cfg.stoploss_guard.enabled || cfg.max_drawdown.enabled || cfg.cooldown.enabled || cfg.daily_loss.enabled;
}

/** 已实现盈亏要不要查(回撤护栏与日内亏损上限才看它)。 */
export function needsPnlEvents(cfg: ProtectionsConfig): boolean {
  return cfg.max_drawdown.enabled || cfg.daily_loss.enabled;
}

/** 查库从哪一刻起:开着的规则里窗口最早的那个起点。日内亏损上限从美东当天零点起。 */
export function protectionsSince(cfg: ProtectionsConfig, nowMs: number): number {
  const lookbackMinutes = Math.max(
    cfg.stoploss_guard.enabled ? cfg.stoploss_guard.lookback_minutes : 0,
    cfg.max_drawdown.enabled ? cfg.max_drawdown.lookback_minutes : 0,
    cfg.cooldown.enabled ? cfg.cooldown.minutes : 0,
  );
  const since = nowMs - lookbackMinutes * 60_000;
  return cfg.daily_loss.enabled ? Math.min(since, etDayStart(nowMs) - 1) : since;
}

/**
 * 现算一遍当前的保护状态。纯函数:同样的输入永远同样的输出,时间也由调用方给。
 *
 * `accountDaily`:券商报的账户当日盈亏(账户别名 → 美元,含未平仓的浮亏、含手动做的单)。日内亏损上限的
 * basis = account 时用它,每个账户各比各的、只停亏到线的那个账户;一个账户都没报(没连券商、富途、订阅还没来)
 * 就退回按已实现盈亏算的那一条——宁可用窄一点的口径,不让这条规则因为缺一个数就不生效。
 * `accountsExpected`:该有这个数的账户(别名)。有的账户报了、有的没报(基础货币不是美元、订阅还没来、数太旧)时,
 * 没报的那几个各自退回已实现盈亏那一条:不能因为别的账户报了数,它就哪一条都不查。
 */
export function evaluateProtections(
  cfg: ProtectionsConfig, closes: CloseEvent[], pnl: PnlEvent[], nowMs: number,
  accountDaily: Record<string, number> | null = null, accountsExpected: readonly string[] = [],
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

  const daily = cfg.daily_loss;
  const accountPauses: Record<string, ProtectionPause> = {};
  const reported = daily.basis === "account" && accountDaily !== null
    ? Object.entries(accountDaily).filter(([, v]) => Number.isFinite(v)) : [];
  // 当天(美东)累计已实现盈亏。不看峰值:这条管的是"今天最多亏多少",上午赚了 300、下午亏回 800 的那天,
  // 净亏 500 才算到线——从峰值算的是回撤护栏的事
  const realizedLoss = (): number | null => {
    const start = etDayStart(nowMs);
    const today = pnl.filter((p) => p.atMs >= start && p.atMs <= nowMs && Number.isFinite(p.pnl));
    const total = today.reduce((acc, p) => acc + p.pnl, 0);
    return today.length && -total >= daily.max_loss_usd ? -total : null;
  };
  if (daily.enabled && daily.max_loss_usd > 0 && reported.length) {
    for (const [alias, value] of reported) {
      if (-value < daily.max_loss_usd) continue;
      accountPauses[alias] = {
        rule: "daily_loss",
        reason:
          `账户 ${alias} 今天的盈亏(券商报的,含未平仓)是 ${value.toFixed(2)} 美元,到了日内亏损上限 ${daily.max_loss_usd},` +
          "今天这个账户不再下新单",
        untilMs: etDayStart(nowMs, 1),
      };
    }
    // 没报数的账户:各自退回已实现盈亏那一条(那个数是引擎发的单合在一起的,不分账户——偏严)
    const missing = accountsExpected.filter((alias) => !reported.some(([name]) => name === alias));
    const loss = missing.length ? realizedLoss() : null;
    if (loss !== null) {
      for (const alias of missing) {
        accountPauses[alias] = {
          rule: "daily_loss",
          reason:
            `账户 ${alias} 券商没有报当日盈亏,退回按已实现算:今天(美东)已实现亏损 ${loss.toFixed(2)} 美元,` +
            `到了日内亏损上限 ${daily.max_loss_usd},今天这个账户不再下新单`,
          untilMs: etDayStart(nowMs, 1),
        };
      }
    }
  } else if (daily.enabled && daily.max_loss_usd > 0) {
    // 亏到线就停到第二天零点
    const loss = realizedLoss();
    if (loss !== null) {
      pauses.push({
        rule: "daily_loss",
        reason:
          `今天(美东)已实现亏损 ${loss.toFixed(2)} 美元,到了日内亏损上限 ${daily.max_loss_usd},` +
          "今天不再下新单",
        untilMs: etDayStart(nowMs, 1),
      });
    }
  }

  const cooldowns: Record<string, ProtectionPause> = {};
  const cool = cfg.cooldown;
  if (cool.enabled && cool.minutes > 0) {
    for (const close of closes) {
      if (!close.symbol) continue;
      const untilMs = close.atMs + cool.minutes * 60_000;
      if (untilMs <= nowMs) continue;
      // 按标的:这只标的的一切新单都停;按结构:只停和刚平掉的那份持仓同一个结构的单
      const byPosition = cool.scope === "position";
      const key = byPosition ? cooldownKey(close.symbol, close.leg ?? "") : close.symbol;
      const cur = cooldowns[key];
      if (cur !== undefined && cur.untilMs >= untilMs) continue;
      cooldowns[key] = {
        rule: "cooldown",
        reason: byPosition
          ? `${close.symbol} 的这一份持仓刚平过,冷却 ${cool.minutes} 分钟内不再开同样的仓`
          : `${close.symbol} 刚平过仓,冷却 ${cool.minutes} 分钟内不再下新单`,
        untilMs,
      };
    }
  }

  // 同时触发就取解除得最晚的那条:两条规则都说该停,听更保守的
  pauses.sort((a, b) => b.untilMs - a.untilMs);
  return { pause: pauses[0] ?? null, cooldowns, accountPauses };
}

/** 这张单现在能不能发。返回拦截原因(给用户看的话),放行是 null。 */
export function protectionBlock(
  state: ProtectionState, symbol: string, nowMs: number, order: { account?: string; leg?: string } = {},
): string | null {
  if (state.pause !== null && state.pause.untilMs > nowMs) {
    return `${state.pause.reason},${remaining(state.pause.untilMs, nowMs)}后自动恢复`;
  }
  const account = order.account ? state.accountPauses[order.account] : undefined;
  if (account !== undefined && account.untilMs > nowMs) {
    return `${account.reason},${remaining(account.untilMs, nowMs)}后自动恢复`;
  }
  // 两种键都查:按标的冷却时键是标的,按结构冷却时键带着腿身份(这张单的腿身份由调用方给)
  const cool = symbol ? state.cooldowns[symbol] ?? state.cooldowns[cooldownKey(symbol, order.leg ?? "")] : undefined;
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
export function protectionsSummary(state: ProtectionState, nowMs: number): ProtectionsSummary {
  const cooling = Object.entries(state.cooldowns)
    .filter(([, p]) => p.untilMs > nowMs)
    .map(([key, p]) => ({ symbol: key.split("|")[0] ?? key, until_ms: p.untilMs, reason: p.reason }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  const accounts = Object.entries(state.accountPauses)
    .filter(([, p]) => p.untilMs > nowMs)
    .map(([account, p]) => ({ account, until_ms: p.untilMs, reason: p.reason }))
    .sort((a, b) => a.account.localeCompare(b.account));
  const pause = state.pause !== null && state.pause.untilMs > nowMs ? state.pause : null;
  return {
    paused: pause !== null,
    rule: pause?.rule ?? "",
    reason: pause?.reason ?? "",
    until_ms: pause?.untilMs ?? null,
    cooldowns: cooling,
    accounts,
  };
}
