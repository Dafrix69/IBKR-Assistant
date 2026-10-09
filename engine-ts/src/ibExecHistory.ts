/**
 * 向 TWS 要最近几天的成交(docs/features/tradereview.md「成交从哪儿来」)。
 *
 * 平时那条连接(ibSession.ts,@stoqey/ib)和 TWS 谈到的接口版本最高 193,那个版本的 reqExecutions 没有"要几天"这一格,
 * TWS 只回它自己的"当天"——按 TWS 登录时选的时区,过了午夜就要不到了。能带天数的是 200 版。
 * 把整条连接抬到 200 要连着改报错、订单回报、下单、历史 K 线的收发格式(194–199 各改了一样),那是钱路径,不为一个查询去动。
 *
 * 所以这里另开一条**只读、用完就关**的连接,只会说三句话:握手、报到(START_API)、要成交(REQ_EXECUTIONS 带 lastNDays);
 * 只认三种回话:成交、成交发完了、报错。别的消息一概跳过——V100 起每条消息前面都有 4 字节长度,不认识的整条丢掉就行。
 * 它不下单、不订行情、不碰平时那条连接;连不上、被拒、超时都只是"这一趟没要到",当天的成交照旧走平时那条路。
 *
 * - 版本只谈到 200:201 起 TWS 改用 protobuf 编码,这里不会。TWS 太老(谈下来不到 200)时不发请求,回"给不了"。
 * - 成交消息只按位置读前面那一段(合约 + 成交的基本字段,多年没动过),后面的字段不读:以后再往末尾加字段也不受影响。
 * - 自己的 client id:平时那条的 id 加 9000,不和它抢(同一个 id 第二次连会被 TWS 以 326 拒掉)。
 *
 * 字段次序对着官方客户端的两个移植版(Go:scmhub/ibapi;Rust:wboayue/rust-ibapi)核过;编解码是纯函数,测试直接喂字节。
 */
import * as net from "node:net";

/** 握手时报给 TWS 的版本区间。上限就是"要几天"这一格出现的那一版。 */
export const HISTORY_MIN_VERSION = 100;
export const HISTORY_MAX_VERSION = 200;
/** TWS 最多往回给 7 天。 */
export const HISTORY_DAYS_MAX = 7;
/** 这条连接的 client id = 平时那条的 + 这个数。 */
export const HISTORY_CLIENT_OFFSET = 9000;

const OUT_REQ_EXECUTIONS = 7;
const OUT_START_API = 71;
const IN_ERR_MSG = 4;
const IN_NEXT_VALID_ID = 9;
const IN_EXECUTION_DATA = 11;
const IN_MANAGED_ACCTS = 15;
const IN_EXECUTION_DATA_END = 55;
/** 一条消息最长多少字节:TWS 自己的上限是 16MB,超了说明读错了位置。 */
const FRAME_MAX = 16 * 1024 * 1024;
/** 成交消息里这里要读到的最后一格(orderRef)的位置 + 1。 */
const EXECUTION_FIELDS_MIN = 27;

export function historyClientId(clientId: number): number {
  return clientId + HISTORY_CLIENT_OFFSET;
}

/** 握手:`API\0` + 4 字节长度 + `v100..200`。 */
export function handshakeBytes(): Buffer {
  const versions = Buffer.from(`v${HISTORY_MIN_VERSION}..${HISTORY_MAX_VERSION}`, "ascii");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(versions.length, 0);
  return Buffer.concat([Buffer.from("API\0", "ascii"), size, versions]);
}

/** 一条消息:4 字节长度 + 每个字段后面跟一个 \0。 */
export function frame(fields: ReadonlyArray<string | number>): Buffer {
  const payload = Buffer.from(fields.map((f) => `${f}\0`).join(""), "utf-8");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length, 0);
  return Buffer.concat([size, payload]);
}

