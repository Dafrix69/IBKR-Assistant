// 交易引擎的 lint。规矩只有一条:**只留能抓到真错的规则**,不做风格警察——
// 这个仓库的排版是手调过的(表格式的对齐、成段的中文注释),交给工具重排只会把可读性洗掉。
// 所以这里不接 Prettier、不开 stylistic 规则,只开"写错了会出事"的那一类。
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "baseline/**", "coverage/**", ".dependency-cruiser.cjs"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: { ecmaVersion: 2023, sourceType: "module" },
      globals: {
        console: "readonly", process: "readonly", Buffer: "readonly",
        setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly",
        clearInterval: "readonly", setImmediate: "readonly", queueMicrotask: "readonly",
        performance: "readonly", fetch: "readonly", Response: "readonly", AbortController: "readonly",
        structuredClone: "readonly", crypto: "readonly", URL: "readonly", TextEncoder: "readonly",
        TextDecoder: "readonly", globalThis: "readonly", __dirname: "readonly",
      },
    },
    rules: {
      // 能抓到真错的那一类
      "no-constant-binary-expression": "error",
      "no-self-compare": "error",
      "no-unmodified-loop-condition": "error",
      "no-unreachable-loop": "error",
      "no-template-curly-in-string": "error",
      eqeqeq: ["error", "smart"],
      // 速记解析里 `[work, m] = take(work, …)` 这种"流水线"解构:work 要重新赋值,
      // 只有 m 能是 const,拆开写反而更难读。只有整组都能 const 时才报。
      "prefer-const": ["error", { destructuring: "all" }],
      // 关掉三条只会制造噪声的:
      // · no-promise-executor-return —— `new Promise((r) => setTimeout(r, ms))` 是标准写法
      // · require-atomic-updates —— 误报出了名,这里每一处都是先 await 再赋值的正常代码
      // · no-useless-assignment —— 引擎里 `let x = 兜底值` 再在 try 里覆盖是刻意的防御写法,
      //   为它去改下单路径上的十几处代码,是拿真钱的风险换零收益
      "no-promise-executor-return": "off",
      "require-atomic-updates": "off",
      "no-useless-assignment": "off",

      // any 在券商 / 模型的回包上是现实(结构由对方定),不当错误报
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // 引擎里有意用 `let x: T | null = null` 后再赋值的懒加载,不强制 readonly / 推断
      "@typescript-eslint/no-empty-function": "off",
    },
  },
  {
    // `type Rec = Record<string, any>` 的禁区(CLAUDE.md「类型」):一个 Rec 就把整条链路的类型检查关掉。
    // 对外的四个文件(券商与模型回包的结构由对方定)可以有;下面其余几个是存量,碰到时收成接口、
    // 从这张表里划掉。**这张表只许变短**——新文件要松散记录类型,说明它缺一个接口。
    files: ["src/**"],
    ignores: [
      "src/broker.ts", "src/ibSession.ts", "src/futuBroker.ts", "src/providers.ts",
      // 存量
      "src/engine.ts", "src/store.ts", "src/shorthand.ts", "src/flyexit.ts", "src/ibtrades.ts",
      "src/screener.ts", "src/stockreview.ts", "src/tradereview.ts",
      // 从 rpc.ts 搬家带过来的那一份:rpc/ 与 services/ 共用这一处,不再各声明各的
      "src/services/host.ts",
    ],
    rules: {
      "no-restricted-syntax": ["error", {
        selector: "TSTypeAliasDeclaration[id.name='Rec']",
        message: "这个文件不许声明 `type Rec`:把用到的字段写成接口(见 CLAUDE.md「类型」)。",
      }],
    },
  },
  {
    // 测试:断言里常有故意的"怪写法"
    files: ["tests/**", "scripts/**"],
    rules: { "@typescript-eslint/no-unused-expressions": "off" },
  },
);
