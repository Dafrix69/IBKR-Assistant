/** 富途 OpenD 下单层(对应 Python futu_broker.py)——BrokerRouter 的另一条腿。
 *
 * 接口与 BrokerRouter 完全一致,上层一行不用改。三件不变:纯计算复用 broker.ts
 * (定价逻辑只能有一份);校验层不放松;拿不到实时报价就拒单。
 * 三件不同(见模块内注释):不支持 BAG(直接拒,不偷偷拆);回报是拉的
 * (pollOrderUpdates);实盘要先交易解锁(密码 md5 只走 Keychain / DPAPI)。
 * 真机联调三结论全部保留:指数闸门、模拟盘合成成交、is_paper 与 trd_env 核对。
 */
import type { AccountConfig, Settings } from "./config.js";
import {
  BrokerError, LegQuote, PlacementResult, bookLiquidity, cleanPrice, finiteQuote, logStderr,
  redactForLog,
} from "./broker.js";
import type { FutuBridge, FutuQuoteCtx, FutuTradeCtx } from "./futuBridge.js";
import { loadFutuBridge } from "./futuBridge.js";
import { KeychainError, getSecret } from "./keychain.js";
import type { ContractSpec } from "./models.js";
import { MIN_BARS, TIMEFRAMES } from "./priceaction.js";
import { fmtF, pyRound } from "./py.js";
import { probePort, PortProber } from "./tws.js";
import type { ApprovedOrder } from "./validator.js";

// 本系统的 K 线周期 → 富途 KLType。富途没有 2 分钟线,缺的明说,不拿 1 分钟合成。
export const KLTYPE: Record<string, string> = {
  "1m": "K_1M", "5m": "K_5M", "15m": "K_15M", "30m": "K_30M", "1h": "K_60M", "1d": "K_DAY",
};

// 富途订单状态 → ib_insync 口径的状态名。
export const ORDER_STATUS: Record<string, string> = {
  UNSUBMITTED: "PendingSubmit",
  WAITING_SUBMIT: "PreSubmitted",
  SUBMITTING: "PreSubmitted",
  SUBMITTED: "Submitted",
  FILLED_PART: "Submitted",
  FILLED_ALL: "Filled",
  CANCELLING_ALL: "PendingCancel",
  CANCELLING_PART: "PendingCancel",
  CANCELLED_ALL: "Cancelled",
  CANCELLED_PART: "Cancelled",
  FILL_CANCELLED: "Cancelled",
  DELETED: "Cancelled",
  FAILED: "Inactive",
  SUBMIT_FAILED: "Inactive",
  DISABLED: "Inactive",
  TIMEOUT: "Inactive",
  NONE: "Unknown",
};

// put-call parity 反推现价的质量闸
const PARITY_MIN_POINTS = 4;
const PARITY_MIN_DISCOUNT = 0.9;
const PARITY_MAX_DISCOUNT = 1.001;
const PARITY_MAX_RESIDUAL = 0.005;

// 还活着、撤得掉的状态。CANCELLING_* 不算。
export const OPEN_STATUS = new Set([
  "UNSUBMITTED", "WAITING_SUBMIT", "SUBMITTING", "SUBMITTED", "FILLED_PART",
]);

// ======================================================================
// 取值助手
// ======================================================================
type Row = Record<string, unknown>;

export function rowsOf(data: unknown): Row[] {
  if (data === null || data === undefined) return [];
  if (Array.isArray(data)) return data.map((r) => ({ ...(r as Row) }));
  return [];
}

/** 按候选列名依次取值。富途 SDK 的列名在不同版本里换过前缀,赌一个名字的
 * 后果是墙分析静默变成一片零。 */
export function fieldOf(row: Row, ...names: string[]): unknown {
  for (const name of names) {
    if (name in row) {
      const value = row[name];
      if (value !== null && value !== undefined && String(value).toLowerCase() !== "nan") {
        return value;
      }
    }
  }
  return null;
}

export function toFloat(value: unknown): number | null {
  const out = Number(value);
  if (value === null || value === undefined || Number.isNaN(out)) return null;
  return Number.isFinite(out) ? out : null;
}

/** 'YYYYMMDD' → 'YYYY-MM-DD'(富途口径)。 */
export function futuDate(day: string): string {
  const text = (day || "").trim();
  if (text.length === 8 && /^\d{8}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }
  return text;
}

/** 'YYYY-MM-DD' → 'YYYYMMDD'。 */
export function plainDate(day: string): string {
  return (day || "").trim().slice(0, 10).replace(/-/g, "");
}

export function barTime(timeKey: unknown, daily: boolean): string {
  const text = String(timeKey ?? "").trim();
  if (daily) return text.slice(0, 10);
  return text.length >= 16 ? text.slice(0, 16) : text;
}

/** IBKR 口径的 durationStr → 日历天数。IBKR 数交易日,富途按日历区间取,
 * 直接拿数字当天数会少三成(周末)。乘 1.5 加缓冲,宁可多取。 */
export function durationDays(spec: Record<string, unknown>): number {
  const text = String(spec["duration"] ?? "5 D").trim().toUpperCase();
  let amount = 5;
  const head = text.split(/\s+/)[0];
  if (head && /^\d+$/.test(head)) amount = parseInt(head, 10);
  if (text.endsWith("Y")) return amount * 365 + 10;
  return Math.trunc(amount * 1.5) + 5;
}

// ======================================================================
// 从期权链自己反推标的现价(put-call parity)
// ======================================================================
/** C − P = S − K·D 对同一到期日的所有行权价都成立:最小二乘直线拟合,
 * 截距=S、斜率的相反数=D。残差是天然的质量闸,报价脏就拒绝。 */
export function impliedSpot(pairs: Array<[number, number, number]>): Record<string, number> {
  const points: Array<[number, number]> = [];
  for (const [k, c, p] of pairs) {
    if (k && Number.isFinite(k) && Number.isFinite(c) && Number.isFinite(p) && c > 0 && p > 0) {
      points.push([k, c - p]);
    }
  }
  if (points.length < PARITY_MIN_POINTS) {
    throw new BrokerError(
      `只有 ${points.length} 个行权价同时拿到了看涨与看跌的有效报价(至少要 ${PARITY_MIN_POINTS} 个),` +
      "无法反推标的现价。多半是这条链的盘口太稀疏。",
    );
  }
  const n = points.length;
  let sumK = 0;
  let sumY = 0;
  let sumKK = 0;
  let sumKY = 0;
  for (const [k, y] of points) {
    sumK += k;
    sumY += y;
    sumKK += k * k;
    sumKY += k * y;
  }
  const denom = n * sumKK - sumK * sumK;
  if (Math.abs(denom) < 1e-9) {
    throw new BrokerError("反推现价失败:所有取样的行权价都一样,拟合不出斜率。");
  }
  const slope = (n * sumKY - sumK * sumY) / denom;
  const spot = (sumY - slope * sumK) / n;
  const discount = -slope;

  if (!Number.isFinite(spot) || spot <= 0) {
    throw new BrokerError(`反推出的现价不是正数(${fmtF(spot, 4)}),拒绝使用。`);
  }
  if (!(discount >= PARITY_MIN_DISCOUNT && discount <= PARITY_MAX_DISCOUNT)) {
    throw new BrokerError(
      `反推出的折现因子 ${fmtF(discount, 4)} 不合理(应在 ${fmtF(PARITY_MIN_DISCOUNT, 2)} ~ ` +
      `${fmtF(PARITY_MAX_DISCOUNT, 3)} 之间),这条链的报价对不上平价关系,拒绝据此定位墙。`,
    );
  }
  let worst = 0;
  for (const [k, y] of points) worst = Math.max(worst, Math.abs(y - (spot - discount * k)));
  if (worst > spot * PARITY_MAX_RESIDUAL) {
    throw new BrokerError(
      `平价关系拟合的最大残差 ${fmtF(worst, 2)} 超过现价的 ${fmtF(PARITY_MAX_RESIDUAL * 100, 1)}%` +
      `(${fmtF(spot * PARITY_MAX_RESIDUAL, 2)}),说明这条链的报价不干净,拒绝用它反推现价。`,
    );
  }
  return {
    spot: pyRound(spot, 4),
    discount: pyRound(discount, 6),
    residual: pyRound(worst, 4),
    samples: points.length,
  };
}

// ======================================================================
// 回报 shim:与 ib_insync 同形的对象
// ======================================================================
export interface ShimTrade {
  order: { orderId: number; permId: number };
  orderStatus: { status: string; filled: number; remaining: number };
  contract: { symbol: string };
}

export interface ShimFill {
  execution: {
    execId: string;
    time: string;
    price: number;
    shares: number;
    side: string;
    acctNumber: string;
  };
}

export type ReportEvent = ["status" | "fill", ShimTrade, ShimFill | null];

