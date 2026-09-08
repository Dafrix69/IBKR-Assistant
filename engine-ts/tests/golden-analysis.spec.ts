/** 黄金对拍:priceaction / optionwall / alerts / market / research。 */
import { describe, expect, it } from "vitest";

import * as pa from "../src/priceaction.js";
import * as ow from "../src/optionwall.js";
import * as alerts from "../src/alerts.js";
import { buildSnapshot, extractSymbols } from "../src/market.js";
import { briefText, resolveAnchor, symbolBrief } from "../src/research.js";
import { expectSame, loadGolden, makeSettings } from "./util.js";

// ---------------------------------------------------------------- priceaction
describe("golden: priceaction", () => {
  const g = loadGolden("priceaction");

  it("timeframes table", () => {
    expectSame(pa.TIMEFRAMES, g.timeframes, "TIMEFRAMES");
  });

  for (const c of g.cases) {
    it(c.name, () => {
      const now = Date.parse(c.now);
      if (c.error !== undefined) {
        expect(() =>
          pa.analyze(c.rows, c.symbol, c.timeframe, pa.SWING_STRENGTH, now, c.extended_hours),
        ).toThrowError(c.error);
        return;
      }
      const result = pa.analyze(c.rows, c.symbol, c.timeframe, pa.SWING_STRENGTH, now, c.extended_hours);
      expectSame(result, c.expect, c.name);
      expect(pa.factsText(result)).toBe(c.facts_text);
      expectSame(pa.htfSummary(result), c.htf_summary, `${c.name}.htf_summary`);
    });
  }

  it("agreement", () => {
    const now = Date.parse(g.cases[0].now);
    const byName: Record<string, any> = {};
    for (const c of g.cases) {
      if (c.error === undefined) {
        byName[c.name] = pa.analyze(
          c.rows, c.symbol, c.timeframe, pa.SWING_STRENGTH, now, c.extended_hours,
        );
      }
    }
    const up = pa.analyze(
      g.cases.find((c: any) => c.name === "uptrend").rows, "UP", "5m", pa.SWING_STRENGTH, now,
    );
    const down = pa.analyze(
      g.cases.find((c: any) => c.name === "downtrend").rows, "DN", "5m", pa.SWING_STRENGTH, now,
    );
    const summaries: Record<string, any> = {
      uptrend: pa.htfSummary(up),
      downtrend: pa.htfSummary(down),
    };
    for (const a of g.agreement) {
      const higher = a.b === null ? null : summaries[a.b];
      expectSame(pa.agreement(up, higher), a.expect, `agreement(${a.a},${a.b})`);
    }
  });
});

// ---------------------------------------------------------------- optionwall
describe("golden: optionwall", () => {
  const g = loadGolden("optionwall");

  for (const c of g.cases) {
    it(c.name, () => {
      const result = ow.analyze(c.rows, c.spot, c.expiry, c.symbol, ow.MULTIPLIER, Date.parse(c.now));
      expectSame(result, c.expect, c.name);
      expectSame(ow.levelsForPa(result), c.levels_for_pa, `${c.name}.levels_for_pa`);
    });
  }

  it("errors", () => {
    for (const e of g.errors) {
      if (e.name === "no_spot") {
        expect(() => ow.analyze([], 0.0, "20260918")).toThrowError(e.error);
      }
    }
    // few_strikes:用第一个 case 的前 6 行
    const few = g.errors.find((e: any) => e.name === "few_strikes");
    expect(() =>
      ow.analyze(g.cases[0].rows.slice(0, 6), g.cases[0].spot, "20260918"),
    ).toThrowError(few.error);
  });

  it("bs_gamma / years_to_expiry", () => {
    for (const c of g.bs_gamma) {
      expect(ow.bsGamma(c.spot, c.strike, c.t, c.sigma)).toBeCloseTo(c.expect, 12);
    }
    for (const c of g.years_to_expiry) {
      const out = ow.yearsToExpiry(c.expiry, Date.parse(c.now));
      expect(Math.abs(out - c.expect)).toBeLessThan(1e-9);
    }
  });
});

