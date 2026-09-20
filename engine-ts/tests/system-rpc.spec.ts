/** system.status / system.selftest 与 breaker.state / halt / resume 在 RPC 这一层的特征测试。
 *
 * 这五样是状态条和那颗红按钮的全部数据来源,却一直钉在 contract.spec 的 LEGACY 名单里(入参与返回还是 `Rec`)。
 * 迁进契约之前先把**现在的行为**写下来:status 有哪些字段、熔断那三样各回什么、halt 为什么要和盯盘互斥、
 * 券商炸了的时候闸是不是照样合上。先于契约迁移写成,迁的时候不改断言。
 *
 * 全部离线:券商是假的,不连任何端口、不发任何单。熔断只动内存里的闸与本地库。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { BrokerError } from "../src/broker.js";
import { RpcServer } from "../src/rpc.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, any>;

/** 假券商:熔断要它撤单,状态条要它报连没连上。一张真单都不发。 */
class FakeRouter {
  upstreamOk = true;
  cancelCalls = 0;
  cancelFail: Error | null = null;
  spots: Record<string, Rec> = {};
  /** 谁先谁后:盯盘那一轮和熔断撤单各往里记一笔 */
  readonly order: string[] = [];
  sessions(): unknown[] { return [{}]; }
  connectedNames(): string[] { return ["paper"]; }
  spotInfo(symbol: string): Rec | null { return this.spots[symbol] ?? null; }
  async cancelAllOpen(): Promise<number> {
    this.order.push("cancel");
    this.cancelCalls += 1;
    if (this.cancelFail !== null) throw this.cancelFail;
    return 3;
  }
  async indexPrice(): Promise<number | null> { return null; }
}

const servers: RpcServer[] = [];
const dirs: string[] = [];

function makeServer(opts: { connected?: boolean } = {}): {
  s: RpcServer; router: FakeRouter; call: (m: string, p?: Rec) => Promise<Rec>;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-sys-rpc-"));
  dirs.push(dir);
  const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
  const settingsPath = path.join(dir, "settings.json");
  // 挂两个指数:一个缓存里有价、一个没有。只有一个的话"没价就不塞进去"那条分支走不到
  const indexSymbols = { ...base.index_symbols, NDX: { exchange: "NASDAQ", daily_trading_class: "NDXP", monthly_trading_class: "NDX" } };
  fs.writeFileSync(settingsPath, JSON.stringify({
    ...base, index_symbols: indexSymbols, storage: { db_path: path.join(dir, "t.db") },
  }));
  const s = new RpcServer(settingsPath, () => undefined);
  const router = new FakeRouter();
  if (opts.connected ?? true) s.router = router as never;
  servers.push(s);
  const call = async (method: string, params: Rec = {}): Promise<Rec> =>
    s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
  return { s, router, call };
}

afterEach(() => {
  for (const s of servers.splice(0)) {
    s.anomaly.stop();
    s.engineBuilt?.stopTrackerLoop();
  }
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上 sqlite 句柄可能还占着 */
    }
  }
});

