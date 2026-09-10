/** 持仓表:只按增量维护,不信 @stoqey/ib 那份会被截尾的 `all`。
 *
 * 库在持仓归零时用 `splice(i)` 删缓存(少了删除个数),把第 i 个之后的全删了。2026-09-10 真机:
 * 蝶的止盈单成交、三条腿归零,排在后面的 BE 跟着从 `all` 里消失,盯盘判「持仓已不存在」,
 * BE 的追踪被自动停用。这里用库真实会吐出来的形状把那一幕复现出来。
 */
import { describe, expect, it } from "vitest";

import { applyPositionUpdate } from "../src/ibSession.js";

const ACCT = "DUN841779";
const leg = (conId: number, strike: number, right: string, pos: number) => ({
  account: ACCT, contract: { conId, symbol: "SPX", secType: "OPT", strike, right }, pos, avgCost: 100,
});
const be = (pos = 3) => ({ account: ACCT, contract: { conId: 326398514, symbol: "BE", secType: "STK" }, pos, avgCost: 222.93 });
const group = (rows: any[]) => new Map([[ACCT, rows]]);

describe("applyPositionUpdate", () => {
  it("首次(positionEnd 之后、不带增量)用完整快照建表,零数量的不进表", () => {
    const t = applyPositionUpdate(null, { all: group([leg(1, 7625, "P", 1), leg(2, 7650, "P", -2), be(), leg(9, 7700, "C", 0)]) });
    expect([...t.values()].map((p) => p.contract.symbol + p.pos)).toEqual(["SPX1", "SPX-2", "BE3"]);
  });

  it("库的 bug:一条腿归零,推来的 all 已经把后面的 BE 截掉了——表里 BE 必须还在", () => {
    let t = applyPositionUpdate(null, { all: group([leg(1, 7625, "P", 1), leg(2, 7650, "P", -2), leg(3, 7675, "P", 1), be()]) });
    // 7625P 平掉:库 splice(0) 把整个数组清空,推 { all: 空, removed: [7625P] }
    t = applyPositionUpdate(t, { all: group([]), removed: group([leg(1, 7625, "P", 0)]) });
    // 另两条腿归零:它们已不在库的缓存里,库当成"新增"推 { added: [pos 0] }
    t = applyPositionUpdate(t, { all: group([leg(2, 7650, "P", 0)]), added: group([leg(2, 7650, "P", 0)]) });
    t = applyPositionUpdate(t, { all: group([leg(3, 7675, "P", 0)]), added: group([leg(3, 7675, "P", 0)]) });
    expect([...t.values()].map((p) => p.contract.symbol + p.pos)).toEqual(["BE3"]);
  });

  it("被库截掉过的持仓后来变了(库当成新增)→ 表里照常更新", () => {
    let t = applyPositionUpdate(null, { all: group([leg(1, 7625, "P", 1), be(3)]) });
    t = applyPositionUpdate(t, { all: group([]), removed: group([leg(1, 7625, "P", 0)]) });
    t = applyPositionUpdate(t, { all: group([be(4)]), added: group([be(4)]) });
    expect([...t.values()].map((p) => p.contract.symbol + p.pos)).toEqual(["BE4"]);
  });

  it("changed 更新数量;数量变 0 当平仓删掉", () => {
    let t = applyPositionUpdate(null, { all: group([be(3)]) });
    t = applyPositionUpdate(t, { all: group([be(5)]), changed: group([be(5)]) });
    expect(t.get(`${ACCT}|326398514`)!.pos).toBe(5);
    t = applyPositionUpdate(t, { all: group([]), changed: group([be(0)]) });
    expect(t.size).toBe(0);
  });
});
