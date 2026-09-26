/** 利润回撤的起算门槛(profit_drawdown_arm_pct → Targets.profit_drawdown_arm)。
 *
 * 2026-09-26 全天演练里看到的:固定百分比的利润回撤没有门槛,刚开仓浮盈只有几分钱时,30% 的回撤就是
 * 一分钱的波动——四组随机路径里多头那条都在开头两分钟内被平掉。蝶式分档已经有自己的激活线
 * (d371d7b),这里把同一道闸开放给固定百分比:界面填 %,存成倍数,判断走同一个 drawdownArmed。
 * 托管到券商的利润回撤停损单也按它:没过门槛不挂——挂上去券商侧就会在浮盈几分钱时触发。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import * as fx from "../src/flyexit.js";
import { RpcServer } from "../src/rpc.js";
import * as tk from "../src/tracker.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, any>;

class FakeRouter {
  SUPPORTS_HOSTED_CLOSE = true;
  SUPPORTS_NATIVE_CONDITIONS = true;
  BROKER = "ibkr";
  upstreamOk = true;
  constructor(public rows: Rec[]) {}
  sessions(): unknown[] { return [{}]; }
  connectedNames(): string[] { return ["paper"]; }
  async positions(): Promise<Rec[]> { return this.rows.map((r) => ({ ...r })); }
  async indexPrice(): Promise<number | null> { return null; }
  async optionQuotes(): Promise<Rec> { return {}; }
  async listHostedOpen(): Promise<Rec[]> { return []; }
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
/** 界面 TrackForm.start() 发出来的样子:数值全是字符串,'' = 不设 */
const ui = (over: Rec): Rec => ({
  key: KEY, take_profit: "", stop_loss: "", trail_pct: "", profit_drawdown_pct: "", profit_drawdown_preset: undefined,
  profit_drawdown_arm_pct: "", spot_target: "", close_fraction_pct: undefined, chase_max_pct: undefined,
  auto_close: false, order_type: "MKT", host_at_broker: false, ...over,
});

const servers: RpcServer[] = [];
function makeServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-ddarm-"));
  const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ ...base, storage: { db_path: path.join(dir, "t.db") } }));
  const s = new RpcServer(settingsPath, () => undefined);
  s.router = new FakeRouter([stock()]) as never;
  servers.push(s);
  const call = async (method: string, params: Rec = {}): Promise<Rec> =>
    s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
  return { s, call };
}
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.anomaly.stop();
    s.engineBuilt?.stopTrackerLoop();
  }
});

describe("tracker.add / update:起算门槛从界面进来", () => {
  it("'10' → 存成倍数 0.1;'' → null(不设,和加门槛之前一样)", async () => {
    const { call } = makeServer();
    const a = await call("tracker.add", ui({ profit_drawdown_pct: "30", profit_drawdown_arm_pct: "10" }));
    expect(a["error"]).toBeUndefined();
    expect(a["result"]["track"]["targets"]).toMatchObject({ profit_drawdown_pct: 30, profit_drawdown_arm: 0.1, profit_drawdown_floor: null });
    const { call: call2 } = makeServer();
    const b = await call2("tracker.add", ui({ profit_drawdown_pct: "30" }));
    expect(b["result"]["track"]["targets"]["profit_drawdown_arm"]).toBeNull();
  });

  it("0、负数、超过 1000% 当场拒,报人话;不认识的写法照 optFloat 报「不是有效数字」", async () => {
    for (const bad of ["0", "-5", "1001"]) {
      const { call } = makeServer();
      const out = await call("tracker.add", ui({ profit_drawdown_pct: "30", profit_drawdown_arm_pct: bad }));
      expect(out["error"]?.["message"], bad).toMatch(/起算门槛/);
    }
    const { call } = makeServer();
    expect((await call("tracker.add", ui({ profit_drawdown_pct: "30", profit_drawdown_arm_pct: "abc" })))["error"]).toBeDefined();
  });

  it("蝶式预设用它自己那道激活线,不看界面填的门槛", async () => {
    const { call } = makeServer();
    const out = await call("tracker.add", ui({ profit_drawdown_preset: "fly", profit_drawdown_arm_pct: "50" }));
    expect(out["error"]).toBeUndefined();
    expect(out["result"]["track"]["targets"]["profit_drawdown_arm"]).toBe(0.3);
  });

  it("tracker.update 只改门槛也会重建目标(以前这个键不在触发列表里,改了等于没改)", async () => {
    const { call } = makeServer();
    const id = (await call("tracker.add", ui({ profit_drawdown_pct: "30" })))["result"]["track"]["id"];
    const out = await call("tracker.update", { id, profit_drawdown_pct: "30", profit_drawdown_arm_pct: "15" });
    expect(out["error"]).toBeUndefined();
    const listed = (await call("tracker.list"))["result"]["tracks"].find((t: Rec) => t["id"] === id);
    expect(listed["targets"]["profit_drawdown_arm"]).toBeCloseTo(0.15, 10);
  });
});

