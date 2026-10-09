/** 配置与市场日历(对应 Python config.py)。
 *
 * 两条硬约束照抄:真实账号只存在于配置与软件层映射中,prompt_account_table()
 * 只吐别名;提示词模板放 prompts/ 带版本号。所有校验错误信息与 Python 版逐字节
 * 一致——黄金对拍直接比字符串。
 */
import * as fsModule from "node:fs";
// 限额与策略开关的形状界面也要用,定义在 contract/settings.ts;这里转出,老的 import 不用改。
export type { Limits, Policies } from "./contract/settings.js";
import type { FollowConfig } from "./contract/follow.js";
import type { LLMConfig } from "./contract/llm.js";
import type { Limits, Policies, RiskBudgetConfig } from "./contract/settings.js";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

import { builtinCalendar, mergeCalendar } from "./marketCalendar.js";
import { pyFloat, pyRepr, truthy } from "./py.js";
import type { ProtectionsConfig } from "./protections.js";
import { BJ, ET, wallParts, weekdayOfDate } from "./tz.js";

export { ET, BJ };

export const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));

// 与 Python 同一份资产:仓库根的 prompts/ 与 config/(engine-ts 的上一级)。
// 从模块所在目录向上找,src/ 与 dist/src/ 两种布局都能落到同一个地方;
// 用目录里一定存在的文件做标记,免得撞上上层某个同名目录。
function findUp(marker: string[], depth = 6): string | null {
  let dir = PACKAGE_ROOT;
  for (let i = 0; i < depth; i++) {
    try {
      // 存在性检查放到 require 时才做会把错误推迟到很晚;这里直接探
      if (require_fs().existsSync(path.join(dir, ...marker))) return dir;
    } catch {
      /* ignore */
    }
    dir = path.dirname(dir);
  }
  return null;
}

function findPromptDir(): string {
  // 打包布局下由外壳显式指定(Electron main 设 DAFRI_PROMPT_DIR)
  const explicit = process.env["DAFRI_PROMPT_DIR"];
  if (explicit && fsModule.existsSync(explicit)) return explicit;
  const root = findUp(["prompts", "system_v1.0.0.md"]);
  return root ? path.join(root, "prompts") : path.resolve(PACKAGE_ROOT, "..", "..", "prompts");
}

function findDefaultConfigPath(): string {
  const root = findUp(["config", "settings.example.json"]);
  return path.join(root ?? path.resolve(PACKAGE_ROOT, "..", ".."), "config", "settings.json");
}

function require_fs(): typeof import("node:fs") {
  return fsModule;
}

export const DEFAULT_PROMPT_DIR = findPromptDir();



export interface AccountConfig {
  alias: string;
  account_id: string;
  is_paper: boolean;
  connection: string;
  default: boolean;
}

export interface ConnectionConfig {
  name: string;
  host: string;
  port: number;
  client_id: number;
  readonly: boolean;
  broker: string;
}

export interface FutuConfig {
  trd_market: string;
  security_firm: string;
  keychain_service: string;
  keychain_account: string;
  symbol_map: Record<string, string>;
}

export interface BrokerConfig {
  provider: string;
  futu: FutuConfig;
  /** 引擎一启动就连券商,连不上的每 30 秒再试(services/brokerLink.ts)。默认开:追踪要全天有效,
   *  不能等人想起来去点「连接」——重启电脑、引擎崩了被拉起来,都是没人在场的时候。 */
  auto_connect: boolean;
}

export interface IndexConfig {
  symbol: string;
  exchange: string;
  daily_trading_class: string;
  monthly_trading_class: string;
  /** 指数只在常规时段计算,夜盘的"现价"是昨收、一动不动,期权却在照常波动。
   * 填了期货代码(SPX → ES),常规时段之外就用"期货现价 − 基差"推算指数现价
   * (见 broker.futuresSpot);空串 = 不推算,夜盘照旧拿到昨收。 */
  futures: string;
  futures_exchange: string;
}

/** 内置的期货映射:只放真机核对过的。别的指数(NDX→NQ、RUT→RTY)在配置里自己填。 */
export const DEFAULT_INDEX_FUTURES: Record<string, [string, string]> = { SPX: ["ES", "CME"] };

// LLMConfig 的定义在契约里(contract/llm.ts):llm.catalog 把它原样交给界面
export type { LLMConfig } from "./contract/llm.js";

/** 供应商目录里 config 校验需要的最小面(完整目录在 providers.ts)。 */
export const PROVIDER_META: Record<string, { needs_base_url: boolean; default_model: string }> = {
  anthropic: { needs_base_url: false, default_model: "claude-opus-5" },
  openai_compatible: { needs_base_url: true, default_model: "" },
};