// ======================================================================
// 会话
// ======================================================================
export interface FutuSession {
  name: string;
  host: string;
  port: number;
  quoteCtx: FutuQuoteCtx | null;
  tradeCtx: FutuTradeCtx | null;
  accounts: string[];
  accountEnvs: Record<string, string>;
  unlocked: boolean;
  subscriptions: Map<string, Set<string>>;
}

const sessionConnected = (s: FutuSession): boolean => s.quoteCtx !== null;

interface TrackedOrder {
  record_id: string;
  futu_order_id: string;
  connection: string;
  account_id: string;
  is_paper: boolean;
  symbol: string;
  status: string;
  dealt: number;
  fill_seq?: number;
}

export class FutuRouter {
  static readonly BROKER = "futu";
  readonly BROKER = "futu";
  /** 富途没有原生条件单(§8.1 方式 A):engine 据此把所有条件单送进软件盯盘队列。 */
  readonly SUPPORTS_NATIVE_CONDITIONS = false;
  /** 同理,止盈/止损也没有可同形托管的 GTC+OCA/TRAIL 组合——富途账户的
   * 追踪只能走软件盯盘。engine 与 RPC 都按这个标记拒绝 host_at_broker。 */
  readonly SUPPORTS_HOSTED_CLOSE = false;

  static readonly CHAIN_MAX_WIDTH = 15;
  static readonly SUB_SETTLE_MS = 600;
  static readonly PAGE = 1000;
  static readonly PARITY_SAMPLES = 24;

  readonly settings: Settings;
  private readonly bridgePromise: () => Promise<FutuBridge>;
  private bridgeCache: FutuBridge | null = null;
  private readonly prober: PortProber;
  private readonly sessionsMap = new Map<string, FutuSession>();
  private readonly accountRoute = new Map<string, string>();
  sessionHook: ((session: FutuSession) => void) | null = null;
  private readonly streams = new Set<string>();
  private readonly optionCodes = new Map<string, string>();
  private readonly indexCodes = new Map<string, string | null>();
  private readonly unquotable = new Set<string>();
  private readonly noDealQuery = new Set<string>();
  private readonly orders = new Map<number, TrackedOrder>();
  private nextHandle = 1;
  private readonly seenDeals = new Set<string>();
  private upstreamOkFlag = true;

  private readonly secretReader: (service: string, account: string) => string | null;

  constructor(
    settings: Settings,
    bridge?: FutuBridge | null,
    prober?: PortProber,
    secretReader?: (service: string, account: string) => string | null,
  ) {
    this.settings = settings;
    this.bridgePromise = bridge
      ? async () => bridge
      : async () => {
          if (this.bridgeCache === null) this.bridgeCache = await loadFutuBridge();
          return this.bridgeCache;
        };
    if (bridge) this.bridgeCache = bridge;
    this.prober = prober ?? probePort;
    this.secretReader = secretReader ?? getSecret;
  }

  private async bridge(): Promise<FutuBridge> {
    return this.bridgePromise();
  }

  // ---- 连接 -----------------------------------------------------------
  get connections(): Record<string, { host: string; port: number }> {
    return this.settings.connectionsFor(this.BROKER);
  }

  async connect(connectionName: string): Promise<FutuSession> {
    const existing = this.sessionsMap.get(connectionName);
    if (existing && sessionConnected(existing)) return existing;

    const cfg = this.connections[connectionName];
    if (cfg === undefined) {
      throw new BrokerError(`未定义的连接:${connectionName}(这里只在富途连接里查找)`);
    }

    // 先探端口再建 context:futu 的 context 连不上时会自己重试若干秒,
    // 而 RPC 串行,这几秒会把后面所有请求堵在管道里。
    const probe = await this.prober(cfg.host, cfg.port);
    if (!probe.open) {
      throw new BrokerError(
        `连接 ${connectionName} (${cfg.host}:${cfg.port}) 失败:${probe.error || "端口未监听"}。` +
        `请确认富途 OpenD 已启动并完成登录,且它的 api_port 就是 ${cfg.port}。`,
      );
    }

    const mod = await this.bridge();
    const futuCfg = this.settings.broker.futu;
    let quoteCtx: FutuQuoteCtx | null = null;
    let tradeCtx: FutuTradeCtx | null = null;
    try {
      quoteCtx = await mod.makeQuoteCtx(cfg.host, cfg.port);
      tradeCtx = await mod.makeTradeCtx(
        cfg.host, cfg.port, futuCfg.trd_market, futuCfg.security_firm,
      );
    } catch (exc) {
      await safeClose(quoteCtx);
      await safeClose(tradeCtx);
      throw new BrokerError(
        `连接 ${connectionName} (${cfg.host}:${cfg.port}) 失败:${(exc as Error).message}。` +
        "请在「富途 OpenD」面板点「检测连接」看具体卡在哪一步。",
      );
    }

    const session: FutuSession = {
      name: connectionName,
      host: cfg.host,
      port: cfg.port,
      quoteCtx,
      tradeCtx,
      accounts: [],
      accountEnvs: {},
      unlocked: false,
      subscriptions: new Map(),
    };
    const [accounts, envs] = await this.readAccounts(session);
    session.accounts = accounts;
    session.accountEnvs = envs;
    this.upstreamOkFlag = true;
    this.sessionsMap.set(connectionName, session);
    if (this.sessionHook !== null) {
      try {
        this.sessionHook(session);
      } catch {
        /* 挂监听失败不应阻断连接本身 */
      }
    }
    return session;
  }

  /** 读回会话能管的账号与各自**真实的**交易环境(is_paper 闸门的输入)。 */
  private async readAccounts(session: FutuSession): Promise<[string[], Record<string, string>]> {
    const mod = await this.bridge();
    let ret: unknown;
    let data: unknown;
    try {
      [ret, data] = await session.tradeCtx!.get_acc_list();
    } catch (exc) {
      throw new BrokerError(`读取富途交易账户失败:${String((exc as Error).message).slice(0, 200)}`);
    }
    if (ret !== mod.RET_OK) {
      throw new BrokerError(
        `读取富途交易账户失败:${String(data).slice(0, 200)}。多半是 OpenD 的交易服务没登录。`,
      );
    }
    const accounts: string[] = [];
    const envs: Record<string, string> = {};
    for (const row of rowsOf(data)) {
      const acc = String(fieldOf(row, "acc_id") ?? "").trim();
      if (!acc) continue;
      accounts.push(acc);
      envs[acc] = String(fieldOf(row, "trd_env") ?? "").trim().toUpperCase();
    }
    return [accounts, envs];
  }

  get upstreamOk(): boolean {
    return this.upstreamOkFlag;
  }

  sessions(): FutuSession[] {
    return [...this.sessionsMap.values()].filter(sessionConnected);
  }

  connectedNames(): string[] {
    return [...this.sessionsMap.entries()]
      .filter(([, s]) => sessionConnected(s))
      .map(([name]) => name)
      .sort();
  }

  async disconnectAll(): Promise<void> {
    for (const session of this.sessionsMap.values()) {
      await this.unsubscribeAll(session);
      await safeClose(session.quoteCtx);
      await safeClose(session.tradeCtx);
      session.quoteCtx = null;
      session.tradeCtx = null;
    }
    this.sessionsMap.clear();
    this.accountRoute.clear();
    this.streams.clear();
  }

  /** 路由永远以会话实况为准;跨券商绝不改道(那永远是配置写错)。 */
  async forAccount(account: AccountConfig): Promise<FutuSession> {
    const connections = this.connections;
    if (!(account.connection in connections)) {
      throw new BrokerError(
        `账户 ${account.alias} 绑的连接 ${account.connection} 不是富途连接(当前券商接入:富途)。` +
        "请在设置里给它配一条富途连接和富途账号,或把券商接入切回 IBKR。",
      );
    }
    const order: string[] = [];
    const cached = this.accountRoute.get(account.account_id);
    if (cached && cached in connections) order.push(cached);
    if (!order.includes(account.connection)) order.push(account.connection);
    for (const name of Object.keys(connections)) if (!order.includes(name)) order.push(name);

    const failures: string[] = [];
    for (const name of order) {
      let session: FutuSession;
      try {
        session = await this.connect(name);
      } catch (exc) {
        if (exc instanceof BrokerError) {
          failures.push(exc.message);
          continue;
        }
        throw exc;
      }
      if (session.accounts.includes(account.account_id)) {
        if (name !== account.connection) {
          logStderr(
            `[futu] 账户 ${redactForLog(account.account_id)} 实际由连接 ${name} 管理` +
            `(配置写的是 ${account.connection}),已自动改道`,
          );
        }
        this.accountRoute.set(account.account_id, name);
        return session;
      }
      if (!session.accounts.length && name === account.connection) {
        return session; // 账户列表为空(交易服务未登录):只对配置指定的连接放行
      }
      failures.push(`连接 ${name} 的会话不管理该账户(当前登录的可能是另一个富途账号)`);
    }
    throw new BrokerError(
      `账户 ${account.alias} 在所有已配置的富途连接上都找不到对应会话:` +
      `${failures.join(";") || "无可用连接"}。` +
      "请确认 OpenD 当前登录的就是这个账号,或核对配置里的 account_id。",
    );
  }

