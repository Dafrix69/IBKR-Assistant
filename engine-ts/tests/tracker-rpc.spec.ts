/** tracker.* / positions.list 在 RPC 这一层的特征测试:**输入就是界面真实发出来的载荷形状**。
 *
 * 为什么要有这一份:盯盘、托管、追价的逻辑在引擎层测得很细(hosted / sweep / spot-target / tracker-loop),
 * 但那些测试都绕过了 RPC 入参这一段——而 tracker.add 是在**授权软件自动发单**。界面发过来的载荷里,数值字段
 * 全是字符串(`str(tp)`),空串表示"不设"(见 Tracker.tsx 的 start())。这一段要是解析错了:
 *   · 拒掉字符串 → 真应用里一条追踪都建不了,而引擎层的测试一路绿灯(和 2026-09-10 漏白名单是同一类事故);
 *   · 把 '' 当成 0 → 一个设在 0 的止损;
 *   · 悄悄丢掉一个键 → 追踪建成了,那道保护却没设上,用户以为设上了。
 * 给这个域的入参加 schema、迁进 contract/ 之前,这份测试必须先在;迁的时候它不许改一个断言。
 *
 * 假券商只记下收到的单,不连任何真东西。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { setClock } from "../src/config.js";
import { RpcServer } from "../src/rpc.js";
import * as tk from "../src/tracker.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, any>;

/** 2026-09-11(周五,交易日)美东 12:00,盘中。 */
const NOON = Date.parse("2026-09-11T12:00:00-04:00");

class FakeRouter {
  SUPPORTS_HOSTED_CLOSE = true;
  SUPPORTS_NATIVE_CONDITIONS = true;
  BROKER = "ibkr";
  upstreamOk = true;
  sent: Rec[] = [];
  constructor(public rows: Rec[]) {}
  sessions(): unknown[] { return [{}]; }
  connectedNames(): string[] { return ["paper"]; }
  async positions(): Promise<Rec[]> { return this.rows.map((r) => ({ ...r })); }
  async indexPrice(): Promise<number | null> { return null; }
  async optionQuotes(): Promise<Rec> { return {}; }
  async listHostedOpen(): Promise<Rec[]> { return []; }
  async place(recordId: string, approved: Rec): Promise<Rec> {
    this.sent.push(approved);
    return { record_id: recordId, order_id: 990, perm_id: null, status: "Submitted", limit_price: null, detail: {} };
  }
  async legQuotes(): Promise<unknown[]> { return []; }
  async cancelAllOpen(): Promise<number> { return 0; }
  async contractHours(): Promise<null> { return null; }
  cachedContractHours(): null { return null; }
}

/** 模拟账户里 100 股 BE:成本 100,现价 120。 */
const stock = (over: Rec = {}): Rec => ({
  key: tk.makeKey("模拟", "BE", "STK"), account: "模拟", symbol: "BE", sec_type: "STK", leg: "", quantity: 100,
  avg_cost: 100, multiplier: 1, currency: "USD", market_price: 120, market_value: 12000, unrealized_pnl: 2000,
  contract: { secType: "STK", symbol: "BE" }, ...over,
});
const KEY = stock()["key"] as string;

/**
 * Tracker.tsx 的 start() 拼出来的载荷,原样:数值都是字符串,'' = 不设;没填的可选项是 undefined
 * (过 JSON 之后就是没有这个键)。
 */
const ui = (over: Rec): Rec => ({
  key: KEY, take_profit: "", stop_loss: "", trail_pct: "", profit_drawdown_pct: "", profit_drawdown_preset: undefined,
  spot_target: "", close_fraction_pct: undefined, chase_max_pct: undefined, auto_close: false, order_type: "MKT",
  host_at_broker: false, ...over,
});

const servers: RpcServer[] = [];
const dirs: string[] = [];

