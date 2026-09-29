# 依赖选型

打进安装包的每一个字节都要跟着版本走,所以依赖要克制;但协议客户端、重试退避、状态容器、日历这类别人做得更对、更全的事用现成的。
行为被黄金基线逐字节固定、或者语义是本项目特有的,自己写并用测试覆盖。

## 用了什么

| 包 | 在哪 | 用途 |
|---|---|---|
| `@stoqey/ib` | engine-ts | IBKR TWS API 的 TypeScript 实现 |
| `better-sqlite3` | engine-ts | 同步 API,交易记录是只增的单写者;自带各平台预编译二进制,装机不需要 C++ 工具链 |
| `@anthropic-ai/sdk` | engine-ts | Anthropic 官方 SDK:structured outputs、prompt caching、重试 |
| `openai` | engine-ts | OpenAI 兼容端点(DeepSeek / 通义 / Kimi / 智谱):429 / 5xx / 连接中断自动指数退避重试、超时、带状态码的错误类型 |
| `zod` | engine-ts | RPC 入参的 schema(`contract/schema/`,发单方法用 `.strict()`)与模型输出的复校验(`models.ts`) |
| `@napi-rs/keyring` | engine-ts | 系统凭证库(macOS Keychain / Windows 凭据管理器),原生 N-API,一次读写 3 毫秒以内 |
| `@stdlib/math-base-special-erf` | engine-ts | 误差函数(Cody 有理逼近,double 精度);黄金对拍容差 1e-9,教科书级近似过不了 |
| `futu-api` | engine-ts(开发依赖) | 富途 SDK;适配桥核对完之前不随安装包发出去,见 [富途 OpenD](futu-opend.md) |
| `react` + `antd` + `vite` | desktop | 界面框架、组件库、构建(见 [界面](ui.md)) |
| `zustand` | desktop | 跨页状态容器 |
| `dayjs` | desktop | 日期格式化;AntD 的日期选择器本来就带它 |
| `lightweight-charts` | desktop | TradingView 的图表库:轴、网格、蜡烛、量能、十字光标、缩放平移;业务叠加层用它的 primitives 自己画(见 [行情](priceaction.md))。Apache-2.0,署名在「关于」页 |
| `electron-log` | desktop | 日志落盘。Windows 上 Electron 是 GUI 子系统,没有控制台;主进程、引擎 stderr、渲染层报错、未捕获异常都写进 `userData/logs/main.log`(单份 4 MB,留一份旧的) |
| `electron-builder` | desktop | 打包与安装器 |
| `eslint` + `typescript-eslint` | 两边各一份 | 静态检查,见下 |
| `dependency-cruiser` | 两边各一份 | 模块边界检查:依赖只能往下(规则在各自的 `.dependency-cruiser.cjs`,`npm run depcruise`,CI 里排在 lint 之后) |

**安装包体积。** 引擎的生产依赖按 `package-lock.json` 的闭包整包进安装包,`tools/stage_engine_ts.js` 裁掉 `.d.ts` / `.map` / 测试目录 /
非本平台的预编译二进制。`better-sqlite3` 用白名单(只带 `lib/`、`package.json`、`LICENSE` 与目标平台那一个 `prebuilds/*.node`),
开发机上编译留下的头文件缓存进不了包。`@napi-rs/keyring-<平台>` 一个平台一个二进制,lock 里 12 个都在,暂存时按 lock 条目的 `os` / `cpu`
只收目标平台那一个;目标平台那个不在磁盘上直接报错,不让缺一个原生包的安装包发出去。加运行时依赖之前先算它会把安装包撑大多少(`openai` 裁完约 3.5 MB)。

**桌面端的依赖放哪。** 渲染层的库(react / antd / zustand / dayjs)由 Vite 打进产物,放 `devDependencies`;
主进程 `require()` 的(`electron-log`)必须放 `dependencies`,否则 electron-builder 不打进 asar,打包版一启动就报 `Cannot find module`。

## 刻意不引入的

