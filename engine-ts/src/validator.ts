/** 软件层硬校验(对应 Python validator.py,§5)——第二道防线,全部纯代码。
 *
 * 立场不变:LLM 的输出是不可信输入。限额自己重算、方向自己复核、账户自己映射、
 * 价差结构自己验。所有拒绝信息与 Python 版逐字节一致(黄金对拍直接比字符串)。
 */
import type { EtNow, Settings } from "./config.js";
import type { ContractSpec, Leg, OrderSpec, ParsedOrder } from "./models.js";
import { multiplierValue } from "./models.js";
import { fmtF, pyG } from "./py.js";
import { weekdayOfDate } from "./tz.js";
export type { RecentOrder } from "./models.js";
import type { RecentOrder } from "./models.js";
import { riskBudgetWarning } from "./riskBudget.js";

export const VALIDATOR_CODES = new Set([
  "LOW_CONFIDENCE", "UNKNOWN_ACCOUNT", "LIVE_TRADING_DISABLED", "EXCEEDS_LIMIT",
  "BAD_SPREAD", "TRIGGER_MISMATCH", "AMBIGUOUS_TRIGGER", "EXPIRED_CONTRACT",
  "MARKET_CLOSED", "DUPLICATE_ORDER", "UNSUPPORTED", "UNPRICEABLE",
]);

export interface ValidationIssue {
  code: string;
  message: string;
}


export interface ApprovedOrder {
  order: ParsedOrder;
  account: { alias: string; account_id: string; is_paper: boolean; connection: string };
  notional: number;
  signature: string;
  warnings: string[];
}

export interface RejectedOrder {
  order: ParsedOrder;
  issues: ValidationIssue[];
}

export function primaryCode(rejected: RejectedOrder): string {
  return rejected.issues.length ? rejected.issues[0]!.code : "UNSUPPORTED";
}

export function rejectionMessage(rejected: RejectedOrder): string {
  const seen: string[] = [];
  for (const issue of rejected.issues) {
    if (!seen.includes(issue.message)) seen.push(issue.message);
  }
  return seen.join(" / ");
}

export interface ValidationOutcome {
  approved: ApprovedOrder[];
  rejected: RejectedOrder[];
}

/** 能交易、但交易所只收限价单的时段。"盘外"来自合约自己的交易时段
 * (config.hoursStatus):SPX 期权的隔夜段既不是正股口径的"盘前"也不是"盘后"。
 * 与 tracker.EXTENDED_SESSIONS 同一套语义,两边都改才不会一边放行一边拦。 */
export const EXTENDED_STATUSES = ["盘前", "盘后", "盘外"];

export class Validator {
  readonly settings: Settings;
  readonly nowEt: EtNow;
  readonly snapshot: Record<string, number>;
  readonly recentOrders: RecentOrder[];
  readonly marketStatus: string;
  private readonly marketStatusFn: ((order: ParsedOrder) => string | null) | null;

  constructor(
    settings: Settings,
    nowEt: EtNow,
    snapshot?: Record<string, number> | null,
    recentOrders?: RecentOrder[] | null,
    marketStatusFn?: ((order: ParsedOrder) => string | null) | null,
  ) {
    this.settings = settings;
    this.nowEt = nowEt;
    this.snapshot = {};
    for (const [k, v] of Object.entries(snapshot ?? {})) this.snapshot[k.toUpperCase()] = Number(v);
    this.recentOrders = [...(recentOrders ?? [])];
    this.marketStatus = settings.marketStatus(nowEt);
    this.marketStatusFn = marketStatusFn ?? null;
  }