  marketSession(): FutuSession {
    const sessions = this.sessions();
    if (!sessions.length) {
      throw new BrokerError("引擎未连接富途 OpenD。请先在「富途 OpenD」面板连接引擎。");
    }
    return sessions[0]!;
  }

  // ---- 代码换算 --------------------------------------------------------
  private static readonly MARKET_PREFIX: Record<string, string> = { US: "US", HK: "HK", CN: "SH" };

  /** 本系统代码 → 富途代码。指数先查覆盖表,再去富途的证券列表实测——绝不猜。 */
  async code(symbol: string): Promise<string> {
    const upper = (symbol || "").trim().toUpperCase();
    const override = this.settings.broker.futu.symbol_map[upper];
    if (override) return override;
    // 指数走到这里也只是解析代码(US..SPX 确实存在),拦截在 quoteCapability()。
    // symbol_map 也不是"把指数映射成 ETF"的后门:闸门认 index_symbols,不认映射后的代码。
    if (this.settings.indexConfig(upper) !== null) {
      const resolved = await this.indexCode(upper);
      if (resolved) return resolved;
      throw new BrokerError(
        `在富途的美股指数列表里找不到 ${upper} 对应的代码。` +
        "请在 config/settings.json 的 broker.futu.symbol_map 里显式指定" +
        `(例如 "${upper}": "US.${upper}")。`,
      );
    }
    const prefix = FutuRouter.MARKET_PREFIX[this.settings.broker.futu.trd_market] ?? "US";
    return `${prefix}.${upper}`;
  }

  /** 去富途的证券列表里实测指数代码,结果缓存。拼错不一定报错,可能拿到别的标的。 */
  private async indexCode(symbol: string): Promise<string | null> {
    if (this.indexCodes.has(symbol)) return this.indexCodes.get(symbol)!;
    const mod = await this.bridge();
    const session = this.marketSession();
    let ret: unknown;
    let data: unknown;
    try {
      [ret, data] = await session.quoteCtx!.get_stock_basicinfo(
        mod.Market.US, mod.SecurityType.IDX,
      );
    } catch {
      this.indexCodes.set(symbol, null);
      return null;
    }
    if (ret !== mod.RET_OK) {
      this.indexCodes.set(symbol, null);
      return null;
    }
    const wanted = symbol.toUpperCase();
    let best: string | null = null;
    for (const row of rowsOf(data)) {
      const code = String(fieldOf(row, "code") ?? "");
      const tail = code.split(".").pop()!.replace(/^\.+/, "").toUpperCase();
      if (tail === wanted) {
        best = code;
        break;
      }
    }
    this.indexCodes.set(symbol, best);
    return best;
  }

  /** (标的, 到期日, 行权价, C/P) → 富途期权代码。用期权链查,不按规则拼。 */
  async optionCode(symbol: string, expiry: string, strike: number, right: string): Promise<string> {
    const key = `${symbol.toUpperCase()}|${expiry}|${pyRound(strike, 4)}|${right.toUpperCase()}`;
    const cached = this.optionCodes.get(key);
    if (cached) return cached;

    const mod = await this.bridge();
    const session = this.marketSession();
    const day = futuDate(expiry);
    const optionType = right.toUpperCase() === "C" ? mod.OptionType.CALL : mod.OptionType.PUT;
    let ret: unknown;
    let data: unknown;
    try {
      [ret, data] = await session.quoteCtx!.get_option_chain({
        code: await this.code(symbol), start: day, end: day, option_type: optionType,
      });
    } catch (exc) {
      throw new BrokerError(
        `获取 ${symbol} 的期权链失败:${String((exc as Error).message).slice(0, 200)}`,
      );
    }
    if (ret !== mod.RET_OK) {
      throw new BrokerError(
        `获取 ${symbol} ${expiry} 的期权链失败:${String(data).slice(0, 200)}` +
        "(该到期日是否存在?富途的期权行情是否已开通?)",
      );
    }
    let target: string | null = null;
    for (const row of rowsOf(data)) {
      const value = toFloat(fieldOf(row, "strike_price", "option_strike_price"));
      if (value !== null && Math.abs(value - strike) < 1e-6) {
        target = String(fieldOf(row, "code") ?? "");
        break;
      }
    }
    if (!target) {
      throw new BrokerError(
        `富途的 ${symbol} ${expiry} 期权链里没有行权价 ${pyStrike(strike)} 的` +
        `${right.toUpperCase() === "C" ? "看涨" : "看跌"}(行权价或到期日不存在)。已拦截。`,
      );
    }
    this.optionCodes.set(key, target);
    return target;
  }

  /** 把已批准的合约换成富途代码。BAG 在这里就拒。 */
  async contractCode(contract: ContractSpec): Promise<string> {
    if (contract.secType === "STK") return this.code(contract.symbol);
    if (contract.secType === "OPT") {
      return this.optionCode(
        contract.symbol,
        contract.lastTradeDateOrContractMonth ?? "",
        Number(contract.strike ?? 0),
        contract.right ?? "C",
      );
    }
    throw new BrokerError(
      "富途 OpenD 不支持多腿组合单(BAG)。价差 / 蝴蝶 / 铁鹰在富途只能拆成" +
      "单腿分别下,而拆单会产生腿风险(一条腿成了另一条没成,建出的是裸头寸" +
      "而不是价差),所以这里直接拒绝。这类结构请把券商接入切回 IBKR。",
    );
  }

  // ---- 订阅 -----------------------------------------------------------
  private async subscribe(session: FutuSession, codes: string[], subtype: string): Promise<void> {
    const mod = await this.bridge();
    const fresh = codes.filter((c) => !session.subscriptions.get(c)?.has(subtype));
    if (!fresh.length) return;
    let ret: unknown;
    let data: unknown;
    try {
      [ret, data] = await session.quoteCtx!.subscribe(fresh, [mod.SubType[subtype]!]);
    } catch (exc) {
      throw new BrokerError(`订阅富途行情失败:${String((exc as Error).message).slice(0, 200)}`);
    }
    if (ret !== mod.RET_OK) {
      throw new BrokerError(
        `订阅富途行情失败:${String(data).slice(0, 200)}。常见原因:①该市场的行情权限没开通;` +
        "②订阅额度已用满(富途按资产等级给额度)。",
      );
    }
    for (const code of fresh) {
      if (!session.subscriptions.has(code)) session.subscriptions.set(code, new Set());
      session.subscriptions.get(code)!.add(subtype);
    }
    await sleep(FutuRouter.SUB_SETTLE_MS);
  }

  /** 用完即退订:不退会占着订阅额度,占满后 AUTO_MID 定价会拿不到报价。 */
  private async unsubscribe(session: FutuSession, codes: string[], subtype: string): Promise<void> {
    const mod = await this.bridge();
    const live = codes.filter((c) => session.subscriptions.get(c)?.has(subtype));
    if (!live.length) return;
    try {
      await session.quoteCtx!.unsubscribe(live, [mod.SubType[subtype]!]);
    } catch {
      return; // 退订失败不该拦住主流程
    }
    for (const code of live) session.subscriptions.get(code)?.delete(subtype);
  }

  private async unsubscribeAll(session: FutuSession): Promise<void> {
    if (session.quoteCtx === null) return;
    try {
      await session.quoteCtx.unsubscribe_all();
    } catch {
      /* ignore */
    }
    session.subscriptions.clear();
  }

  // ---- 行情 -----------------------------------------------------------
  /** 快照。不需要订阅但有调用频率限制,只用在一次性查询上。 */
  private async snapshot(codes: string[]): Promise<Record<string, Row>> {
    if (!codes.length) return {};
    const mod = await this.bridge();
    const session = this.marketSession();
    let ret: unknown;
    let data: unknown;
    try {
      [ret, data] = await session.quoteCtx!.get_market_snapshot(codes);
    } catch (exc) {
      throw new BrokerError(`获取富途快照失败:${String((exc as Error).message).slice(0, 200)}`);
    }
    if (ret !== mod.RET_OK) throw new BrokerError(quoteError(String(data)));
    const out: Record<string, Row> = {};
    for (const row of rowsOf(data)) out[String(fieldOf(row, "code") ?? "")] = row;
    return out;
  }

