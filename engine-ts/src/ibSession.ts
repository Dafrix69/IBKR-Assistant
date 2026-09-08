/** IbSession 的默认实现:@stoqey/ib 的 IBApiNext。
 *
 * 原则:库有的能力直接用,不自己写 reqId 配对 / 订阅管理 / 重连——IBApiNext
 * 全都自带(它扮演的就是 ib_insync 在 Python 里的角色)。这里只做两件事:
 * ① 把 IBApiNext 的 Observable/Promise 面折成 broker.ts 的 IbSession 语义;
 * ② 把 tick 字段映射回 ib_insync 口径的 TickerData。
 *
 * ⚠ 真机联调状态:离线测试不触达本文件(router 测试注入 FakeIbSession)。
 * tick 类型映射、深度、期权 greeks 的字段名需要在 TWS 真机上核对——与 Python
 * 版当年 futu 联调"接口按真机对过"是同一条路径,见 docs/reports/ts-rewrite-report.md。
 */
import type {
  IbContract, IbSession, OptChainParam, OrderIntent, PortfolioItemLike, PositionItemLike,
  RawBar, TickerData, TickerHandle, TradeLike,
} from "./broker.js";

type Subscription = { unsubscribe(): void };

interface LiveTicker {
  data: TickerData;
  sub: Subscription | null;
}

