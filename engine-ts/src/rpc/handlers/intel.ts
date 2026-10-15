/** intel.*:信息链路——一条时间线与一份标的档案(docs/features/intel.md)。只读:取价只走已经订着的行情,不发单、不建追踪。 */
import type { IntelDossierParams, IntelFeedParams, RpcResult } from "../../contract/index.js";
import { HandlerBase } from "../context.js";
import type { MethodTable } from "../context.js";
import { contractMethods } from "../contractMethods.js";

export class IntelHandlers extends HandlerBase {
  methods(): MethodTable {
    return contractMethods({
      "intel.feed": (p) => this.feed(p),
      "intel.dossier": (p) => this.dossier(p),
    });
  }

  feed(params: IntelFeedParams): Promise<RpcResult<"intel.feed">> {
    return this.ctx.intel.feed(params);
  }

  dossier(params: IntelDossierParams): Promise<RpcResult<"intel.dossier">> {
    return this.ctx.intel.dossier(params);
  }
}