export class LLMError extends Error {
  /** 端点回的 HTTP 状态码(有的话)。降级判断与界面文案按它走,不再猜错误文字里的数字。 */
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** §9.4:强制 TLS。只给本机放行 http。 */
export function validateBaseUrl(url: string): string {
  url = (url || "").trim().replace(/\/+$/, "");
  if (!url) throw new LLMError("OpenAI 兼容端点必须填 base_url");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new LLMError("base_url 必须以 http(s):// 开头");
  }
  const scheme = parsed.protocol.replace(":", "");
  if (scheme !== "http" && scheme !== "https") {
    throw new LLMError("base_url 必须以 http(s):// 开头");
  }
  const host = (parsed.hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (scheme === "http" && !["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new LLMError(`非本机地址必须用 https(§9.4 强制 TLS),收到:${url}`);
  }
  return url;
}

export interface EtNow {
  /** 时刻 */
  epochMs: number;
  /** 美东日历日 'YYYY-MM-DD' */
  date: string;
  /** 美东当日分钟数(时*60+分,秒并入比较时用 seconds) */
  minutes: number;
  seconds: number;
}

export function etNowFromEpoch(epochMs: number): EtNow {
  const p = wallParts(epochMs, ET);
  return {
    epochMs,
    date: `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`,
    minutes: p.hour * 60 + p.minute,
    seconds: p.hour * 3600 + p.minute * 60 + p.second,
  };
}

// 可注入时钟:契约测试要在固定时刻回放,不然时段相关的输出无法对拍
let clockOverrideMs: number | null = null;

export function setClock(epochMs: number | null): void {
  clockOverrideMs = epochMs;
}

export function nowEt(): EtNow {
  return etNowFromEpoch(clockOverrideMs ?? Date.now());
}

/** 提示词目录里版本号最大的那一版(按 system_vX.Y.Z.md 认,数值比较)。目录读不了、一版都没有时返回 null。 */
export function latestPromptVersion(promptDir: string): string | null {
  let names: string[];
  try {
    names = fsModule.readdirSync(promptDir);
  } catch {
    return null;
  }
  let best: { version: string; rank: number } | null = null;
  for (const name of names) {
    const m = /^system_(v(\d+)\.(\d+)\.(\d+))\.md$/.exec(name);
    if (!m) continue;
    // 三段各不会超过一百万:拼成一个数来比,省得逐段比
    const rank = Number(m[2]) * 1e12 + Number(m[3]) * 1e6 + Number(m[4]);
    if (best === null || rank > best.rank) best = { version: String(m[1]), rank };
  }
  return best?.version ?? null;
}

export class Settings {
  prompt_version = "v1.0.0";
  /** 配置里写的是不是 "latest"(跟着软件带的最新一版走);false = 钉在某一版上 */
  prompt_follows_latest = false;
  prompt_dir: string = DEFAULT_PROMPT_DIR;
  llm!: LLMConfig;
  broker!: BrokerConfig;
  limits!: Limits;
  policies!: Policies;
  protections!: ProtectionsConfig;
  risk_budget!: RiskBudgetConfig;
  follow!: FollowConfig;
  accounts: AccountConfig[] = [];
  connections: Record<string, ConnectionConfig> = {};
  symbol_aliases: Record<string, string> = {};
  index_symbols: Record<string, IndexConfig> = {};
  market_holidays: string[] = [];
  early_close_days: string[] = [];
  db_path: string = path.join(os.homedir(), "Library/Application Support/dafri/trades.db");
  source_path: string | null = null;
  /** 加载时发现的、不致命但必须让用户知道的配置问题(如账户没写 is_paper)。自检与拒单说明读它。 */
  config_warnings: string[] = [];
  /** 没写 is_paper、因此按实盘处理的账户别名(见 paperFlag)。 */
  paper_flag_missing: string[] = [];

  accountByAlias(alias: string): AccountConfig | null {
    if (alias === "DEFAULT") return this.defaultAccount();
    for (const acct of this.accounts) if (acct.alias === alias) return acct;
    return null;
  }

  defaultAccount(): AccountConfig | null {
    for (const acct of this.accounts) if (acct.default) return acct;
    return this.accounts.length ? this.accounts[0]! : null;
  }

  aliasList(): string[] {
    return this.accounts.map((a) => a.alias);
  }

  connectionsFor(provider?: string | null): Record<string, ConnectionConfig> {
    const target = provider || this.broker.provider;
    const out: Record<string, ConnectionConfig> = {};
    for (const [n, c] of Object.entries(this.connections)) if (c.broker === target) out[n] = c;
    return out;
  }

  accountBroker(account: AccountConfig): string {
    const conn = this.connections[account.connection];
    return conn ? conn.broker : "ibkr";
  }

  promptAccountTable(): string {
    const parts: string[] = [];
    for (const acct of this.accounts) {
      const tag = acct.default ? "(默认)" : "";
      const kind = acct.is_paper ? "纸面测试账户" : "实盘账户";
      parts.push(`${acct.alias}=${kind}${tag}`);
    }
    return parts.length ? parts.join(";") : "(未配置账户,只允许 DEFAULT)";
  }

  promptSymbolTable(): string {
    const entries = Object.entries(this.symbol_aliases);
    if (!entries.length) return "(未配置中文别名,所有中文公司名一律拒绝)";
    return entries.map(([k, v]) => `${k}=${v}`).join(";");
  }

  isTradingDay(dateStr: string): boolean {
    if (weekdayOfDate(dateStr) >= 5) return false;
    return !this.market_holidays.includes(dateStr);
  }

  marketStatus(now: EtNow): string {
    if (!this.isTradingDay(now.date)) return "休市";
    const closeMin = this.early_close_days.includes(now.date) ? 13 * 60 : 16 * 60;
    const t = now.seconds;
    if (t < 4 * 3600) return "休市";
    if (t < 9 * 3600 + 30 * 60) return "盘前";
    if (t < closeMin * 60) return "盘中";
    if (t < 20 * 3600) return "盘后";
    return "休市";
  }

  indexConfig(symbol: string): IndexConfig | null {
    return this.index_symbols[symbol.toUpperCase()] ?? null;
  }
}

/**
 * 展开路径开头的 `~`(对应 Python 的 `Path.expanduser()`)。
 *
 * 不展开的后果不是报错,是**静悄悄写到别的地方**:Node 会把 `~` 当成一个普通目录名,
 * 相对当前工作目录建出来。配置里写着 `~/Library/Application Support/dafri/trades.db`
 * 时,Python 引擎打开的是家目录那份,TS 引擎打开的是 `<cwd>/~/Library/...` 那份——
 * 同一份配置、两个库,切换引擎时交易记录、追踪、想法全部"消失"。
 * (2026-09-04 实测:项目根目录下真的多出了一个叫 `~` 的文件夹,里面 WAL 有 1.5MB。)
 */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** `marketStatus` 之外的第三种答案:合约在交易,但不在流动性时段(盘外/隔夜)。 */
export const STATUS_OPEN = "盘中";
export const STATUS_OUTSIDE = "盘外";
export const STATUS_CLOSED = "休市";

/**
 * 把 IBKR `contractDetails.tradingHours` 拆成 [开始, 结束] 的**朴素**分钟数对。
 *
 * 格式:`20260903:1915-20260904:0825;20260904:0830-20260904:1500;20260905:CLOSED`。
 * 时刻是合约自己的时区(timeZoneId,SPX 期权是 US/Central),这里不做时区换算——
 * 换算交给调用方。返回值用"自纪元的朴素分钟"排序比较,避免再引一个日期库。
 */
export function parseTradingHours(spec: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const toNaive = (day: string, hhmm: string): number | null => {
    if (!/^\d{8}$/.test(day) || !/^\d{4}$/.test(hhmm)) return null;
    const y = Number(day.slice(0, 4)), mo = Number(day.slice(4, 6)), d = Number(day.slice(6, 8));
    const h = Number(hhmm.slice(0, 2)), mi = Number(hhmm.slice(2, 4));
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
    return Math.floor(Date.UTC(y, mo - 1, d, h, mi) / 60000);   // UTC 只是当"朴素"用
  };
  for (const raw of (spec ?? "").split(";")) {
    const chunk = raw.trim();
    if (!chunk || chunk.endsWith(":CLOSED")) continue;
    const dash = chunk.indexOf("-");
    if (dash < 0) continue;
    const startRaw = chunk.slice(0, dash).trim(), endRaw = chunk.slice(dash + 1).trim();
    const [sDay, sTime] = startRaw.split(":");
    if (!sDay || !sTime) continue;
    const start = toNaive(sDay, sTime);
    const end = endRaw.includes(":")
      ? toNaive(endRaw.split(":")[0]!, endRaw.split(":")[1]!)
      : toNaive(sDay, endRaw);              // 少数交易所只给结束时刻,当作同一天
    if (start === null || end === null || end <= start) continue;
    out.push([start, end]);
  }
  return out;
}

/**
 * 按合约自己的交易时段判断此刻能不能交易。
 *
 * 这条路存在的原因:`Settings.marketStatus` 是照**美股正股**写死的
 * (4:00 盘前 / 9:30 盘中 / 16:00 盘后 / 20:00 休市),而 SPX 期权不是那个时段——
 * IBKR 报的 SPXW 是 `20:15–次日 09:25`(隔夜)加 `09:30–16:00`(常规,美东)。
 * 拿正股的表去判期权,0DTE 蝶在隔夜那一整段会被当成"休市",追踪止盈完全不设防。
 *
 * 拿不到时段表时返回空串,让调用方退回正股那套。
 */
export function hoursStatus(
  spec: string, tzId: string, epochMs: number, liquid?: string | null,
): string {
  if (!spec || !tzId) return "";
  let local: number;
  try {
    const w = wallParts(epochMs, tzId);
    local = Math.floor(Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) / 60000);
  } catch {
    return "";                              // 认不出的时区不猜,退回正股表
  }
  const windows = parseTradingHours(spec);
  if (!windows.length) return STATUS_CLOSED;
  if (!windows.some(([a, b]) => local >= a && local < b)) return STATUS_CLOSED;
  const liquidWindows = parseTradingHours(liquid ?? "");
  if (liquidWindows.length && !liquidWindows.some(([a, b]) => local >= a && local < b)) {
    return STATUS_OUTSIDE;
  }
  return STATUS_OPEN;
}

// ---------------------------------------------------------------- 构建与校验
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const CLOSED_MARKET_POLICIES = ["allow", "reject_market_orders", "reject_all"];
export const BROKER_PROVIDERS = ["ibkr", "futu"] as const;
export const DEFAULT_BROKER_PORT: Record<string, number> = { ibkr: 7497, futu: 11111 };
const FUTU_MARKETS = ["US", "HK", "CN"];
const FUTU_FIRMS = ["FUTUSECURITIES", "FUTUINC", "FUTUSG", "FUTUAU", "FUTUCA", "FUTUJP", "FUTUMY"];

type Raw = Record<string, unknown>;

function rejectUnknown(known: string[], raw: Raw, label: string): void {
  const unknown = Object.keys(raw).filter((k) => !known.includes(k)).sort();
  if (unknown.length) {
    throw new Error(`${label} 里有未知配置项:${unknown.join(", ")}`);
  }
}

interface NumOpts {
  min?: number;
  minStr?: string;
  max?: number;
  maxStr?: string;
}

function num(
  raw: Raw, key: string, kind: "int" | "float", dflt: number | null, label: string,
  opts: NumOpts = {},
): number | null {
  if (!(key in raw)) return dflt;
  const value = raw[key];
  if (typeof value === "boolean" || (typeof value !== "number" && typeof value !== "string")) {
    throw new Error(`${label}.${key} 必须是数字,收到 ${pyRepr(value)}`);
  }
  let out: number;
  if (typeof value === "string") {
    const t = value.trim();
    const okInt = /^[+-]?\d+$/.test(t);
    const okFloat = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t);
    if (kind === "int" ? !okInt : !okFloat) {
      throw new Error(`${label}.${key} 必须是数字,收到 ${pyRepr(raw[key])}`);
    }
    out = Number(t);
  } else {
    out = kind === "int" ? Math.trunc(value) : value;
  }
  const show = (v: number) => (kind === "float" ? pyFloat(v) : String(v));
  if (opts.min !== undefined && out < opts.min) {
    throw new Error(`${label}.${key} 不能小于 ${opts.minStr ?? String(opts.min)}(收到 ${show(out)})`);
  }
  if (opts.max !== undefined && out > opts.max) {
    throw new Error(`${label}.${key} 不能大于 ${opts.maxStr ?? String(opts.max)}(收到 ${show(out)})`);
  }
  return out;
}