/** 报到:START_API,版本 2,client id,可选能力(空)。 */
export function startApiBytes(clientId: number): Buffer {
  return frame([OUT_START_API, 2, clientId, ""]);
}

/** 要成交:过滤条件全空(所有 client、所有账户),最后两格是"最近几天"与"指定日期的个数"(0)。只在 200 版上发。 */
export function executionsRequestBytes(reqId: number, days: number): Buffer {
  return frame([OUT_REQ_EXECUTIONS, 3, reqId, 0, "", "", "", "", "", "", days, 0]);
}

/** 把收到的字节切成一条条消息的字段;切不满一条的留在 rest 里等下一批。长度不像话就抛。 */
export function splitFrames(buffer: Buffer): { frames: string[][]; rest: Buffer } {
  const frames: string[][] = [];
  let at = 0;
  while (buffer.length - at >= 4) {
    const size = buffer.readUInt32BE(at);
    if (size > FRAME_MAX) throw new Error(`TWS 发来的消息长度不对(${size} 字节)`);
    if (buffer.length - at - 4 < size) break;
    const fields = buffer.toString("utf-8", at + 4, at + 4 + size).split("\0");
    // 每个字段后面都有一个 \0,切出来末尾多一个空串
    if (fields[fields.length - 1] === "") fields.pop();
    frames.push(fields);
    at += 4 + size;
  }
  return { frames, rest: buffer.subarray(at) };
}

export interface ExecutionDetail {
  contract: Record<string, unknown>;
  execution: Record<string, unknown>;
}

const num = (token: string | undefined): number => {
  const n = Number((token ?? "").replaceAll(",", ""));
  return Number.isFinite(n) ? n : 0;
};

/**
 * 一条成交消息(字段 0 是消息号 11)→ [请求号, 合约, 成交]。字段不够回 null。
 * 值的形状照平时那条连接的库给的来(数字是数字、看涨看跌只认 C / P),这样两条路存下来的同一笔成交长得一样。
 */
export function decodeExecution(fields: readonly string[]): { reqId: number; detail: ExecutionDetail } | null {
  if (fields.length < EXECUTION_FIELDS_MIN) return null;
  const f = (i: number): string => fields[i] ?? "";
  const right = f(8);
  return {
    reqId: num(f(1)),
    detail: {
      contract: {
        conId: num(f(3)), symbol: f(4), secType: f(5), lastTradeDateOrContractMonth: f(6), strike: num(f(7)),
        right: right === "C" || right === "P" ? right : undefined,
        multiplier: num(f(9)), exchange: f(10), currency: f(11), localSymbol: f(12), tradingClass: f(13),
      },
      execution: {
        orderId: num(f(2)), execId: f(14), time: f(15), acctNumber: f(16), exchange: f(17), side: f(18),
        shares: num(f(19)), price: num(f(20)), permId: num(f(21)), clientId: num(f(22)), liquidation: num(f(23)),
        cumQty: num(f(24)), avgPrice: num(f(25)), orderRef: f(26),
      },
    },
  };
}

/** 这里用得到的 socket 的那几样(测试塞一个假的进来)。 */
export interface HistorySocket {
  on(event: "connect" | "close", listener: () => void): unknown;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  write(data: Buffer): unknown;
  end(): unknown;
  destroy(): unknown;
}

export interface HistoryRequest {
  host: string;
  port: number;
  /** 这条连接自己的 client id(historyClientId 算出来的那个) */
  clientId: number;
  /** 往回要几天,1–7 */
  days: number;
  /** 整趟最多等多久,默认 8 秒 */
  timeoutMs?: number;
  /** 怎么连(测试注入) */
  connect?: (host: string, port: number) => HistorySocket;
}

export interface HistoryResult {
  /** 和 TWS 谈下来的接口版本 */
  serverVersion: number;
  /** TWS 给不给得了"最近几天"(版本够不够);给不了时 details 是空的,也没有发请求 */
  supported: boolean;
  details: ExecutionDetail[];
}