  /** 富途 OpenAPI 不支持美股指数——不是权限,是能力缺口。判断必须前置。 */
  quoteCapability(symbol: string): string | null {
    if (this.settings.indexConfig(symbol) !== null) {
      return (
        `富途 OpenAPI 不支持美股指数(${symbol}):快照、订阅、K 线三条路都会回` +
        "「暂不支持美股指数」。改用对应的 ETF 自己重下(SPX→SPY、NDX→QQQ、" +
        "RUT→IWM、VIX→VIXY),或把券商接入切回 IBKR。" +
        "**本软件不会替你换标的**——ETF 和指数的点数、乘数、行权规则都不一样。"
      );
    }
    return null;
  }

  /** 给触发价复核与快照用。取不到就回 null。 */
  async indexPrice(symbol: string): Promise<number | null> {
    if (!this.sessions().length) return null;
    const reason = this.quoteCapability(symbol);
    if (reason) {
      // 每个标的只吼一次:盯盘循环几秒一轮,每轮都打会把日志淹掉
      if (!this.unquotable.has(symbol)) {
        this.unquotable.add(symbol);
        logStderr(`[futu] ${reason}`);
      }
      return null;
    }
    let rows: Record<string, Row>;
    let code: string;
    try {
      code = await this.code(symbol);
      rows = await this.snapshot([code]);
    } catch (exc) {
      if (exc instanceof BrokerError) return null;
      throw exc;
    }
    const row = rows[code];
    if (!row) return null;
    for (const key of ["last_price", "cur_price", "prev_close_price"]) {
      const value = cleanPrice(fieldOf(row, key));
      if (value !== null) return value;
    }
    return null;
  }

  /** 批量报价,「板块关注」页用;绝不用于订单定价。 */
  async stockQuotes(symbols: string[]): Promise<Record<string, Record<string, number | null>>> {
    if (!symbols.length || !this.sessions().length) return {};
    const codes: Record<string, string> = {};
    for (const symbol of symbols) {
      if (this.quoteCapability(symbol)) continue; // 指数直接跳,别白跑一次必然失败的请求
      try {
        codes[symbol] = await this.code(symbol);
      } catch (exc) {
        if (exc instanceof BrokerError) continue;
        throw exc;
      }
    }
    let rows: Record<string, Row>;
    try {
      rows = await this.snapshot(Object.values(codes));
    } catch (exc) {
      if (exc instanceof BrokerError) {
        const out: Record<string, Record<string, number | null>> = {};
        for (const s of Object.keys(codes)) out[s] = { last: null, close: null, change_pct: null };
        return out;
      }
      throw exc;
    }
    const out: Record<string, Record<string, number | null>> = {};
    for (const symbol of symbols) {
      if (!(symbol in codes)) continue; // 指数干脆不出现,而不是给一行全 null
      const row = rows[codes[symbol]!] ?? {};
      const last = cleanPrice(fieldOf(row, "last_price", "cur_price"));
      const close = cleanPrice(fieldOf(row, "prev_close_price", "last_close"));
      const change = last && close ? pyRound(((last - close) / close) * 100.0, 2) : null;
      out[symbol] = { last, close, change_pct: change };
    }
    return out;
  }

  /** 常驻订阅 + 每次只读当前值(顶栏宏观带用)。 */
  async streamQuotes(symbols: string[]): Promise<Record<string, Record<string, unknown>>> {
    if (!symbols.length || !this.sessions().length) return {};
    const session = this.marketSession();
    const mod = await this.bridge();

    const codes: Record<string, string> = {};
    for (const symbol of symbols) {
      if (this.quoteCapability(symbol)) continue; // 指数交给公开源兜底
      try {
        codes[symbol] = await this.code(symbol);
      } catch (exc) {
        if (exc instanceof BrokerError) continue;
        throw exc;
      }
    }
    if (!Object.keys(codes).length) return {};
    try {
      await this.subscribe(session, Object.values(codes), "QUOTE");
    } catch (exc) {
      if (exc instanceof BrokerError) return {}; // 没权限/没额度 → 公开源兜底
      throw exc;
    }
    for (const c of Object.values(codes)) this.streams.add(c);

    let ret: unknown;
    let data: unknown;
    try {
      [ret, data] = await session.quoteCtx!.get_stock_quote(Object.values(codes));
    } catch {
      return {};
    }
    if (ret !== mod.RET_OK) return {};

    const rows: Record<string, Row> = {};
    for (const r of rowsOf(data)) rows[String(fieldOf(r, "code") ?? "")] = r;
    const out: Record<string, Record<string, unknown>> = {};
    for (const [symbol, code] of Object.entries(codes)) {
      const row = rows[code];
      if (!row) continue;
      const last = cleanPrice(fieldOf(row, "last_price", "cur_price"));
      const close = cleanPrice(fieldOf(row, "prev_close_price", "last_close"));
      if (last === null) continue; // 没数据 → 公开源兜底
      const change = close ? pyRound(((last - close) / close) * 100.0, 2) : null;
      out[symbol] = { last, close, change_pct: change };
    }
    return out;
  }

  /** 组合各腿的盘口(AUTO_MID 定价用)。真正的拒绝发生在 place() 里。
   * 没有"纸面账户退延迟盘口"这条后路:富途没有全局降级开关,拿不到就拒。 */
  async legQuotes(contract: ContractSpec, account: AccountConfig): Promise<LegQuote[]> {
    const session = await this.forAccount(account);
    const codes: string[] = [];
    const legs = [...(contract.legs ?? [])];
    for (const leg of legs) {
      codes.push(
        await this.optionCode(
          contract.symbol, leg.lastTradeDateOrContractMonth, leg.strike, leg.right,
        ),
      );
    }
    const quotes: LegQuote[] = [];
    try {
      await this.subscribe(session, codes, "ORDER_BOOK");
      for (let i = 0; i < legs.length; i++) {
        const [bid, ask] = await this.topOfBook(session, codes[i]!);
        quotes.push({
          action: legs[i]!.action,
          ratio: legs[i]!.ratio,
          bid: finiteQuote(bid),
          ask: finiteQuote(ask),
        });
      }
    } finally {
      await this.unsubscribe(session, codes, "ORDER_BOOK");
    }
    return quotes;
  }

  private async topOfBook(session: FutuSession, code: string): Promise<[number, number]> {
    const mod = await this.bridge();
    let ret: unknown;
    let data: unknown;
    try {
      [ret, data] = await session.quoteCtx!.get_order_book(code, 1);
    } catch {
      return [0.0, 0.0];
    }
    if (ret !== mod.RET_OK || data === null || typeof data !== "object") return [0.0, 0.0];
    const book = data as Row;
    return [levelPrice(book["Bid"]), levelPrice(book["Ask"])];
  }

  /** 一档盘口 + 深度(取决于行情等级)。只读展示。 */
  async orderBook(symbol: string, rows = 10): Promise<Record<string, any>> {
    const session = this.marketSession();
    const mod = await this.bridge();
    if (this.settings.indexConfig(symbol) !== null) {
      throw new BrokerError("指数本身没有订单簿(不是可交易合约),请查对应 ETF(如 SPY)或成分股。");
    }
    const code = await this.code(symbol);
    const out: Record<string, any> = { symbol, l1: {}, bids: [], asks: [], note: "" };
    try {
      await this.subscribe(session, [code], "ORDER_BOOK");
      const [ret, data] = await session.quoteCtx!.get_order_book(
        code, Math.max(1, Math.min(Math.trunc(rows), 10)),
      );
      if (ret !== mod.RET_OK) throw new BrokerError(quoteError(String(data)));
      const book = (data !== null && typeof data === "object" ? data : {}) as Row;
      out["bids"] = levels(book["Bid"]);
      out["asks"] = levels(book["Ask"]);
    } finally {
      await this.unsubscribe(session, [code], "ORDER_BOOK");
    }

    const bid = out["bids"].length ? out["bids"][0]["price"] : null;
    const ask = out["asks"].length ? out["asks"][0]["price"] : null;
    const l1: Record<string, any> = {
      bid,
      ask,
      bid_size: out["bids"].length ? out["bids"][0]["size"] : null,
      ask_size: out["asks"].length ? out["asks"][0]["size"] : null,
      last: null,
    };
    try {
      const snap = (await this.snapshot([code]))[code] ?? {};
      l1["last"] =
        cleanPrice(fieldOf(snap, "last_price", "cur_price")) ??
        cleanPrice(fieldOf(snap, "prev_close_price"));
    } catch (exc) {
      if (!(exc instanceof BrokerError)) throw exc;
    }
    if (bid && ask && ask >= bid) {
      const mid = (bid + ask) / 2.0;
      l1["spread"] = pyRound(ask - bid, 4);
      l1["spread_bps"] = mid ? pyRound(((ask - bid) / mid) * 10_000, 1) : null;
    }
    out["l1"] = l1;
    if (out["bids"].length <= 1 && out["asks"].length <= 1) {
      out["note"] = "只收到一档:富途的多档深度需要 LV2 行情权限。上方为一档盘口。";
    }
    out["liquidity"] = bookLiquidity(out);
    return out;
  }