function flag(raw: Raw, key: string, dflt: boolean, label: string): boolean {
  if (!(key in raw)) return dflt;
  const value = raw[key];
  // 故意不接受 "true"/"1":这几个开关误判会直接下单
  if (typeof value !== "boolean") {
    throw new Error(`${label}.${key} 必须是 true/false,收到 ${pyRepr(value)}`);
  }
  return value;
}

// 保护规则(见 protections.ts):四条各自一个小节,全部默认关闭。
// 这里的错误文案与 limits / policies 同格式——它们逐字节进黄金基线。
const PROTECTION_KEYS = ["stoploss_guard", "max_drawdown", "cooldown", "daily_loss"];
const STOPLOSS_GUARD_KEYS = ["enabled", "lookback_minutes", "trigger_count", "pause_minutes"];
const MAX_DRAWDOWN_KEYS = ["enabled", "lookback_minutes", "max_drawdown_usd", "pause_minutes"];
const COOLDOWN_KEYS = ["enabled", "minutes"];
const DAILY_LOSS_KEYS = ["enabled", "max_loss_usd"];

function buildProtections(raw: Raw): ProtectionsConfig {
  rejectUnknown(PROTECTION_KEYS, raw, "protections");
  const guard = (raw["stoploss_guard"] as Raw) ?? {};
  const dd = (raw["max_drawdown"] as Raw) ?? {};
  const cool = (raw["cooldown"] as Raw) ?? {};
  const daily = (raw["daily_loss"] as Raw) ?? {};
  rejectUnknown(STOPLOSS_GUARD_KEYS, guard, "protections.stoploss_guard");
  rejectUnknown(MAX_DRAWDOWN_KEYS, dd, "protections.max_drawdown");
  rejectUnknown(COOLDOWN_KEYS, cool, "protections.cooldown");
  rejectUnknown(DAILY_LOSS_KEYS, daily, "protections.daily_loss");
  const one = 1;
  return {
    stoploss_guard: {
      enabled: flag(guard, "enabled", false, "protections.stoploss_guard"),
      lookback_minutes: num(guard, "lookback_minutes", "int", 120, "protections.stoploss_guard", { min: one, minStr: "1" })!,
      trigger_count: num(guard, "trigger_count", "int", 3, "protections.stoploss_guard", { min: one, minStr: "1" })!,
      pause_minutes: num(guard, "pause_minutes", "int", 60, "protections.stoploss_guard", { min: one, minStr: "1" })!,
    },
    max_drawdown: {
      enabled: flag(dd, "enabled", false, "protections.max_drawdown"),
      lookback_minutes: num(dd, "lookback_minutes", "int", 1440, "protections.max_drawdown", { min: one, minStr: "1" })!,
      max_drawdown_usd: num(dd, "max_drawdown_usd", "float", 500.0, "protections.max_drawdown", { min: 0.0, minStr: "0.0" })!,
      pause_minutes: num(dd, "pause_minutes", "int", 120, "protections.max_drawdown", { min: one, minStr: "1" })!,
    },
    cooldown: {
      enabled: flag(cool, "enabled", false, "protections.cooldown"),
      minutes: num(cool, "minutes", "int", 30, "protections.cooldown", { min: one, minStr: "1" })!,
    },
    daily_loss: {
      enabled: flag(daily, "enabled", false, "protections.daily_loss"),
      max_loss_usd: num(daily, "max_loss_usd", "float", 500.0, "protections.daily_loss", { min: 0.0, minStr: "0.0" })!,
    },
  };
}

