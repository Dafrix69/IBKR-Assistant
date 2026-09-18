/** 桌面端的提醒弹窗(desktop/popup-window.js + popup/ 页面)。
 *
 * 弹窗的内容来自行情与用户填的标的,主进程要逐字段清洗;弹窗页发回的动作能把主窗口叫到前台、跳页,
 * 来源必须核对;弹窗绝不能抢焦点(用户很可能正在 TWS 里敲数量)。这些都不是编译期能保证的东西,
 * 真应用里出了错也不会报错——所以放在引擎的测试里,每次跑测试都对一遍。
 *
 * popup-window.js 是主进程的 CommonJS 模块,electron 只在用到时才取:这里用假的 BrowserWindow / screen
 * 注进去,在纯 Node 里把窗口的行为跑一遍。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const DESKTOP = path.resolve(__dirname, "..", "..", "desktop");
const require = createRequire(import.meta.url);

interface PopupItem {
  id: string;
  kind: string;
  symbol: string;
  title: string;
  body: string;
  tone: string;
  at: number;
  page: string | null;
}
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Manager {
  items: PopupItem[];
  updown: string;
  win: FakeWindow | null;
  ready: boolean;
  push(payload: unknown): { shown: number; dropped: number };
  dismiss(id: unknown): boolean;
  clear(): void;
  open(id: unknown): boolean;
  handleAction(msg: unknown): void;
  isPopupSender(event: unknown): boolean;
  syncTheme(): void;
  destroy(): void;
}
interface PopupModule {
  sanitizePopupPayload(payload: unknown): { items: PopupItem[]; updown: string; dropped: number };
  popupBounds(workArea: Rect, contentHeight: number): Rect;
  PopupManager: new (opts?: Record<string, unknown>) => Manager;
  POPUP_LIMITS: {
    width: number;
    margin: number;
    minHeight: number;
    maxHeightRatio: number;
    maxIncoming: number;
    maxItems: number;
    revealFallbackMs: number;
    pageReadyTimeoutMs: number;
    notifyFallbackMax: number;
  };
}

const mod = require(path.join(DESKTOP, "popup-window.js")) as PopupModule;
const { sanitizePopupPayload, popupBounds, PopupManager, POPUP_LIMITS } = mod;

const ch = (code: number) => String.fromCharCode(code);
const NUL = ch(0);
const LF = ch(10);
const TAB = ch(9);
const BEL = ch(7);
const DEL = ch(0x7f);
const ZWSP = ch(0x200b);
const RLO = ch(0x202e);
const BOM = ch(0xfeff);

// ---------------------------------------------------------------- 假 electron

type Handler = (...args: any[]) => unknown;

class FakeWebContents {
  sent: Array<{ channel: string; payload: any }> = [];
  url = "file:///C:/Apps/Dafri/resources/app.asar/popup/popup.html";
  handlers = new Map<string, Handler>();
  openHandler: Handler | null = null;
  send(channel: string, payload: unknown) {
    this.sent.push({ channel, payload });
  }
  getURL() {
    return this.url;
  }
  setWindowOpenHandler(fn: Handler) {
    this.openHandler = fn;
  }
  on(event: string, fn: Handler) {
    this.handlers.set(event, fn);
    return this;
  }
  isDestroyed() {
    return false;
  }
  lastItems(): PopupItem[] {
    const last = this.sent.filter((s) => s.channel === "popup-items").at(-1);
    return last ? (last.payload.items as PopupItem[]) : [];
  }
}

class FakeWindow {
  static instances: FakeWindow[] = [];
  opts: any;
  log: string[] = [];
  visible = false;
  destroyed = false;
  bounds: Rect | null = null;
  background = "";
  onTop: unknown[] = [];
  workspaces: unknown[] = [];
  loaded = "";
  events = new Map<string, Handler>();
  webContents = new FakeWebContents();
  constructor(opts: any) {
    this.opts = opts;
    this.background = opts.backgroundColor;
    FakeWindow.instances.push(this);
  }
  setAlwaysOnTop(...args: unknown[]) {
    this.onTop = args;
  }
  setVisibleOnAllWorkspaces(...args: unknown[]) {
    this.workspaces = args;
  }
  loadFile(p: string) {
    this.loaded = p;
    return Promise.resolve();
  }
  on(event: string, fn: Handler) {
    this.events.set(event, fn);
    return this;
  }
  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return this.visible;
  }
  showInactive() {
    this.visible = true;
    this.log.push("showInactive");
  }
  show() {
    this.visible = true;
    this.log.push("show");
  }
  focus() {
    this.log.push("focus");
  }
  hide() {
    this.visible = false;
    this.log.push("hide");
  }
  setBounds(b: Rect) {
    this.bounds = b;
  }
  moveTop() {
    this.log.push("moveTop");
  }
  setBackgroundColor(c: string) {
    this.background = c;
  }
  destroy() {
    this.destroyed = true;
    this.visible = false;
    this.events.get("closed")?.();
  }
}

class FakeMain {
  log: string[] = [];
  focused: boolean;
  minimized = true;
  handlers = new Map<string, Handler[]>();
  constructor(focused: boolean) {
    this.focused = focused;
  }
  on(event: string, fn: Handler) {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
    return this;
  }
  removeListener(event: string, fn: Handler) {
    this.handlers.set(event, (this.handlers.get(event) ?? []).filter((f) => f !== fn));
    return this;
  }
  /** 用户把主窗口点到前台:系统自己会停掉闪烁 */
  gainFocus() {
    this.focused = true;
    for (const fn of this.handlers.get("focus") ?? []) fn();
  }
  loseFocus() {
    this.focused = false;
  }
  listenerCount(event: string) {
    return (this.handlers.get(event) ?? []).length;
  }
  isDestroyed() {
    return false;
  }
  isFocused() {
    return this.focused;
  }
  isMinimized() {
    return this.minimized;
  }
  restore() {
    this.minimized = false;
    this.log.push("restore");
  }
  isVisible() {
    return true;
  }
  show() {
    this.log.push("show");
  }
  focus() {
    this.log.push("focus");
  }
  flashFrame(on: boolean) {
    this.log.push(`flash:${on}`);
  }
}

/** 弹窗页坏了的时候主进程自己补的系统通知 */
class FakeNotification {
  static shown: Array<{ title: string; body: string }> = [];
  static supported = true;
  static isSupported() {
    return FakeNotification.supported;
  }
  opts: { title: string; body: string };
  constructor(opts: { title: string; body: string }) {
    this.opts = opts;
  }
  show() {
    FakeNotification.shown.push(this.opts);
  }
}

const WORK_A: Rect = { x: 1920, y: 25, width: 2560, height: 1415 };
const WORK_B: Rect = { x: 0, y: 0, width: 1920, height: 1040 };

/** 本用例里建过的 manager:afterEach 统一收摊(看门狗定时器不能漏到下一个用例) */
const live: Manager[] = [];