  // ---- K 线 -----------------------------------------------------------
  /** 分页拉历史 K 线。end=null 表示取到最新。 */
  private async history(
    code: string, ktype: string, start: string, end: string | null, extended: boolean,
  ): Promise<Row[]> {
    const mod = await this.bridge();
    const session = this.marketSession();
    const collected: Row[] = [];
    let pageKey: unknown = null;
    for (let i = 0; i < 20; i++) { // 上限兜底:20 页 × 1000 根足够任何周期
      let ret: unknown;
      let data: unknown;
      try {
        [ret, data, pageKey] = await session.quoteCtx!.request_history_kline({
          code, start, end,
          ktype: mod.KLType[ktype]!,
          autype: mod.AuType.QFQ,
          max_count: FutuRouter.PAGE,
          page_req_key: pageKey,
          extended_time: extended,
        });
      } catch (exc) {
        throw new BrokerError(
          `获取 ${code} 历史 K 线失败:${String((exc as Error).message).slice(0, 200)}`,
        );
      }
      if (ret !== mod.RET_OK) throw new BrokerError(quoteError(String(data)));
      collected.push(...rowsOf(data));
      if (!pageKey) break;
    }
    return collected;
  }

  async historicalBars(symbol: string, start: string, end: string): Promise<Array<Record<string, any>>> {
    if (!this.sessions().length) {
      throw new BrokerError("引擎未连接富途 OpenD,无法获取历史数据。请先在「富途 OpenD」面板连接引擎。");
    }
    const reason = this.quoteCapability(symbol);
    if (reason) throw new BrokerError(reason);
    const code = await this.code(symbol);
    const raw = await this.history(code, "K_DAY", start, end, false);

    const bars: Array<Record<string, any>> = [];
    for (const row of raw) {
      const day = String(fieldOf(row, "time_key", "time") ?? "").slice(0, 10);
      if (!(start <= day && day <= end)) continue;
      const values = ohlc(row);
      if (values === null) continue;
      bars.push({ date: day, ...values });
    }
    bars.sort((a, b) => String(a["date"]).localeCompare(String(b["date"])));
    if (!bars.length) {
      throw new BrokerError(
        `${symbol} 在 ${start} ~ ${end} 内没有历史数据(标的代码是否正确?区间是否全是休市日?` +
        "富途的历史 K 线额度是否已用完?)",
      );
    }
    return bars;
  }

  async intradayBars(symbol: string, timeframe: string, rth = false): Promise<Array<Record<string, any>>> {
    const spec = TIMEFRAMES[timeframe];
    if (spec === undefined) {
      throw new BrokerError(`未知 K 线周期:${timeframe}(可选:${Object.keys(TIMEFRAMES).join("、")})`);
    }
    const ktype = KLTYPE[timeframe];
    if (ktype === undefined) {
      throw new BrokerError(
        `富途不提供 ${spec["label"]} 周期的 K 线(它的最小档位是 1 分钟,往上是 5 / 15 / 30 / 60 分钟与日线)。` +
        "用 1m 或 5m 代替,或把券商接入切回 IBKR。",
      );
    }
    if (!this.sessions().length) {
      throw new BrokerError("引擎未连接富途 OpenD,无法获取 K 线。请先在「富途 OpenD」面板连接引擎。");
    }
    const reason = this.quoteCapability(symbol);
    if (reason) throw new BrokerError(reason);

    const code = await this.code(symbol);
    const daily = timeframe === "1d";
    // 只给下界,不给上界:上界写"本机今天"会在时区两侧各错一次
    const todayOrd = Math.floor(Date.now() / 86_400_000);
    const span = durationDays(spec);
    const startIso = (days: number): string =>
      new Date((todayOrd - days) * 86_400_000).toISOString().slice(0, 10);
    let raw = await this.history(code, ktype, startIso(span), null, !rth);
    if (raw.length < MIN_BARS) {
      raw = (await this.history(code, ktype, startIso(span * 2), null, !rth)) ?? raw;
    }

    let bars: Array<Record<string, any>> = [];
    for (const row of raw) {
      const values = ohlc(row);
      if (values === null) continue;
      bars.push({
        time: barTime(fieldOf(row, "time_key", "time"), daily),
        ...values,
        volume: Math.max(toFloat(fieldOf(row, "volume")) ?? 0.0, 0.0),
      });
    }
    bars.sort((a, b) => String(a["time"]).localeCompare(String(b["time"])));
    bars = bars.slice(-1000);
    if (!bars.length) {
      throw new BrokerError(
        `${symbol} 没有返回 ${spec["label"]} K 线(标的代码是否正确?是否刚好整段休市?` +
        "富途的历史 K 线额度是否已用完?)",
      );
    }
    return bars;
  }

  // ---- 期权链(只读,不进下单链路)---------------------------------------
  async optionExpiries(symbol: string): Promise<Record<string, any>> {
    // 刻意不过 quoteCapability:指数的期权链是支持的(实测回权限错误而非「暂不支持」),
    // 指数缺的只是现价,由 optionChain 用平价关系反推。
    const mod = await this.bridge();
    const session = this.marketSession();
    const code = await this.code(symbol);
    let ret: unknown;
    let data: unknown;
    try {
      [ret, data] = await session.quoteCtx!.get_option_expiration_date(code);
    } catch (exc) {
      throw new BrokerError(
        `获取 ${symbol} 的期权到期日失败:${String((exc as Error).message).slice(0, 200)}`,
      );
    }
    if (ret !== mod.RET_OK) {
      throw new BrokerError(`${symbol}:${quoteError(String(data))}`);
    }
    const expiries = [
      ...new Set(
        rowsOf(data)
          .map((row) => plainDate(String(fieldOf(row, "strike_time", "option_expiry_date") ?? "")))
          .filter(Boolean),
      ),
    ].sort();
    if (!expiries.length) throw new BrokerError(`${symbol} 没有可用的到期日`);
    return { symbol, expiries, strikes: [], exchange: "FUTU" };
  }

  async optionChain(symbol: string, expiry: string | null = null, width = 10): Promise<Record<string, any>> {
    width = Math.max(3, Math.min(Math.trunc(width), FutuRouter.CHAIN_MAX_WIDTH));
    const mod = await this.bridge();
    const session = this.marketSession();
    const meta = await this.optionExpiries(symbol);
    const targetExpiry = expiry ?? meta["expiries"][0];
    if (!meta["expiries"].includes(targetExpiry)) {
      throw new BrokerError(
        `${symbol} 没有 ${targetExpiry} 这个到期日。最近的几个:` +
        meta["expiries"].slice(0, 5).join("、"),
      );
    }

    const day = futuDate(targetExpiry);
    let ret: unknown;
    let data: unknown;
    try {
      [ret, data] = await session.quoteCtx!.get_option_chain({
        code: await this.code(symbol), start: day, end: day,
      });
    } catch (exc) {
      throw new BrokerError(
        `获取 ${symbol} 的期权链失败:${String((exc as Error).message).slice(0, 200)}`,
      );
    }
    if (ret !== mod.RET_OK) throw new BrokerError(quoteError(String(data)));

    const byStrike = new Map<number, Row[]>();
    for (const row of rowsOf(data)) {
      const strike = toFloat(fieldOf(row, "strike_price", "option_strike_price"));
      const code = String(fieldOf(row, "code") ?? "");
      if (strike === null || !code) continue;
      const k = pyRound(strike, 4);
      if (!byStrike.has(k)) byStrike.set(k, []);
      byStrike.get(k)!.push(row);
    }
    if (!byStrike.size) throw new BrokerError(`${symbol} ${targetExpiry} 这条链没有任何合约`);

    // 现价:能直接问就直接问;富途拿不到的(指数)从这条链自己反推。
    let spot = await this.indexPrice(symbol);
    let spotSource = "quote";
    if (!spot) {
      spot = await this.paritySpot(symbol, byStrike);
      spotSource = "parity";
    }

    const strikes = [...byStrike.keys()].sort((a, b) => a - b);
    let nearest = 0;
    for (let i = 1; i < strikes.length; i++) {
      if (Math.abs(strikes[i]! - spot) < Math.abs(strikes[nearest]! - spot)) nearest = i;
    }
    const band = strikes.slice(Math.max(0, nearest - width), nearest + width + 1);
    const codes: string[] = [];
    for (const k of band) for (const r of byStrike.get(k)!) codes.push(String(fieldOf(r, "code")));

    const snap = await this.snapshot(codes);
    const rows: Array<Record<string, any>> = [];
    for (const strike of band) {
      for (const entry of byStrike.get(strike)!) {
        const code = String(fieldOf(entry, "code") ?? "");
        const row = snap[code] ?? {};
        const right = rightOf(entry, row);
        rows.push({
          strike,
          right,
          oi: toFloat(fieldOf(row, "option_open_interest", "open_interest")) ?? 0.0,
          volume: toFloat(fieldOf(row, "volume")) ?? 0.0,
          gamma: toFloat(fieldOf(row, "option_gamma", "gamma")),
          iv: ivOf(row),
        });
      }
    }
    return {
      symbol,
      expiry: targetExpiry,
      spot,
      // 界面要能看出这个现价是问来的还是算出来的
      spot_source: spotSource,
      expiries: meta["expiries"].slice(0, 20),
      rows,
      multiplier: 100.0,
      strike_count: band.length,
    };
  }