describe("system.status", () => {
  it("状态条要的那一份快照:字段一个不少,都是界面读得懂的形状", async () => {
    const { call } = makeServer();
    const out = (await call("system.status"))["result"];
    expect(Object.keys(out).sort()).toEqual([
      "accounts", "allow_live_trading", "auto_execute", "breaker", "broker_connected", "broker_provider",
      "broker_upstream_ok", "index_spot", "limits", "market_status", "model", "now_et", "pending_count",
      "prompt_fingerprint", "prompt_version", "protections", "protocol", "tracker_loop",
    ].sort());
    // 时刻是 ET 的墙钟串,不是 ISO——界面直接显示
    expect(out["now_et"]).toHaveLength(19);
    expect(out["now_et"][4]).toBe("-");
    expect(out["now_et"][10]).toBe(" ");
    expect(out["protocol"]).toBe("1.0"); // 串,不是数字:界面拿它比版本
    expect(typeof out["market_status"]).toBe("string");
    expect(typeof out["prompt_version"]).toBe("string");
    expect(typeof out["prompt_fingerprint"]).toBe("string");
    expect(typeof out["model"]).toBe("string");
    expect(typeof out["auto_execute"]).toBe("boolean");
    expect(typeof out["allow_live_trading"]).toBe("boolean");
    expect(Array.isArray(out["accounts"])).toBe(true);
    expect(typeof out["pending_count"]).toBe("number");
  });

  it("熔断那一块只给界面三样(不带 at),限额六项按名字给", async () => {
    const { call } = makeServer();
    const out = (await call("system.status"))["result"];
    expect(Object.keys(out["breaker"]).sort()).toEqual(["consecutive_failures", "engaged", "reason"]);
    // 没合闸时 reason 是空串不是 null(killswitch 那边没有状态文件就给这一份)
    expect(out["breaker"]).toEqual({ engaged: false, reason: "", consecutive_failures: 0 });
    expect(Object.keys(out["limits"]).sort()).toEqual([
      "duplicate_window_minutes", "max_mkt_shares", "max_option_contracts", "max_order_notional",
      "max_spread_slippage", "min_confidence",
    ]);
    for (const v of Object.values(out["limits"])) expect(typeof v).toBe("number");
  });

  it("连上券商:broker_connected 真、upstream 跟着券商走", async () => {
    const { call, router } = makeServer();
    expect((await call("system.status"))["result"]["broker_connected"]).toBe(true);
    expect((await call("system.status"))["result"]["broker_upstream_ok"]).toBe(true);
    router.upstreamOk = false;
    expect((await call("system.status"))["result"]["broker_upstream_ok"]).toBe(false);
  });

  it("没连券商:connected 假,但 upstream_ok 是真——没连不等于上游坏了", async () => {
    const { call } = makeServer({ connected: false });
    const out = (await call("system.status"))["result"];
    expect(out["broker_connected"]).toBe(false);
    expect(out["broker_upstream_ok"]).toBe(true);
    expect(out["index_spot"]).toEqual({});
  });

  it("index_spot 只转出缓存里有价的那几只:没价的那只连键都不出现,一个请求都不发", async () => {
    const { call, router } = makeServer();
    // 配了 SPX 和 NDX 两个指数,只有 SPX 的缓存里有价
    router.spots["SPX"] = { price: 5600.25, source: "index", note: "" };
    const out = (await call("system.status"))["result"];
    expect(Object.keys(out["index_spot"])).toEqual(["SPX"]);
    expect("NDX" in out["index_spot"]).toBe(false); // 塞一个 null 进去,界面就是一格空白
    expect(out["index_spot"]["SPX"]["price"]).toBe(5600.25);
  });

  it("tracker_loop:十项齐全(没在跑 / 太久没跳 / 上一轮报错都要当场看得见)", async () => {
    const { s, call } = makeServer();
    // 写成 `engineBuilt ? … : null` 是防御性的,实际上问不到 null:同一个方法体在前面读过
    // this.engine(拿熔断状态),引擎那时就已经建起来了。类型上仍按可空登记。
    expect(s.engineBuilt).toBeNull();
    const hb = (await call("system.status"))["result"]["tracker_loop"];
    expect(hb).not.toBeNull();
    expect(Object.keys(hb).sort()).toEqual([
      "age_ms", "event_loop_last_ms", "event_loop_worst_ms", "interval_ms", "last_error", "last_ms", "max_ms",
      "running", "slow_ticks", "ticks",
    ]);
    expect(typeof hb["running"]).toBe("boolean");
    expect(typeof hb["ticks"]).toBe("number");
  });

  it("protections:五项摘要,没触发时 paused 假、冷却表空——到点自己解除,所以带解除时刻", async () => {
    const { call } = makeServer();
    const p = (await call("system.status"))["result"]["protections"];
    expect(Object.keys(p).sort()).toEqual(["cooldowns", "paused", "reason", "rule", "until_ms"]);
    expect(p["paused"]).toBe(false);
    expect(p["until_ms"]).toBeNull();
    expect(p["cooldowns"]).toEqual([]);
  });
});

describe("system.selftest", () => {
  it("提示词自检:版本、指纹、字数、few-shot 对数、别名表、账户", async () => {
    const { call } = makeServer();
    const out = (await call("system.selftest"))["result"];
    expect(Object.keys(out).sort()).toEqual([
      "accounts", "fewshot_pairs", "prompt_fingerprint", "prompt_version", "symbol_aliases", "system_prompt_chars",
    ]);
    expect(typeof out["prompt_version"]).toBe("string");
    expect(out["system_prompt_chars"]).toBeGreaterThan(0);
    expect(typeof out["fewshot_pairs"]).toBe("number");
    expect(typeof out["symbol_aliases"]).toBe("object");
    expect(Array.isArray(out["accounts"])).toBe(true);
  });

  it("字数按码点数算(现有提示词里没有代理对,所以这一条钉的是口径,不是一个看得见的差)", async () => {
    const { s, call } = makeServer();
    const out = (await call("system.selftest"))["result"];
    const text = s.engine.bundle.system_text;
    expect(out["system_prompt_chars"]).toBe([...text].length);
    // 中文是 BMP,一个字一个 UTF-16 单元——两种算法只在 emoji / 扩展 B 区这类代理对上才分家。
    // 现有九版提示词一个都没有,所以换成 text.length 是个等价变异,测不出来;真有人往提示词里放 emoji
    // 的那天,这一行会先红。
    expect(text.length).toBe([...text].length);
  });

  it("指纹和 system.status 报的是同一份", async () => {
    const { call } = makeServer();
    const st = (await call("system.status"))["result"];
    const se = (await call("system.selftest"))["result"];
    expect(se["prompt_fingerprint"]).toBe(st["prompt_fingerprint"]);
    expect(se["prompt_version"]).toBe(st["prompt_version"]);
  });
});