  /** 这一单此刻面对的时段。期权/组合优先用合约自己的,拿不到退回正股表。
   *
   * 存在的理由:`settings.marketStatus` 是照**美股正股**写的,而 SPX 期权还有
   * 20:15–次日 09:25 这一整段隔夜可交易时间(IBKR 报的 SPXW 时段)。拿正股的表判期权,
   * 隔夜下单会被误告「当前休市,订单将挂到下一个交易时段」,而那时它其实能成交。 */
  statusFor(order: ParsedOrder): string {
    if (this.marketStatusFn !== null) {
      let got: string | null = null;
      try {
        got = this.marketStatusFn(order);
      } catch {
        got = null;                 // 查时段失败不该让校验整个炸
      }
      if (got) return got;
    }
    return this.marketStatus;
  }

  /**
   * 逐条校验一批订单。`limit` 覆盖单次输入的订单上限:引擎按账户扇出后同一条输入
   * 会变成 N 倍订单,上限也要按同样倍数放大,否则第二个账户的订单会被当成超额拦掉。
   */
  validateAll(orders: ParsedOrder[], limit?: number | null): ValidationOutcome {
    const outcome: ValidationOutcome = { approved: [], rejected: [] };
    limit = limit ?? this.settings.limits.max_orders_per_input;
    const seenInBatch: Record<string, number> = {};

    orders.forEach((order, index) => {
      if (index >= limit) {
        outcome.rejected.push({
          order,
          issues: [{
            code: "EXCEEDS_LIMIT",
            message:
              `单次输入最多解析 ${limit} 笔订单,本条排在第 ${index + 1} 位,已拦截。` +
              "请拆成多次提交。",
          }],
        });
        return;
      }
      const [issues, approved] = this.validateOne(order, seenInBatch);
      if (issues.length || approved === null) {
        outcome.rejected.push({ order, issues });
      } else {
        seenInBatch[approved.signature] = order.order.totalQuantity;
        outcome.approved.push(approved);
      }
    });
    return outcome;
  }

  validateOne(
    order: ParsedOrder,
    seenInBatch?: Record<string, number>,
  ): [ValidationIssue[], ApprovedOrder | null] {
    const issues: ValidationIssue[] = [];
    const warnings: string[] = [];

    // 1. 置信度(§5.2)
    const minConf = this.settings.limits.min_confidence;
    if (order.confidence < minConf) {
      issues.push({
        code: "LOW_CONFIDENCE",
        message:
          `解析置信度 ${fmtF(order.confidence, 2)} 低于阈值 ${fmtF(minConf, 2)},` +
          "按规则改判拒绝。请把指令写得更明确后重试。",
      });
    }

    // 2. 账户映射
    const account = this.settings.accountByAlias(order.account);
    if (account === null) {
      const aliases = this.settings.aliasList().join("、") || "(未配置)";
      issues.push({
        code: "UNKNOWN_ACCOUNT",
        message:
          `账户别名 '${order.account}' 不在别名表中(可用:${aliases})。` +
          "请改写指令或先在设置里添加别名。",
      });
    } else if (!account.is_paper && !this.settings.policies.allow_live_trading) {
      issues.push({
        code: "LIVE_TRADING_DISABLED",
        message:
          `订单指向实盘账户 ${account.alias},但当前没有允许实盘下单(默认关闭)。` +
          "请先在纸面账户跑够回归测试,再到「设置」里打开「允许实盘账户下单」。",
      });
    }

    // 3. 合约复核
    issues.push(...this.checkContract(order.contract, warnings));

    // 4. 价差结构复核(§5.3a)
    if (order.contract.secType === "BAG") {
      issues.push(...this.checkSpread(order.contract, order.order));
    }

    // 5. 触发方向复核(§5.3b)
    if (order.trigger !== null) {
      issues.push(...this.checkTrigger(order, warnings));
    }

    // 6. 限额复算(§5.2)
    const [notional, limitIssues] = this.checkLimits(order);
    issues.push(...limitIssues);

    // 7. 交易时段(§5.5)
    issues.push(...this.checkSession(order, warnings));

    // 8. 重复防抖(§5.4)
    const signature = orderSignature(order, order.account);
    issues.push(...this.checkDuplicate(order, signature, seenInBatch ?? {}));

    // 9. 原因缺失只警告(§2 铁律 8)
    if (!order.reason.trim()) {
      warnings.push("未提供操作原因,建议补充以便复盘");
    }

    if (issues.length || account === null) return [issues, null];

    // 10. 单笔风险预算:占账户权益的比例,只告警
    const budget = riskBudgetWarning(this.settings.risk_budget, account.alias, order.contract.secType, notional);
    if (budget !== null) warnings.push(budget);

    const merged = [...order.warnings, ...warnings];
    return [[], { order, account, notional, signature, warnings: merged }];
  }