// 单笔风险预算(见 riskBudget.ts):只告警、不拦单,默认关。权益按账户别名填;写了不认识的别名不报错(账户可能刚改名),只是用不上。
const RISK_BUDGET_KEYS = ["enabled", "equity_usd", "max_risk_pct", "max_position_pct"];

function buildRiskBudget(raw: Raw): RiskBudgetConfig {
  rejectUnknown(RISK_BUDGET_KEYS, raw, "risk_budget");
  const equityRaw = raw["equity_usd"] ?? {};
  if (equityRaw === null || typeof equityRaw !== "object" || Array.isArray(equityRaw)) {
    throw new Error(`risk_budget.equity_usd 必须是 {账户别名: 金额},收到 ${pyRepr(equityRaw)}`);
  }
  const equity: Record<string, number> = {};
  for (const alias of Object.keys(equityRaw as Raw)) {
    equity[alias] = num(equityRaw as Raw, alias, "float", 0, "risk_budget.equity_usd", { min: 0.0, minStr: "0.0" })!;
  }
  return {
    enabled: flag(raw, "enabled", false, "risk_budget"),
    equity_usd: equity,
    max_risk_pct: num(raw, "max_risk_pct", "float", 2.0, "risk_budget", { min: 0.1, minStr: "0.1", max: 100, maxStr: "100" })!,
    max_position_pct: num(raw, "max_position_pct", "float", 25.0, "risk_budget", { min: 0.1, minStr: "0.1", max: 1000, maxStr: "1000" })!,
  };
}

// Discord 跟单(见 follow.ts 与 services/follow.ts):默认关、默认不连 Discord。
// 这里只查形状与范围。「开着却没填频道 / 没填信任的人」不算配置错:没频道就不连,没人可信就一条都不跟——
// 配置读不进来的后果是引擎起不来、持仓没人盯,不值得为一段跟单配置冒这个险。账户别名同理(账户可能刚改名),发单那一刻再核对。
const FOLLOW_KEYS = ["enabled", "channel_id", "author_ids", "accounts", "max_age_seconds", "max_orders_per_day", "max_risk_usd", "local_inbox", "local_channel"];
/** Discord 的 ID(snowflake):一串数字。超过了 JSON 数字能精确表示的范围,所以必须写成字符串。 */
const DISCORD_ID = /^\d{15,21}$/;

function discordId(value: unknown, label: string): string {
  if (typeof value !== "string" || !DISCORD_ID.test(value.trim())) {
    throw new Error(`${label} 必须是带引号的 Discord ID(15–21 位数字),收到 ${pyRepr(value)}`);
  }
  return value.trim();
}

