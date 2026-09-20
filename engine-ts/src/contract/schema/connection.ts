/** broker.* / tws.* / futu.* 的入参 schema。
 *
 * 这个域的几句报错都是 golden-rpc 钉着的领域话(「只支持 ibkr、futu」「未定义的连接:…」「勾了「已经是 md5」…」),
 * 所以 schema 只管结构。**密码那一项只确认是字符串**:describeIssue 说的是"哪个字段、要什么类型、收到什么类型",不回显值。
 */
import { z } from "zod";

import type {
  BrokerConnectParams, BrokerSelectParams, DiagnoseParams, FutuSetPasswordParams, FutuUnlockParams, LaunchParams,
} from "../connection.js";
import { optional, requiredButReportedByHandler } from "./kit.js";
import type { ParamsSchema } from "./kit.js";

export const BrokerSelectParamsSchema: ParamsSchema<BrokerSelectParams> = z.object({
  // 不给 / 给个不认识的,都由 handler 报「只支持 ibkr、futu」(golden-rpc 钉着),所以收 unknown
  provider: z.unknown(),
});

export const BrokerConnectParamsSchema: ParamsSchema<BrokerConnectParams> = z.object({
  connections: optional(z.array(z.string())),
});

export const DiagnoseParamsSchema: ParamsSchema<DiagnoseParams> = z.object({
  // 不认识的名字由 handler 报「未定义的连接:…」(golden-rpc 钉着)
  connections: optional(z.array(z.string())),
});

export const LaunchParamsSchema: ParamsSchema<LaunchParams> = z.object({
  // 只认固定的键:不认识的由 handler 报「只支持拉起 tws 或 gateway / opend」
  app: z.unknown(),
});

export const FutuUnlockParamsSchema: ParamsSchema<FutuUnlockParams> = z.object({
  connection: optional(z.string()),
});

export const FutuSetPasswordParamsSchema: ParamsSchema<FutuSetPasswordParams> = z.object({
  // 不带密码时老 handler 报「交易解锁密码为空」(golden-rpc 钉着同一条路上的 md5 那句),不换成 schema 的「缺少 password」
  password: requiredButReportedByHandler(),
  already_md5: z.unknown(),
}).strict();
