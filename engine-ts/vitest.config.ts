// vitest 的配置只有一件事:别去跑编译产物。
//
// tsc 把 tests/ 也编译进 dist/tests(tsconfig 的 include 带着它),而 vitest 4 起默认只排除 node_modules 与 .git,
// 不再排除 dist。不写这一条的话,本机只要打过包、起过应用(dist/ 就在),每条用例会对着编译产物再跑一遍,
// 而那一份找不到 baseline/ 与 desktop/(相对路径差了一层)——2026-09-28 升 vitest 5 时量到:多出 118 个文件、324 条红。
// CI 里看不出来:它只跑 tsc --noEmit,没有 dist。
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "dist/**"],
  },
});