function emptyTicker(): TickerData {
  return {
    bid: NaN, ask: NaN, last: null, close: null, bidSize: null, askSize: null,
    marketPrice: null, callOpenInterest: null, putOpenInterest: null,
    callVolume: null, putVolume: null, modelGreeks: null,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function createIbApiNextSession(cfg: {
  host: string;
  port: number;
  clientId: number;
  readonly: boolean;
}): Promise<IbSession> {
  const mod: any = await import("@stoqey/ib");
  const api = new mod.IBApiNext({ host: cfg.host, port: cfg.port });

  let connected = false;
  let managed: string[] = [];
  const connectivityCbs: Array<(code: number) => void> = [];
  const errorCbs: Array<(reqId: number, code: number, message: string) => void> = [];
  const orderStatusCbs: Array<(trade: any) => void> = [];
  const fillCbs: Array<(trade: any, fill: any) => void> = [];
  const tickers = new Map<string, LiveTicker>();

  // 连接级错误(1100/1101/1102 等)与订单级错误(reqId = orderId,如 200 证券定义、
  // 110 价格跳动、201 拒单)都从 error$ 流上来。订单级的必须转给引擎落库,
  // 否则被 TWS 当场拒掉的单会永远停在 Submitted——模拟盘实测(2026-09-03)。
  const onApiError = (err: any): void => {
    const code = Number(err?.code ?? 0);
    if (!code) return;
    for (const cb of connectivityCbs) cb(code);
    const reqId = Number(err?.reqId ?? -1);
    if (reqId > 0) {
      const message = String(err?.error?.message ?? err?.message ?? err?.error ?? "");
      for (const cb of errorCbs) cb(reqId, code, message);
    }
  };
  api.errorSubject?.subscribe?.(onApiError) ?? api.error$?.subscribe?.(onApiError);

  api.connect(cfg.clientId);
  // 用库自带的 getManagedAccounts 做"连接完成"的信号
  managed = await withTimeout(api.getManagedAccounts(), 10_000, "连接超时");
  connected = true;

  // 成交/状态推流:engine 的推式回报(库自带 getAllOpenOrders / executions 流)
  try {
    api.getOpenOrders?.().subscribe?.((update: any) => {
      for (const cb of orderStatusCbs) cb(update);
    });
  } catch {
    /* 版本差异,engine 侧还有轮询兜底 */
  }

  const keyOf = (c: IbContract): string =>
    `${c.secType}|${c.symbol}|${c.lastTradeDateOrContractMonth ?? ""}|${c.strike ?? ""}|${c.right ?? ""}`;

  const toIbContract = (c: IbContract): Record<string, unknown> => ({
    secType: c.secType,
    symbol: c.symbol,
    exchange: c.exchange,
    currency: c.currency,
    ...(c.lastTradeDateOrContractMonth
      ? { lastTradeDateOrContractMonth: c.lastTradeDateOrContractMonth }
      : {}),
    ...(c.strike ? { strike: c.strike } : {}),
    ...(c.right ? { right: c.right } : {}),
    ...(c.multiplier ? { multiplier: Number(c.multiplier) } : {}),
    ...(c.tradingClass ? { tradingClass: c.tradingClass } : {}),
    ...(c.conId ? { conId: c.conId } : {}),
    ...(c.comboLegs ? { comboLegs: c.comboLegs } : {}),
    ...(c.includeExpired ? { includeExpired: true } : {}),
  });

  const session: IbSession = {
    isConnected: () => connected,

    disconnect: () => {
      connected = false;
      for (const live of tickers.values()) live.sub?.unsubscribe();
      tickers.clear();
      try {
        api.disconnect();
      } catch {
        /* ignore */
      }
    },

    managedAccounts: () => managed,

    async qualifyContracts(contracts, timeoutMs) {
      // 库的 getContractDetails 就是 qualify:回 conId 与完整合约
      await withTimeout(
        (async () => {
          for (const contract of contracts) {
            try {
              const details = await api.getContractDetails(toIbContract(contract));
              const first = Array.isArray(details) ? details[0] : details;
              const resolved = first?.contract;
              if (resolved?.conId) {
                contract.conId = resolved.conId;
                if (resolved.exchange) contract.exchange = resolved.exchange;
                if (resolved.tradingClass) contract.tradingClass = resolved.tradingClass;
              }
            } catch {
              contract.conId = 0; // 确认失败:router 侧统一转成"无法确认该合约"
            }
          }
        })(),
        timeoutMs,
        "timeout",
      );
    },

    async contractHours(contract, timeoutMs) {
      // 只读:合约详情里的交易时段。SPX 期权与正股时段不同(隔夜 20:15–次日 09:25),
      // 用正股日历判期权会把隔夜整段当成休市——见 config.hoursStatus。
      let out: [string, string, string] | null = null;
      await withTimeout(
        (async () => {
          try {
            const details = await api.getContractDetails(toIbContract(contract));
            const first: any = Array.isArray(details) ? details[0] : details;
            if (first) {
              out = [String(first.tradingHours ?? ""), String(first.liquidHours ?? ""),
                     String(first.timeZoneId ?? "")];
            }
          } catch {
            out = null;          // 查不到时段不该炸掉轮询,调用方退回正股表
          }
        })(),
        timeoutMs,
        "timeout",
      ).catch(() => { out = null; });
      return out;
    },

    reqMarketDataType(type) {
      try {
        api.setMarketDataType(type);
      } catch {
        /* ignore */
      }
    },

    subscribeTicker(contract, genericTicks = "") {
      const key = keyOf(contract);
      let live = tickers.get(key);
      if (!live) {
        live = { data: emptyTicker(), sub: null };
        tickers.set(key, live);
        try {
          const observable = api.getMarketData(toIbContract(contract), genericTicks, false, false);
          live.sub = observable.subscribe({
            next: (update: any) => applyTicks(mod, live!.data, update),
            error: () => undefined,
          });
        } catch {
          /* 订阅失败:句柄读到的是空盘口,守卫会拒 */
        }
      }
      const handle: TickerHandle = { read: () => ({ ...live!.data }) };
      return handle;
    },

    cancelTicker(contract) {
      const key = keyOf(contract);
      const live = tickers.get(key);
      if (live) {
        live.sub?.unsubscribe();
        tickers.delete(key);
      }
    },

    settle: (ms) => sleep(ms),

    async historicalData(contract, opts) {
      // barSize 直接传 IBKR 的文本值("1 min" / "1 day"),库按原样下发
      const bars = await api.getHistoricalData(
        toIbContract(contract),
        opts.endDateTime || undefined,
        opts.durationStr,
        opts.barSizeSetting,
        opts.whatToShow,
        opts.useRTH ? 1 : 0,
        1, // formatDate
      );
      return (bars ?? []).map((b: any): RawBar => ({
        date: String(b.time ?? b.date ?? ""),
        open: Number(b.open),
        high: Number(b.high),
        low: Number(b.low),
        close: Number(b.close),
        volume: Number(b.volume ?? 0),
      }));
    },

    async secDefOptParams(symbol, secType, conId) {
      const params = await api.getSecDefOptParams(symbol, "", secType, conId);
      return (params ?? []).map((p: any): OptChainParam => ({
        exchange: String(p.exchange ?? ""),
        tradingClass: String(p.tradingClass ?? ""),
        expirations: [...(p.expirations ?? [])].map(String),
        strikes: [...(p.strikes ?? [])].map(Number),
      }));
    },

    async mktDepth(contract, rows, waitMs) {
      const out = { bids: [] as Array<{ price: number; size: number }>, asks: [] as Array<{ price: number; size: number }> };
      let sub: Subscription | null = null;
      try {
        const observable = api.getMarketDepth(toIbContract(contract), rows, true);
        sub = observable.subscribe({
          next: (update: any) => {
            const rowsOf = (side: any): Array<{ price: number; size: number }> => {
              const list: Array<{ price: number; size: number }> = [];
              side?.forEach?.((v: any) => {
                if (v?.price > 0) list.push({ price: Number(v.price), size: Number(v.size ?? 0) });
              });
              return list;
            };
            out.bids = rowsOf(update?.all?.bids ?? update?.bids);
            out.asks = rowsOf(update?.all?.asks ?? update?.asks);
          },
          error: () => undefined,
        });
        await sleep(waitMs);
      } finally {
        sub?.unsubscribe();
      }
      return out;
    },

    async placeOrder(contract, order): Promise<TradeLike> {
      const ibOrder = toIbOrder(mod, order);
      const orderId = await api.placeNewOrder(toIbContract(contract), ibOrder);
      return { orderId: Number(orderId), permId: null, status: "Submitted" };
    },

    async openTrades() {
      const open = await api.getAllOpenOrders();
      return (open ?? []).map((o: any) => ({
        orderId: Number(o?.orderId ?? o?.order?.orderId ?? 0) || null,
        cancel: () => {
          try {
            api.cancelOrder(Number(o?.orderId ?? o?.order?.orderId ?? 0));
          } catch {
            /* 撤不掉的要继续撤下一笔 */
          }
        },
      }));
    },

    async portfolio(): Promise<PortfolioItemLike[]> {
      // IBApiNext 的 portfolio 走账户更新流;真机联调时再接。
      // 回空让 router 走 positions() 兜底——与 Python 版"portfolio 拿不到就退"同路径。
      return [];
    },

    async executions() {
      // 当天(本次会话)的逐笔成交;IBApiNext 的 getExecutionDetails 一次性回全量
      const details = await api.getExecutionDetails({});
      return (details ?? []).map((d: any) => ({ contract: d?.contract ?? {}, execution: d?.execution ?? {} }));
    },

    async positions(): Promise<PositionItemLike[]> {
      const updates = await firstFrom(api.getPositions());
      const out: PositionItemLike[] = [];
      const all = updates?.all ?? updates;
      all?.forEach?.((positionsOfAccount: any, account: string) => {
        for (const p of positionsOfAccount ?? []) {
          out.push({
            contract: { ...(p.contract ?? {}), account },
            position: Number(p.pos ?? p.position ?? 0),
            avgCost: Number(p.avgCost ?? 0),
          });
        }
      });
      return out;
    },

    onConnectivity(cb) {
      connectivityCbs.push(cb);
    },
    onError(cb) {
      errorCbs.push(cb);
    },
    offError(cb) {
      const i = errorCbs.indexOf(cb);
      if (i >= 0) errorCbs.splice(i, 1);
    },
    onOrderStatus(cb) {
      orderStatusCbs.push(cb);
    },
    onFill(cb) {
      fillCbs.push(cb);
    },
  };
  return session;
}

function applyTicks(mod: any, data: TickerData, update: any): void {
  const ticks = update?.all ?? update;
  // 两张枚举表都要查:BID/ASK/LAST/CLOSE 与 DELAYED_* 在 IBApiTickType(TWS 原生 tick 号),
  // 模型 greeks 等 IBApiNext 自己拆出来的 tick 在 IBApiNextTickType。以前只查后者,
  // 结果基础报价一个都对不上号——所有走 TS 引擎的行情都是空盘口。
  const T1 = mod.IBApiTickType ?? mod.TickType ?? {};
  const T2 = mod.IBApiNextTickType ?? {};
  const get = (name: string): number | undefined => {
    const id = T1[name] ?? T2[name];
    if (id === undefined) return undefined;
    const v = ticks?.get?.(id)?.value ?? ticks?.get?.(id);
    return v === undefined || v === null ? undefined : Number(v);
  };
  const setIf = (value: number | undefined, apply: (v: number) => void): void => {
    if (value !== undefined && !Number.isNaN(value)) apply(value);
  };
  // 延迟行情(reqMarketDataType(3))到达时 tick 类型是 DELAYED_*(66/67/68/75),
  // 不是 BID/ASK/LAST/CLOSE。不认它们的话,"没订阅退延迟"那条路永远拿不到价——
  // ib_insync 会把两组映射到同一个字段,这里也照做:实时优先,延迟兜底。
  const pick = (name: string): number | undefined => get(name) ?? get(`DELAYED_${name}`);
  setIf(pick("BID"), (v) => (data.bid = v));
  setIf(pick("ASK"), (v) => (data.ask = v));
  setIf(pick("LAST"), (v) => (data.last = v));
  setIf(pick("CLOSE"), (v) => (data.close = v));
  setIf(get("BID_SIZE"), (v) => (data.bidSize = v));
  setIf(get("ASK_SIZE"), (v) => (data.askSize = v));
  setIf(get("OPTION_CALL_OPEN_INTEREST"), (v) => (data.callOpenInterest = v));
  setIf(get("OPTION_PUT_OPEN_INTEREST"), (v) => (data.putOpenInterest = v));
  setIf(get("OPTION_CALL_VOLUME"), (v) => (data.callVolume = v));
  setIf(get("OPTION_PUT_VOLUME"), (v) => (data.putVolume = v));
  // 模型 greeks:IBApiNext 把 MODEL_OPTION 的各分量拆成独立 tick
  const gamma = get("MODEL_OPTION_GAMMA") ?? get("modelGamma");
  const iv = get("MODEL_OPTION_IV") ?? get("modelIV");
  if (gamma !== undefined || iv !== undefined) {
    data.modelGreeks = { gamma: gamma ?? null, impliedVol: iv ?? null };
  }
  if (data.last === null && data.bid > 0 && data.ask > 0) {
    data.marketPrice = (data.bid + data.ask) / 2;
  } else if (data.last !== null) {
    data.marketPrice = data.last;
  }
}

function toIbOrder(mod: any, order: OrderIntent): Record<string, unknown> {
  const typeMap: Record<string, string> = {
    MKT: "MKT", LMT: "LMT", STP: "STP", "STP LMT": "STP LMT", TRAIL: "TRAIL",
  };
  const out: Record<string, unknown> = {
    action: order.action,
    orderType: typeMap[order.orderType] ?? order.orderType,
    totalQuantity: order.totalQuantity,
    tif: order.tif,
    outsideRth: order.outsideRth,
    account: order.account,
    transmit: order.transmit,
    orderRef: order.orderRef ?? "",
  };
  if (order.lmtPrice !== null) out["lmtPrice"] = order.lmtPrice;
  if (order.auxPrice !== null) out["auxPrice"] = order.auxPrice;
  if (order.trailingPercent !== null) out["trailingPercent"] = order.trailingPercent;
  if (order.conditions?.length) {
    out["conditions"] = order.conditions.map((c) =>
      new mod.PriceCondition(c["price"], mod.TriggerMethod?.Default ?? 0, c["conId"], c["exchange"], c["isMore"], mod.ConjunctionConnection?.And ?? "a"),
    );
    out["conditionsCancelOrder"] = order.conditionsCancelOrder ?? false;
  }
  return out;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function firstFrom(observable: any): Promise<any> {
  return new Promise((resolve, reject) => {
    let done = false;
    const sub = observable.subscribe({
      next: (v: any) => {
        if (!done) {
          done = true;
          resolve(v);
          setTimeout(() => sub?.unsubscribe?.(), 0);
        }
      },
      error: (e: any) => {
        if (!done) {
          done = true;
          reject(e);
        }
      },
    });
    setTimeout(() => {
      if (!done) {
        done = true;
        resolve(null);
        sub?.unsubscribe?.();
      }
    }, 8000);
  });
}
