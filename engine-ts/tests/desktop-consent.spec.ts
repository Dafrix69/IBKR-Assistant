/** 条款同意(desktop/consent.js)、条款文本(docs/legal)与界面上显示它们的小解析器(lib/docParse.ts)。
 *
 * 钉的是:
 *  · 同意的是"某一版"条款——版本对不上的同意不作数;同意记录只增不改;
 *  · 没同意之前钱路径不放行,只解析不发单的不挡;
 *  · 三份文本开头的版本号一致,且就是主进程认的现行版本(改条款忘了改版本号 = 老用户不会被要求重新确认);
 *  · 主进程真的在放行之前查了它。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..");
const DESKTOP = path.join(ROOT, "desktop");
const require = createRequire(import.meta.url);

interface ConsentState { version: string; accepted: boolean; acceptedAt: string | null }
interface Consent {
  TERMS_VERSION: string;
  CONSENT_REQUIRED_RPC: Set<string>;
  consentPath(dir: string): string;
  consentState(dir: string): ConsentState;
  acceptConsent(dir: string, version: string, opts?: { appVersion?: string; now?: number }): ConsentState;
  blockedWithoutConsent(method: string, params: unknown): string | null;
}
const consent = require(path.join(DESKTOP, "consent.js")) as Consent;

type Block = { kind: string; level?: number; inline?: { text: string; bold: boolean }[]; items?: unknown[]; head?: unknown[]; rows?: unknown[][] };
const parser = (await import(
  /* @vite-ignore */ pathToFileURL(path.join(DESKTOP, "renderer-react", "src", "lib", "docParse.ts")).href
)) as unknown as { parseDoc(text: string): Block[]; parseInline(text: string): { text: string; bold: boolean }[] };

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "dafri-consent-"));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 上文件可能还被占着(SQLite、刚退出的子进程):临时目录留给系统清 */
  }
});

describe("同意记录", () => {
  it("没同意过:accepted 是 false", () => {
    expect(consent.consentState(dir)).toEqual({ version: consent.TERMS_VERSION, accepted: false, acceptedAt: null });
  });

  it("同意现行版本:记下时刻与应用版本,之后读得回来", () => {
    const now = Date.parse("2026-09-28T02:00:00Z");
    const state = consent.acceptConsent(dir, consent.TERMS_VERSION, { appVersion: "0.6.0", now });
    expect(state).toEqual({ version: consent.TERMS_VERSION, accepted: true, acceptedAt: "2026-09-28T02:00:00.000Z" });
    expect(consent.consentState(dir).accepted).toBe(true);
    const file = JSON.parse(readFileSync(consent.consentPath(dir), "utf-8"));
    expect(file.accepted).toEqual([{ version: consent.TERMS_VERSION, at: "2026-09-28T02:00:00.000Z", app_version: "0.6.0" }]);
  });

  it("版本对不上(界面上摆的是旧文本):不作数,也不落盘", () => {
    expect(() => consent.acceptConsent(dir, "2025-01-01")).toThrow(/条款版本对不上/);
    expect(() => consent.acceptConsent(dir, "")).toThrow(/条款版本对不上/);
    expect(consent.consentState(dir).accepted).toBe(false);
  });

  it("只同意过旧版:现行版本仍算没同意;记录只增不改", () => {
    writeFileSync(consent.consentPath(dir), JSON.stringify({ accepted: [{ version: "2025-01-01", at: "2025-01-02T00:00:00.000Z", app_version: "0.4.0" }] }));
    expect(consent.consentState(dir).accepted).toBe(false);
    consent.acceptConsent(dir, consent.TERMS_VERSION, { appVersion: "0.6.0" });
    const file = JSON.parse(readFileSync(consent.consentPath(dir), "utf-8"));
    expect(file.accepted.map((e: { version: string }) => e.version)).toEqual(["2025-01-01", consent.TERMS_VERSION]);
  });

  it("记录文件坏了:按没同意过处理", () => {
    writeFileSync(consent.consentPath(dir), "{ 坏的");
    expect(consent.consentState(dir).accepted).toBe(false);
    consent.acceptConsent(dir, consent.TERMS_VERSION);
    expect(consent.consentState(dir).accepted).toBe(true);
  });
});

describe("没同意之前挡什么", () => {
  it("发单与授权发单:挡", () => {
    expect(consent.blockedWithoutConsent("instruction.submit", { text: "买 AAPL", execute: true })).toMatch(/还没有同意/);
    expect(consent.blockedWithoutConsent("tracker.add", { key: "k" })).toMatch(/还没有同意/);
    expect(consent.blockedWithoutConsent("tracker.update", { id: "t" })).toMatch(/还没有同意/);
    expect(consent.blockedWithoutConsent("tracker.close_now", { id: "t" })).toMatch(/还没有同意/);
  });

  it("只解析不发单:不挡", () => {
    expect(consent.blockedWithoutConsent("instruction.submit", { text: "买 AAPL", execute: false })).toBeNull();
    expect(consent.blockedWithoutConsent("instruction.submit", { text: "买 AAPL" })).toBeNull();
  });

  it("打开闸门:挡;关闸门、改别的设置:不挡", () => {
    expect(consent.blockedWithoutConsent("settings.patch", { patch: { policies: { auto_execute: true } } })).toMatch(/不能打开自动执行或实盘下单/);
    expect(consent.blockedWithoutConsent("settings.patch", { patch: { policies: { allow_live_trading: true } } })).toMatch(/还没有同意/);
    expect(consent.blockedWithoutConsent("settings.patch", { patch: { policies: { auto_execute: false, allow_live_trading: false } } })).toBeNull();
    expect(consent.blockedWithoutConsent("settings.patch", { patch: { limits: { max_order_notional: 100 } } })).toBeNull();
    expect(consent.blockedWithoutConsent("settings.patch", {})).toBeNull();
  });

  it("只读的、熔断、连券商:不挡(熔断尤其不能挡)", () => {
    for (const m of ["system.status", "breaker.halt", "breaker.resume", "broker.connect", "tracker.delete", "records.list"]) {
      expect(consent.blockedWithoutConsent(m, {}), m).toBeNull();
    }
  });
});

