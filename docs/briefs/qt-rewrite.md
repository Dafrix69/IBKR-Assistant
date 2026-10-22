# 任务:把 Datrix 从 Electron + TypeScript 重写为 Qt 6 + C++

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

- **`Datrix`**(Qt Quick 应用):现在 Electron 主进程 + 渲染进程的全部职责合在一个进程里——
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
| `lib/chart/engine.ts`(框架是 TradingView 的 lightweight-charts 5.2.1,Apache-2.0;业务叠加层自己画) | 自己的 `QQuickItem`:蜡烛、量柱、网格、折线、区域、标记用场景图的几何节点画,轴上的刻度、十字光标读数、叠加层的字用子项 `Label`(`--dump-texts` 量得到) | 照搬它此刻画出来的样子与交互(刻度怎么挑、初始铺满、最小柱宽、拖动 / 滚轮 / 拖轴缩放、双击复位),不引图表库(同"不引技术指标库"的理由)。库的算法读它的源码(Apache-2.0,可以读)后自己写;对拍在刻度与坐标那一层(公开 API 读出来的可见范围、`timeToCoordinate` / `priceToCoordinate`,`fillText` 量出来的轴上的字),不比画路径 |
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

阶段 0 的现状(怎么编、怎么在 VS Code 里跑见 [native/README.md](../../native/README.md)):

| 项 | 状态 |
|---|---|
| CMake 工程、空的 QML 窗口、能答 `system.status` 的引擎(形状对着契约,值大多是空的)、QtTest | 有,沙箱里编过、全绿(含 ASan + UBSan、TSan 各一遍) |
| 线协议的握手、报到、读持仓 | 有。期望值两层:照抄 `ib-exec-history.spec.ts` 的字节;`tests/fixtures/stoqey-v193.json` 拿 TS 引擎在用的 `@stoqey/ib` 现算(28 条读进来的、7 条发出去的,含 NaN、千分位、`\uXXXX`、截断的消息),外加 JS 的 `parseInt` / `parseFloat` 的 104 个读法 |
| 录制器与回放器 | 有:`tws-positions --record`、`tws-replay`;回放逐块对写出去的字节 |
| 连纸面账户读一次持仓 | **没做**:要用户开着纸面账户的 TWS,在 VS Code 或终端里跑 `tws-positions --port 7497` |
| CI(`.github/workflows/native.yml`,macOS 与 Windows) | 写了,**还没在 GitHub 上跑过**;单独一条,不挡 `ci.yml` |
| Electron 版的性能基线、纸面账户录一整天 | 没做,要用户的终端与时间 |

对拍时已知的差别(记下来,没有顺手改 TS 版):

- stdin 上一行是 JSON 的标量(`null`、`5`、`"x"`、`true`):TS 引擎在 `server.ts` 的 `rl.on("line")` 里抛 TypeError
  (`null["method"]`;其余是 `WeakMap.set` 拿到非对象的键),没有 `uncaughtException` 兜底,整个引擎退出。C++ 版回 -32700。
  只有 Electron 主进程往这个 stdin 写、写的都是对象,实际碰不到。
- JSON 的键序:TS 照插入的先后写,`QJsonObject` 按字母排。对拍比的是解析后的值,不比字节。诊断包里引擎回来的那几段(状态、自检、备份)
  因此键是排过序的;配置文件那一段与写回去的配置用 `shell/ordered_json`,和 Electron 版逐字一致。
- 读不进来的 JSON:报错的那半句是 V8 的原文(`Unexpected end of JSON input`),Qt 版是自己的话;前半句(「没有可用的备份:」之类)一样。
- 诊断信息的摘要第二行,Electron 版写 Electron 与 Node 的版本,Qt 版写 Qt 的版本。
- 首次启动从示例建出配置时,Electron 主进程发了一条 `bootstrap` 消息,React 版没有人接(迁移时丢了),那句话从没显示过;
  Qt 版照原来的意思显示在横幅上。
- 提醒里没有 id 的一条:清洗时整条丢掉,弹窗回"收下 0、丢掉 0",于是也不补系统通知——两版一样,调用方都带 id。
- 异动提醒的"人就在这一页":React 版问的是 `getTab() === 'quality'`,而当前页只会是侧栏项(`sectors`),所以永远算"没看见"、未读数照加;
  板块页自己在看得见、窗口在前台时清零,所以看不出来。Qt 版照搬(`QualityStore::onAnomaly`),没有顺手改。
- 盯盘心跳停了看不出来(疑似 React 版的缺陷,照搬没改):`store/tracker.ts` 的 `pollTrackers` 在盯盘行没变时,只在 `ticks` 或 `last_error`
  变了才换心跳。节拍器真停了的时候 ticks 不再动、`age_ms` 越来越大,可心跳那一份不换,页面上那行就一直是「盯盘:引擎每 1 秒一轮」,
  「已经 N 秒没跳了」「没在跑」永远出不来(`running`、`hold` 变了也一样)。Qt 版 `TrackerStore::poll` 照搬。
- 界面的本机偏好:React 版记在 localStorage,Qt 版记在 `userData/qt-settings.ini`,Electron 版里设过的**不会带过来**
  (localStorage 在 Chromium 的 leveldb 里,读它不值得)。所有这些偏好的默认值都是"开"或空,所以换过来只会多提醒、不会漏:

  | React 版(localStorage) | Qt 版(qt-settings.ini) |
  |---|---|
  | `dafri-alert-popup` / `dafri-alert-sound` | `alerts/popup` / `alerts/sound` |
  | `dafri-updown`(store/appearance.ts) | `alerts/updown`(只这一份:设置页改的是 `Theme.upDown`,Main.qml 写回 Alerter,提醒小窗跟着它) |
  | `dafri-theme` / `dafri-glass`(store/appearance.ts) | `Dafri/Datrix.ini` 的 `appearance/theme` / `appearance/glass`(`Theme` 里的 QML Settings) |
  | `dafri-spot-level-alert` | `spot/alert` |
  | `dafri-playbook-alert` | `playbook/alert` |
  | `dafri-intel-recent` | `intel/recent`(JSON 数组) |
  | `dafri-update-auto` / `dafri-update-dismissed` | `update/auto` / `update/dismissed` |
  | `dafri-sidegroup-*`、`dafri-shell-tab` | QML `Settings` 的 `shell/collapsedJson`、`shell/tab`——**不在 qt-settings.ini**,在 `userData/Dafri/Datrix.ini`(main.cpp 把 QSettings 的默认位置改到了 userData,跟 `IBKR_USER_DATA_DIR` 走) |
  | `dafri-primer-<id>`(参考资料折叠的记忆) | 同上那份 `Dafri/Datrix.ini` 的 `primer/<id>` |
  | `dafri-submit-accounts`(交易指令页的发单账户勾选) | `trade/accounts`(JSON 数组) |
  | `dafri-record-density`(交易记录的疏密) | `records/density`(`cozy` / `compact`,同上那份 `qt-settings.ini`) |
  | `dafri-pa-symbol` / `dafri-pa-timeframe` / `dafri-pa-rth`、`dafri-book-symbols`(行情页) | `market/symbol` / `market/timeframe` / `market/rth`(`1` / `0`)、`market/books`(JSON 数组),同上那份 `qt-settings.ini` |
  | `dafri-screener-sector`(扫描页选中的股票池) | `screener/sector`(板块 id 或 `all`,同上那份 `qt-settings.ini`) |
  | `dafri-review-record` / `-timeframe` / `-em-manual` / `-kind`(交易分析页) | `review/record` / `review/timeframe` / `review/em-manual`(空 = 自动)/ `review/kind`,同上那份 `qt-settings.ini` |
  | `dafri-perf-scope` / `-kind` / `-days`、`dafri-sizer-equity` / `-pct`(绩效体检页) | `perf/scope` / `perf/kind` / `perf/days`、`sizer/equity` / `sizer/pct`(不是正数当没填,比例兜底 1),同上那份 `qt-settings.ini` |

- 确认框没弹成(桥报错,例如引擎问不到账户类别以外的原因):Qt 版当作点了取消、什么都不发,并在日志里记一行;React 版那里是一个没人接的 reject,
  结果同样是什么都不发,只是控制台多一条未处理的 Promise 拒绝。发单、平仓、新建追踪几处一样。
- 字宽(量过、已校正,`kit/Label.qml` + `Theme.trackFix`,量法在 `tools/font_widths.qml`):
  · 小数像素:Qt 的字体引擎只认整数像素,11.5px 在 macOS 的窗口里按 12 画、无窗口平台按 11 画。Label 按往上取整的像素排、整段缩回去;
  · 无窗口平台(截图、对比)默认 96 DPI,系统字体按点数定字距,12px 被当成 9pt 去取,拉丁字母宽 3%:无窗口平台一律按 72 DPI(同 macOS 的窗口,`main.cpp`);
  · 系统字体自带按字号的字距表(trak),CoreText 用、Chromium 不用;苹方在 Chromium 里也宽一点;中点 `·` 两边的字形宽不一样。差多少是两边同一段字逐字号量出来的,
    Label 按这段字里拉丁与汉字各几个摊成字距,整段宽对得上;
  · 系统字体是可变字体,Qt 不给 `wght` 轴时只取最近的一档(650 → 590):Label 给轴;
  · 富文本里内联的小数像素(`<span style="font-size:9.5px">`)救不了,只有事件列表的标题一处,宽差不到 1px。
  剩下的差:⌘ ↩ ⇧ 混在中文里时宽差 4–6px(交易指令页的快捷键说明);日内剧本表格的数字列。
  贴着行宽的地方要先查样式对不对,别先怪字体:蝴蝶测算的时刻快捷钮曾经折行,原因是 Qt 版给它们开了等宽数字(原版只有点位钮开);
  日内剧本的表曾经宽 19px,原因是「取价」列漏了 .muted(11px 二级色)。
