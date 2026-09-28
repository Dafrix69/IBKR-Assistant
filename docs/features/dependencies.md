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
`better-sqlite3` 是白名单(只带 `lib/`、`package.json`、`LICENSE` 与目标平台那一个 `prebuilds/*.node`):原来的黑名单挡不住开发机上
编译留下的残渣——node-gyp 把 devdir 当成字面量 `true` 写出的头文件缓存 `true/<版本>/include` 有 65 MB,0.5.1 的 mac 包就这么
大了一圈(引擎目录 100 MB,改后 18 MB)。

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
| JSON-RPC 库(`json-rpc-2.0` / `vscode-jsonrpc`) | `rpc/server.ts` 的三条道 + `rpc-client.js` | 调度语义是业务约束:**交易道严格顺序、读道并发 4、本地道即答、轮询请求给用户请求让路**(见 [engine-rpc.md](engine-rpc.md))。通用库表达不了这套优先级,而这套语义被 `tests/rpc-lanes.spec.ts` 钉着 |
| 数据请求库(`@tanstack/react-query`) | `store/*.ts` 里的 `setInterval` 轮询 | 这些循环**不挂在当前页上**:持仓追踪一秒一轮会真的发平仓单,条件单轮询是引擎触发的唯一入口,切走了还得跑。react-query 的 `refetchInterval` 跟着组件生命周期走,语义正好相反 |

## lint 只抓真错,不排版

`engine-ts/eslint.config.js` 与 `desktop/eslint.config.mjs` 各一份,`npm run lint`,两个 CI 任务里都是第一步。

**没有 Prettier,也不打算有。** 这个仓库的排版是手调过的:`MACRO_SYMBOLS` 那样的表格式对齐、
`rpc/handlers/` 里一行写完的短方法、成段中文注释的折行位置——交给格式化工具重排,一次提交就把这些可读性洗掉,
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


**2026-09-28 的两处变动**:

- `futu-api` 从引擎的 `dependencies` 挪到 `devDependencies`,不再随安装包发出去(连同它独占的 17 个传递依赖,protobufjs 在内)。
  原因与挪回来的条件见 [富途 OpenD](futu-opend.md)。引擎生产依赖的 `npm audit` 从此是 0。
- `electron` 从 40 升到 41.10.x,并**停在 41**:40 的那条 high 级通告修在 41.10.3;42 起 macOS 的系统通知要求正式签名。
  见 [发版](release.md)。

随包的开源组件与它们的许可由 `tools/gen_notices.js` 收成一份声明,许可不在白名单里的会让打包失败。

## 升级怎么判断

Dependabot 每周提升级的 PR(配置在 `.github/dependabot.yml`)。**CI 绿了不等于能合**,先看这个依赖发不发给用户:

- **只在开发时用的**(eslint、vitest、dependency-cruiser…):lint、类型检查、全套测试过了就可以合。
- **随包发出去的**(引擎的 `dependencies`、渲染层的库、Electron):除了 CI,还要看「安装包」工作流——它会真的打包、
  拉起安装包里的引擎、把应用启动 30 秒。改到依赖清单的 PR 会自动跑它。
- **钱路径上的**(`@stoqey/ib`、`zod`、`better-sqlite3`):先把新旧两版的包内容 diff 一遍,看清楚动了什么再决定。
  离线测试用的是假的 TWS,证明不了库自己的协议实现没变。

合成一个 PR 的只有小版本与补丁。大版本一个依赖一个 PR(必须一起动的除外:react 全家、vite 与它的插件),
混在一组里,一个装不上整组都红。

### 2026-09-28 的第一批(10 个 PR)

