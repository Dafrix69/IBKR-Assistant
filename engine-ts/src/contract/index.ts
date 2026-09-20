/** 引擎 ↔ 界面的契约:每个 RPC 方法的入参与返回,只写一处。
 *
 * 引擎的 handler 按这里的类型实现(`rpc/contractMethods.ts`),界面的 `bridge.ts` 用
 * `import type` 引同一份——返回结构改一个字段名,两头一起编译不过,而不是界面上出一个 NaN。
 *
 * 迁移是渐进的:**新方法只能从这里加**,老方法碰到一个迁一个(还没迁的名单钉在
 * `tests/contract.spec.ts`,那张表只许变短)。类型文件(本文件与各域的 `<域>.ts`)不 import 任何东西;
 * 入参的运行时校验在 `schema/`,只有引擎 import。
 */
import type {
  AlertsCreateParams, AlertsDeleteParams, AlertsPollResult, AlertsRefreshParams, AlertsRefreshResult, Watch,
} from "./alerts.js";
import type { OptionWall, OptionsWallParams } from "./options.js";
import type { PoolSetWatchParams, PoolWatch } from "./pool.js";
import type { PositionRow } from "./positions.js";
import type {
  AnomalyConfig, QualityAddParams, QualityList, QualityRemoveParams, QualitySetConfigParams, QualityStock,
  QualityUpdateParams,
} from "./quality.js";
import type {
  Sector, SectorsAddParams, SectorsAddStockParams, SectorsAddStockResult, SectorsDeleteResult, SectorsIdParams,
  SectorsPickResult, SectorsQuotesResult, SectorsRemoveStockParams, SectorsRemoveStockResult, SectorsSetTagParams,
} from "./sectors.js";
import type {
  DataExportParams, DataExportResult, KeychainSetParams, SettingsPatchParams, SettingsView,
} from "./settings.js";
import type {
  Track, TrackerAddParams, TrackerDeleteParams, TrackerTargetPreviewParams, TrackerTargetPreviewResult,
  TrackerUpdateParams,
} from "./tracker.js";

export type * from "./alerts.js";
export type * from "./options.js";
export type * from "./pool.js";
export type * from "./positions.js";
export type * from "./quality.js";
export type * from "./sectors.js";
export type * from "./settings.js";
export type * from "./tracker.js";

/** 不带参数的方法。界面传 `{}`,多余的键引擎不看。 */
export type NoParams = Record<string, never>;

export interface RpcMethods {
  "alerts.list": { params: NoParams; result: { watches: Watch[] } };
  "alerts.create": { params: AlertsCreateParams; result: { watch: Watch } };
  "alerts.delete": { params: AlertsDeleteParams; result: { deleted: string } };
  "alerts.refresh": { params: AlertsRefreshParams; result: AlertsRefreshResult };
  "alerts.poll": { params: NoParams; result: AlertsPollResult };

  "options.wall": { params: OptionsWallParams; result: OptionWall };

  "pool.set_watch": { params: PoolSetWatchParams; result: PoolWatch };

  "positions.list": { params: NoParams; result: { positions: PositionRow[] } };

  "quality.list": { params: NoParams; result: QualityList };
  "quality.add": { params: QualityAddParams; result: { stock: QualityStock } };
  "quality.update": { params: QualityUpdateParams; result: { stock: QualityStock } };
  "quality.remove": { params: QualityRemoveParams; result: { deleted: string } };
  "quality.set_config": { params: QualitySetConfigParams; result: { config: AnomalyConfig } };

  "sectors.list": { params: NoParams; result: { sectors: Sector[] } };
  "sectors.add": { params: SectorsAddParams; result: { sector: Sector } };
  "sectors.delete": { params: SectorsIdParams; result: SectorsDeleteResult };
  "sectors.pick": { params: SectorsIdParams; result: SectorsPickResult };
  "sectors.quotes": { params: NoParams; result: SectorsQuotesResult };
  "sectors.add_stock": { params: SectorsAddStockParams; result: SectorsAddStockResult };
  "sectors.remove_stock": { params: SectorsRemoveStockParams; result: SectorsRemoveStockResult };
  "sectors.set_tag": { params: SectorsSetTagParams; result: { sector: Sector } };

  "settings.get": { params: NoParams; result: SettingsView };
  /** 回执就是改完之后的 settings.get */
  "settings.patch": { params: SettingsPatchParams; result: SettingsView };
  "keychain.set": { params: KeychainSetParams; result: { ok: true } };
  "data.export": { params: DataExportParams; result: DataExportResult };

  "tracker.list": { params: NoParams; result: { tracks: Track[] } };
  "tracker.add": { params: TrackerAddParams; result: { track: Track } };
  "tracker.update": { params: TrackerUpdateParams; result: { track: Track } };
  "tracker.delete": { params: TrackerDeleteParams; result: { deleted: true } };
  "tracker.target_preview": { params: TrackerTargetPreviewParams; result: TrackerTargetPreviewResult };
}

export type RpcMethodName = keyof RpcMethods;

/**
 * 会真的动钱或动配置的方法:桌面端主进程要求界面已经确认过一次才放行(main.js 的 SENSITIVE_RPC)。
 * 契约里登记了的方法,敏感不敏感以这张表为准,tests/desktop-whitelist.spec.ts 拿它和 main.js 双向对。
 * 这是本目录里唯一一个运行时的值——界面只 import type,碰不到它。
 */
export const SENSITIVE_METHODS = [
  "keychain.set", "settings.patch", "tracker.add", "tracker.update",
] as const satisfies readonly RpcMethodName[];
export type RpcParams<M extends RpcMethodName> = RpcMethods[M]["params"];
export type RpcResult<M extends RpcMethodName> = RpcMethods[M]["result"];
