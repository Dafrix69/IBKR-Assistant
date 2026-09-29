/** 「交易指令」页发送前的两道判断(desktop/renderer-react)。
 *
 *  1. 发到哪几个账户(lib/accountPick.ts,纯函数,这里直接跑):存过的勾选对不上现在的账户时不能卡死——
 *     只剩一个账户时勾选控件是藏起来的,用户看不见也改不了那份勾选,不能让它把每次发送都拦成「请至少勾选一个发单账户」;
 *  2. 保护规则暂停不灰掉「发送」:它只挡新单、不挡平仓,开还是平要引擎对着持仓认,界面先拦就把平仓也拦了。
 *     这一条是页面接线,照 desktop-whitelist.spec.ts 的老办法对着源码核对。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..", "..", "desktop", "renderer-react", "src");
const read = (...p: string[]): string => readFileSync(path.join(SRC, ...p), "utf-8");

interface Acct { alias: string; default?: boolean }
const { pickAccounts } = (await import(/* @vite-ignore */ pathToFileURL(path.join(SRC, "lib", "accountPick.ts")).href)) as unknown as {
  pickAccounts(usable: Acct[], saved: string[] | null): string[];
};

const PAPER: Acct = { alias: "模拟", default: true };
const LIVE: Acct = { alias: "实盘" };
const LIVE2: Acct = { alias: "实盘2" };

describe("发单账户:勾选 → 实际发到哪几个", () => {
  it("没存过勾选:默认账户;都没标默认就取第一个", () => {
    expect(pickAccounts([LIVE, PAPER], null)).toEqual(["模拟"]);
    expect(pickAccounts([LIVE, LIVE2], null)).toEqual(["实盘"]);
    expect(pickAccounts([], null)).toEqual([]);
  });

  it("存过的勾选照用,只留现在还在的账户", () => {
    expect(pickAccounts([PAPER, LIVE], ["模拟", "实盘"])).toEqual(["模拟", "实盘"]);
    expect(pickAccounts([PAPER, LIVE], ["实盘", "已删掉的"])).toEqual(["实盘"]);
  });

  it("账户减到只剩一个、存的勾选指向别的:发这一个", () => {
    expect(pickAccounts([PAPER], ["实盘"])).toEqual(["模拟"]);
    expect(pickAccounts([LIVE], ["模拟"])).toEqual(["实盘"]);
    // 只有一个账户时控件是藏起来的:就算存的是"全不勾",也发这一个
    expect(pickAccounts([LIVE], [])).toEqual(["实盘"]);
  });

  it("两个以上账户、存的勾选一个都对不上(改了别名、换了券商):回到默认账户", () => {
    expect(pickAccounts([PAPER, LIVE2], ["旧别名"])).toEqual(["模拟"]);
  });

  it("两个以上账户、用户自己把勾全去掉:照样是空的——控件看得见,页面会写「未勾选账户,无法发单」", () => {
    expect(pickAccounts([PAPER, LIVE], [])).toEqual([]);
  });

  it("store 这一侧只转手给 pickAccounts,不自己另算一套", () => {
    const store = read("store", "trade.ts");
    expect(store).toContain("return pickAccounts(usable, usePicked.getState().picked);");
    // 回退不写回本机存的那份勾选:账户配置改回来,存着的那份照旧生效
    expect(store.match(/savePickedAccounts\(/g) ?? []).toHaveLength(1); // 只有定义那一处,选的时候不调
  });
});

describe("保护规则暂停:不灰掉「发送」,由引擎按持仓判", () => {
  const page = read("pages", "Trade.tsx");
  const blockerLines = page.split(/\r?\n/).filter((l) => l.includes("blockers.push("));

  it("发送条件里没有保护规则:只剩自动执行、连接、熔断三条", () => {
    expect(blockerLines).toHaveLength(3);
    expect(blockerLines.some((l) => l.includes("protections"))).toBe(false);
    expect(page).not.toContain("'保护规则暂停中')");
  });

  it("暂停时只提醒:新单会被引擎拦下,认得出在减仓的单照发", () => {
    expect(page).toContain("const guard = status?.protections?.paused ? status.protections : null;");
    expect(page).toContain("新开仓的单会被引擎拦下");
    expect(page).toContain("对着持仓认得出是在减仓的单照发");
  });

  it("引擎那一侧确实是这么判的:被规则拦下之前先看这张单是不是在减已有持仓", () => {
    const engine = readFileSync(path.resolve(__dirname, "..", "src", "engine.ts"), "utf-8");
    expect(engine).toContain("reducesPositions(approved.order, approved.account.alias, guardRows)) guard = null;");
  });
});