| 升级 | 处置 | 依据 |
|---|---|---|
| GitHub Actions:`checkout` 4 → 7、`setup-node` 4 → 7、`upload-artifact` 4 → 7、`download-artifact` 4 → 8 | 合入 | 逐个读了中间各大版本的发布说明:运行时换成 Node 24、内部改成 ESM;有行为变化的几处(按 ID 下载单个产物的路径、`pull_request_target` 下不再检出 fork、校验和不符改为报错)工作流都没用到。`download-artifact` 只在打标签发版时才跑,PR 上的 CI 没有执行过它,**下一次发版是它第一次真跑** |
| `openai` 7.15 → 7.23、`@anthropic-ai/sdk` 0.122 → 0.128 | 合入 | 全套测试(含对本机假端点发真 HTTP 的重试、超时、断连用例)通过;暂存出来的引擎能起来 |
| `@stoqey/ib` 1.6.7 → 1.6.10 | 合入 | 两版的包逐文件比过:**代码一个字节都没变**,只有 `package.json` 把 `rxjs` 从 dependencies 挪成了 peerDependencies。npm 7 起 peer 依赖照样自动装;暂存脚本按 lock 里"不是 dev 的条目"收,`rxjs` 仍在安装包里(暂存后从那份目录 `require('@stoqey/ib')` 验过) |
| 开发工具的小版本:`eslint` 10.11、`typescript-eslint` 8.70.1、`dependency-cruiser` 18.4、`futu-api` 10.11 | 合入(从两个合组 PR 里单拿出来) | lint、分层检查、类型检查、全套测试通过。`futu-api` 只是开发依赖,运行时不加载 |
| `vitest` 3 → 5 | 合入,补了一份 `engine-ts/vitest.config.ts` | 2,023 条测试不改一行全过;`golden:update` 重跑一遍基线零变化。**有一处默认行为变了**:4 起不再排除 `dist/`,而 tsc 把 `tests/` 也编译进了 `dist/tests`——本机只要有编译产物,每条用例会对着它再跑一遍并失败(量到多出 118 个文件、324 条红)。CI 只跑 `tsc --noEmit`、没有 `dist/`,所以 CI 上是绿的,开发机上是红的。配置里把 `dist/**` 排除掉了 |
| 两个合组 PR 里其余的大版本、`zod` 4 | 没升,见下表 | |

### 同一天的第二批(5 个 PR)

分组规则改完之后 Dependabot 马上又提了五个。

