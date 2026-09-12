/** TWS / IB Gateway 连接检测与诊断(对应 Python tws.py)。
 *
 * 边界不变:本模块不接触任何 IBKR 凭证。只做检测、诊断、拉起三件事。
 * TCP 探测与真握手都是可注入的,离线测试不碰网络。
 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import type { Settings } from "./config.js";
import { redactAccount } from "./store.js";

export interface Endpoint {
  port: number;
  label: string;
  kind: string;
  paper: boolean | null;
}

// IBKR 的四个标准端口。软件不猜用户改过的端口,配置里的会另外并进来。
export const KNOWN_ENDPOINTS: Endpoint[] = [
  { port: 7496, label: "TWS 实盘", kind: "tws", paper: false },
  { port: 7497, label: "TWS 模拟", kind: "tws", paper: true },
  { port: 4001, label: "IB Gateway 实盘", kind: "gateway", paper: false },
  { port: 4002, label: "IB Gateway 模拟", kind: "gateway", paper: true },
];

const WIN = os.platform() === "win32";

export const APP_CANDIDATES: Record<string, string[]> = WIN
  ? {
      tws: [
        "C:/Jts/tws.exe",
        "C:/Jts/*/tws.exe",
        "~/Jts/tws.exe",
        "~/Jts/*/tws.exe",
        path.join(process.env["LOCALAPPDATA"] ?? "", "Jts", "tws.exe"),
      ],
      gateway: [
        "C:/Jts/ibgateway/*/ibgateway.exe",
        "C:/Jts/ibgateway.exe",
        "~/Jts/ibgateway/*/ibgateway.exe",
        path.join(process.env["LOCALAPPDATA"] ?? "", "Jts", "ibgateway", "*", "ibgateway.exe"),
      ],
    }
  : {
      tws: [
        "/Applications/Trader Workstation.app",
        "/Applications/Trader Workstation */Trader Workstation *.app",
        "~/Applications/Trader Workstation.app",
        "~/Applications/Trader Workstation */Trader Workstation *.app",
      ],
      gateway: [
        "/Applications/IB Gateway.app",
        "/Applications/IB Gateway */IB Gateway *.app",
        "~/Applications/IB Gateway.app",
        "~/Applications/IB Gateway */IB Gateway *.app",
      ],
    };

export const PROCESS_PATTERNS: Record<string, string> = WIN
  ? { tws: "tws.exe", gateway: "ibgateway.exe" }
  : { tws: "Trader Workstation", gateway: "ibgateway" };

export interface ProbeResult {
  open: boolean;
  latency_ms: number | null;
  error: string | null;
}

export type PortProber = (host: string, port: number, timeoutMs?: number) => Promise<ProbeResult>;

/** 纯 TCP 探测:只看端口通不通,不发任何 IBKR 协议帧,不打扰已有会话。 */
export function probePort(host = "127.0.0.1", port = 7497, timeoutMs = 600): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = new net.Socket();
    let done = false;
    const finish = (result: ProbeResult): void => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () =>
      finish({ open: true, latency_ms: Math.trunc(performance.now() - started), error: null }),
    );
    socket.once("timeout", () => finish({ open: false, latency_ms: null, error: "连接超时" }));
    socket.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNREFUSED") {
        finish({ open: false, latency_ms: null, error: "端口未监听" });
      } else {
        finish({ open: false, latency_ms: null, error: String(err.message || err) });
      }
    });
    socket.connect(port, host);
  });
}

/** 扫标准端口 + 配置里出现的端口,标出每个端口对应哪条连接。 */
export async function scanPorts(
  settings: Settings, host = "127.0.0.1", prober: PortProber = probePort,
): Promise<Array<Record<string, unknown>>> {
  const configured: Record<number, string> = {};
  for (const [name, c] of Object.entries(settings.connectionsFor("ibkr"))) {
    configured[c.port] = name;
  }
  return scanEndpoints(KNOWN_ENDPOINTS, configured, host, prober);
}

export async function scanEndpoints(
  known: Endpoint[], configured: Record<number, string>, host: string, prober: PortProber,
): Promise<Array<Record<string, unknown>>> {
  const entries: Endpoint[] = known.map((e) => ({ ...e }));
  const knownPorts = new Set(entries.map((e) => e.port));
  for (const port of Object.keys(configured).map(Number).sort((a, b) => a - b)) {
    if (!knownPorts.has(port)) {
      entries.push({
        port, label: `自定义端口(连接 ${configured[port]})`, kind: "custom", paper: null,
      });
    }
  }
  const results: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    const probe = await prober(host, entry.port);
    results.push({
      port: entry.port,
      label: entry.label,
      kind: entry.kind,
      paper: entry.paper,
      open: probe.open,
      latency_ms: probe.latency_ms,
      error: probe.error,
      configured_as: configured[entry.port] ?? null,
    });
  }
  return results;
}

