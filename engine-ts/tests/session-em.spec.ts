/** 当天的 EM 从日内剧本的底账里来(sessionEm.ts);止盈回放的阶段可以按剩余方差切;提前收盘日的到期时刻。 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { etNowFromEpoch } from "../src/config.js";
import type { PlaybookBand } from "../src/contract/options.js";
import { SessionEmCache } from "../src/engine/sessionEm.js";
import * as fx from "../src/flyexit.js";
import { FLY_IV_MODEL } from "../src/flyIvModel.js";
import { expiryEpochMs, legInputsOf } from "../src/ivPricing.js";
import { EM_FACTOR } from "../src/playbook.js";
import { PlaybookLog } from "../src/playbookLog.js";
import { sessionEmOf, sessionSigmaOf } from "../src/sessionEm.js";
import * as tk from "../src/tracker.js";
import { loadGolden, makeSettings } from "./util.js";

const g = loadGolden("config");
const DAY = "2026-09-10";
const atEt = (hhmm: string, day = DAY): number => Date.parse(`${day}T${hhmm}:00-04:00`);
const band = (hhmm: string, em: number, over: Partial<PlaybookBand> = {}): PlaybookBand => ({
  at: atEt(hhmm), anchor: 7720, strike: 7720, expiry: DAY.replace(/-/g, ""), call: em / EM_FACTOR / 2, put: em / EM_FACTOR / 2,
  em, lower: 7720 - em, upper: 7720 + em, source: "live", ...over,
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("一条区间折回常规时段全天的 1σ", () => {
  it("和 flyexit.sigmaRemaining 是同一个式子反过来:拿折回去的数再算那一刻的剩余 σ,还原记下来的那个数", () => {
    for (const hhmm of ["09:35", "10:30", "12:00", "14:00", "15:30"]) {
      const b = band(hhmm, 30);
      const day = sessionSigmaOf(b)!;
      const [h, m] = hhmm.split(":").map(Number) as [number, number];
      expect(fx.sigmaRemaining(day, h * 60 + m), hhmm).toBeCloseTo(30, 1);
    }
  });

  it("09:35 那一条:只走掉了第一个半小时的六分之一,全天 σ 比它略大", () => {
    const share = 1 - FLY_IV_MODEL.variance_weights[0]! * (5 / 30);
    expect(sessionSigmaOf(band("09:35", 40))).toBeCloseTo(40 / Math.sqrt(share), 2);
  });

  it("不是当天到期的、开盘前 / 收盘后取的、em 不是正数:null", () => {
    expect(sessionSigmaOf(band("09:35", 40, { expiry: "20260911" }))).toBeNull(); // 昨日口径:取的是第二天到期的
    expect(sessionSigmaOf(band("16:10", 40))).toBeNull();
    expect(sessionSigmaOf(band("09:35", 0))).toBeNull();
    expect(sessionSigmaOf(band("09:00", 40))).toBe(40); // 开盘前:全天的方差都还在
  });
});

describe("从一天的底账里挑", () => {
  const rec = (kind: string, b: PlaybookBand) => ({ kind, band: b });

  it("盘初那一条优先;没有就用当天最早的一条当前区间;昨日口径不用", () => {
    const records = [rec("prior", band("16:10", 55, { at: atEt("16:10", "2026-09-09") })), rec("frame", band("11:00", 25)), rec("frame", band("10:00", 30)), rec("open", band("09:35", 40))];
    expect(sessionEmOf(records)).toMatchObject({ kind: "open", at: "09:35" });
    const noOpen = sessionEmOf(records.filter((r) => r.kind !== "open"))!;
    expect(noOpen).toMatchObject({ kind: "frame", at: "10:00" });
    expect(noOpen.em).toBe(sessionSigmaOf(band("10:00", 30)));
    expect(sessionEmOf(records.filter((r) => r.kind === "prior"))).toBeNull();
  });

  it("空的底账、只有事件、提前收盘日:null", () => {
    expect(sessionEmOf([])).toBeNull();
    expect(sessionEmOf([{ kind: "event" }])).toBeNull();
    expect(sessionEmOf([rec("open", band("09:35", 40))], true)).toBeNull();
  });
});

describe("今天的 EM:引擎从底账里读,一分钟读一次", () => {
  function setup(): { cache: SessionEmCache; log: PlaybookLog } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-em-"));
    dirs.push(dir);
    const settings = makeSettings(g.base_config, { storage: { db_path: path.join(dir, "t.db") } });
    return { cache: new SessionEmCache(() => settings), log: new PlaybookLog(path.join(dir, "playbook")) };
  }

  it("今天没记到:null;记到了:折回全天的那个数;一分钟之内不重读", () => {
    const { cache, log } = setup();
    expect(cache.today(etNowFromEpoch(atEt("10:00")))).toBeNull();
    log.append(DAY, { kind: "open", band: band("09:35", 40) });
    // 缓存还热着:仍是上一次读到的
    expect(cache.today(etNowFromEpoch(atEt("10:00") + 30_000))).toBeNull();
    expect(cache.today(etNowFromEpoch(atEt("10:02")))).toBe(sessionSigmaOf(band("09:35", 40)));
    // 换了一天:重读,那一天没有
    expect(cache.today(etNowFromEpoch(atEt("10:00", "2026-09-11")))).toBeNull();
  });
});

describe("止盈回放:阶段 A 可以按剩余方差切", () => {
  it("不给 cutoff_a_share:按 14:00 的钟点,和以前一样", () => {
    const params = fx.paramsFrom(null);
    expect(params["cutoff_a_share"]).toBeNull();
    expect(fx.cutoffMinute(params)).toBe(14 * 60);
    expect(fx.phaseAt(13 * 60 + 59, 25, params)).toBe("A");
    expect(fx.phaseAt(14 * 60, 25, params)).not.toBe("A");
  });

  it("给了:剩余方差第一次不超过它的那一分钟;给 14:00 那一刻的份额,切点还是 14:00", () => {
    const at14 = fx.remainingVariance(14 * 60);
    const params = fx.paramsFrom({ cutoff_a_share: at14 });
    expect(fx.cutoffMinute(params)).toBe(14 * 60);
    const half = fx.paramsFrom({ cutoff_a_share: 0.5 });
    const cut = fx.cutoffMinute(half);
    expect(fx.remainingVariance(cut)).toBeLessThanOrEqual(0.5);
    expect(fx.remainingVariance(cut - 1)).toBeGreaterThan(0.5);
    expect(fx.phaseAt(cut - 1, 25, half)).toBe("A");
    expect(fx.phaseAt(cut, 25, half)).not.toBe("A");
  });
});

describe("提前收盘日的到期时刻", () => {
  it("收盘结算的合约那天 13:00 到期;开盘结算的月度合约不变;平常日子不变", () => {
    expect(expiryEpochMs("SPX", "20261127", "SPXW", true)).toBe(Date.parse("2026-11-27T13:00:00-05:00"));
    expect(expiryEpochMs("SPX", "20261127", "SPXW")).toBe(Date.parse("2026-11-27T16:00:00-05:00"));
    expect(expiryEpochMs("SPX", "20261119", "SPX", true)).toBe(Date.parse("2026-11-20T09:30:00-05:00")); // 开盘结算:提前收盘与它无关
    expect(expiryEpochMs("AAPL", "20261127", "", true)).toBe(Date.parse("2026-11-27T13:00:00-05:00"));
  });

  it("legInputsOf 按日历问那一天是不是提前收盘", () => {
    const contract = { secType: "OPT", symbol: "SPX", lastTradeDateOrContractMonth: "20261127", strike: 7750, right: "C", tradingClass: "SPXW" };
    const row = { sec_type: "OPT", symbol: "SPX", contract, market_price: 5, model_iv: 0.2 };
    const asked: string[] = [];
    const out = legInputsOf(row, {}, tk.legPriceKey, (d) => { asked.push(d); return d === "2026-11-27"; });
    expect(asked).toEqual(["2026-11-27"]);
    expect(out.expiryMs).toBe(Date.parse("2026-11-27T13:00:00-05:00"));
    expect(legInputsOf(row, {}, tk.legPriceKey).expiryMs).toBe(Date.parse("2026-11-27T16:00:00-05:00"));
  });
});