const long = tk.makePosition({ account: "模拟", symbol: "BE", sec_type: "STK", quantity: 100, avg_cost: 100, multiplier: 1 });
const short = tk.makePosition({ account: "模拟", symbol: "BE", sec_type: "STK", quantity: -100, avg_cost: 100, multiplier: 1 });

describe("盯盘判断:没过门槛不按回撤平", () => {
  const targets = tk.makeTargets({ profit_drawdown_pct: 30, profit_drawdown_arm: 0.1 });

  it("多头:峰值只赚 5%(没过 10%),回吐 60% 也不平;界面读作「未激活」", () => {
    const r = tk.evaluate(long, targets, 102, 105);
    expect(r.state).toBe(tk.STATE_HOLDING);
    expect(r.profit_drawdown_threshold).toBeNull();
    expect(r.profit_trail_stop).toBeNull();
    // 同样的走势不设门槛:当场平——这正是门槛要挡的那一下
    expect(tk.evaluate(long, tk.makeTargets({ profit_drawdown_pct: 30 }), 102, 105).state).toBe(tk.STATE_PROFIT_TRAIL);
  });

  it("多头:峰值到过 12%(过了门槛)之后回吐到 30% 就平;回落到门槛以下也照样算已激活", () => {
    expect(tk.evaluate(long, targets, 109, 112).state).toBe(tk.STATE_HOLDING); // 回吐 25%
    const r = tk.evaluate(long, targets, 108, 112); // 回吐 33%
    expect(r.state).toBe(tk.STATE_PROFIT_TRAIL);
    expect(tk.evaluate(long, targets, 103, 112).state).toBe(tk.STATE_PROFIT_TRAIL); // 浮盈只剩 3%,门槛是按峰值算的
  });

  it("空头:跌了才赚,门槛同样按峰值浮盈 / |成本|", () => {
    expect(tk.evaluate(short, targets, 98, 95).state).toBe(tk.STATE_HOLDING);       // 峰值赚 5%
    expect(tk.evaluate(short, targets, 93, 88).state).toBe(tk.STATE_PROFIT_TRAIL); // 峰值赚 12%,回吐 42%
  });
});

describe("托管到券商:没过门槛不挂利润回撤停损单", () => {
  const auto = tk.makeAutoClose({ enabled: true, host_at_broker: true });
  const kinds = (peak: number, arm: number | null) =>
    tk.hostedPlan(long, tk.makeTargets({ profit_drawdown_pct: 30, profit_drawdown_arm: arm }), auto, peak).map((p) => p.kind);

  it("峰值只赚 5%:不挂;峰值赚 12%:挂,停损价 = 成本 + 峰值利润 × 70%", () => {
    expect(kinds(105, 0.1)).not.toContain(tk.HOSTED_KIND_PTRAIL);
    const plan = tk.hostedPlan(long, tk.makeTargets({ profit_drawdown_pct: 30, profit_drawdown_arm: 0.1 }), auto, 112);
    const ptrail = plan.find((p) => p.kind === tk.HOSTED_KIND_PTRAIL);
    expect(ptrail?.aux_price).toBeCloseTo(108.4, 6);
  });

  it("不设门槛:和以前一样,一盈利就挂", () => {
    expect(kinds(105, null)).toContain(tk.HOSTED_KIND_PTRAIL);
  });
});

// ---------------------------------------------------------------- 蝶式按金额起算
/** 一组 7600/7615/7630 看跌蝶的三条腿;腿成本含乘数,净成本 300 − 2×200 + 325 = $225 / 组 */
function flyLegs(units = 1): Rec[] {
  const legs: Array<[number, number, number]> = [[7600, 1, 300], [7615, -2, 200], [7630, 1, 325]];
  return legs.map(([strike, q, cost]) => {
    const contract = { secType: "OPT", symbol: "SPX", lastTradeDateOrContractMonth: "20260901", strike, right: "P", multiplier: "100" };
    const ident = tk.legOf(contract);
    return {
      key: tk.makeKey("模拟", "SPX", "OPT", ident), account: "模拟", symbol: "SPX", sec_type: "OPT", leg: ident,
      label: tk.positionLabel("SPX", "OPT", contract), quantity: q * units, avg_cost: cost, multiplier: 100,
      currency: "USD", market_price: null, market_value: null, unrealized_pnl: null, contract,
    };
  });
}

