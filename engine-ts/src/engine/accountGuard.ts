/** 账户级的风控输入,都由引擎向券商现取:在手敞口(两条累计上限)、当日盈亏(日内亏损上限)、净值(单笔风险预算)。
 *
 * 规则本身是纯函数(validator.ts、protections.ts、openRisk.ts);这里只管"数从哪来、拿不到怎么办"。
 * 三样都是**拿得到才用**:券商没报、不是美元、连接断着,就退回各自原来的口径,并且不让一个缺的数挡住下单——
 * 只有一种情况例外:用户设了在手的累计上限而持仓读不到,那一张**开仓**单拒(核对不了的上限等于没有,见 validator.checkOpenLimits);
 * 减仓的单拿最近一次读到的持仓认,照发。
 * 账户当日盈亏与净值这两路没有在真机上核对过(docs/features/protections.md、risk-budget.md 的「当前状态」)。
 */
import { accountDailyPnl, accountNetLiquidation } from "../accountFeeds.js";
import type { Settings } from "../config.js";
import type { IbSession } from "../ibTypes.js";
import type { ParsedOrder } from "../models.js";
import { contractsKey, openRisk } from "../openRisk.js";
import type { OpenRisk } from "../openRisk.js";
import { etDayStart, evaluateProtections } from "../protections.js";
import type { CloseEvent, PnlEvent, ProtectionPause, ProtectionState } from "../protections.js";
import type { WorkingOrder } from "../riskQueries.js";
import type { Rec } from "../store.js";
import type { ApprovedOrder, ValidatorExtras } from "../validator.js";
import { applyReduction, reducesPositions } from "./closing.js";

export interface AccountGuardHost {
  readonly settings: Settings;
  readonly router: { positions(): Promise<Rec[]>; sessions(): unknown[]; BROKER?: string } | null;
  readonly store: {
    audit(actor: string, action: string, detail: Rec | null): void;
    readonly risk: {
      workingOrders(sinceMs: number, nowMs: number): WorkingOrder[];
      dailyLossTrips(sinceMs: number, nowMs: number): Array<{ alias: string; reason: string; untilMs: number }>;
    };
  };
}

/** 库里记的一张在途单 → 能交给平仓识别的那两样。 */
const asOrder = (w: WorkingOrder): ParsedOrder => ({ contract: w.contract, order: w.order } as unknown as ParsedOrder);

/** 这张在途单的到期日(单腿取合约的,组合取第一条腿的)。 */
function expiryOf(contract: Rec): string {
  const legs = (contract["legs"] ?? []) as Rec[];
  return String(contract["lastTradeDateOrContractMonth"] ?? legs[0]?.["lastTradeDateOrContractMonth"] ?? "").slice(0, 8);
}

/**
 * 持仓算出来的敞口,加上今天发出去还没有终态的开仓单(挂着没成交的、排队中的条件单):它们成交之前持仓里看不见,
 * 不加的话连发两张各自合规的单,两张都过。在减已有持仓的在途单不加。
 */
export function withWorkingOrders(exposure: OpenRisk, working: readonly WorkingOrder[], rows: Rec[]): OpenRisk {
  const out: OpenRisk = { riskUsd: { ...exposure.riskUsd }, contracts: { ...exposure.contracts }, notes: [...exposure.notes] };
  for (const w of working) {
    const secType = String(w.contract["secType"] ?? "");
    if (secType !== "OPT" && secType !== "BAG") continue;
    if (reducesPositions(asOrder(w), w.alias, rows)) continue;
    out.riskUsd[w.alias] = (out.riskUsd[w.alias] ?? 0) + w.notional;
    const key = contractsKey(w.alias, String(w.contract["symbol"] ?? ""), expiryOf(w.contract));
    out.contracts[key] = (out.contracts[key] ?? 0) + (Number(w.order["totalQuantity"]) || 0);
  }
  return out;
}

export class AccountGuard {
  constructor(private readonly host: AccountGuardHost) {}

  /** 日内亏损上限按账户算时,今天到过线的账户:到过就停到美东零点,不因为浮亏收回去一点又放开。
   * 到线的那一刻在审计日志里记一条(daily_loss_trip);引擎重建(改设置、重连都会重建)、软件重启之后从那里读回来。
   * 别名 → 那一天的美东零点 */
  private readonly tripped = new Map<string, { dayStart: number; pause: ProtectionPause }>();
  private trippedLoaded = Number.NaN;
  /** 最近一次读到的持仓:这一次读不到时,拿它认"这张单是不是在减仓" */
  private lastRows: Rec[] | null = null;

  private sessions(): IbSession[] {
    const router = this.host.router;
    // 只有 IBKR 的会话有这两路数据;富途的会话形状不同,不问
    return router === null || router.BROKER === "futu" ? [] : (router.sessions() as IbSession[]);
  }

  private ibkrAccounts(): Array<{ alias: string; account_id: string }> {
    const s = this.host.settings;
    return s.accounts.filter((a) => s.accountBroker(a) === "ibkr");
  }

