/** 「出场细则」那一组表单的纯逻辑(desktop/renderer-react/src/lib/trackExitForm.ts):表单 → tracker.add 的载荷、
 * 确认框里的话、卡片上的摘要。载荷再交给真的引擎走一遍,确认界面拼出来的东西引擎收得下、存成的是预想的样子。 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { pathToFileURL } from "node:url";

/** 表单里的那一组值(lib/trackExitForm.ts 的 ExitFields);这里照着写一份,引擎的 tsc 不跟进界面目录 */
interface ExitFields {
  exitAt: string; stopConfirm: number | null; stopBasis: "mid" | "natural";
  chaseGrace: number | null; chaseStep: number | null; chaseMax: number | null; peakConfirm: boolean;
  tiers: Array<{ price: number | null; fraction: number | null }>;
}
interface Tier { price: number; fraction_pct: number; pending?: boolean; done?: boolean }
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "desktop", "renderer-react", "src");
const load = async (file: string): Promise<unknown> => import(/* @vite-ignore */ pathToFileURL(path.join(SRC, "lib", file)).href);
const {
  MAX_TIERS, emptyExitFields, exitConfirmLines, exitProblems, exitSpec, exitSummary, tierLabel,
} = (await load("trackExitForm.ts")) as {
  MAX_TIERS: number;
  emptyExitFields: ExitFields;
  exitConfirmLines(f: ExitFields, derivative: boolean): string;
  exitProblems(f: ExitFields, opts: { hosted: boolean; hasSpotStop: boolean }): string[];
  exitSpec(f: ExitFields, derivative: boolean): Record<string, unknown>;
  exitSummary(targets: object, auto: object): string[];
  tierLabel(tier: Tier, index: number): string;
};
const { spotStopLine } = (await load("spotStopFormat.ts")) as {
  spotStopLine(symbol: string, row: { below: number | null; above: number | null; spot: number | null; pending?: { side: "below" | "above"; held_s: number; need_s: number } }): string;
};
import { RpcServer } from "../src/rpc.js";
import * as tk from "../src/tracker.js";
import { MAX_TP_TIERS } from "../src/trackerExits.js";

type Rec = Record<string, any>;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const F = (over: Partial<ExitFields>): ExitFields => ({ ...emptyExitFields, ...over });

describe("表单 → 载荷", () => {
  it("什么都没填:'' / undefined,和以前的载荷相比只多了几个空键", () => {
    expect(exitSpec(emptyExitFields, true)).toEqual({
      exit_at: "", spot_stop_confirm_s: "", take_profit_tiers: "", stop_basis: "mid",
      stop_chase_grace: undefined, stop_chase_step: undefined, stop_chase_max_pct: undefined, peak_confirm: undefined,
    });
  });

  it("填了的:数值照老规矩给字符串;0 是合法值不会被吞掉", () => {
    const spec = exitSpec(F({
      exitAt: " 15:45 ", stopConfirm: 3, stopBasis: "natural", chaseGrace: 0, chaseStep: 2, chaseMax: 25, peakConfirm: true,
      tiers: [{ price: 6, fraction: 34 }, { price: 9, fraction: 50 }],
    }), true);
    expect(spec).toEqual({
      exit_at: "15:45", spot_stop_confirm_s: "3", stop_basis: "natural", stop_chase_grace: "0", stop_chase_step: "2", stop_chase_max_pct: "25",
      peak_confirm: true, take_profit_tiers: [{ price: "6", fraction_pct: "34" }, { price: "9", fraction_pct: "50" }],
    });
    expect(exitConfirmLines(F({ peakConfirm: true }), true)).toBe("峰值要连续两秒都见到才往上推:跟踪止损与利润回撤的峰值晚一秒,只出现一秒的高点不算。\n");
    expect(exitConfirmLines(F({ peakConfirm: true }), false)).toBe("");
  });

  it("正股:可成交价、追价、确认秒数这几项一律不带(引擎会拒);到点平仓与分批止盈照带", () => {
    const spec = exitSpec(F({ exitAt: "15:45", stopConfirm: 3, stopBasis: "natural", chaseStep: 2, peakConfirm: true, tiers: [{ price: 130, fraction: 50 }] }), false);
    expect(spec).toEqual({
      exit_at: "15:45", spot_stop_confirm_s: "", stop_basis: undefined, stop_chase_grace: undefined, stop_chase_step: undefined,
      stop_chase_max_pct: undefined, peak_confirm: undefined, take_profit_tiers: [{ price: "130", fraction_pct: "50" }],
    });
  });

  it("只填了一半的档位不进载荷,但提交前会说", () => {
    const half = F({ tiers: [{ price: 6, fraction: null }] });
    expect(exitSpec(half, true).take_profit_tiers).toBe("");
    expect(exitProblems(half, { hosted: false, hasSpotStop: false })).toEqual(["分批止盈的每一档要把价和比例都填上。"]);
  });

  it("界面这头就能看出来的毛病", () => {
    const check = (f: Partial<ExitFields>, hosted = false, hasSpotStop = true): string[] => exitProblems(F(f), { hosted, hasSpotStop });
    expect(check({})).toEqual([]);
    expect(check({ exitAt: "1545" })).toEqual(["到点平仓的时刻要写成美东时间的 HH:MM,如 15:45。"]);
    expect(check({ exitAt: "9:30" })).toEqual([]);
    expect(check({ tiers: [{ price: 6, fraction: 34 }] }, true)).toEqual(["分批止盈只支持软件盯盘:托管到券商时不能设。"]);
    expect(check({ stopConfirm: 3 }, false, false)).toEqual(["确认秒数是给标的止损价用的:先填「标的跌到」或「标的涨到」。"]);
    expect(check({ stopConfirm: 0 }, false, false)).toEqual([]);
  });

  it("档数上限和引擎的是同一个数", () => {
    expect(MAX_TIERS).toBe(MAX_TP_TIERS);
  });
});

