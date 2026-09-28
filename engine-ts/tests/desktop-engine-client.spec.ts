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
  start(): Promise<void>;
  stop(opts?: { killGraceMs?: number; final?: boolean }): Promise<void>;
  restart(): Promise<void>;
  call(method: string, params?: object, opts?: { timeoutMs?: number }): Promise<{ pid: number }>;
}
const { EngineClient } = require(path.join(DESKTOP, "rpc-client.js")) as {
  EngineClient: new (opts: { configPath: string; tsEngineRoot: string; packaged: boolean }) => Client;
};

// 假引擎:system.status 回自己的 pid;hang 永远不回;crash 直接退出;FAKE_IGNORE_TERM=1 时不理 SIGTERM
const FAKE_ENGINE = `
const readline = require('node:readline');
if (process.env.FAKE_IGNORE_TERM === '1') process.on('SIGTERM', () => {});
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'hang') return;
  if (msg.method === 'crash') process.exit(3);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { pid: process.pid } }) + '\\n');
});
// stdin 关了也不自己退:模拟一个只认信号的引擎,才测得出"旧进程还活着"的窗口
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

function client(): { c: Client; exits: unknown[] } {
  const c = new EngineClient({ configPath: "/dev/null", tsEngineRoot: root, packaged: false });
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
  for (const c of clients.splice(0)) await c.stop({ killGraceMs: 200 });
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
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

  it("旧引擎不理 SIGTERM:宽限期一过就 SIGKILL,stop() 在它真死之后才落地", async () => {
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