  /** put-call parity 反推现价:在整条行权价网格上均匀取样,一次快照,线性拟合。 */
  private async paritySpot(symbol: string, byStrike: Map<number, Row[]>): Promise<number> {
    const strikes = [...byStrike.keys()].sort((a, b) => a - b);
    if (strikes.length < PARITY_MIN_POINTS) {
      throw new BrokerError(`${symbol} 这条链只有 ${strikes.length} 个行权价,不够反推现价。`);
    }
    const step = Math.max(1, Math.trunc(strikes.length / FutuRouter.PARITY_SAMPLES));
    const sampled: number[] = [];
    for (let i = 0; i < strikes.length && sampled.length < FutuRouter.PARITY_SAMPLES; i += step) {
      sampled.push(strikes[i]!);
    }

    const codes = new Map<string, [number, string]>();
    for (const strike of sampled) {
      for (const entry of byStrike.get(strike)!) {
        const code = String(fieldOf(entry, "code") ?? "");
        if (code) codes.set(code, [strike, rightOf(entry, {})]);
      }
    }
    const snap = await this.snapshot([...codes.keys()]);

    const legs = new Map<number, Record<string, number>>();
    for (const [code, [strike, right]] of codes) {
      const price = optionMid(snap[code] ?? {});
      if (price !== null) {
        if (!legs.has(strike)) legs.set(strike, {});
        legs.get(strike)![right] = price;
      }
    }
    const pairs: Array<[number, number, number]> = [];
    for (const [strike, sides] of legs) {
      if ("C" in sides && "P" in sides) pairs.push([strike, sides["C"]!, sides["P"]!]);
    }
    const result = impliedSpot(pairs);
    logStderr(
      `[futu] ${symbol} 的现价由期权链反推得出:${fmtF(result["spot"]!, 4)}` +
      `(折现因子 ${fmtF(result["discount"]!, 6)},最大残差 ${fmtF(result["residual"]!, 4)},` +
      `${result["samples"]} 个取样)`,
    );
    return result["spot"]!;
  }

  // ---- 交易解锁 --------------------------------------------------------
  /** 实盘交易解锁。密码(的 md5)只从 Keychain / DPAPI 读,不落任何日志。 */
  async unlock(connectionName: string | null = null): Promise<Record<string, unknown>> {
    const futuCfg = this.settings.broker.futu;
    const names = connectionName ? [connectionName] : Object.keys(this.connections);
    let secret: string | null;
    try {
      secret = this.secretReader(futuCfg.keychain_service, futuCfg.keychain_account);
    } catch (exc) {
      if (exc instanceof KeychainError) {
        throw new BrokerError(`读取交易解锁密码失败:${exc.message}`);
      }
      throw exc;
    }
    if (!secret) {
      throw new BrokerError(
        `没有存交易解锁密码(service=${futuCfg.keychain_service}, account=${futuCfg.keychain_account})。` +
        "请在「富途 OpenD」面板里填写并保存;不解锁只能下模拟盘。",
      );
    }
    const mod = await this.bridge();
    const unlocked: string[] = [];
    const failed: Record<string, string> = {};
    for (const name of names) {
      let session: FutuSession;
      try {
        session = await this.connect(name);
      } catch (exc) {
        if (exc instanceof BrokerError) {
          failed[name] = exc.message;
          continue;
        }
        throw exc;
      }
      let ret: unknown;
      let data: unknown;
      try {
        [ret, data] = await session.tradeCtx!.unlock_trade(secret);
      } catch (exc) {
        failed[name] = String((exc as Error).message).slice(0, 200);
        continue;
      }
      if (ret !== mod.RET_OK) {
        // 只回富途的原文,绝不回显任何与密码有关的内容
        failed[name] = String(data).slice(0, 200);
        continue;
      }
      session.unlocked = true;
      unlocked.push(name);
    }
    return { unlocked, failed };
  }

  // ---- 持仓 -----------------------------------------------------------
  /** 富途的 position_list_query 直接给市值和盈亏(pl_val)——对账以券商报的为准。 */
  async positions(): Promise<Array<Record<string, any>>> {
    const mod = await this.bridge();
    const rows: Array<Record<string, any>> = [];
    for (const session of this.sessions()) {
      for (const account of this.settings.accounts) {
        if (!session.accounts.includes(account.account_id)) continue;
        const env = account.is_paper ? mod.TrdEnv.SIMULATE : mod.TrdEnv.REAL;
        let ret: unknown;
        let data: unknown;
        try {
          [ret, data] = await session.tradeCtx!.position_list_query({
            trd_env: env, acc_id: accId(account.account_id), refresh_cache: true,
          });
        } catch (exc) {
          logStderr(`[futu] 读持仓失败:${String((exc as Error).message).slice(0, 200)}`);
          continue;
        }
        if (ret !== mod.RET_OK) {
          logStderr(`[futu] 读持仓失败:${String(data).slice(0, 200)}`);
          continue;
        }
        for (const row of rowsOf(data)) {
          const parsed = positionRow(row, account.alias);
          if (parsed) rows.push(parsed);
        }
      }
    }
    return rows.sort((a, b) =>
      String(a["account"]).localeCompare(String(b["account"])) ||
      String(a["symbol"]).localeCompare(String(b["symbol"])),
    );
  }

  // ---- 下单 -----------------------------------------------------------
  async place(
    recordId: string, approved: ApprovedOrder, limitOverride: number | null = null,
  ): Promise<PlacementResult> {
    const parsed = approved.order;
    const session = await this.forAccount(approved.account as AccountConfig);
    const code = await this.contractCode(parsed.contract); // BAG 在这里就被拒
    const mod = await this.bridge();

    const wantedEnv = approved.account.is_paper ? "SIMULATE" : "REAL";
    const actualEnv = session.accountEnvs[approved.account.account_id] ?? "";
    if (actualEnv && actualEnv !== wantedEnv) {
      // is_paper 是 allow_live_trading 那道闸的输入:以富途报的为准,不一致直接拒
      throw new BrokerError(
        `账户 ${approved.account.alias} 在配置里写的是「${approved.account.is_paper ? "模拟盘" : "实盘"}」,` +
        `但富途报它是「${actualEnv === "SIMULATE" ? "模拟盘" : "实盘"}」。` +
        "is_paper 决定要不要过实盘闸门,写反了等于把保护关掉——已拒绝下单。" +
        "请改 config/settings.json 里这个账户的 is_paper。",
      );
    }
    if (!approved.account.is_paper && !session.unlocked) {
      throw new BrokerError(
        "实盘账户尚未做交易解锁,拒绝下单。请在「富途 OpenD」面板点「交易解锁」" +
        "(解锁状态跟着 OpenD 会话走,重启 OpenD 后要重新解锁)。",
      );
    }

    const spec = parsed.order;
    const limit = limitOverride !== null ? limitOverride : spec.lmtPrice;
    const kwargs = orderKwargs(mod, spec, limit);
    let ret: unknown;
    let data: unknown;
    try {
      [ret, data] = await session.tradeCtx!.place_order({
        code,
        qty: spec.totalQuantity,
        trd_side: spec.action === "BUY" ? mod.TrdSide.BUY : mod.TrdSide.SELL,
        trd_env: approved.account.is_paper ? mod.TrdEnv.SIMULATE : mod.TrdEnv.REAL,
        acc_id: accId(approved.account.account_id),
        // 幂等标识:回报、对账、去重都能凭 remark 找回这条记录
        remark: recordId.slice(0, 64),
        time_in_force: spec.tif === "GTC" ? mod.TimeInForce.GTC : mod.TimeInForce.DAY,
        fill_outside_rth: Boolean(spec.outsideRth),
        ...kwargs,
      });
    } catch (exc) {
      throw new BrokerError(`富途下单失败:${String((exc as Error).message).slice(0, 300)}`);
    }
    if (ret !== mod.RET_OK) {
      throw new BrokerError(`富途拒绝了这笔订单:${String(data).slice(0, 300)}`);
    }

    const rows = rowsOf(data);
    const futuOrderId = rows.length ? String(fieldOf(rows[0]!, "order_id") ?? "") : "";
    if (!futuOrderId) {
      throw new BrokerError(
        "富途没有回订单号,无法跟踪这笔订单的状态。请立刻在富途客户端里核对是否已经挂单。",
      );
    }

    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.orders.set(handle, {
      record_id: recordId,
      futu_order_id: futuOrderId,
      connection: session.name,
      account_id: approved.account.account_id,
      is_paper: approved.account.is_paper,
      symbol: parsed.contract.symbol,
      status: "",
      dealt: 0.0,
    });
    return {
      record_id: recordId,
      order_id: handle,
      perm_id: handle,
      status: ORDER_STATUS[String(fieldOf(rows[0]!, "order_status") ?? "").toUpperCase()] ?? "Submitted",
      limit_price: limit,
      detail: {
        account: approved.account.account_id, futu_order_id: futuOrderId, broker: "futu", code,
      },
    };
  }