describe("breaker.*", () => {
  it("state:没合闸时四样都是空的(带 at,和 system.status 里那份不一样)", async () => {
    const { call } = makeServer();
    const out = (await call("breaker.state"))["result"];
    expect(Object.keys(out).sort()).toEqual(["at", "consecutive_failures", "engaged", "reason"]);
    expect(out).toEqual({ engaged: false, reason: "", at: "", consecutive_failures: 0 });
  });

  it("halt:合闸 + 撤单,回执里带撤了几张", async () => {
    const { call, router } = makeServer();
    const out = (await call("breaker.halt", { reason: "手滑了" }))["result"];
    expect(out["engaged"]).toBe(true);
    expect(out["cancelled"]).toBe(3);
    expect(router.cancelCalls).toBe(1);
    const state = (await call("breaker.state"))["result"];
    expect(state["engaged"]).toBe(true);
    expect(state["reason"]).toBe("手滑了");
    expect(typeof state["at"]).toBe("string");
  });

  it("halt 不给理由就用界面那句默认的", async () => {
    const { call } = makeServer();
    await call("breaker.halt");
    expect((await call("breaker.state"))["result"]["reason"]).toBe("用户在界面上按下暂停");
  });

  it("halt:券商撤单炸了,闸照样合上,回执里带一句 warning——这是安全兜底,不是失败", async () => {
    const { call, router } = makeServer();
    router.cancelFail = new BrokerError("TWS 连接断了");
    const out = (await call("breaker.halt", { reason: "撤不动也要停" }))["result"];
    expect(out["engaged"]).toBe(true);
    expect(out["cancelled"]).toBe(0);
    expect(out["warning"]).toBe("TWS 连接断了");
    expect((await call("breaker.state"))["result"]["engaged"]).toBe(true);
  });

  it("halt:券商那边抛的不是 BrokerError 就照实报错(不吞别人的异常)", async () => {
    const { call, router } = makeServer();
    router.cancelFail = new TypeError("这是个 bug,不是券商的问题");
    const res = await call("breaker.halt");
    expect(res["error"]).toBeDefined();
    expect(String(res["error"]["message"])).toContain("bug");
  });

  it("resume:松闸,回执只有一个 engaged: false,并且记一条审计", async () => {
    const { s, call } = makeServer();
    await call("breaker.halt", { reason: "先停" });
    const out = (await call("breaker.resume"))["result"];
    expect(out).toEqual({ engaged: false });
    expect((await call("breaker.state"))["result"]["engaged"]).toBe(false);
    // 审计是只增的:合闸、松闸两条都要留痕(库里 audit_log 有触发器挡改和删)
    const audits = (s.engine.store as unknown as { exportAll(): Rec }).exportAll()["audit_log"] as Rec[];
    expect(audits.map((a) => a["action"])).toEqual(["halt", "resume"]);
    expect(audits[1]!["actor"]).toBe("ui");
  });

  it("halt 走的是盯盘那把锁:一轮盯盘没跑完,熔断撤单要排在它后面——否则撤完单又挂出一张托管单", async () => {
    const { s, router, call } = makeServer();
    const held = (s as unknown as { trackerLock: (fn: () => Promise<unknown>) => Promise<unknown> })
      .trackerLock(async () => {
        await new Promise((r) => setTimeout(r, 30));
        router.order.push("tick"); // 这一轮盯盘跑完了
      });
    const halted = call("breaker.halt", { reason: "排在盯盘后面" });
    await Promise.all([held, halted]);
    // 顺序是判据本身:撤单必须在那一轮之后。不拿锁的话 cancel 会插到 tick 前面
    expect(router.order).toEqual(["tick", "cancel"]);
  });
});