| 升级 | 处置 | 依据 |
|---|---|---|
| `@types/node` 24.13.3 → 24.13.6 | 合入 | 类型的补丁版本。PR 上 Windows 红的那一条是「端点关着」的用例撞上了带 401 的随机端口(见 [大模型](llm-providers.md)),与升级无关 |
| `@napi-rs/keyring` 2.0 → 2.1 | 合入 | 凭证库,随包。接口只多了一个可选参数(选 Linux 的凭证存储,别的平台不看),各平台的原生二进制重新构建过——二进制没法 diff,靠的是 PR 上 macOS / Windows 的引擎测试(Windows 那一路真的走一遍 set → get → has → delete)和「安装包」工作流 |
| `vite` 6 → 8、`@vitejs/plugin-react` 4 → 6 | 合入,配置改成 `vite.config.mts` | 打包器从 Rollup 换成了 Rolldown,界面包整个重新生成(JS 1,795 → 1,760 kB)。用下面「界面升级怎么验证」的办法比过:14 个页面全部一致,控制台零报错;CSP nonce 与 `csp-nonce.txt` 一致,脚本标签上没有 `crossorigin`。Vite 8 给的两条警告(配置按 CommonJS 加载、`inlineDynamicImports` 弃用)一并处理了,处理前后产物的内容哈希相同 |
| `antd` 5 → 6 | 合入,界面做了一轮适配 | CI 与「安装包」工作流在 PR 上本来就是全绿的,但界面变了:24 个状态里 23 个和升级前不一样。逐类改回去之后按下面的办法比,结果见下表。改了什么、为什么,在 [界面](ui.md#antd-6-与-react-192026-09-28) |
| `react` 18 → 19(四个包) | 合入 | 要等 `antd` 6(5 不支持 React 19,要另装补丁包)。类型检查红的那 1 处(`JSX` 命名空间)改了;所有声明了 react peer 范围的包都接受 19.3;升完再比一遍,结果与只升 `antd` 时相同 |

### 界面升级怎么验证

沙箱里起不了 Electron,截图工具(`capture_pages.js`)用不上。用的是预览台(`npm run ui:preview`,假数据源)加一段在页面里跑的脚本,
收在 `desktop/tools/ui_compare.js`(用法见 [tools/README](../../desktop/tools/README.md)):

- 改动前后各构建一份预览,同一份假数据、同一个窗口尺寸;采之前清掉界面记住的状态,两份是同一个起点;
- 每个叶子页采三遍:默认态、把收着的参考资料全点开之后、做完演示动作之后(解析、回测、扫描、点开一条记录…,
  清单取自 `capture_pages.js` 的 `DEMO`);
- 每个状态记两样:**带文字的元素**(文字内容区的左边与纵向中线、字号、字重、颜色、字体)、**看得见的盒子**
  (有底色、边框或投影的元素,外加输入框的内容区、图标、画布)。盒子按位置与样式配对,不看 DOM 结构——组件库换了内部结构也比得出来;
- 位置差 1px 以内算一样。同一份构建自己跟自己比,只有「全链路 xx ms」那个数字会不一样。

`antd` 6 + `react` 19 对升级之前(`antd` 5 + `react` 18,同为 Vite 8)的结果:

| 场景 | 状态数 | 完全一致 | 其余 |
|---|---|---|---|
| 主场景(TWS 已连),浅色,1360×900 | 34 | 28 | 搜索按钮 ×4、扫描表列宽 ×1、耗时数字 ×1 |
| 主场景,深色 | 34 | 28 | 同上 |
| 主场景,浅色,1024×768 | 34 | 30 | 搜索按钮 ×4 |
| 首次启动(没配 Key、没连券商) | 32 | 28 | 搜索按钮 ×4 |
| 压力数据(长名字、满池子) | 34 | 29 | 搜索按钮 ×4、耗时数字 ×1 |
| 就绪清单里有一步已完成 | 5 | 5 | — |
| 弹层与聚焦态:下拉框、日期选择器、气泡、分享卡片对话框,三种输入框拿到焦点 | 7 | 7 | — |
| 条款同意页的三个标签页 | 3 | 3 | — |

"其余"那三样是看过之后留着没对齐的,说明在 [界面](ui.md#antd-6-与-react-192026-09-28)。
悬停态单独把鼠标移上去看了四处(数字输入框的上下箭头、顶栏按钮、表格行、分段控件),计算出来的样式两边相同。

**比不出来的**:字体渲染、`titleBarOverlay`、Windows 150% 缩放只有 Electron 里才是真的;悬停态只抽查了四处;
深色主题只跑了主场景。所以这个办法能证明"没变",不能代替真机上看一眼——发版之前照
[发版核对清单](../release-checklist.md) 把界面逐页过一遍。

### 刻意没升的大版本

| 包 | 停在 | 卡在哪 | 什么时候再看 |
|---|---|---|---|
| `typescript` | 5.9 | `typescript-eslint` 8 要求 `typescript <6.1.0`,TypeScript 7 装不上(`npm ci` 报 ERESOLVE)。那一批里同组的六个升级就是被它拖着一起红的。TypeScript 6 没有评估过 | `typescript-eslint` 支持 7 之后。Dependabot 里忽略着,到时候删掉那条 |
| `@types/node` | 24 | 类型要跟着运行时走:Electron 41 内置的与 CI 用的都是 Node 24。类型先升到 26,编译器会放行运行时还没有的 API,到用户机器上才报错 | 换 Electron 大版本、Node 跟着变的时候,和工作流里的 `node-version` 一起改(`desktop-release.spec` 钉着两者一致) |
| `zod` | 3.25 | 4 改了校验问题的结构(`invalid_type` 没有 `received` 了,`invalid_union` 的 `unionErrors` 换成了 `errors`)和默认报错文案。直接换上去:`contract/schema/kit.ts` 11 处编译错,**58 条测试红**(`contract` 12、`pa-rpc` 10、`golden-rpc` 9、`review-rpc` 7…)。它管着三件事:RPC 入参校验(发单方法的 `.strict()` 在内)、模型输出的复校验(`models.ts`)、golden-rpc 里钉着的报错原话 | 单独做一次迁移:报错文案逐条对回原样(不为了让基线过去 `golden:update`),再核对 `.default()` / `.nullish()` / `preprocess` 在 4 里的语义有没有让某个原来拒掉的订单变成放行。3.25 里已经带着 `zod/v4` 子路径,可以一个 schema 一个 schema 地迁。Dependabot 里忽略着 |

`electron` 停在 41 的原因见上面与 [发版](release.md)。