describe("蝶式预设按金额起算:每组浮盈 $100 起追、$200 收紧", () => {
  it("换算:$225 的蝶 → 激活线 100/225,$200 那条线 200/225 让 30%,3 倍成本让 20%", () => {
    const p = fx.drawdownUsdPreset(225)!;
    expect(p.arm).toBeCloseTo(100 / 225, 6);
    expect(p.tiers).toEqual([{ above: 0, pct: 40 }, { above: 0.888889, pct: 30 }, { above: 3, pct: 20 }]);
  });

  it("便宜的蝶($50):3 倍成本不到 $200,那一档不要(否则先紧后松)", () => {
    const p = fx.drawdownUsdPreset(50)!;
    expect(p.arm).toBe(2);
    expect(p.tiers).toEqual([{ above: 0, pct: 40 }, { above: 4, pct: 30 }]);
  });

  it("成本算不出来:回 null,调用方退回按比例的预设", () => {
    expect(fx.drawdownUsdPreset(null)).toBeNull();
    expect(fx.drawdownUsdPreset(0)).toBeNull();
  });

  it("RPC:在组合持仓上勾蝶式预设 → 存的是按这只蝶成本换算的线;正股上勾仍是按比例(见 tracker-rpc.spec)", async () => {
    const { s, call } = makeServer();
    const legs = flyLegs();
    (s.router as unknown as FakeRouter).rows = legs;
    const fly = tk.withCombos(legs).find((r) => r["sec_type"] === "BAG")!;
    const out = await call("tracker.add", ui({ key: fly["key"], profit_drawdown_preset: "fly" }));
    expect(out["error"]).toBeUndefined();
    const t = out["result"]["track"]["targets"];
    expect(t["profit_drawdown_arm"]).toBeCloseTo(100 / 225, 6);
    expect(t["profit_drawdown_tiers"]).toEqual(fx.drawdownUsdPreset(225)!.tiers);
    expect(t["profit_drawdown_late"]).toEqual(fx.drawdownLate(null));
    expect(t["profit_drawdown_floor"]).toBe(fx.drawdownFloor(null));
  });

  const flyPos = (units: number) => tk.makePosition({
    account: "模拟", symbol: "SPX", sec_type: "BAG", quantity: units, avg_cost: 225, multiplier: 100,
  });
  const preset = tk.makeTargets({
    profit_drawdown_tiers: fx.drawdownUsdPreset(225)!.tiers, profit_drawdown_late: fx.drawdownLate(null),
    profit_drawdown_arm: fx.drawdownUsdPreset(225)!.arm, profit_drawdown_floor: fx.drawdownFloor(null),
  });

  it("峰值只赚 $95(没到 $100):回吐到 $60 也不平", () => {
    expect(tk.evaluate(flyPos(1), preset, 2.85, 3.20).state).toBe(tk.STATE_HOLDING);
  });

  it("峰值赚过 $105:让 40%,赚 $70 时拿着、赚 $60 时平", () => {
    expect(tk.evaluate(flyPos(1), preset, 2.95, 3.30).state).toBe(tk.STATE_HOLDING);
    expect(tk.evaluate(flyPos(1), preset, 2.85, 3.30).state).toBe(tk.STATE_PROFIT_TRAIL);
  });

  it("峰值赚过 $205:收紧到 30%,赚 $145 时拿着、赚 $140 时平", () => {
    expect(tk.evaluate(flyPos(1), preset, 3.70, 4.30).state).toBe(tk.STATE_HOLDING);
    const r = tk.evaluate(flyPos(1), preset, 3.65, 4.30);
    expect(r.state).toBe(tk.STATE_PROFIT_TRAIL);
    expect(r.profit_drawdown_threshold).toBe(30);
  });

  it("$100 是按每组算:两组的仓,合计赚 $190(每组 $95)不起算,合计 $210 起算", () => {
    expect(tk.evaluate(flyPos(2), preset, 2.85, 3.20).state).toBe(tk.STATE_HOLDING);
    expect(tk.evaluate(flyPos(2), preset, 2.85, 3.30).state).toBe(tk.STATE_PROFIT_TRAIL);
  });
});
