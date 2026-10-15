/** 一句话里提到了谁(src/symbolMentions.ts)。纯函数,离线。
 *
 * 钉住:
 *  1. 五档的认法与优先级:cashtag > 名单 > 叫法 > 行话推断 > 像代码的大写词;同一只只留最可靠的一次,顺序按原文先后。
 *  2. 不是代码的字母不认:提及、链接、紧贴数字的单位(15CM、0dte、7700C)、行话缩写、整句大写的喊话、小写的普通英文词。
 *  3. 没写标的的行话(Charlie 的频道里的那几种写法)推断成默认标的;写了标的的不推断;关了推断就不推断。
 */
import { describe, expect, it } from "vitest";

import { BUILTIN_KNOWN, confidentSymbols, extractMentions, guessedSymbols, looksLikeOptionTalk, makeUniverse } from "../src/symbolMentions.js";

const U = makeUniverse(["NVDA", "AAPL", "TSLA", "ALL", "SPX"], { 苹果: "AAPL", 英伟达: "NVDA", 特斯拉: "TSLA" }, "SPX");
const syms = (text: string, u = U) => extractMentions(text, u).map((m) => `${m.symbol}:${m.how}`);

describe("认法与优先级", () => {
  it("cashtag、名单、中文叫法、英文叫法各认各的", () => {
    expect(syms("$NVDA 要起飞")).toEqual(["NVDA:cashtag"]);
    expect(syms("NVDA 183 call 看看")).toEqual(["NVDA:known"]);
    expect(syms("英伟达财报后看涨,苹果也不错")).toEqual(["NVDA:alias", "AAPL:alias"]);
    expect(syms("Nvidia 盘后大涨, tesla 跟着")).toEqual(["NVDA:alias", "TSLA:alias"]);
  });

  it("同一只认出几次只留最可靠的那次;顺序按原文先后", () => {
    const m = extractMentions("英伟达 还有 $NVDA 以及 NVDA", U);
    expect(m).toEqual([{ symbol: "NVDA", how: "cashtag", term: "$NVDA" }]);
    expect(syms("苹果 之后是 $NVDA")).toEqual(["AAPL:alias", "NVDA:cashtag"]);
  });

  it("长的叫法先认:「标普500」不会再被「标普」认一遍;配置里的叫法盖过内置的", () => {
    expect(extractMentions("标普500 今天跳空", U)).toEqual([{ symbol: "SPX", how: "alias", term: "标普500" }]);
    const mine = makeUniverse([], { 苹果: "AAPL", 标普: "SPY" }, "SPX");
    expect(syms("标普 要跌", mine)).toEqual(["SPY:alias"]);
  });

  it("名单里的代码小写着写也认(spx 7700 蝴蝶);普通英文词不算(all in 不是 ALL)", () => {
    expect(syms("spx 7700 蝴蝶 1.8")).toEqual(["SPX:known"]);
    expect(syms("all in 了")).toEqual([]);
    expect(syms("ALL 这只票不错")).toEqual(["ALL:known"]);
  });

  it("像代码的大写词但名单里没有:guess,单独一档,不算提到", () => {
    const m = extractMentions("TQQQ 今天放量,CRWV 发债", U);
    expect(m).toEqual([{ symbol: "TQQQ", how: "guess", term: "TQQQ" }, { symbol: "CRWV", how: "guess", term: "CRWV" }]);
    expect(confidentSymbols(m)).toEqual([]);
    expect(guessedSymbols(m)).toEqual(["TQQQ", "CRWV"]);
  });
});

describe("不是代码的字母不认", () => {
  it("提及、链接、表情代码里的字母不算", () => {
    expect(syms("<@220000000000000002> 看看 AAPL <#1100000000000000001> <:pepe:123456>")).toEqual(["AAPL:known"]);
    expect(syms("https://x.com/NVDA/status/1 看这条")).toEqual([]);
    expect(syms("@everyone 7700 7725 bear call -2 -2.5")).toEqual(["SPX:implied"]);
  });

  it("紧贴数字的单位与方向不算:15CM、0dte、7700C、2张", () => {
    expect(syms("1.8 挂15蝴蝶 15CM")).toEqual(["SPX:implied"]);
    expect(syms("0dte 的 7700C 很贵")).toEqual(["SPX:implied"]);
    expect(guessedSymbols(extractMentions("1.8 挂15蝴蝶 15CM", U))).toEqual([]);
  });

  it("行话缩写不猜:CPI、FOMC、ATM、GTC、BPS 都不是代码", () => {
    expect(syms("CPI 之后 FOMC 前别开 ATM 的 GTC 单,BPS 也别卖")).toEqual([]);
  });

  it("整句大写的喊话不猜", () => {
    expect(syms("BUY BUY BUY THIS IS HUGE NEWS LFG")).toEqual([]);
    expect(syms("HUGE 今天")).toEqual(["HUGE:guess"]);
  });

  it("一个字母不算;六个字母以上不算", () => {
    expect(syms("I 觉得 A 股不错, TOOLONG 不是代码")).toEqual([]);
  });
});

describe("没写标的的行话", () => {
  it("蝴蝶、翼宽记号、价差类型词、两个挨着的行权价:推断成默认标的", () => {
    for (const text of ["15蝴蝶 15CM 1.8", "7770 7775 bear call", "00 95 bull put 试下 -2", "7690 7715 put spread", "翼宽 25 的蝶", "蝴蝶止损了哦"]) {
      expect(syms(text), text).toEqual(["SPX:implied"]);
    }
  });

  it("写了标的就不推断;关了推断就不推断;闲聊不推断", () => {
    expect(syms("AAPL 230 240 call spread")).toEqual(["AAPL:known"]);
    expect(syms("7770 7775 bear call", { ...U, implied: null })).toEqual([]);
    expect(syms("今天不交易,休息")).toEqual([]);
    expect(syms("蝴蝶 的 TQQQ 怎么看")).toEqual(["TQQQ:guess", "SPX:implied"]);
  });

  it("looksLikeOptionTalk 只认行话,不认普通句子", () => {
    expect(looksLikeOptionTalk("1.8 挂15蝴蝶 15CM")).toBe(true);
    expect(looksLikeOptionTalk("7700 7725 bear call")).toBe(true);
    expect(looksLikeOptionTalk("买了 7700 7725")).toBe(true);
    expect(looksLikeOptionTalk("今天 CPI 7700 点附近震荡")).toBe(false);
    expect(looksLikeOptionTalk("明天见")).toBe(false);
  });
});

describe("makeUniverse", () => {
  it("内置的指数与 ETF、叫法表的值都进名单;大小写与空白归一", () => {
    const u = makeUniverse([" nvda ", "", "aapl"], {}, null);
    for (const s of BUILTIN_KNOWN) expect(u.known.has(s), s).toBe(true);
    expect(u.known.has("NVDA")).toBe(true);
    expect(u.known.has("AAPL")).toBe(true);
    expect(u.known.has("META")).toBe(true); // 内置叫法 Meta → META
    expect(u.implied).toBeNull();
    expect(u.aliases["英伟达"]).toBe("NVDA");
  });
});