describe("确认框与卡片", () => {
  it("一样都没设:确认框里不多一个字", () => {
    expect(exitConfirmLines(emptyExitFields, true)).toBe("");
  });

  it("设了的每一样各一行,写在人点「确认」的那个框里", () => {
    const text = exitConfirmLines(F({
      exitAt: "15:45", stopConfirm: 3, stopBasis: "natural", chaseGrace: 0, chaseStep: 2, chaseMax: 25, tiers: [{ price: 6, fraction: 34 }],
    }), true);
    expect(text.split("\n")).toEqual([
      "到点平仓:下一次到美东 15:45 时持仓还在就平(不算止损);软件开着时才盯。",
      "分批止盈:第 1 档到 6 平 34%。每一档成交之后接着盯剩下的仓。",
      "标的止损要标的在线外连续待满 3 秒才平。",
      "止损、跟踪止损、利润回撤按「此刻立刻能成交的价」判(盘口变宽时会比按中间价判更早触发)。",
      "止损类触发后的追价:先等 0 秒,之后每秒让 2 跳,最多让到立刻成交价的 25%。",
      "",
    ]);
  });

  it("卡片摘要:没设的不出现;分批止盈写做完了几档", () => {
    expect(exitSummary({}, {})).toEqual([]);
    expect(exitSummary(tk.makeTargets({}), tk.makeAutoClose({}))).toEqual([]);
    const targets = tk.makeTargets({
      exit_at: "15:45", exit_at_ms: Date.parse("2026-09-11T15:45:00-04:00"), spot_stop_confirm_s: 3,
      take_profit_tiers: [{ price: 6, fraction_pct: 34, done: true }, { price: 9, fraction_pct: 50, pending: true }],
    });
    const auto = tk.makeAutoClose({ stop_basis: "natural", stop_chase_grace: 0, stop_chase_max_pct: 25, peak_confirm: true });
    // 到点平仓写的是换算出来的那一刻(带日期):钟点今天已经过了的,看得出是明天
    expect(exitSummary(targets, auto)).toEqual([
      "到点平仓 美东 09-11 15:45", "分批止盈 1/2 档", "标的止损确认 3 秒", "止损按可成交价判", "峰值两秒确认", "止损追价 等 0 秒 / 每秒 1 跳 / 最多 25%",
    ]);
    // 时刻被引擎清掉了(到点那天没平掉,这一次作废):照实写
    expect(exitSummary({ ...targets, exit_at_ms: null }, {})[0]).toBe("到点平仓 美东 15:45(已过期,不会再触发)");
    expect((targets.take_profit_tiers ?? []).map((t, i) => tierLabel(t, i))).toEqual(["第 1 档 6 平 34%(已成交)", "第 2 档 9 平 50%(平仓单已发,等成交)"]);
    expect(tierLabel({ price: 12.5, fraction_pct: 100 }, 2)).toBe("第 3 档 12.5 平 100%(未到)");
  });

  it("盯盘那一行:越线之后在等确认时,最前面先说这件事", () => {
    const row = { below: 7700, above: null, spot: 7698.5, pending: { side: "below" as const, held_s: 2, need_s: 3 } };
    expect(spotStopLine("SPX", row)).toBe("标的止损:已跌破止损线,持续 2 秒,满 3 秒才平 · SPX 现价 7698.50,跌到 7700 就平(还差 -1.50 点)");
    expect(spotStopLine("SPX", { below: 7700, above: null, spot: 7720 })).toBe("标的止损:SPX 现价 7720.00,跌到 7700 就平(还差 20.00 点)");
  });
});

