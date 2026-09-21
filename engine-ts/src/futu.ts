/** 富途 OpenD 连接检测与诊断(对应 Python futu.py)——tws.ts 的孪生兄弟。
 *
 * 边界不变:本模块不接触任何富途账号密码;登录在 OpenD 自己的窗口里完成。
 * 端口探测与进程检测直接复用 tws.ts 的实现——改了那边的超时策略这边必须
 * 跟着改,共用同一份实现是唯一能保证这一点的方式。
 */
import { spawn, spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

import type { Settings } from "./config.js";
import type { AppStatus, GuideStep, LaunchResult, PortStatus } from "./contract/connection.js";
import type { FutuBridge } from "./futuBridge.js";
import { loadFutuBridge } from "./futuBridge.js";
// FutuUnavailable 住在 futuBridge.ts(桥自己抛它);这里转出,老的 import 路径不变。
export { FutuUnavailable } from "./futuBridge.js";
import { FutuUnavailable } from "./futuBridge.js";
import { redactAccount } from "./store.js";
import {
  Endpoint, PortProber, checkAliasMapping, expandGlob, probePort, processRunning, scanEndpoints,
} from "./tws.js";

/** SDK 缺失/未接线。单独一个类型:它的处理方式和"连不上"完全不同。 */

// OpenD 的两个默认端口。telnet 口只做展示:它是控制台,不是 API 通道。
export const KNOWN_ENDPOINTS: Endpoint[] = [
  { port: 11111, label: "OpenD API", kind: "opend", paper: null },
  { port: 22222, label: "OpenD 控制台(telnet,仅供参考)", kind: "telnet", paper: null },
];

const WIN = os.platform() === "win32";

// 富途和 moomoo 是同一套 OpenD 的两个发行版,装哪个都认。绿色解压包,按常见落点扫。
export const APP_CANDIDATES: Record<string, string[]> = WIN
  ? {
      opend: [
        "C:/FutuOpenD*/FutuOpenD.exe",
        "C:/FutuOpenD*/*/FutuOpenD.exe",
        "C:/Program Files/FutuOpenD*/FutuOpenD.exe",
        "C:/Program Files (x86)/FutuOpenD*/FutuOpenD.exe",
        "D:/FutuOpenD*/FutuOpenD.exe",
        "~/FutuOpenD*/FutuOpenD.exe",
        "~/Desktop/FutuOpenD*/FutuOpenD.exe",
        "~/Downloads/FutuOpenD*/FutuOpenD.exe",
        "C:/moomooOpenD*/moomooOpenD.exe",
        "~/moomooOpenD*/moomooOpenD.exe",
        "~/Downloads/moomooOpenD*/moomooOpenD.exe",
        path.join(process.env["LOCALAPPDATA"] ?? "", "FutuOpenD", "FutuOpenD.exe"),
      ],
    }
  : {
      opend: [
        "/Applications/FutuOpenD.app",
        "/Applications/FutuOpenD*/FutuOpenD",
        "/Applications/moomooOpenD.app",
        "/Applications/moomooOpenD*/moomooOpenD",
        "~/FutuOpenD*/FutuOpenD",
        "~/Downloads/FutuOpenD*/FutuOpenD",
        "~/Downloads/moomooOpenD*/moomooOpenD",
      ],
    };

export const PROCESS_PATTERNS: Record<string, string> = { opend: WIN ? "FutuOpenD.exe" : "FutuOpenD" };
export const ALT_PROCESS_PATTERNS: Record<string, string> = {
  opend: WIN ? "moomooOpenD.exe" : "moomooOpenD",
};

export const APP_NAME = "富途 OpenD";

// ----------------------------------------------------------------------
// 端口与应用检测
// ----------------------------------------------------------------------
export async function scanPorts(
  settings: Settings, host = "127.0.0.1", prober: PortProber = probePort,
): Promise<PortStatus[]> {
  const configured: Record<number, string> = {};
  for (const [name, c] of Object.entries(settings.connectionsFor("futu"))) {
    configured[c.port] = name;
  }
  return scanEndpoints(KNOWN_ENDPOINTS, configured, host, prober);
}

export function detectApps(): AppStatus[] {
  const apps: AppStatus[] = [];
  for (const [key, globs] of Object.entries(APP_CANDIDATES)) {
    const found: string[] = [];
    for (const pattern of globs) if (pattern) found.push(...expandGlob(pattern));
    const running =
      processRunning(PROCESS_PATTERNS[key]!) || processRunning(ALT_PROCESS_PATTERNS[key]!);
    apps.push({ key, name: APP_NAME, installed: found.length > 0, paths: found.slice(0, 5), running });
  }
  return apps;
}

/** 拉起 OpenD。只接受固定键,路径在这一侧解析。 */
export function launchApp(key: string): LaunchResult {
  if (!(key in APP_CANDIDATES)) throw new Error(`只支持拉起 opend,收到:'${key}'`);
  if (os.platform() !== "darwin" && !WIN) {
    throw new Error(`当前平台不支持一键拉起,请手动启动 ${APP_NAME}。`);
  }
  for (const app of detectApps()) {
    if (app["key"] !== key || !(app["paths"] as string[]).length) continue;
    const target = (app["paths"] as string[])[0]!;
    if (WIN) {
      // cwd 设为安装目录:OpenD 按相对路径读 FutuOpenD.xml
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
  throw new Error(`没有找到 ${APP_NAME} 的安装。请先从富途 OpenAPI 官网下载 OpenD 并解压。`);
}

// ----------------------------------------------------------------------
// 错误翻译
// ----------------------------------------------------------------------
export function explainConnectError(
  exc: Error, port: number, portOpen: boolean,
): Record<string, string> {
  const name = exc.name || exc.constructor.name;
  const text = String(exc.message ?? "");
  const lowered = text.toLowerCase();

  if (exc instanceof FutuUnavailable) {
    if ((exc as FutuUnavailable & { code?: string }).code === "bridge_unverified") {
      return { reason: text, hint: "等 TS 侧的富途桥完成真机联调;IBKR 通道照常可用。", code: "bridge_unverified" };
    }
    return { reason: text, hint: "装完 futu-api 后重启引擎再试。", code: "sdk_missing" };
  }
  if ((exc as NodeJS.ErrnoException).code === "ECONNREFUSED" || lowered.includes("refused")) {
    return {
      reason: `端口 ${port} 拒绝连接`,
      hint:
        `OpenD 没在跑,或它的 API 端口不是 ${port}。先启动 OpenD 并完成登录,` +
        "再核对 FutuOpenD.xml 里的 api_port。",
      code: "refused",
    };
  }
  if (lowered.includes("timeout") || name.toLowerCase().includes("timeout")) {
    if (portOpen) {
      return {
        reason: "端口开着,但握手超时",
        hint:
          "OpenD 在跑但没应答。多半是它还没登录成功(界面上会显示" +
          "「未登录」),或者开了协议加密而这里没配密钥。",
        code: "handshake_timeout",
      };
    }
    return {
      reason: "连接超时",
      hint: "确认 OpenD 已启动**并完成登录**。停在登录界面时 API 不会响应。",
      code: "timeout",
    };
  }
  if (lowered.includes("rsa") || lowered.includes("encrypt")) {
    return {
      reason: text || name,
      hint:
        "OpenD 开启了协议加密(RSA),但这里没有配私钥。" +
        "要么在 OpenD 里关掉加密,要么本软件暂不支持加密连接。",
      code: "encrypted",
    };
  }
  return { reason: `${name}: ${text}`, hint: "详见引擎日志。", code: "unknown" };
}

// ----------------------------------------------------------------------
// 握手诊断
// ----------------------------------------------------------------------
export async function diagnose(
  settings: Settings,
  connectionName: string,
  options: { timeoutMs?: number; prober?: PortProber; bridge?: FutuBridge | null } = {},
): Promise<Record<string, any>> {
  const cfg = settings.connectionsFor("futu")[connectionName];
  if (cfg === undefined) {
    throw new Error(`未定义的连接:${connectionName}(这里只在富途连接里查找)`);
  }
  const prober = options.prober ?? probePort;
  const probe = await prober(cfg.host, cfg.port);
  const result: Record<string, any> = {
    connection: connectionName,
    broker: "futu",
    host: cfg.host,
    port: cfg.port,
    port_open: probe.open,
    port_latency_ms: probe.latency_ms,
    connected: false,
    server_version: null,
    server_time: null,
    qot_logined: null,
    trd_logined: null,
    managed_accounts: [],
    accounts: [],
    unmapped_accounts: [],
    unlock_required: false,
    readonly: cfg.readonly,
    error: null,
    hint: null,
  };

  const fail = (exc: Error, portOpen: boolean): Record<string, any> => {
    const detail = explainConnectError(exc, cfg.port, portOpen);
    result["error"] = detail["reason"];
    result["hint"] = detail["hint"];
    result["error_code"] = detail["code"];
    return result;
  };

  if (!probe.open) {
    const err = new Error(probe.error ?? "") as NodeJS.ErrnoException;
    err.code = "ECONNREFUSED";
    return fail(err, false);
  }

  let bridge: FutuBridge;
  try {
    bridge = options.bridge ?? (await loadFutuBridge());
  } catch (exc) {
    return fail(exc as Error, true);
  }

  let quote: any = null;
  let state: any;
  try {
    quote = await bridge.makeQuoteCtx(cfg.host, cfg.port);
    const [ret, data] = await quote.get_global_state();
    if (ret !== bridge.RET_OK) {
      result["error"] = `读取 OpenD 状态失败:${String(data).slice(0, 200)}`;
      result["hint"] = "OpenD 在跑但没能应答。看一眼 OpenD 窗口里的状态行。";
      await closeCtx(quote);
      return result;
    }
    state = data;
  } catch (exc) {
    await closeCtx(quote);
    return fail(exc as Error, true);
  }

  result["connected"] = true;
  state = state !== null && typeof state === "object" ? state : {};
  result["server_version"] = state["server_ver"] ?? null;
  result["server_time"] = readableTime(state["timestamp"] ?? state["local_timestamp"]);
  result["qot_logined"] = asBool(state["qot_logined"]);
  result["trd_logined"] = asBool(state["trd_logined"]);
  result["market_us"] = state["market_us"] ?? null;
  await closeCtx(quote);

  if (result["qot_logined"] === false) {
    result["error"] = "OpenD 已启动,但**行情服务未登录**";
    result["hint"] =
      "在 OpenD 窗口里用你的富途账号登录(或在 FutuOpenD.xml 里配好登录信息后重启它)。";
    return result;
  }

  await probeAccounts(settings, cfg, result, bridge);
  return result;
}

/** 读交易账户列表并核对别名表与 is_paper。 */
async function probeAccounts(
  settings: Settings,
  cfg: { host: string; port: number },
  result: Record<string, any>,
  bridge: FutuBridge,
): Promise<void> {
  const futuCfg = settings.broker.futu;
  let trd: any = null;
  let data: any;
  try {
    trd = await bridge.makeTradeCtx(cfg.host, cfg.port, futuCfg.trd_market, futuCfg.security_firm);
    const [ret, rows] = await trd.get_acc_list();
    if (ret !== bridge.RET_OK) {
      result["hint"] =
        `行情通道正常,但读不到交易账户:${String(rows).slice(0, 200)}。` +
        "多半是 OpenD 的交易服务没登录(需要在 OpenD 里额外做一次交易登录)。";
      await closeCtx(trd);
      return;
    }
    data = rows;
  } catch (exc) {
    // 交易侧失败不该抹掉行情侧已确认的结果
    result["hint"] = `行情通道正常,交易通道打不开:${String((exc as Error).message).slice(0, 200)}`;
    await closeCtx(trd);
    return;
  }

  const [accounts, envs] = accRows(data);
  result["managed_accounts"] = accounts.map(redactAccount);
  // 只核这条连接上的别名(见 checkAliasMapping 的注释:不分连接地核会把别的连接上的别名误报成对不上)
  const [rows, unmapped] = checkAliasMapping(settings, accounts, String(result["connection"]));
  // is_paper 写反不会报错,只会让实盘闸门失效——必须在连接阶段就摆出来
  const envMismatch: string[] = [];
  for (const row of rows) {
    // rows 已经按连接筛过,所以按别名回查(不再靠下标和 settings.accounts 对齐)
    const account = settings.accounts.find((a) => a.alias === row["alias"]);
    if (account === undefined) continue;
    const actual = envs[account.account_id] ?? "";
    row["trd_env"] = actual || null;
    const wanted = account.is_paper ? "SIMULATE" : "REAL";
    row["env_matches"] = !actual ? null : actual === wanted;
    if (actual && actual !== wanted) {
      envMismatch.push(
        `${account.alias}(配置写「${account.is_paper ? "模拟盘" : "实盘"}」,` +
        `富途报「${actual === "SIMULATE" ? "模拟盘" : "实盘"}」)`,
      );
    }
  }
  result["accounts"] = rows;
  result["unmapped_accounts"] = unmapped;
  result["unlock_required"] = settings.accounts.some(
    (a) => !a.is_paper && a.connection === result["connection"],
  );

  if (unmapped.length) {
    result["hint"] =
      `这个会话还能管到 ${unmapped.length} 个没写进别名表的账号(${unmapped.join("、")})。` +
      "没写进表的账号 LLM 永远指不到,这是设计使然;如果你想用它们,请在配置里补别名。";
  }
  if (envMismatch.length) {
    result["error"] =
      `这些账户的 is_paper 和富途报的交易环境对不上:${envMismatch.join("、")}。` +
      "is_paper 决定要不要过实盘闸门,写反了等于把保护关掉——下单会被拒绝。";
    result["hint"] = "请改 config/settings.json 里这些账户的 is_paper。";
    await closeCtx(trd);
    return;
  }

  const missing = rows
    .filter((r) => !r["resolved"] && r["connection"] === result["connection"])
    .map((r) => r["alias"]);
  if (missing.length) {
    result["error"] =
      `别名 ${missing.join("、")} 配的账号不在这条连接可管的账号里,继续下单会落到错误账户。`;
    result["hint"] = "请核对 config/settings.json 里这些别名的 account_id(富途账号是一串数字)。";
  } else if (result["unlock_required"]) {
    result["hint"] =
      (result["hint"] ? result["hint"] + " " : "") +
      "这条连接上有实盘账户:实盘下单前必须先做一次交易解锁(下面的「交易解锁」)。";
  }
  await closeCtx(trd);
}

/** 从账户列表行里取账号与各自的交易环境。拿不到就当成空——诊断不该因取值方式失败。 */
export function accRows(data: unknown): [string[], Record<string, string>] {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
  } catch {
    return [[], {}];
  }
  const accounts: string[] = [];
  const envs: Record<string, string> = {};
  for (const row of rows) {
    const acc = String(row["acc_id"] ?? "").trim();
    if (!acc || acc.toLowerCase() === "nan") continue;
    accounts.push(acc);
    envs[acc] = String(row["trd_env"] ?? "").trim().toUpperCase();
  }
  return [accounts, envs];
}

/** OpenD 回的是 unix 时间戳。原样显示是一串数字,没人看得懂。 */
export function readableTime(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const v = Number(value);
  if (!Number.isFinite(v)) return String(value);
  const d = new Date(v * 1000);
  if (Number.isNaN(d.getTime())) return String(value);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

export function asBool(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes"].includes(text)) return true;
  if (["0", "false", "no", ""].includes(text)) return false;
  return null;
}

export async function closeCtx(ctx: { close(): void | Promise<void> } | null): Promise<void> {
  if (!ctx) return;
  try {
    await ctx.close();
  } catch {
    /* 关不掉也不该盖住真正的结论 */
  }
}

// ----------------------------------------------------------------------
// 指引
// ----------------------------------------------------------------------
export function connectionGuide(settings: Settings): GuideStep[] {
  const ports =
    Object.values(settings.connectionsFor("futu"))
      .map((c) => String(c.port))
      .join("、") || "11111";
  return [
    {
      step: 1,
      title: "下载并解压 OpenD",
      detail:
        "去富途 OpenAPI 官网下载 FutuOpenD(海外版叫 moomooOpenD)。" +
        "它是绿色包,解压到哪都行,但别放在中文或带空格的深层目录里。",
    },
    {
      step: 2,
      title: "启动 OpenD 并登录",
      detail:
        "在 OpenD 自己的窗口里输入富途账号密码(或在 FutuOpenD.xml 里配好)。" +
        "本软件不接触、也不保存你的富途凭证。没登录成功时 API 不会响应。",
    },
    {
      step: 3,
      title: "核对 API 端口",
      detail:
        `OpenD 的 api_port 要和本软件配置里的端口一致(当前配置:${ports})。` +
        "OpenD 默认 11111;改过就同步改这边。",
    },
    {
      step: 4,
      title: "只信任本机",
      detail:
        "OpenD 的 ip 只填 127.0.0.1,不要绑到 0.0.0.0" +
        "(§9.2:API 端口绝不暴露到局域网)。",
    },
    {
      step: 5,
      title: "确认行情权限",
      detail:
        "富途的美股行情要单独开通:LV1 够用报价与 K 线,多档盘口要 LV2," +
        "**期权链还要单独的美股期权行情权限**。没权限时报价为空," +
        "AUTO_MID 定价会直接拒单——这是刻意的,不会拿坏报价去下真单。",
    },
    {
      step: 6,
      title: "知道它做不了什么",
      detail:
        "富途 OpenAPI **不支持美股指数**(SPX / NDX / VIX / RUT):快照、订阅、" +
        "K 线三条路都会回「暂不支持美股指数」。涉及指数的行情、K 线、条件单会被" +
        "明确拒绝,不会静默换成 ETF——点数和乘数都不一样。另外它没有原生条件单," +
        "所有条件单由本软件盯盘,软件关掉就不会触发。",
    },
    {
      step: 7,
      title: "实盘还要交易解锁",
      detail:
        "模拟盘不需要。实盘下单前要用交易密码解锁一次,密码只存 Keychain / DPAPI," +
        "不写配置文件、不进日志。",
    },
    {
      step: 8,
      title: "回到这里点「检测连接」",
      detail:
        "检测会真握手一次并读回账户列表,同时核对账户别名与 is_paper 是否" +
        "对得上真实账号——is_paper 写反等于把实盘闸门关掉,必须在这一步暴露。",
    },
  ];
}
