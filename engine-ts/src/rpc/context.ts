/** 各域 handler 看到的上下文,与它们共同的基类。
 *
 * handler 只认这个接口,不 import server.ts——server 引 handler,handler 再引 server 就是环。
 * handler 之间也不互相 import:两个域都要的东西下沉到 services/(带状态)或 params.ts(纯函数)。
 */
import type { LLMConfig, Settings } from "../config.js";
import type { AccountView } from "../contract/settings.js";
import type { TradingEngine } from "../engine.js";
import type { RpcError } from "../rpcError.js";
import type { AlertsService } from "../services/alerts.js";
import type { AnomalyService } from "../services/anomaly.js";
import { gatewayName, needConnection } from "../services/host.js";
import type { Rec, Router, ServiceHost } from "../services/host.js";
import type { MarketDataService } from "../services/marketData.js";
import type { PoolService } from "../services/pool.js";
import type { StockTripsService } from "../services/stockTrips.js";
import type { SimilarContextService } from "../services/similarContext.js";
import type { TradeHistoryService } from "../services/tradeHistory.js";
import { redactAccount } from "../store.js";

export type { Rec } from "../services/host.js";

export const PROTOCOL_VERSION = "1.0";

/** 一个域交出来的方法表:"tracker.add" → 处理函数。server 把各域的表合成一张。 */
export type MethodTable = Record<string, (params: Rec) => Promise<Rec> | Rec>;

export interface RpcContext extends ServiceHost {
  /** 配置重载 / 切券商时整份换掉。 */
  settings: Settings;
  /** 连接 / 断开时换掉;换完要 dropEngine,让引擎带上新的 router 重建。 */
  router: Router | null;
  /** 已经建好的引擎;还没人用过就是 null。只想看一眼心跳、不想因此把引擎建起来时用它。 */
  readonly engineBuilt: TradingEngine | null;
  /** 测试可注入的解析器工厂。 */
  parserFactory: (cfg: LLMConfig) => any;
  /** 配置变了就整体重建:限额、别名表都会进提示词,必须一起换掉。 */
  reload(): void;
  /** 丢掉当前引擎(先停它的节拍器),下次用到时重建。 */
  dropEngine(): void;
  /** 追踪相关操作的共享锁:每一轮盯盘、建 / 改 / 删追踪、立即平仓、熔断排成一队。 */
  trackerLock<T>(fn: () => Promise<T>): Promise<T>;

  readonly market: MarketDataService;
  readonly alerts: AlertsService;
  readonly anomaly: AnomalyService;
  readonly pool: PoolService;
  readonly stockTrips: StockTripsService;
  readonly tradeHistory: TradeHistoryService;
  readonly similarContext: SimilarContextService;
}

/** handler 的基类:把上下文里最常用的几样摊成 this.settings / this.router / this.engine,
 *  从 rpc.ts 搬过来的方法体一个字不用改。要**换掉** settings / router 的地方显式写 this.ctx.xxx = …。 */
export abstract class HandlerBase {
  constructor(protected readonly ctx: RpcContext) {}

  abstract methods(): MethodTable;

  protected get settings(): Settings {
    return this.ctx.settings;
  }

  protected get router(): Router | null {
    return this.ctx.router;
  }

  protected get engine(): TradingEngine {
    return this.ctx.engine;
  }

  protected emit(event: string, payload: Rec): void {
    this.ctx.emit(event, payload);
  }

  protected parserFactory(cfg: LLMConfig): any {
    return this.ctx.parserFactory(cfg);
  }

  protected gateway(): string {
    return gatewayName(this.settings);
  }

  protected needConnection(code: number, what: string): RpcError {
    return needConnection(this.settings, code, what);
  }

  protected accounts(): AccountView[] {
    return this.settings.accounts.map((a) => ({
      alias: a.alias,
      account_masked: redactAccount(a.account_id),
      is_paper: a.is_paper,
      connection: a.connection,
      broker: this.settings.accountBroker(a),
      default: a.default,
    }));
  }
}
