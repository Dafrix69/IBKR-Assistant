/** 富途 SDK 桥接口:与 Python futu-api 的调用语义逐一对应。
 *
 * FutuRouter / futu.diagnose 只认这个接口;离线测试注入假实现。
 * npm 的 futu-api(官方,protobuf/websocket)的调用面与 Python SDK 不同,
 * 真正的适配要连着本机 OpenD 逐接口核对——与 Python 版当年"接口签名、返回
 * 列名、枚举取值全部按真机对过"是同一条路径。真机联调前,默认桥抛
 * FutuUnavailable 并说明怎么接,绝不给一个没验证过的实现假装能用。
 */

export type FutuRet = number | string;
export type FutuTuple<T = unknown> = [FutuRet, T] | Promise<[FutuRet, T]>;

export interface FutuQuoteCtx {
  get_global_state(): FutuTuple<Record<string, unknown>>;
  subscribe(codes: string[], subtypes: string[]): FutuTuple;
  unsubscribe(codes: string[], subtypes: string[]): FutuTuple | void | Promise<void>;
  unsubscribe_all(): void | Promise<void>;
  get_market_snapshot(codes: string[]): FutuTuple<Array<Record<string, unknown>>>;
  get_stock_quote(codes: string[]): FutuTuple<Array<Record<string, unknown>>>;
  get_order_book(code: string, num: number): FutuTuple<Record<string, unknown>>;
  request_history_kline(opts: {
    code: string;
    start: string;
    end: string | null;
    ktype: string;
    autype: string;
    max_count: number;
    page_req_key: unknown;
    extended_time?: boolean;
  }): [FutuRet, Array<Record<string, unknown>>, unknown] | Promise<[FutuRet, Array<Record<string, unknown>>, unknown]>;
  get_option_expiration_date(code: string): FutuTuple<Array<Record<string, unknown>>>;
  get_option_chain(opts: {
    code: string;
    start: string;
    end: string;
    option_type?: string;
  }): FutuTuple<Array<Record<string, unknown>>>;
  get_stock_basicinfo(market: string, secType: string): FutuTuple<Array<Record<string, unknown>>>;
  close(): void | Promise<void>;
}

export interface FutuTradeCtx {
  get_acc_list(): FutuTuple<Array<Record<string, unknown>>>;
  unlock_trade(passwordMd5: string): FutuTuple;
  place_order(opts: Record<string, unknown>): FutuTuple<Array<Record<string, unknown>>>;
  order_list_query(opts: {
    trd_env: string;
    acc_id: number;
    refresh_cache: boolean;
  }): FutuTuple<Array<Record<string, unknown>>>;
  deal_list_query(opts: {
    trd_env: string;
    acc_id: number;
    refresh_cache: boolean;
  }): FutuTuple<Array<Record<string, unknown>>>;
  modify_order(
    op: string, orderId: string, qty: number, price: number,
    opts: { trd_env: string; acc_id: number },
  ): FutuTuple;
  position_list_query(opts: {
    trd_env: string;
    acc_id: number;
    refresh_cache: boolean;
  }): FutuTuple<Array<Record<string, unknown>>>;
  close(): void | Promise<void>;
}

export interface FutuBridge {
  RET_OK: FutuRet;
  TrdEnv: { SIMULATE: string; REAL: string };
  OrderType: {
    MARKET: string; NORMAL: string; STOP: string; STOP_LIMIT: string; TRAILING_STOP: string;
  };
  TrdSide: { BUY: string; SELL: string };
  TimeInForce: { DAY: string; GTC: string };
  TrailType: { RATIO: string; AMOUNT: string };
  ModifyOrderOp: { CANCEL: string };
  KLType: Record<string, string>;
  AuType: { QFQ: string };
  SubType: Record<string, string>;
  Market: { US: string };
  SecurityType: { IDX: string };
  OptionType: { CALL: string; PUT: string };
  makeQuoteCtx(host: string, port: number): FutuQuoteCtx | Promise<FutuQuoteCtx>;
  makeTradeCtx(
    host: string, port: number, trdMarket: string, securityFirm: string,
  ): FutuTradeCtx | Promise<FutuTradeCtx>;
}

/** 测试与默认桥共用的枚举面(与 Python SDK 的取值语义一致)。 */
export const FUTU_ENUMS = {
  RET_OK: 0 as FutuRet,
  TrdEnv: { SIMULATE: "SIMULATE", REAL: "REAL" },
  OrderType: {
    MARKET: "MARKET", NORMAL: "NORMAL", STOP: "STOP",
    STOP_LIMIT: "STOP_LIMIT", TRAILING_STOP: "TRAILING_STOP",
  },
  TrdSide: { BUY: "BUY", SELL: "SELL" },
  TimeInForce: { DAY: "DAY", GTC: "GTC" },
  TrailType: { RATIO: "RATIO", AMOUNT: "AMOUNT" },
  ModifyOrderOp: { CANCEL: "CANCEL" },
  KLType: {
    K_1M: "K_1M", K_5M: "K_5M", K_15M: "K_15M", K_30M: "K_30M", K_60M: "K_60M", K_DAY: "K_DAY",
  },
  AuType: { QFQ: "qfq" },
  SubType: { QUOTE: "QUOTE", ORDER_BOOK: "ORDER_BOOK" },
  Market: { US: "US" },
  SecurityType: { IDX: "IDX" },
  OptionType: { CALL: "CALL", PUT: "PUT" },
};

/** 默认桥:npm futu-api 的适配。真机联调前显式不可用——绝不假装。 */
export async function loadFutuBridge(): Promise<FutuBridge> {
  const { FutuUnavailable } = await import("./futu.js");
  try {
    await import("futu-api");
  } catch (exc) {
    throw new FutuUnavailable(
      "未安装 futu-api(npm)。在 engine-ts 目录执行 npm install futu-api。" +
      `原始报错:${(exc as Error).message}`,
    );
  }
  throw new FutuUnavailable(
    "npm futu-api 的适配桥尚未完成真机核对(接口签名、返回列名、枚举取值都要连着" +
    "本机 OpenD 逐一对过,与 Python 版当年的联调路径相同)。富途通道在 TS 引擎里" +
    "暂不可用;需要富途请暂用 Python 引擎,或等待适配完成。",
  );
}
