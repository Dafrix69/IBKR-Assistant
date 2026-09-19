/** alerts.*:价位提醒的增删查;重算与轮询转给 services/alerts。 */
import { RpcError } from "../../rpcError.js";
import { HandlerBase } from "../context.js";
import type { MethodTable, Rec } from "../context.js";
import { symbolOrRaise } from "../params.js";

export class AlertsHandlers extends HandlerBase {
  methods(): MethodTable {
    return {
      "alerts.list": (p) => this.alertsList(p),
      "alerts.create": (p) => this.alertsCreate(p),
      "alerts.delete": (p) => this.alertsDelete(p),
      "alerts.refresh": (p) => this.alertsRefresh(p),
      "alerts.poll": (p) => this.alertsPoll(p),
    };
  }

  // ---- 警告 ------------------------------------------------------------
  alertsList(_params: Rec): Rec {
    this.ctx.pool.ensureMigrated();
    return { watches: this.engine.store.listWatches() };
  }

  alertsCreate(params: Rec): Rec {
    const symbol = symbolOrRaise(params);
    let watch: Rec;
    try {
      watch = this.engine.store.addWatch(symbol, Number(params["step"] ?? 5.0) || 5.0);
    } catch (exc) {
      throw new RpcError(-32602, (exc as Error).message);
    }
    this.engine.store.audit("ui", "alert_watch_add", { symbol });
    return { watch };
  }

  alertsDelete(params: Rec): Rec {
    const watchId = String(params["id"] ?? "").trim();
    if (!this.engine.store.deleteWatch(watchId)) {
      throw new RpcError(-32602, `没有这个警告:${watchId}`);
    }
    return { deleted: watchId };
  }

  alertsRefresh(params: Rec): Promise<Rec> {
    return this.ctx.alerts.refresh(params);
  }

  alertsPoll(_params: Rec): Promise<Rec> {
    return this.ctx.alerts.poll();
  }
}
