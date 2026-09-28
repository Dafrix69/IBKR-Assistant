/** 主进程整条路走一遍(desktop/main.js + support-ipc.js),Electron 是假的,交易引擎是真的。
 *
 * 主进程里的判断都拆进了能单测的纯模块,但**接线**没有:通道登记了没有、放行之前各道检查的先后、
 * 对话框点了之后做什么、引擎用退出码说"别重启我"时主进程听没听见——这些只有把 main.js 真的跑起来才验得到,
 * 而 Electron 在测试环境里起不来。这里换一个假的 `electron`(记下登记了哪些通道、对话框按脚本回答),
 * 引擎子进程用编译出来的那一份,配置与库都在临时目录里。
 *
 * 全部离线:配置里 `broker.auto_connect` 关着,不连任何券商;走到引擎的调用都挑了不会碰网络与钥匙串的。
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..");
const DESKTOP = path.join(ROOT, "desktop");
const require = createRequire(import.meta.url);
type Rec = Record<string, any>;
type Handler = (event: Rec, ...args: any[]) => unknown;

const dir = mkdtempSync(path.join(os.tmpdir(), "dafri-main-"));
const configPath = path.join(dir, "settings.json");
const dbPath = path.join(dir, "data", "trades.db");
const userData = path.join(dir, "userData");

// ---- 假的 electron ----------------------------------------------------------
const handlers = new Map<string, Handler>();
const appEvents = new Map<string, Array<(...a: any[]) => void>>();
const boxes: Rec[] = [];
const answers: number[] = [];
const sent: Array<{ channel: string; payload: Rec }> = [];
const errorBoxes: string[] = [];
const revealed: string[] = [];
let savePath: string | null = null;
let quits = 0;
let clipboardText = "";

const webContents = {
  on: () => undefined,
  send: (channel: string, payload: Rec) => { sent.push({ channel, payload }); },
  getURL: () => "file:///x/desktop/renderer-react/dist/index.html",
  isDestroyed: () => false,
  setWindowOpenHandler: () => undefined,
  reload: () => undefined,
};
class FakeWindow {
  webContents = webContents;
  on(): void { /* 窗口事件:这里用不到 */ }
  once(): void { /* 同上 */ }
  loadFile(): void { /* 不加载界面 */ }
  isDestroyed(): boolean { return false; }
  isVisible(): boolean { return true; }
  isMinimized(): boolean { return false; }
  isFocused(): boolean { return true; }
  isFullScreen(): boolean { return false; }
  isMaximized(): boolean { return false; }
  getNormalBounds(): Rec { return { x: 0, y: 0, width: 1360, height: 900 }; }
  show(): void { /* noop */ }
  focus(): void { /* noop */ }
  flashFrame(): void { /* noop */ }
  maximize(): void { /* noop */ }
}
const showMessageBox = async (...args: any[]): Promise<{ response: number }> => {
  const options = (args.length > 1 ? args[1] : args[0]) as Rec;
  boxes.push(options);
  return { response: answers.length ? answers.shift()! : Number(options["cancelId"] ?? 0) };
};
const fakeElectron = {
  app: {
    isPackaged: false,
    name: "IBKR-Assistant",
    getPath: (what: string) => (what === "userData" ? userData : path.join(dir, what)),
    setPath: () => undefined,
    getVersion: () => "9.9.9-test",
    getName: () => "IBKR-Assistant",
    getLocale: () => "zh-CN",
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    on: (name: string, fn: (...a: any[]) => void) => { appEvents.set(name, [...(appEvents.get(name) ?? []), fn]); },
    quit: () => { quits += 1; },
    dock: undefined,
  },
  BrowserWindow: FakeWindow,
  Menu: { buildFromTemplate: (t: unknown) => t, setApplicationMenu: () => undefined },
  Notification: Object.assign(class { show(): void { /* noop */ } }, { isSupported: () => false }),
  ipcMain: {
    handle: (channel: string, fn: Handler) => { handlers.set(channel, fn); },
    on: () => undefined,
  },
  dialog: {
    showMessageBox,
    showSaveDialog: async () => ({ canceled: savePath === null, filePath: savePath ?? undefined }),
    showErrorBox: (title: string, body: string) => { errorBoxes.push(`${title}:${body}`); },
  },
  shell: {
    openExternal: () => undefined,
    showItemInFolder: (p: string) => { revealed.push(p); },
    openPath: async (p: string) => { revealed.push(p); return ""; },
  },
  session: { defaultSession: { webRequest: { onHeadersReceived: () => undefined }, setPermissionRequestHandler: () => undefined } },
  nativeTheme: { on: () => undefined, shouldUseDarkColors: false, themeSource: "system" },
  powerSaveBlocker: { start: () => 1 },
  screen: { getAllDisplays: () => [] },
  net: { fetch: async () => { throw new Error("测试里不联网"); } },
  clipboard: { writeText: (t: string) => { clipboardText = t; }, writeImage: () => undefined },
  nativeImage: { createFromDataURL: () => ({ isEmpty: () => true }) },
};
const logged: string[] = [];
const hooks: Array<(m: Rec) => Rec> = [];
const write = (...data: unknown[]): void => {
  let message: Rec = { data };
  for (const hook of hooks) message = hook(message);
  logged.push((message["data"] as unknown[]).map(String).join(" "));
};
const fakeLog = {
  initialize: () => undefined,
  transports: { file: { level: "info", maxSize: 0, getFile: () => ({ path: path.join(userData, "logs", "main.log") }) }, console: { level: false } },
  errorHandler: { startCatching: () => undefined },
  functions: {},
  hooks,
  info: write, warn: write, error: write, debug: write,
};

