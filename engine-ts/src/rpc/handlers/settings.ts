/** llm.* / settings.* / keychain.set / data.export:大模型接入与设置。
 *  settings.get / settings.patch / keychain.set / data.export 已经在契约里(contract/settings.ts);llm.* 还是老方法。 */
import * as fs from "node:fs";

import { patchConfigFile } from "../../config.js";
import type { LLMConfig } from "../../config.js";
import { KeychainError, hasSecret, setSecret } from "../../keychain.js";
import { PROVIDERS, buildParser, providerCatalog } from "../../providers.js";
import type {
  DataExportParams, KeychainSetParams, RpcResult, SettingsPatchParams, SettingsView,
} from "../../contract/index.js";
import { RpcError } from "../../rpcError.js";
import { HandlerBase } from "../context.js";
import type { MethodTable, Rec } from "../context.js";
import { contractMethods } from "../contractMethods.js";

export class SettingsHandlers extends HandlerBase {
  methods(): MethodTable {
    return {
      "llm.catalog": (p) => this.llmCatalog(p),
      "llm.patch": (p) => this.llmPatch(p),
      "llm.test": (p) => this.llmTest(p),
      ...contractMethods({
        "settings.get": () => this.settingsGet(),
        "settings.patch": (p) => this.settingsPatch(p),
        "keychain.set": (p) => this.keychainSet(p),
        "data.export": (p) => this.dataExport(p),
      }),
    };
  }

  // ---- 大模型接入 ------------------------------------------------------
  llmCatalog(_params: Rec): Rec {
    const cfg = this.settings.llm;
    const keys: Record<string, boolean> = {};
    for (const name of Object.keys(PROVIDERS)) {
      try {
        keys[name] = hasSecret(cfg.keychain_service, name); // 只查有没有,不解密(解密要起 PowerShell)
      } catch (exc) {
        if (!(exc instanceof KeychainError)) throw exc;
        keys[name] = false;
      }
    }
    return {
      providers: providerCatalog(),
      current: {
        provider: cfg.provider,
        model: cfg.model,
        base_url: cfg.base_url,
        effort: cfg.effort,
        temperature: cfg.temperature,
        max_tokens: cfg.max_tokens,
        timeout_s: cfg.timeout_s,
        keychain_service: cfg.keychain_service,
        keychain_account: cfg.keychain_account,
      },
      key_configured: keys,
    };
  }

  /** 改模型配置。切供应商时 keychain_account 跟着切,避免用错那把 key。 */
  llmPatch(params: Rec): Rec {
    const patch: Rec = { ...(params["llm"] ?? {}) };
    const allowed = new Set([
      "provider", "model", "base_url", "effort", "temperature", "max_tokens", "timeout_s",
    ]);
    const unknown = Object.keys(patch).filter((k) => !allowed.has(k)).sort();
    if (unknown.length) throw new RpcError(-32602, `不允许修改的字段:${unknown.join("、")}`);
    if ("provider" in patch) patch["keychain_account"] = patch["provider"];
    try {
      patchConfigFile(this.settings.source_path, { llm: patch });
    } catch (exc) {
      throw new RpcError(-32007, `配置校验失败,已回滚:${(exc as Error).message}`);
    }
    this.engine.store.audit("ui", "llm_patch", { patch });
    this.ctx.reload();
    this.emit("llm", this.llmCatalog({}));
    return this.llmCatalog({});
  }

  /** 真打一次最小请求。允许带一把未保存的 key 先试。 */
  async llmTest(params: Rec): Promise<Rec> {
    let cfg = this.settings.llm;
    const overrides: Rec = params["llm"] ?? {};
    if (Object.keys(overrides).length) {
      const merged: Rec = { ...cfg };
      for (const [k, v] of Object.entries(overrides)) if (k in cfg) merged[k] = v;
      if ("provider" in overrides) merged["keychain_account"] = overrides["provider"];
      cfg = merged as LLMConfig;
    }
    try {
      const parser = buildParser(cfg, params["api_key"] || null);
      const result = await parser.test();
      result["provider"] = cfg.provider;
      return result;
    } catch (exc) {
      return {
        ok: false,
        error:
          exc instanceof Error && exc.constructor.name !== "LLMError"
            ? `${exc.constructor.name}: ${exc.message}`
            : (exc as Error).message,
        provider: cfg.provider,
        model: cfg.model,
      };
    }
  }

  // ---- 设置 -----------------------------------------------------------
  settingsGet(): SettingsView {
    const s = this.settings;
    return {
      path: String(s.source_path),
      llm: { model: s.llm.model, effort: s.llm.effort, max_tokens: s.llm.max_tokens },
      limits: { ...s.limits },
      policies: { ...s.policies },
      protections: {
        stoploss_guard: { ...s.protections.stoploss_guard },
        max_drawdown: { ...s.protections.max_drawdown },
        cooldown: { ...s.protections.cooldown },
      },
      symbol_aliases: s.symbol_aliases,
      accounts: this.accounts(),
      connections: Object.fromEntries(
        Object.entries(s.connections).map(([name, c]) => [name, { host: c.host, port: c.port }]),
      ),
    };
  }

  settingsPatch(params: SettingsPatchParams): RpcResult<"settings.patch"> {
    const patch = params["patch"] ?? {};
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
      throw new RpcError(-32602, "patch 必须是对象");
    }
    const forbidden = ["accounts", "connections"].filter((k) => k in patch).sort();
    if (forbidden.length) {
      // 账户与连接牵涉真实账号,只允许人手动改配置文件,不给 UI 通道(§9.6)
      throw new RpcError(-32006, `账户与连接配置不允许从界面修改:${forbidden.join(", ")}`);
    }
    try {
      patchConfigFile(this.settings.source_path, patch);
    } catch (exc) {
      throw new RpcError(-32007, `配置校验失败,已回滚:${(exc as Error).message}`);
    }
    this.engine.store.audit("ui", "settings_patch", { patch });
    this.ctx.reload();
    this.emit("settings", this.settingsGet());
    return this.settingsGet();
  }

  keychainSet(params: KeychainSetParams): RpcResult<"keychain.set"> {
    const secret = String(params["secret"] ?? "");
    try {
      const account = params["provider"] || this.settings.llm.keychain_account;
      setSecret(this.settings.llm.keychain_service, account, secret);
    } catch (exc) {
      if (exc instanceof KeychainError) throw new RpcError(-32008, exc.message);
      throw exc;
    }
    this.engine.store.audit("ui", "keychain_set", { service: this.settings.llm.keychain_service });
    return { ok: true };
  }

  dataExport(params: DataExportParams): RpcResult<"data.export"> {
    const target = String(params["path"] ?? "");
    if (!target) throw new RpcError(-32602, "缺少导出路径");
    const data = this.engine.store.exportAll();
    fs.writeFileSync(target, JSON.stringify(data, null, 2), "utf-8");
    this.engine.store.audit("ui", "export", { path: target });
    return { path: target, records: (data["records"] as Rec[]).length };
  }
}
