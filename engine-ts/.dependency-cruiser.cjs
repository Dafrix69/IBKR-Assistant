/** 引擎的模块边界。规则跟 eslint 一个口径:只写"违反了会出事"的那几条。
 *  依赖只能单向往下流:
 *    transport(rpc/cli) → orchestration(engine/tracker) → execution(broker、futuBroker、ibSession、tws、futu)
 *    → validation/parsing(validator/providers/prompts/shorthand) → analysis(纯计算) → domain(config/models/store) → util
 */
const L = {
  util:        "^src/(py|pyjson|tz|schemaOut|notify|keychain|killswitch)\\.ts$",
  domain:      "^src/(config|models|store|positions|marketdata)\\.ts$",
  analysis:    "^src/(backtest|priceaction|screener|research|optionwall|anomaly|flyexit|tradereview|ibtrades|macro|market|alerts)\\.ts$",
  parsing:     "^src/(validator|providers|prompts|shorthand|llm)\\.ts$",
  execution:   "^src/(broker|futuBroker|ibSession|ibTypes|tws|futu|futuBridge)\\.ts$",
  orchestrate: "^src/(engine|tracker)\\.ts$",
  transport:   "^src/(rpc|cli)\\.ts$",
};
module.exports = {
  forbidden: [
    { name: "no-circular", severity: "error", comment: "循环依赖:两个模块互相 import,改一个必须懂另一个",
      from: {}, to: { circular: true } },
    { name: "analysis-is-pure", severity: "error",
      comment: "纯计算模块不准知道券商、引擎、RPC 的存在——它们的行为被黄金基线钉着,必须能离线单跑",
      from: { path: L.analysis }, to: { path: [L.execution, L.orchestrate, L.transport, L.parsing] } },
    { name: "execution-not-above", severity: "error",
      comment: "下单层不准依赖分析层 / 编排层:券商适配器只认合约、订单、行情",
      from: { path: L.execution }, to: { path: [L.analysis, L.orchestrate, L.transport] } },
    { name: "domain-bottom", severity: "error",
      comment: "config / models / store 是地基,只能依赖 util",
      from: { path: L.domain }, to: { path: [L.analysis, L.parsing, L.execution, L.orchestrate, L.transport] } },
    { name: "util-bottom", severity: "error", comment: "util 不依赖任何业务模块",
      from: { path: L.util }, to: { path: "^src/", pathNot: L.util } },
    { name: "only-cli-imports-rpc", severity: "error", comment: "rpc.ts 是最外层,只有 cli 和测试能 import 它",
      from: { path: "^src/", pathNot: "^src/cli\\.ts$" }, to: { path: "^src/rpc\\.ts$" } },
    { name: "no-orphans", severity: "warn", from: { orphan: true, pathNot: "\\.d\\.ts$" }, to: {} },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "require", "node", "default"], extensions: [".ts", ".js"] },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