// ---- 调通道 -----------------------------------------------------------------
const event = { sender: webContents, senderFrame: { parent: null } };
const invoke = async (channel: string, ...args: any[]): Promise<any> => {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`主进程没有登记通道:${channel}`); // 通道是 whenReady 之后才登记的:刚启动时等一等
  return fn(event, ...args);
};
const rpc = (method: string, params: Rec = {}): Promise<any> => invoke("rpc", { method, params: { ...params } });
const failure = async (p: Promise<unknown>): Promise<string> => p.then(() => { throw new Error("本该被拒"); }, (e: Error) => e.message);
const until = async (cond: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> => {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 50));
  }
};
const engineUp = async (): Promise<boolean> => rpc("system.status").then(() => true, () => false);

let restoreLoad: (() => void) | null = null;
const ready = existsSync(path.join(ROOT, "engine-ts", "node_modules", "typescript"));

beforeAll(async () => {
  // 引擎子进程跑的是编译出来的那一份:不在、或者比源码旧,就先编一遍(桌面端 npm start 之前做的同一件事)
  const built = spawnSync(process.execPath, [path.join(DESKTOP, "tools", "ensure_engine_ts.js")], { encoding: "utf-8" });
  if (built.status !== 0) throw new Error(`引擎没有编译成功:${built.stderr || built.stdout}`);

  const example = JSON.parse(readFileSync(path.join(ROOT, "config", "settings.example.json"), "utf-8")) as Rec;
  example["broker"]["auto_connect"] = false; // 测试绝不连券商
  example["storage"] = { db_path: dbPath };
  example["accounts"][0]["account_id"] = "DU7654321";
  example["accounts"][1]["account_id"] = "U1234567";
  writeFileSync(configPath, JSON.stringify(example, null, 2));
  process.env["DAFRI_CONFIG"] = configPath;
  delete process.env["DAFRI_DEV"];

  const Module = require("node:module") as { _load: (request: string, ...rest: unknown[]) => unknown };
  const original = Module._load;
  Module._load = function load(request: string, ...rest: unknown[]): unknown {
    if (request === "electron") return fakeElectron;
    if (request === "electron-log/main") return fakeLog;
    return original.call(this, request, ...rest);
  };
  restoreLoad = () => { Module._load = original; };
  require(path.join(DESKTOP, "main.js"));
  await until(engineUp);
}, 120_000);

afterAll(async () => {
  // 和真的退出走同一条路:before-quit 里等引擎停稳
  let prevented = false;
  for (const fn of appEvents.get("before-quit") ?? []) fn({ preventDefault: () => { prevented = true; } });
  if (prevented) await until(() => quits > 0, 12_000).catch(() => undefined);
  restoreLoad?.();
  delete process.env["DAFRI_CONFIG"];
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 上文件可能还被占着(SQLite、刚退出的子进程):临时目录留给系统清 */
  }
}, 30_000);

