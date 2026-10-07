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
import { GRAMMAR_VERSION, LOCAL_MODEL, tryParseShorthand } from "../src/shorthand.js";
import type { ShorthandMeta } from "../src/shorthand.js";
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

describe("shorthand: 数字边界(2026-09-27 审计 V3)", () => {
  // 以前「NN蝴蝶」「N张」的正则左边不设边界:「580蝴蝶」被拆成孤立的 5(当成权利金上限)+「80蝴蝶」
  // (现价百位 + 80),QQQ 在 612 时就成了 670/680/690 看涨蝶、限价 5——和用户要的完全不是一张单。
  // 三位数中心说不清是绝对价还是"百位 + N",语法不接,交给大模型。
  it("三位数中心(没有「的」)不猜,回落大模型", () => {
    const cases: Array<[string, Record<string, number>]> = [
      ["QQQ 580蝴蝶 10cm", { QQQ: 612 }],
      ["QQQ 580蝴蝶 10cm", { QQQ: 585 }],
      ["AAPL 230蝴蝶 5cm", { AAPL: 226 }],
      ["SPY 670蝴蝶 10cm", { SPY: 662 }],
    ];
    for (const [text, snap] of cases) expect(tryParseShorthand(text, snap, FRIDAY), text).toBeNull();
  });

  it("张数不从更长的数字中间截:「1500张」不是 500 张 + 权利金 1", () => {
    expect(tryParseShorthand("1500张 7520的20cm蝴蝶", { SPX: 7462.35 }, FRIDAY)).toBeNull();
  });

  it("四位数中心、「N蝴蝶」、「三位数的」照常解析(对照)", () => {
    const four = tryParseShorthand("7515蝴蝶 15cm 1.8", { SPX: 7462.35 }, FRIDAY);
    expect(four?.["orders"][0]["intent_summary"]).toContain("7500/7515/7530");
    const tail = tryParseShorthand("1.8 挂15蝴蝶 15CM", { SPX: 6907.35 }, FRIDAY);
    expect(tail?.["orders"][0]["intent_summary"]).toContain("6900/6915/6930");
    const three = tryParseShorthand("QQQ 580的10cm蝴蝶 看跌 2", { QQQ: 585 }, FRIDAY);
    expect(three?.["orders"][0]["intent_summary"]).toContain("570/580/590");
    expect(three?.["orders"][0]["order"]["lmtPrice"]).toBe(2);
  });

  it("语法收窄,版本号跟着升", () => {
    expect(GRAMMAR_VERSION).toBe("shorthand-v5");
  });
});


// ---------------------------------------------------------------- v5:闲字与相对写法的标记
// 样本都是 Charlie 的频道里真实出现过的写法(2026-09-17 到 10-07);现价取 7650.2,周五。
describe("shorthand v5: 闲字表补了真实出现过的语气词", () => {
  const SPOT = { SPX: 7650.2 };
  const parse = (text: string, meta?: ShorthandMeta) => tryParseShorthand(text, SPOT, FRIDAY, meta);
  const order = (text: string) => (parse(text) as any)?.orders?.[0];

  it("「一下」「试一下」「试试看」「赌博小彩票」「好贵」不带交易语义:接住,单子和不带它们时一模一样", () => {
    const bare = order("7600蝴蝶 25CM 3.1");
    expect(bare.order.lmtPrice).toBe(3.1);
    for (const text of [
      "7600蝴蝶 25CM 3.1 彩票一下",
      "7600蝴蝶 25CM 3.1 试一下",
      "7600蝴蝶 25CM 挂3.1试试看",
      "7600蝴蝶 25CM 3.1 赌博小彩票",
      "7600蝴蝶 25CM 3.1 好贵",
    ]) {
      const o = order(text);
      expect(o, text).toBeDefined();
      expect(o.contract.legs.map((l: any) => l.strike), text).toEqual([7575, 7600, 7625]);
      expect(o.order.lmtPrice, text).toBe(3.1);
    }
  });

  it("频道里原样出现过的几句", () => {
    expect(order("45 10cm蝴蝶 2块钱 赌博小彩票").order.lmtPrice).toBe(2);
    expect(order("50蝴蝶 20CM 挂个3.9试试 好贵").contract.legs.map((l: any) => l.strike)).toEqual([7630, 7650, 7670]);
    expect(order("20蝴蝶 25cm 挂个4.5试试").order.lmtPrice).toBe(4.5);
    expect(order("7770蝴蝶 20CM 4块钱试试").order.lmtPrice).toBe(4);
  });

  it("仍然不接:不认识的词、带条件的、写不清的——只放行闲字,不放行语义", () => {
    // 动词不是闲字:「走一下」只吃掉「一下」,「走」留下来,整句交给大模型
    expect(parse("20蝴蝶 25cm 挂4.5 走一下")).toBeNull();
    // 止损条件
    expect(parse("7725蝴蝶 25CM 挂4块钱 不要追价 51.5站稳考虑止损")).toBeNull();
    // 7605/10:7605 还是 7610,说不清
    expect(parse("7605/10 蝴蝶 25cm")).toBeNull();
    // 「2块1」是 2.1 元的另一种写法,语法还不认
    expect(parse("2块1尝试下 7650 10CM彩票")).toBeNull();
    // 商榷的口气不是单子
    expect(parse("你考虑开40左右的蝴蝶")).toBeNull();
  });

  it("meta.relativeCenter:「N蝴蝶」(百位 + N)是 true,写明中心的是 false;不传 meta 照常", () => {
    const rel: ShorthandMeta = { relativeCenter: false };
    expect(parse("20蝴蝶 25cm 挂个4.5试试", rel)).not.toBeNull();
    expect(rel.relativeCenter).toBe(true);
    const abs: ShorthandMeta = { relativeCenter: true };
    expect(parse("7645 蝴蝶 25cm", abs)).not.toBeNull();
    expect(abs.relativeCenter).toBe(false);
    const abs2: ShorthandMeta = { relativeCenter: true };
    expect(parse("7650 10CM彩票 3", abs2)).not.toBeNull();
    expect(abs2.relativeCenter).toBe(false);
    expect(parse("20蝴蝶 25cm")).not.toBeNull();
  });
});