function makeServer(opts: { autoExecute?: boolean; rows?: Rec[] } = {}): { s: RpcServer; router: FakeRouter; call: (m: string, p?: Rec) => Promise<Rec> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-trk-rpc-"));
  dirs.push(dir);
  const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({
    ...base,
    policies: { ...base.policies, auto_execute: opts.autoExecute ?? false },
    storage: { db_path: path.join(dir, "t.db") },
  }));
  const s = new RpcServer(settingsPath, () => undefined);
  const router = new FakeRouter(opts.rows ?? [stock()]);
  s.router = router as never;
  servers.push(s);
  // 过一遍 JSON:和真的 stdio 一样,undefined 的键在路上就没了
  const call = async (method: string, params: Rec = {}): Promise<Rec> =>
    s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
  return { s, router, call };
}

afterEach(() => {
  setClock(null);
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

// ---------------------------------------------------------------- tracker.add:界面的载荷
describe("tracker.add:界面发来的数值是字符串,'' 是不设", () => {
  it("止损 '95':存成数字 95;其余 '' 一律是 null(不是 0);auto_close 补齐默认值", async () => {
    const { s, call } = makeServer();
    const out = await call("tracker.add", ui({ stop_loss: "95" }));
    expect(out["error"]).toBeUndefined();
    const track = out["result"]["track"];
    // 现状:新建的回执里 enabled 是数字 1(回的是刚拼的那一行,没过读库的转换),tracker.list 里同一条是 true——
    // 和 alerts.create 同一个毛病。界面按真假用;要统一得连 golden 一起动,所以这里如实钉住。
    expect(track).toMatchObject({ account: "模拟", symbol: "BE", sec_type: "STK", enabled: 1, peak: 120 });
    expect(s.engine.store.getTrack(track["id"])!["enabled"]).toBe(true);
    expect(track["targets"]).toEqual({
      take_profit: null, stop_loss: 95, trail_pct: null, profit_drawdown_pct: null,
      profit_drawdown_tiers: null, profit_drawdown_late: null, spot_target: null,
    });
    expect(track["auto_close"]).toMatchObject({
      enabled: false, order_type: "MKT", slippage_pct: 0.3, close_fraction_pct: 100, host_at_broker: false,
    });
    // 库里读回来是同一份:回执不是另拼的
    expect(s.engine.store.getTrack(track["id"])!["targets"]).toEqual(track["targets"]);
  });

  it("四个数一起填:每个字符串各进各的字段,一个不丢", async () => {
    const { call } = makeServer();
    const out = await call("tracker.add", ui({ take_profit: "140.5", stop_loss: "95", trail_pct: "8", profit_drawdown_pct: "40" }));
    expect(out["result"]["track"]["targets"]).toEqual({
      take_profit: 140.5, stop_loss: 95, trail_pct: 8, profit_drawdown_pct: 40,
      profit_drawdown_tiers: null, profit_drawdown_late: null, spot_target: null,
    });
  });

  it("自动平仓那一组:开关、限价、平一半;追价上限填 '0' 就是 0(合法值,不能被当成没填)", async () => {
    const { call } = makeServer();
    const out = await call("tracker.add", ui({
      stop_loss: "95", auto_close: true, order_type: "LMT", close_fraction_pct: "50", chase_max_pct: "0",
    }));
    expect(out["error"]).toBeUndefined();
    expect(out["result"]["track"]["auto_close"]).toMatchObject({
      enabled: true, order_type: "LMT", close_fraction_pct: 50, chase_max_pct: 0, host_at_broker: false,
    });
  });

  it("order_type 只认 'LMT',别的一律当市价;没填分数就是 100%", async () => {
    const { call } = makeServer();
    const auto = (await call("tracker.add", ui({ stop_loss: "95", auto_close: true, order_type: "whatever" })))["result"]["track"]["auto_close"];
    expect(auto).toMatchObject({ enabled: true, order_type: "MKT", close_fraction_pct: 100 });
  });

  it("分档利润回撤的 fly 预设:三档 40 / 30 / 20,15:00 之后收紧一半", async () => {
    const { call } = makeServer();
    const targets = (await call("tracker.add", ui({ profit_drawdown_preset: "fly" })))["result"]["track"]["targets"];
    expect(targets["profit_drawdown_tiers"]).toEqual([{ above: 0, pct: 40 }, { above: 1, pct: 30 }, { above: 3, pct: 20 }]);
    expect(targets["profit_drawdown_late"]).toEqual({ after: "15:00", factor: 0.5 });
    expect(targets["profit_drawdown_pct"]).toBeNull();
  });

  it("自己列档位:{above, pct} 数组与尾盘收紧原样进库", async () => {
    const { call } = makeServer();
    const out = await call("tracker.add", ui({
      profit_drawdown_tiers: [{ above: "0", pct: "35" }, { above: 2, pct: 25 }],
      profit_drawdown_late: { after: "15:30", factor: "0.6" },
    }));
    expect(out["error"]).toBeUndefined();
    expect(out["result"]["track"]["targets"]).toMatchObject({
      profit_drawdown_tiers: [{ above: 0, pct: 35 }, { above: 2, pct: 25 }],
      profit_drawdown_late: { after: "15:30", factor: 0.6 },
    });
  });

  it("标的目标价 '130':进 spot_target;止盈价留空(两者只能选一个)", async () => {
    const { call } = makeServer();
    const out = await call("tracker.add", ui({ spot_target: "130" }));
    expect(out["error"]).toBeUndefined();
    expect(out["result"]["track"]["targets"]).toMatchObject({ spot_target: 130, take_profit: null, stop_loss: null });
  });

  it("托管到券商:host_at_broker 原样进库(IBKR 账户才能开);滑点给了就用给的", async () => {
    const { call } = makeServer();
    const out = await call("tracker.add", { ...ui({ stop_loss: "95", auto_close: true, order_type: "LMT", host_at_broker: true }), slippage_pct: "0.5" });
    expect(out["error"]).toBeUndefined();
    expect(out["result"]["track"]["auto_close"]).toMatchObject({ enabled: true, order_type: "LMT", host_at_broker: true, slippage_pct: 0.5 });
  });

  it("备注截到 200 字", async () => {
    const { call } = makeServer();
    const track = (await call("tracker.add", { ...ui({ stop_loss: "95" }), note: "长".repeat(300) }))["result"]["track"];
    expect([...String(track["note"])]).toHaveLength(200);
  });
});

describe("tracker.add:该拒的当场拒,话要说清楚", () => {
  const errorOf = async (params: Rec, rows?: Rec[]): Promise<{ code: number; message: string }> =>
    (await makeServer({ rows }).call("tracker.add", params))["error"];

  it("一个目标都没设(全是 '')", async () => {
    expect(await errorOf(ui({}))).toEqual({
      code: -32602, message: "至少要设一个:止盈价、止损价、跟踪止损百分比,或标的目标价。",
    });
  });

  it("方向填反:多头的止损在现价上方", async () => {
    const err = await errorOf(ui({ stop_loss: "130" }));
    expect(err.code).toBe(-32602);
    expect(err.message).toBe("多头的止损价要低于现价(现价 120.0000,你填了 130.0000)——填在上方会立刻触发。");
  });

  it("止盈价和标的目标价都填了", async () => {
    const err = await errorOf(ui({ take_profit: "140", spot_target: "130" }));
    expect(err.code).toBe(-32602);
    expect(err.message).toMatch(/^止盈价和标的目标价只能选一个/);
  });

  it("不是数字的字符串:报出原话,不当成没填", async () => {
    expect(await errorOf(ui({ stop_loss: "abc" }))).toEqual({ code: -32602, message: "不是有效数字:'abc'" });
  });

  it("持仓已经不在了", async () => {
    expect(await errorOf({ ...ui({ stop_loss: "95" }), key: "模拟|GONE|STK" })).toEqual({
      code: -32602, message: "找不到这个持仓(可能刚刚被平掉了),请刷新持仓列表。",
    });
  });

  it("同一份持仓不能追踪两次", async () => {
    const { call } = makeServer();
    expect((await call("tracker.add", ui({ stop_loss: "95" })))["error"]).toBeUndefined();
    expect((await call("tracker.add", ui({ stop_loss: "90" })))["error"]).toEqual({
      code: -32602, message: "已经在追踪 模拟 的 BE 了",
    });
  });

  it("没连券商:-32018,指到连接面板", async () => {
    const { s, call } = makeServer();
    s.router = null;
    const err = (await call("tracker.add", ui({ stop_loss: "95" })))["error"];
    expect(err["code"]).toBe(-32018);
    expect(err["message"]).toMatch(/请先在「TWS 连接」面板连接引擎/);
  });

  it("分档写错:pct 超出 (0, 100]", async () => {
    const err = await errorOf(ui({ profit_drawdown_tiers: [{ above: 0, pct: 0 }] }));
    expect(err).toEqual({ code: -32602, message: "分档的 pct 要在 0(不含)到 100 之间,当前 0" });
  });
});

// ---------------------------------------------------------------- tracker.update
describe("tracker.update", () => {
  async function tracked(): Promise<{ call: (m: string, p?: Rec) => Promise<Rec>; id: string; s: RpcServer }> {
    const { s, call } = makeServer();
    const id = (await call("tracker.add", ui({ stop_loss: "95", auto_close: true, order_type: "LMT", host_at_broker: false })))["result"]["track"]["id"];
    return { call, id, s };
  }

  it("界面只用它切启停:{id, enabled};重新启用会把上一次触发的闩解开", async () => {
    const { call, id, s } = await tracked();
    s.engine.store.updateTrack(id, { fired_at: "2026-09-11T16:00:00+00:00", fired_state: "stop_loss", fired_record: "rec-1" });
    const off = (await call("tracker.update", { id, enabled: false }))["result"]["track"];
    expect(off).toMatchObject({ enabled: false, fired_state: "stop_loss" }); // 停用不动那道闩
    const on = (await call("tracker.update", { id, enabled: true }))["result"]["track"];
    expect(on).toMatchObject({ enabled: true, fired_at: null, fired_state: "", fired_record: "" });
  });

  it("改目标:同样是字符串;要把五个目标字段一起给('' = 清掉),给一个算全给", async () => {
    const { call, id } = await tracked();
    const out = await call("tracker.update", { id, take_profit: "140", stop_loss: "96", trail_pct: "", profit_drawdown_pct: "", spot_target: "" });
    expect(out["result"]["track"]["targets"]).toEqual({
      take_profit: 140, stop_loss: 96, trail_pct: null, profit_drawdown_pct: null,
      profit_drawdown_tiers: null, profit_drawdown_late: null, spot_target: null,
    });
    // 现状:只给一个目标字段,其余四个按"没填"算,等于被清掉——不是"只改这一个"
    const only = await call("tracker.update", { id, stop_loss: "97" });
    expect(only["result"]["track"]["targets"]).toMatchObject({ stop_loss: 97, take_profit: null });
  });

  it("改目标走和新建同一套校验:方向反了照样拒,库里不动", async () => {
    const { call, id, s } = await tracked();
    const err = (await call("tracker.update", { id, stop_loss: "130", take_profit: "", trail_pct: "", profit_drawdown_pct: "", spot_target: "" }))["error"];
    expect(err["code"]).toBe(-32602);
    expect(err["message"]).toMatch(/^多头的止损价要低于现价/);
    expect(s.engine.store.getTrack(id)!["targets"]["stop_loss"]).toBe(95);
  });

  it("现状(界面目前不这么用):auto_close 是整份替换,不是合并——没带的键就没了,读的时候靠默认值补", async () => {
    const { call, id, s } = await tracked();
    expect(s.engine.store.getTrack(id)!["auto_close"]).toMatchObject({ enabled: true, order_type: "LMT", slippage_pct: 0.3 });
    const out = await call("tracker.update", { id, auto_close: { enabled: true, close_fraction_pct: 50 } });
    expect(out["result"]["track"]["auto_close"]).toEqual({ enabled: true, close_fraction_pct: 50 });
    // 读的那一头:makeAutoClose 补默认——order_type 从 LMT 回到了 MKT。谁要改这个行为,得是有意的
    expect(tk.makeAutoClose(out["result"]["track"]["auto_close"])).toMatchObject({ order_type: "MKT", slippage_pct: 0.3, host_at_broker: false });
  });

  it("没有要改的字段 / 没有这个追踪", async () => {
    const { call, id } = await tracked();
    expect((await call("tracker.update", { id }))["error"]).toEqual({ code: -32602, message: "没有要改的字段" });
    expect((await call("tracker.update", { id: "nope", enabled: true }))["error"]).toEqual({ code: -32602, message: "没有这个追踪" });
  });
});

// ---------------------------------------------------------------- 只读的三个
describe("positions.list / tracker.list / tracker.target_preview", () => {
  it("positions.list:券商给了盈亏就用券商的;tracked 跟着追踪表走", async () => {
    const { call } = makeServer();
    let rows = (await call("positions.list"))["result"]["positions"] as Rec[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: KEY, symbol: "BE", quantity: 100, market_price: 120, unrealized_pnl: 2000, pnl_source: "broker", tracked: false });
    await call("tracker.add", ui({ stop_loss: "95" }));
    rows = (await call("positions.list"))["result"]["positions"] as Rec[];
    expect(rows[0]!["tracked"]).toBe(true);
  });

  it("positions.list:券商没给盈亏就本地按同一套口径算,并标明是算的", async () => {
    const { call } = makeServer({ rows: [stock({ unrealized_pnl: null, market_value: null })] });
    const row = ((await call("positions.list"))["result"]["positions"] as Rec[])[0]!;
    expect(row).toMatchObject({ unrealized_pnl: 2000, unrealized_pct: 20, market_value: 12000, pnl_source: "computed" });
  });

  it("positions.list:休市没有现价,按昨收另给一份 close_pnl,不冒充此刻的盈亏", async () => {
    const { call } = makeServer({ rows: [stock({ market_price: null, unrealized_pnl: null, market_value: null, close_price: 110 })] });
    const row = ((await call("positions.list"))["result"]["positions"] as Rec[])[0]!;
    expect(row).toMatchObject({ close_pnl: 1000, close_pct: 10, unrealized_pnl: null, pnl_source: null });
  });

  it("tracker.target_preview:目标价同样是字符串;正股的预计价就是目标价本身", async () => {
    const { call } = makeServer();
    const out = (await call("tracker.target_preview", { key: KEY, spot_target: "130", chase_max_pct: undefined }))["result"];
    expect(out["structure"]).toEqual({ kind: "stock", label: "正股" });
    expect(out["spot_target"]).toMatchObject({
      spot_target: 130, spot: 120, price: 130, pnl: 3000, pnl_pct: 30, sigma_source: "none", reached: false,
    });
    expect((await call("tracker.target_preview", { key: KEY, spot_target: "" }))["error"]).toEqual({
      code: -32602, message: "要给一个标的目标价 spot_target。",
    });
    expect((await call("tracker.target_preview", { key: KEY, spot_target: "abc" }))["error"]).toEqual({
      code: -32602, message: "不是有效数字:'abc'",
    });
  });

  it("tracker.poll:一行 = 追踪设置 + 这一轮的现价与状态;带节拍器心跳", async () => {
    setClock(NOON);
    const { call } = makeServer();
    const id = (await call("tracker.add", ui({ stop_loss: "95" })))["result"]["track"]["id"];
    const out = (await call("tracker.poll"))["result"];
    expect(out["fired"]).toEqual([]);
    expect(out["blocked"]).toEqual([]);
    expect(out["loop"]).toMatchObject({ interval_ms: 1000 });
    expect((out["rows"] as Rec[])[0]).toMatchObject({
      id, symbol: "BE", state: "holding", price: 120, unrealized_pnl: 2000, unrealized_pct: 20, pnl_source: "broker",
      stop_effective: 95, to_stop_pct: -20.833, trail_stop: null,
    });
  });
});

// ---------------------------------------------------------------- tracker.close_now / delete
describe("tracker.close_now:手动平仓走和自动平仓同一条路,同一套闸门", () => {
  it("盘中、模拟账户、自动执行开着:发出一张卖出 100 股的平仓单,记上这条追踪", async () => {
    setClock(NOON);
    const { call, router } = makeServer({ autoExecute: true });
    const id = (await call("tracker.add", ui({ stop_loss: "95" })))["result"]["track"]["id"];
    const out = await call("tracker.close_now", { id });
    expect(out["error"]).toBeUndefined();
    expect(out["result"]["fired"]).toMatchObject({ id, symbol: "BE", state: "stop_loss", reason: "手动平仓", order_id: 990 });
    expect(router.sent).toHaveLength(1);
    // 交给券商的是一张和指令路径同形的已批准订单:order.order 是下单参数,order.contract 是合约
    const approved = router.sent[0]!;
    expect(approved["order"]["order"]).toMatchObject({ action: "SELL", orderType: "MKT", totalQuantity: 100, tif: "DAY" });
    expect(approved["order"]["contract"]).toMatchObject({ symbol: "BE", secType: "STK" });
    expect(approved["order"]["execution_type"]).toBe("IMMEDIATE");
    expect(approved["account"]).toMatchObject({ alias: "模拟", is_paper: true });
    expect(approved["signature"]).toBe(`tracker:${id}`);
  });

  it("平一半:close_fraction_pct '50' → 卖 50 股", async () => {
    setClock(NOON);
    const { call, router } = makeServer({ autoExecute: true });
    const id = (await call("tracker.add", ui({ stop_loss: "95", auto_close: true, close_fraction_pct: "50" })))["result"]["track"]["id"];
    expect((await call("tracker.close_now", { id }))["error"]).toBeUndefined();
    expect(router.sent[0]!["order"]["order"]).toMatchObject({ action: "SELL", totalQuantity: 50 });
    expect(router.sent[0]!["order"]["intent_summary"]).toBe("止损平仓:卖出 50 BE(市价,平 50/100)");
  });

  it("「允许自动执行」没开:拒,一张单都不发", async () => {
    setClock(NOON);
    const { call, router } = makeServer({ autoExecute: false });
    const id = (await call("tracker.add", ui({ stop_loss: "95" })))["result"]["track"]["id"];
    const err = (await call("tracker.close_now", { id }))["error"];
    expect(err["code"]).toBe(-32019);
    expect(err["message"]).toMatch(/^不能平仓:/);
    expect(router.sent).toEqual([]);
  });

  it("持仓已经不在了 / 没有这个追踪", async () => {
    setClock(NOON);
    const { call, router } = makeServer({ autoExecute: true });
    const id = (await call("tracker.add", ui({ stop_loss: "95" })))["result"]["track"]["id"];
    router.rows = [];
    expect((await call("tracker.close_now", { id }))["error"]).toEqual({ code: -32602, message: "这个持仓已经不在了。" });
    expect((await call("tracker.close_now", { id: "nope" }))["error"]).toEqual({ code: -32602, message: "没有这个追踪" });
    expect(router.sent).toEqual([]);
  });

  it("tracker.delete:删掉就不再盯;再删一次报没有", async () => {
    const { call } = makeServer();
    const id = (await call("tracker.add", ui({ stop_loss: "95" })))["result"]["track"]["id"];
    expect((await call("tracker.delete", { id }))["result"]).toEqual({ deleted: true });
    expect((await call("tracker.list"))["result"]["tracks"]).toEqual([]);
    expect((await call("tracker.delete", { id }))["error"]).toEqual({ code: -32602, message: "没有这个追踪" });
  });
});
