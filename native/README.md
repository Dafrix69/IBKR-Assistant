# native/ — Datrix(Qt 6 / C++)

仓库里唯一的应用。当初为什么重写、怎么证明和原版一样:[docs/briefs/qt-rewrite.md](../docs/briefs/qt-rewrite.md)。这里只写怎么编、怎么跑。
Electron 版与 TS 引擎已删;下文提到的 `desktop/…`、`engine-ts/…`、`*.ts` 是"照着哪个原模块搬的"出处,原文件在 `main` 分支。

## 有什么

| 目录 | 是什么 |
|---|---|
| `engine/util/` | `jsnum`(照 JS 的 parseInt / parseFloat 读数:TS 引擎读 TWS 报文全靠它们)、`redact`(遮账号,同 `desktop/redact.js`)、`awake_clock`(睡眠里不走的钟)、`post`(跨线程投递) |
| `engine/execution/tws/` | TWS 线协议:`codec`(纯函数,握手 / 报到 / 持仓 / 当前时刻 / 报错)、`transport`(QTcpSocket)、`client`、`recording`(录制与回放)、`positions_snapshot`(连上读一次持仓就关)。**只会说只读的那几句,发不了单** |
| `engine/transport/` | stdio 上的 JSON-RPC:`rpc_server`(读行、三条道、回执与事件、收尾,同 `rpc/server.ts` 的传输与生命周期,线上行为对着 TS 现跑的输出)、`context`(同 `rpc/context.ts`)、`cli`(同 `cli.ts` 里不要引擎的命令)。`system.status` 只有形状是对的 |
| `shell/` | 界面那个进程里不画界面的那一半(只用 Qt Core):`engine_client`(拉起引擎子进程、请求与回执、先死后生的重启,同 `desktop/rpc-client.js`)、`engine_supervisor`(配置 / 交易库坏了不重启、别的退避重启、心跳、条件单轮询,同 `main.js`)、`status_store`(状态快照,同 `store/status.ts`)、`instance_guard`(Electron 版开着不拉引擎、Qt 版只开一个)、`fatal_line` |
| `app/` | Qt Quick 界面。默认拉同一次编出来的 C++ 引擎 `ibkr-engine` |
| `spec/` | `contract/`:引擎与界面的契约类型(原 `engine-ts/src/contract`,测试当数据读);`baseline/`:录制基线(96 步 RPC 回放、大模型输出的 schema `baseline/llm`,引擎运行时也读它) |
| `tools/` | `tws-positions`(连 TWS 读一次持仓,可录报文)、`tws-replay`(回放录像)、`preview/`(预览引擎:node 跑的假数据,`--engine preview`)、`discord-window-follow.swift`(跟单本地收件读窗口的程序)、`make_icon.swift`(应用图标) |
| `tests/` | QtTest,全部离线。`fixtures/` 里的期望值原来由 TS / React 原版现算(生成器随原版一起删了),往后改口径就手改期望值 |

## 在 VS Code 里改、编、跑

1. 先装工具链(一次):`brew install qtbase qtdeclarative qtwebsockets qtsvg qttools cmake ninja`
2. VS Code 里「文件 → 打开文件夹」选 **`IBKR-Assistant/native`** 这个目录(不是仓库根),右下角提示装推荐扩展时点安装:
   CMake Tools、clangd、CodeLLDB、Qt QML、Qt C++。
3. CMake Tools 会自己按 `CMakePresets.json` 配置;第一次问选哪个预设时选 **macOS Debug**(`mac-debug`)。
   编译目录在 `~/Library/Caches/IBKR-Assistant/native-build/<预设>`,不在桌面上:桌面是 iCloud 同步的,
   同步会把编译产物逐出、也会给 `.app` 加属性让签名失败。
4. 编译:`⇧⌘B`(任务「CMake: 编译」)或状态栏的「生成」。测试:侧栏的「测试」面板(CTest),或任务「CMake: 跑测试」。
5. 运行 / 调试:`F5`,在「运行和调试」里选一项:
   - **界面 Datrix**:拉起同一次编出来的 C++ 引擎(`ibkr-engine --config …`,提示词与 schema 的目录由界面用 `DAFRI_PROMPT_DIR` / `DAFRI_SCHEMA_DIR` 指给它)。
     **用的是真配置**(`--config` → `DAFRI_CONFIG` → 仓库里的 `config/settings.json`):会按设置连 TWS、开真的交易库、跑盯盘。
     旧的 Electron 版开着时它不拉引擎(两个引擎会同时盯同一个交易库)。只想看界面、不拉引擎:参数加 `--engine none`;看假数据:`--engine preview`(要 node)。
   - **引擎 ibkr-engine**:开在集成终端里,一行一条请求,例如 `{"jsonrpc":"2.0","id":1,"method":"system.status"}`;`⌃D` 结束。带命令时是命令行(`ibkr-engine selftest --config …`、`validate`、`records`、`import-fills` 等,同 `cli.ts`;`parse` / `run` 还没搬)。
   - **tws-positions**:连**纸面账户**的 TWS(7497)读一次持仓,账号遮过才打出来;报文录到 `~/Library/Caches/IBKR-Assistant/tws-positions.twsrec`
     (含真实账号,不进仓库)。TWS 要开着、「启用 ActiveX 与套接字客户端」勾上。
   - **tws-replay**:把上一次录的放回去,写出去的字节对不上就退出码 3。
   - 断点直接点行号左边;CodeLLDB 会停在那里。
