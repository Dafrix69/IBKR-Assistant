/** follow.*:Discord 跟单的状态、bot token、重新连接(docs/features/follow.md)。
 *  跟单的配置是 settings 的 `follow` 段,读写走 settings.get / settings.patch;这里只有不属于配置文件的那几样。
 *  follow.set_token 写系统凭证库:入参 schema 是 strict 的,并登记在 SENSITIVE_METHODS 里。 */
import type { FollowSetTokenParams, FollowStatus } from "../../contract/index.js";
import { RpcError } from "../../rpcError.js";
import { KeychainError } from "../../secrets.js";
import { HandlerBase } from "../context.js";
import type { MethodTable } from "../context.js";
import { contractMethods } from "../contractMethods.js";

export class FollowHandlers extends HandlerBase {
  methods(): MethodTable {
    return contractMethods({
      "follow.status": () => this.ctx.follow.status(),
      "follow.set_token": (p) => this.setToken(p),
      "follow.reconnect": () => this.reconnect(),
    });
  }

  /** 存 bot token 并用它重新连接。明文只经过这一跳,不落配置、不回显、不进日志。 */
  async setToken(params: FollowSetTokenParams): Promise<FollowStatus> {
    const token = params.token.trim();
    // bot token 是三段用点连起来的 base64url;用户 token 也长这样,分不出来——但形状都不对的可以当场说
    if (!/^[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}$/.test(token)) {
      throw new RpcError(-32602, "这不像 Discord 的 bot token(应该是用两个点连起来的三段)。在 Developer Portal 的 Bot 页点 Reset Token 之后整段复制。");
    }
    try {
      await this.ctx.follow.setToken(token);
    } catch (exc) {
      if (exc instanceof KeychainError) throw new RpcError(-32008, exc.message);
      throw exc;
    }
    return this.ctx.follow.status();
  }

  /** 丢掉现在的连接重来:在 Developer Portal 改好了设置(打开 intent、把 bot 拉进服务器)之后用。 */
  async reconnect(): Promise<FollowStatus> {
    await this.ctx.follow.sync(true);
    return this.ctx.follow.status();
  }
}
