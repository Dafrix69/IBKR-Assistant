/** SPX 日内剧本的纯计算(playbook.ts):预期波动区间、状态机、目标位、加速档。
 *
 * 区间那一组的期望值是 2026-10-07 盘中对照帧上的三组取价与它们给出的区间:公式要能把那三组数复出来。
 */
import { describe, expect, it } from "vitest";

import type { OptionWallStrike, PlaybookBand } from "../src/contract/options.js";
import {
  ACCEL_REARM, EM_FACTOR, QUIET_MS, accelerator, atmStrike, expectedMove, legMid, makeBand, newMachine, stepMachine, targets,
} from "../src/playbook.js";
import type { MachineInput, PlaybookMachine } from "../src/playbook.js";

const band = (anchor: number, call: number, put: number): PlaybookBand =>
  makeBand({ at: 0, anchor, strike: atmStrike(anchor), expiry: "20261007", call, put, source: "live" })!;
const gex = (strike: number, net_gex: number): OptionWallStrike => ({ strike, call_oi: 0, put_oi: 0, call_vol: 0, put_vol: 0, net_gex });

describe("预期波动区间", () => {
  it("系数是 √(π/2)", () => {
    expect(EM_FACTOR).toBeCloseTo(1.2533141, 6);
    expect(expectedMove(10, 10)).toBeCloseTo(25.066, 3);
  });

  it.each([
    ["昨日", 7818.93, 16.97, 13.31, 37.95, 7780.98, 7856.88, 7820],
    ["盘初", 7784.04, 11.98, 15.43, 34.35, 7749.69, 7818.39, 7785],
    ["当前", 7791.61, 9.30, 8.50, 22.31, 7769.30, 7813.92, 7790],
  ])("对照帧的%s口径复得出来", (_name, anchor, call, put, em, lower, upper, strike) => {
    const b = band(anchor, call, put);
    expect(b.strike).toBe(strike);
    expect(Math.abs(b.em - em)).toBeLessThan(0.01);
    expect(Math.abs(b.lower - lower)).toBeLessThan(0.01);
    expect(Math.abs(b.upper - upper)).toBeLessThan(0.01);
  });

  it("锚或哪条腿不是正数就不出区间", () => {
    const spec = { at: 0, anchor: 7800, strike: 7800, expiry: "20261007", call: 10, put: 10, source: "live" as const };
    expect(makeBand({ ...spec, call: 0 })).toBeNull();
    expect(makeBand({ ...spec, put: NaN })).toBeNull();
    expect(makeBand({ ...spec, anchor: 0 })).toBeNull();
  });

  it("中间价:缺一边、卖价不是正数、盘口倒挂都不算数;买价 0 照算", () => {
    expect(legMid({ bid: 2, ask: 2.2 })).toBeCloseTo(2.1);
    expect(legMid({ bid: 0, ask: 0.1 })).toBeCloseTo(0.05);
    expect(legMid({ bid: null, ask: 2 })).toBeNull();
    expect(legMid({ bid: 2, ask: null })).toBeNull();
    expect(legMid({ bid: 2, ask: 0 })).toBeNull();
    expect(legMid({ bid: 3, ask: 2 })).toBeNull();
  });

  it("平值行权价按 5 点一档取最近的", () => {
    expect(atmStrike(7818.93)).toBe(7820);
    expect(atmStrike(7791.61)).toBe(7790);
    expect(atmStrike(7792.5)).toBe(7795);
  });
});