  // ---- 合约 ---------------------------------------------------------
  private checkContract(contract: ContractSpec, warnings: string[]): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const expiries: string[] = [];
    if (contract.lastTradeDateOrContractMonth) expiries.push(contract.lastTradeDateOrContractMonth);
    for (const leg of contract.legs ?? []) expiries.push(leg.lastTradeDateOrContractMonth);

    const today = this.nowEt.date;
    for (const raw of expiries) {
      const expiry = expiryToIso(raw);
      if (expiry < today) {
        issues.push({
          code: "EXPIRED_CONTRACT",
          message: `到期日 ${raw} 已早于当前美东日期 ${today},合约不存在。`,
        });
      } else if (!this.settings.isTradingDay(expiry)) {
        issues.push({
          code: "EXPIRED_CONTRACT",
          message: `到期日 ${raw} 不是交易日(周末或休市日),请确认后重写。`,
        });
      }
    }

    // 指数期权的 tradingClass 按到期日复核(§8.3)
    const indexCfg = this.settings.indexConfig(contract.symbol);
    if (indexCfg && expiries.length) {
      for (const [slot, raw] of expirySlots(contract)) {
        const expiry = expiryToIso(raw);
        const expected = isIndexMonthlyExpiry(expiry, this.settings)
          ? indexCfg.monthly_trading_class
          : indexCfg.daily_trading_class;
        if (!expected) continue;
        const current = slot.tradingClass;
        if (current !== expected) {
          warnings.push(
            `${contract.symbol} ${raw} 到期的 tradingClass 由 ` +
            `${current === null ? "None" : `'${current}'`} 复核为 '${expected}'(按到期日判定)`,
          );
          slot.tradingClass = expected;
        }
      }
    }
    return issues;
  }

  // ---- 价差 ---------------------------------------------------------
  private checkSpread(contract: ContractSpec, order: OrderSpec): ValidationIssue[] {
    if (contract.combo_strategy === "BUTTERFLY") return this.checkButterfly(contract, order);
    if (contract.combo_strategy === "IRON_CONDOR") return this.checkIronCondor(contract, order);
    return this.checkVertical(contract, order);
  }

  private checkVertical(contract: ContractSpec, order: OrderSpec): ValidationIssue[] {
    const legs: Leg[] = [...(contract.legs ?? [])];
    if (legs.length !== 2) return [bad("垂直价差必须正好两条腿。")];

    const buys = legs.filter((l) => l.action === "BUY");
    const sells = legs.filter((l) => l.action === "SELL");
    if (buys.length !== 1 || sells.length !== 1) {
      return [bad("垂直价差必须一买一卖各一条腿。")];
    }
    const buy = buys[0]!;
    const sell = sells[0]!;
    const issues: ValidationIssue[] = [];
    if (buy.right !== sell.right) issues.push(bad("两腿必须同为 Call 或同为 Put。"));
    if (buy.lastTradeDateOrContractMonth !== sell.lastTradeDateOrContractMonth) {
      issues.push(bad("垂直价差两腿到期日必须相同。"));
    }
    if (buy.strike === sell.strike) issues.push(bad("两腿行权价不能相同。"));
    if (buy.ratio !== 1 || sell.ratio !== 1) issues.push(bad("垂直价差只支持 1:1 比例。"));
    if (issues.length) return issues;

    // 方向复核:借方价差(BUY)买低卖高(call)/ 买高卖低(put),SELL 相反
    const debit = order.action === "BUY";
    let ok: boolean;
    if (buy.right === "C") {
      ok = debit ? buy.strike < sell.strike : buy.strike > sell.strike;
    } else {
      ok = debit ? buy.strike > sell.strike : buy.strike < sell.strike;
    }
    if (!ok) {
      issues.push(bad(
        `${debit ? "买入(借方)" : "卖出(贷方)"} ${buy.right === "C" ? "call" : "put"} spread ` +
        `的腿方向不对:买 ${fmtF(buy.strike, 2)} / 卖 ${fmtF(sell.strike, 2)} 不构成该方向的垂直价差。`,
      ));
    }

    if (order.price_mode === "AUTO_MID" && order.lmtPrice !== null) {
      issues.push(bad("AUTO_MID 时 lmtPrice 必须为空。"));
    }
    if (order.price_mode === "EXPLICIT" && order.lmtPrice !== null && debit) {
      const width = Math.abs(buy.strike - sell.strike);
      if (order.lmtPrice > width) {
        issues.push(bad(
          `借方价差净权利金 ${fmtF(order.lmtPrice, 2)} 超过行权价差 ${fmtF(width, 2)},` +
          "数学上不可能盈利。",
        ));
      }
    }
    return issues;
  }

  private checkButterfly(contract: ContractSpec, order: OrderSpec): ValidationIssue[] {
    const legs: Leg[] = [...(contract.legs ?? [])].sort((a, b) => a.strike - b.strike);
    if (legs.length !== 3) return [bad("蝴蝶必须正好三条腿。")];

    const [lo, mid, hi] = legs as [Leg, Leg, Leg];
    const issues: ValidationIssue[] = [];
    if (order.action !== "BUY") {
      issues.push(bad("仅支持买入(借方)蝴蝶:卖出蝴蝶的保证金与风险结构不在本系统支持范围内。"));
    }
    if (new Set(legs.map((l) => l.right)).size !== 1) {
      issues.push(bad("蝴蝶三条腿必须同为 Call 或同为 Put。"));
    }
    if (new Set(legs.map((l) => l.lastTradeDateOrContractMonth)).size !== 1) {
      issues.push(bad("蝴蝶三条腿到期日必须相同。"));
    }
    if (new Set(legs.map((l) => l.strike)).size !== 3) {
      issues.push(bad("蝴蝶三条腿行权价必须互不相同。"));
    }
    if (lo.action !== "BUY" || hi.action !== "BUY" || mid.action !== "SELL") {
      issues.push(bad("买入蝴蝶的腿方向必须是:买最低价、卖中间价、买最高价。"));
    }
    if (lo.ratio !== 1 || hi.ratio !== 1 || mid.ratio !== 2) {
      issues.push(bad("蝴蝶比例必须是 1:-2:1(外翼各 1 张,中腿 2 张)。"));
    }
    if (issues.length) return issues;

    const wingLo = mid.strike - lo.strike;
    const wingHi = hi.strike - mid.strike;
    if (Math.abs(wingLo - wingHi) > 0.01) {
      return [bad(
        `蝴蝶两翼必须等距(当前 ${fmtF(wingLo, 2)} / ${fmtF(wingHi, 2)})。` +
        "不等翼(broken wing)结构不支持。",
      )];
    }

    if (order.price_mode === "EXPLICIT" && order.lmtPrice !== null) {
      if (order.lmtPrice > wingLo) {
        issues.push(bad(
          `蝴蝶净权利金 ${fmtF(order.lmtPrice, 2)} 超过翼宽 ${fmtF(wingLo, 2)},数学上不可能盈利。`,
        ));
      }
    }
    return issues;
  }

  private checkIronCondor(contract: ContractSpec, order: OrderSpec): ValidationIssue[] {
    const legs: Leg[] = [...(contract.legs ?? [])].sort((a, b) => a.strike - b.strike);
    if (legs.length !== 4) return [bad("铁鹰必须正好四条腿。")];

    const issues: ValidationIssue[] = [];
    if (order.action !== "SELL") {
      issues.push(bad("仅支持卖出(贷方)铁鹰:收权利金、卖内侧买外翼。借方(反向)铁鹰不支持。"));
    }
    if (new Set(legs.map((l) => l.lastTradeDateOrContractMonth)).size !== 1) {
      issues.push(bad("铁鹰四条腿到期日必须相同。"));
    }
    if (legs.some((l) => l.ratio !== 1)) issues.push(bad("铁鹰四条腿比例必须都是 1。"));
    if (new Set(legs.map((l) => l.strike)).size !== 4) {
      issues.push(bad("铁鹰四条腿行权价必须互不相同(内侧同价的铁蝶结构不支持)。"));
    }

    const puts = legs.filter((l) => l.right === "P").sort((a, b) => a.strike - b.strike);
    const calls = legs.filter((l) => l.right === "C").sort((a, b) => a.strike - b.strike);
    if (puts.length !== 2 || calls.length !== 2) {
      issues.push(bad("铁鹰必须由两条 Put 腿与两条 Call 腿组成。"));
    }
    if (issues.length) return issues;

    if (puts[puts.length - 1]!.strike >= calls[0]!.strike) {
      issues.push(bad("铁鹰的 Put 侧行权价必须整体低于 Call 侧。"));
    }
    if (puts[0]!.action !== "BUY" || puts[1]!.action !== "SELL") {
      issues.push(bad("Put 侧腿方向不对:应买入低行权价、卖出高行权价。"));
    }
    if (calls[0]!.action !== "SELL" || calls[1]!.action !== "BUY") {
      issues.push(bad("Call 侧腿方向不对:应卖出低行权价、买入高行权价。"));
    }
    return issues;
  }

  // ---- 触发条件 ------------------------------------------------------
  private checkTrigger(order: ParsedOrder, warnings: string[]): ValidationIssue[] {
    const trigger = order.trigger!;
    const price = this.snapshot[trigger.symbol];
    if (price === undefined) {
      if (this.settings.policies.require_trigger_price_verification) {
        return [{
          code: "AMBIGUOUS_TRIGGER",
          message:
            `缺少 ${trigger.symbol} 的现价快照,无法独立复核触发方向` +
            `(${trigger.operator} ${fmtF(trigger.value, 4)}),按策略拒绝。`,
        }];
      }
      warnings.push(`未取得 ${trigger.symbol} 现价,触发方向未经软件层复核`);
      return [];
    }

    const gapBps = price ? (Math.abs(price - trigger.value) / price) * 10_000 : 0.0;
    if (gapBps < this.settings.policies.trigger_min_gap_bps) {
      return [{
        code: "AMBIGUOUS_TRIGGER",
        message:
          `${trigger.symbol} 现价 ${fmtF(price, 4)} 与触发价 ${fmtF(trigger.value, 4)} ` +
          `相差仅 ${fmtF(gapBps, 1)} 个基点,方向不可靠,已拒绝。`,
      }];
    }

    const expected = price < trigger.value ? ">=" : "<=";
    if (trigger.operator !== expected) {
      return [{
        code: "TRIGGER_MISMATCH",
        message:
          `触发方向判反了:${trigger.symbol} 现价 ${fmtF(price, 4)} ` +
          `${price < trigger.value ? "低于" : "高于"} 触发价 ${fmtF(trigger.value, 4)},` +
          `应为 ${expected},模型给的是 ${trigger.operator}。`,
      }];
    }
    warnings.push(
      `已复核:${trigger.symbol} 现价 ${fmtF(price, 4)},触发条件 ` +
      `${trigger.operator} ${fmtF(trigger.value, 4)} 方向一致`,
    );
    return [];
  }

  // ---- 限额 ---------------------------------------------------------
  private checkLimits(order: ParsedOrder): [number, ValidationIssue[]] {
    const limits = this.settings.limits;
    const contract = order.contract;
    const spec = order.order;
    const qty = spec.totalQuantity;
    const issues: ValidationIssue[] = [];
    let notional: number;

    if (contract.secType === "BAG") {
      const width = riskWidth(contract);
      if (spec.price_mode === "EXPLICIT" && spec.lmtPrice !== null) {
        if (spec.action === "BUY") {
          // 借方组合最大亏损 = 付出的净权利金
          notional = qty * multiplierValue(contract) * spec.lmtPrice;
        } else {
          // 贷方组合最大亏损 = 宽度 - 收到的权利金
          notional = qty * multiplierValue(contract) * Math.max(width - spec.lmtPrice, 0.0);
        }
      } else {
        // AUTO_MID:权利金未知,用结构宽度做最大亏损上界
        notional = qty * multiplierValue(contract) * width;
      }
    } else if (contract.secType === "OPT") {
      if (spec.action === "SELL") {
        if (contract.right !== "P") {
          return [0.0, [{
            code: "UNSUPPORTED",
            message:
              "裸卖 Call 的最大亏损无上限,且本系统无法核对你是否持有正股" +
              "(备兑)。单腿卖出 Call 不支持;备兑思路请直接在 TWS 操作," +
              "或改用风险有界的贷方价差(卖出 call spread)。",
          }]];
        }
        if (!contract.strike || contract.strike <= 0) {
          return [0.0, [{
            code: "UNPRICEABLE",
            message:
              "卖出 Put 需要行权价才能按最坏情况(被行权接货)核算敞口," +
              "当前合约缺少行权价,已拒绝。",
          }]];
        }
        // 卖出 Put 按现金担保口径计敞口
        notional = qty * multiplierValue(contract) * contract.strike;
      } else {
        // 买入期权:最大亏损 = 付出的权利金(标的现价不是权利金,不做快照兜底)
        const premium = referencePrice(spec, null);
        if (premium === null) {
          return [0.0, [{
            code: "UNPRICEABLE",
            message:
              "单腿期权缺少可用于估算风险敞口的价格(权利金),无法核对限额,已拒绝。" +
              "请写明权利金上限,例如'权利金不超过 5.5'。",
          }]];
        }
        notional = qty * multiplierValue(contract) * premium;
      }
    } else {
      const ref = referencePrice(spec, this.snapshot[contract.symbol] ?? null);
      if (ref === null) {
        if (qty > limits.max_mkt_shares) {
          return [0.0, [{
            code: "EXCEEDS_LIMIT",
            message:
              `无法估算市价单金额(指令与行情快照都没有参考价),股数 ${spec.totalQuantity} ` +
              `超过市价单上限 ${limits.max_mkt_shares} 股。`,
          }]];
        }
        return [0.0, []];
      }
      notional = qty * ref;
    }

    if (notional > limits.max_order_notional) {
      issues.push({
        code: "EXCEEDS_LIMIT",
        message:
          `本笔风险敞口约 ${fmtF(notional, 2)} USD,超过单笔上限 ` +
          `${fmtF(limits.max_order_notional, 2)} USD。`,
      });
    }
    if (
      (contract.secType === "OPT" || contract.secType === "BAG") &&
      spec.totalQuantity > limits.max_option_contracts
    ) {
      issues.push({
        code: "EXCEEDS_LIMIT",
        message:
          `期权/价差单笔 ${spec.totalQuantity} 张,超过上限 ${limits.max_option_contracts} 张。`,
      });
    }
    return [notional, issues];
  }

  // ---- 交易时段 ------------------------------------------------------
  private checkSession(order: ParsedOrder, warnings: string[]): ValidationIssue[] {
    const policy = this.settings.policies.closed_market_policy;
    const status = this.statusFor(order);
    const spec = order.order;

    if (status === "休市") {
      if (order.execution_type === "CONDITIONAL") {
        warnings.push("当前休市,条件单进入等待队列,开盘后才可能触发");
        return [];
      }
      if (policy === "reject_all") {
        return [{ code: "MARKET_CLOSED", message: "当前休市,按策略拒绝所有直接执行型订单。" }];
      }
      if (policy === "reject_market_orders" && spec.orderType === "MKT") {
        return [{
          code: "MARKET_CLOSED",
          message:
            "当前休市,市价单会在开盘瞬间以未知价格成交,风险过大,已拒绝。" +
            "请改成限价单,例如'限价 230 买入'。",
        }];
      }
      warnings.push("当前休市,订单将挂到下一个交易时段");
      return [];
    }

    if (EXTENDED_STATUSES.includes(status) && !spec.outsideRth) {
      // 光说"要等"没用——用户要的是知道怎么让它现在就走。
      warnings.push(
        `当前为${status},outsideRth=false:订单会挂着,到常规时段才送交易所。` +
        `要在${status}就成交,指令里加「盘外」或「隔夜」。`,
      );
    }
    if (EXTENDED_STATUSES.includes(status) && spec.outsideRth && spec.orderType === "MKT") {
      // 交易所盘外只接受限价单:盘外市价单必须硬拒而不是警告
      return [{
        code: "UNSUPPORTED",
        message:
          `${status}市价单不被交易所支持:盘外只接受限价单,市价单会一直等到开盘才成交,` +
          "与盘外成交的意图矛盾。请改写为盘外限价单,例如'盘前限价 X 买入…'。",
      }];
    }
    return [];
  }

  // ---- 重复防抖 ------------------------------------------------------
  private checkDuplicate(
    order: ParsedOrder,
    signature: string,
    seenInBatch: Record<string, number>,
  ): ValidationIssue[] {
    const limits = this.settings.limits;
    const qty = order.order.totalQuantity;

    if (
      signature in seenInBatch &&
      qtyClose(qty, seenInBatch[signature]!, limits.duplicate_qty_tolerance)
    ) {
      return [{
        code: "DUPLICATE_ORDER",
        message: `同一条输入里出现了重复订单(${signature}),已拦截第二笔以防重复下单。`,
      }];
    }

    const windowMs = limits.duplicate_window_minutes * 60_000;
    for (const recent of this.recentOrders) {
      if (recent.signature !== signature) continue;
      if (this.nowEt.epochMs - recent.createdAtMs > windowMs) continue;
      if (qtyClose(qty, recent.quantity, limits.duplicate_qty_tolerance)) {
        return [{
          code: "DUPLICATE_ORDER",
          message:
            `${limits.duplicate_window_minutes} 分钟内已提交过高度相似的订单` +
            `(${signature},数量 ${pyG(recent.quantity)}),已拦截以防重复下单。` +
            "如确需再下一笔,请等待窗口结束或改变数量。",
        }];
      }
    }
    return [];
  }
}