6. 预设还有 `mac-release`、`mac-asan`(AddressSanitizer + UBSan)、`mac-tsan`(ThreadSanitizer),状态栏里切。
7. Windows:先装 Visual Studio 2022 Build Tools 的 C++ x64/x86 工具与 Windows SDK,以及 CMake(至少 3.25)、Ninja。
   Qt 用在线安装器或 aqt 装 MSVC 2022 x64 版,包括 qtbase、qtdeclarative、qtsvg、qttools、qtshadertools;Discord 网关还要 qtwebsockets。
   把环境变量 `QT_ROOT_DIR` 设成那一份(如 `C:\Qt\6.10.3\msvc2022_64`),预设选 `win-debug`。
   命令行要先进入 VS 的 x64 Developer PowerShell,再把下文三条命令的 `mac-debug` 换成 `win-debug`;
   运行前把 `QT_ROOT_DIR\bin` 加进 PATH。「运行和调试」里的 Windows 两项会自动加它(编译目录里没有 Qt 的 DLL)。

改了 C++ 不用管 `compile_commands.json`:CMake Tools 每次配置后会拷一份到 `native/` 给 clangd(已 gitignore)。

## 不用 VS Code

```
cmake --preset mac-debug
cmake --build --preset mac-debug
ctest --preset mac-debug
```

在 Claude 的沙箱里编(xcrun 写不了缓存,所以直接指到 CommandLineTools 的编译器与 SDK,编译目录放沙箱能写的地方):

```
cmake --preset mac-debug -B /tmp/claude-501/ibkr-native-build \
  -DCMAKE_CXX_COMPILER=/Library/Developer/CommandLineTools/usr/bin/clang++ \
  -DCMAKE_OSX_SYSROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk
```

## 规矩(在 CLAUDE.md 之外多的几条)

- TWS 的字段次序对着 MIT 的移植版核(`@stoqey/ib`、`ibExecHistory.ts`),**不照着 IB 的 GPL 源码写**,那份源码也不进仓库。
- 线上的结构里数一律是 `double`(和 TS 引擎拿到的 JS 数一样,含 NaN);往上用时再换类型。
- 测试不连真券商;回环上的那一条只连测试自己开的端口。真机录的报文含账号,不进仓库(`*.twsrec` 已 gitignore)。
- 重写里不顺手改行为:发现 TS 版疑似有问题,记下来、照原样搬。
- 要认"电脑睡过没有"的计时一律用 `util::awakeMicros()`,不用 `QElapsedTimer` / `std::chrono::steady_clock`:
  它们在 macOS 上是 CLOCK_MONOTONIC_RAW,**睡眠里照走**(和 TS 版踩过的 libuv hrtime 是同一个坑)。
- 从别的线程交给某个对象所在线程去做的事,一律走 `util::postQueued`,不直接调 `QMetaObject::invokeMethod`:
  装的 QtCore 没有 TSan 插桩,TSan 编法要在那一处补一把它看得见的锁(别的编法里没有这把锁)。
- 各个 store 调引擎一律用带 context 的 `bridge_->rpc(this, …)` / `bridge_->confirm(this, …)`,不用不带的那一个:
  store 比引擎先析构,引擎停下时把在途的调用一并回绝,不带 context 的回调会打到已经没了的对象上。
  同理,长寿的 lambda 里捕获的 QObject 指针用 `QPointer`。
- 表单控件是**受控**的(`Dafri.Kit` 的 InputNumber / Select / Checkbox / Switch / Segmented):`value` / `checked` 只由外面绑定,控件只发信号
  (`valueEdited` / `activated` / `toggled`),绝不给自己赋值——一赋值外面的绑定就断了,框里显示的和真正发出去的就不是同一个数。
- 会随数据刷新的列表(持仓、追踪卡片……)给 Repeater 的 model 用 `shell/keyed_list_model`(按键原地更新),不给现拼的 JS 数组:
  数组一换所有 delegate 销毁重建,卡片里展开着的表单每秒回到初值。`tst_kit_controls` 钉着这两条。
- 浮点照 JS 一步一舍:全工程 `-ffp-contract=off`(arm64 上 clang 默认把 `a * b + c` 合成 FMA,末位就和 TS 版对不上)。
  要 FMA 的地方显式调 `std::fma`(如 `jsToFixed` 判一半)。