| 想换的东西 | 现在 | 不换的原因 |
|---|---|---|
| 技术指标库(`trading-signals` / `technicalindicators`) | `backtest.ts` / `priceaction.ts` / `screener.ts` 里自己写的 EMA / SMA / RSI / MACD / ATR / z 分数 | 各家的平滑方式(Wilder 与 SMA 起始值)、初值、空值处理都不同,换库就是换数;这些数被黄金基线逐字节固定,还直接决定扫描页的信号 |
| 期权定价库 | `bsPrice` / `bsGamma` / `bachelierCall` | 本来就只有十几行,erf 已经用 `@stdlib` |
| 时区库(`luxon` / `date-fns-tz` / Temporal) | `tz.ts`(Intl 查表 + 墙钟迭代校正)与 `marketCalendar.ts` | 墙钟与时刻的换算按夏令时边界写清楚并有测试,换库只多一个依赖 |
| 配置校验用 zod | `config.ts` 手写校验 | 每一条错误文案都进了黄金基线,换成 zod 的报错就是换掉用户看到的话 |
| JSON-RPC 库(`json-rpc-2.0` / `vscode-jsonrpc`) | `rpc/server.ts` 的三条道 + `rpc-client.js` | 调度语义是业务约束(交易道严格顺序、读道并发 4、本地道即答、轮询给用户请求让路,见 [引擎 RPC](engine-rpc.md)),通用库表达不了 |
| 数据请求库(`@tanstack/react-query`) | `store/*.ts` 里的轮询 | 这些循环不挂在当前页上,切走了还得运行;react-query 的 `refetchInterval` 跟着组件生命周期走 |
| 向量库(Chroma / LanceDB / pgvector) | 向量存 SQLite 的 BLOB 列,暴力余弦 | 一万条量级是个位数毫秒,见 [想法检索](idea-retrieval.md) |

## lint 只抓真错,不排版

`engine-ts/eslint.config.js` 与 `desktop/eslint.config.mjs`,`npm run lint`,两个 CI 任务的第一步。

- 不接 Prettier:仓库的排版是手调过的(`MACRO_SYMBOLS` 那样按列排整齐的表格写法、handler 里一行写完的短方法、成段中文注释的折行),
  格式化工具重排会洗掉这些可读性,也会让 `git blame` 失真。
- 只开能抓到真错的规则:未使用的变量与导入、`==`、常量条件、不可达循环、React 的 hooks 规则。
- 关掉三条只制造噪声的:`no-promise-executor-return`、`require-atomic-updates`、`no-useless-assignment`。
  引擎的 `prefer-const` 用 `destructuring: "all"`;界面的全角空格规则开着 `skipJSXText`(回测流程图里的全角空格是内容)。
- `type Rec` 由 `no-restricted-syntax` 禁止,只有对外的四个文件与一张存量豁免表例外,**豁免表只许变短**。引擎的 `no-explicit-any` 没开,新代码不用 `any` 靠评审。

## 凭证的存放与迁移

密钥存系统凭证库(`@napi-rs/keyring`)。旧版的存法是 macOS 的 `security` 命令(Keychain 里的 generic password)与 Windows 的
`%LOCALAPPDATA%/dafri/credentials.dpapi.json`(DPAPI 密文):

- 第一次读到就迁移:凭证库里没有、旧存储里有 → 解出来写进凭证库,再把值交出去,用户不用重填。
- 旧的不删,回退到旧版本时那边还读得到;用户删除这条凭证时两边一起清掉,否则删完再读又被迁回来。
- `tests/keychain.spec.ts` 在 Windows 上真的造一份旧格式密文(临时 `LOCALAPPDATA`)走完这条路。

## 升级怎么判断

Dependabot 开升级的 PR(`.github/dependabot.yml`:npm 每周、GitHub Actions 每月)。分组规则:

