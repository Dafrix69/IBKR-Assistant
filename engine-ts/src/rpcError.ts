/** 带错误码的失败。码与文案原样进 JSON-RPC 回执的 error 字段,界面按码分流
 *(-32602 参数不对、-3200x 业务上拒了、-32000 没料到的异常)。
 *
 * 放在最底层:rpc/ 的 handler 与 services/ 的编排都要抛它,谁也不该为了一个错误类去 import 传输层。
 */
export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** 给人看的失败原因:RpcError 的文案原样给,其余异常截到 200 字。 */
export function errText(exc: unknown): string {
  if (exc instanceof RpcError) return exc.message;
  return String((exc as Error)?.message ?? exc).slice(0, 200);
}
