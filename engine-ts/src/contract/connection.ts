/** broker.* / tws.* / futu.*:券商接入的选择、连接,与本机网关的探测。类型文件,不 import 任何东西。
 *
 * **这个域不接触任何券商凭证**(§9.1):账号一律打码,富途的交易解锁密码只说"存没存",从不回显。
 * 拉起外部程序只认固定的键,路径在引擎这一侧解析——界面传不进路径。
 */

// ---------------------------------------------------------------- 共用
/** 一条连接的可见部分(不含只该留在配置文件里的东西)。 */
export interface ConnectionBrief {
  host: string;
  port: number;
  /** 富途那边没有这一项 */
  client_id?: number;
}

/** 给界面看的账户:账号打了码。 */
export interface BrokerAccountView {
  alias: string;
  account_masked: string;
  is_paper: boolean;
  connection: string;
  default: boolean;
}

/** 诊断时的账户核对:同上,外加「这个别名在网关的可管账户里对得上吗」。 */
export interface DiagnoseAccount extends BrokerAccountView {
  resolved: boolean;
  /**
   * 富途独有:网关报的这个账户到底是模拟还是实盘(SIMULATE / REAL),以及它跟配置里的 is_paper 对不对得上。
   * is_paper 写反不会报错,只会让实盘闸门失效——所以在连接阶段就摆出来。网关没报是 null。
   */
  trd_env?: string | null;
  env_matches?: boolean | null;
}

/** 本机某个端口的探测结果。 */
export interface PortStatus {
  port: number;
  /** 这个端口通常是谁(TWS 实盘 / 模拟、Gateway、OpenD…) */
  label: string;
  kind: string;
  /** 这个端口按惯例是模拟盘;自定义端口不知道,是 null */
  paper: boolean | null;
  open: boolean;
  latency_ms: number | null;
  /** 没开时的原因 */
  error: string | null;
  /** 配置里哪条连接用的是它;没人用是 null */
  configured_as: string | null;
}

/** 本机装没装、在不在跑。 */
export interface AppStatus {
  /** tws / gateway / opend */
  key: string;
  name: string;
  installed: boolean;
  /** 找到的安装路径(最多 5 条) */
  paths: string[];
  running: boolean;
}

/** 连接指引里的一步。 */
export interface GuideStep {
  step: number;
  title: string;
  detail: string;
}

/** 拉起外部程序的结果。 */
export interface LaunchResult {
  launched: boolean;
  path: string;
}

// ---------------------------------------------------------------- broker.*
export interface BrokerProviderEntry {
  /** ibkr / futu */
  key: string;
  label: string;
  /** 当前生效的是不是它 */
  current: boolean;
  connections: Record<string, ConnectionBrief>;
  accounts: BrokerAccountView[];
  /** 这一家还没配连接时,把该抄进配置文件的那一段直接给出来;配了就是 null */
  config_snippet: string | null;
}

export interface BrokerCatalog {
  /** 当前生效的券商 */
  current: string;
  /** 已连上的连接名 */
  connected: string[];
  providers: BrokerProviderEntry[];
  /** 富途独有的几项。unlock_password_saved 只说存没存,绝不回显 */
  futu: {
    trd_market: string;
    security_firm: string;
    symbol_map: Record<string, string>;
    unlock_password_saved: boolean;
  };
}

export interface BrokerSelectParams {
  /** ibkr / futu;别的报「只支持 ibkr、futu」 */
  provider?: unknown;
}

export interface BrokerSelectResult {
  current: string;
  /** 切过去之后这一家有哪几条连接 */
  connections: string[];
}

export interface BrokerConnectParams {
  /** 连哪几条;不给 = 这一家配置里的全部 */
  connections?: string[];
}

export interface BrokerConnectResult {
  provider: string;
  connected: string[];
  /** 没连上的那几条各自的原因 */
  failed: Record<string, string>;
  /** 给引擎挂上了几个事件监听(0 = 一条都没连上) */
  listeners: number;
}

export interface BrokerDisconnectResult {
  connected: string[];
}

// ---------------------------------------------------------------- tws.* / futu.* 探测
export interface TwsScanResult {
  ports: PortStatus[];
  apps: AppStatus[];
  guide: GuideStep[];
  connections: Record<string, ConnectionBrief>;
  connected: string[];
}

export interface FutuScanResult extends TwsScanResult {
  /** 当前生效的券商是不是富途 */
  active: boolean;
  /** npm 的 futu-api 装没装 */
  sdk_installed: boolean;
}

/**
 * 一条连接的诊断。下面除了头四项,其余都是可选的:`diagnose()` 自己一定给全,但**它整个抛了**的时候
 * handler 只补得出「哪条连接、没连上、什么错、没有下一步」——那一格照样要摆到界面上。
 */
export interface DiagnoseResultFull {
  connection: string;
  connected: boolean;
  error: string | null;
  hint: string | null;
  host?: string;
  port?: number;
  port_open?: boolean;
  port_latency_ms?: number | null;
  server_version?: string | number | null;
  server_time?: string | null;
  /** 网关报的托管账户 */
  managed_accounts?: string[];
  /** 配置里的账户与托管账户对得上吗(账号打码) */
  accounts?: DiagnoseAccount[];
  /** 网关有、配置里没有的那些(打码) */
  unmapped_accounts?: string[];
  readonly?: boolean;
  /** 诊断用的是偏移过的 client_id:别和正在下单的那条抢 ID(IBKR 会报 326) */
  client_id?: number;
  // ---- 富途独有 ----
  broker?: string;
  qot_logined?: boolean | null;
  trd_logined?: boolean | null;
  unlock_required?: boolean;
  error_code?: string | null;
}

export interface DiagnoseParams {
  /** 诊断哪几条;不给 = 全部。不认识的名字报「未定义的连接:…」 */
  connections?: string[];
}

/** 诊断失败本身就是要展示的结果:那一格给 error 与 hint,不是整次调用报错。 */
export type DiagnoseResult = DiagnoseResultFull;

export interface DiagnoseResults {
  results: DiagnoseResult[];
}

export interface LaunchParams {
  /** tws / gateway;富途只认 opend(不给就是 opend)。**只认键,不收路径** */
  app?: unknown;
}

// ---------------------------------------------------------------- 富途交易解锁
export interface FutuUnlockParams {
  /** 解锁哪一条;不给 = 全部 */
  connection?: string | null;
}

export interface FutuUnlockResult {
  unlocked: string[];
  /** 没解开的那几条各自的原因(富途原文,绝不含与密码有关的内容) */
  failed: Record<string, string>;
}

export interface FutuSetPasswordParams {
  /** 交易解锁密码。**只存 md5,绝不存明文,也绝不回显任何一段** */
  password: string;
  /** 填的已经是 md5 了(那就只校验 32 位十六进制,不再哈希一次) */
  already_md5?: unknown;
}
