/** quality.*:优质股追踪的增删改与触发条件;监控循环本身在 services/anomaly。 */
import { AnomalyError, normalizeAnomalyConfig } from "../../anomaly.js";
import type { AnomalyConfig } from "../../anomaly.js";
import { RpcError } from "../../rpcError.js";
import { AnomalyService } from "../../services/anomaly.js";
import { HandlerBase } from "../context.js";
import type { MethodTable, Rec } from "../context.js";
import { symbolOrRaise } from "../params.js";

export class QualityHandlers extends HandlerBase {
  methods(): MethodTable {
    return {
      "quality.list": (p) => this.qualityList(p),
      "quality.add": (p) => this.qualityAdd(p),
      "quality.update": (p) => this.qualityUpdate(p),
      "quality.remove": (p) => this.qualityRemove(p),
      "quality.set_config": (p) => this.qualitySetConfig(p),
    };
  }

  /** 库里的一行 + 内存里最近一轮的指标。 */
  private qualityRowOut(row: Rec): Rec {
    const symbol = String(row["symbol"]);
    const hit = this.ctx.anomaly.metricsOf(symbol);
    return {
      ...row,
      metrics: hit?.metrics ?? null,
      metrics_at: hit?.at ?? null,
      quote_error: hit?.error ?? null,
      // 同一只股身上的另一个开关算到哪一步了:界面要能显示「正在算价位…」
      levels_status: this.ctx.alerts.levelsStatusOf(symbol),
    };
  }

  qualityList(_params: Rec): Rec {
    this.ctx.pool.ensureMigrated();
    return {
      stocks: this.engine.store.listQualityStocks().map((row) => this.qualityRowOut(row)),
      config: this.ctx.anomaly.config(),
      monitor: this.ctx.anomaly.monitor(),
      max: AnomalyService.MAX_QUALITY,
    };
  }

  qualityAdd(params: Rec): Rec {
    this.ctx.pool.ensureMigrated(); // 排在 ensureInPool 前面:别让迁移替这只新股开开关(备注会丢)
    const symbol = symbolOrRaise(params);
    if (this.settings.indexConfig(symbol)) {
      // 指数不是可交易合约,量能流按正股去订一定订不上
      throw new RpcError(-32602, `${symbol} 是指数,优质股追踪只支持个股 / ETF`);
    }
    const store = this.engine.store;
    if (store.listQualityStocks().some((q) => String(q["symbol"]) === symbol)) {
      throw new RpcError(-32602, `已经在追踪 ${symbol} 了`);
    }
    if (store.listQualityStocks().length >= AnomalyService.MAX_QUALITY) {
      // 每只股一条常驻行情流,线路总共约 100 条,还要留给宏观带、盯盘、期权链
      throw new RpcError(-32602, `最多追踪 ${AnomalyService.MAX_QUALITY} 只`);
    }
    // 成员身份由池子说了算:不在任何板块里就先并进「自选」,再开「盯异动」这一个开关
    this.ctx.pool.ensureInPool(symbol, String(params["company"] ?? ""));
    const out = this.ctx.pool.setWatch(symbol, { anomaly: true }, String(params["note"] ?? ""));
    if (!out["anomaly_on"]) {
      throw new RpcError(-32602, String((out["skipped"] as string[])[0] ?? `打不开 ${symbol} 的异动监控`));
    }
    const stock = store.listQualityStocks().find((q) => String(q["symbol"]) === symbol)!;
    return { stock: this.qualityRowOut(stock) };
  }

  qualityUpdate(params: Rec): Rec {
    const stockId = String(params["id"] ?? "").trim();
    const store = this.engine.store;
    const stock = store.getQualityStock(stockId);
    if (stock === null) throw new RpcError(-32602, `没有这只优质股:${stockId}`);
    const fields: Rec = {};
    if (params["enabled"] !== undefined && params["enabled"] !== null) fields["enabled"] = Boolean(params["enabled"]);
    if (params["note"] !== undefined && params["note"] !== null) fields["note"] = String(params["note"]);
    if (Object.keys(fields).length) {
      store.updateQualityStock(stockId, fields);
      store.audit("ui", "quality_update", { id: stockId, symbol: stock["symbol"], fields: Object.keys(fields) });
    }
    if (fields["enabled"] === false) {
      // 停用期间的样本到重新启用时早就过时了,留着只会把一段空档算成"窗口"
      this.ctx.anomaly.forget(String(stock["symbol"]));
    }
    return { stock: this.qualityRowOut(store.getQualityStock(stockId) ?? stock) };
  }

  qualityRemove(params: Rec): Rec {
    const stockId = String(params["id"] ?? "").trim();
    const store = this.engine.store;
    const stock = store.getQualityStock(stockId);
    if (stock === null) throw new RpcError(-32602, `没有这只优质股:${stockId}`);
    // 走同一段开关逻辑:删行 + 清掉内存里的样本 / 指标 + 留痕,一处改处处改
    this.ctx.pool.setWatch(String(stock["symbol"]), { anomaly: false });
    return { deleted: stockId };
  }

  qualitySetConfig(params: Rec): Rec {
    const raw = params["config"];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new RpcError(-32602, "触发条件格式不对:config 应是一个对象");
    }
    let config: AnomalyConfig;
    try {
      // 界面一次只改一两项:在当前生效的那份上合并,不是在默认值上
      config = normalizeAnomalyConfig(raw, this.ctx.anomaly.config());
    } catch (exc) {
      if (exc instanceof AnomalyError) throw new RpcError(-32602, exc.message);
      throw exc;
    }
    this.engine.store.setPref(AnomalyService.QUALITY_CONFIG_PREF, config);
    this.engine.store.audit("ui", "quality_config", { config });
    return { config };
  }
}
