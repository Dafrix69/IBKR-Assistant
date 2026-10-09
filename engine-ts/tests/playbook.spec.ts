/** SPX 日内剧本的纯计算(playbook.ts):预期波动区间、状态机、目标位、加速档。
 *
 * 区间那一组的期望值是 2026-10-07 盘中对照帧上的三组取价与它们给出的区间:公式要能把那三组数复出来。
 */
import { describe, expect, it } from "vitest";

import type { OptionWallStrike, PlaybookAnchor, PlaybookBand, PlaybookEvent } from "../src/contract/options.js";
import {
  ACCEL_REARM, EM_FACTOR, QUIET_MS, accelerator, atmStrike, expectedMove, legMid, makeBand, newMachine, quietKey, restoreMachine,
  stepMachine, targets, todayBand, wallSpan,
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

describe("今日区间:09:35 的锚 ± 当前剩余的预期波动", () => {
  const anchor: PlaybookAnchor = { at: 1, price: 7784.04, source: "live" };
  const open = band(7784.04, 11.98, 15.43); // 09:35:7749.69 – 7818.39
  const current = { ...band(7791.61, 9.30, 8.50), at: 5 }; // 之后某一格:围着当时现价,±22.31

  it("锚是 09:35 的价,半宽是最近一次取到的剩余预期波动;取价的那几样照当前剩余那一条", () => {
    const day = todayBand(anchor, current)!;
    expect(day.anchor).toBe(7784.04);
    expect(day.em).toBe(current.em);
    expect(day.lower).toBeCloseTo(7784.04 - current.em, 9);
    expect(day.upper).toBeCloseTo(7784.04 + current.em, 9);
    expect(Math.abs(day.upper - 7806.35)).toBeLessThan(0.01);
    expect(day).toMatchObject({ at: 5, strike: 7790, call: 9.30, put: 8.50, expiry: "20261007", source: "live" });
  });

  it("09:35 那一格当前剩余就是盘初那一条:今日区间就是盘初区间", () => {
    expect(todayBand(anchor, open)).toEqual(open);
  });

  it("只要锚,不要盘初那一条区间;缺锚或缺当前剩余拼不出来;有一样是补的就标成补的", () => {
    expect(todayBand(null, current)).toBeNull();
    expect(todayBand(anchor, null)).toBeNull();
    expect(todayBand({ ...anchor, price: 0 }, current)).toBeNull();
    expect(todayBand({ ...anchor, source: "backfill" }, current)?.source).toBe("backfill");
    expect(todayBand(anchor, { ...current, source: "backfill" })?.source).toBe("backfill");
  });

  it("站上今日区间上沿,和「09:35 的锚掉出了 现价 ± 剩余预期波动 的下沿」是同一句话", () => {
    const day = todayBand(anchor, current)!;
    for (const price of [7790, 7806.3, 7806.4, 7812, 7830]) {
      expect(price > day.upper).toBe(anchor.price < price - current.em);
    }
  });

  it("剩余预期波动变小,区间跟着收窄,锚不动", () => {
    const later = todayBand(anchor, band(7801.2, 5.1, 4.9))!;
    expect(later.anchor).toBe(7784.04);
    expect(later.upper).toBeLessThan(todayBand(anchor, current)!.upper);
    expect(later.upper - later.anchor).toBeCloseTo(EM_FACTOR * 10, 9);
  });
});

describe("期权墙要看多宽", () => {
  it("取离现价最远的那条线的距离:规则会读的每一条线都得在窗口里", () => {
    expect(wallSpan(7791.61, [7780.98, 7749.69, 7818.39])).toBeCloseTo(7791.61 - 7749.69, 9);
    expect(wallSpan(7860, [7780.98, 7749.69, 7818.39])).toBeCloseTo(7860 - 7749.69, 9);
    expect(wallSpan(7791.61, [null, 7818.39, undefined])).toBeCloseTo(7818.39 - 7791.61, 9);
  });

  it("一条线都没有:不指定,用期权链默认的窗口", () => {
    expect(wallSpan(7791.61, [null, undefined])).toBeNull();
    expect(wallSpan(7791.61, [])).toBeNull();
    expect(wallSpan(7791.61, [NaN])).toBeNull();
  });
});

describe("状态机", () => {
  const B3 = 7780.98, B2 = 7813.92;
  /** 不特别说明的每一笔都当作刚取到新一格(B2 只在这种时候判) */
  const feed = (m: PlaybookMachine, price: number, at: number, more: Partial<MachineInput> = {}) =>
    stepMachine(m, { at, price, b3: B3, b2: B2, frame: true, accelStrike: null, ...more });
  const MIN = 60_000;

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

  it("站上今日区间上沿进 B2;正好踩在线上不算", () => {
    expect(feed(newMachine(), B2, 0).next.state).toBe("R");
    const { next, events } = feed(newMachine(), 7814.5, 2000);
    expect(next).toMatchObject({ state: "B2", trigger: B2, since: 2000 });
    expect(events).toEqual([{ at: 2000, kind: "enter", state: "B2", level: B2, price: 7814.5 }]);
  });

  it("B2 只在取到新一格的那一笔判:格子中间刺上去不算进入,刺下去又回来不算失效", () => {
    // 格子中间站上了上沿:不动
    const spike = feed(newMachine(), 7820, 0, { frame: false });
    expect(spike.next.state).toBe("R");
    expect(spike.events).toEqual([]);
    // 下一格取到时还在上面:这时才进
    let m = feed(spike.next, 7816, 5 * MIN).next;
    expect(m).toMatchObject({ state: "B2", trigger: B2, since: 5 * MIN });
    // 格子中间跌回线下又回来:还是 B2,不报失效
    const dip = feed(m, 7810, 6 * MIN, { frame: false });
    expect(dip.next).toMatchObject({ state: "B2", trigger: B2 });
    expect(dip.events).toEqual([]);
    m = feed(dip.next, 7815, 10 * MIN).next;
    expect(m).toMatchObject({ state: "B2", trigger: B2, since: 5 * MIN });
    // 取到新一格时还在线下:失效
    const out = feed(m, 7812, 15 * MIN);
    expect(out.events).toEqual([{ at: 15 * MIN, kind: "invalid", state: "B2", level: B2, price: 7812 }]);
    expect(out.next.state).toBe("R");
  });

  it("进了 B2 记住的是进去时的那条线:之后上沿抬高了(剩余预期波动变大),状态不跟着变回去", () => {
    let m = feed(newMachine(), 7815, 0).next;
    const later = feed(m, 7818, 5 * MIN, { b2: 7840 });
    expect(later.next).toMatchObject({ state: "B2", trigger: B2, since: 0 });
    expect(later.events).toEqual([]);
    m = later.next;
    // 跌回进去时那条线的下方才失效
    const out = feed(m, 7813, 10 * MIN, { b2: 7840 });
    expect(out.next).toMatchObject({ state: "R", trigger: null, since: 10 * MIN });
    expect(out.events).toEqual([{ at: 10 * MIN, kind: "invalid", state: "B2", level: B2, price: 7813 }]);
  });

  it("跌破昨日区间下沿进 B3,收回线上方失效——每一笔都判,不等新一格", () => {
    const a = feed(newMachine(), 7780, 0, { frame: false });
    expect(a.next).toMatchObject({ state: "B3", trigger: B3 });
    expect(a.events[0]).toMatchObject({ kind: "enter", state: "B3", level: B3 });
    const b = feed(a.next, 7781.5, 10 * MIN, { frame: false });
    expect(b.next.state).toBe("R");
    expect(b.events).toEqual([{ at: 600_000, kind: "invalid", state: "B3", level: B3, price: 7781.5 }]);
  });

  it("两样同时成立按 B3:现价在昨日下沿之下、又在今日上沿之上,还是失守", () => {
    const { next } = feed(newMachine(), 7770, 0, { b2: 7765 });
    expect(next).toMatchObject({ state: "B3", trigger: B3 });
  });

  it("从 B2 直接掉到昨日下沿之下:先报失效,再报进入 B3;不等新一格", () => {
    const m = feed(newMachine(), 7815, 0).next;
    const { next, events } = feed(m, 7775, MIN, { frame: false });
    expect(next).toMatchObject({ state: "B3", trigger: B3, lost: B2 });
    expect(events.map((e) => `${e.kind}:${e.state}`)).toEqual(["invalid:B2", "enter:B3"]);
  });

  it("已经在 B2 里、现价掉到昨日下沿之下但还在 B2 进入线之上(跳空低开的日子):B3 压过去,不报「跌回…下方」", () => {
    // 昨日下沿 5760;低开后锚 5700、今日上沿 5730
    const day = { b3: 5760, b2: 5730 };
    let m = feed(newMachine(), 5700, 0, day).next;
    expect(m.state).toBe("B3");
    const up = feed(m, 5765, 10 * MIN, day); // 收回昨日下沿上方,也在今日上沿之上
    expect(up.events.map((e) => `${e.kind}:${e.state}`)).toEqual(["invalid:B3", "enter:B2"]);
    m = up.next;
    const down = feed(m, 5750, 11 * MIN, { ...day, b2: 5728, frame: false }); // 又到昨日下沿之下,还在 5730 之上
    expect(down.next).toMatchObject({ state: "B3", trigger: 5760, since: 11 * MIN, lost: null });
    // 只有一条「进入 B3」:B2 进入时那条线(5730)没丢,「跌回 5730 下方」这句话不成立,不报
    expect(down.events).toEqual([{ at: 11 * MIN, kind: "enter", state: "B3", level: 5760, price: 5750 }]);
    // 收回昨日下沿之上:B3 失效;B2 等下一格取到时再判(这一笔不是)
    const again = feed(down.next, 5762, 12 * MIN, { ...day, b2: 5728, frame: false });
    expect(again.next.state).toBe("R");
    expect(feed(again.next, 5762, 15 * MIN, { ...day, b2: 5726 }).next).toMatchObject({ state: "B2", trigger: 5726 });
  });

  it("贴着线来回蹭:同一种事件五分钟内只报一次,状态照变", () => {
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

  it("静默期不看那条线是多少:上沿每一格都在变,换了数也还是同一种事件", () => {
    expect(quietKey({ kind: "enter", state: "B2", level: 7813.92 })).toBe(quietKey({ kind: "enter", state: "B2", level: 7813.67 }));
    expect(quietKey({ kind: "enter", state: "B2", level: 1 })).not.toBe(quietKey({ kind: "invalid", state: "B2", level: 1 }));
    expect(quietKey({ kind: "enter", state: "B2", level: 1 })).not.toBe(quietKey({ kind: "enter", state: "B3", level: 1 }));
    // 加速档带着行权价:换了一档是另一件事
    expect(quietKey({ kind: "accel", state: "R", level: 7790 })).not.toBe(quietKey({ kind: "accel", state: "R", level: 7800 }));

    // 进入 → 失效 → 四分半钟之后在另一条线上再进入:状态变,不报
    let m = feed(newMachine(), 7815, 0).next;
    m = feed(m, 7800, 30_000).next; // 失效,而且回到了区间里
    const again = feed(m, 7812, 270_000, { b2: 7811 });
    expect(again.next).toMatchObject({ state: "B2", trigger: 7811 });
    expect(again.events).toEqual([]);
  });

  it("现价贴着一格一格往下收的上沿来回蹭半小时:只在每格取到时判,一共两条事件,不是每格两条", () => {
    // 每格跨式便宜 0.2 → 上沿每格降 0.25;每分钟整点在上沿之上 1 点,半分时在上沿之下 1 点
    let m = newMachine();
    const seen: string[] = [];
    for (let minute = 0; minute < 30; minute += 1) {
      const edge = 7743.47 - 0.25 * Math.floor(minute / 5);
      for (const [second, offset] of [[0, 1], [30, -1]] as const) {
        const r = feed(m, edge + offset, minute * MIN + second * 1000, { b2: edge, b3: null, frame: minute % 5 === 0 && second === 0 });
        m = r.next;
        seen.push(...r.events.map((e) => `${minute}:${e.kind}`));
      }
    }
    // 第 25 分钟那一格:现价跟着上沿降了 1.25,取到时已经在进入那条线(7743.47)之下 → 这才失效;之后等它回区间或站回去
    expect(seen).toEqual(["0:enter", "25:invalid"]);
    expect(m).toMatchObject({ state: "R", lost: 7743.47 });
  });

  it("区间收窄之后 B2 失效:现价还在新的上沿之上,只报失效,不紧跟着报一条进入", () => {
    let m = feed(newMachine(), 7815, 0).next; // 在 7813.92 进的 B2
    const out = feed(m, 7812, 10 * MIN, { b2: 7806 }); // 上沿已经收到 7806;现价跌回 7813.92 下方
    expect(out.events).toEqual([{ at: 10 * MIN, kind: "invalid", state: "B2", level: B2, price: 7812 }]);
    expect(out.next).toMatchObject({ state: "R", trigger: null, lost: B2 });
    m = out.next;
    // 还在新的上沿之上、丢掉的那条线之下晃:什么都不报
    const still = feed(m, 7809, 15 * MIN, { b2: 7806 });
    expect(still.events).toEqual([]);
    expect(still.next).toMatchObject({ state: "R", lost: B2 });
    // 回到区间里(不高于上沿)就解开;再站上去是新的一次,触发线是此刻的上沿
    const inside = feed(still.next, 7806, 20 * MIN, { b2: 7806 });
    expect(inside.next).toMatchObject({ state: "R", lost: null });
    const again = feed(inside.next, 7807, 25 * MIN, { b2: 7806 });
    expect(again.events).toEqual([{ at: 25 * MIN, kind: "enter", state: "B2", level: 7806, price: 7807 }]);
    expect(again.next).toMatchObject({ state: "B2", trigger: 7806, lost: null });
  });

  it("B2 失效之后没回过区间、但重新站回了丢掉的那条线:也算新的一次,不会一整天卡在 R", () => {
    // 锚 5800。10:00 上沿 5830,5831 进 B2;10:30 上沿 5827,现价 5829.9 跌回 5830 之下一下,之后一路走高
    const day = (b2: number) => ({ b2, b3: null });
    let m = feed(newMachine(), 5831, 0, day(5830)).next;
    const dip = feed(m, 5829.9, 30 * MIN, day(5827));
    expect(dip.next).toMatchObject({ state: "R", lost: 5830 });
    m = dip.next;
    // 站回 5830 之上:进,新的触发线是此刻的上沿(比丢掉的那条低,不贴着同一条线来回翻)
    const back = feed(m, 5835, 35 * MIN, day(5827));
    expect(back.events).toEqual([{ at: 35 * MIN, kind: "enter", state: "B2", level: 5827, price: 5835 }]);
    expect(back.next).toMatchObject({ state: "B2", trigger: 5827, lost: null });
    // 之后区间继续收窄、现价继续走高:一直是 B2
    for (const [minute, price, b2] of [[60, 5850, 5824], [120, 5870, 5818], [300, 5870, 5808], [350, 5875, 5803]] as const) {
      m = feed(back.next, price, minute * MIN, day(b2)).next;
      expect(m).toMatchObject({ state: "B2", trigger: 5827 });
    }
  });

  it("上沿没动时 B2 失效:现价已经在线下,当场解开,下一格站上照报", () => {
    const m = feed(newMachine(), 7815, 0).next;
    const out = feed(m, 7813, 5 * MIN);
    expect(out.next).toMatchObject({ state: "R", lost: null });
    const again = feed(out.next, 7815, 10 * MIN);
    expect(again.events.map((e) => e.kind)).toEqual(["enter"]);
  });

  it("等着重新上膛的时候跌破昨日下沿:B3 照进,不受它拦", () => {
    const waiting = { ...newMachine(), state: "R" as const, lost: 7790 };
    const { next, events } = feed(waiting, 7770, 0, { b2: 7760 });
    expect(next).toMatchObject({ state: "B3", trigger: B3, lost: 7790 });
    expect(events.map((e) => `${e.kind}:${e.state}`)).toEqual(["enter:B3"]);
    // 没有今日上沿(锚还缺)时解不开,也进不了 B2
    expect(feed(waiting, 7900, 0, { b2: null, b3: null }).next).toMatchObject({ state: "none", lost: 7790 });
  });

  it("不改传进来的那一份", () => {
    const m = newMachine();
    feed(m, 7700, 0, { accelStrike: 7790 });
    expect(m).toEqual(newMachine());
  });
});

describe("重启之后从哪儿接着判", () => {
  const enter = (state: "B2" | "B3", level: number, at: number): PlaybookEvent => ({ at, kind: "enter", state, level, price: level });
  const invalid = (state: "B2" | "B3", level: number, at: number): PlaybookEvent => ({ at, kind: "invalid", state, level, price: level });

  it("有落盘的状态就用它:静默期里没报出来的那一次进入、重新上膛那一下都在里面", () => {
    const events = [enter("B2", 7743.47, 100), invalid("B2", 7743.47, 200)];
    // 事件只到「失效」,落盘的状态已经是又进去了(那一次在静默期里,没报)
    expect(restoreMachine({ at: 300, state: "B2", trigger: 7743.47, since: 300, lost: null }, events))
      .toEqual({ state: "B2", trigger: 7743.47, since: 300, lost: null });
    // 失效之后回过区间里:丢掉的线已经清了
    expect(restoreMachine({ at: 250, state: "R", trigger: null, since: 200, lost: null }, events))
      .toEqual({ state: "R", trigger: null, since: 200, lost: null });
  });

  it("没有落盘状态的底账(加这种记录之前写的):照最后一条进入 / 失效事件推;加速档的事件不算", () => {
    const accel: PlaybookEvent = { at: 900, kind: "accel", state: "B2", level: 7790, price: 7789 };
    expect(restoreMachine(null, [enter("B2", 7765.07, 100), accel])).toEqual({ state: "B2", trigger: 7765.07, since: 100, lost: null });
    expect(restoreMachine(null, [enter("B2", 7765.07, 100), invalid("B2", 7765.07, 200)]))
      .toEqual({ state: "R", trigger: null, since: 200, lost: 7765.07 });
    expect(restoreMachine(null, [enter("B3", 7668.6, 100), invalid("B3", 7668.6, 200)]))
      .toEqual({ state: "R", trigger: null, since: 200, lost: null });
    expect(restoreMachine(null, [])).toEqual({ state: "none", trigger: null, since: null, lost: null });
  });

  it("落盘的状态之后还有更晚的进入 / 失效事件(中途换回过老版本):以事件为准", () => {
    const stale = { at: 100, state: "R" as const, trigger: null, since: 100, lost: null };
    expect(restoreMachine(stale, [enter("B3", 7668.6, 500)])).toEqual({ state: "B3", trigger: 7668.6, since: 500, lost: null });
  });
});

describe("加速档", () => {
  const feed = (m: PlaybookMachine, price: number, at: number, accelStrike: number | null = 7790) =>
    stepMachine(m, { at, price, b3: 7700, b2: 7900, frame: false, accelStrike });

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
