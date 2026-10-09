/** 黄金基线的**参数层**:别的基线(golden-*.spec,机制层)是在哪一套参数下生成的。
 *
 * 基线红了有两种截然不同的原因,以前分不开:
 *  · **机制变了**——同样的输入、同样的参数,算出来的不一样了。这是要查的;
 *  · **参数变了**——重新校准了日内方差分布、改了一个默认值。机制层里凡是用到它的用例跟着变,是预期的。
 * 这一条只钉参数。机制层红了先看它:它也红,先确认参数的改动是有意的,再 `npm run golden:update`
 * (它和机制层一起重生成);它绿,那就是机制自己变了。
 *
 * 这里列的是"进了钱路径或定价的数":止盈策略的倍数与钟点、按金额起算的两条线、校准出来的 IV 模型、
 * 追价的节奏、平仓限价的跳动、自动平仓与限额 / 策略 / 保护规则的默认值。只做展示的常量不列。
 */
import { describe, it } from "vitest";

import { DEFAULT_COMBO_TICK } from "../src/broker.js";
import { fromDict } from "../src/config.js";
import * as fx from "../src/flyexit.js";
import { FLY_IV_MODEL } from "../src/flyIvModel.js";
import * as tk from "../src/tracker.js";
import { expectSame, loadGolden } from "./util.js";

function currentParams(): Record<string, unknown> {
  const settings = fromDict({});
  const option = tk.makePosition({ account: "a", symbol: "SPX", sec_type: "OPT", quantity: 1 });
  const combo = tk.makePosition({ account: "a", symbol: "SPX", sec_type: "BAG", quantity: 1 });
  const stock = tk.makePosition({ account: "a", symbol: "AAPL", sec_type: "STK", quantity: 1 });
  return {
    flyexit_defaults: { ...fx.DEFAULTS },
    flyexit_usd_lines: { arm: fx.FLY_ARM_USD, tighten: fx.FLY_TIGHTEN_USD },
    sigma_search: { min: fx.SIGMA_MIN, max: fx.SIGMA_MAX },
    fly_iv_model: {
      version: FLY_IV_MODEL.version, period: FLY_IV_MODEL.period, days: FLY_IV_MODEL.days,
      variance_weights: [...FLY_IV_MODEL.variance_weights], realized_to_implied: FLY_IV_MODEL.realized_to_implied,
      response: FLY_IV_MODEL.response, response_long: FLY_IV_MODEL.response_long,
      resid_k: FLY_IV_MODEL.resid_k, resid_move: FLY_IV_MODEL.resid_move, own: FLY_IV_MODEL.own === null ? null : "own",
    },
    chase: { grace_rounds: tk.CHASE_GRACE_ROUNDS, step_ticks: tk.CHASE_STEP_TICKS, warn_rounds: tk.CHASE_WARN_ROUNDS },
    ticks: {
      combo_open: DEFAULT_COMBO_TICK, combo_close: tk.closeTick(combo, 1), stock: tk.closeTick(stock, 1),
      option_below_3: tk.closeTick(option, 2.95), option_from_3: tk.closeTick(option, 3),
    },
    auto_close_defaults: tk.makeAutoClose({}),
    limits_defaults: settings.limits,
    policies_defaults: settings.policies,
    protections_defaults: settings.protections,
    risk_budget_defaults: settings.risk_budget,
  };
}

describe("golden: 参数快照(机制层的基线是在这一套参数下生成的)", () => {
  const g = loadGolden("params");

  it("参数没有变", () => {
    try {
      expectSame(currentParams(), g.snapshot, "params.snapshot");
    } catch (exc) {
      throw new Error(
        `${(exc as Error).message}\n` +
        "↑ 这是**参数**变了,不是机制变了:重新校准、或者改了一个默认值。机制层里用到它的基线(flyexit 的方差表 / 阶段 / 回放、" +
        "tracker 的预设档位……)会跟着红,那是预期的。确认这次改动是有意的,再 `npm run golden:update`,并在提交信息里写明改了哪个参数。",
        { cause: exc },
      );
    }
  });
});