- 着色器效果(玻璃背后的模糊、投影、吸顶页头的玻璃):沙箱里截图用的是 Qt 的软件渲染(无窗口平台,也拿不到 Metal 设备),着色器一律画不出来,
  截图里只有着色那一层。真机的 Metal 下才看得到,在真机清单里。
- JSON 的键序在界面上露出来的地方:`QJsonObject` 把键按字母排,React 版 `Object.entries` 是引擎插键的先后。已知的一处是新建追踪试算里
  每条腿的 σ(`leg_sigmas`):引擎按持仓合约里各腿的次序插(`tracker.ts` 的 `structureOf`),Qt 版照合约的腿重排(`shell/track_form`)。
  以后搬页面时,凡是 React 版对引擎回来的对象做 `Object.entries` / `Object.keys` 摆给人看的,都要按同样的办法找到次序的来历。
- 开发态(`appInfo.dev`):源码运行且 `DAFRI_DEV=1` 才算,同 main.js 的 `DEV`。打包版靠编译定义 `IBKR_PACKAGED` 一律算否——
  **现在还没有任何地方定义它**,做打包的时候要在打包的预设里加上,不然打包版带着 `DAFRI_DEV=1` 启动会被当成开发态、不自动检查更新。

**1. Qt 界面接现在的 TS 引擎。** 先搬主进程的职责(上面"进程结构"那一串,每一项现在都有离线测试,跟着搬),再按用得多少搬页面:
持仓追踪 → 交易指令 → 总览 → 行情 → 其余。每一页拿预览台的同一份 mock 数据,和 React 版并排截图比对。
这一段结束时 Qt 版可以作为测试版和 Electron 版并行发。

阶段 1 的现状:

| 项 | 状态 |
|---|---|
| 引擎的生与死(`native/shell/`):拉起、先死后生的重启、排空再停、迟到的回执、退避(`rpc-client.js`);退出码 78 / 74 不重启、别的退避重启、心跳、条件单轮询(`main.js`);状态快照(`store/status.ts`);窗口底部的状态条 | 有。`desktop-engine-client.spec.ts` 的 16 条逐条搬成 QtTest,外加退避、心跳、状态快照、单实例的用例;对着假引擎跑,另有一条接真的 TS 引擎(设了 `IBKR_TS_ENGINE_ROOT` 才跑,配置现写一份、不连券商、库在临时目录) |
| 单实例:Electron 版开着时不拉引擎(认它的 `SingletonLock`),两个 Qt 版不能同时开 | 有,只在 macOS / Linux 上认得出 Electron 版 |
| 确认框与放行凭据(`confirm-grants.js`)、RPC 白名单与会发单的那几条(`main.js` 的 `ALLOWED_RPC` / `SENSITIVE_RPC`) | 有(`shell/confirm_grants`、`shell/bridge`、`shell/rpc_policy`)。期望值由 node 跑原模块现算(`tests/fixtures/gen_confirm_grants.mjs`),每个判断都做过反向检验 |
| 条款同意(`consent.js` + `ConsentGate.tsx`):与 Electron 版共用同一份同意记录;条款正文照 `docParse.ts` 切块(`shell/doc_parse`,对照数据 `gen_doc_parse.mjs`),不用 Qt 的 Markdown——CommonMark 不认句号贴着 `**` 的加粗 | 有 |
| 外壳:统一工具栏(连接 / 熔断两个按钮)、源列表侧栏(三组、徽标、⌘1…9)、通知条、提示;主题与基础控件(`Dafri.Kit`) | 有。页面先是占位("这一页还在 Electron 版里") |
| 预览引擎(`desktop/tools/preview_engine.js`):说同一套 RPC、回预览台的 mock 数据,`--engine preview` 才用,默认不用 | 有。`--screenshot` 抓图;自检与截图时 QML 报任何一条警告都以退出码 6 失败 |
| 顶栏下面的两条:重要事件(`store/events.ts` + `EventStrip` / `EventList` / `EventActions`)与宏观行情带(`store/macro.ts` + `MacroStrip`) | 有(`shell/event_rules`、`shell/events_store`、`shell/macro_store`)。判定逐条对着原模块现算的 280 条(`gen_event_rules.mjs`);节拍与派生对着假引擎测。「应对」写进的指令框随交易指令页接 |
| 提醒:置顶小窗(`popup-window.js` + `popup/`)、提示音、系统通知、通知流 | 有(`shell/popup_rules`、`shell/alerter`、`shell/alert_tone`、`app/popup_controller`、`AlertPopup.qml`、`app/platform_mac.mm`)。清洗与摆放对着原模块现算(`gen_popup.mjs`);提示音照 Web Audio 那段包络合成 WAV(Homebrew 的 Qt 不带 Multimedia),macOS 用 NSSound 放;系统通知用 UNUserNotificationCenter。小窗不抢焦点、浮在所有桌面与全屏之上、Dock 跳——这几样只能在真机上看 |
| 日志落盘与脱敏(electron-log + `redact.js`) | 有(`shell/log_file`、`shell/redactor`):`userData/logs/qt-main.log`,4 MB 一份、留一份旧的,行的样子同 electron-log(`log_report.js` 照样读);脱敏对着原模块现算的 93 条(`gen_redact.mjs`) |
| 菜单栏、Dock 菜单、关窗只藏、点 Dock 叫回、窗口位置记忆、单实例(第二次打开叫前一个到前台)、⌘Q 先停引擎再退 | 有(`app/desktop_shell`、`shell/window_state`)。窗口位置与 Electron 版共用 `window-state.json`。单实例那条测试在沙箱里绑不了 Unix 套接字,自动跳过 |
| 电源与合盖(`power-watch.js`、`lid-guard.js`) | 有(`shell/power_guard` 对着原模块驱动同一串事件现算的输出逐步对,`gen_power.mjs`;`app/power_controller` 接 IOKit / NSWorkspace / `pmset` / `osascript`)。`lid-guard.json` 与 Electron 版共用 |
| 配置坏了、交易库打不开时的对话框与恢复(`config-guard.js`、`store-guard.js`、`handleStoreFatal`) | 有(`shell/config_guard`、`shell/store_guard`、`app/fatal_dialogs`),在真文件上对着原模块现算(`gen_config_guard.mjs`、`gen_store_guard.mjs`)。写回配置保持键的次序(`shell/ordered_json`,`JSON.stringify(…, null, 2)` 逐字一致) |
| 「支持与数据」:导出 / 复制诊断、打开所在位置、账户增删改、从备份恢复交易库、检查新版本、外部链接白名单、首次启动从示例建配置 | 有(`shell/diagnostics`、`shell/accounts_setup`、`shell/update_check` 对着原模块现算;`app/support_service` 对着假引擎、临时目录与本机的假 GitHub)。界面上的按钮随「关于」「接入」页一起接,菜单里的「导出诊断信息…」已经能用。没接真引擎(预览、自检、截图)时只读:改账户、恢复交易库当场拒,不问、不写(原版的预览台没有主进程,这两条路根本不存在)|
| 不看当前在哪一页的提醒循环:价位警告 10 秒一轮(`store/alerts.ts`)、SPX 走到 25 的整数倍(`store/spot.ts`)、日内剧本 / 异动 / 情报三路引擎推送(`store/playbook.ts`、`quality.ts`、`intel.ts`)、新版本检查(`store/update.ts`,顶栏的「新版本」) | 有(`shell/alerts_store`、`spot_store`、`feed_stores`、`update_store`;判定在 `shell/alert_rules`、`track_levels`、`spot_levels`、`playbook_format`、`intel_rules`,对着原模块现算的 `gen_alert_rules.mjs`、`gen_spot_levels.mjs`、`gen_feed_rules.mjs`)。节拍、一批一声、弹窗没收下退回系统通知对着假引擎测。新版本只在接真引擎时自动问,预览与自检不去问网络。`Bridge` 的回调带 context:store 先于引擎析构时迟到的回包不再打到已经没了的对象上 |
| 持仓追踪页 | 有(`app/pages/TrackerPage.qml` 等;数据 `shell/tracker_store`、新建追踪 `shell/track_form`、卡片按钮 `shell/track_actions`、价位条 `shell/level_strip`、
接线 `shell/tracker_controller`)。整页的字对着 React 页面 SSR 渲染的 15 个场景逐段相同;新建追踪把 `TrackForm.tsx` 的 `start()` 原样切出来跑 27 个场景逐步对拍,
载荷过引擎的 zod schema;新建 / 立即平仓 / 暂停恢复经真的桥对着假引擎端到端测过。排版用 `tools/compare_texts.mjs` 对过:页面上半截、追踪卡片在 2px 内,
表单每行在 1px 内。验收与 review 各过了一遍,19 + 4 条全修(受控的表单控件、
按键原地更新的列表、确认框挡住整个应用、断开 / 连回时整读、「查看」跳过来闪卡片、吸顶的页头……)。
自动平仓 / 立即平仓后的 `recordsStale` 接到交易记录那一份 store 上重读 |
| 交易指令页 | 有(`app/pages/TradePage.qml`、`OrderTicket.qml`、`PayoffChart.qml`、`SimilarTrades.qml`、`FlyPlanner.qml`、`FlyResult.qml`、`FlyChart.qml`、`PlaybookPanel.qml`;
判定 `shell/trade_rules`、`shell/fly_rules`,输入与提交 `shell/trade_composer`,蝴蝶测算 `shell/fly_store`,大模型目录 `shell/llm_store`,接线 `shell/trade_controller`、`shell/fly_controller`)。
编辑器与解析结果:整页的字对着 SSR 渲染原页面的 33 个场景逐段相同,损益图几何一位不差;提交把原 `store/trade.ts` 真跑 11 个场景逐步对,`instruction.submit` 的入参过引擎的 zod schema,
发送经真的桥对着假引擎端到端测过;「发送」按钮的提示、灰不灰、橙不橙对着 SSR 的按钮属性逐场景对。验收通过(2026-10-18)。
蝴蝶测算与日内剧本:`flyPlanForm.ts` 的纯函数(16 份表单,入参过 strict schema)、`store/flyPlan.ts` 真跑 7 个场景逐步对、面板的字对着 SSR 的 28 + 11 个场景逐段相同、
盈亏曲线的路径与线与标签一位不差。排版用 `tools/compare_texts.mjs` 对过:编辑器栏、结果卡片、蝴蝶测算的结果在 2px 内;两栏怎么分照 AntD Splitter 的 flex 规则
(各占 50%,内容最窄也放不下的那一栏撑宽——日内剧本那张不折行的表)。提交之后同原版的 `Promise.all`:状态、交易记录、条件单一起重读。
预览引擎下占位账号按预览台的 mock 算(空),截图才和 React 版同一份数据 |
| 订单看板 | 有(`app/pages/BoardPage.qml`;口径 `shell/order_rules`,交易记录与条件单的 store `shell/order_stores`,接线 `shell/board_controller`)。
140 个终态 × 在途状态的组合(叫法、分档、着色、阶段路径)与整页的字对着 SSR 的 10 个场景逐段相同(`gen_board.mjs`);store 的读法(读不到留着上一份、在途不重发、
pending 事件重读)与 15 秒一轮只在这一页时跑,对着假引擎测(`tst_order_stores`);通知流接没接上由 `tst_shell` 真把应用跑起来量字 |
| 交易记录页 | 有(`app/pages/RecordsPage.qml`、`RecordDetail.qml`;口径 `shell/records_rules`,接线 `shell/records_controller`)。整页与单据的字对着 SSR 的 36 个场景逐段相同
(筛选、关键词、疏密、六种排序、详情的读着 / 不在了 / 读不到 / 四种记录;排序按 zh-CN 的 `localeCompare`),`ticketFromRecord` 对着原函数 6 份;
原始记录照引擎回包的键序写(回包保序再读一遍,`EngineReply::raw`);详情作废旧回包、导出先要保存对话框的路径,对着假引擎与预览引擎测(`tst_records_controller`)。
排版:表与单据(三屏)在 1.5px 内。蝴蝶单的「分析这笔交易」与点代码徽章开档案,交易分析与情报两页搬过来之前只切到那一页 |
| 图表(`lib/chart/`:spec、引擎、叠加层;lightweight-charts 画的框架) | 有(`shell/chart_spec` 归一化 / 价格区间 / 量能封顶 / 读数 / 视口怎么留 / 避让,`shell/chart_scale` 一帧:窗格、轴宽、刻度、时间轴的字、蜡烛与量柱的像素框、叠加层、十字光标,`kit/chart_view` + `kit/Chart.qml` 画与交互)。
不靠库的那一半对着原文切出来跑(`gen_chart.mjs`,13 份 spec);库的那一半对着浏览器里量的原版(`tools/chart_harness.mjs` 把原 engine.ts 打成一页,`chart_capture.js` 量 24 个场景:可见范围、每根的 x、价格 ↔ y、窗格高、轴宽、`fillText` 记下的每一段字),
交互对着调库的模型量的 24 步(`chart_interactions.js`:滚轮、拖动、拖时间轴、拖价格轴、价格手动时上下拖、双击复位、刷新留视口、改尺寸按 `lockVisibleTimeRangeOnResize` 缩放)。
场景 40 个(另有 5 分钟跨 4 个交易日、小时线跨 6 天、日线跨年,时间刻度的天 / 12 时 / 6 时 / 3 时 / 时那几档;一组价格区间让三种刻度除数序列各赢一次)。字的位置在 0.4px 内。
指针一动只重算十字光标那一层(`applyHover`),轴上的字不重建
用 QPainter 画而不是场景图的几何节点:画布那一套(任意虚线、1.5px 的线、抗锯齿)照搬最直接。像素比按窗口的(Retina 2×,库也按设备像素取整) |
| 行情页 | 有(`app/pages/MarketPage.qml`、`PaCards.qml`、`BookBody.qml`;口径 `shell/market_rules`,图 `shell/pa_spec`,接线 `shell/market_controller`)。
整页的字对着 SSR 的 34 个场景逐段相同(读着 / 出错 / 空、形成中 / 未到齐、盘外推算 / 夜盘 / 只看正常时段、高周期同向 / 相反 / 没有、依据平铺、AI 解读、四种盘口快照、关注表坏了……),
`paSpec` 对着原函数 9 份(顶部均线读数逐根比);取数、20 秒节拍(在途跳过、没连券商不刷)、关注表(去空白转大写、最多 12 只、逐只刷、正在看的排最前)、
卸下清空对着假引擎测(`tst_market_controller`)。排版:六屏在 2px 内。原版页面切走就卸载,Qt 版 `setVisible(false)` 同样清空。与原版的一处差别:上一轮「全部刷新」还没取完又点一次,原版另起一条逐只取的循环(同一只取两遍),Qt 版并进同一条队列、去重 |
| 想法页 | 有(`app/pages/IdeasPage.qml`;口径 `shell/ideas_rules`,接线 `shell/ideas_controller`)。整页的字对着 SSR 的 14 个场景逐段相同
(空 / 读不到 / 检索没命中、命中方式、九种 AI 分析的形态、分析着、知识总结与缺键的总结、总结着、不附带交易结果),时间的悬停提示同 `fmtTime`;
取数(列表 / 检索 / 总结历史、每分钟一轮)、记下、完成 / 归档、AI 分析、总结、发到解析对着假引擎测(`tst_ideas_controller`)。排版:三屏在 2px 内
(对比用的数据:`PREVIEW_MOCK` 指向一份在预览台 mock 后面接上带分析与总结的想法,浏览器里同一段补丁)。这一页只碰 `ideas.*`,不下单 |
| 板块页 | 有(`app/pages/SectorsPage.qml`;口径 `shell/sectors_rules`,板块与行情 `shell/sectors_store`(store/sectors.ts + store/pool.ts),接线 `shell/sectors_controller`)。
整页的字对着 SSR 的 22 个场景逐段相同(心跳一行的十种样子、行与价位条的各种形态、选股着 / 拨着开关 / 改标签、触发条件扣大盘读不到、碰均线关着 / 没读到、穿越要收盘确认、弹窗与提示音关了),
还比每个开关、状态点、行里数字的着色、读着的按钮;增删改、开关(旧库停用过的一行走 quality.update)、标签、触发条件的 600 毫秒防抖与离开时补存对着假引擎测(`tst_sectors_controller`)。
排版:四屏在 2px 内;板块标题(等宽字里夹中文)窄 4–5px,是等宽字的中文落到的字体不同,没校正。
板块页的接线还对着假引擎钉了:移除失败先退回再重读、拨开关失败照原话说哪一路并重读、没连上的提示按券商说面板名(池子空就不说)、窗口在后台不清异动未读、
主窗口回到前台当场清、连上 / 断开只重刷不算重新挂上(在途的回包照样落地)、存不上时草稿退回引擎那份 |
| 扫描页 | 有(`app/pages/ScreenerPage.qml`;口径 `shell/screener_rules`(screenerRows.ts、ScanTable、DeviationSection、LeadersSection),接线 `shell/screener_controller`)。
整页的字对着 SSR 的 23 个场景逐段相同(没扫过 / 扫着 / 背离没回来 / 只有 RS / 只有背离、三种排序、标签没分、记着的板块已删、偏离的读着 / 数据不够 / 超卖 / 不在极值、空池、
强势股的四种筛选与没筛成 / 筛着),极值偏离两张图的 spec 对着原文 useMemo 切出来跑的 3 个场景;先 RS 后背离、背离的列先占住、出结果顺手复盘榜首那只(人点过就不抢)、
两步同一个原因只报一次、连点只认最后一次、上一只 / 下一只绕圈、手输优先、排序三态、股票池记在本机、卸下清空对着假引擎测(`tst_screener_controller`)。
排版:扫描后三屏、强势股两屏、没扫过一屏;扫描后与没扫过的 0 段差(偏离卡片标题这类 14px 650 的字宽 2–3px 的差除外);强势股的表照 AntD 的 max-content 按最宽一格排列宽
(含表体里那行量宽用的 12px 粗体表头),VCP 一列「→」的字宽差 1.2% 让后面两列整体左移 3.4px,没校正。
`page:screener[@y]#form:scan|scan-leaders` 是截图对比用的入口(点「扫描」,再点「筛选强势股」)。这一页只碰 `screener.*` 与 `sectors.list`,不下单 |
| 回测页 | 有(`app/pages/BacktestPage.qml` + `BacktestResult.qml`、`SweepPanel.qml`、`RuleBuilder.qml`;口径 `shell/backtest_rules`,接线 `shell/backtest_controller`)。
整页的字对着 SSR 的 27 个场景逐段相同(目录没回来 / 五种策略 / 参数清空、自定义的三种条件、两种期权、跑着 / 失败 / 四种结果、参数扫描的表单 / 跑着 / 失败 / 结果 / 亮黄与不亮黄 /
p 正好 0.001 / 七页与十二页的分页),还比流程图的卡片、按钮的读着与点不动、卡片的状态色、着色的数、瓦片的着色、输入框里的字(数字框按步长的小数位,同 rc-input-number)、分页;
净值曲线的 spec 对着原文 useMemo 切出来跑的 4 个场景;跑一次 / 扫参数的载荷、读目录与默认参数、条件搭建器、翻页、切走清空与晚到的回包对着假引擎测(`tst_backtest_controller`)。
引擎回来的对象按原文的键序读(`OJson::toQJsonKeyed`:QJsonObject 会把 RSI 的 period / buy_below / sell_above 排成字母序)。
排版:默认、自定义、期权、跑一次、扫参数五种状态共十二屏,除卡片标题(14px 650)的字宽外 0 段差。新的 kit:`DateRangePicker`(AntD RangePicker:预设、两个月并排、
不晚于今天、能敲日期)、`AutoTable`(table-layout: auto 的列宽,交易分析也要用)、`Pager`(AntD 小号分页,过 50 条带「10 条/页」)。
照原版保留的怪处:日历的月份写成「2025年Oct」、星期是 Su…Sa(AntD 用了 zh_CN,dayjs 没切中文);换到自定义策略时上一个策略的参数照样带进载荷;
起止默认按 UTC 的日期(toISOString);结果表换了一份更短的结果时只在显示上夹到最后一页,记着的页码不变(同 AntD 的 usePagination)。
离开自定义策略时一句话的输入与「生成中」清掉(原版条件搭建器卸载),在途的那一次回来照样把条件写进去(原版的 onChange 还挂在页面上)。
页面里凡是带输入框的重复行(参数、期权四项、扫描网格、条件、持仓追踪的分批止盈档)模型只放键或条数,行的数据按序号现读:敲一个字页面模型整份重算,
拿对象数组当模型会把正在打字的那一行连框重建,后面的字落空(`tst_kit_controls::keysModelKeepsTypingRow`)。kit 的 Select 字的 x 是 12(1 的边 + 11 的内边距,同 AntD),
值不在选项里时原样显示这个值。`page:backtest[@y]#form:run|sweep|custom|option` 是截图对比用的入口。这一页只碰 `backtest.*`,不下单 |
| 交易分析页 | 有(`app/pages/ReviewPage.qml` + `ReviewResult.qml`;口径 `shell/review_rules`(Review.tsx 的候选写法、ReviewResult.tsx、reviewCharts.tsx),接线 `shell/review_controller`)。
整页的字对着 SSR 的 28 个场景逐段相同(读着 / 没连 / 筛空、十二种候选写法、分析着 / 失败、蝶的四种结果(本地、持仓中、不能回放、没有蝶价、没有止盈策略、策略没出手)、股票的两种),
还比卡片的状态色、瓦片与表里数的着色、按钮、开关、类型分段、EM 框点不点得动;三张图的 spec 对着原文 useMemo 切出来跑的 10 个场景;读候选(附带本地的开关、选中那一笔的保留与退回、
新鲜度只在是「读候选那句」时换)、筛类型后的退回、分析的载荷与记下的本机设置、失败清掉上一次、交易记录跳过来(默认列表没有就打开附带本地再读、页面没挂上时挂上再办)、
切走清空与晚到的回包对着假引擎测(`tst_review_controller`)。交易记录详情里的「分析这笔交易」接到这一页(`RecordsController::reviewRequested` → `ReviewController::request`)。
排版:没分析、蝶(五屏)、股票(三屏)0 段位置差,只有字宽(下拉里省略的那一笔、卡片标题)。引擎给的字一律按纯文本摆(蝶的止盈策略说明里有「σ_剩余 12.4 < W/1.6」,
按 StyledText 解析会把「<」后面整段吃掉)。kit 的 Label 与 Select 默认纯文本(账户别名是用户起的,「IRA<旧>」不能被当标签吞掉),要粗体的说明显式写 StyledText(Hint 就是);
Select 的弹层同 AntD 最高 256、能滚、打开时滚到选中那一项,选项字省略(候选能有 200 笔,`tst_kit_controls::selectLongListScrolls`)。
照原版保留的怪处:类型筛成「股票」时从交易记录点一张蝶的「分析这笔交易」,候选被退回第一笔股票,下面的结论却是那张蝶(Review.tsx 的退回 effect 同样错位)。对比时预览引擎要换 mock(`review-override.js`):Qt 的预览引擎把入参的值按键的字母序依次传进 mock,`reviewAnalyze(spec)` 拿到的是 exit。
`page:review[@y]#form:run|stock` 是截图对比用的入口。这一页只碰 `review.candidates` / `review.analyze`,不下单 |
| 绩效体检页 | 有(`app/pages/PerformancePage.qml` + `PerformanceParts.qml`、`ShareCard.qml`;口径 `shell/performance_rules`(Performance.tsx、PerformanceParts.tsx、
PerformanceExtras.tsx、PositionSizer.tsx + sizing.ts、SignalScorecard.tsx、shareCardDraw.ts 的副标题与页脚),接线 `shell/performance_controller`)。
整页的字对着 SSR 的 15 个场景逐段相同(读着 / 算不出来 / 空范围、体检结果、重新算着、建议在填、仓位计算器的四种、边角两种、信号成绩单的五种),还比卡片的状态色、
瓦片的着色、着色的数与悬停的区间、R 格的悬停说明、按钮(读着、上一页 / 下一页)、范围分段、仓位计算器的三个框、账本的页数;仓位计算、分享卡片的副标题与页脚、
权益曲线的 spec 对着原文跑。读账本(换范围 / 品种 / 天数就重读、天数 0 不带、读着时上一次的结果留着、失败不清结果)、按建议填入(确认框上的字、取消不发、
只带那一条规则的 settings.patch、成了横幅 + 刷新状态 + 重算、失败横幅说设置未改动)、仓位计算器(本机记的权益与比例、每份最大亏损的起手值是账本里蝶的每份风险中位数、
中位数变了才回到它)、信号成绩单(点了才算、带天数、换天数不清)、分享卡片的导出(只收 PNG 的 data URL、不超过 12 MB、存盘路径只来自保存对话框、文件名同 main.js 洗过)、
切走清空与晚到的回包对着假引擎测(`tst_performance_controller`)。
排版:页顶、结论、建议、核心数字、分组、执行损耗、仓位计算器(空着 / 填了)、账本、信号成绩单(打了分,含默认展开的说明)共九屏 0 段位置差,只有字宽(卡片标题、
品种那张宽表里按字宽分出来的列差 2~3px)。新的 kit:`CardGrid`(CSS 的 repeat(auto-fit, minmax()):空列收掉、同一行一样高、可占整行);`AutoTable` 加了
`fixed`(有一列 ellipsis 时 AntD 换成 table-layout: fixed)与 `scrollX`(scroll.x = max-content);`Select` 加了小号(24 高、9 圆角);`Meta` 里比一行还长的一项
缩到一行宽、在里面折行(同 flex 项);`Pager` 改成量的间距 4、页码 11.5px(回测的参数扫描用的同一个,之前没有截到过分页)。
分享卡片照 shareCardDraw.ts 摆:底、光、应用图标、曲线面板与曲线画在 Canvas 上(Qt 的 Context2D 没有 Path2D / roundRect,路径现画;「#RRGGBBAA」在 Qt 里读成 #AARRGGBB,
带透明度的颜色写 rgba());字不用 fillText(Qt 的画布填字时把系统字体里笔画互相叠着的地方挖空:「+」「4」),是一层普通的 Text,摆在 fillText 会摆的位置
(同基线、同对齐、同样按格宽收字号),导出时整张 grabToImage 写到壳定的临时文件、壳读回来再拷贝或另存。预览是同一张缩着显示(带 mipmap 的 layer),
圆角用弹层底色盖四个角。涨跌配色在设置页搬过来之前按绿涨红跌。kit 的 CardGrid 重排靠绑定(宽、子项看不看得见与自然高度),不用 connect + Qt.callLater:
排进去的回调会在切页销毁之后才跑,进程当场 abort。
照原版保留的怪处:几次读账本在途时谁后回来谁算数,「读着」在任何一次回来时就落下(原版 useCallback + finally,不分新旧)。
`page:performance[@y]#form:signals|sizer|share` 是截图对比用的入口。这一页只碰 `review.performance` / `review.signals`,以及经确认框的 `settings.patch`(保护规则只会收紧),不下单 |
| 情报页 + 标的档案 + ⌘K 查标的 | 有(`app/pages/IntelPage.qml` + `IntelTimeline.qml`,全站共用的 `app/shell/DossierDrawer.qml`、`LookupModal.qml`;口径 `shell/intel_page_rules`
(Intel.tsx、IntelTimeline.tsx、SymbolDossier.tsx、DossierHost.tsx 的 Lookup;单条的规则在原有的 `shell/intel_rules`),接线 `shell/intel_controller`,状态在原有的 IntelStore)。
整页的字对着 SSR 的 13 个页面场景(读着、读不到、没连券商、几天的时间线、刷新着、筛代码 / 原文 / 筛不出、只看信号、只看持仓、两种一起、一条都没有)、
10 份档案(全有、指数价与蝴蝶持仓、跌的、刷新着、读着、读不到、读到过这次没读到、什么都没有、连着不在订行情、各段都多)、5 个查标的逐段相同,
还比提示条、种类分段、开关、关键字框、每一行的种类 / 状态色 / 持仓 / 标的胶囊(持仓、描边、猜的、悬停字)/ 信任圆点 / 时刻与悬停全写 / 结果胶囊颜色 / 涨跌 / 写进指令框、
常被提到、档案的价与涨跌色、标签胶囊(颜色、圆点、悬停字)、列表项的类、价位胶囊、查标的的警告边(`tst_intel_page_rules`);
进页拉时间线记成看过、窗口回到前台只在这一页时记看过、切走清关键字、种类 / 只看持仓交给引擎、档案与查标的(`tst_intel_controller`)。
SSR 里 AntD 的 Drawer / Modal 不肯渲染(portal),生成器打包时换成就地摆标题、右上按钮与正文的替身。
排版:情报页三屏、档案(顶与滚到 600)、查标的 0 段位置差,只有字宽(胶囊、等宽字里挨着中文的空格:Qt 用中文字体的空格,窄)。mock 的时间线按「现在」往回推,
过了午夜分组会变:对比时两边要同一时刻截。档案的「写指令」把指令框换成「代码 」开头、翻到解析结果、切过去;「K 线」去行情页换成它;时间线上「写进指令框」同事件的「应对」。
交易记录的代码徽章、「持仓的票被提到」弹窗的「查看」直接打开档案。kit:`Drawer` 加了标题字号 / 副标题 / 右上按钮,正文内边距放进滚动区(同 AntD,滚起来一起走);
`Modal` 标题按 1.5714 的行高摆;`Input` 加了 large / clearable / warn;`Button` 加了 fontSize;`Label` 露出 truncated。这一页只读,不发单 |
| 接入页(TWS、富途 OpenD、账户、大模型、Discord 跟单) | 有(`app/pages/AccessPage.qml` + `AccessParts.qml`;口径 `shell/access_rules`(Access.tsx、TwsPanel、FutuPanel、AccountsPanel、LlmPanel、FollowPanel、connectBits;
跟单表单的读写与校验对着 lib/followForm 现算),接线 `shell/access_controller`)。整页的字对着 SSR 的 46 个场景逐段相同,另比按钮 / 卡片 / 提示条 / 状态点 / 标签 / 胶囊 / 端口格 / 行色 /
勾选 / 开关 / 分段 / 指引(`tst_access_rules`);检测、诊断、启动程序后过 4 秒重测、连接引擎、切券商(确认框 broker.select)、富途密码只存 md5 与解锁、账户改动走壳(校验、确认框、写配置、重启引擎)、
大模型的目录 / 测试 / 保存 / 存 Key、跟单的关当场生效、开走保存与 gate.follow 确认框(`tst_access_controller`,14 条变异全被杀)。确认凭据与 Electron 的 `confirm-grants.js` 同一张表,没有多加也没有放宽。
排版:五个子页签(跟单四屏)对着 React 0 段位置差,只有等宽字宽(端口格的小牌)。kit:`Segmented` 默认尺寸的项宽改成字宽 + 22(量的;之前没有页面用默认尺寸);
`Alert` 没有说明时上下 9(同 AntD,其它页的对比没变);新的 `StepList`;`GroupRow` 加了图标瓦片、竖排、自定义名字格。跳到某一节(tws / futu…)由接入页切子页签。
预览台的账户信息用 React 预览台 mock 的那一份(三条连接)。密码框(富途交易密码、大模型 Key、bot token)拿着焦点时开 macOS 的安全键盘输入(`kit/secure_input`,Qt 自己不开;浏览器的 password 框是开的),真机上还没核对 |
| 设置页(外观、执行闸门、风控限额与按账户覆盖、保护规则、单笔风险预算、重要事件的口径、数据与备份) | 有(`app/pages/SettingsPage.qml`;口径 `shell/settings_rules`(Settings.tsx、lib/settingsForm、AccountLimitsRows、EventsConfig、DataPanel),
接线 `shell/settings_controller`)。表单的 toForm / formProblems / toPatch / isDirty 对着原模块现算(5 份设置、5 份表单、15 个补丁,含按账户覆盖清掉时送 null、空着的格子照原值送回);
整页的字对着 SSR 的 15 个场景逐段相同,另比按钮、输入框显示的数与占位字、开关与点不动、分段、玻璃滑杆(`tst_settings_rules`)。闸门关是当场生效的、开跟着保存走;
保存依次过 gate.auto_execute / gate.allow_live_trading / limits.loosen 的确认框(取消把开关拨回去、不存),凭据由 Bridge 核销,与 Electron 的 confirm-grants.js 同一张表;
重要事件的口径 600ms 防抖存、开关当场存、离开页面补存;立即备份、恢复交给壳(`tst_settings_controller`,21 条变异全被杀)。外观三项记在本机、由 `Theme` 直接读写:
深浅色固定一种时连系统控件一起换(QStyleHints.colorScheme),涨跌配色对调 up / down 与蜡烛色,玻璃着色程度进所有玻璃面。
排版:默认与全打开(保护规则、风险预算)各五屏、问题清单一屏对着 React 0 段位置差,只有一行换行宽度(字体)。kit:新的 `Slider`、`LoadingBlock`;`SectionTitle` 加了 topGap(紧跟页头时 10) |
| 关于页(版本信息、更新、支持、键盘快捷键、引擎日志) | 有(`app/pages/AboutPage.qml`;口径同在 `shell/settings_rules`(About.tsx、UpdatePanel、SupportPanel),接线 `shell/about_controller`)。
整页的字、版本信息表、按钮、链接、发布说明与日志对着 SSR 的 11 个场景(`tst_settings_rules`);Qt 版的版本信息没有 Electron / Chromium / Node,换成一行 Qt 的版本。
引擎日志从启动起就收、只留 200 行;更新跟着 UpdateStore;导出 / 拷贝诊断、打开位置、看条款、重启引擎交给壳(`tst_settings_controller`)。快捷键表列的每一条 Qt 版都接上了
(侧栏的 ↑ ↓ 是这次补的:焦点在侧栏时按侧栏顺序上下切页,折叠的组跳过)。预览引擎的版本信息与「检查更新」回 React 预览台 mock 的那一份(不去问 GitHub),顶栏的「新版本」也就亮着。
排版:两屏对着 React 0 段位置差(预览台没有引擎日志,那一行除外)。这一页不发单 |
| 打包时怎么带 Node 跑 TS 引擎 | 没定:开发时用系统的 node |
| 阶段 1 的整体审查(钱路径、Electron 有而 Qt 没接的、晚到的回包与拆页、预览与测试的安全) | 做完,发现的都修了:`WrapRow` / `Meta` 拆页时还会排 `Qt.callLater`(和 CardGrid 那次 abort 同一类)改成绑定驱动,
`tst_kit_controls::wrapAndMetaTearDownCleanly` 挂上卸载 30 轮、见到告警就红;别的平台上菜单栏没挂进窗口,Ctrl+R / Ctrl+M 补在 `Main.qml`;涨跌配色只记一份(`alerts/updown`)。
钱路径的白名单、敏感方法、结果未知方法三张表与 main.js 逐项对上,`__confirmed` 只在 preload.js 带的那几条上带。16 页都过了验收。
已知没对齐、留着的:「保护规则」说明里加粗那句是 700(原版 600;StyledText 的 `<b>` 只有 700,RichText 不认 Label 的行高) |