function setup(opts: { mainFocused?: boolean; dark?: boolean; mainWindow?: FakeMain | null } = {}) {
  FakeWindow.instances = [];
  FakeNotification.shown = [];
  FakeNotification.supported = true;
  let cursorOn: Rect = WORK_A;
  let displays: Rect[] = [WORK_A, WORK_B];
  const screenHandlers = new Map<string, Handler[]>();
  const screen = {
    getCursorScreenPoint: () => ({ x: cursorOn.x + 10, y: cursorOn.y + 10 }),
    getDisplayNearestPoint: () => ({ workArea: cursorOn }),
    getPrimaryDisplay: () => ({ workArea: WORK_B }),
    getAllDisplays: () => displays.map((workArea) => ({ workArea })),
    on(event: string, fn: Handler) {
      const list = screenHandlers.get(event) ?? [];
      list.push(fn);
      screenHandlers.set(event, list);
      return this;
    },
    removeListener(event: string, fn: Handler) {
      screenHandlers.set(event, (screenHandlers.get(event) ?? []).filter((f) => f !== fn));
      return this;
    },
  };
  const nativeTheme = { shouldUseDarkColors: Boolean(opts.dark) };
  const app = { focus: vi.fn() };
  const main = opts.mainWindow === undefined ? new FakeMain(Boolean(opts.mainFocused)) : opts.mainWindow;
  const toMain: Array<{ channel: string; payload: any }> = [];
  const mgr = new PopupManager({
    electron: { BrowserWindow: FakeWindow, screen, nativeTheme, app, Notification: FakeNotification },
    getMainWindow: () => main,
    sendToMain: (channel: string, payload: unknown) => toMain.push({ channel, payload }),
  });
  live.push(mgr);
  const moveCursorTo = (area: Rect) => {
    cursorOn = area;
  };
  /** 拔掉一块屏 / 换分辨率:剩下的显示器由 getAllDisplays 报出去 */
  const setDisplays = (next: Rect[]) => {
    displays = next;
  };
  const emitDisplayEvent = (event: string) => {
    for (const fn of screenHandlers.get(event) ?? []) fn();
  };
  const screenListenerCount = (event: string) => (screenHandlers.get(event) ?? []).length;
  return { mgr, main: main!, toMain, nativeTheme, moveCursorTo, setDisplays, emitDisplayEvent, screenListenerCount };
}

function raw(id: string, extra: Record<string, unknown> = {}) {
  return { id, kind: "anomaly", symbol: "RKLB", title: "RKLB 放量 3.1×", body: "说明", tone: "up", at: 1_000, ...extra };
}

/** 模拟弹窗页:ready 之后渲染、报高度。 */
function pageShows(mgr: Manager, height = 150) {
  mgr.handleAction({ type: "ready" });
  mgr.handleAction({ type: "size", height });
}

const ids = (mgr: Manager) => mgr.items.map((i) => i.id);

afterEach(() => {
  // 每扇窗都挂着一个 10 秒的看门狗:不收摊的话它会在后面某个用例里突然开火
  for (const mgr of live) mgr.destroy();
  live.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- 清洗

describe("弹窗内容清洗(sanitizePopupPayload)", () => {
  it("payload 不是对象 / items 不是数组 → 空列表,涨跌配色兜底 green-up", () => {
    for (const bad of [null, undefined, 42, "x", [], { items: "nope" }, { items: { 0: raw("a") } }]) {
      expect(sanitizePopupPayload(bad)).toEqual({ items: [], updown: "green-up", dropped: 0 });
    }
    expect(sanitizePopupPayload({ items: [], updown: "red-up" }).updown).toBe("red-up");
    expect(sanitizePopupPayload({ items: [], updown: "purple-up" }).updown).toBe("green-up");
  });

  it("一次最多收 30 条(和列表上限取齐),多出来的如实记进 dropped 而不是悄悄截掉", () => {
    expect(POPUP_LIMITS.maxIncoming).toBe(POPUP_LIMITS.maxItems);
    expect(POPUP_LIMITS.maxIncoming).toBe(30);

    const items = Array.from({ length: 35 }, (_, i) => raw(`id${i}`));
    const out = sanitizePopupPayload({ items });
    expect(out.items).toHaveLength(30);
    expect(out.items[0]!.id).toBe("id0");
    expect(out.items.at(-1)!.id).toBe("id29");
    expect(out.dropped).toBe(5); // 截在门外的那几条,调用方要自己补通知

    expect(sanitizePopupPayload({ items: items.slice(0, 30) }).dropped).toBe(0);
    // 没有 id 的整条丢掉,但那不算"截断":dropped 只数装不下的
    expect(sanitizePopupPayload({ items: [raw("a"), { id: "" }] }).dropped).toBe(0);
  });

  it("id 只留字母数字与 _:.-|+、截到 100;洗完为空的整条丢掉", () => {
    const out = sanitizePopupPayload({
      items: [
        raw("RKLB:burst:up:-:1789150800"),
        raw("level:SPX:5000.5:1789150800000"),
        raw("a b<script>c" + NUL + "d"),
        raw("x".repeat(150)),
        raw("<>!@#"),
        raw(""),
        { ...raw("tmp"), id: undefined },
        null,
        "string",
        [raw("arr")],
      ],
    });
    expect(out.items.map((i) => i.id)).toEqual([
      "RKLB:burst:up:-:1789150800",
      "level:SPX:5000.5:1789150800000",
      "abscriptcd",
      "x".repeat(100),
    ]);
  });

  it("symbol 转大写、只留字母数字点横线、截到 16", () => {
    const sym = (s: unknown) => sanitizePopupPayload({ items: [raw("a", { symbol: s })] }).items[0]!.symbol;
    expect(sym("brk.b")).toBe("BRK.B");
    expect(sym("rds-a")).toBe("RDS-A");
    expect(sym("AB C<D>")).toBe("ABCD");
    expect(sym("Z".repeat(30))).toHaveLength(16);
    expect(sym(123)).toBe("");
  });

  it("title 截 80、body 截 240;控制字符换成空格,零宽与双向控制字符去掉", () => {
    const out = sanitizePopupPayload({
      items: [
        raw("a", {
          title: "RKLB" + TAB + "放量" + LF + LF + "3.1×" + BEL + DEL,
          body: "下" + RLO + "破" + ZWSP + BOM + " 5000" + NUL,
        }),
        raw("b", { title: "长".repeat(200), body: "b".repeat(500) }),
      ],
    });
    const [a, b] = out.items;
    expect(a!.title).toBe("RKLB 放量 3.1×");
    expect(a!.body).toBe("下破 5000");
    expect(b!.title).toHaveLength(80);
    expect(b!.body).toHaveLength(240);
    for (const item of out.items) {
      for (const text of [item.title, item.body]) {
        expect([...text].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 0x7f)).toBe(false);
      }
    }
  });

  it("按码点截断,不会把 emoji 劈成半个代理对", () => {
    const title = "😀".repeat(100);
    const out = sanitizePopupPayload({ items: [raw("a", { title })] }).items[0]!.title;
    expect([...out]).toHaveLength(80);
    expect(out).toBe("😀".repeat(80));
  });

  it("tone / kind / page 不在集合里就兜底;at 非有限数 → 当前时间;title 为空退回代码", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_789_150_800_000);
    const [a, b, c] = sanitizePopupPayload({
      items: [
        raw("a", { tone: "rainbow", kind: "trade", page: "orders", at: Number.NaN }),
        raw("b", { tone: "down", kind: "level", page: "sectors", at: 5 }),
        raw("c", { title: "   ", body: undefined, at: "1000", page: undefined }),
      ],
    }).items;
    expect(a).toMatchObject({ tone: "info", kind: "anomaly", page: null, at: 1_789_150_800_000 });
    expect(b).toMatchObject({ tone: "down", kind: "level", page: "sectors", at: 5 });
    expect(c).toMatchObject({ title: "RKLB", body: "", page: null, at: 1_789_150_800_000 });
    expect(Object.keys(a!).sort()).toEqual(["at", "body", "id", "kind", "page", "symbol", "title", "tone"]);
  });

  it("幂等:洗过的再洗一遍结果不变", () => {
    const once = sanitizePopupPayload({
      items: [raw("a:b c", { title: "x" + LF + "y", symbol: "brk.b", tone: "?", page: "quality" })],
      updown: "red-up",
    });
    expect(sanitizePopupPayload(once)).toEqual(once);
  });
});