/** 连上 TWS,要最近几天的成交,关掉。失败(连不上、被拒、超时、TWS 报错)都抛一句人话。 */
export function fetchExecutionHistory(request: HistoryRequest): Promise<HistoryResult> {
  const days = Math.min(HISTORY_DAYS_MAX, Math.max(1, Math.trunc(request.days)));
  const reqId = 1;
  return new Promise<HistoryResult>((resolve, reject) => {
    const socket = (request.connect ?? ((host, port) => net.connect({ host, port })))(request.host, request.port);
    const details: ExecutionDetail[] = [];
    let pending: Buffer = Buffer.alloc(0);
    let serverVersion = 0;
    let asked = false;
    let done = false;
    /** TWS 没点名哪个请求的最近一条报错(21xx 是数据农场的通告,不算) */
    let notice = "";
    const timeoutMs = request.timeoutMs ?? 8_000;
    const timer = setTimeout(() => fail(`往回要成交等了 ${Math.round(timeoutMs / 1000)} 秒没有回应`), timeoutMs);

    const finish = (): boolean => {
      if (done) return false;
      done = true;
      clearTimeout(timer);
      return true;
    };
    const fail = (message: string): void => {
      if (!finish()) return;
      socket.destroy();
      reject(new Error(message));
    };
    const succeed = (supported: boolean): void => {
      if (!finish()) return;
      socket.end();
      resolve({ serverVersion, supported, details });
    };

    const onFrame = (fields: string[]): void => {
      if (serverVersion === 0) {
        // 握手的回话:[接口版本, 连接时刻]
        serverVersion = Math.trunc(Number(fields[0]));
        if (!Number.isFinite(serverVersion) || serverVersion < HISTORY_MIN_VERSION) return fail(`TWS 握手的回话认不出:${fields.join(" ").slice(0, 80)}`);
        if (serverVersion < HISTORY_MAX_VERSION) return succeed(false);
        socket.write(startApiBytes(request.clientId));
        return;
      }
      const id = Number(fields[0]);
      if ((id === IN_NEXT_VALID_ID || id === IN_MANAGED_ACCTS) && !asked) {
        // TWS 认了这条连接:可以发请求了
        asked = true;
        socket.write(executionsRequestBytes(reqId, days));
        return;
      }
      if (id === IN_EXECUTION_DATA) {
        const got = decodeExecution(fields);
        if (got === null) return fail(`成交消息的字段不够(${fields.length} 个),没有采用这一趟`);
        if (got.reqId === reqId) details.push(got.detail);
        return;
      }
      if (id === IN_EXECUTION_DATA_END) {
        if (Number(fields[2]) === reqId) succeed(true);
        return;
      }
      if (id === IN_ERR_MSG) {
        // 194 版起:[4, 请求号, 错误码, 说明, 详细拒单原因, 时刻]
        const code = Number(fields[2]);
        const text = `${fields[2] ?? ""} ${fields[3] ?? ""}`.trim().slice(0, 200);
        if (Number(fields[1]) === reqId) return fail(`TWS 拒了往回要成交的请求:${text}`);
        if (!(code >= 2100 && code < 2200)) notice = text;
      }
    };

    socket.on("connect", () => socket.write(handshakeBytes()));
    socket.on("data", (chunk) => {
      if (done) return;
      try {
        const cut = splitFrames(pending.length ? Buffer.concat([pending, chunk]) : chunk);
        pending = cut.rest;
        for (const fields of cut.frames) {
          if (done) return;
          onFrame(fields);
        }
      } catch (exc) {
        fail((exc as Error).message);
      }
    });
    socket.on("error", (err) => fail(`往回要成交的连接出错:${err.message}`));
    socket.on("close", () => fail(`往回要成交的连接被 TWS 关了${notice ? `:${notice}` : ""}`));
  });
}