// ---------------------------------------------------------------- alerts
describe("golden: alerts", () => {
  const g = loadGolden("alerts");

  it("round_levels", () => {
    for (const c of g.round_levels) {
      expectSame(alerts.roundLevels(c.spot, c.step), c.expect, `round(${c.spot})`);
    }
  });

  it("build_levels + describe", () => {
    for (const [i, c] of g.build_levels.entries()) {
      const levels = alerts.buildLevels(c.spot, c.wall, c.step);
      expectSame(
        levels.map((l) => ({ ...alerts.levelDict(l), priority: l.priority })),
        c.expect,
        `build[${i}]`,
      );
      expect(alerts.describe(levels, c.spot)).toEqual(c.describe);
    }
  });

  it("trend_levels + snapshot", () => {
    for (const [i, c] of g.trend_levels.entries()) {
      const levels = alerts.trendLevels(c.bars, c.spot);
      expectSame(
        levels.map((l) => ({ ...alerts.levelDict(l), priority: l.priority })),
        c.expect,
        `trend[${i}]`,
      );
      expectSame(alerts.trendSnapshot(c.bars, c.spot), c.snapshot, `trend[${i}].snapshot`);
    }
  });

  it("build_levels with history", () => {
    const w = g.build_with_history;
    const levels = alerts.buildLevels(w.spot, null, w.step, undefined, undefined, w.bars);
    expectSame(
      levels.map((l) => ({ ...alerts.levelDict(l), priority: l.priority })),
      w.expect,
      "build_with_history",
    );
  });

  it("evaluate walk", () => {
    const w = g.walk;
    const levels = alerts.buildLevels(w.spot, w.wall, w.step);
    let states: Record<string, alerts.LevelState> = {};
    let prev: number | null = null;
    let stepIdx = 0;
    for (const [i, price] of w.prices.entries()) {
      if (price === null) {
        prev = null;
        continue;
      }
      const [events, next] = alerts.evaluate(levels, states, prev, price, w.t0 + i * 60.0);
      states = next;
      const expected = w.steps[stepIdx++];
      expectSame(events, expected.events, `walk[${i}].events`);
      const sortedStates: Record<string, unknown> = {};
      for (const k of Object.keys(states).sort()) {
        sortedStates[k] = { armed: states[k]!.armed, last_fired_at: states[k]!.last_fired_at };
      }
      expectSame(sortedStates, expected.states, `walk[${i}].states`);
      prev = price;
    }
  });

  it("cooldown walk", () => {
    const w = g.cooldown_walk;
    const levels = alerts.buildLevels(452.6, g.walk.wall, 5.0);
    let states: Record<string, alerts.LevelState> = {};
    let prev: number | null = null;
    for (const [i, [price, dt]] of w.seq.entries()) {
      const [events, next] = alerts.evaluate(
        levels, states, prev, price, g.walk.t0 + dt, w.band_pct, w.cooldown,
      );
      states = next;
      expectSame(events, w.steps[i].events, `cooldown[${i}].events`);
      prev = price;
    }
  });
});

// ---------------------------------------------------------------- market
describe("golden: market", () => {
  const g = loadGolden("market");
  const settings = makeSettings(g.base_config);

  it("extract_symbols", () => {
    for (const c of g.cases) {
      expect(extractSymbols(c.text, settings), c.text).toEqual(c.default);
      expect(extractSymbols(c.text, settings, null, false), `${c.text} (no default)`).toEqual(
        c.no_default,
      );
    }
    expect(extractSymbols("苹果", settings, ["QQQ"])).toEqual(g.extra);
  });

  it("build_snapshot", () => {
    const snapshot = buildSnapshot(
      ["AAPL", "SPX", "FAIL", "NONE"],
      (s) => {
        if (s === "FAIL") throw new Error("boom");
        return ({ AAPL: 229.4, SPX: 7462.35 } as Record<string, number>)[s] ?? null;
      },
      { NONE: 12.5 },
    );
    expectSame(snapshot, g.snapshot, "snapshot");
  });
});

// ---------------------------------------------------------------- research
describe("golden: research", () => {
  const g = loadGolden("research");

  it("resolve_anchor", () => {
    for (const c of g.anchors) {
      expectSame(resolveAnchor(c.text, g.bars, g.today), c.expect, c.text);
    }
  });

  it("symbol_brief + brief_text", () => {
    const brief = symbolBrief(g.bars);
    expectSame(brief, g.brief, "brief");
    expect(briefText("AAPL", { ...brief })).toBe(g.brief_text);
    expect(briefText(null, null)).toBe(g.brief_text_none);
    expect(briefText("AAPL", null)).toBe(g.brief_text_no_data);
    expect(briefText("AAPL", { error: "timeout" })).toBe(g.brief_text_error);
    expect(briefText("AAPL", { ...brief, anchor: g.anchors[0].expect })).toBe(g.brief_text_anchor);
    expectSame(symbolBrief(g.bars.slice(0, 1)), g.brief_short, "brief_short");
  });
});
