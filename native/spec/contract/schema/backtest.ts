/** backtest.* 的入参 schema。代码形状、日期格式与区间长度、策略与参数认不认识,是领域校验,在 handler 与 backtest.ts;
 *  rules / instrument 由 models.ts 的 CustomRulesSchema / BacktestInstrumentSchema 校验(它们还要补默认值、给中文原因),这里不抄。 */
import { z } from "zod";

import type { BacktestParseRulesParams, BacktestRunParams, BacktestSweepParams } from "../backtest.js";
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
  cost_pct: z.unknown(),
});

// 结构只认这几个键;网格的取值、比例的范围由 backtestLab 报人话
export const BacktestSweepParamsSchema: ParamsSchema<BacktestSweepParams> = z.object({
  symbols: z.array(z.string()),
  start: z.unknown(),
  end: z.unknown(),
  strategy: z.unknown(),
  grid: optional(z.record(z.string(), z.array(z.union([z.number(), z.string()])))),
  instrument: z.unknown(),
  cost_pct: z.unknown(),
  split_pct: z.unknown(),
  folds: z.unknown(),
  objective: z.unknown(),
});

export const BacktestParseRulesParamsSchema: ParamsSchema<BacktestParseRulesParams> = z.object({
  // 不带 text 由 handler 报「策略描述为空」:golden-rpc 钉着这一句
  text: requiredButReportedByHandler(),
});
