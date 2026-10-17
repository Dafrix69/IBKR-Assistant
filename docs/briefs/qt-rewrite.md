# 任务:把 IBKR-Assistant 从 Electron + TypeScript 重写为 Qt 6 + C++

## 为什么,以及能指望它快在哪

用户的原话:"原来的太繁冗了"。现在一个应用是四类进程(Electron 主进程、渲染进程、GPU 进程、Node 跑的引擎),
装好的 `.app` 269 MB、DMG 100 MB,其中绝大部分是 Chromium 与 `node_modules`。

先说清楚换语言**不会**让什么变快(2026-10-18 量过 `main.log`,经过见 [journal/sleep-read-as-stall.md](../journal/sleep-read-as-stall.md)):
5,425 条慢请求里量得出原因的大头都是在等——等 TWS 回合约确认(12 秒超时)、等公开行情源、等电脑醒来;
有没有算得慢的,那份日志分不出来(只有执行时长,没有 CPU 时间)。等的那几处已经在 TS 版里修掉了,排队与执行从这一版起分开记。所以重写要量、要对比的是:

| 指标 | 现在 | 怎么量 |
|---|---|---|
| 安装包 | `.app` 269 MB、DMG 100 MB | `du -sh` |
| 常驻内存(全部进程合计) | 没量(沙箱里跑不了 `ps`) | 阶段 0 在用户自己的终端里量一次,作为基线 |
| 冷启动到能看到持仓 | 没量 | 同上 |
| 界面一帧(K 线拖动、持仓一秒一刷) | 没量 | 同上 |

## 已经定下的

| 项 | 选择 | 理由 |
|---|---|---|
| 界面 | Qt 6 + Qt Quick(QML) | 用户选的。现在的卡片式、带动画的界面在 QML 里最顺手;GPU 渲染 |
| TWS 客户端 | 自己用 C++ 实现 TWS 线协议(`QTcpSocket`) | 用户选的(2026-10-18):IB 官方 C++ API 是 GPLv3,链进来整个产品就只能按 GPL 发布,以后不能再改成闭源授权(仓库现在是 MIT,要不要改授权还没定);现在的 TS 引擎靠 `@stoqey/ib`(MIT)也是自己说线协议,`ibExecHistory.ts` 已经手写过一个最小的客户端(握手、报到、按位置读字段)。不需要 Intel 的 `libbid` 与 protobuf |
| 富途 | 第一版不搬 | C++ 版在实盘上跑稳之后再加。现在的富途代码约 3,000 行 |
| 平台 | macOS + Windows | 钥匙串、睡眠、合盖、通知各写一份 Windows 实现,并在 Windows 真机上核对 |

还没定、要用户决定的:**Qt 的许可**。开源版是 LGPLv3:可以闭源卖,但 Qt 必须动态链接、用户能替换那几个库、
安装包里要带许可声明与 Qt 的源码获取方式;不想受这些约束就要买 Qt 商业许可。卖之前定下来,不影响开工。

## 进程结构

仍然是两个进程,中间仍然是 stdio 上的 JSON-RPC,契约一个字不改:

- **`IBKR-Assistant`**(Qt Quick 应用):现在 Electron 主进程 + 渲染进程的全部职责合在一个进程里——
  窗口、菜单、弹窗、通知、引擎的生与死、确认框与放行凭据(`confirm-grants`)、日志脱敏(`redact`)、条款同意、
  合盖与电源监视、诊断导出、更新检查,以及 16 个页面。
- **`ibkr-engine`**(C++,只用 Qt Core / Network / WebSockets,没有界面):现在 `engine-ts` 的全部。

为什么不合成一个进程:引擎崩了界面还在、能说清楚出了什么事、能按退出码(`EXIT_CONFIG` 78 / `EXIT_STORE` 74)决定重不重启;
而且契约就是现成的规格——**阶段 1 的 Qt 界面先接现在的 TS 引擎,阶段 2 的 C++ 引擎拿同一份契约与黄金基线对拍**,
两半各自可以单独验证,任何时候都有一个能发出去的版本。

