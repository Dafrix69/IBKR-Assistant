/** alerts.*:价位提醒的增删查与碰均线的设置;重算与轮询转给 services/alerts。
 *  整个域已经在契约里(contract/alerts.ts):入参过了 schema 才到这里,返回对着契约类型检查。 */
import type {
  AlertsCreateParams, AlertsDeleteParams, AlertsSetTouchConfigParams, MaTouchConfig, RpcResult, Watch,
} from "../../contract/index.js";
import { MaTouchError, normalizeTouchConfig } from "../../maTouch.js";
import { RpcError } from "../../rpcError.js";
import { AlertsService } from "../../services/alerts.js";
import { HandlerBase } from "../context.js";
import type { MethodTable } from "../context.js";
import { contractMethods } from "../contractMethods.js";
import { symbolOrRaise } from "../params.js";

export class AlertsHandlers extends HandlerBase {
  methods(): MethodTable {
    return contractMethods({
      "alerts.list": () => this.alertsList(),
      "alerts.create": (p) => this.alertsCreate(p),
      "alerts.delete": (p) => this.alertsDelete(p),
      "alerts.refresh": (p) => this.ctx.alerts.refresh(p),
      "alerts.poll": () => this.ctx.alerts.poll(),
      "alerts.set_touch_config": (p) => this.alertsSetTouchConfig(p),
    });
  }

  // ---- 警告 ------------------------------------------------------------
  alertsList(): RpcResult<"alerts.list"> {
    this.ctx.pool.ensureMigrated();
    return { watches: this.engine.store.listWatches(), touch_config: this.ctx.alerts.touchConfig() };
  }

  alertsCreate(params: AlertsCreateParams): RpcResult<"alerts.create"> {
    const symbol = symbolOrRaise(params);
    let watch: Watch;
    try {
      watch = this.engine.store.addWatch(symbol, Number(params["step"] ?? 5.0) || 5.0);
    } catch (exc) {
      throw new RpcError(-32602, (exc as Error).message);
    }
    this.engine.store.audit("ui", "alert_watch_add", { symbol });
    return { watch };
  }

  alertsDelete(params: AlertsDeleteParams): RpcResult<"alerts.delete"> {
    const watchId = String(params["id"] ?? "").trim();
    if (!this.engine.store.deleteWatch(watchId)) {
      throw new RpcError(-32602, `没有这个警告:${watchId}`);
    }
    return { deleted: watchId };
  }

  alertsSetTouchConfig(params: AlertsSetTouchConfigParams): RpcResult<"alerts.set_touch_config"> {
    // "config 得是个对象"由 schema 管;哪几项、各自的范围由 normalizeTouchConfig 管(给中文原因)
    let config: MaTouchConfig;
    try {
      // 界面一次只改一两项:在当前生效的那份上合并,不是在默认值上
      config = normalizeTouchConfig(params["config"], this.ctx.alerts.touchConfig());
    } catch (exc) {
      if (exc instanceof MaTouchError) throw new RpcError(-32602, exc.message);
      throw exc;
    }
    this.engine.store.setPref(AlertsService.TOUCH_CONFIG_PREF, config);
    this.engine.store.audit("ui", "alert_touch_config", { config });
    this.ctx.alerts.touchConfigChanged();
    return { config };
  }
}