**2. C++ 引擎,按层自下而上**(层次与依赖方向同 `CLAUDE.md` 的引擎分层):
contract → util → domain(库)→ analysis(纯计算,16,200 行,彼此独立,可以几个会话并行)→ parsing → execution(TWS)→
orchestrate(盯盘、托管单、对账)→ transport(三条道的 RPC)。每一层先把对应的 vitest 用例搬成 QtTest 再写实现。
完成标准:**同一份 `baseline/golden/*.json` 与 golden-rpc 的 96 步回放,C++ 引擎的结果与 TS 引擎一致**;参数层、机制层、定价恒等式全过。

阶段 2 的现状:

| 项 | 状态 |
|---|---|
| 进度表:engine-ts 的 96 步 RPC 回放(`baseline/rpc/`)对着 C++ 引擎 | 有(`tests/tst_golden_rpc`,读 TS 那条测试用的同几份文件、照它的归一化与容差比)。棘轮:`fixtures/golden_rpc_passing.json` 记着已经对上的步,只许变长;现在 0 / 96。TS 那边的黄金基线在干净的副本里是绿的(13 个文件、367 条) |
| 对拍的做法 | 每个模块一份 `tests/fixtures/gen_<模块>.mjs`:拿 `tsc` 编出来的 `engine-ts/dist` 里的原模块,在一大把输入上现跑,C++ 逐个比。生成时要给编过的 engine-ts 目录(在 iCloud 之外的副本里 `npx tsc`)。**对的是装好的应用里跑 TS 引擎的那个运行时**(Electron 41 自带的 Node 24 / V8 14.6,`ELECTRON_RUN_AS_NODE=1 …/Electron gen_x.mjs`),不是开发机上的 node:两者的 Math.* 末位与 URL 解析不一样。引擎那 16 个生成器在两个运行时下都跑过,输出只在下面「已知的差别」里那两处不同 |
| util 层:JS 数字与字符串(`util/jsformat`、`jsvalue`:toFixed / toExponential / String / Number / Date.parse,按规范在精确的十进制展开上取舍)、`py`、`pyjson`、`tz`、`market_calendar`、`risk_budget`、`protections`、`killswitch`、`notify`、`rpc_error`、`keychain` + `secrets` | 有,每个都对着原模块现算的答案(数字格式 2 万多条、tz 1.4 万多条、保护规则 400 个场景、熔断 144 串操作……),ASan + UBSan 干净。界面的 `shell/jsvalue` 改成用这里的同一份 |
| 引擎的 async / await | `util/task`:C++20 协程 `Task<T>`(立刻开始跑、可以被几个调用方同时等、异常穿得过 co_await)、`Deferred`(new Promise)、`sleepMs`、`withDeadline`(超时不撤那件事)。规矩:协程的参数传值;协程是活得比它的 await 长的对象的成员,或 await 之后先查 QPointer;不写按引用捕获的 lambda 协程 |
| 凭证 | 引擎从不直接碰凭证库:读写交给自己的可执行文件起的子进程(`ibkr-engine --keychain-child`,钥匙串认的程序身份不变,到硬上限才杀),「有没有存过」在 macOS 上问 `security` 不带 `-w`(不解密、不弹窗)。macOS 用 Security.framework 读写登录钥匙串里同一条 generic password(@napi-rs/keyring 背后是 apple-native-keyring-store,存的同一处),查一条不存在的条目的真调用在测试里跑过。**Windows 那条(凭据管理器的 TargetName = account.service、UTF-16 存法)照 keyring-rs 写的,还没在 Windows 真机上核对能不能读到 Electron 版存的那一份** |
| domain 层:配置(`domain/config`,`config.ts` 逐句搬) | 有。fromDict 465 份配置(含写成数字、套了一层数组的休市日:只有字符串对得上日期)(每一种校验的原话、读进来的整份 Settings 与它的方法,连键序比)、loadSettings 三种错、patchConfigFile 写盘的文本与 .bak、deepMerge、交易时段、base_url(WHATWG URL 的怪处:`http://127.1` 算本机、`http://LOCALHOST.` 不算)、提示词最新版、`~` 展开。TS 拿 JSON.parse 出来的东西直接当对象用,原始值上取属性、`in` 用在原始值上抛的 TypeError 原话、`Object.keys("ab")`、Object.prototype 上的名字(`provider: "toString"` 带了 model 就能过)都照着做 |
| JSON 的两处 JS 行为(`util/v8json`、`util/ordered_json`) | V8 的 JSON.parse 报错原话(用户手改配置改坏了看到的就是它):4119 份文本对着 node 逐字比。OJson 的键序改成 JS 对象的键序(像数组下标的键按数值排最前),`\u` 后面逐位查十六进制(原来 `\u00e\r` 会被收下)——界面那边读写 settings.json 也跟着对了 |
| JS 的 Math.log / exp / log10 / log2 / sin / cos / atan(`util/jsmath`) | V8 用自己带的 fdlibm,和系统 libm 不是一份(macOS 的 libm 在 exp 上约一成输入差 1 ulp);定价与统计的数再经 toFixed 写成字,1 ulp 也会翻数字。搬了 fdlibm 那几个函数:log / exp / log10 / log2 / atan 对着 Electron 的 V8 在 4 万个输入上逐位相同,和引擎别的代码一样 `-ffp-contract=off`(Electron 照 Chromium 的配置编,不合成 FMA;Homebrew 的 node 在 arm64 上合成了,和 Electron 本来就差末位)。Math.pow 与 `**` 是 V8 的 math::pow:走系统 libm 的 std::pow,先挡掉指数 2(就是 x*x)、0.5(sqrt)、NaN、±1 的 ±∞ 次方——macOS 的 pow(x, 2) 约千分之一的输入和 x*x 差一个末位,所以有 `jsmath::pow`:引擎与界面里照 JS 写的、指数可能是 2 或 0.5 的乘方都用它;剩下几处 `std::pow`(IPv4 的 256^k、图表刻度的 10^k、提示音的包络)指数是整数或与 JS 无关,结果一样。sin / cos 见下面的差别。x86-64(Windows 版)的基线指令集没有 FMA,只要不开 `-mfma` / `/arch:AVX2` 就一样——**Windows 真机上没核对过** |
| analysis 层:到点平仓 / 分批止盈 / 止损确认 / 利润回撤 / 标的止损(`analysis/tracker_rules`) | 有。原模块上 2 千多个随机场景;评审另跑了 6 万个调用、验收加了 15 个变异,都对得上 |
| analysis 层:蝶式测算的 IV 模型(`analysis/fly_model`:flyCalibration.ts + flyIvModel.ts + ivPricing.ts) | 有。校准(合成的小时线 / 5 分钟线,带缺根、乱序、盘前盘后、坏价,trainShare 取 0.5 / 1 / 负 / NaN)、自己攒的 IV 样本那一份(离网格点一样远的两笔、只剩 5 或 6 个点的天)、校准出来的那份常量、到期时刻 3024 种组合、各腿 σ 与行情 420 份,逐字比。变异:我 27 个、验收 12 个;5 分钟线正好缺两根、长一档 IV 正好 59 / 60 天这两处是验收抓出来的空当,已补上用例。剩下三个抓不住的是等价的:`> within` 换成 `>=`(要正好相等)、日内 σ 里 exp 换成系统 libm 的(校准输出取到 3~4 位小数,末位被盖住;jsmath 自己逐位测着)、到期日取 `left(8)` 换成 `left(10)`(之后只用前 8 位) |
| analysis 层:蝶式止盈策略(`analysis/flyexit`:flyexit.ts) | 有。黄金基线的 18 个场景与 74 天合成的整天分钟线(每一分钟的蝶价、阶段、触发价,每一笔出手的那句话)、参数整理(串、布尔、数组、Object.prototype 上的名字)、方差与阶段、回撤档位、Bachelier 与反解,逐字比;Bachelier 的正态分布用的 `@stdlib/math-base-special-erf` 连它自带的 exp 一起搬了(`util/stdlib_erf.cpp`,Apache-2.0),2.2 万个输入逐位比。变异:我 35 个、验收 19 个。验收抓出两处空当(数据在 15:59 断掉时按内在价值结算、标的正好停在 0.8W 那条线上),已补上写明的场景;其余抓不住的都看得出等价:TS 里多余的两道检查、二分到宽度 1e-9 就停那一条(被 6 位小数盖住)、erf 里 exp 永远走不到的那一段、改了也是同一个 double 的常数、erf 两段有理逼近在分界那 0.007 里给出同一个数、翼尖上正好 abs(S−K) = W 时二分本来就回空 |
| analysis 层:SPX 日内剧本(`analysis/playbook`:playbook.ts + sessionEm.ts) | 有。状态机 44 条长走法(1.4 万多步:贴着线来回蹭、只在新一格判 B2、昨日下沿压过 B2、静默期正好 5 分钟、现价正好等于丢掉的线、重启接上带触发线的 R),每一步的状态与事件和最后整台机器(含 fired)逐字比;区间、目标位(相等的边)、加速档、重启接续、从底账折回全天 1σ。变异 25 个全抓住 |
| analysis 层:蝴蝶测算(`analysis/fly_plan`:flyPlan.ts) | 有。planSchedule 300 组(收盘后、周末、休市日、提前收盘、写坏的时刻与日期、认不出的结算方式)、planFly 近 400 组(三种 IV 来源、三种走法、带 own 的模型与陡到碰下限的那一份、盘口缺腿 / 买价 0 / 倒挂 / 买卖相等、锚定差得大、隔日到期、目标 = 此刻 / 到期前一秒 / 正好在翼上、要 2.5 步长的曲线),整份结果逐字比。变异 37 个,抓不住的 5 个都等价(期限正好 1 天时插值权重本来就是 0、重复的穿越点不改首尾、0.1 一档的百分比上 `>= 0.05` 与 `> 0.05` 相同、正好 1σ 是测度为零、目标时刻不会晚于到期) |
| analysis 层:小样本的区间与检验(`analysis/inference`)与执行损耗(`analysis/exec_quality`) | 有。t 分布、Wilson / t / Welch / 秩和 / Newcombe / 中位数区间与按簇的三种,三千多组;簇的离差按第一次出现的先后求和(求和次序会改末位)。执行损耗 800 多组平仓痕(老痕没 mark、组合的腿行与 BAG 行、模拟盘、时间窗、明细截到 50 行)。变异:inference 19 个(抓不住的都等价:t = 0 的那一行本来就落到 0.5、Wilson 的下限夹 0 只挡浮点噪声……),执行损耗 18 个全抓住 |
| parsing 层:本地速记(`parsing/shorthand`,语法 v7) | 有。黄金基线 45 条、TS 测试里写过的每一句、按语法拼的随机句子,共 3800 多句、7300 多次解析(含周末拒绝与 meta.relativeCenter),逐字比。JS 正则的三处语义换成了 PCRE 的写法:`\s` 用 JS 那一组(含 U+3000、U+FEFF、U+2028)、`.` 不含四个行终结符、`$` 是 `\z`;落单的代理项先换成私用区的字再匹配(PCRE2 见到不合法的 UTF-16 整串不匹配),原文按下标取回。NFKC 用 `util::jsNormalizeNfkc`(见下面的差别)。变异 33 个,抓不住的 4 个都等价 |
| parsing 层:提示词(`parsing/prompts`) | 有。每一版提示词在五份配置下的指纹、系统提示词全文、少样本(业务用的那份按 JSON.stringify 比键序),三千多次用户消息渲染(含账号泄漏与残留变量的报错),写坏的提示词目录(残留变量、少样本格式不对、CRLF)。少样本落成保序的 OJson(`util::toPlainOJson`):QJsonObject 会按字母排键,发给模型的那份要原样的次序 |
| parsing 层:Discord 跟单的判定(`parsing/follow`) | 有。摘提及、分诊、跟不跟(本地速记的真产出 + 拼坏的 payload × 闸门 × 额度)、相对中心、引擎走完之后的下场、对方写的价、成交后建追踪的入参、等待中的追踪怎么核对、建好的追踪说成一句话。decide 的几处返回字面量键序不一样(前三处 detail 在前),照搬。变异 25 个,抓不住的 1 个等价 |
| orchestrate 层的纯计算:持仓追踪(`orchestrate/tracker`,tracker.ts) | 有。标的目标价的五档波动率来源(ibkr / smile / net / leg / clock,1100 组)、立刻能成交的价与追价(含 3 元换档)、盈亏、设置校验(止损 = 止盈、正好在现价上)、触发判断 1200 组(含负的峰值)、平仓单、托管单,整份结论逐字比。变异 67 个,抓不住的 1 个等价(平仓比例正好 100%) |
| 交易库与 domain 的其余几样 | 持仓身份与组合识别(619 组持仓)、IV 样本与日内剧本的底账、跟单的本地收件与读窗口程序的看管,都对着原模块现跑的答案;`flyExitSweep*`(1,700 行)只有开发脚本 `npm run sweep:fly` 用,应用里没有调用方,不进 golden-rpc;它要的 flyexit / playbook / trackerExits 都已搬完,排到引擎其余各层之后,和 `scripts/calibrate-fly-iv.mjs` 一起做成 C++ 的命令行工具(阶段 4 删 TS 之前要有) |
| SQLite | `native/third_party/sqlite3`:better-sqlite3 13.0.3 自带的 3.53.4(已打它的 1208.patch),三个文件的 sha256 与编译开关见那里的 README;`util/sqlite` 是照 better-sqlite3 看得见的行为写的薄壳(数一律绑成 REAL、布尔拒绑、run 的 changes 只算这一步真改的、只认一条语句、嵌套事务用同名 SAVEPOINT、错的 code 用它那张名字表、DEFENSIVE 开着、落单的代理项写成 U+FFFD) |
| domain 层:交易库(`domain/store`、`store_safety`、`risk_queries`、`log_stores`、`imported_trades`,对着 store.ts 那一组 7 个文件) | 有。`gen_store.mjs` 在原模块上跑 248 步操作(钟与 id 两边换成同一套可复现的),每一步的返回值、抛出的话与 code、之后整个库的样子(每张表的全部行、sqlite_master 里的建表原文、FTS5 影子表的字节、user_version)逐字比;外加老结构的库打开时的迁移、真应用开库的保险 16 段(版本、quick_check、每日 / 升级 / 手动备份与留几份、损坏 / 占用 / 写不进去的人话),以及 better-sqlite3 自己的 39 条行为。记录、成交、事件都是保序的 JS 对象,读出来的行同 TS 的 `{...row}` |
| Discord Gateway 客户端(`discordGateway.ts`) | 跟着跟单那一层一起搬(它的假 Gateway 在那边) |

