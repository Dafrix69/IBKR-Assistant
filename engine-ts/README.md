# engine-ts

TypeScript 版交易引擎,桌面端默认加载它(不需要 Python)。行为规格是 `../engine-python`:
`tests/golden-*.spec.ts` 用 Python 生成的 `baseline/golden/*.json` 逐字段对拍,`tests/golden-rpc.spec.ts`
回放 `baseline/rpc/` 的契约样本,`tests/golden-store.spec.ts` 直接打开 Python 生成的 `baseline/store/fixture.db`。
`baseline/llm/*_schema.json` 是 pydantic dump 出来的结构化输出 schema,TS 只消费不生成。重写过程见 `../docs/reports/ts-rewrite-report.md`。

```bash
npm install
npm run build        # tsc → dist/(不进仓库;桌面端 npm start 会自动检查并重编,见 desktop/tools/ensure_engine_ts.js)
npm test             # vitest:单测 + 黄金对拍 + RPC 契约回放
npm run typecheck
```

默认读仓库根的 `prompts/` 与 `config/settings.json`(向上查找,src/ 与 dist/src/ 两种布局都能落到同一处);
`DAFRI_PROMPT_DIR`、`DAFRI_CONFIG` 可覆盖,打包版由 Electron 外壳显式指定。
