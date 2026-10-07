/** 假的 TWS:垫在真的 `ibSession.ts` 与真的 `BrokerRouter` 底下的那个 `@stoqey/ib`。全部离线。
 *
 * 现有的假会话(broker-router / fix-tracker-quotes)自己不带行情缓存、也不维护持仓表,会话层的事测不出来。
 * 这里只假到库为止:订阅占不占行情线路、撤掉的订阅收不收 tick、持仓的增量怎么推,都照库的样子来。
 * 2026-09-28 从 fix-shared-ticker-stream.spec.ts 里拎出来(fix-closed-position-streams.spec.ts 也要用)。
 */
import { BrokerRouter } from "../src/broker.js";
import type { IbSession } from "../src/broker.js";
import { createIbApiNextSession } from "../src/ibSession.js";
import type { AccountConfig } from "../src/config.js";
import { loadGolden, makeSettings } from "./util.js";

const g = loadGolden("config");
export type Row = Record<string, unknown>;
export type Wire = Record<string, unknown>;
export interface Quote { bid?: number; ask?: number; last?: number }
export interface Sub { contract: Wire; generic: string; next: (u: unknown) => void; closed: boolean }
/** 不写 account 就是 ACCOUNT(配置里的纸面账户) */
export interface Held { contract: Wire; pos: number; avgCost: number; account?: string }

export const TICK = { BID: 1, ASK: 2, LAST: 4, CLOSE: 9 };
export const CFG = { host: "127.0.0.1", port: 7497, clientId: 11, readonly: false };
export const ACCOUNT = "DU7654321";

/** 库给的一根历史 K 线(`@stoqey/ib` 的 Bar):TWS 回 -1 的字段库里就没有,指数的日线因此不带 volume。 */
export interface LibBar { time: string; open: number; high: number; low: number; close: number; volume?: number }

/** 一个假的 TWS:合约按 conId 认,盘口按 conId 给,只有没撤掉的订阅收得到 tick。 */
export class FakeTws {
  readonly subs: Sub[] = [];
  readonly book = new Map<number, Quote>();
  held: Held[] = [];
  /** TWS 不回合约确认(刚睡醒、还在重连 IBKR 时的样子):请求发出去就没有下文,也不报错 */
  stalled = false;
  /** TWS 回了话、但查无此合约的标的(回一个空列表) */
  readonly unlisted = new Set<string>();
  /** 一共收到过几次合约确认请求 */
  detailRequests = 0;
  /** 标的 → 历史 K 线,不管请求的时长与周期,原样给(切片是 BrokerRouter 的事) */
  readonly history = new Map<string, LibBar[]>();
  /** 每次历史请求的标的与 whatToShow */
  readonly histRequests: Array<{ symbol: string; whatToShow: string }> = [];
  private readonly ids = new Map<string, number>();
  private readonly positionObservers: Array<(u: unknown) => void> = [];

  conId(symbol: string, expiry = "", strike = 0, right = "", tradingClass = ""): number {
    const key = [symbol, expiry, strike, right, tradingClass].join("|");
    let id = this.ids.get(key);
    if (id === undefined) {
      id = 1000 + this.ids.size;
      this.ids.set(key, id);
    }
    return id;
  }

  /** 请求里没写交易类的期权:按标的的日到期类认(SPX → SPXW),和真机对非月度到期日的回法一样 */
  resolve(c: Wire): { conId: number; tradingClass: string } {
    const option = c["secType"] === "OPT";
    const tradingClass = String(c["tradingClass"] ?? "") || (option ? `${String(c["symbol"])}W` : "");
    const conId = this.conId(
      String(c["symbol"]), String(c["lastTradeDateOrContractMonth"] ?? ""),
      Number(c["strike"] ?? 0), String(c["right"] ?? ""), tradingClass,
    );
    return { conId, tradingClass };
  }

  /** 行情推一轮:每条还开着的订阅收到它那张合约此刻的盘口 */
  pump(): void {
    for (const sub of this.subs) {
      if (sub.closed) continue;
      const quote = this.book.get(Number(sub.contract["conId"]));
      if (quote === undefined) continue;
      const all = new Map<number, { value: number }>();
      if (quote.bid !== undefined) all.set(TICK.BID, { value: quote.bid });
      if (quote.ask !== undefined) all.set(TICK.ASK, { value: quote.ask });
      if (quote.last !== undefined) all.set(TICK.LAST, { value: quote.last });
      sub.next({ all });
    }
  }

  /** 此刻还占着行情线路的订阅(按 conId) */
  open(conId: number): Sub[] {
    return this.subs.filter((s) => !s.closed && Number(s.contract["conId"]) === conId);
  }

  /** 此刻一共占着几条行情线路 */
  lines(): number {
    return this.subs.filter((s) => !s.closed).length;
  }