对拍时已知的差别(阶段 2):

- `String.prototype.localeCompare`(保护规则摘要里按代码、按账户排序):Node 按进程的默认区域排;C++ 固定用 en-US 的 ICU 排序。这是**推断**——装好的应用由访达拉起、环境里没有 LANG,
  TS 引擎就落在 en 上——没在真机上量过。哪天两版的排序对不上,先查这一条(zh 区域里汉字按拼音排,en 下按码位;
  中文账户别名的排序就是这样:`LANG=zh_CN.UTF-8` 下「主账户」排在「模拟」后面,en 下在前面)。阶段 3 在真机上量:
  `ps eww <TS 引擎 pid> | tr ' ' '\n' | grep -E 'LANG|LC_'`,照结果定 QCollator 用哪个区域。
- 熔断状态文件写不进去时两版都抛(TS 的 `writeFileSync` / `renameSync`,C++ 的 QSaveFile 打不开或换不上去),话的样子照 Node 的 fs 错误
  (`EACCES: permission denied, open '…json.tmp'`),但 errno 只分三种(ENOENT / EACCES / 其它一律 EIO),不逐字对得上。
- V8 的报错原话:引擎的生成器在 Electron 41 带的 Node 24 下重跑过,和 node v26 下逐字一样。
- `Math.sin` / `Math.cos`:Chromium 配置下的 V8 打开了 `V8_USE_LIBM_TRIG_FUNCTIONS`,三角函数走它带的一份 glibc 的 sin / cos(V8 14.6.202 的 src/base/ieee754.cc,`libm_sin` → `glibc_sin`),不是 fdlibm。C++ 仍是 fdlibm,4 万个输入里约 3% 差一个末位、没有差两个的。引擎里只有统计用它们(inference 的 logGamma、signalOutcomes 的 t 分布),定价不用。没搬那一份:它是 glibc 的代码(LGPL)。已知后果(评审 M1):inference 的 logGamma 在 x < 0.5 时走 sin,与 Electron 差一个末位;只在 tQuantile 的 df < 1 或 incompleteBeta 的 a、b < 0.5 时碰到,产品里 df ≥ 1、b 固定 0.5,不会发生。夹具里 x < 0.5 的几个点碰巧对上,不能当作保证。
- `config.json` 那份夹具仍是 node 26 下生成的(为了下面这一条);别的引擎夹具在 Electron 下重跑都一样。Electron 带的 ICU 77.1 / tzdata 2025b 比 node 26 的(78.3 / 2026a)旧,`tz.json` 这次两边一样,哪天时区规则改了会分开——那时以 Electron 为准。
- `String.prototype.normalize("NFKC")`:Electron 41 的 ICU 77 是 Unicode 16,Qt 6.12 是 Unicode 17;111 万个码位逐个比过,只有 U+A7F1、U+16126–U+16128 两边不一样,`util::jsNormalizeNfkc` 把这几个照原样留着(落单的代理项两边都不动)。
- 照原样搬过来的 TS 缺陷(没修):建好的追踪说成一句话时(follow.trackExitsText),分档的百分比若是字符串("30"),pyG 打成「inf」。追踪行里的档位由引擎写、都是数,碰不到。
- base_url 的主机名里有 `xn--` 开头的段(punycode):Electron 的 URL 解析会解码检查,解不出来或解出来不合法(`https://xn--a`、`xn--zz`、`xn--1ug`)就判不合法;node 26 与 C++ 照收(C++ 对纯 ASCII 的主机名只转小写)。Qt 自己的 IDNA(QUrl::toAce)和两边都不一样,没用。写坏的 punycode 地址接下来也连不上,只是报错的时机不同。
- 写配置文件失败时的话照 Node 的 fs 错误的样子,errno 是按哪一步失败写定的(打开 EACCES / ENOENT、写 ENOSPC、fsync EIO、换名 EPERM),不是系统真给的那个;界面只显示这句话。
- 配置里名叫 `__proto__` 的键:JSON.parse 收成普通的键,TS 之后对它赋值时改的是原型。C++ 当普通的键。没人会这样写。
- `expandHome` 照 Node 的 `path.posix.join` 归一化(`~/a/../b` → 家目录/b);Windows 上 Node 用 win32 的规则,没搬。
- 账户的 connection 写成 Object.prototype 上的名字(`constructor`…)时,TS 的 accountBroker 回 undefined;C++ 回空的 QString(和 "ibkr"、"futu" 都不相等,效果相同)。
- 往 SQLite 绑定一个数组或对象:better-sqlite3 把数组摊成几个参数、把对象当具名参数;C++ 一律当作不能绑定(报布尔那句 TypeError)。引擎里没有这样传的。
- 照原样搬过来的 TS 缺陷(没修,行为一字不差):折叠交易记录时已实现盈亏用 `+` 相加,佣金回报里的 realized_pnl 若是字符串就成了字符串拼接(`0 + 12.5 + "7"` → `"12.57"`)。IBKR 给的是数,碰不到;要修就两边一起修。
- 照原样搬过来的 TS 缺陷(没修):跟单本地收件每读一块就单独按 UTF-8 解,一个汉字正好被切在两次读之间时,两半各变成一个 U+FFFD,
  那条消息原文就坏了(写收件文件的脚本一次写一整行,很少碰到);读窗口程序的标准输出也是这样(只影响窗口标题)。要修就两边一起改:两次读之间留下没凑齐的字节,而不是解好的字。
