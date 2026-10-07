/** 系统凭证库的弹窗不许卡住交易。
 *
 * 换一个没有正式签名的包,macOS 第一次解密钥匙串条目要弹窗问人。以前引擎在自己的事件循环上同步调原生库,
 * 弹窗没人点,盯盘节拍、托管单对账、所有 RPC 一起停(见 docs/journal/keychain-prompt-stall.md)。现在的口径(secrets.ts):
 *  · 界面一打开就问的「有没有存过」不解密;
 *  · 真要用这把钥匙时在子进程里读,调用方最多等一个时限,到点报一句说清楚怎么办的错;
 *  · 等的时候,盯盘、system.status、别的 RPC 照常。
 *
 * 全部离线:凭证库换成假的(永远不回话),券商是假的。子进程那几条用临时目录里现编的入口;
 * 碰到系统凭证库的只有一条:查一个不存在的条目(不存在的条目不会弹窗)。
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { isSupported } from "../src/keychain.js";
import { RpcServer } from "../src/rpc.js";
import {
  KeychainTimeoutError, callKeychainChild, readSecret, secretExists, useSecretBackend, writeSecret,
} from "../src/secrets.js";
import type { SecretBackend } from "../src/secrets.js";
import * as tk from "../src/tracker.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(HERE, "..");
type Rec = Record<string, any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await sleep(10);
  }
}

/** 一个会记账的假凭证库:read / write 默认永远不回话(弹窗没人点)。 */
function fakeKeychain(over: Partial<SecretBackend> = {}): SecretBackend & { reads: string[]; checks: string[] } {
  const reads: string[] = [];
  const checks: string[] = [];
  return {
    reads,
    checks,
    exists: async (service, account) => {
      checks.push(`${service}/${account}`);
      return account === "anthropic";
    },
    read: (service, account) => {
      reads.push(`${service}/${account}`);
      return never();
    },
    write: () => never(),
    ...over,
  };
}

afterEach(() => {
  useSecretBackend(null);
});

// ---------------------------------------------------------------- secrets.ts
describe("secrets:凭证库永远不回话", () => {
  it("到点抛 KeychainTimeoutError,说清楚去处理系统弹窗;等的这段时间事件循环照转", async () => {
    useSecretBackend(fakeKeychain(), { timeoutMs: 300 });
    let beats = 0;
    const beat = setInterval(() => { beats += 1; }, 20);
    const t0 = performance.now();
    const err = await readSecret("dafri-llm-api-key", "anthropic").then(() => null, (e: Error) => e);
    clearInterval(beat);
    expect(err).toBeInstanceOf(KeychainTimeoutError);
    expect(err!.message).toContain("没有交出凭证(service=dafri-llm-api-key, account=anthropic)");
    expect(err!.message).toContain("盯盘、托管单与其它功能照常运行");
    expect(performance.now() - t0).toBeGreaterThanOrEqual(280);
    // 同步卡住的话一拍都跳不了;这里 300 毫秒里跳了一串
    expect(beats).toBeGreaterThanOrEqual(5);
  });

  it("同一条凭证同时只读一次(只弹一个窗),后来的调用接着等它;弹窗点完,等着的都拿到值", async () => {
    let answer: (v: string | null) => void = () => undefined;
    const kc = fakeKeychain({
      read: (service, account) => {
        kc.reads.push(`${service}/${account}`);
        return new Promise<string | null>((resolve) => { answer = resolve; });
      },
    });
    useSecretBackend(kc, { timeoutMs: 1_000 });
    const a = readSecret("svc", "acct");
    const b = readSecret("svc", "acct");
    await until(() => kc.reads.length === 1);
    answer("sk-后点的");
    expect(await a).toBe("sk-后点的");
    expect(await b).toBe("sk-后点的");
    expect(kc.reads).toEqual(["svc/acct"]);
  });

  it("调用方放弃之后那次读不撤:用户后来点了允许,下一次调用接着等的就是它", async () => {
    let answer: (v: string | null) => void = () => undefined;
    const kc = fakeKeychain({
      read: (service, account) => {
        kc.reads.push(`${service}/${account}`);
        return new Promise<string | null>((resolve) => { answer = resolve; });
      },
    });
    useSecretBackend(kc, { timeoutMs: 60 });
    await expect(readSecret("svc", "acct")).rejects.toBeInstanceOf(KeychainTimeoutError);
    const retry = readSecret("svc", "acct");
    answer("sk-x");
    expect(await retry).toBe("sk-x");
    expect(kc.reads).toHaveLength(1);
  });

  it("查有没有存过:不解密、答案记住;写过就记成有;查不出来按没存过答、不记", async () => {
    let broken = true;
    const kc = fakeKeychain({
      exists: async (service, account) => {
        kc.checks.push(`${service}/${account}`);
        if (broken) throw new Error("security 退出码 51");
        return false;
      },
      write: async () => undefined,
    });
    useSecretBackend(kc);
    expect(await secretExists("svc", "a")).toBe(false); // 查不出来
    broken = false;
    expect(await secretExists("svc", "a")).toBe(false); // 上一次没记,重新查
    expect(await secretExists("svc", "a")).toBe(false); // 这一次记住了
    expect(kc.checks).toEqual(["svc/a", "svc/a"]);
    await writeSecret("svc", "a", "sk-new");
    expect(await secretExists("svc", "a")).toBe(true);
    expect(kc.checks).toHaveLength(2);
    expect(kc.reads).toEqual([]); // 从头到尾没解密过
  });

  it("读出来的结果也记下「有没有」:读到 null 就是没存过", async () => {
    const kc = fakeKeychain({ read: async () => null });
    useSecretBackend(kc);
    expect(await readSecret("svc", "gone")).toBeNull();
    expect(await secretExists("svc", "gone")).toBe(false);
    expect(kc.checks).toEqual([]);
  });

  it("写入等不到:报错说清楚点了允许之后会自己写完;空密钥当场拒", async () => {
    useSecretBackend(fakeKeychain(), { timeoutMs: 50 });
    const err = await writeSecret("svc", "a", "sk").then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(KeychainTimeoutError);
    expect(err!.message).toMatch(/没有写完凭证.*这次保存会自己完成/);
    await expect(writeSecret("svc", "a", "")).rejects.toThrowError("拒绝写入空密钥");
  });
});

