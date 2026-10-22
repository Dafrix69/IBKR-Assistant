# native/ — Qt 6 / C++ 重写

为什么重写、分几段、怎么证明对:[docs/briefs/qt-rewrite.md](../docs/briefs/qt-rewrite.md)。这里只写怎么编、怎么跑。

## 现在有什么(阶段 0 与阶段 1 起步)

| 目录 | 是什么 |
|---|---|
| `engine/util/` | `jsnum`(照 JS 的 parseInt / parseFloat 读数:TS 引擎读 TWS 报文全靠它们)、`redact`(遮账号,同 `desktop/redact.js`)、`awake_clock`(睡眠里不走的钟)、`post`(跨线程投递) |
| `engine/execution/tws/` | TWS 线协议:`codec`(纯函数,握手 / 报到 / 持仓 / 当前时刻 / 报错)、`transport`(QTcpSocket)、`client`、`recording`(录制与回放)、`positions_snapshot`(连上读一次持仓就关)。**只会说只读的那几句,发不了单** |
| `engine/transport/` | stdio 上的 JSON-RPC:`rpc_server`(读行、三条道、回执与事件、收尾,同 `rpc/server.ts` 的传输与生命周期,线上行为对着 TS 现跑的输出)、`context`(同 `rpc/context.ts`)、`cli`(同 `cli.ts` 里不要引擎的命令)。`system.status` 只有形状是对的 |
| `shell/` | 界面那个进程里不画界面的那一半(只用 Qt Core):`engine_client`(拉起引擎子进程、请求与回执、先死后生的重启,同 `desktop/rpc-client.js`)、`engine_supervisor`(配置 / 交易库坏了不重启、别的退避重启、心跳、条件单轮询,同 `main.js`)、`status_store`(状态快照,同 `store/status.ts`)、`instance_guard`(Electron 版开着不拉引擎、Qt 版只开一个)、`fatal_line` |
| `app/` | Qt Quick 窗口:底部状态条与横幅。默认拉 TS 引擎 |
| `tools/` | `tws-positions`(连 TWS 读一次持仓,可录报文)、`tws-replay`(回放录像) |
| `tests/` | QtTest,全部离线。`fixtures/stoqey-v193.json` 是拿 TS 引擎在用的 `@stoqey/ib` 现算的对拍期望(`node tests/fixtures/gen_stoqey_v193.mjs` 重生成,不手改) |

## 在 VS Code 里改、编、跑

1. 先装工具链(一次):`brew install qtbase qtdeclarative qtwebsockets qtsvg qttools cmake ninja`
2. VS Code 里「文件 → 打开文件夹」选 **`IBKR-Assistant/native`** 这个目录(不是仓库根),右下角提示装推荐扩展时点安装:
   CMake Tools、clangd、CodeLLDB、Qt QML、Qt C++。
3. CMake Tools 会自己按 `CMakePresets.json` 配置;第一次问选哪个预设时选 **macOS Debug**(`mac-debug`)。
   编译目录在 `~/Library/Caches/IBKR-Assistant/native-build/<预设>`,不在桌面上:桌面是 iCloud 同步的,
   同步会把编译产物逐出、也会给 `.app` 加属性让签名失败。
4. 编译:`⇧⌘B`(任务「CMake: 编译」)或状态栏的「生成」。测试:侧栏的「测试」面板(CTest),或任务「CMake: 跑测试」。
5. 运行 / 调试:`F5`,在「运行和调试」里选一项:
   - **界面 Datrix**:拉起现在的 TS 引擎(`node engine-ts/dist/src/cli.js rpc`),底部状态条每 5 秒问一次状态。
     **用的是真配置**(同 Electron 版开发时:`--config` → `DAFRI_CONFIG` → 仓库里的 `config/settings.json`):会按设置连 TWS、
     开真的交易库、跑盯盘。Electron 版开着时它不拉引擎(两个引擎会同时盯同一个交易库)。只想看界面、不拉引擎:参数加 `--engine none`。
   - **引擎 ibkr-engine**:开在集成终端里,一行一条请求,例如 `{"jsonrpc":"2.0","id":1,"method":"system.status"}`;`⌃D` 结束。带命令时是命令行(`ibkr-engine selftest --config …`、`validate`、`records`、`import-fills` 等,同 `cli.ts`;`parse` / `run` 还没搬)。
   - **tws-positions**:连**纸面账户**的 TWS(7497)读一次持仓,账号遮过才打出来;报文录到 `~/Library/Caches/IBKR-Assistant/tws-positions.twsrec`
     (含真实账号,不进仓库)。TWS 要开着、「启用 ActiveX 与套接字客户端」勾上。
   - **tws-replay**:把上一次录的放回去,写出去的字节对不上就退出码 3。
   - 断点直接点行号左边;CodeLLDB 会停在那里。
6. 预设还有 `mac-release`、`mac-asan`(AddressSanitizer + UBSan)、`mac-tsan`(ThreadSanitizer),状态栏里切。
7. Windows:先装 Qt(在线安装器或 aqt)并把环境变量 `QT_ROOT_DIR` 设成那一份(如 `C:\Qt\6.10.3\msvc2022_64`),
   预设选 `win-debug`;「运行和调试」里的 Windows 两项会把 `QT_ROOT_DIR\bin` 加进 PATH(编译目录里没有 Qt 的 DLL)。

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
- 引擎的每个模块对着原模块现算的答案测(`tests/fixtures/gen_<模块>.mjs` 读 `tsc` 编出来的 `engine-ts/dist`);
  JS 的数与字符串之间的转换只走 `util/jsformat` / `util/jsvalue`,不用 `QString::number` / `printf` 拼给人看的数。