function bad(message: string): ValidationIssue {
  return { code: "BAD_SPREAD", message };
}

// ----------------------------------------------------------------------
/** 用于防抖与审计的订单指纹:账户+方向+合约要素,不含数量与价格。 */
export function orderSignature(order: ParsedOrder, accountAlias: string): string {
  const contract = order.contract;
  const parts: string[] = [accountAlias, order.order.action, contract.secType, contract.symbol];
  if (contract.secType === "OPT") {
    parts.push(
      contract.lastTradeDateOrContractMonth ?? "",
      pyG(contract.strike ?? 0),
      contract.right ?? "",
    );
  } else if (contract.secType === "BAG") {
    for (const leg of [...(contract.legs ?? [])].sort((a, b) => a.strike - b.strike)) {
      parts.push(
        leg.action, String(leg.ratio), leg.lastTradeDateOrContractMonth, pyG(leg.strike), leg.right,
      );
    }
  }
  return parts.join("|");
}

/** 组合的最大亏损宽度(每张、每乘数单位)。结构不合法时给 0。 */
export function riskWidth(contract: ContractSpec): number {
  const legs = [...(contract.legs ?? [])].sort((a, b) => a.strike - b.strike);
  const strategy = contract.combo_strategy;
  if (strategy === "VERTICAL" && legs.length === 2) {
    return Math.abs(legs[1]!.strike - legs[0]!.strike);
  }
  if (strategy === "BUTTERFLY" && legs.length === 3) {
    return legs[1]!.strike - legs[0]!.strike;
  }
  if (strategy === "IRON_CONDOR" && legs.length === 4) {
    const puts = legs.filter((l) => l.right === "P").sort((a, b) => a.strike - b.strike);
    const calls = legs.filter((l) => l.right === "C").sort((a, b) => a.strike - b.strike);
    if (puts.length === 2 && calls.length === 2) {
      return Math.max(puts[1]!.strike - puts[0]!.strike, calls[1]!.strike - calls[0]!.strike);
    }
  }
  return 0.0;
}