- 照原样搬过来的 TS 缺陷(没修,要等 review 的 handler 搬过来时照搬):复盘里手填的 EM 是 `"abc"`、`"-5"`、`" "` 时,提示写「EM 取 abc 点(手动填的)」,但 flyexit.paramsFrom 把这个值丢了,回放实际按默认的 36 算(`rpc/handlers/review.ts` 的 attachExitPlan)。复盘结论会误导人,不碰下单;要修就两边一起改。
- 熔断状态文件的顶层是数组或字符串时,TS 的 `raw["at"]` 取到 `Array.prototype.at` / `String.prototype.at`,时刻那一格写进了函数的源码。文件是引擎自己写的、碰不到;C++ 照原样留着。

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

1. 工具链已装(2026-10-18):`brew install qtbase qtdeclarative qtwebsockets qtsvg qttools cmake ninja` → Qt 6.12.0、CMake 4.4.4、Ninja 1.13.2,`-DCMAKE_PREFIX_PATH=/opt/homebrew`;一个 Qt Quick + Controls + WebSockets + Svg 的测试程序已经编过、跑通。沙箱里也能编、能链接:绕开 xcrun(它写不了缓存),把 `CMAKE_CXX_COMPILER` 与 `CMAKE_OSX_SYSROOT` 直接指到 CommandLineTools(命令在 `native/README.md`);QML 模块的 URI 不要和目标同名(大小写不敏感的盘上撞目录)。
2. TWS 线协议自己实现,不用下载 IB 的 API。本机 `~/Downloads/twsapi_macunix*` 里那两份 GPL 源码不要拷进仓库、也不照着写。
3. Windows 那一路要一台 Windows 机器做真机核对(阶段 1 结束前)。
4. 卖之前:Qt 许可(LGPL 还是商业)。