describe.runIf(ready)("主进程:接线", () => {
  it("新加的通道都登记了", () => {
    for (const channel of [
      "rpc", "confirm", "diagnostics-export", "diagnostics-copy", "reveal", "consent-get", "consent-accept",
      "backup-restore", "accounts-info", "accounts-change", "quit-app",
    ]) expect(handlers.has(channel), channel).toBe(true);
  });

  it("不是主窗口发来的调用一律拒", async () => {
    const stranger = { sender: { getURL: () => "file:///x/renderer-react/dist/index.html" }, senderFrame: { parent: null } };
    for (const channel of ["rpc", "confirm", "diagnostics-export", "consent-accept", "accounts-change", "backup-restore", "quit-app"]) {
      const fn = handlers.get(channel)!;
      await expect(Promise.resolve().then(() => fn(stranger, { method: "system.status", params: {} })), channel).rejects.toThrow(/不受信任/);
    }
    // 子 frame 也不行
    await expect(Promise.resolve().then(() => handlers.get("rpc")!({ ...event, senderFrame: { parent: {} } }, { method: "system.status", params: {} }))).rejects.toThrow(/不受信任/);
  });

  it("引擎起来了,用的是临时目录里的配置与库", async () => {
    const status = await rpc("system.status");
    expect(status.broker_connected).toBe(false);
    expect(status.auto_execute).toBe(false);
    const backups = await rpc("data.backups");
    expect(backups.db_path).toBe(dbPath);
    expect(backups.schema_version).toBe(1);
  });
});

