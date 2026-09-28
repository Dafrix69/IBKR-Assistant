/** 桌面端拉起引擎的那一层(desktop/rpc-client.js):重启时绝不能留下第二个活着的引擎。
 *
 * 事故形状(2026-09-27 审计时复现):「关于」页点「重启交易引擎」= stop() 紧跟 start()。
 * 旧引擎的 exit 事件在新引擎拉起之后才到,旧的处理函数把 `this.child` 清成 null、把在途调用全拒掉——
 * 清掉的其实是**新**引擎的引用。新引擎成了孤儿:还连着 TWS(同一个 client id)、还跑着盯盘节拍会发平仓单,
 * 界面却看不见它;下一次轮询又拉起第三个,连不上 TWS,顶栏显示"未连接"。
 *
 * 这里用一个真的子进程当假引擎(本机 node 跑一段读 stdin 回 JSON 的脚本),不连任何券商。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const DESKTOP = path.resolve(__dirname, "..", "..", "desktop");
const require = createRequire(import.meta.url);

interface Child { pid: number; exitCode: number | null; signalCode: string | null }
interface Client {
  child: Child | null;
  on(event: string, fn: (payload: unknown) => void): void;
  start(opts?: { force?: boolean }): Promise<void>;
  stop(opts?: { killGraceMs?: number; drainMs?: number; final?: boolean }): Promise<void>;
  restart(opts?: { drainMs?: number }): Promise<void>;
  holdUntil(epochMs: number): void;
  call(method: string, params?: object, opts?: { timeoutMs?: number; lateReply?: boolean }): Promise<{ pid: number }>;
}
const { EngineClient } = require(path.join(DESKTOP, "rpc-client.js")) as {
  EngineClient: new (opts: { configPath: string; tsEngineRoot: string; packaged: boolean; drainMs?: number }) => Client;
};

// 假引擎:system.status 回自己的 pid;hang 永远不回;crash 直接退出;slow 过 params.ms 毫秒才回;
// FAKE_IGNORE_TERM=1 时不理 SIGTERM;FAKE_EXIT_ON_EOF=1 时像真引擎那样,stdin 关了就把在途的答完再退
const FAKE_ENGINE = `
const readline = require('node:readline');
if (process.env.FAKE_IGNORE_TERM === '1') process.on('SIGTERM', () => {});
const rl = readline.createInterface({ input: process.stdin });
let inFlight = 0;
let closed = false;
const reply = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { pid: process.pid } }) + '\\n');
const maybeExit = () => { if (closed && inFlight === 0 && process.env.FAKE_EXIT_ON_EOF === '1') process.exit(0); };
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'hang') return;
  if (msg.method === 'crash') process.exit(3);
  if (msg.method === 'slow') {
    inFlight += 1;
    setTimeout(() => { reply(msg); inFlight -= 1; maybeExit(); }, Number(msg.params.ms));
    return;
  }
  reply(msg);
});
rl.on('close', () => { closed = true; maybeExit(); });
// 默认 stdin 关了也不自己退:模拟一个只认信号的引擎,才测得出"旧进程还活着"的窗口
setInterval(() => {}, 1 << 30);
`;

let root = "";
const clients: Client[] = [];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** drainMs 默认给得很短:假引擎默认不认 EOF,每次 stop 都白等满这段时间。测排空的用例自己给长的。 */
function client(drainMs = 40): { c: Client; exits: unknown[] } {
  const c = new EngineClient({ configPath: "/dev/null", tsEngineRoot: root, packaged: false, drainMs });
  const exits: unknown[] = [];
  c.on("exit", (info) => exits.push(info));
  clients.push(c);
  return { c, exits };
}

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "fake-engine-"));
  mkdirSync(path.join(root, "dist", "src"), { recursive: true });
  writeFileSync(path.join(root, "dist", "src", "cli.js"), FAKE_ENGINE);
});

afterEach(async () => {
  delete process.env.FAKE_IGNORE_TERM;
  delete process.env.FAKE_EXIT_ON_EOF;
  for (const c of clients.splice(0)) await c.stop({ killGraceMs: 200, drainMs: 0 });
});

afterAll(() => {
  try {
    if (root) rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows 上文件可能还被占着(SQLite、刚退出的子进程):临时目录留给系统清 */
  }
});