- 引擎不直接碰凭证库:`util/secrets` 的读写都经 `ibkr-engine --keychain-child` 子进程、有时限(同 TS 版的 keychain-off-the-loop)。
- 测试不碰用户的 userData(同意记录、Qt 版的锁、Electron 的 `SingletonLock`):起应用的测试设 `IBKR_USER_DATA_DIR` 指到临时目录。
- QML 里的 JS 是 Qt 的 V4,不是浏览器:`Array.prototype.flatMap` 之类没有。绑定里出错默认只打一行 stderr,界面照常开着,
  所以 `--smoke-test` 与 `--screenshot` 遇到任何一条 QML 警告都以退出码 6 失败,`tst_shell` 两条都看退出码。
- 外观照 React 版逐项搬:颜色、圆角、阴影的数取自 `styles.css` / `theme/antd.ts`(`app/kit/Theme.qml` 里写明出处),
  图标是 `tools/gen_icons.mjs` 从 `ui/Icons.tsx` / `ui/AppMark.tsx` 原样渲染出的 SVG(`app/kit/icons/`),不手画。
  对照:`Datrix --engine preview --screenshot x.png [--color-scheme dark]` 与预览台同一页并排看。
- 主进程那一半的每个纯模块(脱敏、弹窗清洗、电源与合盖、配置 / 交易库恢复、诊断包、账户设置、新版本检查、重要事件)与界面那一半的判定(提醒口径、追踪价位、SPX 关口、日内剧本、情报)都有一个
  `tests/fixtures/gen_*.mjs`:用 node 跑 `desktop/` 里的原模块现算期望值。改了原模块就重跑对应的生成器;时间相关的用 `TZ=Asia/Shanghai`。
- 原生的几样(系统通知、提示音、Dock、浮动面板、电源事件)在 `app/platform_mac.mm`;无窗口平台(自检、截图)上一律不碰。
- 界面对照 React 版有三层,由强到弱:
  1. **字对字**:页面的模型(C++)按文档次序吐出来的字,对着原组件用 SSR 渲染出的 HTML 抽的字(`tests/fixtures/ssr/`:vite SSR 打包、
     zustand 换成读此刻状态的版本;生成器把场景灌进 React 版的 store 再渲染)。例:`gen_track_card.mjs`、`gen_tracker_page.mjs`。
  2. **钱路径逐步对**:会发单的按钮(表单的 start()、卡片的立即平仓)把原文件里的那个函数原样切出来,依赖换成记录调用的假货跑场景,
     C++ 版按同样的假货重放;载荷再过引擎的 zod schema。例:`gen_track_form.mjs`、`gen_track_actions.mjs`。
  3. **排版对位置**(无窗口平台按 72 DPI 排字,同 macOS 的窗口,应用自己设;另跑 `qml` 量字时要自己带 `QT_FONT_DPI=72`):`--screenshot x.png --dump-texts qt.json --open page:<页>[@y][#form:<key>]` 把看得见的每段字的位置字号写出来;
     React 版在预览台(`tools/preview_server.mjs` 发 dist-preview 并收结果)里跑 `tools/text_dump.js` 的同一份量法;
     `node tools/compare_texts.mjs qt.json react.json --from … --to … --anchor …` 按字对齐、以 anchor 为原点比相对位置。
     CSS 的行高(`kit/Label` 的 css,默认 1.47 = theme/antd.ts)与外边距合并要照搬,不然一页下来差几十像素。
     比的还有颜色(任一通道差过 0.04 就报)。字宽:页面的字一律走 `kit/Label`(小数像素、系统字体的字距表、可变字重都在那里校正,见 brief 的已知差异);
     直接写 `Text` 的地方没有这些校正,只留给富文本与图里的字。表格的格子、`.pill`、`.card-meta`、`.chip`、`.price`、`.num` 在 CSS 里是等宽数字(`tnum: true`)。
- 只给测试 / 截图用的开关:`--open page:<页>[@y][#form:<持仓 key>|#form:parse|#focus:<标的>]`(持仓追踪页展开某张表单 / 交易指令页填一条指令按「解析并校验」/ 模拟弹窗「查看」带着标的跳过来;行情页的 `#focus:<标的>` 是标的档案的「K 线」:换成它并分析),交易指令页还有 `#form:fly|fly-run|playbook`(右栏翻到那一面),交易记录页 `#form:<记录 id>`(打开那一条的单据),订单看板 `#form:feed`(往通知流推两条),扫描页 `#form:scan|scan-leaders`(点「扫描」,再点「筛选强势股」),回测页 `#form:run|sweep|custom|option`(填 NVDA 跑一次 / 均线交叉扫参数 / 换自定义 / 换买入蝴蝶),交易分析页 `#form:run|stock`(分析默认那一笔 / 先选股票那一笔再分析),绩效体检页 `#form:signals|sizer|share`(给信号打分 / 仓位计算器填权益 50000、比例 1.5 / 打开分享卡片),情报页 `#form:dossier[<y>]|lookup`(打开 NVDA 的档案、正文滚到 y / 开过 NVDA 再打开查标的),接入页的子页签直接写成页名(`page:tws|futu|accounts|llm|follow`),设置页 `#form:open|problems`(保护规则与风险预算全打开 / 再清空单笔名义金额点保存)、`--open chart:<n>`(把 `tests/fixtures/chart_scale_cases.json` 的第 n 个场景按它的尺寸放进一张图;不写 `--engine` 时用预览台的引擎)、`--open all|act|popup`(截图前先打开抽屉 / 对话框 / 提醒小窗)、`--color-scheme dark`、`--quit-after 毫秒`。