describe.runIf(ready)("主进程:钱路径上的三道(条款 → 确认凭据 → 引擎)", () => {
  const ORDER = { text: "买入 AAPL 100 股 limit 230", execute: true, accounts: ["没有这个账户"], __confirmed: true };

  it("没同意条款:发单、建追踪、平仓、开闸门都不放行;只解析、关闸门、熔断不挡", async () => {
    expect((await invoke("consent-get")).accepted).toBe(false);
    expect(await failure(rpc("instruction.submit", ORDER))).toMatch(/还没有同意《风险揭示与使用条款》/);
    expect(await failure(rpc("tracker.close_now", { id: "t", __confirmed: true }))).toMatch(/还没有同意/);
    expect(await failure(rpc("tracker.add", { key: "k", auto_close: true, __confirmed: true }))).toMatch(/还没有同意/);
    expect(await failure(rpc("settings.patch", { patch: { policies: { auto_execute: true } }, __confirmed: true }))).toMatch(/还没有同意/);
    // 关闸门照常(引擎回的是改完之后的设置)
    expect((await rpc("settings.patch", { patch: { policies: { auto_execute: false } }, __confirmed: true })).policies.auto_execute).toBe(false);
    expect((await rpc("breaker.state")).engaged).toBe(false);
  });

  it("同意的版本对不上不作数;对得上才记下", async () => {
    expect(await failure(invoke("consent-accept", "2020-01-01"))).toMatch(/条款版本对不上/);
    const { TERMS_VERSION } = require(path.join(DESKTOP, "consent.js")) as { TERMS_VERSION: string };
    expect((await invoke("consent-accept", TERMS_VERSION)).accepted).toBe(true);
    expect(JSON.parse(readFileSync(path.join(userData, "consent.json"), "utf-8")).accepted[0]).toMatchObject({ version: TERMS_VERSION, app_version: "9.9.9-test" });
  });

  it("同意了条款、但没有在确认框里点过确认:不放行", async () => {
    expect(await failure(rpc("instruction.submit", ORDER))).toContain("要先在确认框里点确认(发送真实订单)");
    expect(await failure(rpc("tracker.close_now", { id: "t", __confirmed: true }))).toContain("确认框里点确认(立即平仓)");
    // 缺 __confirmed 的照旧在最前面被拒
    expect(await failure(rpc("instruction.submit", { ...ORDER, __confirmed: undefined }))).toMatch(/缺少界面确认标记/);
  });

  it("确认框:第一行是主进程写的,指令与账户类别也是;点了取消不发凭据", async () => {
    boxes.length = 0;
    answers.push(0);
    const no = await invoke("confirm", { purpose: "instruction.submit", binding: { text: ORDER.text, accounts: ["模拟", "主账户"] }, title: "随便写的标题", message: "界面写的话", confirmLabel: "我确认,发送" });
    expect(no).toBe(false);
    const box = boxes[0]!;
    expect(box["message"]).toBe("发送真实订单(含实盘账户)");
    expect(box["title"]).toBe("发送真实订单");
    expect(box["detail"]).toContain(`指令:${ORDER.text}`);
    expect(box["detail"]).toContain("账户:模拟(纸面)、主账户(实盘)");
    expect(box["detail"]).toContain("每笔订单各发 2 份");
    expect(box["defaultId"]).toBe(0);
    expect(box["buttons"]).toEqual(["取消", "我确认,发送"]);
    expect(await failure(rpc("instruction.submit", { ...ORDER, accounts: ["模拟", "主账户"] }))).toMatch(/确认框里点确认/);
  });

  it("点了确认:这一次放行到引擎;同一张凭据不能用第二次;内容变了不放行", async () => {
    answers.push(1);
    expect(await invoke("confirm", { purpose: "instruction.submit", binding: { text: ORDER.text, accounts: ORDER.accounts }, title: "", message: "" })).toBe(true);
    // 改了一个字:不放行,凭据还在
    expect(await failure(rpc("instruction.submit", { ...ORDER, text: "买入 AAPL 900 股 limit 230" }))).toMatch(/确认框里点确认/);
    // 原样:过了主进程的三道,到了引擎——引擎自己的第一道闸说话了(自动执行没开)。这句话是引擎的,不是主进程的
    const fromEngine = await failure(rpc("instruction.submit", ORDER));
    expect(fromEngine).not.toMatch(/确认框|条款|确认标记/);
    expect(fromEngine).toMatch(/自动执行没有打开/);
    // 第二次:凭据已经用掉了
    expect(await failure(rpc("instruction.submit", ORDER))).toMatch(/确认框里点确认/);
  });

  it("未知的确认用途发不出凭据", async () => {
    expect(await failure(invoke("confirm", { purpose: "anything", binding: {}, title: "", message: "" }))).toMatch(/未知的确认用途/);
  });

  it("开闸门:要确认,确认框上的话全由主进程写;确认之后才改得了", async () => {
    const patch = { patch: { policies: { auto_execute: true } }, __confirmed: true };
    expect(await failure(rpc("settings.patch", patch))).toContain("确认框里点确认(打开自动执行)");
    boxes.length = 0;
    answers.push(1);
    await invoke("confirm", { purpose: "gate.auto_execute", title: "界面给的", message: "界面给的", detail: "界面给的" });
    expect(boxes[0]!["message"]).toBe("打开自动执行");
    expect(boxes[0]!["detail"]).toMatch(/没有人工确认环节/);
    expect(JSON.stringify(boxes[0])).not.toContain("界面给的");
    expect((await rpc("settings.patch", patch)).policies.auto_execute).toBe(true);
    // 已经开着:再带着 true 保存不用再确认
    expect((await rpc("settings.patch", patch)).policies.auto_execute).toBe(true);
    // 关:不用确认,当场生效
    expect((await rpc("settings.patch", { patch: { policies: { auto_execute: false } }, __confirmed: true })).policies.auto_execute).toBe(false);
  });

  it("放宽限额:确认框上从多少到多少由主进程对着引擎现在的设置算;收紧不用确认", async () => {
    const looser = { patch: { limits: { max_order_notional: 50000, max_option_contracts: 5 } }, __confirmed: true };
    expect(await failure(rpc("settings.patch", looser))).toContain("确认框里点确认(放宽风控限额)");
    boxes.length = 0;
    answers.push(1);
    expect(await invoke("confirm", { purpose: "limits.loosen", binding: { limits: looser.patch.limits }, title: "", message: "" })).toBe(true);
    expect(boxes[0]!["detail"]).toContain("单笔名义金额上限(USD):5,000 → 50,000");
    expect(boxes[0]!["detail"]).not.toContain("期权 / 价差单笔上限"); // 没变的不列
    expect((await rpc("settings.patch", looser)).limits.max_order_notional).toBe(50000);
    // 收紧:直接改
    boxes.length = 0;
    expect((await rpc("settings.patch", { patch: { limits: { max_order_notional: 3000 } }, __confirmed: true })).limits.max_order_notional).toBe(3000);
    // 没有放宽任何一项时去确认:不弹框,直接回 true
    expect(await invoke("confirm", { purpose: "limits.loosen", binding: { limits: { max_order_notional: 2000 } }, title: "", message: "" })).toBe(true);
    expect(boxes).toHaveLength(0);
  });

  it("配置是原子写的,改之前那一份在 .bak 里", () => {
    expect(JSON.parse(readFileSync(configPath, "utf-8")).limits.max_order_notional).toBe(3000);
    expect(JSON.parse(readFileSync(`${configPath}.bak`, "utf-8")).limits.max_order_notional).toBe(50000);
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });
});

