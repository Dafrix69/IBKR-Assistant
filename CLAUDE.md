# CLAUDE.md — IBKR-Assistant 的工作规矩

这个文件只写**约束**,不写说明。项目是什么、怎么跑、每个功能怎么设计,看 `README.md` 与 `docs/features/*.md`;
动某个功能之前先读它对应的那份 feature 文档,改完把口径的变化写回去。

## 仓库

- `engine-ts/` 交易引擎(TypeScript,Node ≥ 22,ESM,`.js` 后缀 import)。`src/` 实现、`tests/` vitest、
  `baseline/` 黄金基线。
- `desktop/` Electron。`main.js` / `preload.js` 主进程与桥,`renderer-react/src/` 界面(React + AntD 5 + zustand)。
- 引擎与界面之间只有 stdio JSON-RPC,没有端口。真实账号永远不进提示词、不进日志、不进仓库。

## 每次改完必须跑

```
cd engine-ts && npm run lint && npx tsc --noEmit && npx vitest run
cd desktop   && npm run lint && npm run ui:typecheck
```

黄金基线红了不等于代码错了,等于**行为变了**。先判断是不是刻意的:是,`npm run golden:update` 并在 commit
信息里说明改了哪个口径;不是,改代码。绝不为了让基线过而改基线。

## 引擎分层(依赖只能往下)

```
transport     rpc.ts(转出的壳)  rpc/server.ts  rpc/context.ts  rpc/contractMethods.ts  rpc/params.ts  rpc/handlers/*.ts  cli.ts
orchestrate   engine.ts  tracker.ts  services/*.ts
execution     broker.ts  futuBroker.ts  ibSession.ts  ibTypes.ts  tws.ts  futu.ts  futuBridge.ts
parsing       validator.ts  providers.ts  prompts.ts  shorthand.ts  llm.ts
analysis      backtest priceaction screener research optionwall anomaly flyexit tradereview ibtrades macro market alerts
domain        config.ts  models.ts  store.ts  positions.ts  marketdata.ts
util          py.ts  pyjson.ts  tz.ts  notify.ts  keychain.ts  killswitch.ts  protections.ts  schemaOut.ts  rpcError.ts
contract      contract/*.ts(纯类型,零 import,谁都能引)  contract/schema/*.ts(入参的 zod 校验,只给 rpc/ 用)
```

- 下层不 import 上层。`analysis` 这一层是纯计算,不认识券商、引擎、RPC,必须能离线单跑。
- 执行层只认合约、订单、行情。它需要的领域概念已经有家:持仓身份与托管单计划在 `positions.ts`,
  K 线周期表与量价快照在 `marketdata.ts`,IB 会话接口在 `ibTypes.ts`。不从 `tracker` / `priceaction` / `anomaly` 拿。
- 不许循环 import,类型环也不许(`import type` 的环说明接口放错了文件)。
- `rpc/server.ts` 只管传输、生命周期、装配,**不写业务**。一个方法属于哪个域就进 `rpc/handlers/<域>.ts`;
  handler 之间不互相 import,也不 import server——两个域都要的东西下沉:带状态的(缓存、循环、迁移标记)进
  `services/`,纯函数进 `rpc/params.ts`。`services/` 不认识 RPC,只认 `ServiceHost`;settings / router / engine
  每次从宿主现取,不在构造时存一份(配置会重载、券商会重连、引擎会重建)。
- 规则在 `engine-ts/.dependency-cruiser.cjs`,`npm run depcruise` 必须零 error(CI 里排在 lint 之后)。
  新建文件时把它归进上面某一层,并加到那条正则里。

## 界面分层

`shell → pages → lib → store → bridge`;`ui/` 与 `theme/` 只做视觉,不 import 业务。页面之间不互相 import,
要共享的下沉到 `lib/`(组件、纯函数)或 `store/`(跨页状态、轮询)。轮询循环只能在 `store/` 里,
不挂在组件生命周期上——切走页面追踪器还得跑。规则在 `desktop/.dependency-cruiser.cjs`,`npm run depcruise`。

## 引擎 ↔ 界面契约

- **新方法只能从契约加**,顺序是:`contract/<域>.ts` 写入参与返回的类型 → `contract/index.ts` 的 `RpcMethods` 登记 →
  `contract/schema/` 配入参 schema(漏了是编译错)→ 所属域 handler 用 `contractMethods({...})` 实现 → `main.js` 的
  `ALLOWED_RPC`(会发单的还要进 `SENSITIVE_RPC`)→ `preload.js` → `bridge.ts` 的 `DafriBridge` 用 `RpcParams` / `RpcResult` 写签名。
  方法要走本地道 / 读道,还要进 `server.ts` 的道表。`tests/desktop-whitelist.spec.ts` 与 `tests/contract.spec.ts` 少一处会红。
