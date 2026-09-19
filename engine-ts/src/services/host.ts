/** services/ 的宿主接口:带状态的编排(行情缓存、价位提醒、异动循环、股票池)向外只要这四样。
 *
 * 配置会重载、券商会重连、引擎会重建——所以 service 手里拿的是宿主,每次用到都现取,
 * 不在构造时把 settings / router / engine 存成自己的字段(存了就是一份会过期的拷贝)。
 * 宿主由 rpc/server.ts 实现;这里不认识 RPC,离线测试可以塞一个假的进来。
 */
import type { BrokerRouter } from "../broker.js";
import type { Settings } from "../config.js";
import type { TradingEngine } from "../engine.js";
import type { FutuRouter } from "../futuBroker.js";
import { RpcError } from "../rpcError.js";

/** 从 rpc.ts 搬家时带过来的松散记录类型,rpc/ 与 services/ 共用这一处声明。
 *  **新代码不用它**:SQLite 行、RPC 入参与返回写成接口(见 CLAUDE.md「类型」)。 */
export type Rec = Record<string, any>;

export type Router = BrokerRouter | FutuRouter;

export interface ServiceHost {
  readonly settings: Settings;
  /** 没连券商是 null;连过又全断了是"有 router、sessions() 为空"。 */
  readonly router: Router | null;
  /** 懒建;库、通知器、熔断器都从它身上拿。 */
  readonly engine: TradingEngine;
  /** 推一条事件给界面(JSON-RPC 通知)。 */
  emit(event: string, payload: Rec): void;
}

//: 生效券商 → (本机网关叫什么, 界面上哪个面板去连它)
export const GATEWAY_NAMES: Record<string, [string, string]> = {
  ibkr: ["TWS / IB Gateway", "「TWS 连接」"],
  futu: ["富途 OpenD", "「富途 OpenD」"],
};

export function gatewayName(settings: Settings): string {
  return (GATEWAY_NAMES[settings.broker.provider] ?? GATEWAY_NAMES["ibkr"])![0];
}

function panelName(settings: Settings): string {
  return (GATEWAY_NAMES[settings.broker.provider] ?? GATEWAY_NAMES["ibkr"])![1];
}

export function needConnection(settings: Settings, code: number, what: string): RpcError {
  return new RpcError(code, `${what}需要${gatewayName(settings)}:请先在${panelName(settings)}面板连接引擎。`);
}

/** service 的基类:把宿主的四样摊成 this.settings / this.router / this.engine / this.emit,
 *  从 rpc.ts 搬过来的方法体一个字不用改。 */
export abstract class ServiceBase {
  constructor(protected readonly host: ServiceHost) {}

  protected get settings(): Settings {
    return this.host.settings;
  }

  protected get router(): Router | null {
    return this.host.router;
  }

  protected get engine(): TradingEngine {
    return this.host.engine;
  }

  protected emit(event: string, payload: Rec): void {
    this.host.emit(event, payload);
  }

  protected needConnection(code: number, what: string): RpcError {
    return needConnection(this.settings, code, what);
  }
}
