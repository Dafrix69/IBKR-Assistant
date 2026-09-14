/** IBKR 成交时间(Execution.time)的两种真实写法:
 * - execDetails 实时推送:'20260910-10:00:01',UTC;
 * - reqExecutions 应答:'20260910 05:00:01 US/Central',TWS 本地时间 + 时区名。
 * 引擎把 execution.time 原文记进 ibkr.fills[].time。以前 tradereview.parseWhen 两种都认不出,
 * 引擎下的单复盘时开仓/平仓时刻全都退回提交时间并标"估算"。这里钉住两边解析器(parseWhen / parseIbTime)
 * 与复盘取时刻的结果。 */
import { describe, expect, it } from "vitest";

import { fillRow, parseIbTime } from "../src/broker.js";
import { butterflyProfile, entryOf, findExit, parseWhen, utcIso } from "../src/tradereview.js";

const iso = (epoch: number | null): string | null => (epoch === null ? null : utcIso(epoch));

describe("parseWhen:IB 成交时间", () => {
  it("实时推送的 yyyymmdd-hh:mm:ss 按 UTC,不按美东", () => {
    expect(iso(parseWhen("20260910-10:00:01"))).toBe("2026-09-10T10:00:01+00:00");
    expect(iso(parseWhen("20260115-10:00:01"))).toBe("2026-01-15T10:00:01+00:00");
  });

  it("reqExecutions 的带时区名写法按所带时区,夏令时/冬令时都对", () => {
    expect(iso(parseWhen("20260910 05:00:01 US/Central"))).toBe("2026-09-10T10:00:01+00:00"); // CDT UTC-5
    expect(iso(parseWhen("20260115 05:00:01 US/Central"))).toBe("2026-01-15T11:00:01+00:00"); // CST UTC-6
    expect(iso(parseWhen("20260910 06:00:01 US/Eastern"))).toBe("2026-09-10T10:00:01+00:00");
    expect(iso(parseWhen("20260910 03:00:01 US/Pacific"))).toBe("2026-09-10T10:00:01+00:00");
  });

  it("时区名直接是 IANA 的也认", () => {
    expect(iso(parseWhen("20260910 05:00:01 America/Chicago"))).toBe("2026-09-10T10:00:01+00:00");
    expect(iso(parseWhen("20260910 18:00:01 Asia/Shanghai"))).toBe("2026-09-10T10:00:01+00:00");
  });

  it("不带时区名的老写法照旧按美东(含两个空格)", () => {
    expect(iso(parseWhen("20260910 05:00:01"))).toBe("2026-09-10T09:00:01+00:00");
    expect(iso(parseWhen("20260910  05:00:01"))).toBe("2026-09-10T09:00:01+00:00");
  });

  it("日期越界、时区名认不出 → null,不给挪了位的时刻", () => {
    expect(parseWhen("20260231-10:00:01")).toBeNull();
    expect(parseWhen("20260910-24:00:01")).toBeNull();
    expect(parseWhen("20260231 05:00:01 US/Central")).toBeNull();
    expect(parseWhen("20260910 05:00:01 Foo/Bar")).toBeNull();
  });
});

describe("parseIbTime / fillRow:同一套 IB 写法", () => {
  it("实时推送的 UTC 写法也认,成交行时间落成 UTC ISO", () => {
    expect(iso(parseIbTime("20260910-10:00:01"))).toBe("2026-09-10T10:00:01+00:00");
    const row = fillRow({ secType: "BAG" }, { execId: "0001", time: "20260910-10:00:01" });
    expect(row!["time"]).toBe("2026-09-10T10:00:01+00:00");
  });

  it("带时区名、不带时区名、unix 秒照旧", () => {
    expect(iso(parseIbTime("20260910 05:00:01 US/Central"))).toBe("2026-09-10T10:00:01+00:00");
    expect(iso(parseIbTime("20260910  05:00:01"))).toBe("2026-09-10T09:00:01+00:00");
    expect(iso(parseIbTime("1789034401"))).toBe("2026-09-10T10:00:01+00:00");
    expect(parseIbTime("20260910 05:00:01 Foo/Bar")).toBeNull();
  });
});

describe("复盘取时刻:用成交时间,不再退回提交时间", () => {
  // SPX 看涨蝴蝶 6500/6510/6520,created_at 故意比成交早一个多小时,好看出取的是哪个
  const fly = (id: string, action: string, fills: string[], createdAt: string) => ({
    id,
    created_at: createdAt,
    final_status: "filled",
    contract: {
      secType: "BAG", symbol: "SPX", multiplier: "100",
      legs: [
        { strike: 6500, ratio: 1, action: "BUY", right: "C", lastTradeDateOrContractMonth: "20260910" },
        { strike: 6510, ratio: 2, action: "SELL", right: "C", lastTradeDateOrContractMonth: "20260910" },
        { strike: 6520, ratio: 1, action: "BUY", right: "C", lastTradeDateOrContractMonth: "20260910" },
      ],
    },
    order: { action, totalQuantity: 1, lmtPrice: 2.5 },
    ibkr: { avg_fill_price: 2.4, fills: fills.map((time, i) => ({ exec_id: `${id}.${i}`, time })) },
  });

  it("entryOf 取两种写法里最早的成交时间,estimated=false", () => {
    const record = fly("open", "BUY", ["20260910 05:00:03 US/Central", "20260910-10:00:01"], "2026-09-10T08:30:00+00:00");
    const entry = entryOf(record);
    expect(entry.estimated).toBe(false);
    expect(iso(entry.time)).toBe("2026-09-10T10:00:01+00:00");
  });

  it("findExit 用平仓单的成交时间", () => {
    const open = fly("open", "BUY", ["20260910-10:00:01"], "2026-09-10T08:30:00+00:00");
    const close = fly("close", "SELL", ["20260910 09:30:00 US/Central"], "2026-09-10T08:30:00+00:00");
    const found = findExit(butterflyProfile(open)!, entryOf(open).time, [open, close], "open");
    expect(found!["record_id"]).toBe("close");
    expect(iso(found!["time"])).toBe("2026-09-10T14:30:00+00:00");
  });
});