function referencePrice(spec: OrderSpec, snapshotPrice: number | null): number | null {
  for (const candidate of [spec.lmtPrice, spec.auxPrice, snapshotPrice]) {
    if (candidate) return Number(candidate);
  }
  return null;
}

function qtyClose(a: number, b: number, tolerance: number): boolean {
  if (a === b) return true;
  const base = Math.max(Math.abs(a), Math.abs(b)) || 1.0;
  return Math.abs(a - b) / base <= tolerance;
}

function expiryToIso(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

function isThirdFriday(dateIso: string): boolean {
  if (weekdayOfDate(dateIso) !== 4) return false;
  const day = Number(dateIso.slice(8, 10));
  return day >= 15 && day <= 21;
}

/**
 * 指数月度期权(AM 结算)的最后交易日 = 第三个周五的**前一个交易日**,通常是周四。
 *
 * 这里曾按 "第三个周五本身" 判定,方向正好反了。2026-09-09 对着真实 TWS 核过:
 * SPX 月度类记的是 20260917、20261015、20261119、20261217、20270114、20270218——
 * 全是第三个周五的前一天;第三个周五当天(20260918)只存在于日到期类 SPXW。
 * 判反的后果是双向的:第三个周五的单会被改写成不存在的月度合约,下单时 qualify 直接挂;
 * 真正的月度那天(两条链都在)则被改成日到期类,把 AM 结算悄悄换成 PM 结算。
 */
function isIndexMonthlyExpiry(dateIso: string, settings: Settings): boolean {
  const thirdFri = thirdFridayOfMonth(dateIso.slice(0, 7));
  if (thirdFri === null) return false;
  return prevTradingDay(thirdFri, settings) === dateIso;
}

function thirdFridayOfMonth(yearMonth: string): string | null {
  for (let day = 15; day <= 21; day++) {
    const iso = `${yearMonth}-${String(day).padStart(2, "0")}`;
    if (isThirdFriday(iso)) return iso;
  }
  return null;
}

function prevTradingDay(dateIso: string, settings: Settings): string {
  let ms = Date.parse(dateIso + "T00:00:00Z");
  for (let i = 0; i < 10; i++) {
    ms -= 86_400_000;
    const iso = new Date(ms).toISOString().slice(0, 10);
    if (settings.isTradingDay(iso)) return iso;
  }
  return dateIso;
}

function* expirySlots(
  contract: ContractSpec,
): Generator<[{ tradingClass: string | null }, string]> {
  if (contract.lastTradeDateOrContractMonth) {
    yield [contract, contract.lastTradeDateOrContractMonth];
  }
  for (const leg of contract.legs ?? []) {
    yield [leg, leg.lastTradeDateOrContractMonth];
  }
}