  private async readRows(): Promise<Rec[] | null> {
    const rows = this.host.router === null ? null : await this.host.router.positions().catch(() => null);
    if (rows !== null) this.lastRows = rows;
    return rows;
  }

  /** 这一批订单的校验要的那几样。两条累计上限一条都没设时不读持仓;单笔风险预算没开时不问净值。 */
  async validatorExtras(nowMs: number = Date.now()): Promise<ValidatorExtras> {
    const s = this.host.settings;
    const out: ValidatorExtras = {};
    const capped = [s.limits, ...s.accounts.map((a) => s.limitsFor(a.alias))]
      .some((l) => l.max_open_risk_usd > 0 || l.max_underlying_contracts > 0);
    if (capped && this.host.router?.BROKER === "futu") {
      // 富途的持仓行不分期权与正股(一律记成 STK)、读失败也不报:敞口算不出来,平仓也认不出。不拿一张空表去放行或拒绝
      out.capNote = "富途通道读不出期权持仓,这个账户的累计上限(在手风险 / 同标的张数)没有核对。";
    } else if (capped) {
      const rows = await this.readRows();
      // 平仓识别用一份自己的拷贝:同一批里认过的减仓逐张扣掉,后一张对着扣过的持仓判
      const basis = (rows ?? this.lastRows)?.map((row) => ({ ...row })) ?? null;
      if (basis !== null) {
        out.isReduction = (order: ParsedOrder, alias: string): boolean => reducesPositions(order, alias, basis);
        out.consumeReduction = (order: ParsedOrder, alias: string): void => applyReduction(order, alias, basis);
      }
      out.exposure = rows === null
        ? null
        : withWorkingOrders(openRisk(rows), this.host.store.risk.workingOrders(etDayStart(nowMs), nowMs), rows);
    }
    if (s.risk_budget.enabled) {
      const sessions = this.sessions();
      const equity: Record<string, number> = {};
      for (const account of this.ibkrAccounts()) {
        const value = accountNetLiquidation(sessions, account.account_id);
        if (value !== null) equity[account.alias] = value;
      }
      if (Object.keys(equity).length) out.equity = equity;
    }
    return out;
  }

  /** 这张已经过了校验的单是不是只在减已有的持仓(排队的条件单到触发那一刻用:保护规则不挡平仓)。读不到持仓 = 认不准 = 不是。 */
  async isReduceOnly(approved: ApprovedOrder): Promise<boolean> {
    const rows = await this.readRows();
    return rows !== null && reducesPositions(approved.order, approved.account.alias, rows);
  }

  /** 券商报的各账户当日盈亏(美元)。日内亏损上限没开、不按账户算、一个账户都没报:null(调用方退回已实现盈亏)。 */
  dailyPnl(nowMs: number): Record<string, number> | null {
    const daily = this.host.settings.protections.daily_loss;
    if (!daily.enabled || daily.basis !== "account") return null;
    const sessions = this.sessions();
    const out: Record<string, number> = {};
    for (const account of this.ibkrAccounts()) {
      const value = accountDailyPnl(sessions, account.account_id, nowMs);
      if (value !== null) out[account.alias] = value;
    }
    return Object.keys(out).length ? out : null;
  }

  /** 现算一遍保护状态:券商报的当日盈亏由这里现取,今天到过线的账户补回去。 */
  protections(cfg: Settings["protections"], closes: CloseEvent[], pnl: PnlEvent[], nowMs: number): ProtectionState {
    const expected = this.host.settings.accounts.map((a) => a.alias);
    return this.withLatch(evaluateProtections(cfg, closes, pnl, nowMs, this.dailyPnl(nowMs), expected), nowMs);
  }

  /** 把"今天到过线"的账户补回去:券商报的数含浮亏,收回去一点就不到线了,但"今天不再下新单"是这条规则的本意。 */
  withLatch(state: ProtectionState, nowMs: number): ProtectionState {
    const today = etDayStart(nowMs);
    if (this.trippedLoaded !== today) {
      // 换了一天、或这个引擎头一次问:从审计日志里把今天记过的读回来
      this.trippedLoaded = today;
      this.tripped.clear();
      try {
        for (const trip of this.host.store.risk.dailyLossTrips(today, nowMs)) {
          this.tripped.set(trip.alias, { dayStart: today, pause: { rule: "daily_loss", reason: trip.reason, untilMs: trip.untilMs } });
        }
      } catch {
        /* 读不回来就只认这个引擎自己见过的 */
      }
    }
    for (const [alias, pause] of Object.entries(state.accountPauses)) {
      if (!this.tripped.has(alias)) {
        this.host.store.audit("engine", "daily_loss_trip", { alias, reason: pause.reason, until_ms: pause.untilMs });
      }
      this.tripped.set(alias, { dayStart: today, pause });
    }
    const accountPauses = { ...state.accountPauses };
    for (const [alias, hit] of [...this.tripped]) {
      if (accountPauses[alias] === undefined) accountPauses[alias] = hit.pause;
    }
    return Object.keys(accountPauses).length === Object.keys(state.accountPauses).length ? state : { ...state, accountPauses };
  }
}
