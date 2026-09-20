/** broker.* / tws.* / futu.* 在 RPC 这一层的特征测试:券商接入的选择、连接,与本机网关的探测。
 *
 * golden-rpc 钉了这个域的几句报错(切到没配连接的券商、未定义的连接、md5 校验、非富途不给解锁),但**扫描 / 诊断 / 连接**
 * 那几条走不到:它们要探本机端口、查安装、真连网关。这里把探测与连接都换成假的,钉从 RPC 进来这一段:
 * 回执里界面读的每一个键、诊断失败时那一格降级而不是整次报错、以及"不接触任何券商凭证"这条纪律
 * (回执里不能出现完整账号、不能出现密码)。
 * 全部离线:**不探真端口、不查真进程、不拉起任何程序、不写系统凭证库**。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deleteSecret } from "../src/keychain.js";
import { RpcServer } from "../src/rpc.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, any>;

/** 测试专用的凭证库服务名:默认那个是真应用在用的,查它等于读用户机器上存没存密码。 */
const TEST_KEYCHAIN = "dafri-test-无此服务";

const servers: RpcServer[] = [];
const dirs: string[] = [];

/**
 * 这几处会碰本机,统一换掉。要点:**只换最外面那一层,底下的真逻辑照跑**——
 * `scanPorts` / `diagnose` 本来就收一个探测器参数,所以这里转调真实现、把探测器换成假的,
 * 端口表怎么拼、诊断失败怎么降级,走的还是生产代码。
 *
 * 为什么不直接 mock `probePort`:模块**内部**对它的引用不会被换掉(`scanPorts` 的默认参数在定义时就绑好了),
 * 真探测照样会跑——本机此刻开着什么(4001 这类端口)就会渗进断言,测试成了看环境。这一点是跑出来才发现的。
 */
const CLOSED = async (): Promise<{ open: boolean; latency_ms: number | null; error: string }> =>
  ({ open: false, latency_ms: null, error: "连接被拒绝" });

/** 诊断到这条连接时假装整个抛了(试 handler 的降级)。 */
const THROWS = "会炸的那条";

vi.mock("../src/tws.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/tws.js")>();
  return {
    ...real,
    scanPorts: (settings: never) => real.scanPorts(settings, "127.0.0.1", CLOSED),
    diagnose: (settings: never, name: string) => {
      // 用它试 handler 的降级分支:诊断这一步整个抛了,那一格要照样摆出来
      if (name === THROWS) throw new Error("诊断这一步自己炸了");
      return real.diagnose(settings, name, { prober: CLOSED });
    },
    detectApps: () => [
      { key: "tws", name: "Trader Workstation", installed: true, paths: ["C:/Jts/tws.exe"], running: false },
      { key: "gateway", name: "IB Gateway", installed: false, paths: [], running: false },
    ],
    launchApp: (key: string) => {
      if (key !== "tws" && key !== "gateway") throw new Error(`只支持拉起 tws 或 gateway,收到:'${key}'`);
      return { launched: true, path: `C:/Jts/${key}.exe` };
    },
  };
});
vi.mock("../src/futu.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/futu.js")>();
  return {
    ...real,
    scanPorts: (settings: never) => real.scanPorts(settings, "127.0.0.1", CLOSED),
    detectApps: () => [{ key: "opend", name: "FutuOpenD", installed: false, paths: [], running: false }],
    launchApp: (key: string) => {
      if (key !== "opend") throw new Error(`只支持拉起 opend,收到:'${key}'`);
      throw new Error("没有找到 FutuOpenD 的安装。");
    },
  };
});

/**
 * 每个用例前后都把测试专用的那条凭证删干净。
 * 为什么要这一步:md5 校验那道闸门一旦被改坏(变异验证里就有这么一条),`futu.set_password` 会真的往凭证库写一条。
 * 不清的话,下一次跑 `unlock_password_saved` 就成了 true——一条留在机器上的残留能让后面的测试假通过。
 */
