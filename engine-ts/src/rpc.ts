/** 老路径。实现已经按域搬走:
 *
 *   rpc/server.ts        传输(三条道)、生命周期、装配
 *   rpc/handlers/<域>.ts  每个域一张方法表
 *   rpc/params.ts        入参小工具
 *   services/*.ts        带状态的编排:行情缓存、价位提醒、异动循环、股票池
 *
 * cli、桌面端的压测脚本(dist/src/rpc.js)与测试继续从这里 import,所以留一个只做转出的壳。
 */
export { PROTOCOL_VERSION } from "./rpc/context.js";
export { configSnippet } from "./rpc/handlers/connection.js";
export { summarize } from "./rpc/handlers/trading.js";
export { drawdownTiersOf, optFloat, optInt } from "./rpc/params.js";
export { RpcServer, main } from "./rpc/server.js";
export { RpcError } from "./rpcError.js";