describe("状态机", () => {
  const B3 = 7780.98, B2 = 7813.92;
  const feed = (m: PlaybookMachine, price: number, at: number, more: Partial<MachineInput> = {}) =>
    stepMachine(m, { at, price, b3: B3, b2: B2, accelStrike: null, ...more });

  it("两条线之间是 R,不报事件", () => {
    const { next, events } = feed(newMachine(), 7791.61, 1000);
    expect(next).toMatchObject({ state: "R", trigger: null, since: 1000 });
    expect(events).toEqual([]);
  });

  it("两条线都没有就判不了", () => {
    expect(feed(newMachine(), 7791, 0, { b2: null, b3: null }).next.state).toBe("none");
    // 只有一条线:那一条照判
    expect(feed(newMachine(), 7700, 0, { b2: null }).next.state).toBe("B3");
    expect(feed(newMachine(), 7900, 0, { b3: null }).next.state).toBe("B2");
  });

  it("站上当前区间上沿进 B2;正好踩在线上不算", () => {
    expect(feed(newMachine(), B2, 0).next.state).toBe("R");
    const { next, events } = feed(newMachine(), 7814.5, 2000);
    expect(next).toMatchObject({ state: "B2", trigger: B2, since: 2000 });
    expect(events).toEqual([{ at: 2000, kind: "enter", state: "B2", level: B2, price: 7814.5 }]);
  });

  it("进了 B2 记住的是进去时的那条线:当前区间换了、上沿抬高了,状态不跟着变回去", () => {
    let m = feed(newMachine(), 7815, 0).next;
    const later = feed(m, 7818, 60_000, { b2: 7840 });
    expect(later.next).toMatchObject({ state: "B2", trigger: B2, since: 0 });
    expect(later.events).toEqual([]);
    m = later.next;
    // 跌回进去时那条线的下方才失效
    const out = feed(m, 7813, 120_000, { b2: 7840 });
    expect(out.next).toMatchObject({ state: "R", trigger: null, since: 120_000 });
    expect(out.events).toEqual([{ at: 120_000, kind: "invalid", state: "B2", level: B2, price: 7813 }]);
  });

  it("跌破昨日区间下沿进 B3,收回线上方失效", () => {
    const a = feed(newMachine(), 7780, 0);
    expect(a.next).toMatchObject({ state: "B3", trigger: B3 });
    expect(a.events[0]).toMatchObject({ kind: "enter", state: "B3", level: B3 });
    const b = feed(a.next, 7781.5, 10 * 60_000);
    expect(b.next.state).toBe("R");
    expect(b.events).toEqual([{ at: 600_000, kind: "invalid", state: "B3", level: B3, price: 7781.5 }]);
  });

  it("两样同时成立按 B3:跌破昨日下沿之后反弹过了新的当前上沿,还是失守", () => {
    const { next } = feed(newMachine(), 7770, 0, { b2: 7765 });
    expect(next).toMatchObject({ state: "B3", trigger: B3 });
  });

  it("从 B2 直接掉到昨日下沿之下:先报失效,再报进入 B3", () => {
    const m = feed(newMachine(), 7815, 0).next;
    const { next, events } = feed(m, 7775, 60_000);
    expect(next.state).toBe("B3");
    expect(events.map((e) => `${e.kind}:${e.state}`)).toEqual(["invalid:B2", "enter:B3"]);
  });

  it("贴着线来回蹭:同一条线上同一种事件五分钟内只报一次,状态照变", () => {
    let m = newMachine();
    const seen: string[] = [];
    const prices = [7780, 7782, 7780, 7782, 7780];
    prices.forEach((price, i) => {
      const r = feed(m, price, i * 10_000);
      m = r.next;
      seen.push(...r.events.map((e) => e.kind));
    });
    expect(seen).toEqual(["enter", "invalid"]);
    expect(m.state).toBe("B3");
    // 过了静默期再蹭一次:照报
    const again = feed(feed(m, 7782, QUIET_MS + 50_000).next, 7780, QUIET_MS + 60_000);
    expect(again.events.map((e) => e.kind)).toEqual(["enter"]);
  });

  it("不改传进来的那一份", () => {
    const m = newMachine();
    feed(m, 7700, 0, { accelStrike: 7790 });
    expect(m).toEqual(newMachine());
  });
});

describe("加速档", () => {
  const feed = (m: PlaybookMachine, price: number, at: number, accelStrike: number | null = 7790) =>
    stepMachine(m, { at, price, b3: 7700, b2: 7900, accelStrike });

  it("第一笔只登记在哪一侧;穿过去报一次", () => {
    const a = feed(newMachine(), 7793, 0);
    expect(a.events).toEqual([]);
    const b = feed(a.next, 7789, 5000);
    expect(b.events).toEqual([{ at: 5000, kind: "accel", state: "R", level: 7790, price: 7789 }]);
  });

  it("穿过去之后没走开半档就又穿回来:不报;走开了再穿:报", () => {
    let m = feed(feed(newMachine(), 7793, 0).next, 7789, 5000).next;
    const back = feed(m, 7791, 10_000);
    expect(back.events).toEqual([]);
    m = feed(back.next, 7790 + ACCEL_REARM, QUIET_MS + 20_000).next;
    expect(feed(m, 7789, QUIET_MS + 30_000).events.map((e) => e.kind)).toEqual(["accel"]);
  });

  it("换了行权价只登记,不报;没有加速档就清掉", () => {
    const m = feed(newMachine(), 7793, 0).next;
    const moved = feed(m, 7793, 5000, 7800);
    expect(moved.events).toEqual([]);
    expect(moved.next.accel).toEqual({ strike: 7800, side: "below", armed: true });
    expect(feed(moved.next, 7793, 6000, null).next.accel).toBeNull();
  });
});

describe("目标位与加速档的挑法", () => {
  const open = band(7784.04, 11.98, 15.43); // 7749.69 – 7818.39
  const strikes = [gex(7790, -2529.7), gex(7800, -300), gex(7815, 120), gex(7820, -50), gex(7825, 900), gex(7830, 400)];

  it("B2:T1 是盘初区间上沿,T2 是它上方最近的正 gamma 行权价", () => {
    expect(targets("B2", 7813.92, open, strikes)).toEqual({ t1: open.upper, t2: 7825 });
  });

  it("B2:盘初上沿已经在触发线身后就不给 T1,T2 从触发线起算", () => {
    expect(targets("B2", 7822, open, strikes)).toEqual({ t1: null, t2: 7825 });
    expect(targets("B2", 7840, open, strikes)).toEqual({ t1: null, t2: null });
  });

  it("B3:T1 是盘初区间下沿,T2 是它下方的下一档行权价", () => {
    expect(targets("B3", 7780.98, open, strikes)).toEqual({ t1: open.lower, t2: 7745 });
    // 正好落在一档上:取再下一档
    expect(targets("B3", 7750, null, strikes)).toEqual({ t1: null, t2: 7745 });
  });

  it("R / none 没有目标位", () => {
    expect(targets("R", null, open, strikes)).toEqual({ t1: null, t2: null });
    expect(targets("none", null, open, strikes)).toEqual({ t1: null, t2: null });
  });

  it("加速档:当前区间里负 gamma 最大的行权价;区间外的不算,没有负的就没有", () => {
    const current = band(7791.61, 9.30, 8.50); // 7769.30 – 7813.92
    expect(accelerator(strikes, current)).toEqual({ strike: 7790, net_gex: -2529.7 });
    expect(accelerator([gex(7700, -9999), gex(7800, 50)], current)).toBeNull();
    expect(accelerator(strikes, null)).toBeNull();
  });
});