## 技术映射

| 现在 | 换成 | 备注 |
|---|---|---|
| React 19 + AntD 6 + zustand | QML + Qt Quick Controls;跨页状态与轮询放在 C++ 的单例里(对应 `store/`) | 轮询循环仍然不挂在页面上:切走页面追踪器照跑 |
| `lib/chart/engine.ts`(自绘 K 线) | 自己的 `QQuickItem`,用场景图的几何节点画 | 照搬现在的画法与交互,不引图表库(同"不引技术指标库"的理由) |
| `@stoqey/ib` | 自己的 C++ 线协议客户端(`QTcpSocket`,引擎线程里收发,不另起读线程) | 握手报的版本区间先和现在那条连接一样(`v100..193`):各条消息的字段次序就是 TS 版此刻用的那一版,对拍才对得上;抬版本另算一件事。201 起是 protobuf,先不碰。编解码写成纯函数,测试直接喂字节;字段次序对着 MIT 的移植版(`@stoqey/ib`、rust-ibapi)核,**不照着 IB 的 GPL 源码抄**,那份源码也不进仓库 |
| `better-sqlite3` | SQLite 的 C 接口(随包带 amalgamation) | 同一个库文件直接打开:表结构、append-only 触发器、`SCHEMA_VERSION`、`VACUUM INTO` 备份全照旧 |
| `@anthropic-ai/sdk`、`openai` | `QNetworkAccessManager` 直接调 HTTP(含 SSE 流) | 提示词照旧读 `prompts/`,渲染出的指纹必须和 TS 版逐字节相同 |
| `zod` 入参校验 | 手写的结构校验,一个方法一个 | 规矩照旧:会发单的方法 `.strict()`,不认识的键当场拒 |
| `@napi-rs/keyring` | macOS `Security.framework`、Windows 凭据管理器 | 只在工作线程里调、有时限:钥匙串弹窗不许挡住盯盘(`keychain-off-the-loop` 那条) |
| `@stdlib/math-base-special-erf` | `std::erf` | 定价恒等式(`pricing-identities.spec`)先过 |
| `discordGateway.ts` | `QWebSocket` | 只读 |
| `discord-window-follow.swift` | 不动 | 本来就是单独的辅助程序 |
| Electron `powerMonitor`、`powerSaveBlocker` | IOKit `IORegisterForSystemPower`、`NSProcessInfo beginActivity`;Windows `PowerRegisterSuspendResumeNotification` | 引擎认睡眠直接用 `mach_absolute_time`(睡眠里不走)对墙钟——TS 版踩过的坑见上面那篇 journal |
| `electron-log` + `redact.js` | 自己的日志(滚动 4 MB 留一份),落盘前过同一套脱敏规则 | 脱敏规则的用例一条不少地搬过去 |
| electron-builder | `macdeployqt` + codesign + DMG;Windows `windeployqt` + 安装器 | DMG 与签名仍在用户自己的终端里做 |
| vitest(50,100 行) | QtTest | 不新引测试框架 |

## 阶段(每一段结束时测试全绿,任何时候都有一个能发出去的版本)

**0. 工具链与骨架。** `native/` 下的 CMake 工程:一个空的 QML 窗口、一个能答 `system.status` 的引擎、QtTest、CI 里加 macOS 与 Windows 两条。
线协议客户端的握手、报到、读持仓三句先通(编解码用录下来的字节测),连纸面账户读一次持仓(只读)。用 `desktop/tools/perf_snapshot.js` 采 30 次量现在的 Electron 版作为基线(内存、CPU、安装包、引擎到连上券商),冷启动另用 `hyperfine` 跑 20 次;
写 TWS 报文的录制器与回放器,在纸面账户上录一整天(见下"方法与工具")。

**1. Qt 界面接现在的 TS 引擎。** 先搬主进程的职责(上面"进程结构"那一串,每一项现在都有离线测试,跟着搬),再按用得多少搬页面:
持仓追踪 → 交易指令 → 总览 → 行情 → 其余。每一页拿预览台的同一份 mock 数据,和 React 版并排截图比对。
这一段结束时 Qt 版可以作为测试版和 Electron 版并行发。

