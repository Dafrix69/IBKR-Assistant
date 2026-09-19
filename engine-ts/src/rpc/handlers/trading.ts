/** 下单这条线:instruction.submit、交易记录、条件单队列、熔断。 */
import { BrokerError } from "../../broker.js";
import { resolveFanoutAccounts } from "../../engine.js";
import { redactAccount } from "../../store.js";
import { RpcError } from "../../rpcError.js";
import { HandlerBase } from "../context.js";
import type { MethodTable, Rec } from "../context.js";

export class TradingHandlers extends HandlerBase {
  methods(): MethodTable {
    return {
      "instruction.submit": (p) => this.instructionSubmit(p),
      "records.list": (p) => this.recordsList(p),
      "records.get": (p) => this.recordsGet(p),
      "pending.list": (p) => this.pendingList(p),
      "pending.poll": (p) => this.pendingPoll(p),
      "breaker.state": (p) => this.breakerState(p),
      "breaker.halt": (p) => this.breakerHalt(p),
      "breaker.resume": (p) => this.breakerResume(p),
    };
  }

  // ---- 指令 -----------------------------------------------------------
  async instructionSubmit(params: Rec): Promise<Rec> {
    const text = String(params["text"] ?? "").trim();
    if (!text) throw new RpcError(-32602, "指令为空");
    const execute = Boolean(params["execute"]);
    if (execute && !this.settings.policies.auto_execute) {
      throw new RpcError(-32003, "自动执行没有打开,拒绝执行。请先在「设置」里打开「允许自动执行」。");
    }
    if (execute && this.router === null) {
      throw new RpcError(-32004, `尚未连接${this.gateway()},拒绝执行。`);
    }
    // 界面勾选的目标账户:勾两个就同时向两个账户发单。别名先在这里核对,
    // 表外的名字不该走到大模型那一步才报错。
    const rawAccounts = params["accounts"] ?? [];
    if (!Array.isArray(rawAccounts) || rawAccounts.some((a) => typeof a !== "string")) {
      throw new RpcError(-32602, "accounts 必须是账户别名数组");
    }
    let accounts: string[];
    try {
      accounts = resolveFanoutAccounts(this.settings, rawAccounts as string[]);
    } catch (exc) {
      throw new RpcError(-32602, (exc as Error).message);
    }

    const engine = this.engine;
    const channel = String(params["channel"] ?? "manual");
    // 解析模式(不执行)作为参数传进去,不临时改共享配置——盯盘节拍器同一时刻也在读它
    const result = await engine.handleInstruction(text, channel, null, null, accounts, !execute);

    const payload: Rec = { ...result, executed: execute };
    this.emit("result", payload);
    return payload;
  }

  // ---- 记录 -----------------------------------------------------------
  recordsList(params: Rec): Rec {
    const limit = Math.trunc(Number(params["limit"] ?? 30));
    const records = this.engine.store.listRecords(limit);
    return { records: records.map(summarize) };
  }

  recordsGet(params: Rec): Rec {
    const record = this.engine.store.getRecord(String(params["id"] ?? ""));
    if (record === null) throw new RpcError(-32005, "记录不存在");
    const out = { ...record };
    const account = { ...(out["account"] ?? {}) };
    if (account["account_id"]) {
      account["account_masked"] = redactAccount(account["account_id"]);
      delete account["account_id"];
    }
    out["account"] = account;
    return { record: out };
  }

  // ---- 条件单队列 ------------------------------------------------------
  pendingList(_params: Rec): Rec {
    return {
      pending: this.engine.pendingTriggers.map((p) => ({
        record_id: p.record_id,
        intent_summary: p.approved.order.intent_summary,
        symbol: p.trigger.symbol,
        operator: p.trigger.operator,
        value: p.trigger.value,
        account: p.approved.account.alias,
        created_at: p.created_at,
      })),
    };
  }

  /** UI 定时调用:盯盘 + 顺手同步券商回报(富途没有事件流)。 */
  async pendingPoll(_params: Rec): Promise<Rec> {
    const synced = await this.engine.syncBrokerOrders();
    if (this.router === null || !this.engine.pendingTriggers.length) {
      return { fired: [], prices: {}, synced };
    }
    const prices: Record<string, number> = {};
    for (const pending of this.engine.pendingTriggers) {
      const symbol = pending.trigger.symbol;
      if (symbol in prices) continue;
      const price = await this.router.indexPrice(symbol);
      if (price !== null) prices[symbol] = price;
    }
    const fired = await this.engine.firePending(prices);
    const expired = this.engine.expirePending();
    if (fired.length || expired) this.emit("pending", { fired, expired });
    return { fired, prices, expired, synced };
  }

  // ---- 熔断 -----------------------------------------------------------
  breakerState(_params: Rec): Rec {
    const state = this.engine.killswitch.state();
    return {
      engaged: state.engaged, reason: state.reason, at: state.at,
      consecutive_failures: state.consecutive_failures,
    };
  }

  async breakerHalt(params: Rec): Promise<Rec> {
    const reason = String(params["reason"] || "用户在界面上按下暂停");
    // 熔断(撤全部单)和一轮盯盘互斥:否则那一轮可能在熔断前过了闸门、熔断撤完单之后才把托管单
    // 挂出去,熔断后还留着一张活单
    const outcome: Rec = await this.ctx.trackerLock(async () => {
      try {
        return await this.engine.halt(reason);
      } catch (exc) {
        if (!(exc instanceof BrokerError)) throw exc;
        this.engine.killswitch.engage(reason);
        return { engaged: true, cancelled: 0, warning: exc.message } as Rec;
      }
    });
    this.emit("breaker", outcome);
    return outcome;
  }

  breakerResume(_params: Rec): Rec {
    this.engine.killswitch.release("ui");
    this.engine.store.audit("ui", "resume", {});
    this.emit("breaker", { engaged: false });
    return { engaged: false };
  }
}

export function summarize(record: Rec): Rec {
  const account = record["account"] ?? {};
  const contract = record["contract"] ?? {};
  const order = record["order"] ?? {};
  const ibkr = record["ibkr"] ?? {};
  const timeline: Rec[] = ibkr["status_timeline"] ?? [];
  return {
    id: record["id"] ?? null,
    created_at: record["created_at"] ?? null,
    intent_summary: (record["llm"] ?? {})["intent_summary"] ?? "",
    raw_instruction: (record["input"] ?? {})["raw_instruction"] ?? "",
    reason: (record["input"] ?? {})["reason"] ?? "",
    symbol: contract["symbol"] ?? "",
    secType: contract["secType"] ?? "",
    action: order["action"] ?? "",
    quantity: order["totalQuantity"] ?? null,
    account: account["alias"] ?? "",
    account_masked: redactAccount(account["account_id"] ?? ""),
    is_paper: account["is_paper"] ?? null,
    execution_type: record["execution_type"] ?? null,
    final_status: record["final_status"] ?? null,
    status: (timeline.length ? timeline[timeline.length - 1] : {})!["status"] ?? null,
    avg_fill_price: ibkr["avg_fill_price"] ?? null,
    total_commission: ibkr["total_commission"] ?? null,
    confidence: (record["llm"] ?? {})["confidence"] ?? null,
    rejection: record["rejection"] ?? null,
    notional_estimate: record["notional_estimate"] ?? null,
  };
}