// ----------------------------------------------------------------------
// 应用检测与拉起
// ----------------------------------------------------------------------
/** glob 用 Node 内建 fs.globSync(Node ≥22),不自己实现匹配器。 */
export function expandGlob(pattern: string): string[] {
  let p = pattern;
  if (p.startsWith("~")) p = path.join(os.homedir(), p.slice(1));
  try {
    return (fs.globSync(p) as string[]).filter((m) => fs.existsSync(m)).sort();
  } catch {
    return fs.existsSync(p) ? [p] : [];
  }
}

export function processRunning(pattern: string): boolean {
  if (WIN) {
    try {
      const proc = spawnSync(
        "tasklist", ["/FI", `IMAGENAME eq ${pattern}`, "/NH", "/FO", "CSV"],
        { encoding: "utf-8", timeout: 5000 },
      );
      return proc.status === 0 && (proc.stdout ?? "").toLowerCase().includes(pattern.toLowerCase());
    } catch {
      return false;
    }
  }
  if (os.platform() !== "darwin" && os.platform() !== "linux") return false;
  try {
    const proc = spawnSync("pgrep", ["-f", pattern], { encoding: "utf-8", timeout: 3000 });
    return proc.status === 0 && Boolean((proc.stdout ?? "").trim());
  } catch {
    return false;
  }
}

export function detectApps(
  candidates: Record<string, string[]> = APP_CANDIDATES,
  patterns: Record<string, string> = PROCESS_PATTERNS,
): Array<Record<string, unknown>> {
  const apps: Array<Record<string, unknown>> = [];
  for (const [key, globs] of Object.entries(candidates)) {
    const found: string[] = [];
    for (const pattern of globs) {
      if (pattern) found.push(...expandGlob(pattern));
    }
    apps.push({
      key,
      name: key === "tws" ? "Trader Workstation" : "IB Gateway",
      installed: found.length > 0,
      paths: found.slice(0, 5),
      running: processRunning(patterns[key]!),
    });
  }
  return apps;
}

/** 拉起 TWS / Gateway。只接受固定键,路径在这一侧解析——绝不让界面传路径。 */
export function launchApp(key: string): Record<string, unknown> {
  if (!(key in APP_CANDIDATES)) {
    throw new Error(`只支持拉起 tws 或 gateway,收到:'${key}'`);
  }
  if (os.platform() !== "darwin" && !WIN) {
    throw new Error("当前平台不支持一键拉起,请手动启动 TWS / IB Gateway。");
  }
  for (const app of detectApps()) {
    if (app["key"] !== key || !(app["paths"] as string[]).length) continue;
    const target = (app["paths"] as string[])[0]!;
    if (WIN) {
      // cwd 设为安装目录:TWS 启动器按相对路径找 jars/ 与 jts.ini
      const child = spawn(target, [], { cwd: path.dirname(target), detached: true, stdio: "ignore" });
      child.unref();
    } else {
      const proc = spawnSync("open", ["-a", target], { encoding: "utf-8" });
      if (proc.status !== 0) {
        throw new Error(`启动失败:${(proc.stderr ?? "").trim() || "未知错误"}`);
      }
    }
    return { launched: true, path: target };
  }
  throw new Error(
    `没有找到 ${key === "tws" ? "Trader Workstation" : "IB Gateway"} 的安装。请先从 IBKR 官网下载安装。`,
  );
}

// ----------------------------------------------------------------------
// 握手诊断
// ----------------------------------------------------------------------
export const IBKR_ERROR_HINTS: Record<number, string> = {
  326: "clientId 已被占用。换一个 clientId,或关掉正在用同一 ID 的程序。",
  502: "无法连接到 TWS。多半是 API 没启用:TWS → Configure → API → Settings," +
    "勾上「Enable ActiveX and Socket Clients」,并确认 Socket port 与这里一致。",
  504: "未连接。请确认 TWS 已完成登录(登录界面停着是连不上的)。",
  1100: "与 IBKR 的连接已断开,TWS 正在重连。",
  2110: "与 IBKR 的连接暂时中断,TWS 会自动恢复。",
};