- 老方法(入参与返回还是 `Rec`)钉在 `tests/contract.spec.ts` 的 `LEGACY_METHODS`:**那张表只许变短**,碰到一个迁一个。
  迁的时候类型搬进 contract、原文件改成转出(`anomaly.ts` 是样板),不要两边各留一份。
- 契约的类型文件(`contract/` 顶层)**不 import 任何东西**:界面的 tsc 会顺着 `bridge.ts` 走进来,而 CI 里界面那一路
  不装引擎的依赖。界面只有 `bridge.ts` 能跨进引擎目录,只许 `import type`,只许进 `contract/` 顶层。
- schema 只管**结构**(有哪些字段、什么 JSON 类型);领域校验(代码形状、上限、阈值范围)留在 handler,报 handler 自己那句人话。
  不要让 schema 比老 handler 严——那是改行为(例:异动阈值一直认数字串,schema 就不能写成 `z.number()`)。
  缺必填字段归 schema 报;唯一的例外是 golden-rpc 里有请求没带它、期望的却是 handler 某句原话的字段(`ideas.update` 不带 id →
  「缺少想法 id」;`backtest.run` 只给一个坏代码 →「股票代码不合法」,检查的先后次序也算行为),用 `schema/kit.ts` 的
  `requiredButReportedByHandler()`,不要为了迁移去 `golden:update`。
- **会发单 / 授权发单的方法(`tracker.*`,以后的 `instruction.submit`)反过来,schema 必须 `.strict()`**:不认识的键当场拒。
  zod 默认把没列的键静默丢掉——对别的域无所谓,对 `tracker.add` 就是"追踪建成了,那道保护没设上"。这类方法还要登记进
  `contract/index.ts` 的 `SENSITIVE_METHODS`(`desktop-whitelist.spec` 拿它和 `main.js` 的 `SENSITIVE_RPC` 双向对)。
  动它们的入参之前先看 `tests/tracker-rpc.spec.ts`:输入是界面真实的载荷形状(数值全是字符串,`''` = 不设),迁移不许改它的断言。
- 界面拼 RPC 载荷的对象字面量要**直接标上契约类型**(`const spec: TrackerAddSpec = {…}`)。TypeScript 只对标了类型的字面量查多余的键;
  先拼成没标类型的变量再传进去,写错的键名编译期查不出来。
- 改钱路径上的文件(`tracker.ts` `engine.ts` `store.ts` `broker.ts` `flyexit.ts`)时如果本意只是动类型:改动前后各编译一次,
  去掉注释比对 `dist/src/<文件>.js`,必须逐字节一致。这比"我只改了类型"这句话可靠。
- 老方法的返回结构改字段名 = 破坏契约,而且编译器看不见。改之前 grep `renderer-react/src` 里所有用到该字段的地方。

## 类型

- `type Rec = Record<string, any>` 只允许出现在对外的四个文件:`broker.ts` `ibSession.ts` `futuBroker.ts`
  `providers.ts`(券商与模型回包的结构由对方定)。其它文件不新声明 `Rec`,新代码不用 `any`;
  SQLite 行、追踪器行、RPC 入参都有固定字段,写成接口。eslint 有一张存量豁免表(`eslint.config.js`),
  **那张表只许变短**;`rpc/` 与 `services/` 里搬家带过来的老代码共用 `services/host.ts` 的那一处声明,新 handler 不用它。
- `strict` + `noUncheckedIndexedAccess` 开着,不要用 `!` 断言绕过,用 `?? 兜底值`。

## 体积预算

引擎单文件 1,500 行、函数 150 行、页面组件 400 行。超线不是不能提交,是提交前先回答"它是不是两个东西"。
已知超线且待拆的:`engine.ts`(托管单、IB 回调各自成文件)、`broker.ts`(IB 合约工具函数成 `ibContracts.ts`)。
**往这两个文件里加新功能之前,先看它是不是该去一个新文件。**(`rpc.ts` 已于 2026-09-19 按域拆完,
最大的一个 handler 不到 450 行。)

## 加东西之前

- 新依赖:先读 `docs/features/dependencies.md` 的"刻意不引入的"表。要加,写清楚为什么现成的更对,以及打进
  安装包多大;桌面端主进程 `require` 的放 `dependencies`,渲染层的放 `devDependencies`。
- 新指标 / 新数值算法:自己写,不引技术指标库——平滑口径不同就是换数,黄金基线会全红。
- 新提示词:`prompts/` 按版本号只增不改,`config` 里 `prompt_version` 切换。
- 新功能:`docs/features/<名字>.md` 一份,写设计决策与口径,不写操作手册。事故写 `docs/journal/`。

## 不做的事

- 不接 Prettier,不开 stylistic lint 规则,不重排别人手调过的对齐。
- 不在测试里连真券商、不发真单。`tests/` 全部离线,新测试也必须离线。
- 不改 `baseline/` 里的 `.db` 与 `golden/*.json` 手工内容,只通过 `golden:update` 重生成。
- 不把 `config/settings.json`、`~/`、`.claude/` 提交进仓库。
