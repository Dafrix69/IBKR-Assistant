/** events.*:重要事件的清单、口径与自定义事件(docs/features/events.md)。只读行情日历、只写本地偏好,不发单。 */
import type { EventsAddParams, EventsListParams, EventsRemoveParams, EventsSetConfigParams, RpcResult } from "../../contract/index.js";
import { EventsConfigError } from "../../econCalendar.js";
import { RpcError } from "../../rpcError.js";
import { HandlerBase } from "../context.js";
import type { MethodTable } from "../context.js";
import { contractMethods } from "../contractMethods.js";

export class EventsHandlers extends HandlerBase {
  methods(): MethodTable {
    return contractMethods({
      "events.list": (p) => this.list(p),
      "events.set_config": (p) => this.setConfig(p),
      "events.add": (p) => this.add(p),
      "events.remove": (p) => this.remove(p),
    });
  }

  list(params: EventsListParams): Promise<RpcResult<"events.list">> {
    return this.ctx.events.list(Boolean(params.force));
  }

  setConfig(params: EventsSetConfigParams): RpcResult<"events.set_config"> {
    try {
      return { config: this.ctx.events.setConfig(params.config) };
    } catch (exc) {
      if (exc instanceof EventsConfigError) throw new RpcError(-32602, exc.message);
      throw exc;
    }
  }

  add(params: EventsAddParams): RpcResult<"events.add"> {
    return { event: this.ctx.events.add(params) };
  }

  remove(params: EventsRemoveParams): RpcResult<"events.remove"> {
    const id = params.id.trim();
    if (!this.ctx.events.remove(id)) throw new RpcError(-32602, "没有这条自定义事件");
    return { deleted: id };
  }
}