  // ---- 回报(拉取式)----------------------------------------------------
  /** 拉一次订单与成交。富途没有事件流,返回的对象和 ib_insync 同形,
   * engine 里那套现成的入库逻辑原样吃下去。按 (连接, 账户, 环境) 分组查。 */
  async pollOrderUpdates(): Promise<ReportEvent[]> {
    if (!this.orders.size) return [];
    const mod = await this.bridge();
    const events: ReportEvent[] = [];
    for (const session of this.sessions()) {
      for (const [key, tracked] of this.trackedByAccount(session)) {
        const [accountId, isPaper] = key;
        const env = isPaper ? mod.TrdEnv.SIMULATE : mod.TrdEnv.REAL;
        // 顺序有讲究:先问成交、再读订单——成交查询顺带发现"模拟盘不支持",
        // 订单那一轮才知道要不要自己合成。
        events.push(...(await this.pollDeals(mod, session, tracked, env, accountId)));
        events.push(...(await this.pollOrders(mod, session, tracked, env, accountId)));
      }
    }
    return events;
  }

  private trackedByAccount(
    session: FutuSession,
  ): Map<[string, boolean], Map<string, [number, TrackedOrder]>> {
    const grouped = new Map<string, Map<string, [number, TrackedOrder]>>();
    const keys = new Map<string, [string, boolean]>();
    for (const [handle, info] of this.orders) {
      if (info.connection !== session.name) continue;
      const keyStr = `${info.account_id}|${info.is_paper}`;
      keys.set(keyStr, [info.account_id, info.is_paper]);
      if (!grouped.has(keyStr)) grouped.set(keyStr, new Map());
      grouped.get(keyStr)!.set(info.futu_order_id, [handle, info]);
    }
    const out = new Map<[string, boolean], Map<string, [number, TrackedOrder]>>();
    for (const [keyStr, tracked] of grouped) out.set(keys.get(keyStr)!, tracked);
    return out;
  }

  private async pollOrders(
    mod: FutuBridge, session: FutuSession,
    tracked: Map<string, [number, TrackedOrder]>, env: string, accountId: string,
  ): Promise<ReportEvent[]> {
    let ret: unknown;
    let data: unknown;
    try {
      [ret, data] = await session.tradeCtx!.order_list_query({
        trd_env: env, acc_id: accId(accountId), refresh_cache: true,
      });
    } catch (exc) {
      logStderr(`[futu] 拉订单状态失败:${String((exc as Error).message).slice(0, 200)}`);
      return [];
    }
    if (ret !== mod.RET_OK) {
      logStderr(`[futu] 拉订单状态失败:${String(data).slice(0, 200)}`);
      return [];
    }

    const events: ReportEvent[] = [];
    for (const row of rowsOf(data)) {
      const entry = tracked.get(String(fieldOf(row, "order_id") ?? ""));
      if (entry === undefined) continue; // 别人的单(用户在富途客户端里手动下的)
      const [handle, info] = entry;
      const rawStatus = String(fieldOf(row, "order_status") ?? "").toUpperCase();
      const status = ORDER_STATUS[rawStatus] ?? "Submitted";
      const dealt = toFloat(fieldOf(row, "dealt_qty")) ?? 0.0;
      const total = toFloat(fieldOf(row, "qty")) ?? 0.0;
      if (status === info.status && Math.abs(dealt - info.dealt) < 1e-9) continue; // 没变化不重复落库
      const filledDelta = dealt - info.dealt;
      info.status = status;
      info.dealt = dealt;
      if (filledDelta > 1e-9 && this.noDealQuery.has(accountId)) {
        events.push(this.syntheticFill(handle, info, row, filledDelta, accountId));
      }
      events.push([
        "status",
        {
          order: { orderId: handle, permId: handle },
          orderStatus: { status, filled: dealt, remaining: Math.max(total - dealt, 0.0) },
          contract: { symbol: info.symbol },
        },
        null,
      ]);
    }
    return events;
  }

  private async pollDeals(
    mod: FutuBridge, session: FutuSession,
    tracked: Map<string, [number, TrackedOrder]>, env: string, accountId: string,
  ): Promise<ReportEvent[]> {
    if (this.noDealQuery.has(accountId)) return []; // 查不了成交的账户别每轮白跑
    let ret: unknown;
    let data: unknown;
    try {
      [ret, data] = await session.tradeCtx!.deal_list_query({
        trd_env: env, acc_id: accId(accountId), refresh_cache: true,
      });
    } catch (exc) {
      logStderr(`[futu] 拉成交明细失败:${String((exc as Error).message).slice(0, 200)}`);
      return [];
    }
    if (ret !== mod.RET_OK) {
      // 富途的模拟盘不支持成交查询(真机实测)。认出来就不再问,
      // 改从订单行的 dealt_qty / dealt_avg_price 合成成交。
      this.noDealQuery.add(accountId);
      logStderr(
        `[futu] 账户 ${redactForLog(accountId)} 查不到逐笔成交(${String(data).slice(0, 120)}),` +
        "改用订单行的成交均价合成。",
      );
      return [];
    }

    const events: ReportEvent[] = [];
    for (const row of rowsOf(data)) {
      const dealId = String(fieldOf(row, "deal_id") ?? "");
      const entry = tracked.get(String(fieldOf(row, "order_id") ?? ""));
      if (entry === undefined || !dealId || this.seenDeals.has(dealId)) continue;
      const [handle, info] = entry;
      this.seenDeals.add(dealId);
      events.push([
        "fill",
        {
          order: { orderId: handle, permId: handle },
          orderStatus: { status: "Submitted", filled: 0.0, remaining: 0.0 },
          contract: { symbol: info.symbol },
        },
        {
          execution: {
            execId: dealId,
            time: String(fieldOf(row, "create_time", "updated_time") ?? ""),
            price: toFloat(fieldOf(row, "price")) ?? 0.0,
            shares: toFloat(fieldOf(row, "qty")) ?? 0.0,
            side: String(fieldOf(row, "trd_side") ?? ""),
            acctNumber: info.account_id,
          },
        },
      ]);
    }
    return events;
  }

  /** 用订单行的成交均价合成一笔成交(模拟盘专用)。显式带 synthetic 标记,
   * 别拿它当逐笔明细做滑点归因。 */
  private syntheticFill(
    handle: number, info: TrackedOrder, row: Row, shares: number, accountId: string,
  ): ReportEvent {
    info.fill_seq = (info.fill_seq ?? 0) + 1;
    const price =
      toFloat(fieldOf(row, "dealt_avg_price")) ?? toFloat(fieldOf(row, "price")) ?? 0.0;
    return [
      "fill",
      {
        order: { orderId: handle, permId: handle },
        orderStatus: { status: "Submitted", filled: 0.0, remaining: 0.0 },
        contract: { symbol: info.symbol },
      },
      {
        execution: {
          execId: `${info.futu_order_id}#${info.fill_seq}(合成)`,
          time: String(fieldOf(row, "updated_time", "create_time") ?? ""),
          price,
          shares,
          side: String(fieldOf(row, "trd_side") ?? ""),
          acctNumber: accountId,
        },
      },
    ];
  }