// ---------------------------------------------------------------- RPC:等钥匙的时候交易照常
class FakeRouter {
  SUPPORTS_HOSTED_CLOSE = true;
  SUPPORTS_NATIVE_CONDITIONS = true;
  BROKER = "ibkr";
  upstreamOk = true;
  positionCalls = 0;
  constructor(public rows: Rec[]) {}
  sessions(): unknown[] { return [{}]; }
  connectedNames(): string[] { return ["paper"]; }
  async positions(): Promise<Rec[]> {
    this.positionCalls += 1;
    return this.rows.map((r) => ({ ...r }));
  }
  async indexPrice(): Promise<number | null> { return null; }
  async optionQuotes(): Promise<Rec> { return {}; }
  async listHostedOpen(): Promise<Rec[]> { return []; }
  async legQuotes(): Promise<unknown[]> { return []; }
  async cancelAllOpen(): Promise<number> { return 0; }
  async contractHours(): Promise<null> { return null; }
  cachedContractHours(): null { return null; }
}

const stock = (): Rec => ({
  key: tk.makeKey("模拟", "BE", "STK"), account: "模拟", symbol: "BE", sec_type: "STK", leg: "", quantity: 100,
  avg_cost: 100, multiplier: 1, currency: "USD", market_price: 120, market_value: 12000, unrealized_pnl: 2000,
  contract: { secType: "STK", symbol: "BE" },
});

const servers: RpcServer[] = [];
const dirs: string[] = [];

function makeServer(out: (line: string) => void = () => undefined): RpcServer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-kc-offloop-"));
  dirs.push(dir);
  const base = JSON.parse(fs.readFileSync(path.join(ENGINE, "baseline", "rpc", "base_config.json"), "utf-8"));
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ ...base, storage: { db_path: path.join(dir, "t.db") } }));
  const s = new RpcServer(settingsPath, out);
  servers.push(s);
  return s;
}

afterEach(() => {
  for (const s of servers.splice(0)) {
    s.anomaly.stop();
    s.engineBuilt?.stopTrackerLoop();
  }
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上 sqlite 句柄可能还占着 */
    }
  }
});