- 引擎里 TS 的 `throw new Error(…)` 是 `util::JsError`(带错误码的是 `util::RpcError`),话一个字不改;`async` 函数是 `util::Task<T>` 协程(见 `engine/util/task.h`):
  **协程的参数一律传值**(挂起之后引用就悬空了);协程是活得比它所有 await 都长的对象的成员函数,或者 co_await 之后先查 `QPointer` 再碰对象;
  不写按引用捕获局部变量的 lambda 协程。`tst_task` 在 ASan 下钉着异常、共享等待、对象先没了、超时不撤这几条。
- 引擎的每个模块对着原模块当时现算的答案测(期望值在 `tests/fixtures/`,原版删了以后只能手改);
  JS 的数与字符串之间的转换只走 `util/jsformat` / `util/jsvalue`,不用 `QString::number` / `printf` 拼给人看的数。
- 引擎不直接碰凭证库:`util/secrets` 的读写都经 `ibkr-engine --keychain-child` 子进程、有时限(同 TS 版的 keychain-off-the-loop)。
- 测试不碰用户的 userData(同意记录、Qt 版的锁、Electron 的 `SingletonLock`):起应用的测试设 `IBKR_USER_DATA_DIR` 指到临时目录。
- QML 里的 JS 是 Qt 的 V4,不是浏览器:`Array.prototype.flatMap` 之类没有。绑定里出错默认只打一行 stderr,界面照常开着,
  所以 `--screenshot` 遇到任何一条 QML 警告都以退出码 6 失败,`tst_shell` 看退出码。
- 外观照 React 版逐项搬:颜色、圆角、阴影的数取自 `styles.css` / `theme/antd.ts`(`app/kit/Theme.qml` 里写明出处),
  图标是当初从 React 版的 `ui/Icons.tsx` / `ui/AppMark.tsx` 原样渲染出的 SVG(`app/kit/icons/`),新图标照同样的线宽与网格画。
  截图:`Datrix --engine preview --screenshot x.png [--color-scheme dark]`。
- 主进程那一半的每个纯模块(脱敏、弹窗清洗、电源与合盖、配置 / 交易库恢复、诊断包、账户设置、新版本检查、重要事件)与界面那一半的判定(提醒口径、追踪价位、SPX 关口、日内剧本、情报)都有一个
  期望值文件(`tests/fixtures/`),当初用 node 跑 `desktop/` 里的原模块现算;原模块已删,改口径时直接改期望值并在提交说明里写清楚。
- 原生的几样(系统通知、提示音、Dock、浮动面板、电源事件)在 `app/platform_mac.mm`;无窗口平台(自检、截图)上一律不碰。
- 界面当初对照 React 版逐字、逐步、逐位置核过(SSR 抽字、钱路径按钮逐步重放、`--dump-texts` 量位置);React 版已删,这几层对照不再能重跑,
  `--dump-texts` 仍可用来比两次 Qt 截图之间的排版。字宽:页面的字一律走 `kit/Label`(小数像素、系统字体的字距表、可变字重都在那里校正)。
- 只给测试 / 截图用的开关:`--open page:<页>[@y][#form:<持仓 key>|#form:parse|#focus:<标的>]`(持仓追踪页展开某张表单 / 交易指令页填一条指令按「解析并校验」/ 模拟弹窗「查看」带着标的跳过来;行情页的 `#focus:<标的>` 是标的档案的「K 线」:换成它并分析),交易指令页还有 `#form:fly|fly-run|playbook`(右栏翻到那一面),交易记录页 `#form:<记录 id>`(打开那一条的单据),订单看板 `#form:feed`(往通知流推两条),扫描页 `#form:scan|scan-leaders`(点「扫描」,再点「筛选强势股」),回测页 `#form:run|sweep|custom|option`(填 NVDA 跑一次 / 均线交叉扫参数 / 换自定义 / 换买入蝴蝶),交易分析页 `#form:run|stock`(分析默认那一笔 / 先选股票那一笔再分析),绩效体检页 `#form:signals|sizer|share`(给信号打分 / 仓位计算器填权益 50000、比例 1.5 / 打开分享卡片),情报页 `#form:dossier[<y>]|lookup`(打开 NVDA 的档案、正文滚到 y / 开过 NVDA 再打开查标的),接入页的子页签直接写成页名(`page:tws|futu|accounts|llm|follow`),设置页 `#form:open|problems`(保护规则与风险预算全打开 / 再清空单笔名义金额点保存)、`--open chart:<n>`(把 `tests/fixtures/chart_scale_cases.json` 的第 n 个场景按它的尺寸放进一张图;不写 `--engine` 时用预览台的引擎)、`--open all|act|popup`(截图前先打开抽屉 / 对话框 / 提醒小窗)、`--color-scheme dark`、`--quit-after 毫秒`。