describe.runIf(ready)("主进程:支持与数据", () => {
  it("诊断信息:存到对话框选的地方;里面没有真实账号,有版本与引擎状态", async () => {
    savePath = path.join(dir, "diag.txt");
    const done = await invoke("diagnostics-export");
    expect(done).toEqual({ ok: true, path: savePath });
    const text = readFileSync(savePath, "utf-8");
    expect(text).toContain("9.9.9-test");
    expect(text).toContain("引擎状态(system.status)");
    expect(text).toContain("交易库与备份(data.backups)");
    expect(text).not.toContain("U1234567");
    expect(text).not.toContain("DU7654321");
    expect(text).toContain("DU***321");
    expect(revealed).toContain(savePath);
    // 取消保存对话框:什么都不写
    savePath = null;
    expect(await invoke("diagnostics-export")).toEqual({ ok: false, canceled: true });
    await invoke("diagnostics-copy");
    expect(clipboardText).toContain("IBKR-Assistant 9.9.9-test");
  });

  it("打开所在位置:只认那几个固定的地方", async () => {
    revealed.length = 0;
    await invoke("reveal", "config");
    await invoke("reveal", "logs");
    await invoke("reveal", "backups");
    expect(revealed).toEqual([configPath, path.join(userData, "logs", "main.log"), path.join(path.dirname(dbPath), "backups")]);
    expect(await failure(invoke("reveal", "/etc/passwd"))).toMatch(/未知的位置/);
    expect(await failure(invoke("reveal", "../../"))).toMatch(/未知的位置/);
  });

  it("落盘的日志过了脱敏", () => {
    logged.length = 0;
    fakeLog.error("[engine] IB error 201 for U1234567 key sk-ant-abcdefgh12345678");
    fakeLog.warn(new Error("bad account DU7654321"));
    fakeLog.info({ account: "U1234567" });
    const text = logged.join("\n");
    expect(text).not.toMatch(/U1234567|DU7654321|sk-ant-abcdefgh/);
    expect(text).toContain("U***567");
  });

  it("从界面改账户:先校验(实盘账号标成纸面存不进去),再弹确认框,点了保存才写盘,然后重启引擎", async () => {
    const before = readFileSync(configPath, "utf-8");
    expect(await failure(invoke("accounts-change", { action: "upsert", alias: "模拟", account_id: "U9998887", is_paper: true, connection: "paper" }))).toMatch(/不能标成纸面/);
    boxes.length = 0;
    const change = { action: "upsert", alias: "第二个模拟", account_id: "DU2223334", is_paper: true, connection: "paper" };
    expect(await invoke("accounts-change", change)).toEqual({ ok: false, canceled: true }); // 默认答的是「取消」
    expect(readFileSync(configPath, "utf-8")).toBe(before);
    expect(boxes[0]!["detail"]).toContain("账号:DU2223334");
    expect(boxes[0]!["detail"]).toContain("类别:纸面账户");

    answers.push(1);
    expect(await invoke("accounts-change", change)).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(configPath, "utf-8")).accounts.map((a: Rec) => a.alias)).toContain("第二个模拟");
    // 引擎重启之后读到的是新配置;界面拿到的账号是打了码的
    await until(async () => (await rpc("system.status").catch(() => ({ accounts: [] }))).accounts.some((a: Rec) => a.alias === "第二个模拟"));
    const account = (await rpc("system.status")).accounts.find((a: Rec) => a.alias === "第二个模拟");
    expect(account).toMatchObject({ account_masked: "DU***334", is_paper: true });
    expect((await invoke("accounts-info")).placeholders).toEqual(["富途模拟"]);
  });

  it("备份与恢复:恢复要在对话框里点过;恢复之后引擎重启,库回到备份那一刻", async () => {
    const made = (await rpc("data.backup")).backup;
    expect(made.reason).toBe("manual");
    await rpc("ideas.add", { text: "备份之后写的想法" });
    expect((await rpc("ideas.list", {})).ideas).toHaveLength(1);

    expect(await failure(invoke("backup-restore", "../../etc/passwd"))).toMatch(/找不到这份备份/);
    expect(await invoke("backup-restore", made.name)).toEqual({ ok: false, canceled: true });
    expect((await rpc("ideas.list", {})).ideas).toHaveLength(1);

    boxes.length = 0;
    answers.push(1);
    expect(await invoke("backup-restore", made.name)).toMatchObject({ ok: true, restored: made.name });
    expect(boxes[0]!["message"]).toBe("用这份备份换掉现在的交易库?");
    await until(engineUp);
    expect((await rpc("ideas.list", {})).ideas).toHaveLength(0);
    // 原来的库留在旁边;恢复之前还自动多留了一份备份
    expect(readdirSync(path.dirname(dbPath)).some((f) => f.startsWith("trades.db.before-restore-"))).toBe(true);
    expect((await rpc("data.backups")).backups.length).toBeGreaterThanOrEqual(2);
  });
});