describe("RPC:一个请求在等钥匙串,交易照常", () => {
  it("大模型解析在等 API Key:system.status / tracker.list / llm.catalog 照答,盯盘照跑;到点这条指令报 -32008", async () => {
    const kc = fakeKeychain();
    useSecretBackend(kc, { timeoutMs: 1_500 });
    const s = makeServer();
    const router = new FakeRouter([stock()]);
    s.router = router as never;
    const engine = s.engine;
    engine.store.addTrack({
      account: "模拟", symbol: "BE", sec_type: "STK", contract: { secType: "STK", symbol: "BE" },
      targets: { take_profit: 500 }, auto_close: { enabled: false }, peak: 120,
    });
    engine.stopTrackerLoop();
    engine.startTrackerLoop(50);
    const call = (method: string, params: Rec = {}): Promise<Rec> =>
      s.handle({ jsonrpc: "2.0", id: 1, method, params });
    const timed = async (method: string): Promise<{ ms: number; out: Rec }> => {
      const t0 = performance.now();
      const out = await call(method);
      return { ms: performance.now() - t0, out };
    };

    const t0 = performance.now();
    // 本地速记认不出的一句:要交给大模型,大模型要 Key,Key 在等一个没人点的弹窗
    const parsing = call("instruction.submit", { text: "帮我看看明天开盘 BE 怎么做比较好" });
    await until(() => kc.reads.length === 1);
    expect(kc.reads).toEqual(["dafri-llm-api-key/anthropic"]);

    const ticksBefore = Number(engine.trackerHeartbeat()["ticks"]);
    const positionsBefore = router.positionCalls;
    const status = await timed("system.status");
    expect(status.out["error"]).toBeUndefined();
    expect(status.ms).toBeLessThan(500);
    const list = await timed("tracker.list");
    expect(list.out["error"]).toBeUndefined();
    expect(list.ms).toBeLessThan(500);
    const catalog = await timed("llm.catalog");
    expect(catalog.out["result"]["key_configured"]).toEqual({ anthropic: true, openai_compatible: false });
    expect(catalog.ms).toBeLessThan(500);
    const poll = await engine.withTrackerLock(() => engine.pollTrackers());
    expect(poll.rows).toHaveLength(1);
    await sleep(300);
    expect(Number(engine.trackerHeartbeat()["ticks"])).toBeGreaterThan(ticksBefore + 2);
    expect(router.positionCalls).toBeGreaterThan(positionsBefore + 2);

    const out = await parsing;
    expect(performance.now() - t0).toBeGreaterThanOrEqual(1_400);
    expect(out["error"]["code"]).toBe(-32008);
    expect(out["error"]["message"]).toMatch(/秒没有交出凭证\(service=dafri-llm-api-key, account=anthropic\)/);
    // 界面一打开就问的那几样从头到尾没解密过:只读过解析要的那一次
    expect(kc.reads).toEqual(["dafri-llm-api-key/anthropic"]);
    expect(engine.trackerHeartbeat()["running"]).toBe(true);
  });

  it("存 Key 在等弹窗:不占交易道,排在后面的下单请求照常处理", async () => {
    useSecretBackend(fakeKeychain(), { timeoutMs: 400 });
    const answered = new Map<number, { at: number; msg: Rec }>();
    const t0 = performance.now();
    const s = makeServer((line) => {
      const msg = JSON.parse(line);
      if (msg["method"] !== "event") answered.set(msg["id"], { at: performance.now() - t0, msg });
    });
    const input = new PassThrough();
    const done = s.serve(input);
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "keychain.set", params: { secret: "sk-新的" } }) + "\n");
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "instruction.submit", params: { text: "" } }) + "\n");
    input.end();
    await done;
    const submit = answered.get(2)!;
    expect(submit.msg["error"]).toEqual({ code: -32602, message: "指令为空" });
    const set = answered.get(1)!;
    expect(set.at).toBeGreaterThanOrEqual(380);
    // 要证的是下单没有排在存 Key 后面:它比存 Key 先答完。不按绝对毫秒数算——CI 的 Windows 机器起一个 server 就要几百毫秒
    expect(submit.at).toBeLessThan(set.at);
    expect(set.msg["error"]["code"]).toBe(-32008);
    expect(set.msg["error"]["message"]).toMatch(/没有写完凭证.*这次保存会自己完成/);
  });

  it("broker.catalog 查富途解锁密码存没存:不解密", async () => {
    const kc = fakeKeychain();
    useSecretBackend(kc);
    const s = makeServer();
    const out = await s.handle({ jsonrpc: "2.0", id: 1, method: "broker.catalog", params: {} });
    expect(out["result"]["futu"]["unlock_password_saved"]).toBe(false);
    expect(kc.checks).toEqual(["dafri-futu-unlock/futu"]);
    expect(kc.reads).toEqual([]);
  });
});