/** 本地收件的发送者:`local:` 加屏幕上的显示名(1–80 字,不含换行)。和 followInbox.ts 的 localAuthorId 同一个口径。 */
export const LOCAL_AUTHOR = /^local:[^\r\n]{1,80}$/;

/** 本地收件读哪个频道:窗口标题里的那个名字,最多 100 字、不含换行(和 followReader.ts 的 CHANNEL_NAME_MAX 一致);空 = 不自动启动。 */
function localChannel(value: unknown): string {
  if (typeof value !== "string" || /[\r\n]/.test(value) || value.trim().length > 100) {
    throw new Error(`follow.local_channel 必须是不超过 100 字、不含换行的频道名,收到 ${pyRepr(value)}`);
  }
  return value.trim();
}

/** 信任名单里的一项:Discord 的用户 / webhook ID,或本地收件的显示名。 */
function followAuthor(value: unknown, label: string): string {
  if (typeof value === "string" && LOCAL_AUTHOR.test(value.trim())) return value.trim();
  return discordId(value, label);
}

function stringList(raw: Raw, key: string, label: string): unknown[] {
  const value = raw[key] ?? [];
  if (!Array.isArray(value)) throw new Error(`${label}.${key} 必须是数组,收到 ${pyRepr(value)}`);
  return value;
}

function buildFollow(raw: Raw): FollowConfig {
  rejectUnknown(FOLLOW_KEYS, raw, "follow");
  const channel = raw["channel_id"] ?? "";
  const authors = stringList(raw, "author_ids", "follow").map((v, i) => followAuthor(v, `follow.author_ids[${i}]`));
  const accounts = stringList(raw, "accounts", "follow").map((v, i) => {
    if (typeof v !== "string" || !v.trim()) throw new Error(`follow.accounts[${i}] 必须是账户别名,收到 ${pyRepr(v)}`);
    return v.trim();
  });
  return {
    enabled: flag(raw, "enabled", false, "follow"),
    channel_id: channel === "" ? "" : discordId(channel, "follow.channel_id"),
    author_ids: [...new Set(authors)],
    accounts: [...new Set(accounts)],
    max_age_seconds: num(raw, "max_age_seconds", "int", 30, "follow", { min: 1, max: 600 })!,
    max_orders_per_day: num(raw, "max_orders_per_day", "int", 3, "follow", { min: 1, max: 100 })!,
    max_risk_usd: num(raw, "max_risk_usd", "float", 300.0, "follow", { min: 1.0, minStr: "1.0" })!,
    local_inbox: flag(raw, "local_inbox", false, "follow"),
    local_channel: localChannel(raw["local_channel"] ?? ""),
  };
}

const LIMIT_KEYS = [
  "max_order_notional", "max_option_contracts", "max_mkt_shares", "min_confidence",
  "max_spread_slippage", "max_orders_per_input", "duplicate_window_minutes",
  "duplicate_qty_tolerance",
];

function buildLimits(raw: Raw): Limits {
  rejectUnknown(LIMIT_KEYS, raw, "limits");
  return {
    max_order_notional: num(raw, "max_order_notional", "float", 5000.0, "limits", { min: 0.01, minStr: "0.01" })!,
    max_option_contracts: num(raw, "max_option_contracts", "int", 5, "limits", { min: 1, minStr: "1" })!,
    max_mkt_shares: num(raw, "max_mkt_shares", "int", 200, "limits", { min: 1, minStr: "1" })!,
    min_confidence: num(raw, "min_confidence", "float", 0.9, "limits", { min: 0.0, minStr: "0.0", max: 1.0, maxStr: "1.0" })!,
    max_spread_slippage: num(raw, "max_spread_slippage", "float", 0.10, "limits", { min: 0.0, minStr: "0.0" })!,
    max_orders_per_input: num(raw, "max_orders_per_input", "int", 5, "limits", { min: 1, minStr: "1" })!,
    duplicate_window_minutes: num(raw, "duplicate_window_minutes", "int", 10, "limits", { min: 0, minStr: "0" })!,
    duplicate_qty_tolerance: num(raw, "duplicate_qty_tolerance", "float", 0.2, "limits", { min: 0.0, minStr: "0.0" })!,
  };
}

const POLICY_KEYS = [
  "auto_execute", "allow_live_trading", "auto_outside_rth",
  "require_trigger_price_verification",
  "trigger_min_gap_bps", "closed_market_policy", "consecutive_failure_breaker",
  "review_feature_enabled",
  // 已撤掉的开关:老配置里还写着,认下、不用。当未知项拒掉的话,升级完第一次启动就起不来
  "allow_combo_live",
];

function buildPolicies(raw: Raw): Policies {
  rejectUnknown(POLICY_KEYS, raw, "policies");
  const policy = (raw["closed_market_policy"] ?? "reject_market_orders") as string;
  if (!CLOSED_MARKET_POLICIES.includes(policy)) {
    throw new Error(
      `policies.closed_market_policy 只能是 ${[...CLOSED_MARKET_POLICIES].sort().join("、")}`,
    );
  }
  return {
    auto_execute: flag(raw, "auto_execute", false, "policies"),
    allow_live_trading: flag(raw, "allow_live_trading", false, "policies"),
    auto_outside_rth: flag(raw, "auto_outside_rth", true, "policies"),
    require_trigger_price_verification: flag(raw, "require_trigger_price_verification", true, "policies"),
    trigger_min_gap_bps: num(raw, "trigger_min_gap_bps", "float", 5.0, "policies", { min: 0.0, minStr: "0.0" })!,
    closed_market_policy: policy,
    consecutive_failure_breaker: num(raw, "consecutive_failure_breaker", "int", 3, "policies", { min: 1, minStr: "1" })!,
    review_feature_enabled: flag(raw, "review_feature_enabled", false, "policies"),
  };
}

const LLM_KEYS = [
  "provider", "model", "effort", "temperature", "base_url", "max_tokens", "timeout_s",
  "keychain_service", "keychain_account",
];

