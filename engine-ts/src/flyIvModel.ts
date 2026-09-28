/** 蝴蝶测算的 IV 模型:拿历史数据校准出来的参数。
 *
 * **由 scripts/calibrate-fly-iv.mjs 生成,不要手改。** 要改就重新校准:
 *   npm run build && npm run calibrate:fly -- --fetch --write
 * 口径、检验与局限见 docs/features/fly-plan.md「校准」。
 */
import type { FlyIvModel } from "./flyCalibration.js";

export const FLY_IV_MODEL: FlyIvModel = {
  "version": "2026-09-28",
  "source": "SPY 小时线与 5 分钟线、^VIX1D 与 ^VIX9D 小时线(公开行情接口)",
  "proxy": "VIX1D",
  "period": {
    "from": "2023-12-11",
    "to": "2026-09-25"
  },
  "days": 692,
  "variance_weights": [
    0.1507,
    0.1178,
    0.0948,
    0.0805,
    0.0596,
    0.0517,
    0.0597,
    0.0509,
    0.0597,
    0.0616,
    0.0609,
    0.0522,
    0.0999
  ],
  "realized_to_implied": 0.83,
  "response": {
    "a": -0.0105,
    "b": -0.0969,
    "c": 0.0253
  },
  "response_long": {
    "a": -0.0053,
    "b": -0.0641,
    "c": 0.0129,
    "days": 9
  },
  "resid_k": 0.158,
  "resid_move": {
    "base": 0.823,
    "slope": 0.265
  },
  "own": null,
  "fit": {
    "rows": 19376,
    "r2_in": 0.338,
    "r2_out": 0.322,
    "r2_out_flat": -0.007,
    "coverage_half": 0.525,
    "train": {
      "from": "2023-12-11",
      "to": "2025-11-19",
      "days": 484
    },
    "test": {
      "from": "2025-11-20",
      "to": "2026-09-25",
      "days": 208
    }
  }
};