  private grouped(list: Held[]): Map<string, Held[]> {
    const out = new Map<string, Held[]>();
    for (const h of list) out.set(h.account ?? ACCOUNT, [...(out.get(h.account ?? ACCOUNT) ?? []), h]);
    return out;
  }

  /** 新开一笔仓:照库的样子推增量(added 里只带这一条) */
  fill(...opened: Held[]): void {
    for (const h of opened) {
      this.held = [...this.held, h];
      const update = { all: this.grouped(this.held), added: this.grouped([h]) };
      for (const next of this.positionObservers) next(update);
    }
  }

  /** 平掉这几笔仓:库在数量归零时推 removed,里面只带那一条、数量是 0(见 applyPositionUpdate 的注释) */
  flatten(...closed: Held[]): void {
    for (const h of closed) {
      this.held = this.held.filter((x) => x !== h);
      const update = { all: this.grouped(this.held), removed: this.grouped([{ ...h, pos: 0 }]) };
      for (const next of this.positionObservers) next(update);
    }
  }

  mod(): Record<string, unknown> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const tws = this;
    class FakeApiNext {
      readonly api = { on: () => undefined };
      readonly errorSubject = { subscribe: () => ({ unsubscribe: () => undefined }) };
      readonly connectionState = { subscribe: () => ({ unsubscribe: () => undefined }) };
      connect(): void { /* 离线 */ }
      disconnect(): void { /* 离线 */ }
      getManagedAccounts(): Promise<string[]> { return Promise.resolve([ACCOUNT]); }
      setMarketDataType(): void { /* 离线 */ }
      getContractDetails(c: Wire): Promise<unknown[]> {
        tws.detailRequests += 1;
        if (tws.stalled) return new Promise(() => undefined);
        if (tws.unlisted.has(String(c["symbol"]))) return Promise.resolve([]);
        return Promise.resolve([{ contract: { ...tws.resolve(c), exchange: "SMART" } }]);
      }
      getPositions(): { subscribe(o: { next(u: unknown): void }): { unsubscribe(): void } } {
        return {
          subscribe: (o) => {
            tws.positionObservers.push(o.next);
            o.next({ all: tws.grouped(tws.held) });
            return { unsubscribe: () => undefined };
          },
        };
      }
      getMarketData(contract: Wire, generic: string): { subscribe(o: { next(u: unknown): void }): { unsubscribe(): void } } {
        return {
          subscribe: (o) => {
            const sub: Sub = { contract, generic, next: o.next, closed: false };
            tws.subs.push(sub);
            return { unsubscribe: () => { sub.closed = true; } };
          },
        };
      }
      getMarketDepth(): { subscribe(): { unsubscribe(): void } } {
        return { subscribe: () => ({ unsubscribe: () => undefined }) };
      }
      getHistoricalData(contract: Wire, _end: unknown, _duration: string, _barSize: string, whatToShow: string): Promise<LibBar[]> {
        const symbol = String(contract["symbol"]);
        tws.histRequests.push({ symbol, whatToShow });
        return Promise.resolve(tws.history.get(symbol) ?? []);
      }
    }
    return {
      IBApiNext: FakeApiNext, IBApiTickType: TICK, EventName: {},
      ConnectionState: { Disconnected: 0, Connecting: 1, Connected: 2 },
    };
  }
}

/** 真的会话 + 真的路由。等行情(settle)不真睡:每等一次,假 TWS 推一轮盘口。 */
export async function connect(tws: FakeTws): Promise<{ session: IbSession; router: BrokerRouter; account: AccountConfig }> {
  const session = await createIbApiNextSession(CFG, { mod: tws.mod() });
  session.settle = async () => tws.pump();
  const settings = makeSettings(g.base_config);
  const router = new BrokerRouter(settings, async () => session);
  const account = settings.accounts[0];
  if (account === undefined) throw new Error("配置里没有账户");
  await router.forAccount(account);
  return { session, router, account };
}

export const EXPIRY = "20260910";

/** 一条 SPX 看涨期权的持仓腿 */
export function optionLeg(tws: FakeTws, strike: number, pos: number, tradingClass = "SPXW", expiry = EXPIRY): Held {
  return {
    pos, avgCost: 100,
    contract: {
      conId: tws.conId("SPX", expiry, strike, "C", tradingClass), symbol: "SPX", secType: "OPT",
      lastTradeDateOrContractMonth: expiry, strike, right: "C", multiplier: "100", tradingClass,
    },
  };
}

export const positions = async (router: BrokerRouter): Promise<Row[]> => (await router.positions()) as unknown as Row[];
export const priceOf = (rows: Row[], strike: number): unknown =>
  rows.find((r) => (r["contract"] as Row | undefined)?.["strike"] === strike)?.["market_price"];