function buildLlm(raw: Raw): LLMConfig {
  rejectUnknown(LLM_KEYS, raw, "llm");
  const effort = (raw["effort"] ?? "high") as string;
  if (!EFFORT_LEVELS.includes(effort)) {
    throw new Error(`llm.effort 只能是 ${[...EFFORT_LEVELS].sort().join("、")}`);
  }
  let temperature: number | null = null;
  if (raw["temperature"] !== null && raw["temperature"] !== undefined) {
    temperature = num(raw, "temperature", "float", null, "llm", {
      min: 0.0, minStr: "0.0", max: 2.0, maxStr: "2.0",
    });
  }
  const provider = String(raw["provider"] ?? "anthropic");
  if (!(provider in PROVIDER_META)) {
    throw new Error(`llm.provider 只能是 ${Object.keys(PROVIDER_META).sort().join("、")}`);
  }
  let baseUrl = String(raw["base_url"] ?? "");
  if (PROVIDER_META[provider]!.needs_base_url) {
    try {
      baseUrl = validateBaseUrl(baseUrl);
    } catch (exc) {
      throw new Error(`llm.base_url:${(exc as Error).message}`, { cause: exc });
    }
  }
  const model = String(raw["model"] ?? "") || PROVIDER_META[provider]!.default_model;
  if (!model) {
    throw new Error("llm.model 不能为空:请在「大模型」面板里选择或填写模型标识");
  }
  return {
    provider,
    model,
    effort,
    temperature,
    base_url: baseUrl,
    max_tokens: num(raw, "max_tokens", "int", 8000, "llm", { min: 1000, minStr: "1000" })!,
    timeout_s: num(raw, "timeout_s", "float", 60.0, "llm", { min: 1.0, minStr: "1.0" })!,
    keychain_service: String(raw["keychain_service"] ?? "dafri-llm-api-key"),
    keychain_account: String(raw["keychain_account"] ?? "") || provider,
  };
}

const FUTU_KEYS = ["trd_market", "security_firm", "keychain_service", "keychain_account", "symbol_map"];

function buildFutu(raw: Raw): FutuConfig {
  rejectUnknown(FUTU_KEYS, raw, "broker.futu");
  const market = String(raw["trd_market"] ?? "US").toUpperCase();
  if (!FUTU_MARKETS.includes(market)) {
    throw new Error(`broker.futu.trd_market 只能是 ${[...FUTU_MARKETS].sort().join("、")}`);
  }
  const firm = String(raw["security_firm"] ?? "FUTUSECURITIES").toUpperCase();
  if (!FUTU_FIRMS.includes(firm)) {
    throw new Error(`broker.futu.security_firm 只能是 ${[...FUTU_FIRMS].sort().join("、")}`);
  }
  const symbolMap: Record<string, string> = {};
  for (const [key, value] of Object.entries((raw["symbol_map"] as Raw) ?? {})) {
    const code = String(value).trim();
    if (!code) throw new Error(`broker.futu.symbol_map 里 ${key} 的富途代码为空`);
    symbolMap[String(key).trim().toUpperCase()] = code;
  }
  return {
    trd_market: market,
    security_firm: firm,
    keychain_service: String(raw["keychain_service"] ?? "dafri-futu-unlock"),
    keychain_account: String(raw["keychain_account"] ?? "") || "futu",
    symbol_map: symbolMap,
  };
}

function buildBroker(raw: Raw): BrokerConfig {
  rejectUnknown(["provider", "futu", "auto_connect"], raw, "broker");
  const provider = String(raw["provider"] ?? "ibkr");
  if (!(BROKER_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`broker.provider 只能是 ${BROKER_PROVIDERS.join("、")}`);
  }
  const autoConnect = raw["auto_connect"] ?? true;
  if (typeof autoConnect !== "boolean") throw new Error("broker.auto_connect 只能是 true 或 false");
  return { provider, futu: buildFutu((raw["futu"] as Raw) ?? {}), auto_connect: autoConnect };
}

function buildConnection(name: string, raw: Raw): ConnectionConfig {
  const broker = String(raw["broker"] ?? "ibkr");
  if (!(BROKER_PROVIDERS as readonly string[]).includes(broker)) {
    throw new Error(
      `连接 ${name} 的 broker 只能是 ${BROKER_PROVIDERS.join("、")}(收到 ${pyRepr(broker)})`,
    );
  }
  return {
    name,
    host: String(raw["host"] ?? "127.0.0.1"),
    port: Math.trunc(Number(raw["port"] ?? DEFAULT_BROKER_PORT[broker]!)),
    client_id: Math.trunc(Number(raw["client_id"] ?? 11)),
    readonly: truthy(raw["readonly"] ?? false),
    broker,
  };
}

function assertUniqueAliases(accounts: AccountConfig[]): void {
  const seen = new Set<string>();
  let defaults = 0;
  for (const a of accounts) {
    if (seen.has(a.alias)) throw new Error(`账户别名重复:${a.alias}`);
    if (a.alias === "DEFAULT") throw new Error("别名不得叫 DEFAULT(保留字)");
    seen.add(a.alias);
    defaults += a.default ? 1 : 0;
  }
  if (accounts.length && defaults !== 1) {
    throw new Error(`必须且只能有一个账户标记 default=true(当前 ${defaults} 个)`);
  }
}

function assertAccountConnections(settings: Settings): void {
  for (const acct of settings.accounts) {
    if (!(acct.connection in settings.connections)) {
      throw new Error(`账户 ${acct.alias} 指向未定义的连接 ${acct.connection}`);
    }
  }
  if (Object.keys(settings.connections).length && !Object.keys(settings.connectionsFor()).length) {
    const p = settings.broker.provider;
    throw new Error(
      `broker.provider=${p},但 connections 里没有任何 broker="${p}" 的连接。` +
      `请先在配置里加一条(富途 OpenD 默认端口 ${DEFAULT_BROKER_PORT[p]})。`,
    );
  }
}