describe("弹窗位置(popupBounds)", () => {
  it("工作区右上角,边距 12,宽 360;高度夹在 [96, 工作区 × 0.7]", () => {
    expect(popupBounds(WORK_A, 150.2)).toEqual({ x: 1920 + 2560 - 360 - 12, y: 25 + 12, width: 360, height: 151 });
    expect(popupBounds(WORK_A, 20).height).toBe(96);
    expect(popupBounds(WORK_A, 5000).height).toBe(Math.floor(1415 * 0.7));
    expect(popupBounds(WORK_A, Number.NaN).height).toBe(96);
    // 工作区小到 0.7 倍都不够 96:宁可按 96
    expect(popupBounds({ x: 0, y: 0, width: 800, height: 100 }, 400).height).toBe(96);
  });
});

// ---------------------------------------------------------------- 窗口行为

describe("PopupManager", () => {
  it("没有内容不建窗;第一条来了才懒建窗:安全三件套、置顶、不进任务栏、先不显示", () => {
    const { mgr } = setup();
    expect(mgr.push({ items: [] })).toEqual({ shown: 0, dropped: 0 });
    expect(mgr.push({ items: [{ id: "" }] })).toEqual({ shown: 0, dropped: 0 });
    expect(FakeWindow.instances).toHaveLength(0);

    expect(mgr.push({ items: [raw("a")] })).toEqual({ shown: 1, dropped: 0 });
    expect(FakeWindow.instances).toHaveLength(1);
    const win = FakeWindow.instances[0]!;
    expect(win.opts).toMatchObject({
      width: 360,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
    });
    // Windows 上不可获得焦点:点弹窗的按钮也不把键盘焦点从 TWS 抢走
    expect(win.opts.focusable).toBe(process.platform !== "win32");
    expect(win.opts.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: false,
    });
    expect(path.basename(win.opts.webPreferences.preload)).toBe("popup-preload.js");
    expect(path.basename(win.loaded)).toBe("popup.html");
    expect(path.basename(path.dirname(win.loaded))).toBe("popup");
    expect(win.onTop).toEqual([true, "screen-saver"]);
    expect(win.visible).toBe(false);
    expect(win.webContents.sent).toHaveLength(0); // 页面没 ready 之前不发,条目留着排队
  });

  it("页面 ready 后整份发出;报了高度才 showInactive,摆在光标所在屏工作区的右上角", () => {
    const { mgr } = setup();
    mgr.push({ items: [raw("a")], updown: "red-up" });
    mgr.push({ items: [raw("b", { at: 2_000 })], updown: "red-up" });
    const win = FakeWindow.instances[0]!;
    expect(FakeWindow.instances).toHaveLength(1);

    mgr.handleAction({ type: "ready" });
    const sent = win.webContents.sent.at(-1)!;
    expect(sent.channel).toBe("popup-items");
    expect(sent.payload.updown).toBe("red-up");
    expect(win.webContents.lastItems().map((i) => i.id)).toEqual(["b", "a"]);
    expect(win.visible).toBe(false); // 还没按内容高度摆好,先不露面

    mgr.handleAction({ type: "size", height: 150.2 });
    expect(win.visible).toBe(true);
    expect(win.bounds).toEqual({ x: 1920 + 2560 - 360 - 12, y: 37, width: 360, height: 151 });
    // 绝不 show() / focus()
    expect(win.log).toEqual(["showInactive"]);
  });

  it("已显示时来新条目:只改高度、提到最上层,不跟着光标换屏,也不再抢焦点", () => {
    const { mgr, moveCursorTo } = setup();
    mgr.push({ items: [raw("a")] });
    pageShows(mgr, 150);
    const win = FakeWindow.instances[0]!;

    moveCursorTo(WORK_B);
    mgr.push({ items: [raw("b", { at: 2_000 })] });
    expect(win.webContents.lastItems().map((i) => i.id)).toEqual(["b", "a"]);
    mgr.handleAction({ type: "size", height: 260 });
    expect(win.bounds).toEqual({ x: 1920 + 2560 - 360 - 12, y: 37, width: 360, height: 260 });
    expect(win.log).toEqual(["showInactive", "moveTop"]);

    // 高度夹在 [96, 工作区 × 0.7]
    mgr.handleAction({ type: "size", height: 99_999 });
    expect(win.bounds!.height).toBe(Math.floor(1415 * 0.7));
    mgr.handleAction({ type: "size", height: 10 });
    expect(win.bounds!.height).toBe(96);
  });

  it("按 id 去重替换、按时间新的在前、最多留 30 条", () => {
    const { mgr } = setup();
    mgr.push({ items: [raw("a", { at: 1_000 }), raw("b", { at: 2_000 })] });
    expect(ids(mgr)).toEqual(["b", "a"]);

    mgr.push({ items: [raw("a", { at: 3_000, title: "RKLB 放量 5.0×" })] });
    expect(ids(mgr)).toEqual(["a", "b"]);
    expect(mgr.items[0]!.title).toBe("RKLB 放量 5.0×");

    const batch = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => raw(`n${from + i}`, { at: 10_000 + from + i }));
    mgr.push({ items: batch(0, 20) });
    mgr.push({ items: batch(20, 20) });
    expect(mgr.items).toHaveLength(POPUP_LIMITS.maxItems);
    expect(POPUP_LIMITS.maxItems).toBe(30);
    expect(mgr.items[0]!.id).toBe("n39");
    expect(ids(mgr)).not.toContain("a"); // 最早的挤掉
  });

  it("关掉一条 → 重发列表;关掉最后一条 / 全部关闭 → 隐藏,任务栏也停闪", () => {
    const { mgr, main } = setup();
    mgr.push({ items: [raw("a"), raw("b")] });
    pageShows(mgr);
    const win = FakeWindow.instances[0]!;

    mgr.handleAction({ type: "dismiss", id: "a" });
    expect(ids(mgr)).toEqual(["b"]);
    expect(win.webContents.lastItems().map((i) => i.id)).toEqual(["b"]);
    expect(win.visible).toBe(true);

    mgr.handleAction({ type: "dismiss", id: "b" });
    expect(win.visible).toBe(false);
    expect(win.log.at(-1)).toBe("hide");
    expect(main.log.at(-1)).toBe("flash:false");

    // 隐藏之后再来一条:照样按"先排版、后露面"再显示一次
    mgr.push({ items: [raw("c")] });
    expect(win.visible).toBe(false);
    mgr.handleAction({ type: "size", height: 140 });
    expect(win.visible).toBe(true);
    expect(win.log.filter((l) => l === "showInactive")).toHaveLength(2);

    mgr.handleAction({ type: "clear" });
    expect(mgr.items).toEqual([]);
    expect(win.visible).toBe(false);
    expect(win.log).not.toContain("show");
    expect(win.log).not.toContain("focus");
  });

  it("关光了 / 全部关闭:空列表也要发下去,别在藏起来的页面里留着已经关掉的卡片", () => {
    const { mgr } = setup();
    mgr.push({ items: [raw("a"), raw("b", { at: 2_000 })] });
    pageShows(mgr);
    const win = FakeWindow.instances[0]!;

    mgr.handleAction({ type: "dismiss", id: "a" });
    expect(win.webContents.lastItems().map((i) => i.id)).toEqual(["b"]);
    mgr.handleAction({ type: "dismiss", id: "b" }); // 关掉最后一条
    expect(win.visible).toBe(false);
    expect(win.webContents.lastItems()).toEqual([]);

    mgr.push({ items: [raw("c"), raw("d", { at: 3_000 })] });
    pageShows(mgr, 200);
    expect(win.webContents.lastItems()).toHaveLength(2);
    mgr.handleAction({ type: "clear" });
    expect(win.visible).toBe(false);
    expect(win.webContents.lastItems()).toEqual([]); // 页面的 DOM 跟着清空
    expect(mgr.items).toEqual([]);

    // 关掉一条不存在的 id:什么都不发
    const sentBefore = win.webContents.sent.length;
    expect(mgr.dismiss("没有这条")).toBe(false);
    expect(win.webContents.sent).toHaveLength(sentBefore);
  });

  it("「查看」:主窗口 restore + focus,发 menu navigate(page 缺省 quality),再关掉这一条", () => {
    const { mgr, main, toMain } = setup();
    mgr.push({
      items: [
        raw("x", { symbol: "rklb", page: undefined, at: 2_000 }),
        raw("y", { symbol: "SPX", kind: "level", page: "sectors", at: 1_000 }),
      ],
    });
    pageShows(mgr);

    mgr.handleAction({ type: "open", id: "x" });
    expect(main.log).toContain("restore");
    expect(main.log).toContain("focus");
    expect(toMain.at(-1)).toEqual({ channel: "menu", payload: { action: "navigate", page: "quality", symbol: "RKLB" } });
    expect(ids(mgr)).toEqual(["y"]);

    mgr.handleAction({ type: "open", id: "y" });
    expect(toMain.at(-1)).toEqual({ channel: "menu", payload: { action: "navigate", page: "sectors", symbol: "SPX" } });
    expect(mgr.items).toEqual([]);

    const before = toMain.length;
    expect(mgr.open("不存在")).toBe(false);
    expect(toMain).toHaveLength(before);
  });

  it("来源校验:只认弹窗自己的主 frame,且页面是 file:// 的 popup/popup.html", () => {
    const { mgr } = setup();
    expect(mgr.isPopupSender({ sender: {}, senderFrame: null })).toBe(false); // 还没有窗
    mgr.push({ items: [raw("a")] });
    const win = FakeWindow.instances[0]!;
    const wc = win.webContents;
    const top = { parent: null, url: wc.url };

    expect(mgr.isPopupSender({ sender: wc, senderFrame: top })).toBe(true);
    expect(mgr.isPopupSender({ sender: wc, senderFrame: null })).toBe(true); // 退回 getURL()
    expect(mgr.isPopupSender({ sender: new FakeWebContents(), senderFrame: top })).toBe(false);
    expect(mgr.isPopupSender({ sender: wc, senderFrame: { parent: top, url: wc.url } })).toBe(false);
    expect(
      mgr.isPopupSender({ sender: wc, senderFrame: { parent: null, url: "file:///C:/app/renderer-react/dist/index.html" } }),
    ).toBe(false);
    expect(mgr.isPopupSender({ sender: wc, senderFrame: { parent: null, url: "https://evil.example/popup/popup.html" } })).toBe(
      false,
    );
    expect(mgr.isPopupSender(null)).toBe(false);

    mgr.destroy();
    expect(mgr.isPopupSender({ sender: wc, senderFrame: top })).toBe(false);
  });

  it("主窗口不在前台时闪任务栏;在前台就不闪", () => {
    const away = setup({ mainFocused: false });
    away.mgr.push({ items: [raw("a")] });
    pageShows(away.mgr);
    expect(away.main.log).toContain("flash:true");

    const here = setup({ mainFocused: true });
    here.mgr.push({ items: [raw("a")] });
    pageShows(here.mgr);
    expect(here.main.log).not.toContain("flash:true");
  });

  it("已经在闪就不重复调 flashFrame(true):macOS 上每调一次都是一次新的 requestUserAttention", () => {
    const { mgr, main } = setup({ mainFocused: false });
    mgr.push({ items: [raw("a")] });
    pageShows(mgr);
    expect(main.log.filter((l) => l === "flash:true")).toHaveLength(1);

    // 一批批地来:窗口每次都提到最上层,但闪烁只起一次
    for (let i = 0; i < 5; i += 1) {
      mgr.push({ items: [raw(`n${i}`, { at: 2_000 + i })] });
      mgr.handleAction({ type: "size", height: 200 + i });
    }
    expect(main.log.filter((l) => l === "flash:true")).toHaveLength(1);

    // 关光了 → 停闪;再来一条 → 允许再闪一次
    mgr.handleAction({ type: "clear" });
    expect(main.log.at(-1)).toBe("flash:false");
    mgr.push({ items: [raw("z", { at: 9_000 })] });
    mgr.handleAction({ type: "size", height: 150 });
    expect(main.log.filter((l) => l === "flash:true")).toHaveLength(2);
  });

  it("用户把主窗口点到前台(系统自己停了闪烁):标记跟着清零,之后切走再来的提醒还能闪", () => {
    const { mgr, main } = setup({ mainFocused: false });
    mgr.push({ items: [raw("a")] });
    pageShows(mgr);
    expect(main.log.filter((l) => l === "flash:true")).toHaveLength(1);
    expect(main.listenerCount("focus")).toBe(1);

    main.gainFocus(); // 系统这时已经把闪烁停掉了
    main.loseFocus(); // 用户又切回 TWS
    mgr.push({ items: [raw("b", { at: 2_000 })] });
    mgr.handleAction({ type: "size", height: 220 });
    expect(main.log.filter((l) => l === "flash:true")).toHaveLength(2);

    // 提醒还没关就切到前台:当场按"不用叫了"处理,后面也不会重复 flashFrame(false)
    main.gainFocus();
    mgr.push({ items: [raw("c", { at: 3_000 })] });
    mgr.handleAction({ type: "size", height: 240 });
    expect(main.log.filter((l) => l === "flash:true")).toHaveLength(2);
    mgr.handleAction({ type: "clear" });
    expect(main.log.filter((l) => l === "flash:false")).toHaveLength(0);

    // 监听只挂一份,收摊时摘掉
    expect(main.listenerCount("focus")).toBe(1);
    mgr.destroy();
    expect(main.listenerCount("focus")).toBe(0);
  });

  it("没有主窗口(还没建 / 已经关了)也不抛", () => {
    const { mgr } = setup({ mainWindow: null });
    mgr.push({ items: [raw("a")] });
    expect(() => pageShows(mgr)).not.toThrow();
    expect(() => mgr.handleAction({ type: "clear" })).not.toThrow();
  });

  it("锚定的那块屏没了(拔线 / 改分辨率):重新按光标所在屏摆,不把窗留在屏幕外", () => {
    const { mgr, moveCursorTo, setDisplays, emitDisplayEvent } = setup();
    mgr.push({ items: [raw("a")] });
    pageShows(mgr, 150);
    const win = FakeWindow.instances[0]!;
    expect(win.bounds).toEqual({ x: 1920 + 2560 - 360 - 12, y: 37, width: 360, height: 150 });

    // 拔掉右边那块副屏,光标只剩主屏
    setDisplays([WORK_B]);
    moveCursorTo(WORK_B);
    emitDisplayEvent("display-removed");
    expect(win.bounds).toEqual({ x: 1920 - 360 - 12, y: 12, width: 360, height: 150 });

    // 之后来的新条目继续按新锚点摆
    mgr.push({ items: [raw("b", { at: 2_000 })] });
    mgr.handleAction({ type: "size", height: 260 });
    expect(win.bounds).toEqual({ x: 1920 - 360 - 12, y: 12, width: 360, height: 260 });
  });

  it("显示器还在就别乱动:分辨率没变的 display-metrics-changed 不改锚点", () => {
    const { mgr, moveCursorTo, emitDisplayEvent } = setup();
    mgr.push({ items: [raw("a")] });
    pageShows(mgr, 150);
    const win = FakeWindow.instances[0]!;
    const before = { ...win.bounds! };

    moveCursorTo(WORK_B); // 光标挪到另一块屏:窗口不该跟着跳
    emitDisplayEvent("display-added");
    emitDisplayEvent("display-metrics-changed");
    expect(win.bounds).toEqual(before);
  });

  it("屏幕变动的监听跟着窗口走:没窗时不挂,窗口收了就摘掉", () => {
    const { mgr, screenListenerCount } = setup();
    expect(screenListenerCount("display-removed")).toBe(0);
    mgr.push({ items: [raw("a")] });
    expect(screenListenerCount("display-removed")).toBe(1);
    mgr.push({ items: [raw("b", { at: 2_000 })] }); // 同一扇窗,不重复挂
    expect(screenListenerCount("display-removed")).toBe(1);
    mgr.destroy();
    expect(screenListenerCount("display-removed")).toBe(0);
    expect(screenListenerCount("display-added")).toBe(0);
    expect(screenListenerCount("display-metrics-changed")).toBe(0);
  });

  it("取不到显示器列表(老版本 / 正在退出)就当锚点还在,绝不趁机乱挪窗", () => {
    const { mgr } = setup();
    mgr.push({ items: [raw("a")] });
    pageShows(mgr, 150);
    const win = FakeWindow.instances[0]!;
    const before = { ...win.bounds! };
    const screen = (mgr as any).electronOverride.screen;
    screen.getAllDisplays = () => {
      throw new Error("screen 已经拆了");
    };
    mgr.handleAction({ type: "size", height: 150 });
    expect(win.bounds).toEqual(before);

    // screen 整个不能用了:摆不了就不摆,总之不能把 handleAction 炸出去
    screen.getDisplayNearestPoint = () => {
      throw new Error("screen 已经拆了");
    };
    screen.getPrimaryDisplay = () => {
      throw new Error("screen 已经拆了");
    };
    mgr.handleAction({ type: "clear" });
    mgr.push({ items: [raw("b", { at: 2_000 })] });
    expect(() => mgr.handleAction({ type: "size", height: 180 })).not.toThrow();
  });

  it("页面迟迟不报高度:兜底时间一到照样显示(提醒宁可高度不准,也不能不出来)", () => {
    vi.useFakeTimers();
    const { mgr } = setup();
    mgr.push({ items: [raw("a"), raw("b")] });
    mgr.handleAction({ type: "ready" });
    const win = FakeWindow.instances[0]!;
    vi.advanceTimersByTime(POPUP_LIMITS.revealFallbackMs - 10);
    expect(win.visible).toBe(false);
    vi.advanceTimersByTime(20);
    expect(win.visible).toBe(true);
    expect(win.log).toEqual(["showInactive"]);
    expect(win.bounds!.height).toBeGreaterThanOrEqual(POPUP_LIMITS.minHeight);
  });

  it("看门狗:建窗后一直不 ready,排队的提醒由主进程改发系统通知(一条都不能咽下去)", () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { mgr } = setup();
    // 报 shown 是"收下准备显示",不是"已经画出来了":页面没 ready 之前条目在队列里等
    expect(mgr.push({ items: [raw("a", { title: "RKLB 放量 3.1×", body: "说明 A" })] })).toEqual({ shown: 1, dropped: 0 });
    expect(mgr.push({ items: [raw("b", { at: 2_000, title: "SPX 上穿 5000", body: "说明 B" })] })).toEqual({
      shown: 1,
      dropped: 0,
    });
    expect(FakeNotification.shown).toHaveLength(0); // 还在正常加载的时间里,不抢跑

    vi.advanceTimersByTime(POPUP_LIMITS.pageReadyTimeoutMs + 1);
    // 页面指望不上了:窗口扔掉,两条提醒改走系统通知,旧的在前地发(最新的落在最上面)
    expect(FakeNotification.shown).toEqual([
      { title: "RKLB 放量 3.1×", body: "说明 A" },
      { title: "SPX 上穿 5000", body: "说明 B" },
    ]);
    expect(FakeWindow.instances[0]!.destroyed).toBe(true);
    expect(mgr.win).toBe(null);
    expect(mgr.items).toEqual([]); // 已经用通知送达,窗口恢复了也别再显示一遍
    expect(err).toHaveBeenCalled();

    // 下一条提醒照常建新窗口,新窗口带自己的看门狗
    expect(mgr.push({ items: [raw("c")] })).toEqual({ shown: 1, dropped: 0 });
    expect(FakeWindow.instances).toHaveLength(2);
    mgr.handleAction({ type: "ready" });
    expect(FakeWindow.instances[1]!.webContents.lastItems().map((i) => i.id)).toEqual(["c"]);
    // ready 过的窗口不会被看门狗误判
    vi.advanceTimersByTime(POPUP_LIMITS.pageReadyTimeoutMs * 3);
    expect(FakeNotification.shown).toHaveLength(2);
    expect(mgr.win).not.toBe(null);
    mgr.destroy();
  });

  it("看门狗没跑成(定时器被挂起):下一次 push 补判坏,这一批如实报 shown 0 交给渲染层", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const { mgr } = setup();
    expect(mgr.push({ items: [raw("a")] })).toEqual({ shown: 1, dropped: 0 });

    now.mockReturnValue(1_000_000 + POPUP_LIMITS.pageReadyTimeoutMs + 1);
    // 这一批不进队列:主进程不发通知,由渲染层退回系统通知——两头都发就成了重复提醒
    expect(mgr.push({ items: [raw("b"), raw("c")] })).toEqual({ shown: 0, dropped: 2 });
    expect(FakeNotification.shown.map((n) => n.title)).toEqual(["RKLB 放量 3.1×"]); // 只补了排队的 a
    expect(mgr.items).toEqual([]);
    expect(mgr.win).toBe(null);
  });

  it("加载失败 / 预加载出错:当场就判坏,不用等满 10 秒", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fail = setup();
    fail.mgr.push({ items: [raw("a")] });
    const wc = FakeWindow.instances[0]!.webContents;
    wc.handlers.get("did-fail-load")!({}, -6, "ERR_FILE_NOT_FOUND", "file:///popup.html", true);
    expect(FakeNotification.shown).toHaveLength(1);
    expect(fail.mgr.win).toBe(null);

    // 子 frame 的失败、被顶掉的加载(ERR_ABORTED)都不算
    const ok = setup();
    ok.mgr.push({ items: [raw("a")] });
    const wc2 = FakeWindow.instances[0]!.webContents;
    wc2.handlers.get("did-fail-load")!({}, -6, "ERR_FILE_NOT_FOUND", "file:///x", false);
    wc2.handlers.get("did-fail-load")!({}, -3, "ERR_ABORTED", "file:///x", true);
    expect(FakeNotification.shown).toHaveLength(0);
    expect(ok.mgr.win).not.toBe(null);

    // 预加载挂了 = 页面永远拿不到 dafriPopup
    const pre = setup();
    pre.mgr.push({ items: [raw("a")] });
    FakeWindow.instances[0]!.webContents.handlers.get("preload-error")!({}, "popup-preload.js", new Error("boom"));
    expect(FakeNotification.shown).toHaveLength(1);
    expect(pre.mgr.win).toBe(null);

    // 已经 ready 的页面再收到迟到的失败事件:别把好好的窗拆了
    const live = setup();
    live.mgr.push({ items: [raw("a")] });
    pageShows(live.mgr);
    const liveWc = FakeWindow.instances[0]!.webContents;
    liveWc.handlers.get("did-fail-load")!({}, -6, "ERR_FILE_NOT_FOUND", "file:///x", true);
    expect(live.mgr.win).not.toBe(null);
    expect(FakeNotification.shown).toHaveLength(0);
  });

  it("系统通知一次最多堆 5 条,再多汇总成一条;通知也用不了就只能记日志", () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const many = setup();
    many.mgr.push({ items: Array.from({ length: 9 }, (_, i) => raw(`n${i}`, { at: 1_000 + i, body: `说明 ${i}` })) });
    vi.advanceTimersByTime(POPUP_LIMITS.pageReadyTimeoutMs + 1);
    expect(FakeNotification.shown).toHaveLength(POPUP_LIMITS.notifyFallbackMax + 1);
    expect(FakeNotification.shown.at(-1)!.body).toContain("另有 4 条");

    const none = setup();
    FakeNotification.supported = false;
    none.mgr.push({ items: [raw("a")] });
    vi.advanceTimersByTime(POPUP_LIMITS.pageReadyTimeoutMs + 1);
    expect(FakeNotification.shown).toHaveLength(0);
    expect(err.mock.calls.flat().join(" ")).toContain("系统通知也用不了");
  });

  it("导航、开新窗口、webview 一律拦", () => {
    const { mgr } = setup();
    mgr.push({ items: [raw("a")] });
    const wc = FakeWindow.instances[0]!.webContents;
    expect(wc.openHandler!({ url: "https://example.com" })).toEqual({ action: "deny" });
    const nav = { preventDefault: vi.fn() };
    wc.handlers.get("will-navigate")!(nav, "https://example.com");
    expect(nav.preventDefault).toHaveBeenCalled();
    const same = { preventDefault: vi.fn() };
    wc.handlers.get("will-navigate")!(same, wc.url);
    expect(same.preventDefault).not.toHaveBeenCalled();
    const webview = { preventDefault: vi.fn() };
    wc.handlers.get("will-attach-webview")!(webview);
    expect(webview.preventDefault).toHaveBeenCalled();
  });

  it("页面进程崩了:扔掉窗口、条目留着,下一条来时重建窗口一起显示", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { mgr } = setup();
    mgr.push({ items: [raw("a")] });
    pageShows(mgr);
    const first = FakeWindow.instances[0]!;
    first.webContents.handlers.get("render-process-gone")!({}, { reason: "crashed" });
    expect(first.destroyed).toBe(true);
    expect(mgr.win).toBe(null);
    expect(ids(mgr)).toEqual(["a"]);

    mgr.push({ items: [raw("b", { at: 2_000 })] });
    expect(FakeWindow.instances).toHaveLength(2);
    const second = FakeWindow.instances[1]!;
    mgr.handleAction({ type: "ready" });
    expect(second.webContents.lastItems().map((i) => i.id)).toEqual(["b", "a"]);
    mgr.destroy();
  });

  it("destroy:销毁窗口;之后再推会重新建窗", () => {
    const { mgr } = setup();
    mgr.push({ items: [raw("a")] });
    pageShows(mgr);
    const first = FakeWindow.instances[0]!;
    mgr.destroy();
    expect(first.destroyed).toBe(true);
    expect(mgr.win).toBe(null);
    expect(mgr.ready).toBe(false);
    mgr.destroy(); // 重复调用无害(before-quit 与 window-all-closed 都会调)

    mgr.push({ items: [raw("b")] });
    expect(FakeWindow.instances).toHaveLength(2);
  });

  it("窗口底色跟 nativeTheme,并与 popup.css 的 --bg-window 一致", () => {
    const { mgr, nativeTheme } = setup({ dark: true });
    mgr.push({ items: [raw("a")] });
    const win = FakeWindow.instances[0]!;
    expect(win.opts.backgroundColor).toBe("#232325");
    nativeTheme.shouldUseDarkColors = false;
    mgr.syncTheme();
    expect(win.background).toBe("#f2f2f4");

    const css = readFileSync(path.join(DESKTOP, "popup", "popup.css"), "utf-8");
    expect(css).toContain("--bg-window: #f2f2f4;");
    expect(css).toContain("--bg-window: #232325;");
  });

  it("页面发来乱七八糟的消息也不抛", () => {
    const { mgr } = setup();
    mgr.push({ items: [raw("a")] });
    const junk = [null, 1, "x", [], {}, { type: "size", height: "100" }, { type: "size", height: Number.NaN },
      { type: "size", height: -5 }, { type: "dismiss" }, { type: "open", id: { toString: 1 } }, { type: "nope" }];
    for (const msg of junk) expect(() => mgr.handleAction(msg)).not.toThrow();
    expect(ids(mgr)).toEqual(["a"]);
  });
});

