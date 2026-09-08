// 用当前 TS 实现重写黄金基线。
//
//   npm run golden:update                 # 全部 tests/golden-*.spec.ts
//   npm run golden:update -- screener     # 只跑文件名含 screener 的
//
// 原理:UPDATE_GOLDEN=1 下 tests/util.ts 的 expectSame 遇到差异不报错,而是把实际值写回
// golden 文件(K 线序列照旧抽进 _bars.json 去重)。串行跑,免得多个 worker 同时写 _bars.json。
// 跑完看 git diff:每一处变化都应当是你有意改的行为。toBe / toEqual 钉住的常量、经过转换再比的
// 期望值、以及 baseline/store/fixture.db,不会自动改——失败了按报错手改。
import { spawnSync } from "node:child_process";

const extra = process.argv.slice(2);
const filter = extra.length ? extra : ["golden-"];
const result = spawnSync("npx", ["vitest", "run", "--no-file-parallelism", ...filter], {
  stdio: "inherit",
  env: { ...process.env, UPDATE_GOLDEN: "1" },
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
