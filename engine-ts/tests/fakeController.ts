/** 真的 IBApiNext,只把最底下的 socket 控制器(Controller)换成假的。全部离线。
 *
 * 不开 socket,把发给 TWS 的请求记下来;TWS 的回话由测试在 `tws` 上手动 emit(事件名、参数与库的解码器发的一样)。
 * 库自己在断线、重连时做的事(收到 1100 / 2110 断 socket、5 秒后重连、按原 reqId 重订)都是真的。
 * 调用方要开假时钟(`vi.useFakeTimers`)。2026-09-30 从 fix-stale-streams.spec.ts 里拎出来(fix-upstream-info.spec.ts 也要用)。
 */
import * as ib from "@stoqey/ib";
import { vi } from "vitest";

import { createIbApiNextSession } from "../src/ibSession.js";
import type { IbSession } from "../src/ibTypes.js";

export type Emitter = { emit(name: string, ...args: unknown[]): boolean };

/** 配置里「主账户」的账号,真 TWS 在 reqManagedAccts 上回它 */
export const LIVE_ACCOUNT = "U1234567";

/** 换掉 IBApi 最底下的 Controller:不开 socket,把发给 TWS 的请求记下来,TWS 的回话由测试手动 emit。 */
export class FakeController {
  connected = false;
  /** 发给 TWS 的请求:[名字, reqId 或参数…];合约只记行权价 */
  sent: unknown[][] = [];
  readonly encoder: Record<string, (...args: unknown[]) => void>;
  constructor(private readonly ibApi: Emitter, account: string) {
    this.encoder = new Proxy({}, {
      get: (_t, name: string) => (...args: unknown[]) => {
        this.sent.push([name, ...args.slice(0, 2).map((a) => (a && typeof a === "object" ? (a as { strike?: unknown }).strike : a))]);
        if (name === "reqManagedAccts") queueMicrotask(() => this.ibApi.emit("managedAccounts", account));
      },
    });
  }
  get serverVersion(): number { return 176; }
  connect(): void {
    this.connected = true;
    this.ibApi.emit("connected");
  }
  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.ibApi.emit("disconnected");
  }
  schedule(fn: () => void): void { fn(); }
  pause(): void { /* 真的那个在 nextValidId 之前攒着请求;这里直接发,先后次序不变 */ }
  resume(): void { /* 同上 */ }
  /** 发出去的 reqMktData 的 reqId,按先后 */
  mktReqs(): number[] { return this.sent.filter((s) => s[0] === "reqMktData").map((s) => Number(s[1])); }
}

export interface SessionCfg { host: string; port: number; clientId: number; readonly: boolean }

/** 一条真的会话。`tws` 是库里的 IBApi(事件源),`ctl` 记着发出去的请求 */
export async function realSession(
  cfg: SessionCfg = { host: "127.0.0.1", port: 7496, clientId: 12, readonly: false }, account = LIVE_ACCOUNT,
): Promise<{ session: IbSession; ctl: FakeController; tws: Emitter }> {
  let ctl: FakeController | null = null;
  let tws: Emitter | null = null;
  const Base = (ib as unknown as { IBApiNext: new (o: Record<string, unknown>) => { api: Emitter & { controller: unknown } } }).IBApiNext;
  const mod = {
    ...ib,
    IBApiNext: class extends Base {
      constructor(opts: Record<string, unknown>) {
        super({ ...opts, logger: { debug() {}, info() {}, warn() {}, error() {} } });
        tws = this.api;
        ctl = new FakeController(this.api, account);
        this.api.controller = ctl;
      }
    },
  };
  const pending = createIbApiNextSession(cfg, { mod });
  await vi.advanceTimersByTimeAsync(10);
  const session = await pending;
  return { session, ctl: ctl!, tws: tws! };
}
