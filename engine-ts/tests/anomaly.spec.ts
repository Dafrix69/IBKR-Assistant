/** 优质股异动检测(纯函数)。
 *
 * 这条路上会让人错过行情或者被刷屏的地方,每一个都在下面钉死:
 *  1. 量比的分母。当日量只跟同一条流的均量 × 同时段常态比;开盘竞价、收盘竞价那两格不许拿来判放量。
 *  2. 不刷屏。档位一天一次、一次跨多档只报最高那档;窗口信号滞回 + 冷却;换日才重置。
 *  3. 基准会变。hist_vol 可能盘中才到,档位按序号记,切到 σ 基准不能把同一档再报一遍。
 *  4. 单位。IB 的量有时按手(×100)给——所有信号都是比值,量同乘 100 结果必须一模一样。
 */
import { describe, expect, it } from "vitest";

import * as an from "../src/anomaly.js";

type Snap = an.VolumeSnapshot;
type Result = ReturnType<typeof an.evaluateAnomalies>;

const CFG = an.DEFAULT_ANOMALY_CONFIG;
const DAY = "2026-09-11";
/** 2026-09-11(周五)09:30 ET = 13:30 UTC */
const OPEN_MS = Date.UTC(2026, 8, 11, 13, 30);
const AVG = 1_000_000;

const msAt = (minute: number): number => OPEN_MS + minute * 60_000;
const secAt = (minute: number): number => Math.round(msAt(minute) / 1000);
const cum = (minute: number, session?: number): number => an.cumVolumeFraction(minute, session);

function snapOf(over: Partial<Snap> = {}): Snap {
  return { last: 101, close: 100, volume: null, avg_volume: null, hist_vol: null, ...over };
}

interface Run {
  minute: number;
  snap?: Partial<Snap>;
  samples?: an.Sample[];
  state?: an.AnomalyState | null;
  config?: an.AnomalyConfig;
  session?: number;
  etDate?: string;
}

function run(o: Run): Result {
  return an.evaluateAnomalies({
    symbol: "RKLB",
    snap: snapOf(o.snap),
    samples: o.samples ?? [],
    state: o.state ?? null,
    nowMs: msAt(o.minute),
    etDate: o.etDate ?? DAY,
    minute: o.minute,
    ...(o.session !== undefined ? { sessionMinutes: o.session } : {}),
    config: o.config ?? CFG,
  });
}

const ofKind = (r: Result, kind: an.AnomalyKind): an.AnomalyEvent[] => r.events.filter((e) => e.kind === kind);
const kindsOf = (r: Result): string[] => r.events.map((e) => e.kind);

/** 当日量正好是同时段常态的 ratio 倍 */
const volumeAt = (minute: number, ratio: number, session?: number): number => ratio * AVG * cum(minute, session);

/** 窗口场景:W 分钟前一条样本 + 本轮样本;窗口量 = ratio × 同时段常态(按均量)。价格默认不动。 */
function windowCase(
  minute: number, ratio: number,
  o: { W?: number; v0?: number; from?: number; to?: number } = {},
): { samples: an.Sample[]; snap: Partial<Snap> } {
  const W = o.W ?? 5;
  const from = o.from ?? 101;
  const to = o.to ?? from;
  const v0 = o.v0 ?? 400_000;
  const v1 = v0 + ratio * AVG * (cum(minute) - cum(minute - W));
  // 窗口里均匀铺 10 步(真实引擎 5 秒一轮,一个窗口约 60 步):量与价线性走,最大一步只占十分之一,
  // 不会被当成一笔大单(见 MIN_BURST_STEPS / block_share)
  const STEPS = 10;
  const samples: an.Sample[] = [];
  for (let i = 0; i <= STEPS; i += 1) {
    const f = i / STEPS;
    samples.push({ t: msAt(minute - W + W * f), volume: v0 + (v1 - v0) * f, last: from + (to - from) * f });
  }
  return { samples, snap: { volume: v1, avg_volume: AVG, last: to, close: to } };
}

/** 只动价格的窗口场景(没有量,不会触发放量类);昨收 = 现价,不会触发大涨大跌。 */
function moveCase(minute: number, from: number, to: number, hv: number | null = null, W = 5) {
  return {
    samples: [
      { t: msAt(minute - W), volume: null, last: from },
      { t: msAt(minute), volume: null, last: to },
    ] as an.Sample[],
    snap: { last: to, close: to, hist_vol: hv } as Partial<Snap>,
  };
}

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === "object") {
    for (const v of Object.values(obj)) deepFreeze(v);
    Object.freeze(obj);
  }
  return obj;
}