// ---------------------------------------------------------------- 弹窗页

/**
 * 弹窗页(popup/popup.js)的最小 DOM 替身:引擎的测试跑在纯 Node 里,没有浏览器。
 * 页面只用到 createElement / textContent / append / replaceChildren / closest 这几样,照着做够了——
 * 图的是能真的把 popup.js 跑起来,验点击那两道闸,而不是又照抄一遍逻辑。
 */
class FakeEl {
  tag: string;
  className = "";
  type = "";
  title = "";
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  listeners = new Map<string, Handler[]>();
  #text = "";
  constructor(tag: string) {
    this.tag = tag;
  }
  get textContent() {
    return this.#text;
  }
  set textContent(value: string) {
    this.#text = String(value);
  }
  append(...kids: FakeEl[]) {
    for (const kid of kids) {
      kid.parent = this;
      this.children.push(kid);
    }
  }
  replaceChildren(...kids: FakeEl[]) {
    for (const kid of this.children) kid.parent = null;
    this.children = [];
    this.append(...kids);
  }
  setAttribute(name: string, value: string) {
    this.attrs[name] = String(value);
  }
  addEventListener(type: string, fn: Handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  closest(sel: string): FakeEl | null {
    // 从自己往上走父链,起点就是 this
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let node: FakeEl | null = this;
    while (node) {
      if (sel === "button[data-action]" && node.tag === "button" && typeof node.dataset.action === "string") return node;
      if (sel === "li.item" && node.tag === "li" && node.className.split(" ").includes("item")) return node;
      node = node.parent;
    }
    return null;
  }
  getBoundingClientRect() {
    return { height: 38 + 60 * this.children.reduce((n, c) => n + c.children.length, 0) };
  }
  find(pred: (el: FakeEl) => boolean): FakeEl | null {
    for (const kid of this.children) {
      if (pred(kid)) return kid;
      const hit = kid.find(pred);
      if (hit) return hit;
    }
    return null;
  }
}

function loadPage() {
  const src = readFileSync(path.join(DESKTOP, "popup", "popup.js"), "utf-8");
  const byId = new Map<string, FakeEl>();
  for (const id of ["app", "list", "count", "clear-all"]) byId.set(id, new FakeEl(id === "list" ? "ol" : "div"));
  const root = byId.get("app")!;
  const list = byId.get("list")!;
  root.append(list);

  const calls: Array<{ fn: string; arg: unknown }> = [];
  let onItems: Handler = () => {};
  const api = {
    onItems: (cb: Handler) => {
      onItems = cb;
      return () => {};
    },
    ready: () => calls.push({ fn: "ready", arg: undefined }),
    size: (h: number) => calls.push({ fn: "size", arg: h }),
    dismiss: (id: string) => calls.push({ fn: "dismiss", arg: id }),
    clear: () => calls.push({ fn: "clear", arg: undefined }),
    open: (id: string) => calls.push({ fn: "open", arg: id }),
  };
  const document = {
    documentElement: new FakeEl("html"),
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: (tag: string) => new FakeEl(tag),
  };
  // Date 用宿主的那一个:用例里 spyOn(Date, "now") 才管得到页面里的时间闸
  vm.runInNewContext(src, { window: { dafriPopup: api }, document, Element: FakeEl, Date: globalThis.Date, console });

  return {
    list,
    count: byId.get("count")!,
    document,
    calls,
    /** 主进程把列表发下来 */
    emit: (items: Array<Partial<PopupItem>>, updown = "green-up") => onItems({ items, updown }),
    /** 点某张卡上的按钮;detail 就是浏览器给的"这是第几下" */
    click: (id: string, action: string, detail = 1) => {
      const li = list.children.find((c) => c.dataset.id === id);
      const btn = li ? li.find((n) => n.tag === "button" && n.dataset.action === action) : null;
      for (const fn of list.listeners.get("click") ?? []) fn({ target: btn, detail });
    },
  };
}

const card = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: "anomaly",
  symbol: "RKLB",
  title: "RKLB 放量 3.1×",
  body: "说明",
  tone: "up",
  at: 1_789_150_800_000,
  page: "quality",
  ...extra,
});

