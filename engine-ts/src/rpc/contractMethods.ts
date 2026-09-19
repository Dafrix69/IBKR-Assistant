/** 从 contract/ 登记的方法:入参先过 schema,handler 拿到的就是契约里写的那个类型。
 *
 *   methods(): MethodTable {
 *     return contractMethods({
 *       "quality.add": (p) => this.qualityAdd(p),   // p: QualityAddParams,返回必须是 { stock: QualityStock }
 *     });
 *   }
 *
 * 方法名、入参、返回三样都对着 RpcMethods 检查:名字不在契约里、返回少一个字段,都是编译错。
 * 一个域里契约方法和老方法可以并存——把这张表摊进老表里:`{ ...老表, ...contractMethods({...}) }`。
 */
import type { RpcMethodName, RpcParams, RpcResult } from "../contract/index.js";
import { PARAMS_SCHEMAS, describeIssue } from "../contract/schema/index.js";
import { RpcError } from "../rpcError.js";
import type { MethodTable, Rec } from "./context.js";

export type ContractHandler<M extends RpcMethodName> = (params: RpcParams<M>) => RpcResult<M> | Promise<RpcResult<M>>;

export function contractMethods<K extends RpcMethodName>(impl: { [M in K]: ContractHandler<M> }): MethodTable {
  const table: MethodTable = {};
  for (const name of Object.keys(impl) as K[]) {
    const handler = impl[name];
    const schema = PARAMS_SCHEMAS[name];
    table[name] = (raw: Rec) => {
      const parsed = schema.safeParse(raw);
      // 结构不合是调用方写错了(界面与引擎的版本对不上、手写请求漏了字段),和用户填错的领域错分开说
      if (!parsed.success) throw new RpcError(-32602, `${name} 的参数不对:${describeIssue(parsed.error)}`);
      return handler(parsed.data as RpcParams<K>);
    };
  }
  return table;
}
