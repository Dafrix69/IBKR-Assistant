/** 引擎的模块边界。规则跟 eslint 一个口径:只写"违反了会出事"的那几条。
 *  依赖只能单向往下流:
 *    transport(rpc.ts、rpc/、cli) → orchestration(engine/tracker、services/) → execution(broker、futuBroker、ibSession、tws、futu)
 *    → validation/parsing(validator/providers/prompts/shorthand) → analysis(纯计算) → domain(config/models/store) → util
 *    → contract(引擎 ↔ 界面的契约:顶层是纯类型、零依赖,谁都能引;contract/schema/ 是入参的运行时校验,只给 rpc/ 用)
 */
const L = {
  contractTypes: "^src/contract/[^/]+\\.ts$",
  util:        "^src/(py|pyjson|tz|notify|keychain|killswitch|protections|rpcError)\\.ts$",
  domain:      "^src/(config|models|store|importedTrades|positions|marketdata)\\.ts$",
  analysis:    "^src/(backtest|priceaction|screener|research|ideaRetrieval|optionwall|anomaly|flyexit|tradereview|tradeOutcomes|fillsCsv|optionTradesCsv|optionPositionsCsv|tradeSimilar|ibtrades|macro|market|alerts)\\.ts$",
  parsing:     "^src/(validator|providers|prompts|shorthand|llm)\\.ts$",
  execution:   "^src/(broker|ibContracts|futuBroker|ibSession|ibTypes|tws|futu|futuBridge)\\.ts$",
  orchestrate: "^src/((engine|tracker)\\.ts|(engine|services)/[^/]+\\.ts)$",
  transport:   "^src/((rpc|cli)\\.ts|rpc/.+\\.ts)$",
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
    { name: "util-bottom", severity: "error", comment: "util 不依赖任何业务模块(契约的类型文件在它下面,可以引:protections.ts 的配置形状就定义在那里)",
      from: { path: L.util }, to: { path: "^src/", pathNot: [L.util, L.contractTypes] } },
    { name: "contract-types-import-nothing", severity: "error",
      comment: "契约的类型文件只许互相引用:界面的 tsc 会顺着 bridge.ts 的 import type 走进来,而 CI 里界面那一路不装引擎的依赖、也没有 node 的类型",
      from: { path: L.contractTypes }, to: { pathNot: L.contractTypes } },
    { name: "contract-is-bottom", severity: "error",
      comment: "契约在最底下:contract/(含 schema/)不依赖引擎的任何模块,schema 只认 zod 和同目录的类型",
      from: { path: "^src/contract/" }, to: { path: "^src/", pathNot: "^src/contract/" } },
    { name: "schema-is-for-rpc", severity: "error",
      comment: "入参的运行时校验是传输层的事:contract/schema/ 只给 rpc/ 用,别的层要形状就引上一层的类型文件",
      from: { path: "^src/", pathNot: "^src/(rpc/|contract/schema/)" }, to: { path: "^src/contract/schema/" } },
    { name: "rpc-outermost", severity: "error",
      comment: "传输层是最外层:rpc.ts / rpc/ / cli.ts 之外谁也不 import 它们——services/ 不认识 RPC,离线能单跑",
      from: { path: "^src/", pathNot: L.transport }, to: { path: L.transport } },
    { name: "rpc-facade-one-way", severity: "error",
      comment: "rpc.ts 只是转出的壳:rpc/ 里的实现不回头 import 它,也不 import cli",
      from: { path: "^src/rpc/" }, to: { path: "^src/(rpc|cli)\\.ts$" } },
    { name: "handlers-are-leaves", severity: "error",
      comment: "handler 之间不互相 import,也不 import server:两个域都要的东西下沉到 services/(带状态)或 rpc/params.ts(纯函数)",
      from: { path: "^src/rpc/handlers/" }, to: { path: ["^src/rpc/handlers/", "^src/rpc/server\\.ts$"] } },
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
