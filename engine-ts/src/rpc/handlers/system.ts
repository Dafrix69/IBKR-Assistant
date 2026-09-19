/** system.*:状态条读的那一份快照,与提示词自检。 */
import { ET, nowEt } from "../../config.js";
import { fingerprint, loadPromptBundle } from "../../prompts.js";
import { protectionsSummary } from "../../protections.js";
import { pad2, wallParts } from "../../tz.js";
import { HandlerBase, PROTOCOL_VERSION } from "../context.js";
import type { MethodTable, Rec } from "../context.js";

export class SystemHandlers extends HandlerBase {
  methods(): MethodTable {
    return {
      "system.status": (p) => this.systemStatus(p),
      "system.selftest": (p) => this.systemSelftest(p),
    };
  }

  private indexSpots(): Rec {
    const info = (this.router as { spotInfo?: (s: string) => Rec | null } | null)?.spotInfo;
    if (typeof info !== "function") return {};
    const out: Rec = {};
    for (const symbol of Object.keys(this.settings.index_symbols)) {
      const row = info.call(this.router, symbol);
      if (row) out[symbol] = row;
    }
    return out;
  }

  systemStatus(_params: Rec): Rec {
    const moment = nowEt();
    const breaker = this.engine.killswitch.state();
    const p = wallParts(moment.epochMs, ET);
    return {
      protocol: PROTOCOL_VERSION,
      now_et: `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`,
      market_status: this.settings.marketStatus(moment),
      prompt_version: this.engine.bundle.version,
      prompt_fingerprint: fingerprint(this.engine.bundle),
      model: this.settings.llm.model,
      auto_execute: this.settings.policies.auto_execute,
      allow_live_trading: this.settings.policies.allow_live_trading,
      breaker: {
        engaged: breaker.engaged,
        reason: breaker.reason,
        consecutive_failures: breaker.consecutive_failures,
      },
      // 保护规则(接连止损 / 回撤过大 / 同标的冷却):到点自己解除,所以带上解除时刻,
      // 界面直接显示"还剩几分钟",不用再问一次
      protections: protectionsSummary(this.engine.protectionState(moment.epochMs), moment.epochMs),
      broker_provider: this.settings.broker.provider,
      broker_connected: Boolean(this.router && this.router.sessions().length),
      broker_upstream_ok: Boolean(this.router === null || this.router.upstreamOk),
      pending_count: this.engine.pendingTriggers.length,
      // 各指数最近一次现价是怎么来的:官方实时 / 夜盘期货推算 / 推算失败退回的昨收(带原因)。
      // 只读缓存,不发请求——status 在本地道,来了就答。
      index_spot: this.indexSpots(),
      // 盯盘节拍器的心跳:没在跑、太久没跳、上一轮报错,界面都要能当场看见
      tracker_loop: this.ctx.engineBuilt ? this.ctx.engineBuilt.trackerHeartbeat() : null,
      accounts: this.accounts(),
      limits: {
        max_order_notional: this.settings.limits.max_order_notional,
        max_option_contracts: this.settings.limits.max_option_contracts,
        max_mkt_shares: this.settings.limits.max_mkt_shares,
        min_confidence: this.settings.limits.min_confidence,
        max_spread_slippage: this.settings.limits.max_spread_slippage,
        duplicate_window_minutes: this.settings.limits.duplicate_window_minutes,
      },
    };
  }

  systemSelftest(_params: Rec): Rec {
    const bundle = loadPromptBundle(this.settings);
    return {
      prompt_version: bundle.version,
      prompt_fingerprint: fingerprint(bundle),
      system_prompt_chars: [...bundle.system_text].length,
      fewshot_pairs: bundle.fewshot.length,
      symbol_aliases: this.settings.symbol_aliases,
      accounts: this.accounts(),
    };
  }
}
