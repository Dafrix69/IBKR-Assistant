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
    callVolume: null, putVolume: null, modelGreeks: null, error: null,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 持仓表的一行(账户 + 合约 + 数量 + 成本),按 `账户|conId` 索引。 */
export interface HeldPosition { account: string; contract: any; pos: number; avgCost: number }

/**
 * 把 IBApiNext.getPositions() 的一次推送并进自己维护的持仓表。
 *
 * **不信库里那份 `all`。** @stoqey/ib 在持仓归零时这样删缓存:`accountPositions.splice(i)`——
 * 少了第二个参数,把第 i 个之后的**全部**删掉。蝶的一条腿平掉,排在它后面的 BE 也跟着从 `all`
 * 里消失,盯盘判「持仓已不存在」→ 停追踪、撤托管单(2026-09-10 真机:蝶止盈成交后一秒,
 * BE 的追踪被自动停用)。但库发的增量(added / changed / removed)各自只带那一条,是对的。
 * 所以:只有首次那份(positionEnd 之后、不带增量)用 `all` 建表,之后一律只按增量改。
 */
export function applyPositionUpdate(
  table: Map<string, HeldPosition> | null, update: any,
): Map<string, HeldPosition> {
  const keyOf = (account: string, contract: any): string => `${account}|${contract?.conId ?? contract?.symbol ?? ""}`;
  const each = (group: any, fn: (account: string, p: any) => void): void => {
    group?.forEach?.((list: any[], account: string) => { for (const p of list ?? []) fn(account, p); });
  };
  const isDelta = Boolean(update?.added || update?.changed || update?.removed);
  if (table === null || !isDelta) {
    const fresh = new Map<string, HeldPosition>();
    each(update?.all ?? update, (account, p) => {
      if (Number(p?.pos ?? 0)) fresh.set(keyOf(account, p.contract), { account, contract: p.contract, pos: Number(p.pos), avgCost: Number(p.avgCost ?? 0) });
    });
    if (table === null || !isDelta) return fresh;
  }
  const upsert = (account: string, p: any): void => {
    const k = keyOf(account, p?.contract);
    if (Number(p?.pos ?? 0)) table.set(k, { account, contract: p.contract, pos: Number(p.pos), avgCost: Number(p.avgCost ?? 0) });
    else table.delete(k); // 归零 = 平仓
  };
  each(update.added, upsert);
  each(update.changed, upsert);
  each(update.removed, (account, p) => table.delete(keyOf(account, p?.contract)));
  return table;
}

/** 底层 IBApi 的 orderStatus 事件 → 引擎期望的 trade(ib_insync 同形:order / orderStatus / contract)。 */
export function tradeFromOrderStatus(
  orderId: unknown, status: unknown, filled: unknown, remaining: unknown, avgFillPrice: unknown,
  permId: unknown, contract: Record<string, unknown> | undefined,
): { order: { orderId: number; permId: number | null }; orderStatus: Record<string, unknown>; contract: Record<string, unknown> } {
  return {
    order: { orderId: Number(orderId) || 0, permId: Number(permId) || null },
    orderStatus: {
      status: String(status ?? ""),
      filled: Number(filled) || 0,
      remaining: Number(remaining) || 0,
      avgFillPrice: Number(avgFillPrice) || 0,
    },
    contract: contract ?? {},
  };
}