/** 把连接异常翻成"下一步该做什么",而不是把 traceback 甩给用户。 */
export function explainConnectError(
  exc: Error, port: number, portOpen: boolean,
): Record<string, string> {
  // 对应 Python 的 type(exc).__name__:优先 err.name(TimeoutError 等靠它区分)
  const name = exc.name || exc.constructor.name;
  const text = String(exc.message ?? "");

  for (const [code, hint] of Object.entries(IBKR_ERROR_HINTS)) {
    if (text.includes(code)) return { reason: text || name, hint, code };
  }

  const lowered = text.toLowerCase();
  if ((exc as NodeJS.ErrnoException).code === "ECONNREFUSED" || lowered.includes("refused")) {
    return {
      reason: `端口 ${port} 拒绝连接`,
      hint:
        `TWS / IB Gateway 没有在跑,或者它的 API 端口不是 ${port}。` +
        "先启动并登录 TWS,再在 Configure → API → Settings 里核对 Socket port。",
      code: "refused",
    };
  }
  if (lowered.includes("timeout") || name.toLowerCase().includes("timeout")) {
    if (portOpen) {
      return {
        reason: "端口开着,但握手超时",
        hint:
          "程序在跑,API 没放行。两种常见情况:①「Enable ActiveX and Socket Clients」" +
          "没勾;② TWS 弹出了「接受传入连接」的确认框,正等你点「Yes」。",
        code: "handshake_timeout",
      };
    }
    return {
      reason: "连接超时",
      hint: "确认 TWS / IB Gateway 已启动并**完成登录**,停在登录界面时 API 不会响应。",
      code: "timeout",
    };
  }
  return { reason: `${name}: ${text}`, hint: "详见引擎日志。", code: "unknown" };
}

/** 核对别名表和这个会话真正能管的账号。 */
export function checkAliasMapping(
  settings: Settings, managedAccounts: string[],
): [Array<Record<string, unknown>>, string[]] {
  const managed = new Set(managedAccounts.filter(Boolean));
  const rows = settings.accounts.map((account) => ({
    alias: account.alias,
    account_masked: redactAccount(account.account_id),
    is_paper: account.is_paper,
    connection: account.connection,
    resolved: managed.has(account.account_id),
    default: account.default,
  }));
  const configuredIds = new Set(settings.accounts.map((a) => a.account_id));
  const unmapped = [...managed].filter((a) => !configuredIds.has(a)).sort();
  return [rows, unmapped.map(redactAccount)];
}

/** 真握手一次的执行器:连上、读服务器版本与账户列表、立刻断开。可注入假实现。 */
export type IbHandshake = (args: {
  host: string;
  port: number;
  clientId: number;
  timeoutMs: number;
}) => Promise<{ serverVersion: number | null; serverTime: string | null; managedAccounts: string[] }>;

export async function diagnose(
  settings: Settings,
  connectionName: string,
  options: {
    clientId?: number | null;
    timeoutMs?: number;
    prober?: PortProber;
    handshake?: IbHandshake | null;
  } = {},
): Promise<Record<string, any>> {
  const cfg = settings.connectionsFor("ibkr")[connectionName];
  if (cfg === undefined) {
    throw new Error(`未定义的连接:${connectionName}(这里只在 IBKR 连接里查找)`);
  }
  const prober = options.prober ?? probePort;
  const probe = await prober(cfg.host, cfg.port);
  const result: Record<string, any> = {
    connection: connectionName,
    host: cfg.host,
    port: cfg.port,
    port_open: probe.open,
    port_latency_ms: probe.latency_ms,
    connected: false,
    server_version: null,
    server_time: null,
    managed_accounts: [],
    accounts: [],
    unmapped_accounts: [],
    readonly: cfg.readonly,
    // 用一个偏移过的 clientId,避免和正在下单的那条连接抢 ID(IBKR 会报 326)
    client_id: options.clientId ?? cfg.client_id + 90,
    error: null,
    hint: null,
  };

  if (!probe.open) {
    const err = new Error(probe.error ?? "") as NodeJS.ErrnoException;
    err.code = "ECONNREFUSED";
    const detail = explainConnectError(err, cfg.port, false);
    result["error"] = detail["reason"];
    result["hint"] = detail["hint"];
    return result;
  }

  const handshake = options.handshake ?? (await defaultHandshake());
  if (handshake === null) {
    result["error"] = "IBKR SDK(@stoqey/ib)不可用";
    result["hint"] = "在 engine-ts 目录执行 npm install";
    return result;
  }
  let info: Awaited<ReturnType<IbHandshake>>;
  try {
    info = await handshake({
      host: cfg.host,
      port: cfg.port,
      clientId: result["client_id"],
      timeoutMs: options.timeoutMs ?? 8000,
    });
  } catch (exc) {
    const detail = explainConnectError(exc as Error, cfg.port, true);
    result["error"] = detail["reason"];
    result["hint"] = detail["hint"];
    result["error_code"] = detail["code"];
    return result;
  }

  result["connected"] = true;
  result["server_version"] = info.serverVersion;
  result["server_time"] = info.serverTime;
  const accounts = info.managedAccounts;
  result["managed_accounts"] = accounts.map(redactAccount);
  const [rows, unmapped] = checkAliasMapping(settings, accounts);
  result["accounts"] = rows;
  result["unmapped_accounts"] = unmapped;
  if (unmapped.length) {
    result["hint"] =
      `这个会话还能管到 ${unmapped.length} 个没写进别名表的账号(${unmapped.join("、")})。` +
      "没写进表的账号 LLM 永远指不到,这是设计使然;如果你想用它们,请在配置里补别名。";
  }
  const missing = rows
    .filter((r) => !r["resolved"] && r["connection"] === connectionName)
    .map((r) => r["alias"]);
  if (missing.length) {
    result["error"] =
      `别名 ${missing.join("、")} 配的账号不在这条连接可管的账号里,继续下单会落到错误账户。`;
    result["hint"] = "请核对 config/settings.json 里这些别名的 account_id。";
  }
  return result;
}