describe("弹窗页的点击闸(列表会在指针底下重排)", () => {
  function page(now: { value: number }) {
    vi.spyOn(Date, "now").mockImplementation(() => now.value);
    return loadPage();
  }

  it("装上就订阅列表并报 ready;收到列表后画卡片、报高度", () => {
    const now = { value: 1_000_000 };
    const p = page(now);
    expect(p.calls.map((c) => c.fn)).toEqual(["ready"]);

    p.emit([card("a"), card("b", { symbol: "SPX", tone: "down" })]);
    expect(p.list.children.map((c) => c.dataset.id)).toEqual(["a", "b"]);
    expect(p.count.textContent).toBe("2 条");
    expect(p.calls.at(-1)!.fn).toBe("size");
    expect(p.calls.at(-1)!.arg).toBeGreaterThan(0);
  });

  it("「查看」双击的第二下不认:第一下已经把卡片关掉,后面的整体上移", () => {
    const now = { value: 1_000_000 };
    const p = page(now);
    p.emit([card("a"), card("b")]);
    now.value += 400; // 过了重排后的护窗期

    p.click("a", "open", 1);
    expect(p.calls.filter((c) => c.fn === "open")).toEqual([{ fn: "open", arg: "a" }]);
    p.emit([card("b")]); // 主进程关掉 a、重发列表,b 滑到指针底下
    now.value += 400; // 哪怕护窗期已过,同一次双击的第二下也不认
    p.click("b", "open", 2);
    expect(p.calls.filter((c) => c.fn === "open")).toHaveLength(1);
  });

  it("一条条连点「×」清列表:同一位置的连点 detail 一路涨,每一下都要认", () => {
    const now = { value: 1_000_000 };
    const p = page(now);
    p.emit([card("a"), card("b"), card("c"), card("d")]);
    now.value += 400;

    // 真机上量过:每秒三四下地点,浏览器给的 detail 是 1、2、3、4……
    const rest = ["a", "b", "c", "d"];
    for (let n = 1; n <= 4; n++) {
      const id = rest.shift()!;
      p.click(id, "dismiss", n);
      p.emit(rest.map((r) => card(r))); // 主进程重发,下一张卡的「×」滑到指针底下
      now.value += 250;
    }
    expect(p.calls.filter((c) => c.fn === "dismiss").map((c) => c.arg)).toEqual(["a", "b", "c", "d"]);
  });

  it("手滑双击「×」:第二下落在自己关掉一条之后的 150ms 短护窗里,不连带关掉下一条", () => {
    const now = { value: 1_000_000 };
    const p = page(now);
    p.emit([card("a"), card("b")]);
    now.value += 400;

    p.click("a", "dismiss", 1);
    p.emit([card("b")]);
    now.value += 149;
    p.click("b", "dismiss", 2);
    expect(p.calls.filter((c) => c.fn === "dismiss")).toEqual([{ fn: "dismiss", arg: "a" }]);
    now.value += 2;
    p.click("b", "dismiss", 3);
    expect(p.calls.filter((c) => c.fn === "dismiss").map((c) => c.arg)).toEqual(["a", "b"]);
  });

  it("自己关一条引起的短护窗不会把新提醒的 300ms 缩短", () => {
    const now = { value: 1_000_000 };
    const p = page(now);
    p.emit([card("a"), card("b")]);
    now.value += 400;

    p.emit([card("z", { at: 1_789_150_900_000 }), card("a"), card("b")]); // 新提醒:护 300ms
    now.value += 100;
    p.emit([card("z", { at: 1_789_150_900_000 }), card("b")]); // 紧跟着少了一条:只延不缩
    now.value += 160; // 离新提醒 260ms,离少一条 160ms
    p.click("z", "dismiss");
    expect(p.calls.filter((c) => c.fn === "dismiss")).toHaveLength(0);
    now.value += 41;
    p.click("z", "dismiss");
    expect(p.calls.filter((c) => c.fn === "dismiss")).toEqual([{ fn: "dismiss", arg: "z" }]);
  });

  it("刚重排过的 300ms 内不认点击:新提醒插在最前面,指针底下已经换了一只股票", () => {
    const now = { value: 1_000_000 };
    const p = page(now);
    p.emit([card("a")]);
    now.value += 400;

    // 新提醒插到最前面 → 顺序变了 → 护窗期重新开始
    p.emit([card("z", { symbol: "TSLA", at: 1_789_150_900_000 }), card("a")]);
    p.click("z", "dismiss");
    p.click("a", "open");
    expect(p.calls.filter((c) => c.fn === "dismiss" || c.fn === "open")).toHaveLength(0);

    now.value += 299;
    p.click("z", "dismiss");
    expect(p.calls.filter((c) => c.fn === "dismiss")).toHaveLength(0);
    now.value += 2;
    p.click("z", "dismiss");
    expect(p.calls.filter((c) => c.fn === "dismiss")).toEqual([{ fn: "dismiss", arg: "z" }]);
  });

  it("顺序和条数都没变的重画(只是内容更新)不设闸:别让用户白等", () => {
    const now = { value: 1_000_000 };
    const p = page(now);
    p.emit([card("a"), card("b")]);
    now.value += 400;

    p.emit([card("a", { title: "RKLB 放量 5.0×" }), card("b")]);
    p.click("a", "open");
    expect(p.calls.filter((c) => c.fn === "open")).toEqual([{ fn: "open", arg: "a" }]);

    // 条数变了(关掉一条之后主进程重发)照样设闸,只是短一些
    p.emit([card("b")]);
    p.click("b", "dismiss");
    expect(p.calls.filter((c) => c.fn === "dismiss")).toHaveLength(0);
    now.value += 150;
    p.click("b", "dismiss");
    expect(p.calls.filter((c) => c.fn === "dismiss")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- 静态检查

function block(source: string, marker: string, length = 400): string {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`找不到 ${marker}`);
  return source.slice(start, start + length);
}

function setBlock(source: string, name: string): Set<string> {
  const start = source.indexOf(`const ${name} = new Set([`);
  if (start < 0) throw new Error(`main.js 里找不到 ${name}`);
  const end = source.indexOf("]);", start);
  return new Set([...source.slice(start, end).matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]!));
}

describe("弹窗页与主进程的静态约束", () => {
  const html = readFileSync(path.join(DESKTOP, "popup", "popup.html"), "utf-8");
  const pageJs = readFileSync(path.join(DESKTOP, "popup", "popup.js"), "utf-8");
  const main = readFileSync(path.join(DESKTOP, "main.js"), "utf-8");
  const preload = readFileSync(path.join(DESKTOP, "preload.js"), "utf-8");
  const popupPreload = readFileSync(path.join(DESKTOP, "popup-preload.js"), "utf-8");

  it("popup.html 带严格 CSP,且没有内联脚本 / 内联样式", () => {
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    for (const directive of [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "connect-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
    ]) {
      expect(html).toContain(directive);
    }
    const scripts = [...html.matchAll(/<script[^>]*>/g)].map((m) => m[0]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toContain("src=");
    expect(html).not.toContain("<style");
    expect(html).not.toContain(" style=");
    expect(html).not.toMatch(/\son[a-z]+\s*=/i); // 没有 onclick= 一类的内联事件
  });

  it("popup.js 只用 createElement / textContent 拼节点,不把字符串当标记解析", () => {
    for (const bad of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"]) {
      expect(pageJs, bad).not.toContain(bad);
    }
    expect(pageJs).toContain("textContent");
    expect(pageJs).toContain("createElement");
  });

  it("main.js:popup-action 只认弹窗自己的主 frame,popup-show 只认主窗口", () => {
    const action = block(main, "ipcMain.on('popup-action'", 200);
    expect(action).toContain("if (!popup.isPopupSender(event)) return;");
    expect(action.indexOf("isPopupSender")).toBeLessThan(action.indexOf("handleAction"));

    const show = block(main, "ipcMain.handle('popup-show'", 200);
    expect(show).toContain("if (!isTrustedSender(event))");
    expect(show.indexOf("isTrustedSender")).toBeLessThan(show.indexOf("popup.push"));
  });

  it("main.js:主窗口关闭、全部窗口关闭、退出前都销毁弹窗(隐藏着的弹窗也会把应用吊着)", () => {
    expect(block(main, "mainWindow.on('closed'", 300)).toContain("popup.destroy()");
    expect(block(main, "app.on('window-all-closed'", 200)).toContain("popup.destroy()");
    expect(block(main, "app.on('before-quit'", 200)).toContain("popup.destroy()");
  });

  it("quality.* 都在 ALLOWED_RPC,且都不要求界面确认(只提醒、不下单)", () => {
    const allowed = setBlock(main, "ALLOWED_RPC");
    const sensitive = setBlock(main, "SENSITIVE_RPC");
    for (const m of ["quality.list", "quality.add", "quality.update", "quality.remove", "quality.set_config"]) {
      expect(allowed.has(m), m).toBe(true);
      expect(sensitive.has(m), m).toBe(false);
    }
  });

  it("preload:showPopup 走 popup-show;弹窗的 preload 只有 dafriPopup 那几个动作,碰不到 rpc", () => {
    expect(preload).toContain("showPopup: (items, updown) => ipcRenderer.invoke('popup-show', { items, updown })");
    expect(popupPreload).toContain("exposeInMainWorld('dafriPopup'");
    for (const fn of ["onItems", "ready", "size", "dismiss", "clear", "open"]) expect(popupPreload).toContain(`${fn}: `);
    expect(popupPreload).not.toContain("'rpc'");
    expect(popupPreload).not.toContain("invoke(");
    const channels = [...popupPreload.matchAll(/ipcRenderer\.(?:send|on)\('([a-z-]+)'/g)].map((m) => m[1]);
    expect(new Set(channels)).toEqual(new Set(["popup-action", "popup-items"]));
  });

  it("打包清单带上弹窗的主进程模块、预加载与页面", () => {
    const pkg = JSON.parse(readFileSync(path.join(DESKTOP, "package.json"), "utf-8")) as { build: { files: string[] } };
    for (const f of ["popup-window.js", "popup-preload.js", "popup/**/*"]) expect(pkg.build.files).toContain(f);
  });
});