/**
 * is_paper 是人填的,而它决定要不要过实盘闸门——把实盘账号标成纸面,那道闸对它就失效了。
 * IBKR 的模拟账号都以 D 开头(DU / DF…),实盘账号以 U / F / I 开头:账号长得像实盘、却标成了纸面的,
 * **按实盘处理**并留一条提醒(失败朝安全的一侧;最坏的结果是一个真的纸面账户多过一道闸)。
 * 只管走 IBKR 的账户;富途的账号是纯数字,从样子上分不出来。
 */
function livePaperMismatches(settings: Settings): string[] {
  const out: string[] = [];
  for (const acct of settings.accounts) {
    if (!acct.is_paper || settings.accountBroker(acct) !== "ibkr") continue;
    if (/^D/i.test(acct.account_id)) continue;
    acct.is_paper = false;
    out.push(
      `账户 ${acct.alias} 标的是纸面账户,但账号不是 IBKR 模拟账号的样子(模拟账号以 D 开头),已按实盘账户处理` +
      "(下单要过「允许实盘账户下单」这道闸)。如果它确实是模拟账户,请核对账号有没有填错。",
    );
  }
  return out;
}

/**
 * 账户的 is_paper。它决定要不要过实盘闸门(allow_live_trading),所以两件事必须对:
 * · 没写 = **按实盘处理**(失败朝安全的一侧)。以前没写默认 true,把实盘账号照抄进纸面模板、
 *   漏了这一行,实盘闸门就对它失效;
 * · 字符串只认 "true" / "false"(不分大小写)。以前走 truthy,"false" 是非空字符串 → 当成 true。
 * 其它值(1、"yes"、"")说不清,直接报错,和 policies 的开关同一个态度。
 */
function paperFlag(a: Raw): boolean | null {
  if (!("is_paper" in a) || a["is_paper"] === null || a["is_paper"] === undefined) return null;
  const value = a["is_paper"];
  if (typeof value === "boolean") return value;
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (text === "true") return true;
  if (text === "false") return false;
  throw new Error(
    `账户 ${String(a["alias"])} 的 is_paper 必须是 true/false,收到 ${pyRepr(value)}`,
  );
}

export function fromDict(raw: Raw, source: string | null = null): Settings {
  const paperMissing: string[] = [];
  const accounts: AccountConfig[] = ((raw["accounts"] as Raw[]) ?? []).map((a) => {
    const paper = paperFlag(a);
    if (paper === null) paperMissing.push(String(a["alias"]));
    return {
      alias: String(a["alias"]),
      account_id: String(a["account_id"]),
      is_paper: paper ?? false,
      connection: String(a["connection"] ?? "paper"),
      default: truthy(a["default"] ?? false),
    };
  });
  assertUniqueAliases(accounts);

  const connections: Record<string, ConnectionConfig> = {};
  for (const [name, c] of Object.entries((raw["connections"] as Record<string, Raw>) ?? {})) {
    connections[name] = buildConnection(name, c);
  }
  for (const conn of Object.values(connections)) {
    if (!["127.0.0.1", "localhost", "::1"].includes(conn.host)) {
      // §9.2:API 端口只绑本机,绝不跨网段
      throw new Error(`连接 ${conn.name} 的 host 必须是本机地址,当前为 ${conn.host}`);
    }
  }

  const indexes: Record<string, IndexConfig> = {};
  for (const [sym, c] of Object.entries((raw["index_symbols"] as Record<string, Raw>) ?? {})) {
    const dflt = DEFAULT_INDEX_FUTURES[sym.toUpperCase()];
    indexes[sym.toUpperCase()] = {
      symbol: sym.toUpperCase(),
      exchange: String((c["exchange"] as string) ?? "CBOE"),
      daily_trading_class: String((c["daily_trading_class"] as string) ?? ""),
      monthly_trading_class: String((c["monthly_trading_class"] as string) ?? ""),
      // 配置里显式写了(哪怕是空串)就听配置的;没写才用内置映射
      futures: String((c["futures"] as string | undefined) ?? dflt?.[0] ?? ""),
      futures_exchange: String((c["futures_exchange"] as string | undefined) ?? dflt?.[1] ?? "CME"),
    };
  }

  const storage = (raw["storage"] as Raw) ?? {};
  const settings = new Settings();
  settings.prompt_dir = raw["prompt_dir"] ? String(raw["prompt_dir"]) : DEFAULT_PROMPT_DIR;
  settings.prompt_version = String(raw["prompt_version"] ?? "v1.0.0");
  // "latest":跟着软件带的最新一版提示词走。配置是首次启动时从示例拷出来的,之后不会再被改写——
  // 钉死某一版的话,软件升级带来的新提示词老用户永远用不上。要钉住(回滚)就把它写成具体的版本号。
  if (settings.prompt_version === "latest") {
    const latest = latestPromptVersion(settings.prompt_dir);
    if (latest === null) throw new Error(`prompt_version 写的是 latest,但提示词目录里一版都没有:${settings.prompt_dir}`);
    settings.prompt_version = latest;
    settings.prompt_follows_latest = true;
  }
  // 与 Python 的 Settings(...) 参数求值顺序一致:llm → broker → limits → policies
  settings.llm = buildLlm((raw["llm"] as Raw) ?? {});
  settings.broker = buildBroker((raw["broker"] as Raw) ?? {});
  settings.limits = buildLimits((raw["limits"] as Raw) ?? {});
  settings.policies = buildPolicies((raw["policies"] as Raw) ?? {});
  settings.protections = buildProtections((raw["protections"] as Raw) ?? {});
  settings.risk_budget = buildRiskBudget((raw["risk_budget"] as Raw) ?? {});
  settings.follow = buildFollow((raw["follow"] as Raw) ?? {});
  settings.accounts = accounts;
  settings.connections = connections;
  const aliases: Record<string, string> = {};
  for (const [k, v] of Object.entries((raw["symbol_aliases"] as Raw) ?? {})) {
    aliases[k] = String(v).toUpperCase();
  }
  settings.symbol_aliases = aliases;
  settings.index_symbols = indexes;
  // 休市日 / 提前收盘日 = 配置里写的 ∪ 内置日历(marketCalendar.ts 按 NYSE 规则推算)。配置那张表只写到某一年,
  // 表里没有的年份以前每个工作日都算交易日;临时休市规则算不出来,照旧靠配置。
  // "market_calendar": "config_only" 退回老口径(只认配置里写的)。
  const calendarMode = String(raw["market_calendar"] ?? "builtin");
  if (calendarMode !== "builtin" && calendarMode !== "config_only") {
    throw new Error(`market_calendar 只能是 builtin 或 config_only,收到 ${pyRepr(raw["market_calendar"])}`);
  }
  const builtin = calendarMode === "builtin" ? builtinCalendar() : { holidays: [], earlyCloses: [] };
  settings.market_holidays = mergeCalendar((raw["market_holidays"] as string[]) ?? [], builtin.holidays);
  settings.early_close_days = mergeCalendar((raw["early_close_days"] as string[]) ?? [], builtin.earlyCloses);
  if (storage["db_path"]) settings.db_path = expandHome(String(storage["db_path"]));
  settings.source_path = source;
  settings.paper_flag_missing = paperMissing;
  settings.config_warnings = paperMissing.map(
    (alias) =>
      `账户 ${alias} 没写 is_paper,已按实盘账户处理(下单要过「允许实盘账户下单」这道闸)。` +
      "请在 config/settings.json 里给它写明 \"is_paper\": true 或 false。",
  );
  assertAccountConnections(settings);
  settings.config_warnings.push(...livePaperMismatches(settings));
  return settings;
}