- 已知差异(评审 2026-10-19,情报批):① intel_items 的标签查表遇到 JS 原型键(`constructor`、`toString`、`__proto__`)时 TS 取到原型上的函数,C++ 精确查表;三个键都来自固定枚举,进不来。② open_risk 的账户别名若恰是 `valueOf`/`__proto__` 等,TS 的 riskUsd 累加会变成字符串拼接或丢项,C++ 给干净的数;别名是用户填的,几乎碰不到,建议校验层拒这几个名字。③ `v8DateParse` 默认参数每次构造系统时区,evaluateCrossMarket 约 2 ms/次;产品里是秒级调用,不处理。

- 范围决定(用户 2026-10-20):**富途(futu.ts / futuBridge.ts / futuBroker.ts)不移植。** C++ 引擎只接 IBKR/TWS;golden-rpc 里走富途的请求不算进 96/96 的完成标准,单列。
- 日期解析(评审 2026-10-20,B1/B2/M1):`util::jsDateParse` 改成直接调 `v8DateParse`(V8 Date.parse 的完整搬法),删掉 `market::dateParseIso`。
  原来的严格 ISO 读法在旧式写法、顺延的日子(2 月 30 日)、越界的时区偏移上与 V8 不同,越界偏移还会静默变成 1970;换完之后 parseWhen / dteBucket 与 TS 一致。
  本机时区只查一次(`util::systemZone()`)。
