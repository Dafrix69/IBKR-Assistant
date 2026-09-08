# engine-ts

交易引擎(TypeScript,Node ≥ 22)。桌面端拉起 `dist/src/cli.js rpc` 作为子进程,命令行也是同一个入口(见根 README「命令行」)。
它最初是 Python 实现的逐字段等价重写(过程见 `../docs/reports/ts-rewrite-report.md`);2026-09-08 起 Python 版退役,这里是唯一实现。

```bash
# Node >= 22(better-sqlite3 13 的预编译包在 Node 20 上会段错误);开发机与 Electron 40 内置的都是 Node 24
npm install
npm run build          # tsc → dist/(不进仓库;桌面端 npm start 会自动检查并重编,见 desktop/tools/ensure_engine_ts.js)
npm test               # vitest:单测 + 黄金回归 + RPC 契约回放,全部离线
npm run typecheck
npm run golden:update  # 有意改了行为之后重写黄金基线,然后审阅 git diff
```

## 基线(baseline/)

- `golden/*.json`:纯函数模块的 (输入, 期望输出) 快照,`tests/golden-*.spec.ts` 逐字段回放(浮点 1e-9 相对容差,字符串逐字节)。
  最初由 Python 参考实现生成,现在是本引擎自己的回归快照。
- `golden/_bars.json`:所有 golden 共用的 K 线序列,按内容哈希去重,用例里只留 `{"$bars": id}`;`tests/util.ts` 的 `loadGolden`
  读回时展开。别的工具要直接读 golden 时照 `desktop/tools/gen_pa_mock.js` 那样先展开。
- `rpc/`:76 步 RPC 契约回放(`requests.json` → `expected.json`,固定时钟、假 LLM、无券商连接),`tests/golden-rpc.spec.ts`。
- `store/fixture.db`:旧版(Python 引擎)写出的数据库文件,`tests/golden-store.spec.ts` 保证本引擎能原样打开与折叠读取——升级用户手里的
  trades.db 就是这种文件。
- `llm/*_schema.json`:发给模型的结构化输出 JSON Schema 资产,与 `src/models.ts` 的 zod 模型对应;改 schema 要两处一起改,
  `tests/golden-providers.spec.ts` 钉住。

**更新基线**:`npm run golden:update`(可带过滤,如 `npm run golden:update -- screener`)让 `expectSame` 在差异处把实际值写回文件,
串行跑以免多个 worker 同时写 `_bars.json`;跑完逐条看 diff,每一处变化都应当是你有意改的行为。`toBe` / `toEqual` 钉住的常量、
经过转换再比的期望值、`fixture.db` 不会自动改,按报错手改。

默认读仓库根的 `prompts/` 与 `config/settings.json`(向上查找,src/ 与 dist/src/ 两种布局都能落到同一处);
`DAFRI_PROMPT_DIR`、`DAFRI_CONFIG` 可覆盖,打包版由 Electron 外壳显式指定。