const fs = fsModule;

export const DEFAULT_CONFIG_PATH = process.env["DAFRI_CONFIG"] ?? findDefaultConfigPath();

/** 引擎因为配置读不进来而退出时用的退出码(sysexits.h 的 EX_CONFIG)。桌面端认它:
 *  不再按"引擎崩了"去自动重启(配置不改,重启一万次也是同一个错),改成问用户怎么办。 */
export const EXIT_CONFIG = 78;

/** 配置读不进来。missing = 文件不在;syntax = 不是合法的 JSON;invalid = 是 JSON,但校验不过。
 *  invalid 的 message 就是校验那句原话,不加前缀——那些话和 Python 版逐字节一致,别处在比。 */
export class ConfigLoadError extends Error {
  readonly kind: "missing" | "syntax" | "invalid";
  readonly path: string;

  constructor(kind: "missing" | "syntax" | "invalid", filePath: string, message: string) {
    super(message);
    this.name = "ConfigLoadError";
    this.kind = kind;
    this.path = filePath;
  }
}

export function loadSettings(settingsPath?: string | null): Settings {
  const p = settingsPath ?? DEFAULT_CONFIG_PATH;
  if (!fs.existsSync(p)) {
    throw new ConfigLoadError(
      "missing", p,
      `找不到配置文件 ${p}。请复制 config/settings.example.json 为 config/settings.json 后修改。`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (exc) {
    throw new ConfigLoadError("syntax", p, `配置文件不是合法的 JSON(多半是手改时少了逗号或引号):${(exc as Error).message}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigLoadError("syntax", p, "配置文件的最外层必须是一个 { } 对象");
  }
  try {
    return fromDict(raw as Raw, p);
  } catch (exc) {
    throw new ConfigLoadError("invalid", p, (exc as Error).message);
  }
}

/** 上一份可用配置的备份放在哪:同目录、原名加 .bak。桌面端的「恢复上一份可用的配置」读的就是它。 */
export function configBackupPath(settingsPath: string): string {
  return `${settingsPath}.bak`;
}

/**
 * 原子写:先写同目录的临时文件、落盘(fsync),再 rename 过去。进程在任何一步被杀、磁盘在半路写满,
 * 留下的要么是旧文件、要么是新文件,不会是半截 JSON——半截 JSON 的后果是引擎起不来,持仓追踪没人盯。
 */
function writeFileAtomic(target: string, text: string): void {
  const tmp = `${target}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, text, null, "utf-8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, target);
  } catch (exc) {
    // Windows 上目标文件正被别的进程打开(杀毒、同步盘)时 rename 会 EPERM / EBUSY:退回直接写,不让这一次保存失败
    try {
      fs.writeFileSync(target, text, "utf-8");
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    if (!fs.existsSync(target)) throw exc;
  }
}

/** 深合并一份补丁到配置文件。先在内存里验一遍,验不过就不落盘。
 *  落盘之前把**改动前**那一份存成 .bak(它刚被读进来过,是能用的),再原子写新的。 */
export function patchConfigFile(settingsPath: string | null, patch: Raw): Settings {
  if (settingsPath === null || settingsPath === undefined) {
    throw new Error("当前设置不是从文件加载的,无法写回");
  }
  const before = fs.readFileSync(settingsPath, "utf-8");
  const raw = JSON.parse(before);
  const merged = deepMerge(raw, patch);
  const settings = fromDict(merged, settingsPath); // 验证:抛异常就不会走到写盘
  try {
    writeFileAtomic(configBackupPath(settingsPath), before);
  } catch {
    // 备份写不进去(目录只读?)不该挡住这一次保存:保存本身还会再试一次写盘,写不进去由它报
  }
  writeFileAtomic(settingsPath, JSON.stringify(merged, null, 2));
  return settings;
}

export function deepMerge(base: Raw, patch: Raw): Raw {
  const out: Raw = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (
      value !== null && typeof value === "object" && !Array.isArray(value) &&
      out[key] !== null && typeof out[key] === "object" && !Array.isArray(out[key])
    ) {
      out[key] = deepMerge(out[key] as Raw, value as Raw);
    } else {
      out[key] = value;
    }
  }
  return out;
}
