/** 本地速记解析:黄金对拍(与 Python 逐字节一致)+ 引擎集成(命中时不碰大模型)。
 *
 * 这条路径绕过大模型直接构单,两个实现对同一句话必须给出**同一张单**——
 * 中文摘要、warning 文案、行权价、方向,一个字节都不能差。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { EtNow } from "../src/config.js";
import { TradingEngine } from "../src/engine.js";
import { Notifier } from "../src/notify.js";
import { LLMResponse } from "../src/providers.js";
import { LOCAL_MODEL, tryParseShorthand } from "../src/shorthand.js";
import { TradeStore } from "../src/store.js";
import { expectSame, loadGolden, makeSettings } from "./util.js";

const g = loadGolden("shorthand");
const gc = loadGolden("config");

function et(date: string): EtNow {
  return { epochMs: 0, date, minutes: 10 * 60 + 32, seconds: 0 };
}

const FRIDAY = et("2026-08-14");

describe("golden: shorthand", () => {
  it("cases", () => {
    for (const [i, c] of g.cases.entries()) {
      const out = tryParseShorthand(c.text, c.snapshot, FRIDAY);
      if (c.expect === null) {
        expect(out, `shorthand[${i}] ${c.text}`).toBeNull();
      } else {
        expectSame(out, c.expect, `shorthand[${i}] ${c.text}`);
      }
    }
  });

  it("weekend rejects locally, no LLM round-trip", () => {
    const w = g.weekend;
    const out = tryParseShorthand(w.text, w.snapshot, et(w.moment));
    expect(out).toEqual(w.expect); // 与 Python 侧逐字节一致
    expect(out!["orders"]).toEqual([]);
    expect(out!["rejections"][0]["code"]).toBe("UNSUPPORTED");
  });
});

describe("shorthand: 引擎集成", () => {
  function engineWithRecordingParser() {
    const dir = mkdtempSync(path.join(tmpdir(), "dafri-shorthand-"));
    const settings = makeSettings(gc.base_config, {
      storage: { db_path: path.join(dir, "sh.db") },
    });
    const calls: string[] = [];
    const parser = {
      async parse(_bundle: any, userMessage: string): Promise<LLMResponse> {
        calls.push(userMessage);
        return new LLMResponse(
          JSON.stringify({ orders: [], rejections: [] }),
          "claude-opus-5", "v", "f", 42,
        );
      },
    };
    const engine = new TradingEngine({
      settings, parser, store: new TradeStore(settings.db_path),
      notifier: new Notifier(false), router: null,
    });
    return { engine, calls };
  }

  it("命中速记时完全不调大模型", async () => {
    const { engine, calls } = engineWithRecordingParser();
    const result = await engine.handleInstruction(
      "1.8 挂15蝴蝶 15CM", "manual", FRIDAY, { SPX: 6907.35 },
    );
    expect(calls).toEqual([]);
    expect(result.llm!.model).toBe(LOCAL_MODEL);
    expect(result.llm!.latency_ms).toBe(0);
    expect(result.validated_only).toHaveLength(1); // auto_execute=false → 只校验不发
    expect(result.validated_only[0]!.intent_summary).toContain("6900/6915/6930");
  });

  it("非速记指令照旧走大模型", async () => {
    const { engine, calls } = engineWithRecordingParser();
    const result = await engine.handleInstruction(
      "买入 AAPL 100股 limit 230", "manual", FRIDAY, {},
    );
    expect(calls).toHaveLength(1);
    expect(result.llm!.model).toBe("claude-opus-5");
  });
});

describe("shorthand: 公开源现价兜底(没连券商也要秒解)", () => {
  function engineWithRecordingParser() {
    const dir = mkdtempSync(path.join(tmpdir(), "dafri-shpub-"));
    const settings = makeSettings(gc.base_config, {
      storage: { db_path: path.join(dir, "sh.db") },
    });
    const calls: string[] = [];
    const parser = {
      async parse(_bundle: any, userMessage: string): Promise<LLMResponse> {
        calls.push(userMessage);
        return new LLMResponse(
          JSON.stringify({ orders: [], rejections: [] }), "claude-opus-5", "v", "f", 42,
        );
      },
    };
    const engine = new TradingEngine({
      settings, parser, store: new TradeStore(settings.db_path),
      notifier: new Notifier(false), router: null,
    });
    return { engine, calls };
  }

  it("公开源给出 SPX 现价 → 本地秒解并留痕", async () => {
    const { engine, calls } = engineWithRecordingParser();
    engine.publicPriceFn = async (sym) => (sym === "SPX" ? 6907.35 : null);
    const result = await engine.handleInstruction("1.8 挂15蝴蝶 15CM", "manual", FRIDAY, {});
    expect(calls).toEqual([]);
    expect(result.llm!.model).toBe(LOCAL_MODEL);
    const order = result.validated_only[0]!;
    expect(order.intent_summary).toContain("6900/6915/6930");
    const record = engine.store.getRecord(String(order.record_id))!;
    expect((record.llm.warnings as string[]).some((w) => w.includes("公开数据源"))).toBe(true);
  });

  it("公开源也取不到 → 老实回落大模型", async () => {
    const { engine, calls } = engineWithRecordingParser();
    engine.publicPriceFn = async () => null;
    await engine.handleInstruction("1.8 挂15蝴蝶 15CM", "manual", FRIDAY, {});
    expect(calls).toHaveLength(1);
  });
});
