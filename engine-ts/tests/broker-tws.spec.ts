/** tws.ts 行为测试(移植自 Python test_tws.py)。TCP 探测用真实本机 socket。 */
import * as net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  IBKR_ERROR_HINTS, KNOWN_ENDPOINTS, checkAliasMapping, connectionGuide, detectApps, diagnose,
  explainConnectError, launchApp, probePort, scanPorts,
} from "../src/tws.js";
import { loadGolden, makeSettings } from "./util.js";

const g = loadGolden("config");

let server: net.Server;
let openPort: number;
let closedPort: number;

beforeAll(async () => {
  server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  openPort = (server.address() as net.AddressInfo).port;
  // 找一个刚释放的端口当"关闭端口"
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  closedPort = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("tws: 端口探测与扫描", () => {
  it("探测认出开着的端口(带延迟)", async () => {
    const result = await probePort("127.0.0.1", openPort);
    expect(result.open).toBe(true);
    expect(result.latency_ms).not.toBeNull();
    expect(result.error).toBeNull();
  });

  it("探测认出关着的端口", async () => {
    const result = await probePort("127.0.0.1", closedPort);
    expect(result.open).toBe(false);
    expect(result.error).toBe("端口未监听");
  });

  it("扫描覆盖四个标准端口并标出配置里的连接", async () => {
    const settings = makeSettings(g.base_config);
    const rows = await scanPorts(settings, "127.0.0.1", async () => ({
      open: false, latency_ms: null, error: "端口未监听",
    }));
    expect(rows.map((r) => r["port"])).toEqual(KNOWN_ENDPOINTS.map((e) => e.port));
    const byPort = Object.fromEntries(rows.map((r) => [r["port"], r]));
    expect(byPort[7497]!["configured_as"]).toBe("paper");
    expect(byPort[7496]!["configured_as"]).toBe("live");
    expect(byPort[4001]!["configured_as"]).toBeNull();
  });

  it("配置里的非标准端口也进扫描清单", async () => {
    const settings = makeSettings(g.base_config, {
      connections: { paper: { host: "127.0.0.1", port: 9999, client_id: 11 } },
    });
    const rows = await scanPorts(settings, "127.0.0.1", async () => ({
      open: false, latency_ms: null, error: null,
    }));
    const custom = rows.find((r) => r["port"] === 9999)!;
    expect(custom["kind"]).toBe("custom");
    expect(String(custom["label"])).toContain("paper");
    expect(custom["configured_as"]).toBe("paper");
  });
});

describe("tws: 错误翻译", () => {
  it("拒绝连接 → 指向没启动的 TWS", () => {
    const err = new Error("connection refused") as NodeJS.ErrnoException;
    err.code = "ECONNREFUSED";
    const detail = explainConnectError(err, 7497, false);
    expect(detail["code"]).toBe("refused");
    expect(detail["hint"]).toContain("Socket port");
  });

  it("端口开着但超时 → 指向 API 复选框/确认框", () => {
    for (const err of [new Error("timeout"), Object.assign(new Error(""), { name: "TimeoutError" })]) {
      const detail = explainConnectError(err, 7497, true);
      expect(detail["code"]).toBe("handshake_timeout");
      expect(detail["hint"]).toContain("Enable ActiveX and Socket Clients");
    }
  });

  it("端口关着的超时 → 指向登录", () => {
    const detail = explainConnectError(new Error("timed out? timeout"), 7497, false);
    expect(detail["code"]).toBe("timeout");
    expect(detail["hint"]).toContain("完成登录");
  });

  it("已知 IBKR 错误码有专属提示", () => {
    for (const code of [326, 502, 504]) {
      const detail = explainConnectError(new Error(`API error ${code} happened`), 7497, true);
      expect(detail["code"]).toBe(String(code));
      expect(detail["hint"]).toBe(IBKR_ERROR_HINTS[code]);
    }
  });
});

describe("tws: 别名核对 / 拉起 / 指引", () => {
  it("别名配错账号会被标出", () => {
    const settings = makeSettings(g.base_config);
    const [rows, unmapped] = checkAliasMapping(settings, ["DU7654321", "U9999999"]);
    const byAlias = Object.fromEntries(rows.map((r) => [r["alias"], r]));
    expect(byAlias["模拟"]!["resolved"]).toBe(true);
    expect(byAlias["主账户"]!["resolved"]).toBe(false); // U1234567 不在会话里
    expect(unmapped).toEqual(["U9***999"]); // 会话里多出的账号(掩码)
  });

  it("launch 只接受固定键", () => {
    expect(() => launchApp("evil.exe")).toThrowError(/只支持拉起 tws 或 gateway/);
  });

  it("detect_apps 的输出形状", () => {
    const apps = detectApps();
    expect(apps.map((a) => a["key"]).sort()).toEqual(["gateway", "tws"]);
    for (const app of apps) {
      for (const key of ["name", "installed", "paths", "running"]) expect(key in app).toBe(true);
    }
  });

  it("指引里写着配置里的真实端口", () => {
    const settings = makeSettings(g.base_config);
    const guide = connectionGuide(settings);
    expect(guide.length).toBe(6);
    const portStep = guide.find((s) => String(s["title"]).includes("Socket port"))!;
    expect(String(portStep["detail"])).toContain("7497");
    expect(String(portStep["detail"])).toContain("7496");
  });
});

describe("tws: 诊断", () => {
  it("端口死着时给下一步,而不是抛异常", async () => {
    const settings = makeSettings(g.base_config, {
      connections: {
        paper: { host: "127.0.0.1", port: closedPort, client_id: 11 },
        live: { host: "127.0.0.1", port: 7496, client_id: 12 },
      },
    });
    const result = await diagnose(settings, "paper", { handshake: null });
    expect(result["port_open"]).toBe(false);
    expect(result["connected"]).toBe(false);
    expect(result["error"]).toContain("拒绝连接");
    expect(result["hint"]).toBeTruthy();
  });

  it("未知连接名直接拒", async () => {
    const settings = makeSettings(g.base_config);
    await expect(diagnose(settings, "nope")).rejects.toThrowError(/未定义的连接/);
  });

  it("假握手成功时核对别名与多余账号", async () => {
    const settings = makeSettings(g.base_config);
    const result = await diagnose(settings, "paper", {
      prober: async () => ({ open: true, latency_ms: 1, error: null }),
      handshake: async () => ({
        serverVersion: 176, serverTime: "t", managedAccounts: ["DU7654321", "DU0000001"],
      }),
    });
    expect(result["connected"]).toBe(true);
    expect(result["server_version"]).toBe(176);
    expect(result["managed_accounts"]).toEqual(["DU***321", "DU***001"]);
    expect(result["unmapped_accounts"]).toEqual(["DU***001"]);
    expect(String(result["hint"])).toContain("没写进别名表");
    // 主账户配在 live 连接上,不在本连接的 missing 里 → error 为 null
    expect(result["error"]).toBeNull();
  });

  it("本连接的别名对不上账号时报错", async () => {
    const settings = makeSettings(g.base_config);
    const result = await diagnose(settings, "paper", {
      prober: async () => ({ open: true, latency_ms: 1, error: null }),
      handshake: async () => ({ serverVersion: 176, serverTime: null, managedAccounts: ["DU1111111"] }),
    });
    expect(String(result["error"])).toContain("模拟");
    expect(String(result["error"])).toContain("落到错误账户");
  });
});