// ---------------------------------------------------------------- 常数与曲线
describe("日内成交量曲线", () => {
  it("78 格原样、和为 1;时刻常数与规格一致", () => {
    expect(an.SLOT_FRACTIONS).toHaveLength(78);
    expect(an.SLOT_FRACTIONS[0]).toBe(0.06609);
    expect(an.SLOT_FRACTIONS[77]).toBe(0.0727);
    expect(an.SLOT_FRACTIONS.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
    expect(an.RTH_MINUTES).toBe(390);
    expect(an.VOLUME_END_MINUTE).toBe(385);
    expect(an.RVOL_MIN_MINUTE).toBe(15);
    expect(an.BURST_MIN_MINUTE).toBe(6);
    expect(an.SPIKE_MIN_MINUTE).toBe(15);
  });

  it("端点:开盘 0、收盘 1;盘前为 0、盘后为 1;NaN 当 0", () => {
    expect(cum(0)).toBe(0);
    expect(cum(-30)).toBe(0);
    expect(cum(Number.NaN)).toBe(0);
    expect(cum(390)).toBe(1);
    expect(cum(600)).toBe(1);
    expect(cum(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it("单调不减,且收盘前严格小于 1", () => {
    let prev = 0;
    for (let m = 0; m <= 390; m += 0.25) {
      const v = cum(m);
      expect(v).toBeGreaterThanOrEqual(prev);
      if (m < 390) expect(v).toBeLessThan(1);
      prev = v;
    }
  });

  it("格边界等于前几格之和(按和归一),格内线性插值", () => {
    const total = an.SLOT_FRACTIONS.reduce((a, b) => a + b, 0);
    const [a, b, c] = an.SLOT_FRACTIONS as [number, number, number];
    expect(cum(5)).toBeCloseTo(a / total, 12);
    expect(cum(15)).toBeCloseTo((a + b + c) / total, 12);
    expect(cum(2.5)).toBeCloseTo(a / total / 2, 12);
    expect(cum(12.5)).toBeCloseTo((a + b + c / 2) / total, 12);
    // 最后一格(收盘竞价)占 7% 多:15:55 到 16:00 这一段曲线是陡的
    expect(1 - cum(385)).toBeCloseTo(an.SLOT_FRACTIONS[77]! / total, 12);
  });

  it("半日市:整条曲线按 210/390 压缩,收盘即 1", () => {
    for (const m of [1, 8, 30, 105, 150, 207]) {
      expect(cum(m, 210)).toBeCloseTo(cum((m * 390) / 210), 12);
    }
    expect(cum(210, 210)).toBe(1);
    expect(cum(209.99, 210)).toBeLessThan(1);
    expect(cum(105, 210)).toBeCloseTo(cum(195), 12);
  });

  it("session 非法(0 / 负数 / NaN)按 390 算", () => {
    for (const bad of [0, -210, Number.NaN]) expect(cum(100, bad)).toBe(cum(100));
  });
});

// ---------------------------------------------------------------- 样本
describe("pushSample:升序、同 t 覆盖、裁旧、不改入参", () => {
  it("追加并保持升序;乱序到来的样本插到该在的位置", () => {
    let s: an.Sample[] = [];
    s = an.pushSample(s, { t: 1000, volume: 1, last: 10 });
    s = an.pushSample(s, { t: 3000, volume: 3, last: 30 });
    s = an.pushSample(s, { t: 2000, volume: 2, last: 20 });
    expect(s.map((x) => x.t)).toEqual([1000, 2000, 3000]);
  });

  it("同 t 覆盖,不重复", () => {
    const s = an.pushSample([{ t: 1000, volume: 1, last: 10 }], { t: 1000, volume: 9, last: 90 });
    expect(s).toEqual([{ t: 1000, volume: 9, last: 90 }]);
  });

  it("默认只留最新样本 20 分钟以内的;keepMs 可调", () => {
    const base = [0, 5, 10, 19, 21].map((m) => ({ t: msAt(m), volume: m, last: 100 }));
    const s = an.pushSample(base, { t: msAt(25), volume: 25, last: 100 });
    expect(s.map((x) => x.volume)).toEqual([5, 10, 19, 21, 25]);
    const short = an.pushSample(base, { t: msAt(25), volume: 25, last: 100 }, 5 * 60_000);
    expect(short.map((x) => x.volume)).toEqual([21, 25]);
  });

  it("返回新数组,入参不动;非有限 t 的样本不收", () => {
    const base = deepFreeze([{ t: 1000, volume: 1, last: 10 }]);
    const s = an.pushSample(base as an.Sample[], { t: 2000, volume: 2, last: 20 });
    expect(s).not.toBe(base);
    expect(base).toHaveLength(1);
    expect(an.pushSample(s, { t: Number.NaN, volume: 3, last: 30 })).toEqual(s);
  });

  it("量价里的 NaN / Infinity 记成 null", () => {
    const s = an.pushSample([], { t: 1, volume: Number.NaN, last: Number.POSITIVE_INFINITY });
    expect(s).toEqual([{ t: 1, volume: null, last: null }]);
  });
});

// ---------------------------------------------------------------- 状态
describe("freshState / coerceState:库里读回什么都不抛", () => {
  it("freshState:档位清零、两个窗口信号都上膛", () => {
    expect(an.freshState(DAY)).toEqual({
      date: DAY, rvol_fired: 0, day_up_fired: 0, day_down_fired: 0, max_step_share: 0,
      burst: { armed: true, last_fired_at: null }, spike: { armed: true, last_fired_at: null },
    });
  });

  for (const [why, raw] of [
    ["null", null],
    ["undefined", undefined],
    ["数字", 42],
    ["坏 JSON 串", "{not json"],
    ["数组", [1, 2, 3]],
    ["JSON 数组串", "[1,2]"],
    ["空对象", {}],
  ] as Array<[string, unknown]>) {
    it(`${why} → 全新状态`, () => {
      expect(an.coerceState(raw, DAY)).toEqual(an.freshState(DAY));
    });
  }

  it("正常状态原样往返(JSON 序列化再读回)", () => {
    const state: an.AnomalyState = {
      date: "2026-09-10", rvol_fired: 3, day_up_fired: 2, day_down_fired: 1, max_step_share: 0.031,
      burst: { armed: false, last_fired_at: 1_789_000_000 }, spike: { armed: true, last_fired_at: 1_788_999_000 },
    };
    expect(an.coerceState(JSON.parse(JSON.stringify(state)), DAY)).toEqual(state);
    expect(an.coerceState(JSON.stringify(state), DAY)).toEqual(state);
  });

  it("字段类型不对就取默认;日期缺了用传入的日期", () => {
    const got = an.coerceState({
      rvol_fired: "3", day_up_fired: -1, day_down_fired: 2.7,
      burst: "armed", spike: { armed: "yes", last_fired_at: "123" },
    }, DAY);
    expect(got).toEqual({
      date: DAY, rvol_fired: 0, day_up_fired: 0, day_down_fired: 2, max_step_share: 0,
      burst: { armed: true, last_fired_at: null }, spike: { armed: true, last_fired_at: null },
    });
  });

  it("NaN / Infinity / 空日期 也不抛", () => {
    const got = an.coerceState({
      date: "", rvol_fired: Number.NaN, day_up_fired: Number.POSITIVE_INFINITY,
      burst: { armed: false, last_fired_at: Number.NaN }, spike: null,
    }, DAY);
    expect(got).toEqual({
      date: DAY, rvol_fired: 0, day_up_fired: 0, day_down_fired: 0, max_step_share: 0,
      burst: { armed: false, last_fired_at: null }, spike: { armed: true, last_fired_at: null },
    });
  });

  it("只纠类型、不管换日:昨天的状态保留昨天的日期,由 evaluate 去重置", () => {
    expect(an.coerceState({ date: "2026-09-10", rvol_fired: 5 }, DAY).date).toBe("2026-09-10");
  });
});

// ---------------------------------------------------------------- 配置
describe("normalizeAnomalyConfig", () => {
  it("默认值与规格一致;null / undefined → base 的副本(改副本不动默认)", () => {
    expect(CFG).toEqual({
      rvol_tiers: [2, 3, 5], burst_ratio: 4, window_min: 5, spike_sigma: 4, spike_min_pct: 1.0,
      spike_fixed_pct: 1.5, day_sigma_tiers: [2, 3, 4], day_fixed_tiers: [3, 5, 8], cooldown_min: 10,
    });
    const a = an.normalizeAnomalyConfig(null);
    const b = an.normalizeAnomalyConfig(undefined);
    expect(a).toEqual(CFG);
    expect(b).toEqual(CFG);
    a.rvol_tiers.push(9);
    expect(CFG.rvol_tiers).toEqual([2, 3, 5]);
  });

  it("只改传了的键,其余取 base;未知键忽略", () => {
    const got = an.normalizeAnomalyConfig({ burst_ratio: 6, window_min: 10, whatever: 1 });
    expect(got).toEqual({ ...CFG, burst_ratio: 6, window_min: 10 });
    expect(got).not.toHaveProperty("whatever");
    const base = { ...CFG, cooldown_min: 30 };
    expect(an.normalizeAnomalyConfig({ spike_sigma: 3 }, base)).toEqual({ ...base, spike_sigma: 3 });
  });

  it("档位乱序、重复 → 升序去重;数字串也认", () => {
    const got = an.normalizeAnomalyConfig({ rvol_tiers: [5, 2, 3, 3], day_fixed_tiers: ["8", 3, 5], burst_ratio: "6" });
    expect(got.rvol_tiers).toEqual([2, 3, 5]);
    expect(got.day_fixed_tiers).toEqual([3, 5, 8]);
    expect(got.burst_ratio).toBe(6);
  });

  it("边界值本身合法", () => {
    const got = an.normalizeAnomalyConfig({
      rvol_tiers: [1.2, 50], burst_ratio: 1.5, window_min: 3, spike_sigma: 20, spike_min_pct: 0.1,
      spike_fixed_pct: 30, day_sigma_tiers: [0.5, 20], day_fixed_tiers: [0.5, 50], cooldown_min: 240,
    });
    expect(got.rvol_tiers).toEqual([1.2, 50]);
    expect(got.cooldown_min).toBe(240);
  });

  for (const [why, raw, hint] of [
    ["全天量比档位低于 1.2", { rvol_tiers: [1.1, 3] }, "全天量比档位"],
    ["全天量比档位高于 50", { rvol_tiers: [2, 51] }, "全天量比档位"],
    ["全天量比档位是空数组", { rvol_tiers: [] }, "全天量比档位"],
    ["全天量比档位超过 5 个", { rvol_tiers: [2, 3, 4, 5, 6, 7] }, "全天量比档位"],
    ["全天量比档位不是数组", { rvol_tiers: "2,3" }, "全天量比档位"],
    ["全天量比档位里有非数字", { rvol_tiers: [2, "x"] }, "全天量比档位"],
    ["窗口量比太小", { burst_ratio: 1.4 }, "窗口量比"],
    ["窗口量比太大", { burst_ratio: 51 }, "窗口量比"],
    ["窗口量比是布尔", { burst_ratio: true }, "窗口量比"],
    ["窗口不是 3/5/10", { window_min: 4 }, "窗口只能是"],
    ["窗口是 0", { window_min: 0 }, "窗口只能是"],
    ["σ 倍数太小", { spike_sigma: 1.4 }, "σ 倍数"],
    ["σ 倍数太大", { spike_sigma: 21 }, "σ 倍数"],
    ["最低幅度太小", { spike_min_pct: 0.05 }, "最低幅度"],
    ["最低幅度太大", { spike_min_pct: 21 }, "最低幅度"],
    ["固定急涨急跌阈值太小", { spike_fixed_pct: 0.1 }, "急涨急跌阈值"],
    ["固定急涨急跌阈值太大", { spike_fixed_pct: 31 }, "急涨急跌阈值"],
    ["σ 档位太小", { day_sigma_tiers: [0.4] }, "σ 档位"],
    ["σ 档位太大", { day_sigma_tiers: [2, 21] }, "σ 档位"],
    ["σ 档位是空数组", { day_sigma_tiers: [] }, "σ 档位"],
    ["固定档位太小", { day_fixed_tiers: [0.4] }, "大涨大跌档位"],
    ["固定档位太大", { day_fixed_tiers: [3, 51] }, "大涨大跌档位"],
    ["冷却太短", { cooldown_min: 0.5 }, "冷却时间"],
    ["冷却太长", { cooldown_min: 241 }, "冷却时间"],
    ["整个不是对象(字符串)", "rvol=2", "格式不对"],
    ["整个不是对象(数组)", [1, 2], "格式不对"],
  ] as Array<[string, unknown, string]>) {
    it(`越界抛 AnomalyError:${why}`, () => {
      expect(() => an.normalizeAnomalyConfig(raw)).toThrow(an.AnomalyError);
      expect(() => an.normalizeAnomalyConfig(raw)).toThrow(hint);
    });
  }
});

// ---------------------------------------------------------------- 全天量比
describe("rvol:全天量比按档报,每档一天一次", () => {
  it("一次跨多档只报最高那档;文案、方向、档位", () => {
    const r = run({ minute: 60, snap: { volume: volumeAt(60, 3.52), avg_volume: AVG } });
    expect(kindsOf(r)).toEqual(["rvol"]);
    const e = r.events[0]!;
    expect(e).toMatchObject({
      id: `RKLB:rvol:up:3:${secAt(60)}`, at: secAt(60), symbol: "RKLB", kind: "rvol", direction: "up",
      threshold: 3, tier: 3, sigma: null, price: 101, change_pct: 1, basis: "avg_volume",
      title: "RKLB 放量 3.5×",
      text: "当日成交量已达同时段常态的 3.5×(第 3× 档),现价 101(+1.00%)",
    });
    expect(e.value).toBeCloseTo(3.52, 4);
    expect(r.state.rvol_fired).toBe(3);
    expect(r.metrics.rvol).toBeCloseTo(3.52, 4);
  });

  it("同档不重报,升到更高档再报", () => {
    const first = run({ minute: 60, snap: { volume: volumeAt(60, 3.52), avg_volume: AVG } });
    const same = run({ minute: 61, snap: { volume: volumeAt(61, 4.4), avg_volume: AVG }, state: first.state });
    expect(same.events).toEqual([]);
    expect(same.state.rvol_fired).toBe(3);
    const higher = run({ minute: 90, snap: { volume: volumeAt(90, 5.3), avg_volume: AVG }, state: same.state });
    expect(higher.events.map((e) => e.tier)).toEqual([5]);
    const top = run({ minute: 120, snap: { volume: volumeAt(120, 9), avg_volume: AVG }, state: higher.state });
    expect(top.events).toEqual([]);
  });

  it("换日重置:昨天报过最高档,今天照样重新报", () => {
    const yesterday = { ...an.freshState("2026-09-10"), rvol_fired: 5 };
    const r = run({ minute: 60, snap: { volume: volumeAt(60, 3.52), avg_volume: AVG }, state: yesterday });
    expect(r.events.map((e) => e.tier)).toEqual([3]);
    expect(r.state.date).toBe(DAY);
    // 同一天的状态沿用:不重报
    const today = { ...an.freshState(DAY), rvol_fired: 5 };
    expect(run({ minute: 60, snap: { volume: volumeAt(60, 3.52), avg_volume: AVG }, state: today }).events).toEqual([]);
  });

  it("09:45 之前不判(早盘分母太小),指标也不给", () => {
    const early = run({ minute: 14.9, snap: { volume: volumeAt(14.9, 8), avg_volume: AVG } });
    expect(early.events).toEqual([]);
    expect(early.metrics.rvol).toBeNull();
    const ok = run({ minute: 15, snap: { volume: volumeAt(15, 8), avg_volume: AVG } });
    expect(ok.events.map((e) => e.tier)).toEqual([5]);
  });

  it("收盘前最后一格(15:55 之后)不判放量,指标照给", () => {
    const late = run({ minute: 385, snap: { volume: volumeAt(385, 6), avg_volume: AVG } });
    expect(ofKind(late, "rvol")).toEqual([]);
    expect(late.metrics.rvol).toBeCloseTo(6, 4);
    const before = run({ minute: 384.9, snap: { volume: volumeAt(384.9, 6), avg_volume: AVG } });
    expect(ofKind(before, "rvol")).toHaveLength(1);
  });

  it("没有均量 → 指标为 null,不报", () => {
    const r = run({ minute: 60, snap: { volume: 5_000_000, avg_volume: null } });
    expect(r.events).toEqual([]);
    expect(r.metrics.rvol).toBeNull();
    expect(run({ minute: 60, snap: { volume: 5_000_000, avg_volume: 0 } }).metrics.rvol).toBeNull();
  });

  it("正好达到档位也报(浮点误差不漏报)", () => {
    const r = run({ minute: 77, snap: { volume: volumeAt(77, 2), avg_volume: AVG } });
    expect(r.events.map((e) => e.tier)).toEqual([2]);
  });

  it("档位按倍数值记:盘中改了档位,不把低于已报倍数的档再报一遍", () => {
    const cfg = an.normalizeAnomalyConfig({ rvol_tiers: [2.5, 4, 6] });
    const state = { ...an.freshState(DAY), rvol_fired: 3 };
    const mid = run({ minute: 60, snap: { volume: volumeAt(60, 3.6), avg_volume: AVG }, state, config: cfg });
    expect(mid.events).toEqual([]);
    const up = run({ minute: 61, snap: { volume: volumeAt(61, 4.2), avg_volume: AVG }, state: mid.state, config: cfg });
    expect(up.events.map((e) => [e.tier, e.text])).toEqual([
      [4, "当日成交量已达同时段常态的 4.2×(第 4× 档),现价 101(+1.00%)"],
    ]);
  });

  it("下跌中放量:方向跟当日涨跌走", () => {
    const r = run({ minute: 60, snap: { volume: volumeAt(60, 2.2), avg_volume: AVG, last: 97.5 } });
    expect(r.events[0]).toMatchObject({ direction: "down", change_pct: -2.5 });
    expect(r.events[0]!.text).toBe("当日成交量已达同时段常态的 2.2×(第 2× 档),现价 97.5(−2.50%)");
  });

  it("半日市:开盘那道闸按真实分钟(09:45),收盘那道按 210/390 压缩", () => {
    const S = 210;
    // 开盘竞价是按真实时钟发生的:半日市也要等到 09:45,不是压缩后的 09:38
    const early = run({ minute: 14.9, session: S, snap: { volume: volumeAt(14.9, 3.5, S), avg_volume: AVG } });
    expect(early.events).toEqual([]);
    const ok = run({ minute: 15, session: S, snap: { volume: volumeAt(15, 3.5, S), avg_volume: AVG } });
    expect(ok.events.map((e) => e.tier)).toEqual([3]);
    expect(ok.metrics.rvol).toBeCloseTo(3.5, 4);
    const late = run({ minute: 207.4, session: S, snap: { volume: volumeAt(207.4, 3.5, S), avg_volume: AVG } });
    expect(late.events).toEqual([]);
    // 13:00 收盘之后不在时段内
    expect(run({ minute: 210, session: S, snap: { volume: volumeAt(209, 9, S), avg_volume: AVG } }).events).toEqual([]);
  });
});

// ---------------------------------------------------------------- 窗口放量
describe("burst:近 W 分钟放量,滞回 + 冷却", () => {
  it("样本差算窗口量;方向取窗口涨跌", () => {
    const c = windowCase(120, 6.34, { from: 100, to: 100.9 });
    const r = run({ minute: 120, ...c });
    const [e] = ofKind(r, "burst");
    expect(e).toMatchObject({
      id: `RKLB:burst:up:-:${secAt(120)}`, kind: "burst", direction: "up", threshold: 4, tier: null, sigma: null,
      basis: "avg_volume", title: "RKLB 5分钟放量 6.3×",
      text: "近 5 分钟成交量是同时段常态的 6.3×,5 分钟 +0.90%,现价 100.9",
    });
    expect(e!.value).toBeCloseTo(6.34, 4);
    expect(r.metrics).toMatchObject({ window_ready: true, basis_volume: "avg_volume" });
    expect(r.metrics.burst).toBeCloseTo(6.34, 4);
    expect(r.metrics.ret_window_pct).toBeCloseTo(0.9, 4);
    expect(r.state.burst).toEqual({ armed: false, last_fired_at: secAt(120) });
  });

  it("没到阈值不报,但指标照给", () => {
    const r = run({ minute: 120, ...windowCase(120, 3.9) });
    expect(ofKind(r, "burst")).toEqual([]);
    expect(r.metrics.burst).toBeCloseTo(3.9, 4);
  });

  it("需要窗口:只有本轮样本、流里也没有短时量 → null", () => {
    const r = run({
      minute: 120, samples: [{ t: msAt(120), volume: 900_000, last: 101 }],
      snap: { volume: 900_000, avg_volume: AVG },
    });
    expect(r.metrics).toMatchObject({ window_ready: false, burst: null, basis_volume: null, ret_window_pct: null });
    expect(r.events).toEqual([]);
  });

  it("窗口起点样本比理想时刻早 90 秒以上就不算", () => {
    const stale = (lagSec: number): Result => run({
      minute: 120,
      samples: [
        { t: msAt(115) - lagSec * 1000, volume: 400_000, last: 101 },
        { t: msAt(120), volume: 500_000, last: 101 },
      ],
      snap: { volume: 500_000, avg_volume: AVG },
    });
    expect(stale(91).metrics.window_ready).toBe(false);
    expect(stale(91).metrics.burst).toBeNull();
    expect(stale(89).metrics.window_ready).toBe(true);
    // 实际时长 5 分 89 秒:常态量按实际时长算
    const expected = 100_000 / (AVG * (cum(120) - cum(120 - (5 * 60 + 89) / 60)));
    expect(stale(89).metrics.burst).toBeCloseTo(expected, 4);
  });

  it("开盘竞价排除:窗口起点要在 09:31 之后(minute − W ≥ 1)", () => {
    const early = run({ minute: 5.9, ...windowCase(5.9, 20) });
    expect(ofKind(early, "burst")).toEqual([]);
    expect(early.metrics.burst).toBeCloseTo(20, 4);
    expect(ofKind(run({ minute: 6, ...windowCase(6, 20) }), "burst")).toHaveLength(1);
    // 3 分钟窗口:第 4 分钟起
    const cfg3 = an.normalizeAnomalyConfig({ window_min: 3 });
    expect(ofKind(run({ minute: 3.9, config: cfg3, ...windowCase(3.9, 20, { W: 3 }) }), "burst")).toEqual([]);
    expect(ofKind(run({ minute: 4, config: cfg3, ...windowCase(4, 20, { W: 3 }) }), "burst")).toHaveLength(1);
  });

  it("滞回 + 冷却:持续放量不重报;回落到一半以下且过冷却才重新上膛", () => {
    let state: an.AnomalyState | null = null;
    const tick = (minute: number, ratio: number): Result => {
      const r = run({ minute, state, ...windowCase(minute, ratio) });
      state = r.state;
      return r;
    };
    expect(ofKind(tick(120, 6), "burst")).toHaveLength(1);
    expect(ofKind(tick(121, 7), "burst")).toEqual([]); // 还在放量:落防中
    expect(ofKind(tick(123, 1), "burst")).toEqual([]); // 回落了但冷却没过(3 分钟 < 10)
    expect(state!.burst.armed).toBe(false);
    expect(ofKind(tick(125, 6), "burst")).toEqual([]);
    expect(ofKind(tick(131, 3), "burst")).toEqual([]); // 冷却过了,但 3× 没回到 2× 以下
    expect(state!.burst.armed).toBe(false);
    expect(ofKind(tick(132, 1.5), "burst")).toEqual([]); // 回落 + 过冷却 → 上膛
    expect(state!.burst).toEqual({ armed: true, last_fired_at: secAt(120) });
    const again = tick(133, 5);
    expect(ofKind(again, "burst")).toHaveLength(1);
    expect(state!.burst).toEqual({ armed: false, last_fired_at: secAt(133) });
  });

  it("流里短时量兜底:样本不够时用 vol_5m 给指标,但不报——分不出是不是一笔大单", () => {
    const v5 = 6.34 * AVG * (cum(120) - cum(115));
    const r = run({
      minute: 120, samples: [{ t: msAt(120), volume: 900_000, last: 101 }],
      snap: { volume: 900_000, avg_volume: AVG, vol_5m: v5, vol_3m: 1, vol_10m: 1 },
    });
    expect(ofKind(r, "burst")).toEqual([]);
    expect(r.metrics).toMatchObject({ window_ready: false, basis_volume: "avg_volume", block_share: null });
    expect(r.metrics.burst).toBeCloseTo(6.34, 4);
    expect(r.state.burst.armed).toBe(true); // 没报就不落防
  });

  it("窗口 3 / 10 分钟各取流里对应的短时量(只作指标)", () => {
    for (const W of [3, 10]) {
      const cfg = an.normalizeAnomalyConfig({ window_min: W });
      const vw = 5 * AVG * (cum(120) - cum(120 - W));
      const snap = { volume: 900_000, avg_volume: AVG, vol_3m: W === 3 ? vw : 1, vol_5m: 1, vol_10m: W === 10 ? vw : 1 };
      const r = run({ minute: 120, config: cfg, snap });
      expect(r.metrics.burst).toBeCloseTo(5, 4);
      expect(ofKind(r, "burst")).toEqual([]);
    }
  });

  it("全天量比也去掉当天最大的一步:一笔大宗顶不出一整档", () => {
    // 09:45 刚开闸:常态该走完 12.3%,一笔占日均量 25% 的大宗能把量比顶到 3 倍开外
    const minute = 15;
    const day = 3.6 * AVG * cum(minute); // 全天量比 3.6×
    const block = 0.25 * AVG; // 一笔占日均量 25% 的大宗 ≈ 量比里的 2 倍(cum 只有 12.3%)
    const samples = [
      { t: msAt(minute) - 10_000, volume: day - block, last: 101 },
      { t: msAt(minute), volume: day, last: 101 },
    ];
    const snap = { volume: day, avg_volume: AVG, last: 101, close: 101 };
    const withBlock = run({ minute, samples, snap });
    expect(withBlock.metrics.rvol!).toBeCloseTo(3.6, 2); // 含大单是 3.6×
    expect(withBlock.state.max_step_share).toBeCloseTo(0.25, 6);
    expect(ofKind(withBlock, "rvol")).toEqual([]); // 去掉那一步只剩 1.6×,一档都不到
    // 同样的量,一步步走上来的:照报
    const steady = Array.from({ length: 11 }, (_, i) => ({
      t: msAt(minute - 5 + i * 0.5), volume: day - block + (block * i) / 10, last: 101,
    }));
    const r = run({ minute, samples: steady, snap });
    expect(ofKind(r, "rvol").map((e) => e.tier)).toEqual([3]);
  });

  it("一笔大宗补报不算放量(2026-09-11 真机 GOOG:5 秒 +65.9 万股,价格不动)", () => {
    // 窗口里 60 步,每步 554 股(那天一步的中位数),其中一步 +658,681
    const minute = 285;
    const samples: an.Sample[] = [];
    let v = 7_900_000;
    for (let i = 0; i <= 60; i += 1) {
      if (i > 0) v += i === 58 ? 658_681 : 554;
      samples.push({ t: msAt(minute - 5) + i * 5000, volume: v, last: 336.4 });
    }
    const r = run({ minute, samples, snap: { volume: v, avg_volume: 19_881_826, last: 336.33, close: 330.39 } });
    expect(r.metrics.burst!).toBeGreaterThan(4); // 按窗口总量确实是"5 分钟放量"
    expect(r.metrics.block_share!).toBeGreaterThan(0.9);
    expect(ofKind(r, "burst")).toEqual([]);
    expect(r.state.burst.armed).toBe(true);
  });

  it("持续放量里夹着一笔大单:去掉最大一步还够倍数,照报", () => {
    const c = windowCase(120, 8);
    // 在中间某一步额外塞一笔 = 窗口量的 20%(整体倍数随之抬到 ~10×,去掉它还有 8×)
    const extra = 0.25 * (c.snap.volume! - c.samples[0]!.volume!);
    const samples = c.samples.map((s, i) => (i >= 5 ? { ...s, volume: s.volume! + extra } : s));
    const r = run({ minute: 120, samples, snap: { ...c.snap, volume: c.snap.volume! + extra } });
    expect(ofKind(r, "burst")).toHaveLength(1);
    expect(r.metrics.block_share!).toBeGreaterThan(0.2);
  });

  it("窗口里步数太少(< MIN_BURST_STEPS)判不出大单:只给指标不报", () => {
    const v0 = 400_000;
    const v1 = v0 + 8 * AVG * (cum(120) - cum(115));
    const sparse = (n: number): Result => {
      const samples: an.Sample[] = [];
      for (let i = 0; i <= n; i += 1) samples.push({ t: msAt(115 + (5 * i) / n), volume: v0 + ((v1 - v0) * i) / n, last: 101 });
      return run({ minute: 120, samples, snap: { volume: v1, avg_volume: AVG, last: 101, close: 101 } });
    };
    expect(an.MIN_BURST_STEPS).toBe(4);
    expect(ofKind(sparse(1), "burst")).toEqual([]);
    expect(ofKind(sparse(3), "burst")).toEqual([]);
    expect(sparse(3).metrics.burst).toBeCloseTo(8, 4);
    expect(ofKind(sparse(4), "burst")).toHaveLength(1);
  });

  it("样本差为负(流重订)视为无效:有短时量就退回它,没有就不算", () => {
    const samples = [
      { t: msAt(115), volume: 2_000_000, last: 101 },
      { t: msAt(120), volume: 900_000, last: 101 },
    ];
    const v5 = 5 * AVG * (cum(120) - cum(115));
    const withStream = run({ minute: 120, samples, snap: { volume: 900_000, avg_volume: AVG, vol_5m: v5 } });
    expect(withStream.metrics.burst).toBeCloseTo(5, 4);
    expect(withStream.metrics.window_ready).toBe(true);
    const without = run({ minute: 120, samples, snap: { volume: 900_000, avg_volume: AVG } });
    expect(without.metrics.burst).toBeNull();
  });

  it("没有均量:开盘 30 分钟后按当日节奏估(session_pace)", () => {
    const minute = 120;
    const V = 500_000;
    const normal = (V / cum(minute)) * (cum(minute) - cum(minute - 5));
    const v0 = V - 5.2 * normal;
    const samples = Array.from({ length: 11 }, (_, i) => ({ t: msAt(minute - 5 + i * 0.5), volume: v0 + ((V - v0) * i) / 10, last: 101 }));
    const r = run({ minute, samples, snap: { volume: V, avg_volume: null } });
    const [e] = ofKind(r, "burst");
    expect(e!.basis).toBe("session_pace");
    expect(e!.text).toBe("近 5 分钟成交量是同时段常态的 5.2×,5 分钟 +0.00%,现价 101(无均量数据,按当日节奏估)");
    expect(r.metrics.basis_volume).toBe("session_pace");
    expect(r.metrics.rvol).toBeNull();
  });

  it("没有均量又不到开盘 30 分钟:不估,指标为 null", () => {
    const minute = 29;
    const samples = [
      { t: msAt(minute - 5), volume: 100_000, last: 101 },
      { t: msAt(minute), volume: 300_000, last: 101 },
    ];
    const r = run({ minute, samples, snap: { volume: 300_000, avg_volume: null } });
    expect(r.metrics.burst).toBeNull();
    expect(r.metrics.basis_volume).toBeNull();
  });

  it("收盘前最后一格(15:55 之后)不判放量", () => {
    const r = run({ minute: 386, ...windowCase(386, 12) });
    expect(ofKind(r, "burst")).toEqual([]);
    expect(r.metrics.burst).toBeCloseTo(12, 4);
  });
});

// ---------------------------------------------------------------- 急涨急跌
describe("spike:窗口涨跌幅对 σ 阈值,滞回 + 冷却", () => {
  const RKLB_HV = 0.9;
  const sigmaW = (hv: number, span = 5): number => hv * Math.sqrt(span / (252 * 390)) * 100;

  it("有历史波动率:阈值 = spike_sigma × 窗口 σ", () => {
    const thr = 4 * sigmaW(RKLB_HV);
    expect(thr).toBeCloseTo(2.5678, 3);
    const r = run({ minute: 120, ...moveCase(120, 100, 102.9, RKLB_HV) });
    expect(kindsOf(r)).toEqual(["spike"]);
    const e = r.events[0]!;
    expect(e).toMatchObject({
      id: `RKLB:spike:up:-:${secAt(120)}`, direction: "up", tier: null, basis: "hist_vol",
      title: "RKLB 5分钟急涨 +2.9%",
      text: "5 分钟 +2.90%,约 4.5σ(阈值 2.57%),现价 102.9",
    });
    expect(e.value).toBeCloseTo(2.9, 4);
    expect(e.threshold).toBeCloseTo(thr, 4);
    expect(e.sigma).toBeCloseTo(2.9 / sigmaW(RKLB_HV), 3);
    expect(r.metrics.sigma_window_pct).toBeCloseTo(sigmaW(RKLB_HV), 4);
    expect(run({ minute: 120, ...moveCase(120, 100, 102.5, RKLB_HV) }).events).toEqual([]);
  });

  it("σ 很小的股:阈值不低于最低幅度 spike_min_pct", () => {
    expect(4 * sigmaW(0.2)).toBeLessThan(1);
    expect(run({ minute: 120, ...moveCase(120, 100, 100.8, 0.2) }).events).toEqual([]);
    const r = run({ minute: 120, ...moveCase(120, 100, 101.1, 0.2) });
    expect(r.events[0]).toMatchObject({ threshold: 1, basis: "hist_vol" });
    expect(r.events[0]!.text).toBe(`5 分钟 +1.10%,约 ${(1.1 / sigmaW(0.2)).toFixed(1)}σ(阈值 1%),现价 101.1`);
  });

  it("没有历史波动率:按固定 spike_fixed_pct", () => {
    expect(run({ minute: 120, ...moveCase(120, 100, 98.6) }).events).toEqual([]);
    const r = run({ minute: 120, ...moveCase(120, 100, 98.4) });
    expect(r.events[0]).toMatchObject({
      kind: "spike", direction: "down", threshold: 1.5, sigma: null, basis: "fixed",
      title: "RKLB 5分钟急跌 −1.6%",
      text: "5 分钟 −1.60%(无历史波动率,按固定 1.5%),现价 98.4",
    });
    expect(r.events[0]!.value).toBeCloseTo(-1.6, 4);
    expect(r.metrics.basis_sigma).toBe("fixed");
  });

  it("hist_vol > 5 视为百分数", () => {
    const pct = run({ minute: 120, ...moveCase(120, 100, 102.9, 90) });
    const dec = run({ minute: 120, ...moveCase(120, 100, 102.9, 0.9) });
    expect(pct).toEqual(dec);
  });

  it("开盘 15 分钟内不报(半日市同样是真实的 15 分钟)", () => {
    expect(run({ minute: 14.9, ...moveCase(14.9, 100, 103) }).events).toEqual([]);
    expect(kindsOf(run({ minute: 15, ...moveCase(15, 100, 103) }))).toEqual(["spike"]);
    // 半日市也是真实的 15 分钟:开盘头一刻钟的波动不随交易时长缩短(压缩成 8 分钟只会早盘刷屏)
    expect(run({ minute: 14.9, session: 210, ...moveCase(14.9, 100, 103) }).events).toEqual([]);
    expect(kindsOf(run({ minute: 15, session: 210, ...moveCase(15, 100, 103) }))).toEqual(["spike"]);
  });

  it("滞回 + 冷却", () => {
    let state: an.AnomalyState | null = null;
    const tick = (minute: number, pct: number): Result => {
      const r = run({ minute, state, ...moveCase(minute, 100, 100 + pct) });
      state = r.state;
      return r;
    };
    expect(tick(60, 2).events).toHaveLength(1);
    expect(tick(61, 2.2).events).toEqual([]);
    expect(tick(63, 0.5).events).toEqual([]); // 回到一半以下,但冷却没过
    expect(state!.spike.armed).toBe(false);
    expect(tick(65, 2).events).toEqual([]);
    expect(tick(71, 1).events).toEqual([]); // 过了冷却,但 1% 没回到 0.75% 以下
    expect(state!.spike.armed).toBe(false);
    expect(tick(72, -0.5).events).toEqual([]);
    expect(state!.spike.armed).toBe(true);
    const again = tick(73, -2);
    expect(again.events.map((e) => e.direction)).toEqual(["down"]);
  });

  it("价格信号不受 15:55 限制,收盘后才停", () => {
    expect(kindsOf(run({ minute: 388, ...moveCase(388, 100, 102) }))).toEqual(["spike"]);
    expect(run({ minute: 390, ...moveCase(390, 100, 102) }).events).toEqual([]);
  });

  it("没有窗口(样本不够)就没有涨跌幅,不报", () => {
    const r = run({ minute: 120, samples: [{ t: msAt(120), volume: null, last: 110 }], snap: { last: 110, close: 110 } });
    expect(r.metrics.ret_window_pct).toBeNull();
    expect(r.events).toEqual([]);
  });
});

// ---------------------------------------------------------------- 大涨大跌
describe("day_move:较昨收涨跌幅分档,上下各自记档序号", () => {
  const at = (minute: number, last: number, state: an.AnomalyState | null = null, hv: number | null = null): Result =>
    run({ minute, state, snap: { last, close: 100, hist_vol: hv } });

  it("向上分档:到一档报一档;同档不重报", () => {
    const one = at(60, 103.5);
    expect(one.events).toHaveLength(1);
    expect(one.events[0]).toMatchObject({
      id: `RKLB:day_move:up:1:${secAt(60)}`, kind: "day_move", direction: "up", tier: 1, threshold: 3,
      sigma: null, basis: "fixed", price: 103.5, change_pct: 3.5,
      title: "RKLB 大涨 +3.5%",
      text: "较昨收 +3.50%(第 1 档,阈值 3%),现价 103.5",
    });
    const two = at(61, 105.5, one.state);
    expect(two.events.map((e) => e.tier)).toEqual([2]);
    expect(two.state.day_up_fired).toBe(2);
    expect(at(62, 105.8, two.state).events).toEqual([]);
    expect(at(63, 104, two.state).events).toEqual([]); // 回落再上来也不重报
  });

  it("一次跨多档只报最高那档", () => {
    const r = at(60, 109);
    expect(r.events.map((e) => [e.tier, e.threshold])).toEqual([[3, 8]]);
    expect(r.state.day_up_fired).toBe(3);
  });

  it("向下独立计档", () => {
    const up = at(60, 105.5);
    const down = at(200, 96.8, up.state);
    expect(down.events).toHaveLength(1);
    expect(down.events[0]).toMatchObject({
      direction: "down", tier: 1, title: "RKLB 大跌 −3.2%",
      text: "较昨收 −3.20%(第 1 档,阈值 3%),现价 96.8",
    });
    expect(down.state).toMatchObject({ day_up_fired: 2, day_down_fired: 1 });
    expect(down.events[0]!.id).toBe(`RKLB:day_move:down:1:${secAt(200)}`);
  });

  it("跳空:开盘第一分钟(minute = 0)即报", () => {
    const r = at(0, 106);
    expect(r.events.map((e) => [e.kind, e.tier])).toEqual([["day_move", 2]]);
  });

  it("有历史波动率:档位 = k × 日 σ", () => {
    const sigmaD = (0.32 / Math.sqrt(252)) * 100;
    const r = at(60, 104.5, null, 0.32);
    expect(r.events[0]).toMatchObject({
      tier: 1, basis: "hist_vol",
      text: `较昨收 +4.50%,约 2.2σ(第 1 档,阈值 4.03%),现价 104.5`,
    });
    expect(r.events[0]!.threshold).toBeCloseTo(2 * sigmaD, 4);
    expect(r.events[0]!.sigma).toBeCloseTo(4.5 / sigmaD, 3);
    expect(r.metrics.sigma_day_pct).toBeCloseTo(sigmaD, 4);
    expect(at(60, 104, null, 0.32).events).toEqual([]); // 4% < 2σ(4.03%)
  });

  it("档序号跨基准切换不重报:盘中 hist_vol 晚到,固定档切到 σ 档", () => {
    const fixed = at(60, 103.5); // 固定档第 1 档(3%)
    expect(fixed.events.map((e) => e.basis)).toEqual(["fixed"]);
    const switched = at(61, 104.5, fixed.state, 0.32); // σ 档第 1 档(4.03%),序号 1 已报过
    expect(switched.events).toEqual([]);
    const next = at(62, 106.2, switched.state, 0.32); // σ 档第 2 档(6.05%)
    expect(next.events.map((e) => [e.tier, e.basis])).toEqual([[2, "hist_vol"]]);
    expect(next.events[0]!.text).toBe("较昨收 +6.20%,约 3.1σ(第 2 档,阈值 6.05%),现价 106.2");
  });

  it("盘前 / 收盘后只算指标不报", () => {
    for (const minute of [-10, 390, 500, Number.NaN]) {
      const r = at(minute, 110);
      expect(r.events).toEqual([]);
      expect(r.metrics.change_pct).toBeCloseTo(10, 4);
    }
  });

  it("没有昨收或现价:不算涨跌", () => {
    const r = run({ minute: 60, snap: { last: 110, close: null } });
    expect(r.metrics.change_pct).toBeNull();
    expect(r.events).toEqual([]);
  });
});

// ---------------------------------------------------------------- 综合
describe("综合:单位不变性、时段、事件格式、入参不动", () => {
  /** 一轮里四类信号全中:3.5× 全天量比、6.3× 窗口放量、5 分钟 +4.7%、较昨收 +12%(σ 档第 1 档)。 */
  function allFour(k: number): Result {
    const minute = 120;
    const V1 = 3.52 * AVG * cum(minute);
    const V0 = V1 - 6.34 * AVG * (cum(minute) - cum(minute - 5));
    return an.evaluateAnomalies({
      symbol: "RKLB",
      snap: {
        last: 112, close: 100, volume: V1 * k, avg_volume: AVG * k, hist_vol: 0.9,
        vol_5m: 1234 * k, vol_3m: 55 * k, vol_10m: 99 * k,
      },
      // 窗口里铺 10 步,量与价线性走(一步只占十分之一,不会被当成一笔大单)
      samples: [
        { t: msAt(minute - 10), volume: (V0 - 10_000) * k, last: 106 },
        ...Array.from({ length: 11 }, (_, i) => ({
          t: msAt(minute - 5 + i * 0.5), volume: (V0 + ((V1 - V0) * i) / 10) * k, last: 107 + (5 * i) / 10,
        })),
      ],
      state: null, nowMs: msAt(minute), etDate: DAY, minute, config: CFG,
    });
  }

  it("四类信号同一轮都能报,顺序固定", () => {
    const r = allFour(1);
    expect(kindsOf(r)).toEqual(["rvol", "burst", "spike", "day_move"]);
    expect(r.events.map((e) => e.title)).toEqual([
      "RKLB 放量 3.5×", "RKLB 5分钟放量 6.3×", "RKLB 5分钟急涨 +4.7%", "RKLB 大涨 +12.0%",
    ]);
  });

  it("单位不变性:volume / avg_volume / vol_5m 与样本量同乘 100,结果一模一样", () => {
    expect(allFour(100)).toEqual(allFour(1));
  });

  it("单位不变性:按当日节奏估 + 流里短时量兜底这条路也一样", () => {
    const one = (k: number): Result => {
      const V = 500_000;
      const normal = (V / cum(120)) * (cum(120) - cum(115));
      return run({ minute: 120, snap: { volume: V * k, avg_volume: null, vol_5m: 5.2 * normal * k } });
    };
    expect(one(1).metrics.basis_volume).toBe("session_pace");
    expect(one(1).metrics.burst).toBeCloseTo(5.2, 4);
    expect(one(100)).toEqual(one(1));
  });

  it("事件 id:symbol:kind:direction:tier:秒", () => {
    const r = allFour(1);
    const s = secAt(120);
    expect(r.events.map((e) => e.id)).toEqual([
      `RKLB:rvol:up:3:${s}`, `RKLB:burst:up:-:${s}`, `RKLB:spike:up:-:${s}`, `RKLB:day_move:up:1:${s}`,
    ]);
    for (const e of r.events) {
      expect(e.id).toMatch(/^[A-Z0-9.\-]+:(rvol|burst|spike|day_move):(up|down|-):([\d.]+|-):\d+$/);
      expect(e.at).toBe(s);
      expect(e.symbol).toBe("RKLB");
    }
  });

  it("收盘前最后一格:放量类全不判,价格类照判", () => {
    const minute = 386;
    const V1 = 6 * AVG * cum(minute);
    const V0 = V1 - 12 * AVG * (cum(minute) - cum(minute - 5));
    const r = run({
      minute,
      samples: [{ t: msAt(minute - 5), volume: V0, last: 100 }, { t: msAt(minute), volume: V1, last: 103.5 }],
      snap: { volume: V1, avg_volume: AVG, last: 103.5, close: 100 },
    });
    expect(kindsOf(r)).toEqual(["spike", "day_move"]);
    expect(r.metrics.rvol).toBeCloseTo(6, 4);
    expect(r.metrics.burst).toBeCloseTo(12, 4);
  });

  it("时段外(盘前 / 收盘后)一概不报,但指标照给", () => {
    const pre = run({ minute: -5, snap: { volume: 100_000, avg_volume: AVG, last: 115 } });
    expect(pre.events).toEqual([]);
    expect(pre.metrics).toMatchObject({ change_pct: 15, rvol: null });
    const post = run({ minute: 400, snap: { volume: 3 * AVG, avg_volume: AVG, last: 115 } });
    expect(post.events).toEqual([]);
    expect(post.metrics.rvol).toBeCloseTo(3, 4); // 收盘后分母是全天:就是整日量比
  });

  it("全空快照也返回完整指标", () => {
    const r = an.evaluateAnomalies({
      symbol: "RKLB",
      snap: { last: null, close: null, volume: null, avg_volume: null, hist_vol: null },
      samples: [], state: null, nowMs: msAt(60), etDate: DAY, minute: 60, config: CFG,
    });
    expect(r.events).toEqual([]);
    expect(r.metrics).toEqual({
      last: null, change_pct: null, rvol: null, burst: null, block_share: null, ret_window_pct: null,
      sigma_window_pct: null, sigma_day_pct: null, basis_volume: null, basis_sigma: "fixed",
      window_ready: false, delayed: false,
    });
    expect(r.state).toEqual(an.freshState(DAY));
  });

  it("非正 / 非有限的量价当没有", () => {
    const r = run({
      minute: 60,
      snap: { last: Number.NaN, close: -1, volume: 0, avg_volume: Number.POSITIVE_INFINITY, hist_vol: -0.3 },
    });
    expect(r.metrics).toMatchObject({ last: null, change_pct: null, rvol: null, sigma_day_pct: null, basis_sigma: "fixed" });
  });

  it("延迟行情照样判,指标里标出来", () => {
    const r = run({ minute: 60, snap: { last: 104, close: 100, delayed: true } });
    expect(r.metrics.delayed).toBe(true);
    expect(r.events).toHaveLength(1);
  });

  it("不改调用方的 state(冻住了也不抛):返回新对象", () => {
    const state = deepFreeze({ ...an.freshState(DAY), burst: { armed: false, last_fired_at: secAt(0) } });
    const minute = 120;
    const c = windowCase(minute, 1);
    const r = an.evaluateAnomalies({
      symbol: "RKLB", snap: snapOf({ ...c.snap, last: 112, close: 100 }), samples: c.samples, state,
      nowMs: msAt(minute), etDate: DAY, minute, config: CFG,
    });
    expect(r.state).not.toBe(state);
    expect(r.state.day_up_fired).toBe(3); // +12%,固定档 [3, 5, 8] 的第 3 档
    expect(r.state.burst).toEqual({ armed: true, last_fired_at: secAt(0) }); // 1× 回落 + 过冷却 → 重新上膛
    expect(state).toEqual({ ...an.freshState(DAY), burst: { armed: false, last_fired_at: secAt(0) } });
  });

  it("同一天同样的输入再跑一轮:状态不变、不重报(调用方靠 JSON 比较决定落不落库)", () => {
    const first = allFour(1);
    const minute = 120;
    const V1 = 3.52 * AVG * cum(minute);
    const second = an.evaluateAnomalies({
      symbol: "RKLB",
      snap: { last: 112, close: 100, volume: V1, avg_volume: AVG, hist_vol: 0.9 },
      samples: [{ t: msAt(minute), volume: V1, last: 112 }],
      state: first.state, nowMs: msAt(minute) + 5000, etDate: DAY, minute: minute + 5 / 60, config: CFG,
    });
    expect(second.events).toEqual([]);
    expect(JSON.stringify(second.state)).toBe(JSON.stringify(first.state));
  });
});