  // ---- 熔断 -----------------------------------------------------------
  /** 撤掉**本引擎发出的**全部未成交单(§9.7)。刻意不撤别人的单。 */
  async cancelAllOpen(): Promise<number> {
    const mod = await this.bridge();
    let count = 0;
    let untouched = 0;
    for (const session of this.sessions()) {
      for (const [key, tracked] of this.trackedByAccount(session)) {
        const [accountId, isPaper] = key;
        const env = isPaper ? mod.TrdEnv.SIMULATE : mod.TrdEnv.REAL;
        let ret: unknown;
        let data: unknown;
        try {
          [ret, data] = await session.tradeCtx!.order_list_query({
            trd_env: env, acc_id: accId(accountId), refresh_cache: true,
          });
        } catch (exc) {
          logStderr(`[futu] 熔断时拉挂单失败:${String((exc as Error).message).slice(0, 200)}`);
          continue;
        }
        if (ret !== mod.RET_OK) {
          logStderr(`[futu] 熔断时拉挂单失败:${String(data).slice(0, 200)}`);
          continue;
        }
        for (const row of rowsOf(data)) {
          if (!OPEN_STATUS.has(String(fieldOf(row, "order_status") ?? "").toUpperCase())) continue;
          const orderId = String(fieldOf(row, "order_id") ?? "");
          if (!tracked.has(orderId)) {
            untouched += 1;
            continue;
          }
          let ok: unknown;
          let detail: unknown;
          try {
            [ok, detail] = await session.tradeCtx!.modify_order(
              mod.ModifyOrderOp.CANCEL, orderId, 0, 0,
              { trd_env: env, acc_id: accId(accountId) },
            );
          } catch (exc) {
            logStderr(`[futu] 撤单失败(${orderId}):${String((exc as Error).message).slice(0, 120)}`);
            continue;
          }
          if (ok === mod.RET_OK) count += 1;
          else logStderr(`[futu] 撤单被拒(${orderId}):${String(detail).slice(0, 120)}`);
        }
      }
    }
    if (untouched) {
      logStderr(
        `[futu] 熔断只撤了本软件发出的单;账户里还有 ${untouched} 笔来自其他渠道的挂单没动。`,
      );
    }
    return count;
  }
}

// ======================================================================
// 模块级助手
// ======================================================================
/** 把本系统的订单类型翻成富途 place_order 的参数。价格为空的限价单在这里就报错。 */
export function orderKwargs(
  mod: FutuBridge, spec: { orderType: string; auxPrice: number | null; trailingPercent: number | null },
  limit: number | null,
): Record<string, unknown> {
  if (spec.orderType === "MKT") return { order_type: mod.OrderType.MARKET, price: 0.0 };
  if (spec.orderType === "LMT") {
    if (limit === null) throw new BrokerError("限价单缺少限价(AUTO_MID 未定价?),拒绝下单");
    return { order_type: mod.OrderType.NORMAL, price: limit };
  }
  if (spec.orderType === "STP") {
    return { order_type: mod.OrderType.STOP, price: 0.0, aux_price: Number(spec.auxPrice) };
  }
  if (spec.orderType === "STP LMT") {
    if (limit === null) throw new BrokerError("止损限价单缺少限价,拒绝下单");
    return {
      order_type: mod.OrderType.STOP_LIMIT, price: limit, aux_price: Number(spec.auxPrice),
    };
  }
  if (spec.orderType === "TRAIL") {
    if (spec.trailingPercent !== null) {
      return {
        order_type: mod.OrderType.TRAILING_STOP, price: 0.0,
        trail_type: mod.TrailType.RATIO, trail_value: spec.trailingPercent,
      };
    }
    return {
      order_type: mod.OrderType.TRAILING_STOP, price: 0.0,
      trail_type: mod.TrailType.AMOUNT, trail_value: Number(spec.auxPrice),
    };
  }
  throw new BrokerError(`不支持的订单类型:${spec.orderType}`);
}

/** 富途的账号是数字。转不动就明说是配置写错了。 */
export function accId(accountId: string): number {
  const text = String(accountId).trim();
  if (!/^\d+$/.test(text)) {
    throw new BrokerError(
      `富途账号必须是数字,配置里写的是 ${redactForLog(text)}。` +
      "IBKR 的 U/DU 开头账号不能用在富途连接上。",
    );
  }
  return parseInt(text, 10);
}

/** 富途盘口的一档是 (price, volume, order_num[, detail]) 元组。 */
export function levelPrice(rawLevels: unknown): number {
  if (!Array.isArray(rawLevels) || !rawLevels.length) return 0.0;
  const first = rawLevels[0];
  if (Array.isArray(first)) {
    const v = Number(first[0]);
    return Number.isFinite(v) ? v : 0.0;
  }
  return 0.0;
}

export function levels(rawLevels: unknown): Array<{ price: number; size: number }> {
  const out: Array<{ price: number; size: number }> = [];
  for (const level of Array.isArray(rawLevels) ? rawLevels : []) {
    if (!Array.isArray(level)) continue;
    const price = Number(level[0]);
    const size = Number(level[1]);
    if (!Number.isFinite(price) || !Number.isFinite(size)) continue;
    if (price > 0) out.push({ price, size });
  }
  return out;
}

export function ohlc(row: Row): Record<string, number> | null {
  const values: Record<string, number> = {};
  for (const key of ["open", "high", "low", "close"]) {
    const value = toFloat(fieldOf(row, key));
    if (value === null) return null;
    values[key] = value;
  }
  return values;
}

/** 一份期权快照 → 可用于平价拟合的价格。优先盘口中间价。 */
export function optionMid(row: Row): number | null {
  const bid = toFloat(fieldOf(row, "bid_price"));
  const ask = toFloat(fieldOf(row, "ask_price"));
  if (bid && ask && bid > 0 && ask >= bid) return (bid + ask) / 2.0;
  const last = toFloat(fieldOf(row, "last_price", "cur_price"));
  return last && last > 0 ? last : null;
}

/** CALL/PUT → C/P。链和快照都可能带这个字段,谁有用谁。 */
export function rightOf(chainRow: Row, snapRow: Row): string {
  const raw = String(
    fieldOf(chainRow, "option_type") ?? fieldOf(snapRow, "option_type") ?? "",
  ).toUpperCase();
  return raw.includes("PUT") ? "P" : "C";
}

/** 隐含波动率归一到小数(IBKR 口径)。富途给的是百分数。 */
export function ivOf(row: Row): number | null {
  const value = toFloat(fieldOf(row, "option_implied_volatility", "implied_volatility"));
  if (value === null || value <= 0) return null;
  return value > 3.0 ? pyRound(value / 100.0, 6) : value;
}

/** 把富途的取数报错翻成"下一步该做什么"。 */
export function quoteError(text: string): string {
  const lowered = text.toLowerCase();
  if (text.includes("权限") || lowered.includes("permission") || lowered.includes("no right")) {
    if (text.includes("期权") || lowered.includes("option")) {
      return (
        "富途返回「没有美股期权行情权限」。这份权限和股票行情是**分开**的:" +
        "股票报价能用不代表期权能用,而且没有它连期权链的到期日都取不到。" +
        "请在富途 / moomoo 客户端里开通「美股期权行情」,开通后重连引擎即可。" +
        `原始报错:${text.slice(0, 200)}`
      );
    }
    return (
      "富途返回「没有行情权限」。美股行情要在富途/moomoo 客户端里单独开通" +
      `(LV1 基础报价即可满足报价与 K 线;多档盘口需要 LV2)。原始报错:${text.slice(0, 200)}`
    );
  }
  if (text.includes("额度") || lowered.includes("quota") || lowered.includes("limit")) {
    return (
      "富途返回「额度不足」。它的历史 K 线和行情订阅都是按额度计的:" +
      "历史 K 线按标的数计费,订阅按条数计。等额度恢复,或减少同时关注的标的。" +
      `原始报错:${text.slice(0, 200)}`
    );
  }
  return `富途取数失败:${text.slice(0, 300)}`;
}

function positionRow(row: Row, alias: string): Record<string, any> | null {
  const code = String(fieldOf(row, "code") ?? "");
  const symbol = code.split(".").pop() ?? "";
  let qty = toFloat(fieldOf(row, "qty")) ?? 0.0;
  if (!symbol || !qty) return null;
  // 富途用 position_side 表示多空,qty 本身是正的
  const side = String(fieldOf(row, "position_side") ?? "LONG").toUpperCase();
  if (side.startsWith("SHORT")) qty = -qty;
  return {
    key: `${alias}|${symbol}|STK`,
    account: alias,
    symbol,
    sec_type: "STK",
    leg: "",
    label: symbol,
    quantity: qty,
    multiplier: 1.0,
    currency: "USD",
    avg_cost: toFloat(fieldOf(row, "cost_price")) ?? 0.0,
    market_price: toFloat(fieldOf(row, "nominal_price")),
    market_value: toFloat(fieldOf(row, "market_val")),
    unrealized_pnl: toFloat(fieldOf(row, "pl_val")),
    contract: { secType: "STK", symbol, exchange: "SMART", currency: "USD" },
  };
}

function pyStrike(strike: number): string {
  return Number.isInteger(strike) ? `${strike}.0` : String(strike);
}

async function safeClose(ctx: { close(): void | Promise<void> } | null): Promise<void> {
  if (!ctx) return;
  try {
    await ctx.close();
  } catch {
    /* ignore */
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