// ---------------------------------------------------------------- 载荷交给真的引擎
const servers: RpcServer[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.anomaly.stop();
    s.engineBuilt?.stopTrackerLoop();
  }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("界面拼出来的载荷,引擎收得下", () => {
  const stock: Rec = {
    key: tk.makeKey("模拟", "BE", "STK"), account: "模拟", symbol: "BE", sec_type: "STK", leg: "", quantity: 100,
    avg_cost: 100, multiplier: 1, currency: "USD", market_price: 120, market_value: 12000, unrealized_pnl: 2000,
    contract: { secType: "STK", symbol: "BE" },
  };

  function server(): (method: string, params: Rec) => Promise<Rec> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-exitform-"));
    dirs.push(dir);
    const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ ...base, storage: { db_path: path.join(dir, "t.db") } }));
    const s = new RpcServer(settingsPath, () => undefined);
    s.router = {
      BROKER: "ibkr", SUPPORTS_HOSTED_CLOSE: true, sessions: () => [{}], connectedNames: () => ["paper"],
      positions: async () => [{ ...stock }], indexPrice: async () => 120, spotInfo: () => null,
    } as never;
    servers.push(s);
    return async (method, params) => s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
  }

  /** lib/TrackForm.tsx 的 start() 拼的那一份(正股) */
  const payload = (exits: ExitFields): Rec => ({
    key: stock["key"], take_profit: "", stop_loss: "95", trail_pct: "", profit_drawdown_pct: "", profit_drawdown_preset: undefined,
    profit_drawdown_arm_pct: "", spot_target: "", spot_stop_below: "", spot_stop_above: "", close_fraction_pct: undefined,
    chase_max_pct: undefined, auto_close: false, order_type: "MKT", host_at_broker: false, ...exitSpec(exits, false),
  });

  it("空的出场细则:建得成,四个新目标都是 null", async () => {
    const out = await server()("tracker.add", payload(emptyExitFields));
    expect(out["error"]).toBeUndefined();
    expect(out["result"]["track"]["targets"]).toMatchObject({ exit_at: null, exit_at_ms: null, spot_stop_confirm_s: null, take_profit_tiers: null });
  });

  it("到点平仓 + 两档分批止盈:存成数字与下一次到这个钟点的时刻", async () => {
    const out = await server()("tracker.add", payload(F({ exitAt: "15:45", tiers: [{ price: 130, fraction: 50 }, { price: 140, fraction: 100 }] })));
    expect(out["error"]).toBeUndefined();
    const targets = out["result"]["track"]["targets"];
    expect(targets["exit_at"]).toBe("15:45");
    expect(targets["exit_at_ms"]).toBeGreaterThan(Date.now());
    expect(targets["take_profit_tiers"]).toEqual([{ price: 130, fraction_pct: 50 }, { price: 140, fraction_pct: 100 }]);
  });
});
