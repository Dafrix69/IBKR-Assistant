/** backtest.* 的入参 schema。代码形状、日期格式与区间长度、策略与参数认不认识,是领域校验,在 handler 与 backtest.ts;
 *  rules / instrument 由 models.ts 的 CustomRulesSchema / BacktestInstrumentSchema 校验(它们还要补默认值、给中文原因),这里不抄。 */
import { z } from "zod";

import type { BacktestParseRulesParams, BacktestRunParams } from "../backtest.js";
import { optional, requiredButReportedByHandler } from "./kit.js";
import type { ParamsSchema } from "./kit.js";

export const BacktestRunParamsSchema: ParamsSchema<BacktestRunParams> = z.object({
  symbol: z.string(),
  // golden-rpc 有一条只带一个坏代码的请求,期望的是「股票代码不合法」:这三项没带不能在这里拒
  start: requiredButReportedByHandler(),
  end: requiredButReportedByHandler(),
  strategy: requiredButReportedByHandler(),
  params: optional(z.record(z.string(), z.unknown())),
  rules: z.unknown(),
  instrument: z.unknown(),
});

export const BacktestParseRulesParamsSchema: ParamsSchema<BacktestParseRulesParams> = z.object({
  // 不带 text 由 handler 报「策略描述为空」:golden-rpc 钉着这一句
  text: requiredButReportedByHandler(),
});
