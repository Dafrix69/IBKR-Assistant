# 依赖选型:哪些交给成熟的包,哪些自己写

这个仓库对第三方依赖是克制的——打进安装包的每一个字节都要跟着版本走。但"克制"不等于什么都自己造:
凡是**别人做得更对、更全**的事(协议客户端、重试退避、状态容器、日历),用现成的;凡是**行为被黄金基线逐字节钉住**、
或者语义本来就是本项目特有的,自己写并用测试钉住。

## 用了什么

| 包 | 在哪 | 为什么是它 |
|---|---|---|
| `@stoqey/ib` | engine-ts | IBKR TWS API 的 TypeScript 实现。自己实现券商协议不现实 |
| `futu-api` | engine-ts | 富途官方 SDK(protobuf 协议) |
| `better-sqlite3` | engine-ts | 同步 API,交易记录是 append-only 单写者;自带各平台预编译二进制,装机不需要 C++ 工具链 |
| `@anthropic-ai/sdk` | engine-ts | Anthropic 官方 SDK:structured outputs、prompt caching、重试 |
| `openai` | engine-ts | OpenAI 兼容端点(DeepSeek / 通义 / Kimi / 智谱)走官方 SDK:**429 / 5xx / 连接中断自动指数退避重试**、超时、带 `status` 的错误类型。原来是手写 fetch,一次网络抖动就是一条指令白发,降级判断还得在错误文字里找 "400" |
| `zod` | engine-ts | 模型输出的复校验。schema 资产(`baseline/llm/*.json`)与 zod 模型一起改 |
| `@napi-rs/keyring` | engine-ts | 系统凭证库(macOS Keychain / Windows 凭据管理器),原生 N-API,一次读写 3 毫秒内。原来 Windows 侧是 PowerShell 调 DPAPI:每次解密**同步**起一个进程约 0.8 秒,占住引擎事件循环、盯盘节拍器晚一拍——为此加过的进程内缓存与后台预热两层补丁一起删掉了 |
| `@stdlib/math-base-special-erf` | engine-ts | 误差函数(Cody 有理逼近,double 精度)。黄金对拍容差 1e-9,教科书级近似过不了——数值轮子不自己造 |
| `react` + `antd` + `vite` | desktop | 界面框架与组件库(见 [ui.md](ui.md)) |
| `zustand` | desktop | 跨页状态容器。原来每个 store 各写一遍 `Set<Listener>` + `subscribe` + `emit`,16 处同样的样板;换成 `create()` 之后 store 只剩业务逻辑,对外的 `useXxx()` 契约一字未动 |
| `dayjs` | desktop | 日期格式化与"是不是今天"。AntD 的 DatePicker 本来就带它,不额外增加体积 |
| `lightweight-charts` | desktop | TradingView 的图表库,画框架:价格轴与刻度、时间轴、网格、蜡烛、量能子图、十字光标、高分屏,外加**缩放与平移**(自写的 659 行 canvas 引擎一直没有)。价格行为的叠加层用它的 primitives 自己画,规则与原来一致;为什么折线也自己画、叠加层为什么挂在看不见的载体序列上,见 [priceaction.md](priceaction.md#框架换成-lightweight-charts2026-09-13)。Apache-2.0,署名在「关于」页 |
| `electron-log` | desktop | 日志落盘。Windows 上 Electron 是 GUI 子系统:**没有控制台,stderr 也重定向不出来**,出了问题只能靠用户描述。现在主进程、引擎 stderr、渲染层报错、未捕获异常都写进 `userData/logs/main.log`(单份 4 MB、留一份旧的),路径显示在「关于」页 |
| `electron-builder` | desktop | 打包与安装器 |
| `eslint` + `typescript-eslint` | 两边各一份 | 静态检查。规则只留"写错了会出事"的那一类,不做风格警察 —— 见下 |
| `dependency-cruiser` | 两边各一份(devDependency) | 模块边界检查:依赖只能往下流(引擎 transport → orchestrate → execution → parsing → analysis → domain → util;界面 shell → pages → lib → store → bridge),不许循环。规则在各自的 `.dependency-cruiser.cjs`,`npm run depcruise`,CI 里排在 lint 之后。2026-09-17 第一次跑出引擎 8 条、界面 3 条,全是"一个小东西放错了文件"(见 `docs/reports/architecture-review-2026-09-17.md`),修完归零;此后反向依赖在 CI 就被拦住 |

引擎的生产依赖会按 `package-lock.json` 的闭包整包进安装包(`tools/stage_engine_ts.js` 会裁掉 `.d.ts` / `.map` /
测试目录 / 非本平台的预编译二进制)。加一个运行时依赖之前先想清楚它会不会把安装包撑大:`openai` 裁完约 2.8 MB。

**桌面端加运行时依赖要放 `dependencies`,不能放 `devDependencies`**:渲染层的东西(react / antd / zustand / dayjs)
由 Vite 打进产物,所以它们是 devDependencies;而主进程 `require()` 的东西(`electron-log`)必须是生产依赖,
否则 electron-builder 不会把它打进 asar,打包版一启动就崩。

## 刻意不引入的

| 想换的东西 | 现状 | 为什么不换 |
|---|---|---|
| 技术指标库(`trading-signals` / `technicalindicators`) | `backtest.ts` / `priceaction.ts` / `screener.ts` 里的 EMA / SMA / RSI / MACD / ATR / z 分数 | 各家的平滑口径(Wilder vs SMA 种子)、初值、空值处理都不一样,**换库就是换数**;而这些数字被 `baseline/` 的黄金快照逐字节钉住,还直接决定扫描页的信号。收益是少写 200 行,代价是全套基线重生成且无法逐条核对 |
| 期权定价库 | `bsPrice` / `bsGamma` / `bachelierCall` | 本来就只有十几行,且 erf 已经用的是 `@stdlib` |
| 时区库(`luxon` / `date-fns-tz` / Temporal) | `tz.ts`(94 行,Intl 查表 + 墙钟迭代校正) | 只做两件事:墙钟↔时刻、交易日历。已按 DST 边界写清楚并有测试,换库只是多一个依赖 |
| 配置校验用 zod | `config.ts` 手写校验 | 每一条错误文案都逐字节进黄金基线,换成 zod 的报错就是换掉用户看到的话 |
| JSON-RPC 库(`json-rpc-2.0` / `vscode-jsonrpc`) | `rpc.ts` 的三条道 + `rpc-client.js` | 调度语义是业务约束:**交易道严格顺序、读道并发 4、本地道即答、轮询请求给用户请求让路**(见 [engine-rpc.md](engine-rpc.md))。通用库表达不了这套优先级,而这套语义被 `tests/rpc-lanes.spec.ts` 钉着 |
| 数据请求库(`@tanstack/react-query`) | `store/*.ts` 里的 `setInterval` 轮询 | 这些循环**不挂在当前页上**:持仓追踪一秒一轮会真的发平仓单,条件单轮询是引擎触发的唯一入口,切走了还得跑。react-query 的 `refetchInterval` 跟着组件生命周期走,语义正好相反 |

## lint 只抓真错,不排版

`engine-ts/eslint.config.js` 与 `desktop/eslint.config.mjs` 各一份,`npm run lint`,两个 CI 任务里都是第一步。

**没有 Prettier,也不打算有。** 这个仓库的排版是手调过的:`MACRO_SYMBOLS` 那样的表格式对齐、
`rpc.ts` 里一行写完的短方法、成段中文注释的折行位置——交给格式化工具重排,一次提交就把这些可读性洗掉,
而且会让 `git blame` 整体失真。所以只开**能抓到真错**的规则:未使用的变量与导入、`==`、
常量条件、不可达循环、React 的 hooks 规则(K线 PA 那次定时器漂移就是依赖数组写错)。

关掉了三条只会制造噪声的:`no-promise-executor-return`(`new Promise((r) => setTimeout(r, ms))` 是标准写法)、
`require-atomic-updates`(误报出名)、`no-useless-assignment`(引擎里 `let x = 兜底值` 再在 try 里覆盖是刻意的防御写法)。
`prefer-const` 用 `destructuring: "all"`——速记解析里 `[work, m] = take(work, …)` 这种流水线解构,
拆开写反而更难读。全角空格在回测的流程图里是内容,不是笔误(`skipJSXText`)。

第一次跑出 61 条,修掉的都是真的小毛病:没用到的导入与死函数(`tickerPrice`、`firstFrom`)、
`let` 该是 `const`、正则里多余的转义、四处 `throw new Error(...)` 丢了 `cause`(现在带上原始异常,
排查时看得见根因)。

## 凭证怎么迁移过来的

旧版把密钥写在两处:macOS 的 `security` 命令(系统 Keychain 里的 generic password)、Windows 的
`%LOCALAPPDATA%/dafri/credentials.dpapi.json`(DPAPI 密文)。换成 `@napi-rs/keyring` 之后:

- **第一次读到就搬家**:凭证库里没有、旧存储里有 → 解出来写进凭证库,再把值交出来。用户无感,不用重填 Key。
- **旧的不删**:万一要回退到旧版本,那边还读得到。只有在用户**删除**这条凭证时,两边一起清掉——
  否则删完再读又被迁回来。
- `tests/keychain.spec.ts` 在 Windows 上真的造一份旧格式密文(临时 `LOCALAPPDATA`,不碰真实文件)走完这条路。

**按平台分包的原生依赖**:`@napi-rs/keyring-<platform>` 一个平台一个二进制,npm 只装当前平台那一个,
但 lock 里 12 个都在。`tools/stage_engine_ts.js` 按 lock 条目的 `os` / `cpu` 只收目标平台那一个(win32-x64 约 1.8 MB),
其余跳过;**目标平台那个不在磁盘上会直接报错**——少打一个原生包,要到用户机器上才会以 "Cannot find module" 暴露。