describe.runIf(ready)("主进程:引擎说「别重启我」", () => {
  it("配置坏了:不自动重启,弹对话框;点「恢复上一份可用的配置」之后引擎起得来,闸门是关的", async () => {
    // 先让 .bak 里是一份闸门开着的配置
    answers.push(1);
    await invoke("confirm", { purpose: "gate.auto_execute", title: "", message: "" });
    await rpc("settings.patch", { patch: { policies: { auto_execute: true } }, __confirmed: true });
    await rpc("settings.patch", { patch: { limits: { max_order_notional: 2500 } }, __confirmed: true }); // .bak = 闸门开着的那一份
    expect(JSON.parse(readFileSync(`${configPath}.bak`, "utf-8")).policies.auto_execute).toBe(true);

    writeFileSync(configPath, "{ \"accounts\": [ 手改到一半");
    boxes.length = 0;
    sent.length = 0;
    answers.push(0); // 对话框第一个按钮:恢复上一份可用的配置
    await invoke("engine-restart");
    await until(() => boxes.length > 0);
    const box = boxes[0]!;
    expect(box["message"]).toBe("配置文件的格式坏了,交易引擎没有启动");
    expect(box["buttons"]).toEqual(["恢复上一份可用的配置", "打开配置文件所在位置", "我改好了,重试", "退出"]);
    expect(box["detail"]).toContain("不是合法的 JSON");
    // 界面收到的是"配置的问题",不是"引擎崩了,正在自动重启"
    expect(sent.find((m) => m.channel === "engine-exit")?.payload).toMatchObject({ fatal: "config", code: 78 });

    await until(engineUp);
    const settings = await rpc("settings.get");
    expect(settings.policies.auto_execute).toBe(false); // 备份里是开着的,恢复出来是关的
    expect(settings.policies.allow_live_trading).toBe(false);
    expect(settings.limits.max_order_notional).toBe(3000);
    expect(readdirSync(dir).some((f) => f.startsWith("settings.json.broken-"))).toBe(true);
  }, 40_000);

  it("交易库坏了:不自动重启,弹对话框;点「用最近的备份恢复」之后引擎起得来", async () => {
    await rpc("data.backup");
    boxes.length = 0;
    sent.length = 0;
    answers.push(0); // 用最近的备份恢复
    // 先把库写坏,再重启引擎:启动时那一遍探测会发现它。
    // **原地覆盖,不删不换**:引擎还开着这个文件,Windows 上别的进程开着的文件删不掉(EPERM),写是可以的
    // (SQLite 开库时允许别人读写)。从头盖到尾,引擎收尾时从 WAL 写回来的那几页救不了它。
    await invoke("engine-restart").catch(() => undefined);
    await until(engineUp);
    const size = Math.max(statSync(dbPath).size, 4096);
    const fd = openSync(dbPath, "r+");
    writeSync(fd, Buffer.alloc(size, "这不是数据库"), 0, size, 0);
    closeSync(fd);
    await invoke("engine-restart");
    await until(() => boxes.length > 0);
    expect(boxes[0]!["message"]).toBe("交易库文件损坏了,交易引擎没有启动");
    expect(boxes[0]!["buttons"][0]).toBe("用最近的备份恢复");
    expect(sent.find((m) => m.channel === "engine-exit")?.payload).toMatchObject({ fatal: "store", code: 74 });
    await until(engineUp);
    expect((await rpc("data.backups")).db_path).toBe(dbPath);
    expect(readdirSync(path.dirname(dbPath)).some((f) => f.startsWith("trades.db.corrupt-"))).toBe(true);
  }, 40_000);
});