- TS 原样(twsmisc,2026-10-20):`diagnose` 的 `handshake: null` 经 `??` 仍走默认握手,「SDK 不可用」那支走不到,C++ 不写;端口关着一律报「端口 N 拒绝连接」,不看探测的原文;
  连接名是 `toString` 这类原型键时过得了 `=== undefined`,host / port / readonly 为 undefined、client_id 为 NaN;`launchApp("toString")` 先扫安装目录再抛「没有找到 IB Gateway 的安装」;
  执行历史的版本检查里 NaN 只被 `isFinite` 拦下。端口排序照搬 V8 短数组排序(含比较函数回 NaN)。Windows 分支写了、本机没跑过。
- ibwire(评审 2026-10-20):placeOrder 编码在接口版本 100–193 全部 94 档上与 stoqey 逐字节一致(5 个种子各 2 万单)。B1 已修:OPEN_ORDER 里五处版本守卫改成 `!(version >= N)`,
  与 stoqey 在版本格读成 NaN 时同样跳过。M1 已修:`splitFrames` 用 `util::nodeUtf8`(WHATWG 解码,与 Node 的 Buffer.toString 一致)。
  记一笔、不改的设计取舍(M2):单帧上限 16 MB 即断(stoqey 是缓冲累计超 0xffffff)、长度格按无符号读、帧尾没有 `\0` 时不跨帧拼残片;真 TWS 每帧以 `\0` 结尾,碰不到。
- 范围决定(用户 2026-10-20):**TS 版冻结,不再加新功能**(只修 bug);TS 版现有的**全部功能都要搬进 C++ 版**(富途除外,见上)。
  C++ 版的完成标准因此是"TS 现有行为全覆盖",不是"golden-rpc 能过";golden-rpc 之外的路径(后台循环、提醒、托管单、对账)也要逐项对上。
- 排序(评审 2026-10-20,market M1):`util::market::jsSort` 改成与 V8 14.6 的 ArrayTimSort 一样——不到 8 个直接二分插入、8 个起先找自然顺段;64 个起仍用 `std::stable_sort`
  (只在比较函数前后一致时与 V8 相同,比较结果出现 NaN 时次序可能不同)。tws_detect 原来自带一份同样的排序,已改用这一份;`util/market_js` 挪进 ibkr_util 本体。
- **TS 疑似缺陷,照搬,待用户定(ib_session 评审 2026-10-20,B1)**:断线期间 `placeOrder` / 改单 / `cancelOrder` 不报错,当场返回 `Submitted`,命令排进库的缓冲,**重连后才一股脑发出,没有时效**;
  新单在等 `nextValidId` 时链路掉了,调用方的 Promise 一直挂着(主动 `disconnect()` 时也不返回、不报错)。`broker.ts` 的 `modifyHosted` / `cancelHosted` 没有 `isConnected()` 检查,
  托管单一秒一改价,断线期间会往缓冲里堆。风险:上层超时后让用户重下 → 重连后旧单先发出 → 重复单。建议的修法(TS 与 C++ 一起改,不是移植时顺手改):
  这三个调用在 `!isConnected()` 时直接抛「与 TWS 的连接已断开」,不入队。
  **用户 2026-10-20 决定一起改,TS 已改**(TS 冻结后唯一的行为改动,算 bug 修复):`ibSession.ts` 的 `placeOrder`(新单与改单)和 `cancelOrder` 在断着时第一句就抛 `LinkDownError`
  (`ibLink.ts`,文案「与 TWS 的连接已断开,正在自动重连」),不交给库、不入队;`broker.cancelHosted` 改成撤单发出去之后才删本地记录
  (否则撤单失败后重试回 false、被当成已撤,券商那边的单还挂着);`engine/hosted.ts` 与 `engine.ts` 的追价失败对 `LinkDownError` 不记熔断
  (断线期间每个托管单一分钟一次失败,几分钟就能把熔断打合上)。仍保留的 TS 行为:新单等 `nextValidId` 时链路掉了,调用方的 Promise 不返回(库里的)。
  顺带:`review-rpc.spec.ts` 的假 router 补了 `historicalBars`(auto 周期随日历翻到日线就变红,与本次改动无关)。
- ib_session 的另一处差异(B2):版本帧之后同一数据块里还有帧、而版本不在 100..193 时,TS 继续解码后面的帧并按低版本编码排队命令;见实现头注释。只有非正常对端会碰到。
- `util/task.h` 完成时同步续跑等待者,JS 要让一拍(M2):`ib_session` 上同拍的 `positions()` 加 `disconnect()` 结果记录顺序与 TS 相反;引擎的 broker 用 `co_await` 时不要在续跑里再调回会话。
- wire_out 只搬了版本 100 起的请求分支;TS 编码器在服务端版本 ≤ 54 时对个别字段(如每条腿的 `exemptCode`)会发 503,C++ 不发。ib_session 的 B2 在版本 ≥ 55 时与 TS 逐字节一致,≤ 54 的版本不在夹具里。真 TWS 不会协商到这么低的版本(握手 V100 起)。
- **llm 评审 2026-10-20(B1 安全,已交回修)**:出网闸(`validateBaseUrl` / 嵌入服务的 `isLoopbackUrl`)用 WHATWG 判主机,而真正连接用 `QUrl`,反斜杠两边解释不同,
  `http://127.0.0.1:A\@localhost:B` 会放行后实际连到 localhost:B,Authorization 和想法原文明文发到别处。修法:连接一律用 WHATWG 解析出的 scheme/host/port,`Exchange::start` 里再加一道最终闸。
  同批待修:请求头按 fetch 规则清洗(B2)、响应解析按 undici 收紧(B4)、base_url 拼接按 WHATWG(M1)。**有意保留的差别(B3)**:C++ 不跟随 301/302/303/307/308 重定向(TS 的 fetch 会跟),
  失败时报明确的错;不跟随更安全(凭据不会被转给另一个主机)。打包时要带 OpenSSL 3 的 libssl/libcrypto,否则 HTTPS 会静默变成「网络不通」(待核实打包产物)。
- **C++ 与 TS 的有意差别(用户 2026-10-21 决定,只改 C++、不改 TS)**:跟单 `follow_service` 的 `process()`,try 只包住发单(`handleInstruction`)本身。发单之后的 `outcomeOf` / `conclude` / `finish`、登记追踪计划、写库任何一步抛错,都不再把一张已经发出的单重新记成 `rejected:发单过程出错`;
  保留已发出的结果,另记一条 `follow_post_submit_error` 审计 / 警告,并照样打上去重标记。TS 原版没有这层保护(发单后出错会被记成「被拒绝」,日志说没发、单子其实在券商那边)。
  对拍夹具里「发单之后才抛错」的场景因此与 TS 不同,在生成器里标成 divergent,另有 C++ 自己的期望测试。
- **C++ 与 TS 的有意差别(2026-10-22,评审发现 TS 也有、按「只改 C++」的惯例处理,用户可否决)**:① 引擎重建(`reload` / `dropEngine`)时,软件盯盘的条件单队列 `pendingTriggers` 交给新引擎(TS 不交:排队没触发的单被孤立,界面列表清空、库里记录停在 PendingTrigger、不触发也无终态无通知);
  ② `firePending` 每一项发单之前重查熔断(TS 只在开头查一次,批中途合闸后面的照样发);③ `halt()` 里 `cancelAllOpen` 抛错时,清 `pendingTriggers` 与托管缓存仍要执行。对拍夹具里命中这三处的场景标 divergent,另有 C++ 自己的期望测试。

