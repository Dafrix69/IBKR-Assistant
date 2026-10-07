/** 日志脱敏与诊断包(desktop/redact.js、desktop/diagnostics.js)。
 *
 * 用户遇到问题会把日志、诊断包发给别人。钉的是:真实账号、API Key、家目录里的用户名出不去;
 * 交易数据(通知行里的成交摘要)不进日志;诊断包里该有的都有、不该有的没有。离线,只碰临时目录。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const DESKTOP = path.resolve(__dirname, "..", "..", "desktop");
const require = createRequire(import.meta.url);

interface Redact {
  createRedactor(opts?: { accounts?: string[]; homedir?: string }): (text: unknown) => string;
  accountsFromConfig(config: unknown): string[];
  redactConfig(config: unknown): Record<string, any> | null;
  maskAccount(id: string): string;
}
interface Diagnostics {
  buildReport(input: Record<string, unknown>): string;
  buildSummary(input: Record<string, unknown>): string;
  defaultFileName(now?: number): string;
  tailFile(file: string, maxLines: number): { ok: boolean; total: number; lines: string[]; error?: string };
  LOG_TAIL_LINES: number;
}
const redactMod = require(path.join(DESKTOP, "redact.js")) as Redact;
const diag = require(path.join(DESKTOP, "diagnostics.js")) as Diagnostics;

const CONFIG = {
  ...JSON.parse(readFileSync(path.resolve(__dirname, "..", "baseline", "rpc", "base_config.json"), "utf-8")),
  accounts: [
    { alias: "模拟", account_id: "DU7654321", is_paper: true, connection: "paper", default: true },
    { alias: "主账户", account_id: "U1234567", is_paper: false, connection: "live" },
    { alias: "富途", account_id: "28190044", is_paper: true, connection: "paper" },
  ],
};

describe("脱敏", () => {
  const redact = redactMod.createRedactor({ accounts: redactMod.accountsFromConfig(CONFIG), homedir: "/Users/zhangsan" });

  it("配置里的真实账号:逐个打码,留开头的字母与末三位", () => {
    // 引擎的 redactAccount 留前两个字符:DU 开头的两边一样,U1234567 在引擎那边是 U1***567
    expect(redact("order rejected for account U1234567: margin")).toBe("order rejected for account U***567: margin");
    expect(redact("DU7654321 与 U1234567")).toBe("DU***321 与 U***567");
    expect(redact("富途账户 28190044 解锁失败")).toBe("富途账户 ***044 解锁失败");
    expect(redactMod.maskAccount("DU7654321")).toBe("DU***321");
  });

  it("配置里没写、但长得像 IBKR 账号的串也抹", () => {
    expect(redact("managedAccounts: U9988776,DU1122334,F5566778")).toBe("managedAccounts: U***776,DU***334,F***778");
    // 不误伤:订单号、行权价、日期、小写十六进制
    expect(redact("orderId 12345678 strike 7450 expiry 20260928 ref f1234567")).toBe("orderId 12345678 strike 7450 expiry 20260928 ref f1234567");
  });

  it("API Key 与令牌", () => {
    expect(redact("key sk-ant-api03-AbCdEf123456_xyz used")).toBe("key sk-*** used");
    // Discord bot token(三段式):不带任何键名、孤零零出现在一行报错里也要抹。
    // 三段在这里拼起来:源码里写成一整串,GitHub 的推送保护会把这个假 token 当成真的拒掉推送
    const fakeBotToken = ["MTIzNDU2Nzg5MDEyMzQ1Njc4OQ", "GaBcDe", "abcdefghijklmnopqrstuvwxyz0123456789AB"].join(".");
    expect(redact(`gateway auth failed with ${fakeBotToken}`)).toBe("gateway auth failed with ***.***.***");
    // 普通的带点的东西不受影响:版本号、文件名、域名
    expect(redact("engine 0.5.1 at services/follow.spec.ts via gateway.discord.gg")).toBe("engine 0.5.1 at services/follow.spec.ts via gateway.discord.gg");
    expect(redact("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig")).not.toMatch(/eyJhbGci/);
    expect(redact('{"api_key": "abcdef123456"}')).toBe('{"api_key": "***"}');
    expect(redact("x-api-key: 9f8e7d6c5b4a")).toBe("x-api-key: ***");
    expect(redact("password=hunter2secret&next=1")).toBe("password=***&next=1");
  });

  it("不把配置里正常的键当成密钥", () => {
    const text = '"max_tokens": 8000, "keychain_service": "dafri-llm-api-key", "keychain_account": "anthropic"';
    expect(redact(text)).toBe(text);
  });

  it("家目录里的用户名", () => {
    expect(redact("at foo (/Users/zhangsan/Library/Application Support/x.js:1:1)")).toBe("at foo (~/Library/Application Support/x.js:1:1)");
  });

  it("通知行(非 macOS 上引擎打到 stderr 的):只留标题,成交摘要不进日志", () => {
    expect(redact("[通知] 成交回报 | 账户 模拟 | BUY AAPL 100 @ 230.0000")).toBe("[通知] 成交回报 | (内容不进日志)");
    expect(redact("[engine] ok\n[通知] 下单提醒 | warning | 限价偏离现价 3%\n[engine] next")).toBe(
      "[engine] ok\n[通知] 下单提醒 | (内容不进日志)\n[engine] next",
    );
  });

  it("不是字符串也不炸", () => {
    expect(redact(undefined)).toBe("");
    expect(redact(null)).toBe("");
    expect(redact(42)).toBe("42");
  });

  it("redactConfig:账号打码,别的原样;不改传进来的那一份", () => {
    const out = redactMod.redactConfig(CONFIG)!;
    expect(out.accounts.map((a: { account_id: string }) => a.account_id)).toEqual(["DU***321", "U***567", "***044"]);
    expect(out.accounts[0].alias).toBe("模拟");
    expect(out.limits).toEqual(CONFIG.limits);
    expect(out.llm.max_tokens).toBe(CONFIG.llm.max_tokens);
    expect(CONFIG.accounts[1]!.account_id).toBe("U1234567");
    expect(redactMod.redactConfig(null)).toBeNull();
  });
});

describe("诊断包", () => {
  let dir = "";
  let configPath = "";
  let logPath = "";

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "dafri-diag-"));
    configPath = path.join(dir, "settings.json");
    logPath = path.join(dir, "main.log");
    writeFileSync(configPath, JSON.stringify(CONFIG));
    writeFileSync(logPath, [
      "[2026-09-28 09:30:01.000] [info]  [engine] 启动引擎(node)",
      "[2026-09-28 09:30:05.000] [warn]  [engine] IB error 201 for U1234567: Order rejected",
      "[2026-09-28 09:30:06.000] [info]  [engine] [通知] 成交回报 | 账户 模拟 | BUY AAPL 100 @ 230.0000",
      "[2026-09-28 09:30:07.000] [error] llm 401 key sk-live-abcdefgh12345678",
      "",
    ].join("\n"));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 上文件可能还被占着(SQLite、刚退出的子进程):临时目录留给系统清 */
    }
  });

  const input = (): Record<string, unknown> => ({
    app: { version: "0.5.1", platform: "darwin", arch: "arm64", os: "Darwin 27.0.0", electron: "40.0.0", node: "24.0.0", user_data: "/Users/zhangsan/Library/Application Support/IBKR-Assistant" },
    configPath,
    logPath,
    homedir: "/Users/zhangsan",
    now: Date.parse("2026-09-28T01:30:00Z"),
    engine: {
      running: true,
      restarts: 1,
      status: { broker_provider: "ibkr", broker_connected: true, market_status: "盘中", now_et: "2026-09-27 21:30:00", auto_execute: true, allow_live_trading: false, breaker: { engaged: false }, model: "claude-opus-5", prompt_version: "v1.8.0", accounts: [{ alias: "主账户", account_masked: "U***567" }] },
      selftest: { prompt_version: "v1.8.0", symbol_aliases: { 苹果: "AAPL", 特斯拉: "TSLA" } },
      backups: { db_path: "/Users/zhangsan/Library/Application Support/dafri/trades.db", backups: [] },
      errors: [],
    },
    extra: { consent: { version: "2026-09-28", accepted: true } },
  });

  it("该有的都有:版本、引擎状态、配置、日志", () => {
    const text = diag.buildReport(input());
    for (const heading of ["应用与系统", "交易引擎", "引擎状态(system.status)", "引擎自检(system.selftest)", "交易库与备份(data.backups)", "配置(已脱敏)", "其它", "日志 "]) {
      expect(text, heading).toContain(`===== ${heading}`);
    }
    expect(text).toContain('"version": "0.5.1"');
    expect(text).toContain("启动引擎(node)");
    expect(text).toContain('"symbol_alias_count": 2');
  });

  it("不该有的没有:真实账号、Key、用户名、成交摘要", () => {
    const text = diag.buildReport(input());
    expect(text).not.toContain("U1234567");
    expect(text).not.toContain("DU7654321");
    expect(text).not.toContain("28190044");
    expect(text).not.toContain("sk-live-abcdefgh12345678");
    expect(text).not.toContain("zhangsan");
    expect(text).not.toContain("BUY AAPL 100");
    // 别名表在「配置」那一节里有一份就够了(查解析问题用得上),自检那一节只报条数
    expect(text.match(/特斯拉/g)).toHaveLength(1);
    expect(text).toContain("U***567");
  });

  it("配置读不出来、日志不在:照样出得来(那正是最需要它的时候)", () => {
    writeFileSync(configPath, "{ 坏的");
    rmSync(logPath);
    const text = diag.buildReport({ ...input(), engine: { running: false, restarts: 4, errors: ["system.status:交易引擎已退出"] } });
    expect(text).toMatch(/配置文件 .* 读不出来/);
    expect(text).toMatch(/读不出来:文件不存在/);
    expect(text).toContain('"running": false');
    expect(text).toContain("system.status:交易引擎已退出");
  });

  it("日志只带最后一段,超长的行截断", () => {
    const many = Array.from({ length: diag.LOG_TAIL_LINES + 500 }, (_, i) => `line ${i}`);
    many.push("x".repeat(5000));
    writeFileSync(logPath, many.join("\n") + "\n");
    const text = diag.buildReport(input());
    expect(text).not.toContain("line 10\n");
    expect(text).toContain(`line ${diag.LOG_TAIL_LINES + 499}`);
    expect(text).toContain("…(截断)");
    expect(text.length).toBeLessThan(400_000);
  });

  it("概要:几行字,不带日志", () => {
    const text = diag.buildSummary(input());
    expect(text.split("\n").length).toBeLessThanOrEqual(8);
    expect(text).toContain("IBKR-Assistant 0.5.1");
    expect(text).toContain("券商:ibkr 已连接");
    expect(text).toContain("自动执行 开 · 实盘 关");
    expect(text).not.toContain("启动引擎");
  });

  it("默认文件名带时间", () => {
    expect(diag.defaultFileName(new Date(2026, 8, 28, 9, 5, 7).getTime())).toBe("IBKR-Assistant-诊断-20260928-090507.txt");
  });
});

describe("主进程的接线", () => {
  const main = readFileSync(path.join(DESKTOP, "main.js"), "utf-8");

  it("日志落盘之前过脱敏(electron-log 的 hook)", () => {
    expect(main).toMatch(/log\.hooks\.push\(/);
    expect(main).toMatch(/redact\(item\)/);
  });

  it("交给界面的引擎日志也脱敏", () => {
    expect(main).toMatch(/send\('engine-log', \{ line: redact\(line\) \}\)/);
  });
});