beforeEach(() => {
  try {
    deleteSecret(TEST_KEYCHAIN, "futu");
  } catch {
    /* 没有就没有 */
  }
});

afterEach(() => {
  try {
    deleteSecret(TEST_KEYCHAIN, "futu");
  } catch {
    /* 同上 */
  }
  vi.restoreAllMocks();
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

function makeServer(over: Rec = {}): { s: RpcServer; call: (m: string, p?: Rec) => Promise<Rec> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-conn-rpc-"));
  dirs.push(dir);
  const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({
    ...base,
    // 富途的凭证库服务名换成测试专用的(见 TEST_KEYCHAIN)
    broker: { ...(base["broker"] ?? {}), futu: { ...((base["broker"] ?? {})["futu"] ?? {}), keychain_service: TEST_KEYCHAIN } },
    ...over,
    storage: { db_path: path.join(dir, "t.db") },
  }));
  const s = new RpcServer(settingsPath, () => undefined);
  servers.push(s);
  const call = async (method: string, params: Rec = {}): Promise<Rec> =>
    s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
  return { s, call };
}

describe("broker.catalog", () => {
  it("两家券商各自的连接与账户;账号是打码的,富途只说解锁密码存没存、不回显", async () => {
    const { call } = makeServer();
    const r = (await call("broker.catalog"))["result"];
    expect(Object.keys(r).sort()).toEqual(["connected", "current", "futu", "providers"]);
    expect(r["current"]).toBe("ibkr");
    expect(r["connected"]).toEqual([]); // 没连
    expect(r["providers"].map((p: Rec) => p["key"])).toEqual(["ibkr", "futu"]);
    for (const p of r["providers"]) {
      expect(Object.keys(p).sort()).toEqual(["accounts", "config_snippet", "connections", "current", "key", "label"]);
    }
    const ibkr = r["providers"][0];
    expect(ibkr).toMatchObject({ current: true, label: "盈透证券(IBKR / TWS)" });
    expect(Object.keys(ibkr["connections"]).length).toBeGreaterThan(0);
    for (const c of Object.values(ibkr["connections"])) {
      expect(Object.keys(c as Rec).sort()).toEqual(["client_id", "host", "port"]);
    }
    // 账户:只给别名与打码的账号
    for (const a of ibkr["accounts"]) {
      expect(Object.keys(a).sort()).toEqual(["account_masked", "alias", "connection", "default", "is_paper"]);
      expect(a["account_masked"]).toContain("*");
    }
    // 没配连接的那一家,直接把该抄的配置给出来
    const futu = r["providers"][1];
    expect(futu["accounts"]).toEqual([]);
    expect(typeof futu["config_snippet"]).toBe("string");
    expect(futu["config_snippet"]).toContain("127.0.0.1");
    expect(ibkr["config_snippet"]).toBeNull(); // 配了就不给

    expect(Object.keys(r["futu"]).sort()).toEqual(["security_firm", "symbol_map", "trd_market", "unlock_password_saved"]);
    // 只说存没存(测试用的是一个不存在的服务名,所以确定是 false);绝不回显密码本身
    expect(r["futu"]["unlock_password_saved"]).toBe(false);
  });

  it("整份回执里不出现任何完整账号", async () => {
    const { s, call } = makeServer();
    const raw = JSON.stringify((await call("broker.catalog"))["result"]);
    for (const a of s.settings.accounts) expect(raw).not.toContain(a.account_id);
  });
});

describe("broker.select / disconnect", () => {
  it("切到没配连接的那一家:-32006,并把该抄的配置附上(golden-rpc 钉着)", async () => {
    const { call } = makeServer();
    const err = (await call("broker.select", { provider: "futu" }))["error"];
    expect(err["code"]).toBe(-32006);
    expect(err["message"]).toContain("配置里还没有 富途证券(OpenD) 的连接和账户");
    expect(err["message"]).toContain("127.0.0.1");
  });

  it("不认识的券商:-32602(golden-rpc 钉着)", async () => {
    const { call } = makeServer();
    expect((await call("broker.select", { provider: "schwab" }))["error"]).toEqual({ code: -32602, message: "只支持 ibkr、futu" });
    expect((await call("broker.select", {}))["error"]).toEqual({ code: -32602, message: "只支持 ibkr、futu" });
  });

  it("断开:回执是空的已连列表(没连也不报错)", async () => {
    const { call } = makeServer();
    expect((await call("broker.disconnect"))["result"]).toEqual({ connected: [] });
  });
});

describe("tws.scan / diagnose / launch", () => {
  it("扫描:端口表 + 安装情况 + 连接指引 + 配置里的连接;每一格都说清是哪个端口、开没开", async () => {
    const { call } = makeServer();
    const r = (await call("tws.scan"))["result"];
    expect(Object.keys(r).sort()).toEqual(["apps", "connected", "connections", "guide", "ports"]);
    expect(r["ports"].length).toBeGreaterThan(0);
    for (const p of r["ports"]) {
      expect(Object.keys(p).sort()).toEqual(["configured_as", "error", "kind", "label", "latency_ms", "open", "paper", "port"]);
      expect(p["open"]).toBe(false); // 假探测:一律当成关着
    }
    expect(r["apps"]).toEqual([
      { key: "tws", name: "Trader Workstation", installed: true, paths: ["C:/Jts/tws.exe"], running: false },
      { key: "gateway", name: "IB Gateway", installed: false, paths: [], running: false },
    ]);
    // 配置里那几条连接用的端口,要在表里标出来是哪一条(界面据此显示"配置为模拟 · 已连接")
    const names = Object.keys(r["connections"]);
    expect(names.length).toBeGreaterThan(0);
    const tagged = r["ports"].filter((p: Rec) => p["configured_as"] !== null).map((p: Rec) => p["configured_as"]);
    expect(tagged.sort()).toEqual(names.sort());
    for (const p of r["ports"]) {
      const want = Object.entries(r["connections"]).find(([, c]) => (c as Rec)["port"] === p["port"]);
      expect(p["configured_as"]).toBe(want ? want[0] : null);
    }
    expect(r["guide"].length).toBeGreaterThan(0);
    for (const g of r["guide"]) expect(Object.keys(g).sort()).toEqual(["detail", "step", "title"]);
    expect(r["connected"]).toEqual([]);
  });

  it("诊断:端口没开时这一格给原因与下一步,不抛异常;未定义的连接才报错(golden-rpc 钉着那一句)", async () => {
    const { call } = makeServer();
    const r = (await call("tws.diagnose"))["result"];
    expect(Object.keys(r)).toEqual(["results"]);
    expect(r["results"].length).toBeGreaterThan(0);
    const one = r["results"][0];
    expect(one).toMatchObject({ connected: false, port_open: false });
    expect(typeof one["connection"]).toBe("string");
    expect(typeof one["error"]).toBe("string"); // 端口没开的原因
    expect(one["hint"]).not.toBeNull(); // 下一步该做什么
    // 诊断用的是偏移过的 client_id(别和正在下单的那条抢 ID)
    expect(one["client_id"]).toBeGreaterThan(0);
    expect((await call("tws.diagnose", { connections: ["nope"] }))["error"]).toEqual({
      code: -32602, message: "未定义的连接:nope",
    });
  });

  it("诊断这一步自己抛了:那一格降级成「哪条、没连上、什么错」,不是整次调用失败", async () => {
    const { call } = makeServer({
      connections: { [THROWS]: { broker: "ibkr", host: "127.0.0.1", port: 7497 } },
      accounts: [{ alias: "模拟", account_id: "DU0000000", is_paper: true, connection: THROWS, default: true }],
    });
    const out = await call("tws.diagnose");
    expect(out["error"]).toBeUndefined();
    expect(out["result"]["results"]).toEqual([
      { connection: THROWS, connected: false, error: "诊断这一步自己炸了", hint: null },
    ]);
  });

  it("拉起:只认 tws / gateway 两个键,路径在引擎这一侧解析——界面传不进路径", async () => {
    const { call } = makeServer();
    expect((await call("tws.launch", { app: "tws" }))["result"]).toEqual({ launched: true, path: "C:/Jts/tws.exe" });
    const err = (await call("tws.launch", { app: "C:/别的程序.exe" }))["error"];
    expect(err["code"]).toBe(-32009);
    expect(err["message"]).toContain("只支持拉起 tws 或 gateway");
    // 上面走的是这份文件里的假 launchApp。那道闸门本身是生产代码,这里直接对真函数断言——
    // 真函数在键不对时**先抛、后展开路径**,所以这么试不会拉起任何东西。
    const realTws = await vi.importActual<typeof import("../src/tws.js")>("../src/tws.js");
    expect(() => realTws.launchApp("C:/别的程序.exe")).toThrowError(/只支持拉起 tws 或 gateway/);
    expect(() => realTws.launchApp("")).toThrowError(/只支持拉起 tws 或 gateway/);
    const realFutu = await vi.importActual<typeof import("../src/futu.js")>("../src/futu.js");
    expect(() => realFutu.launchApp("tws")).toThrowError(/只支持拉起 opend/);
  });
});

describe("futu.scan / diagnose / launch", () => {
  it("扫描:比 TWS 多两项——当前是不是走富途、SDK 装没装", async () => {
    const { call } = makeServer();
    const r = (await call("futu.scan"))["result"];
    expect(Object.keys(r).sort()).toEqual(["active", "apps", "connected", "connections", "guide", "ports", "sdk_installed"]);
    expect(r["active"]).toBe(false); // 当前是 ibkr
    expect(typeof r["sdk_installed"]).toBe("boolean");
    expect(r["connections"]).toEqual({}); // 基线配置里没有富途连接
  });

  it("没配富途连接就诊断:让人先去切,而不是给一张空表", async () => {
    const { call } = makeServer();
    expect((await call("futu.diagnose"))["error"]).toEqual({
      code: -32602, message: "配置里还没有任何富途连接。请先在「券商接入」里切到富途。",
    });
  });

  it("拉起 OpenD:没装就报没装(不静默失败);键不认识也报", async () => {
    const { call } = makeServer();
    const notInstalled = (await call("futu.launch"))["error"]; // 不给 app = opend
    expect(notInstalled["code"]).toBe(-32009);
    expect(notInstalled["message"]).toContain("没有找到 FutuOpenD 的安装");
    expect((await call("futu.launch", { app: "tws" }))["error"]["message"]).toContain("只支持拉起 opend");
  });
});

describe("futu.unlock / set_password", () => {
  it("当前不是富途:-32010(golden-rpc 钉着)", async () => {
    const { call } = makeServer();
    expect((await call("futu.unlock"))["error"]).toEqual({ code: -32010, message: "当前券商接入不是富途,无需解锁。" });
  });

  it("存解锁密码:空的拒;勾了「已经是 md5」却不是 32 位十六进制,拒(golden-rpc 钉着)——这两条都在碰凭证库之前", async () => {
    const { call } = makeServer();
    expect((await call("futu.set_password", {}))["error"]).toEqual({ code: -32602, message: "交易解锁密码为空" });
    expect((await call("futu.set_password", { password: "xyz", already_md5: true }))["error"]).toEqual({
      code: -32602, message: "勾了「已经是 md5」,但填的不是 32 位十六进制字符串",
    });
    // 报错里不回显密码本身
    const leaked = (await call("futu.set_password", { password: "我的真密码", already_md5: true }))["error"];
    expect(leaked["message"]).not.toContain("我的真密码");
  });
});
