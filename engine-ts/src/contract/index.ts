/** 引擎 ↔ 界面的契约:每个 RPC 方法的入参与返回,只写一处。
 *
 * 引擎的 handler 按这里的类型实现(`rpc/context.ts` 的 contractMethods),界面的 `bridge.ts` 用
 * `import type` 引同一份——返回结构改一个字段名,两头一起编译不过,而不是界面上出一个 NaN。
 *
 * 迁移是渐进的:**新方法只能从这里加**,老方法碰到一个迁一个(还没迁的名单钉在
 * `tests/contract.spec.ts`,那张表只许变短)。类型文件(本文件与各域的 `<域>.ts`)不 import 任何东西;
 * 入参的运行时校验在 `schemas.ts` / `<域>.schema.ts`,只有引擎 import。
 */
import type { PoolSetWatchParams, PoolWatch } from "./pool.js";
import type {
  AnomalyConfig, QualityAddParams, QualityList, QualityRemoveParams, QualitySetConfigParams, QualityStock,
  QualityUpdateParams,
} from "./quality.js";

export type * from "./pool.js";
export type * from "./quality.js";

/** 不带参数的方法。界面传 `{}`,多余的键引擎不看。 */
export type NoParams = Record<string, never>;

export interface RpcMethods {
  "quality.list": { params: NoParams; result: QualityList };
  "quality.add": { params: QualityAddParams; result: { stock: QualityStock } };
  "quality.update": { params: QualityUpdateParams; result: { stock: QualityStock } };
  "quality.remove": { params: QualityRemoveParams; result: { deleted: string } };
  "quality.set_config": { params: QualitySetConfigParams; result: { config: AnomalyConfig } };
  "pool.set_watch": { params: PoolSetWatchParams; result: PoolWatch };
}

export type RpcMethodName = keyof RpcMethods;
export type RpcParams<M extends RpcMethodName> = RpcMethods[M]["params"];
export type RpcResult<M extends RpcMethodName> = RpcMethods[M]["result"];