**2. C++ 引擎,按层自下而上**(层次与依赖方向同 `CLAUDE.md` 的引擎分层):
contract → util → domain(库)→ analysis(纯计算,16,200 行,彼此独立,可以几个会话并行)→ parsing → execution(TWS)→
orchestrate(盯盘、托管单、对账)→ transport(三条道的 RPC)。每一层先把对应的 vitest 用例搬成 QtTest 再写实现。
完成标准:**同一份 `baseline/golden/*.json` 与 golden-rpc 的 96 步回放,C++ 引擎的结果与 TS 引擎一致**;参数层、机制层、定价恒等式全过。

**3. 切换。** Qt 界面接 C++ 引擎。纸面账户上把每条钱路径各走一遍(清单就是各份 feature 文档里"只有离线测试的"那一段),
之后用户看着在实盘上第一次触发。

**4. 删掉 Electron 与 TS。** 删之前 C++ 版至少完整跑过一周实盘。

## 从哪些原始素材开始

不从整理过的结论开始(feature 文档、journal、记忆里的总结都是二手的,写的时候可能就错了——2026-10-18 那篇 journal 第一稿就有一句没被日志证明的话),
从这些原始记录开始:

| 素材 | 拿来做什么 | 怎么取 |
|---|---|---|
| 原始 `main.log` | 慢在哪、停摆、重连、超时的分布 | `node desktop/tools/log_report.js` |
| `pmset -g log` | 什么时候睡、什么时候 DarkWake、为什么醒 | 用户终端里 `pmset -g log` |
| TWS 的 API 消息日志 | 每一条请求与回报的原文和时刻:TWS 到底回没回、回了什么 | TWS「全局配置 → API → 设置 → 创建 API 消息日志文件」;含账号,只在本机看 |
| 纸面账户上录下来的一整天报文 | C++ 的报文解析与盯盘逻辑的回放输入(见下"录制与回放") | 阶段 0 的录制工具 |
| 交易库 `trades.db` 的审计表 | 每一次触发、停摆(`monitor_gap`)、发单的真实顺序 | 只读打开备份,不碰正在用的那份 |
| IBKR 结单(Flex Query / 活动报表) | 成交、价格、手续费、盈亏的券商口径 | 用户从 IBKR 后台导出 |
| 正在运行的进程 | 内存、CPU、线程、卡住时的调用栈 | `node desktop/tools/perf_snapshot.js`、`sample <pid>`、`spindump`、Instruments |
| IB 的 API 参考文档与发布说明(各版本改了哪条消息的哪一格)、MIT 的移植版(`@stoqey/ib`、rust-ibapi)、Qt 与 libuv 的源码 | 行为的定义本身(消息顺序、限速 50 条 / 秒、时钟取的是哪一个) | 读源码,不读二手博客 |

## 方法与工具

- **先量后改,改完再量。** 每一项性能目标先有基线(`perf_snapshot.js` 量 Electron 版),同一份脚本量 Qt 版;每个数至少采 30 次,
  报中位数与四分位距,两版比较用秩和检验(引擎里已有 `inference.ts`),不拿单次采样下结论。冷启动用 `hyperfine` 跑 20 次。
- **分清"在等"与"在算"。** 排队与执行分开记(`[perf]` 那一行已经有);C++ 版再加每条 RPC 的 CPU 时间。剖析用 Instruments
  (Time Profiler、Allocations、System Trace)、`sample`;界面一帧用 Qt Quick 的 `QSG_RENDER_TIMING=1` 与 QML Profiler。
- **对拍,不是重写完再测。** 同一份输入喂给 TS 引擎与 C++ 引擎,逐字段比结果:先是黄金基线与 golden-rpc 的 96 步,
  再是录下来的一整天纸面账户报文;C++ 版先以"影子"方式跑在 TS 版旁边(只算、不发单),结果每一轮比对、不一致落日志,连续一周零差异才切换。