describe("EngineClient:重启是先死后生", () => {
  it("restart() 之后只剩一个引擎活着,而且就是界面在用的那个", async () => {
    const { c, exits } = client();
    const first = (await c.call("system.status")).pid;
    await c.restart();
    const second = (await c.call("system.status")).pid;
    expect(second).not.toBe(first);
    expect(alive(first)).toBe(false);
    expect(alive(second)).toBe(true);
    expect(c.child?.pid).toBe(second);
    // 自己停的不算"引擎意外退出":不发 exit,主进程也就不会去自动拉起、界面不会弹"引擎已退出"
    expect(exits).toHaveLength(0);
  });

  it("老写法 stop(); start() 不等:start 也会等旧进程退干净,旧进程迟到的 exit 不会清掉新引擎", async () => {
    const { c, exits } = client();
    const first = (await c.call("system.status")).pid;
    void c.stop();
    await c.start();
    const second = c.child?.pid ?? -1;
    expect(alive(first)).toBe(false); // 新的拉起时旧的已经死了
    await new Promise((r) => setTimeout(r, 150)); // 给迟到的事件留时间
    expect(c.child?.pid).toBe(second);
    expect((await c.call("system.status")).pid).toBe(second);
    expect(exits).toHaveLength(0);
  });

  // Windows 没有信号:kill 就是直接结束进程,没有"不理 SIGTERM"这回事,也就没有宽限期可量
  it.skipIf(process.platform === "win32")("旧引擎不理 SIGTERM:宽限期一过就 SIGKILL,stop() 在它真死之后才落地", async () => {
    process.env.FAKE_IGNORE_TERM = "1";
    const { c } = client();
    const pid = (await c.call("system.status")).pid;
    const t0 = Date.now();
    await c.stop({ killGraceMs: 150 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect(alive(pid)).toBe(false);
  });

  it("正在用的引擎崩了:拒掉发给它的在途调用,并发 exit(主进程据此自动拉起)", async () => {
    const { c, exits } = client();
    await c.call("system.status");
    const hanging = c.call("hang");
    await expect(c.call("crash")).rejects.toThrow("交易引擎已退出");
    await expect(hanging).rejects.toThrow("交易引擎已退出");
    expect(exits).toHaveLength(1);
    expect(c.child).toBeNull();
    // 下一次调用会拉起新的
    expect((await c.call("system.status")).pid).toBeGreaterThan(0);
  });

  it("单次调用可以给短超时(主进程心跳用),超时只拒这一次,不影响引擎", async () => {
    const { c } = client();
    const pid = (await c.call("system.status")).pid;
    await expect(c.call("hang", {}, { timeoutMs: 80 })).rejects.toThrow("超时");
    expect((await c.call("system.status")).pid).toBe(pid);
  });

  it("已经发给旧引擎的调用随旧引擎一起被拒;还没发出去的等新引擎起来再发", async () => {
    const { c } = client();
    const first = (await c.call("system.status")).pid;
    const written = c.call("hang");
    await new Promise((r) => setTimeout(r, 30)); // 确认已经写进旧引擎的 stdin
    const notYet = c.call("system.status"); // 与 restart 同一拍发起
    const restarted = c.restart();
    await expect(written).rejects.toThrow("交易引擎已退出");
    await restarted;
    const pid = (await notYet).pid;
    expect(pid).not.toBe(first);
    expect(pid).toBe(c.child?.pid);
  });

  it("应用退出(final)之后不再拉起任何引擎", async () => {
    const { c } = client();
    const pid = (await c.call("system.status")).pid;
    await c.stop({ final: true });
    expect(alive(pid)).toBe(false);
    await expect(c.call("system.status")).rejects.toThrow("应用正在退出");
    expect(c.child).toBeNull();
    await until(() => !alive(pid));
  });
});

describe("EngineClient:停引擎先排空", () => {
  it("stop() 先关 stdin:引擎把在途请求答完再自己退,不挨 SIGTERM", async () => {
    process.env.FAKE_EXIT_ON_EOF = "1";
    const { c, exits } = client(2000);
    const pid = (await c.call("system.status")).pid;
    const inFlight = c.call("slow", { ms: 150 }); // 正在发的那张单
    await new Promise((r) => setTimeout(r, 30));
    const t0 = Date.now();
    await c.stop();
    // 在途的那一次答完了(以前 SIGTERM 先到,它被拒成「交易引擎已退出」)
    expect((await inFlight).pid).toBe(pid);
    expect(Date.now() - t0).toBeLessThan(1500); // 没等满 drainMs:引擎是自己退的
    expect(alive(pid)).toBe(false);
    expect(exits).toHaveLength(0);
  });

  it("引擎不认 EOF:drainMs 过后照旧 SIGTERM", async () => {
    const { c } = client(120);
    const pid = (await c.call("system.status")).pid;
    const t0 = Date.now();
    await c.stop();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
    expect(alive(pid)).toBe(false);
  });

  it("drainMs: 0 不等(心跳判死的引擎):立刻 SIGTERM", async () => {
    const { c } = client(5000);
    const pid = (await c.call("system.status")).pid;
    const t0 = Date.now();
    await c.restart({ drainMs: 0 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(alive(pid)).toBe(false);
    expect((await c.call("system.status")).pid).not.toBe(pid);
  });
});

describe("EngineClient:超时不等于没发生", () => {
  it("要了 lateReply 的调用:超时报 ENGINE_TIMEOUT,引擎迟到的回执发 late-reply", async () => {
    const { c } = client();
    const pid = (await c.call("system.status")).pid;
    const late: Array<{ method: string; ok: boolean; result: { pid: number } | null; waitedMs: number }> = [];
    c.on("late-reply", (info) => late.push(info as (typeof late)[number]));
    const err = await c.call("slow", { ms: 200 }, { timeoutMs: 60, lateReply: true }).catch((e: Error & { code?: string }) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { code?: string }).code).toBe("ENGINE_TIMEOUT");
    expect(late).toHaveLength(0);
    await until(() => late.length === 1);
    expect(late[0]?.method).toBe("slow");
    expect(late[0]?.ok).toBe(true);
    expect(late[0]?.result?.pid).toBe(pid);
    expect(late[0]?.waitedMs).toBeGreaterThanOrEqual(150);
  });

  it("没要 lateReply 的(轮询、心跳):迟到的回执照旧丢掉,不发事件", async () => {
    const { c } = client();
    await c.call("system.status");
    const late: unknown[] = [];
    c.on("late-reply", (info) => late.push(info));
    await expect(c.call("slow", { ms: 120 }, { timeoutMs: 40 })).rejects.toThrow("超时");
    await new Promise((r) => setTimeout(r, 200));
    expect(late).toHaveLength(0);
  });

  it("引擎退了:等它迟到回执的那几条一并作废", async () => {
    const { c } = client();
    await c.call("system.status");
    const late: unknown[] = [];
    c.on("late-reply", (info) => late.push(info));
    await expect(c.call("slow", { ms: 300 }, { timeoutMs: 40, lateReply: true })).rejects.toThrow("超时");
    await expect(c.call("crash")).rejects.toThrow("交易引擎已退出");
    await new Promise((r) => setTimeout(r, 350));
    expect(late).toHaveLength(0);
  });
});

describe("EngineClient:重启退避拦得住轮询", () => {
  it("holdUntil 之前 call 不拉起引擎;到点之后照常", async () => {
    const { c, exits } = client();
    await c.call("system.status");
    await expect(c.call("crash")).rejects.toThrow("交易引擎已退出");
    expect(exits).toHaveLength(1);
    c.holdUntil(Date.now() + 250);
    await expect(c.call("system.status")).rejects.toThrow(/秒后自动重启/);
    expect(c.child).toBeNull();
    expect(exits).toHaveLength(1); // 被退避挡下的调用不算一次"引擎退出"
    await new Promise((r) => setTimeout(r, 280));
    expect((await c.call("system.status")).pid).toBeGreaterThan(0);
  });

  it("手动重启与主进程到点的那一次拉起(force)不受退避管", async () => {
    const { c } = client();
    await c.call("system.status");
    await expect(c.call("crash")).rejects.toThrow("交易引擎已退出");
    c.holdUntil(Date.now() + 60_000);
    await c.start({ force: true });
    expect((await c.call("system.status")).pid).toBeGreaterThan(0);
    c.holdUntil(Date.now() + 60_000); // 引擎活着时设了也不影响调用
    expect((await c.call("system.status")).pid).toBeGreaterThan(0);
    await c.restart();
    expect((await c.call("system.status")).pid).toBeGreaterThan(0);
  });
});
