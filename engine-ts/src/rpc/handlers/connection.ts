/** broker.* / tws.* / futu.*:券商接入的选择、连接,与本机网关的探测。
 *  整个域已经在契约里(contract/connection.ts):入参过了 schema 才到这里,返回对着契约类型检查。 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { BrokerError } from "../../broker.js";
import type {
  BrokerCatalog, BrokerConnectParams, BrokerConnectResult, BrokerDisconnectResult, BrokerSelectParams,
  BrokerSelectResult, DiagnoseParams, DiagnoseResult, DiagnoseResults, FutuScanResult,
  FutuSetPasswordParams, FutuUnlockParams, FutuUnlockResult, LaunchParams, LaunchResult, TwsScanResult,
} from "../../contract/index.js";
import { DEFAULT_BROKER_PORT, patchConfigFile } from "../../config.js";
import * as futu from "../../futu.js";
import { FutuRouter } from "../../futuBroker.js";
import { KeychainError, hasSecret, setSecret } from "../../keychain.js";
import { RpcError } from "../../rpcError.js";
import { redactAccount } from "../../store.js";
import * as twsMod from "../../tws.js";
import { HandlerBase } from "../context.js";
import type { MethodTable } from "../context.js";
import { contractMethods } from "../contractMethods.js";

export class ConnectionHandlers extends HandlerBase {
  methods(): MethodTable {
    return contractMethods({
      "broker.catalog": () => this.brokerCatalog(),
      "broker.select": (p) => this.brokerSelect(p),
      "broker.connect": (p) => this.brokerConnect(p),
      "broker.disconnect": () => this.brokerDisconnect(),
      "tws.scan": () => this.twsScan(),
      "tws.diagnose": (p) => this.twsDiagnose(p),
      "tws.launch": (p) => this.twsLaunch(p),
      "futu.scan": () => this.futuScan(),
      "futu.diagnose": (p) => this.futuDiagnose(p),
      "futu.launch": (p) => this.futuLaunch(p),
      "futu.unlock": (p) => this.futuUnlock(p),
      "futu.set_password": (p) => this.futuSetPassword(p),
    });
  }

  // ---- 券商连接 --------------------------------------------------------
  static readonly BROKER_LABELS: Record<string, string> = {
    ibkr: "盈透证券(IBKR / TWS)",
    futu: "富途证券(OpenD)",
  };

  brokerCatalog(): BrokerCatalog {
    const provider = this.settings.broker.provider;
    const futuCfg = this.settings.broker.futu;
    let unlockSaved = false;
    try {
      unlockSaved = hasSecret(futuCfg.keychain_service, futuCfg.keychain_account); // 只查有没有,不解密
    } catch (exc) {
      if (!(exc instanceof KeychainError)) throw exc;
    }
    return {
      current: provider,
      connected: this.router ? this.router.connectedNames() : [],
      providers: Object.entries(ConnectionHandlers.BROKER_LABELS).map(([key, label]) => ({
        key,
        label,
        current: key === provider,
        connections: Object.fromEntries(
          Object.entries(this.settings.connectionsFor(key)).map(([name, c]) => [
            name, { host: c.host, port: c.port, client_id: c.client_id },
          ]),
        ),
        accounts: this.settings.accounts
          .filter((a) => this.settings.accountBroker(a) === key)
          .map((a) => ({
            alias: a.alias,
            account_masked: redactAccount(a.account_id),
            is_paper: a.is_paper,
            connection: a.connection,
            default: a.default,
          })),
        // 没配连接就把该抄的那段配置直接给出来
        config_snippet: Object.keys(this.settings.connectionsFor(key)).length
          ? null
          : configSnippet(key),
      })),
      futu: {
        trd_market: futuCfg.trd_market,
        security_firm: futuCfg.security_firm,
        symbol_map: futuCfg.symbol_map,
        unlock_password_saved: unlockSaved,
      },
    };
  }

  /** 切换生效的券商接入。切之前先把旧连接断干净。 */
  async brokerSelect(params: BrokerSelectParams): Promise<BrokerSelectResult> {
    const provider = String(params["provider"] ?? "");
    if (!(provider in ConnectionHandlers.BROKER_LABELS)) {
      throw new RpcError(-32602, `只支持 ${Object.keys(ConnectionHandlers.BROKER_LABELS).join("、")}`);
    }
    if (!Object.keys(this.settings.connectionsFor(provider)).length) {
      // 切到一家却没有它的连接 = 切进空档。刻意不替用户补(§9.6)。
      throw new RpcError(
        -32006,
        `配置里还没有 ${ConnectionHandlers.BROKER_LABELS[provider]} 的连接和账户。` +
        `请在 config/settings.json 里加上,再回来切换:\n${configSnippet(provider)}`,
      );
    }
    try {
      this.ctx.settings = patchConfigFile(this.settings.source_path, { broker: { provider } });
    } catch (exc) {
      throw new RpcError(-32007, `切换券商失败,配置未改动:${(exc as Error).message}`);
    }
    if (this.ctx.router !== null) {
      await this.ctx.router.disconnectAll();
      this.ctx.router = null;
    }
    this.ctx.brokerLink.forget();
    this.ctx.dropEngine();
    this.engine.store.audit("ui", "broker_select", { provider });
    return {
      current: provider,
      connections: Object.keys(this.settings.connectionsFor(provider)).sort(),
    };
  }

  /** 连接 / 断开的整条路在 services/brokerLink.ts:启动自动连、断线重连提醒与这里的按钮共用。 */
  async brokerConnect(params: BrokerConnectParams): Promise<BrokerConnectResult> {
    return this.ctx.brokerLink.connect(params["connections"] ?? undefined);
  }

  async brokerDisconnect(): Promise<BrokerDisconnectResult> {
    await this.ctx.brokerLink.disconnect();
    return { connected: [] };
  }

  // ---- TWS 检测(§9.1:本模块不接触任何 IBKR 凭证)------------------------
  async twsScan(): Promise<TwsScanResult> {
    return {
      ports: await twsMod.scanPorts(this.settings),
      apps: twsMod.detectApps(),
      guide: twsMod.connectionGuide(this.settings),
      connections: Object.fromEntries(
        Object.entries(this.settings.connections).map(([name, c]) => [
          name, { host: c.host, port: c.port, client_id: c.client_id },
        ]),
      ),
      connected: this.router ? this.router.connectedNames() : [],
    };
  }

  async twsDiagnose(params: DiagnoseParams): Promise<DiagnoseResults> {
    const names: string[] = params["connections"] ?? Object.keys(this.settings.connections).sort();
    const unknown = names.filter((n) => !(n in this.settings.connections));
    if (unknown.length) throw new RpcError(-32602, `未定义的连接:${unknown.join("、")}`);
    const results: DiagnoseResult[] = [];
    for (const name of names) {
      try {
        results.push(await twsMod.diagnose(this.settings, name) as DiagnoseResult);
      } catch (exc) {
        // 诊断失败本身就是要展示的结果
        results.push({ connection: name, connected: false, error: (exc as Error).message, hint: null });
      }
    }
    this.emit("tws", { results });
    return { results };
  }

  twsLaunch(params: LaunchParams): LaunchResult {
    const key = String(params["app"] ?? "");
    let result: LaunchResult;
    try {
      result = twsMod.launchApp(key);
    } catch (exc) {
      throw new RpcError(-32009, (exc as Error).message);
    }
    this.engine.store.audit("ui", "tws_launch", { app: key, path: result["path"] });
    return result;
  }

  // ---- 富途 OpenD 检测(§9.1:本模块不接触任何富途凭证)-------------------
  async futuScan(): Promise<FutuScanResult> {
    return {
      ports: await futu.scanPorts(this.settings),
      apps: futu.detectApps(),
      guide: futu.connectionGuide(this.settings),
      connections: Object.fromEntries(
        Object.entries(this.settings.connectionsFor("futu")).map(([name, c]) => [
          name, { host: c.host, port: c.port },
        ]),
      ),
      connected: this.router ? this.router.connectedNames() : [],
      active: this.settings.broker.provider === "futu",
      sdk_installed: futuSdkInstalled(),
    };
  }

  async futuDiagnose(params: DiagnoseParams): Promise<DiagnoseResults> {
    const futuConns = this.settings.connectionsFor("futu");
    const names: string[] = params["connections"] ?? Object.keys(futuConns).sort();
    if (!names.length) {
      throw new RpcError(-32602, "配置里还没有任何富途连接。请先在「券商接入」里切到富途。");
    }
    const unknown = names.filter((n) => !(n in futuConns));
    if (unknown.length) throw new RpcError(-32602, `未定义的连接:${unknown.join("、")}`);
    const results: DiagnoseResult[] = [];
    for (const name of names) {
      try {
        results.push(await futu.diagnose(this.settings, name) as DiagnoseResult);
      } catch (exc) {
        results.push({
          connection: name, broker: "futu", connected: false,
          error: (exc as Error).message, hint: null,
        });
      }
    }
    this.emit("futu", { results });
    return { results };
  }

  futuLaunch(params: LaunchParams): LaunchResult {
    const key = String(params["app"] || "opend");
    let result: LaunchResult;
    try {
      result = futu.launchApp(key);
    } catch (exc) {
      throw new RpcError(-32009, (exc as Error).message);
    }
    this.engine.store.audit("ui", "futu_launch", { app: key, path: result["path"] });
    return result;
  }

  /** 存交易解锁密码。只存 md5,绝不存明文,也绝不回显任何一段。 */
  futuSetPassword(params: FutuSetPasswordParams): { ok: true } {
    let secret = String(params["password"] ?? "");
    if (!secret) throw new RpcError(-32602, "交易解锁密码为空");
    if (!params["already_md5"]) {
      secret = crypto.createHash("md5").update(secret, "utf-8").digest("hex");
    }
    secret = secret.trim().toLowerCase();
    if (secret.length !== 32 || !/^[0-9a-f]{32}$/.test(secret)) {
      throw new RpcError(-32602, "勾了「已经是 md5」,但填的不是 32 位十六进制字符串");
    }
    const futuCfg = this.settings.broker.futu;
    try {
      setSecret(futuCfg.keychain_service, futuCfg.keychain_account, secret);
    } catch (exc) {
      if (exc instanceof KeychainError) throw new RpcError(-32008, exc.message);
      throw exc;
    }
    this.engine.store.audit("ui", "futu_password_set", { service: futuCfg.keychain_service });
    return { ok: true };
  }

  /** 实盘交易解锁。密码从 Keychain / DPAPI 读,不经过界面。 */
  async futuUnlock(params: FutuUnlockParams): Promise<FutuUnlockResult> {
    if (this.settings.broker.provider !== "futu") {
      throw new RpcError(-32010, "当前券商接入不是富途,无需解锁。");
    }
    if (this.router === null || !("unlock" in this.router)) {
      throw new RpcError(-32004, "尚未连接富途 OpenD,请先在下面点「连接 / 断开交易引擎」。");
    }
    let result: FutuUnlockResult;
    try {
      result = await (this.router as FutuRouter).unlock(params["connection"] ?? null);
    } catch (exc) {
      if (exc instanceof BrokerError) throw new RpcError(-32011, exc.message);
      throw exc;
    }
    this.engine.store.audit("ui", "futu_unlock", { unlocked: result["unlocked"] ?? [] });
    return result;
  }
}

/** 给用户照抄的那段配置。账号那一行留成占位符。 */
export function configSnippet(provider: string): string {
  const port = DEFAULT_BROKER_PORT[provider]!;
  const account = provider === "futu" ? "8801234(富途账号,一串数字)" : "DU0000000";
  return JSON.stringify(
    {
      connections: { [provider]: { broker: provider, host: "127.0.0.1", port } },
      accounts: [
        {
          alias: provider === "futu" ? "富途模拟" : "模拟",
          account_id: account,
          is_paper: true,
          connection: provider,
        },
      ],
    },
    null,
    2,
  );
}

function futuSdkInstalled(): boolean {
  // 按依赖是否装上判断(npm futu-api);适配桥的真机状态另见 futuBridge
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // src/rpc/handlers/ 下根在上三级;dist/src/rpc/handlers/ 下在上四级
    return [path.join("..", "..", ".."), path.join("..", "..", "..", "..")].some((up) =>
      fs.existsSync(path.resolve(here, up, "node_modules", "futu-api", "package.json")));
  } catch {
    return false;
  }
}