- 开发依赖的小版本与补丁,每个 npm 工程合成一个 PR(`dev-tools`),Electron 除外;
- 生产依赖(引擎的 zod、openai、`@anthropic-ai/sdk`、better-sqlite3、`@stoqey/ib`、keyring、erf,桌面端的 `electron-log`)与 Electron,哪怕是补丁也一个依赖一个 PR;
- 大版本一个依赖一个 PR,必须一起动的除外(react 全家、vite 与它的插件);GitHub Actions 的升级全部合成一个 PR。

改到依赖清单的 PR 会顺带跑一遍「安装包」工作流。**CI 通过之后还要看这个依赖发不发给用户**:

- **只在开发时用的**(eslint、vitest、dependency-cruiser…):lint、类型检查、全套测试过了就可以合。
- **随包发出去的**(引擎的 `dependencies`、渲染层的库、Electron):还要看「安装包」工作流,它真的打包、拉起安装包里的引擎、把应用启动 30 秒。
- **钱路径上的**(`@stoqey/ib`、`zod`、`better-sqlite3`):先把新旧两版的包内容 diff 一遍再决定;离线测试用的是假的 TWS,证明不了库的协议实现没变。

`engine-ts/vitest.config.ts` 排除了 `dist/**`:tsc 会把 `tests/` 编译进 `dist/tests`,不排除的话开发机上每条用例会对着编译产物再跑一遍。

### 界面升级怎么验证

截图工具要起 Electron,沙箱里起不了,所以用预览台(`npm run ui:preview`,假数据源)加一段在页面里运行的脚本 `desktop/tools/ui_compare.js`
(用法见 [tools/README](../../desktop/tools/README.md)):

- 改动前后各构建一份预览,同一份假数据、同一个窗口尺寸;采集之前清掉界面记住的状态。
- 每个叶子页采三遍:默认态、收着的参考资料全部点开之后、做完演示动作之后(清单取自 `capture_pages.js` 的 `DEMO`)。
- 每个状态记两样:带文字的元素(文字内容区的左边与纵向中线、字号、字重、颜色、字体)与看得见的盒子(有底色、边框或投影的元素,外加输入框内容区、图标、画布)。
  盒子按位置与样式配对,不看 DOM 结构,组件库换了内部结构也比得出来。位置差 1px 以内算一样。
- 场景至少覆盖:主场景浅色与深色、1024×768 窄窗口、首次启动、压力数据、就绪清单有一步已完成、弹层与聚焦态、条款同意页。
  悬停态单独把鼠标移上去抽查。

比不出来的:字体渲染、`titleBarOverlay`、Windows 150% 缩放只有 Electron 里才是真的。所以这个办法能证明"没变",
发版之前还要照 [发版核对清单](../release-checklist.md) 把界面逐页过一遍。

### 刻意没升的大版本

| 包 | 停在 | 卡在哪 | 什么时候再看 |
|---|---|---|---|
| `typescript` | 5.9 | `typescript-eslint` 8 要求 `typescript <6.1.0`,TypeScript 7 装不上 | `typescript-eslint` 支持 7 之后;Dependabot 里忽略着,到时删掉那条 |
| `@types/node` | 24 | 类型要跟着运行时:Electron 41 内置的与 CI 用的都是 Node 24,类型先升会放行运行时还没有的 API | 换 Electron 大版本、Node 跟着变时,和工作流里的 `node-version` 一起改(`desktop-release.spec` 检查两者一致) |
| `zod` | 3.25 | 4 改了校验问题的结构与默认报错文案,直接换上去有编译错与大量测试红;它管着 RPC 入参校验(含发单方法的 `.strict()`)、模型输出复校验、黄金基线里的报错原话 | 单独做一次迁移:报错文案逐条对回原样(不为了让基线过而 `golden:update`),再核对 `.default()` / `.nullish()` / `preprocess` 的语义有没有让原来拒绝的订单变成放行。3.25 已带 `zod/v4` 子路径,可以逐个 schema 迁移 |
| `electron` | 41 | 42 起 macOS 的系统通知要求正式签名,ad-hoc 签名的包发不出通知 | 有了 Developer ID 签名的包之后,见 [发版](release.md) |
