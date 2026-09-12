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
| `@stdlib/math-base-special-erf` | engine-ts | 误差函数(Cody 有理逼近,double 精度)。黄金对拍容差 1e-9,教科书级近似过不了——数值轮子不自己造 |
| `react` + `antd` + `vite` | desktop | 界面框架与组件库(见 [ui.md](ui.md)) |
| `zustand` | desktop | 跨页状态容器。原来每个 store 各写一遍 `Set<Listener>` + `subscribe` + `emit`,16 处同样的样板;换成 `create()` 之后 store 只剩业务逻辑,对外的 `useXxx()` 契约一字未动 |
| `dayjs` | desktop | 日期格式化与"是不是今天"。AntD 的 DatePicker 本来就带它,不额外增加体积 |
| `electron-log` | desktop | 日志落盘。Windows 上 Electron 是 GUI 子系统:**没有控制台,stderr 也重定向不出来**,出了问题只能靠用户描述。现在主进程、引擎 stderr、渲染层报错、未捕获异常都写进 `userData/logs/main.log`(单份 4 MB、留一份旧的),路径显示在「关于」页 |
| `electron-builder` | desktop | 打包与安装器 |

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
| 凭证库(`@napi-rs/keyring`) | `keychain.ts`(macOS `security` / Windows DPAPI) | 见下:值得换,但要迁移已存的密钥,单独做 |
| 图表库(`lightweight-charts`) | `public/pa-chart.js`(659 行 canvas) | 见下:最大的一块自造轮子,但换它是一次视觉改版 |

## 还值得做,但要单独开一次

**1. 凭证存储换 `@napi-rs/keyring`。** 现在 Windows 侧用 PowerShell 调 DPAPI:每次解密要**同步**起一个 PowerShell
(实测约 0.8 秒),整个引擎的事件循环被占住——盯盘节拍器会晚一拍。代码里已经为此加了进程内缓存和后台预热两层补丁,
本质上是在绕开"用错了工具"。`@napi-rs/keyring` 直接调 Windows Credential Manager / macOS Keychain,微秒级、无子进程。
代价:①已存的密钥要一次性迁移(读旧的 `credentials.dpapi.json` 写进新库);②多一个原生依赖,`stage_engine_ts.js`
要处理按平台分包的可选依赖;③跨平台打包时目标平台的二进制要在场。

**2. K 线图换 `lightweight-charts`。** `pa-chart.js` 自己实现了蜡烛、成交量归一化、均线、关键位标签避让、
FVG/订单块色块、标记、十字光标与坐标轴刻度算法——其中约五百行是任何图表库都有的部分,而**缩放与平移至今没有**
(库里是白送的)。但价格行为的叠加层(BOS/CHoCH、FVG、扫单标记)要用它的 primitives 重写,
而且图是这个软件最显眼的界面,换等于一次视觉改版:得按 [tools/README.md](../../desktop/tools/README.md) 的做法
改前改后各出一套截图并排比。