- **录制与回放。** 阶段 0 写一个录制器:在纸面账户上把 TWS 的回报原文按时刻录下来;回放器按原来的时刻(或加速)喂给引擎。
  盯盘、托管对账、断线重连、合约确认超时都用真实报文回放,而不是手写的假 TWS。
- **故障注入。** 每条钱路径都要过这张表:TWS 不回合约确认、断线重连、回报乱序 / 重复、合盖睡眠与 DarkWake、墙钟往回拨、
  钥匙串弹窗不点、库文件写满、引擎崩溃在发单途中。假 TWS(`tests/fakeTws.ts` 的那一套搬过去)负责注入。
- **C++ 自己的那一套。** CI 里每次都跑 AddressSanitizer + UndefinedBehaviorSanitizer 一遍、ThreadSanitizer 一遍(界面线程与引擎线程之间、Qt 网络回调与引擎状态之间
  是最容易出数据竞争的地方)、`clang-tidy`;速记解析器、RPC 的 JSON 入参、TWS 报文解码用 libFuzzer 各跑一份模糊测试,
  种子就是现有用例与录下来的报文。金额与价格不用 `float`,比较的容差照抄 TS 版。
- **决定切不切,有明文的条件。** 切换前逐条打勾:对拍零差异、故障注入表全过、纸面账户每条钱路径各触发过一次、性能比基线好(秩和检验显著)、
  回退办法写好且演练过(Electron 版留着、一键换回)。缺一条不切。

## 除了写代码的人,还有什么能证明它是对的

| 证据 | 证明什么 |
|---|---|
| IBKR 自己的结单与 TWS 的 API 消息日志 | 发出去的单、成交、价格是不是和软件记的一样 |
| `pmset -g log` | 睡眠、唤醒的判断对不对 |
| 标准正态分布表、Black–Scholes 解析解、平价关系这些和实现无关的答案 | 定价函数对不对(`pricing-identities.spec.ts`) |
| 老实现(TS 引擎)本身 | 同样的输入,新实现的输出一样(对拍) |
| 干净机器上的 CI(GitHub Actions 的 macOS 与 Windows) | 不依赖这台机器上的状态 |
| 纸面账户上的真实触发 | 端到端真的发得出、平得掉 |
| 另一个人的审查(独立的代码审查会话或人) | 写代码的人看不见的错 |
| 统计检验 | 性能"变快了"不是噪声 |

## 不变的规矩

`CLAUDE.md` 里的约束全部照搬到 C++ 上,尤其是:真实账号不进提示词、日志、仓库;会发单的通道要用户在原生确认框里点过的一次性凭据;
平仓不比开仓严;测试全部离线、不连真券商;黄金基线只能重生成不能手改;**重写里不顺手改行为**,发现疑似问题记下来、照原样搬。

## 体量

这是这个项目到现在最大的一件事:产品代码约 87,000 行(引擎 56,500、界面 21,300、主进程 4,800、工具 4,200),测试 50,100 行。
上一次 Python → TS 搬的是 1.3 万行。阶段 2 的 analysis 层可以并行,其余基本是串行的;钱路径的真机核对要用户的时间。

## 开工前要用户做的

1. 工具链已装(2026-10-18):`brew install qtbase qtdeclarative qtwebsockets qtsvg qttools cmake ninja` → Qt 6.12.0、CMake 4.4.4、Ninja 1.13.2,`-DCMAKE_PREFIX_PATH=/opt/homebrew`;一个 Qt Quick + Controls + WebSockets + Svg 的测试程序已经编过、跑通。链接要在用户的终端里做(沙箱写不了 xcrun 的缓存);QML 模块的 URI 不要和目标同名(大小写不敏感的盘上撞目录)。
2. TWS 线协议自己实现,不用下载 IB 的 API。本机 `~/Downloads/twsapi_macunix*` 里那两份 GPL 源码不要拷进仓库、也不照着写。
3. Windows 那一路要一台 Windows 机器做真机核对(阶段 1 结束前)。
4. 卖之前:Qt 许可(LGPL 还是商业)。