describe("条款文本", () => {
  const docs = ["risk-disclosure.md", "terms.md", "privacy.md"].map((name) => ({
    name,
    text: readFileSync(path.join(ROOT, "docs", "legal", name), "utf-8"),
  }));

  it("三份开头的版本号一致,且就是主进程认的现行版本", () => {
    for (const d of docs) {
      const line = d.text.split(/\r?\n/)[2];
      expect(line, d.name).toBe(`版本:${consent.TERMS_VERSION}`);
    }
  });

  it("界面读版本号的那条正则读得出来(lib/legalText.ts)", () => {
    const src = readFileSync(path.join(DESKTOP, "renderer-react", "src", "lib", "legalText.ts"), "utf-8");
    expect(src).toContain("/^版本[::]\\s*(\\d{4}-\\d{2}-\\d{2})\\s*$/m");
    for (const d of docs) expect(/^版本[::]\s*(\d{4}-\d{2}-\d{2})\s*$/m.exec(d.text)?.[1], d.name).toBe(consent.TERMS_VERSION);
  });

  it("只用了解析器认得的写法:没有链接、图片、代码块、编号列表、引用", () => {
    for (const d of docs) {
      expect(d.text, d.name).not.toMatch(/\]\(|!\[|```|^\s*\d+\.\s|^>/m);
      const blocks = parser.parseDoc(d.text);
      expect(blocks[0], d.name).toMatchObject({ kind: "heading", level: 1 });
      expect(blocks.filter((b) => b.kind === "heading").length, d.name).toBeGreaterThan(3);
      // 解析完不该还留着 Markdown 的记号
      const flat = JSON.stringify(blocks);
      expect(flat, d.name).not.toMatch(/\*\*|^#|\|\s*---/);
    }
  });

  it("隐私说明里列的外发对象和代码里真的会连的地方对得上", () => {
    const privacy = docs[2]!.text;
    const engine = (f: string): string => readFileSync(path.join(ROOT, "engine-ts", "src", f), "utf-8");
    expect(engine("macro.ts")).toMatch(/finance\.yahoo\.com/);
    expect(engine("macro.ts")).toMatch(/cdn\.cboe\.com/);
    expect(privacy).toMatch(/Yahoo Finance/);
    expect(privacy).toMatch(/Cboe/);
    expect(privacy).toMatch(/GitHub/);
    expect(privacy).toMatch(/大模型服务商/);
    // 引擎里出现的外部域名只有这几个;多了一个,隐私说明就得跟着改
    const hosts = new Set<string>();
    for (const f of ["macro.ts", "providers.ts", "embeddings.ts", "market.ts", "optionwall.ts", "llm.ts"]) {
      for (const m of engine(f).matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) hosts.add(String(m[1]).toLowerCase());
    }
    const known = ["cdn.cboe.com", "query1.finance.yahoo.com", "api.deepseek.com", "platform.claude.com", "127.0.0.1", "localhost", "api.example.com"];
    expect([...hosts].filter((h) => !known.includes(h))).toEqual([]);
  });
});

describe("小解析器", () => {
  it("标题、段落、列表、表格、加粗", () => {
    const blocks = parser.parseDoc("# 标题\n\n第一段,\n接着写。\n\n- 甲\n- **乙**丙\n\n| 发给谁 | 发什么 |\n|---|---|\n| GitHub | 版本查询 |\n\n## 小节\n末段");
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "list", "table", "heading", "paragraph"]);
    expect(blocks[1]!.inline).toEqual([{ text: "第一段,接着写。", bold: false }]);
    expect(blocks[2]!.items).toEqual([[{ text: "甲", bold: false }], [{ text: "乙", bold: true }, { text: "丙", bold: false }]]);
    expect(blocks[3]!.head).toEqual([[{ text: "发给谁", bold: false }], [{ text: "发什么", bold: false }]]);
    expect(blocks[3]!.rows).toHaveLength(1);
    expect(blocks[4]).toMatchObject({ kind: "heading", level: 2 });
  });

  it("尖括号、脚本标签只是文字(渲染时由 React 转义)", () => {
    const blocks = parser.parseDoc("<script>alert(1)</script>");
    expect(blocks).toEqual([{ kind: "paragraph", inline: [{ text: "<script>alert(1)</script>", bold: false }] }]);
  });
});

describe("主进程的接线", () => {
  const main = readFileSync(path.join(DESKTOP, "main.js"), "utf-8");
  const handler = main.slice(main.indexOf("ipcMain.handle('rpc'"));

  it("放行之前先查条款:在转给引擎之前", () => {
    const check = handler.indexOf("consent.blockedWithoutConsent(method, clean)");
    const forward = handler.indexOf("engine.call(method, clean");
    expect(check).toBeGreaterThan(-1);
    expect(forward).toBeGreaterThan(check);
  });

  it("界面里没有 dangerouslySetInnerHTML(条款文本也一样只当文本渲染)", () => {
    const src = path.join(DESKTOP, "renderer-react", "src");
    for (const f of ["lib/PlainDoc.tsx", "shell/ConsentGate.tsx", "lib/SupportPanel.tsx", "lib/DataPanel.tsx", "ui/ErrorBoundary.tsx"]) {
      expect(readFileSync(path.join(src, f), "utf-8"), f).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
    }
  });
});