/** 底层 IBApi 的 execDetails 事件 → 引擎期望的 [trade, fill]。 */
export function fillFromExecDetails(
  contract: Record<string, unknown> | undefined, execution: Record<string, any> | undefined,
): [{ order: { orderId: number; permId: number | null }; contract: Record<string, unknown> }, { contract: Record<string, unknown>; execution: Record<string, unknown> }] {
  const e = execution ?? {};
  const c = contract ?? {};
  const orderId = Number(e["orderId"]) || 0;
  const permId = Number(e["permId"]) || null;
  return [
    { order: { orderId, permId }, contract: c },
    {
      contract: c,
      execution: {
        execId: e["execId"] ?? "", time: e["time"] ?? "", price: e["price"] ?? 0, shares: e["shares"] ?? 0,
        side: e["side"] ?? "", acctNumber: e["acctNumber"] ?? "", orderId, permId,
        cumQty: e["cumQty"] ?? null, avgPrice: e["avgPrice"] ?? null,
      },
    },
  ];
}

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
  const commissionCbs: Array<(trade: any, fill: any, report: any) => void> = [];
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

  // 订单状态 / 成交 / 佣金:直接挂在底层 IBApi 的事件上,转成引擎期望的 ib_insync 同形对象。
  // IBApiNext 的 getOpenOrders 推的是 OpenOrdersUpdate 集合、不带成交明细——2026-09-08 模拟盘实测:
  // 单子成交了,记录却永远停在 Submitted,fillCbs 一次都没被调用。这三个事件 TWS 会主动推给下单的
  // client(与 ib_insync 的 orderStatusEvent / execDetailsEvent / commissionReportEvent 同源)。
  const raw: any = (api as any).api;
  const E: any = mod.EventName ?? {};
  const contractsByOrder = new Map<number, Record<string, unknown>>();
  const tradesByExec = new Map<string, any>();
  if (raw && typeof raw.on === "function") {
    raw.on(E.openOrder ?? "openOrder", (orderId: unknown, contract: any) => {
      contractsByOrder.set(Number(orderId), contract ?? {});
    });
    raw.on(E.orderStatus ?? "orderStatus", (
      orderId: unknown, status: unknown, filled: unknown, remaining: unknown, avgFillPrice: unknown, permId?: unknown,
    ) => {
      const trade = tradeFromOrderStatus(
        orderId, status, filled, remaining, avgFillPrice, permId, contractsByOrder.get(Number(orderId)),
      );
      for (const cb of orderStatusCbs) cb(trade);
    });
    raw.on(E.execDetails ?? "execDetails", (_reqId: unknown, contract: any, execution: any) => {
      const [trade, fill] = fillFromExecDetails(contract, execution);
      tradesByExec.set(String(fill.execution["execId"] ?? ""), trade);
      for (const cb of fillCbs) cb(trade, fill);
    });
    raw.on(E.commissionReport ?? "commissionReport", (report: any) => {
      const trade = tradesByExec.get(String(report?.execId ?? ""));
      if (!trade) return;
      for (const cb of commissionCbs) cb(trade, null, report);
    });
  } else {
    // 拿不到底层事件源(库版本差异)就退回集合推流;engine 侧对账循环兜底
    api.getOpenOrders?.().subscribe?.((update: any) => {
      for (const cb of orderStatusCbs) cb(update);
    });
  }

  let mdBaseline = 1;
  // 持仓常驻订阅:见 positions()
  let positionsLatest: Map<string, HeldPosition> | null = null;
  let positionsSub: Subscription | null = null;
  const positionsWaiters: Array<() => void> = [];
  const ensurePositions = (): void => {
    if (positionsSub !== null) return;
    try {
      positionsSub = api.getPositions().subscribe({
        next: (update: any) => {
          // 自己按增量维护,不用库里那份会被截尾的 all(见 applyPositionUpdate)
          positionsLatest = applyPositionUpdate(positionsLatest, update);
          positionsWaiters.splice(0).forEach((f) => f());
        },
        // 订阅断了:清掉句柄,下一次读持仓重订;旧快照也作废,不拿断流前的数冒充现在
        error: () => {
          positionsSub = null;
          positionsLatest = null;
        },
      });
    } catch {
      positionsSub = null;
    }
  };
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
      positionsSub?.unsubscribe();
      positionsSub = null;
      positionsLatest = null;
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
      // "切回实时"(1)一律回到基线:纸面会话的基线是 3,见 BrokerRouter.connect
      try {
        api.setMarketDataType(type === 1 ? mdBaseline : type);
      } catch {
        /* ignore */
      }
    },

    setBaselineMarketDataType(type) {
      mdBaseline = type;
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
          const entry = live;
          live.sub = observable.subscribe({
            next: (update: any) => applyTicks(mod, entry.data, update),
            // 订阅被拒(10197 实盘会话占着实时行情、354 没订阅……)之后这条流就死了。以前把它原样
            // 留在缓存里,同一个合约再订拿到的永远是这条死流——2026-09-10 真机:连接刚建好时第一条
            // 行情请求吃了 10197,之后那只 ES 期货怎么订都是空的。现在出错就摘掉,下次重新订。
            error: (err: any) => {
              const code = err?.code ?? err?.error?.code ?? "";
              const text = String(err?.error?.message ?? err?.message ?? "").slice(0, 120);
              entry.data.error = `${code} ${text}`.trim() || "订阅被拒";
              if (tickers.get(key) === entry) tickers.delete(key);
            },
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
      // 带着原 orderId 就是**改单**:IBKR 的改单语义是同一个 id 重发。以前这里永远 placeNewOrder,
      // modifyHosted 设了 orderId 也白设——每一次"改价"其实都新挂了一张单。托管单一秒一改价,
      // 就是一秒多挂一张平仓单。
      if (order.orderId) {
        api.modifyOrder(order.orderId, toIbContract(contract), ibOrder);
        return { orderId: Number(order.orderId), permId: null, status: "Submitted" };
      }
      const orderId = await api.placeNewOrder(toIbContract(contract), ibOrder);
      return { orderId: Number(orderId), permId: null, status: "Submitted" };
    },

    /** 按 orderId 撤单(托管单用)。以前没实现:路由那边是 `session.cancelOrder?.(id)`,可选调用
     * 撞上未实现就**静默什么都不做**——删追踪、持仓已平、授权收回、熔断时"撤掉"的托管单全都还挂在
     * 券商那边;持仓平了之后那张卖单一成交就是反向开仓(2026-09-10 真机:认领时自愈撤重复单,
     * 撤了个寂寞才暴露)。 */
    cancelOrder(orderId: number) {
      api.cancelOrder(Number(orderId));
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

    /**
     * 未成交单明细(托管单认领用)。以前没实现:listHostedOpen 见它不存在就跳过,永远认领不到,
     * 应用每重启一次就把同一追踪的托管单再挂一张(2026-09-10 真机:重启三次,TWS 上四张同样的卖单)。
     * getAllOpenOrders 拿的是所有 client 的单;认领按 orderRef 前缀过滤,不会认错别人的单。
     */
    async openTradesDetailed() {
      const open = await api.getAllOpenOrders();
      const num = (v: unknown): number | null => {
        const n = Number(v);
        return v === null || v === undefined || !Number.isFinite(n) || n >= 1.7e308 ? null : n;
      };
      return (open ?? []).map((o: any) => {
        const order = o?.order ?? {};
        const c = o?.contract ?? {};
        return {
          orderId: Number(o?.orderId ?? order.orderId ?? 0) || null,
          permId: Number(order.permId ?? 0) || null,
          orderRef: String(order.orderRef ?? ""),
          account: String(order.account ?? ""),
          action: String(order.action ?? ""),
          orderType: String(order.orderType ?? ""),
          totalQuantity: Number(order.totalQuantity ?? 0),
          lmtPrice: num(order.lmtPrice),
          auxPrice: num(order.auxPrice),
          trailingPercent: num(order.trailingPercent),
          status: String(o?.orderState?.status ?? ""),
          ocaGroup: String(order.ocaGroup ?? ""),
          ocaType: Number(order.ocaType ?? 0) || null,
          tif: String(order.tif ?? "GTC"),
          outsideRth: Boolean(order.outsideRth),
          contract: {
            secType: String(c.secType ?? ""), symbol: String(c.symbol ?? ""),
            exchange: String(c.exchange ?? "SMART"), currency: String(c.currency ?? "USD"),
            conId: Number(c.conId ?? 0),
            ...(c.lastTradeDateOrContractMonth ? { lastTradeDateOrContractMonth: c.lastTradeDateOrContractMonth } : {}),
            ...(c.strike ? { strike: Number(c.strike) } : {}),
            ...(c.right ? { right: String(c.right) } : {}),
            ...(c.multiplier ? { multiplier: String(c.multiplier) } : {}),
            ...(c.tradingClass ? { tradingClass: String(c.tradingClass) } : {}),
            ...(Array.isArray(c.comboLegs) && c.comboLegs.length ? { comboLegs: c.comboLegs } : {}),
          } as IbContract,
        };
      });
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
      // 常驻订阅,读最新快照。以前每次都现订阅、拿到一笔就退订:盯盘、托管对账、提醒、持仓页
      // 四处并发读,IBApiNext 共享的那条持仓订阅在"退订/重订"的竞态里卡死,之后再也不推——
      // 2026-09-10 夜盘真机:从 07:18 起每次读持仓都等满 8 秒拿到 null。
      ensurePositions();
      if (positionsLatest === null) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 8000);
          positionsWaiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      if (positionsLatest === null) {
        // 拿不到 ≠ 没有持仓。回空列表的话,盯盘会判"持仓已不存在"、停掉追踪、撤掉托管单
        positionsSub?.unsubscribe();
        positionsSub = null;
        throw new Error("TWS 在 8 秒内没有推送持仓,本轮读不到持仓");
      }
      const out: PositionItemLike[] = [];
      for (const p of positionsLatest.values()) {
        out.push({
          contract: { ...(p.contract ?? {}), account: p.account },
          position: p.pos,
          avgCost: p.avgCost,
        });
      }
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
    onCommission(cb) {
      commissionCbs.push(cb);
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
  // 托管单的 OCA 组与 TRAIL 初始停损。以前这三个字段在这里被丢掉:同一追踪的止盈/止损从来
  // 不在一个 OCA 组里,一张成交另一张照挂——那就是反向开仓(2026-09-10 真机:TWS 上的托管单 oca 为空)。
  if (order.ocaGroup) {
    out["ocaGroup"] = order.ocaGroup;
    out["ocaType"] = order.ocaType ?? 1;
  }
  if (order.trailStopPrice !== undefined && order.trailStopPrice !== null) {
    out["trailStopPrice"] = order.trailStopPrice;
  }
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
