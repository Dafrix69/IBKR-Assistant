/** 契约方法的入参 schema 总表。
 *
 * schema 只管**结构**:有哪些字段、各是什么 JSON 类型。领域上的对不对(代码形状、上限、指数不能盯异动、
 * 阈值越界)留在 handler 里,报的也是 handler 自己那句人话——结构错是调用方写错了,领域错是用户填错了,
 * 两种错不该说成同一句。
 *
 * 表的类型是对着 RpcMethods 的映射:契约里加了方法却没配 schema、或 schema 解出来的形状和契约类型对不上,
 * 都是编译错。
 */
import type { RpcMethodName, RpcParams } from "../index.js";
import { AlertsCreateParamsSchema, AlertsDeleteParamsSchema, AlertsRefreshParamsSchema } from "./alerts.js";
import { BacktestParseRulesParamsSchema, BacktestRunParamsSchema } from "./backtest.js";
import {
  IdeasAddParamsSchema, IdeasAnalyzeParamsSchema, IdeasDigestParamsSchema, IdeasDigestsParamsSchema, IdeasListParamsSchema,
  IdeasUpdateParamsSchema,
} from "./ideas.js";
import { NoParamsSchema } from "./kit.js";
import type { ParamsSchema } from "./kit.js";
import { BookSnapshotParamsSchema, MacroBoardParamsSchema } from "./market.js";
import { OptionsWallParamsSchema } from "./options.js";
import { PoolSetWatchParamsSchema } from "./pool.js";
import {
  QualityAddParamsSchema, QualityRemoveParamsSchema, QualitySetConfigParamsSchema, QualityUpdateParamsSchema,
} from "./quality.js";
import {
  SectorsAddParamsSchema, SectorsAddStockParamsSchema, SectorsIdParamsSchema, SectorsRemoveStockParamsSchema,
  SectorsSetTagParamsSchema,
} from "./sectors.js";
import { DataExportParamsSchema, KeychainSetParamsSchema, SettingsPatchParamsSchema } from "./settings.js";
import {
  TrackerAddParamsSchema, TrackerDeleteParamsSchema, TrackerTargetPreviewParamsSchema, TrackerUpdateParamsSchema,
} from "./tracker.js";

export { describeIssue } from "./kit.js";

export const PARAMS_SCHEMAS: { readonly [M in RpcMethodName]: ParamsSchema<RpcParams<M>> } = {
  "alerts.list": NoParamsSchema,
  "alerts.create": AlertsCreateParamsSchema,
  "alerts.delete": AlertsDeleteParamsSchema,
  "alerts.refresh": AlertsRefreshParamsSchema,
  "alerts.poll": NoParamsSchema,

  "book.snapshot": BookSnapshotParamsSchema,

  "macro.board": MacroBoardParamsSchema,

  "backtest.strategies": NoParamsSchema,
  "backtest.run": BacktestRunParamsSchema,
  "backtest.parse_rules": BacktestParseRulesParamsSchema,

  "ideas.add": IdeasAddParamsSchema,
  "ideas.list": IdeasListParamsSchema,
  "ideas.update": IdeasUpdateParamsSchema,
  "ideas.analyze": IdeasAnalyzeParamsSchema,
  "ideas.digest": IdeasDigestParamsSchema,
  "ideas.digests": IdeasDigestsParamsSchema,

  "options.wall": OptionsWallParamsSchema,

  "pool.set_watch": PoolSetWatchParamsSchema,

  "positions.list": NoParamsSchema,

  "quality.list": NoParamsSchema,
  "quality.add": QualityAddParamsSchema,
  "quality.update": QualityUpdateParamsSchema,
  "quality.remove": QualityRemoveParamsSchema,
  "quality.set_config": QualitySetConfigParamsSchema,

  "sectors.list": NoParamsSchema,
  "sectors.add": SectorsAddParamsSchema,
  "sectors.delete": SectorsIdParamsSchema,
  "sectors.pick": SectorsIdParamsSchema,
  "sectors.quotes": NoParamsSchema,
  "sectors.add_stock": SectorsAddStockParamsSchema,
  "sectors.remove_stock": SectorsRemoveStockParamsSchema,
  "sectors.set_tag": SectorsSetTagParamsSchema,

  "settings.get": NoParamsSchema,
  "settings.patch": SettingsPatchParamsSchema,
  "keychain.set": KeychainSetParamsSchema,
  "data.export": DataExportParamsSchema,

  "tracker.list": NoParamsSchema,
  "tracker.add": TrackerAddParamsSchema,
  "tracker.update": TrackerUpdateParamsSchema,
  "tracker.delete": TrackerDeleteParamsSchema,
  "tracker.target_preview": TrackerTargetPreviewParamsSchema,
};

/** 契约里登记了的方法名(排好序)。 */
export function contractMethodNames(): RpcMethodName[] {
  return (Object.keys(PARAMS_SCHEMAS) as RpcMethodName[]).sort();
}
