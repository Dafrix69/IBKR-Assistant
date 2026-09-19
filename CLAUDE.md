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
transport     rpc.ts  cli.ts
orchestrate   engine.ts  tracker.ts
execution     broker.ts  futuBroker.ts  ibSession.ts  ibTypes.ts  tws.ts  futu.ts  futuBridge.ts
parsing       validator.ts  providers.ts  prompts.ts  shorthand.ts  llm.ts
analysis      backtest priceaction screener research optionwall anomaly flyexit tradereview ibtrades macro market alerts
domain        config.ts  models.ts  store.ts  positions.ts  marketdata.ts
util          py.ts  pyjson.ts  tz.ts  notify.ts  keychain.ts  killswitch.ts  protections.ts  schemaOut.ts
```

- 下层不 import 上层。`analysis` 这一层是纯计算,不认识券商、引擎、RPC,必须能离线单跑。
- 执行层只认合约、订单、行情。它需要的领域概念已经有家:持仓身份与托管单计划在 `positions.ts`,
  K 线周期表与量价快照在 `marketdata.ts`,IB 会话接口在 `ibTypes.ts`。不从 `tracker` / `priceaction` / `anomaly` 拿。
- 不许循环 import,类型环也不许(`import type` 的环说明接口放错了文件)。
- 规则在 `engine-ts/.dependency-cruiser.cjs`,`npm run depcruise` 必须零 error(CI 里排在 lint 之后)。
  新建文件时把它归进上面某一层,并加到那条正则里。

## 界面分层

`shell → pages → lib → store → bridge`;`ui/` 与 `theme/` 只做视觉,不 import 业务。页面之间不互相 import,
要共享的下沉到 `lib/`(组件、纯函数)或 `store/`(跨页状态、轮询)。轮询循环只能在 `store/` 里,
不挂在组件生命周期上——切走页面追踪器还得跑。规则在 `desktop/.dependency-cruiser.cjs`,`npm run depcruise`。

## 引擎 ↔ 界面契约

- 加一个 RPC 方法要同时改四处:`rpc.ts` 的 `methods()`、`main.js` 的 `ALLOWED_RPC`(会发单的还要进
  `SENSITIVE_RPC`)、`preload.js`、`bridge.ts` 的 `DafriBridge`。少一处 `tests/desktop-whitelist.spec.ts` 会红。
- 契约收口(待做,见 `docs/reports/architecture-review-2026-09-17.md` 第一条):方法的入参 schema 与返回类型统一放
  `engine-ts/src/contract/`,`bridge.ts` 用 `import type` 引用。目录建起来之后,**新方法只能从 contract 加**;碰到老方法顺手迁一个。
- 返回结构改字段名 = 破坏契约。改之前 grep `renderer-react/src` 里所有用到该字段的地方。

## 类型

- `type Rec = Record<string, any>` 只允许出现在对外的四个文件:`broker.ts` `ibSession.ts` `futuBroker.ts`
  `providers.ts`(券商与模型回包的结构由对方定)。其它文件不新声明 `Rec`,新代码不用 `any`;
  SQLite 行、追踪器行、RPC 入参都有固定字段,写成接口。
- `strict` + `noUncheckedIndexedAccess` 开着,不要用 `!` 断言绕过,用 `?? 兜底值`。

## 体积预算

引擎单文件 1,500 行、函数 150 行、页面组件 400 行。超线不是不能提交,是提交前先回答"它是不是两个东西"。
已知超线且待拆的:`rpc.ts`(按域拆 `rpc/handlers/*.ts`,带状态的循环进 `services/`)、`engine.ts`
(托管单、IB 回调各自成文件)、`broker.ts`(IB 合约工具函数成 `ibContracts.ts`)。**往这三个文件里加新功能之前,
先看它是不是该去一个新文件。**

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