// ---------------------------------------------------------------- 凭证子进程
// 子进程跑的是编译出来的 keychainChild.js。这里把源码现编进临时目录,不依赖 dist,也不和别的测试抢着编:
//  · real:真的 keychainChild + 真的 keychain(原生凭证库);
//  · stuck:真的 keychainChild + 一个假的 keychain,worker 一进去就卡 20 秒(= 原生调用停在系统弹窗前)。
let realDir = "";
let stuckDir = "";

function transpile(file: string, outDir: string): void {
  const src = fs.readFileSync(path.join(ENGINE, "src", file), "utf-8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
    fileName: file,
  }).outputText;
  fs.writeFileSync(path.join(outDir, file.replace(/\.ts$/, ".js")), js);
}

beforeAll(() => {
  realDir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-kc-child-"));
  stuckDir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-kc-stuck-"));
  for (const dir of [realDir, stuckDir]) {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
    transpile("keychainChild.ts", dir);
  }
  transpile("keychain.ts", realDir);
  fs.symlinkSync(path.join(ENGINE, "node_modules"), path.join(realDir, "node_modules"), "junction");
  // 卡在一个同步的原生调用里(spawnSync 等一个睡 20 秒的进程):和停在系统弹窗前的原生库一样,线程被结束也打断不了它
  fs.writeFileSync(path.join(stuckDir, "keychain.js"), [
    'import { spawnSync } from "node:child_process";',
    'import * as fs from "node:fs";',
    "export function runKeychainRequest() {",
    '  fs.writeFileSync(new URL("./stuck.mark", import.meta.url), "stuck");',
    '  spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 20000)"]);',
    '  return { ok: true, value: "太晚了", exists: true };',
    "}",
    "",
  ].join("\n"));
});

afterAll(() => {
  for (const dir of [realDir, stuckDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 留给系统清 */
    }
  }
});

describe("凭证子进程", () => {
  it("真入口:查一条不存在的凭证 → null(没有系统凭证库的平台如实报错)", async () => {
    const reply = await callKeychainChild(
      { op: "get", service: "dafri-ts-test-offloop", account: "absent" },
      { entry: path.join(realDir, "keychainChild.js") },
    );
    if (isSupported()) expect(reply).toEqual({ ok: true, value: null, exists: false });
    else expect(reply).toMatchObject({ ok: false, error: expect.stringMatching(/没有可用的系统凭证存储/) });
  }, 20_000);

  it("不认识的请求:原话报错,不抛", async () => {
    const entry = path.join(realDir, "keychainChild.js");
    const bad = await callKeychainChild({ op: "drop", service: "s", account: "a" } as never, { entry });
    expect(bad).toEqual({ ok: false, error: "不认识的凭证操作:drop" });
    const missing = await callKeychainChild({ op: "get" } as never, { entry });
    expect(missing).toEqual({ ok: false, error: "凭证请求缺 service / account" });
  }, 20_000);

  it("worker 卡在原生调用里、引擎断开管道:子进程当场结束,不等那 20 秒", async () => {
    fs.rmSync(path.join(stuckDir, "stuck.mark"), { force: true });
    const child = spawn(process.execPath, [path.join(stuckDir, "keychainChild.js")], { stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise<number>((resolve) => child.on("close", () => resolve(performance.now())));
    child.stdin.write(JSON.stringify({ op: "get", service: "s", account: "a" }) + "\n");
    await until(() => fs.existsSync(path.join(stuckDir, "stuck.mark")));
    const t0 = performance.now();
    child.stdin.end(); // = 引擎退出 / 被结束
    expect((await exited) - t0).toBeLessThan(3_000);
  }, 30_000);

  it("到了上限还没结果:父进程把子进程杀掉,报一句没有结果", async () => {
    const t0 = performance.now();
    const err = await callKeychainChild(
      { op: "get", service: "s", account: "a" },
      { entry: path.join(stuckDir, "keychainChild.js"), hardCapMs: 300 },
    ).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/凭证子进程没有给出结果/);
    expect(performance.now() - t0).toBeLessThan(5_000);
  }, 20_000);
});