/** 默认握手实现:IBApiNext 只读连一次,读版本与账户,立刻断开。 */
async function defaultHandshake(): Promise<IbHandshake | null> {
  let mod: any;
  try {
    mod = await import("@stoqey/ib");
  } catch {
    return null;
  }
  const handshake: IbHandshake = ({ host, port, clientId, timeoutMs }) =>
    new Promise((resolve, reject) => {
      const api = new mod.IBApi({ host, port, clientId });
      let settled = false;
      let serverVersion: number | null = null;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            api.disconnect();
          } catch {
            /* ignore */
          }
          reject(new Error("timeout"));
        }
      }, timeoutMs);
      const finish = (accounts: string[]): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const serverTime: string | null = null;
        try {
          serverVersion = api.serverVersion ?? null;
        } catch {
          serverVersion = null;
        }
        try {
          api.disconnect();
        } catch {
          /* ignore */
        }
        resolve({ serverVersion, serverTime, managedAccounts: accounts });
      };
      api.on(mod.EventName.error, (err: Error, code: number) => {
        // 连接级错误才终止;信息型代码(2104 等)忽略
        if (!settled && code >= 500 && code < 600) {
          settled = true;
          clearTimeout(timer);
          try {
            api.disconnect();
          } catch {
            /* ignore */
          }
          reject(new Error(`${code}: ${err?.message ?? err}`));
        }
      });
      api.on(mod.EventName.managedAccounts, (list: string) => {
        finish(String(list ?? "").split(",").map((s) => s.trim()).filter(Boolean));
      });
      api.connect();
      api.reqManagedAccts();
    });
  return handshake;
}

/** 给界面用的分步指引。刻意写死步骤文案,保证和 TWS 的菜单路径一致。 */
export function connectionGuide(settings: Settings): Array<Record<string, unknown>> {
  const ports =
    Object.values(settings.connectionsFor("ibkr"))
      .map((c) => String(c.port))
      .join("、") || "7497";
  return [
    {
      step: 1,
      title: "启动 TWS 或 IB Gateway 并登录",
      detail:
        "在 IBKR 自己的窗口里输入账号密码。本软件不接触、也不保存你的 IBKR 凭证。" +
        "停在登录界面时 API 不会响应。",
    },
    {
      step: 2,
      title: "打开 API 开关",
      detail:
        "TWS:Configure(齿轮)→ API → Settings,勾选「Enable ActiveX and Socket Clients」。" +
        "IB Gateway:Configure → Settings → API → Settings。",
    },
    {
      step: 3,
      title: "核对 Socket port",
      detail:
        `同一页的「Socket port」要和本软件配置里的端口一致(当前配置:${ports})。` +
        "IBKR 默认:TWS 实盘 7496 / 模拟 7497,Gateway 实盘 4001 / 模拟 4002。",
    },
    {
      step: 4,
      title: "只信任本机",
      detail:
        "同一页「Trusted IPs」只留 127.0.0.1,不要勾「Allow connections from localhost only」" +
        "以外的放行(§9.2:API 端口绝不暴露到局域网)。",
    },
    {
      step: 5,
      title: "第一次连接时点「Yes」",
      detail:
        "TWS 会弹出「Accept incoming connection attempt?」,点 Yes。" +
        "不点的话这里会一直显示握手超时。",
    },
    {
      step: 6,
      title: "回到这里点「检测连接」",
      detail: "检测会真握手一次并读回账户列表,同时核对你的账户别名是否对得上真实账号。",
    },
  ];
}
