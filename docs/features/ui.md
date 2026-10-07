# 界面

桌面端界面在 `desktop/renderer-react/`:React 19 + Ant Design 6 + zustand,Vite + TypeScript 构建。
外观参考 iOS 27 的 Liquid Glass;深浅色默认跟随系统(可以固定成浅色或深色),涨跌配色与玻璃透明度在设置里调。

## 页面结构

侧栏三组、14 项,按使用频率分层(`shell/nav.ts`):

| 组 | 页 |
|---|---|
| 工作区 | 交易指令、订单看板、交易记录、持仓追踪 |
| 研究 | 行情、想法、板块、扫描、回测、交易分析、绩效体检 |
| 应用(沉底) | 接入、设置、关于 |

- 组可以折叠,状态记在本地;快捷键或就绪清单跳到折叠组里的页时自动展开。窗口窄于 1000px 时侧栏收成 60px 图标栏(最小窗宽 900);
  窗口失焦时侧栏图标退成灰色。Ctrl / ⌘ + 1…9 按侧栏顺序切页。
- 徽标:订单看板显示排队等待触发的订单数,板块显示没看过的异动条数。
- 「接入」一页四个子页:TWS、富途 OpenD、账户、大模型;上次看的子页记在 `store/nav.ts`。
  旧页名(`pa` `book` `rs` `inflection` `deviation` `alerts` `quality` `tws` `futu` `accounts` `llm`)经 `PARENT_OF` 跳到所在的页。
- 页面与子页清单登记在 `pages/index.ts`,共 17 个叶子页。

| 页 | 内容 |
|---|---|
| 交易指令 | 输入框与解析结果两栏(可拖动,窄于 980px 上下叠放);「解析并校验」/「发送」;结果卡片列出通过、排队、拒绝、警告与模型、耗时、token;通过的订单画成票据(`lib/OrderTicket.tsx`)与到期损益图;右栏可切到[蝴蝶测算](fly-plan.md);下面是[历史相似交易](similar-trades.md)。见 [交易指令](instruction.md) |
| 订单看板 | 四枚小组件(排队 / 在途 / 成交 / 被拒)、「排队等待触发」与「已提交」分列、实时通知流 |
| 交易记录 | 状态分段条与筛选、列表(舒适 / 紧凑两种密度)、单据式详情、导出 |
| 持仓追踪 | 账户持仓与追踪卡片,见 [持仓追踪](tracker.md) |
| 行情 | K 线与价格行为、盘口、关注的盘口,见 [行情](priceaction.md) |
| 想法 | 随手记、AI 分析、知识总结,见 [想法备忘](ideas.md) |
| 板块 | 股票池:成分股、盯价位与盯异动、价位条,见 [股票池](quality-watch.md) |
| 扫描 | RS 强度与拐点一张表、极值偏离、强势股筛选,见 [强势股筛选](leaders.md) |
| 回测 / 交易分析 / 绩效体检 | 见 [回测](backtest-lab.md)、[交易分析](tradereview.md)、[绩效体检](performance.md) |
| 接入 / 设置 / 关于 | 连接与账户、限额与闸门与保护规则与外观与数据备份、版本与更新与支持 |

**顶栏**:美东时间与市场时段合成一格(只到分钟);模型名(三级色小字,悬停变二级色,窄屏第一个丢);券商连接(按生效的券商显示 `TWS` 或 `OpenD`,
引擎不答话时显示「状态未知」)与连接按钮;执行模式;「实盘已放开 / 仅纸面」(放开时红点、字着色加粗,是这一栏唯一例外的着色);
新版本提示;熔断按钮(⌘⇧H;常态写「暂停自动执行」、是普通按钮,熔断后写「解除熔断」并变红;菜单、Dock 与「关于」页里叫「暂停全部自动执行(熔断)」)。栏高固定、不换行,窄窗口按重要性整项丢弃,
连接状态与模式最后丢。顶栏下面是[宏观行情带](macro-board.md)。

**首次启动与出错**:同意现行条款之前整个界面挡在同意页后面(`shell/ConsentGate.tsx`,见 [条款同意](consent.md));
某一页渲染出错时只有那一页换成说明卡(`ui/ErrorBoundary.tsx`),顶栏、侧栏、熔断按钮照常,切页即重试。

## 代码分层

`shell → pages → lib → store → bridge`,`ui/` 与 `theme/` 只做视觉。规则在 `desktop/.dependency-cruiser.cjs`(`npm run depcruise`):
页面之间不互相 import,store 不 import 组件,ui / theme 不认识业务。

| 目录 | 内容 |
|---|---|
| `shell/` | App、Topbar、Sidebar、Toasts、MacroStrip、ConsentGate、nav |
| `pages/` | 每个侧栏项一个文件,合并页的子页在同一文件 |
| `lib/` | 共享组件与纯函数:格式化、词表(`labels.ts`)、图表(`chart/`)、价位条、各个面板 |
| `store/` | 跨页状态与轮询 |
| `ui/` | `kit.tsx`(组合件)、`graphics.tsx`(图形构件)、`Icons.tsx`、`AppMark.tsx`、`ErrorBoundary.tsx` |
| `theme/antd.ts` | AntD 主题 |
| `styles.css` / `shell.css` / `graphics.css` | 变量与布局 / AntD 组件的微调 / 图形构件 |

- 跨页状态用 zustand 的 `create()`,各页只用 `useStatus()` / `useTracker()` 这类 hook。`store/popup.ts`、`store/quality.ts` 仍是手写的订阅加
  `useSyncExternalStore`;`useDark()` 订阅浏览器的 `matchMedia`。
- 轮询循环放在 `store/`,不挂在组件生命周期上,切走页面照常运行:status 5 秒;持仓追踪每秒读引擎最近一轮盯盘的结果;价位提醒 10 秒;
  行情带 2 / 60 秒;挂单 10 秒并跟着引擎事件;持仓页的「账户持仓」只在停留该页时刷新(IBKR 每秒读引擎常驻订阅的缓存,富途 5 秒一次真查询)。
  现有例外:订单看板、想法(60 秒)、交易记录(15 秒)、板块、盘口、K 线(20 秒)在页面里自己计时。
- `window.dafri`(preload)的类型在 `bridge.ts`;载荷形状来自引擎契约,见 [引擎 RPC](engine-rpc.md)「契约」。
- **CSP**:`script-src 'self'`,不加载任何远程资源。AntD 用 CSS-in-JS 注入 `<style>`,构建时生成随机 nonce 写进页面 meta 与
  `dist/csp-nonce.txt`,主进程把它拼进响应头的 CSP;组件库里不接收 nonce 的动态 `<style>` 由 `main.tsx` 补上页面的 nonce。
  React 默认转义,不允许出现 `dangerouslySetInnerHTML`。

## 视觉规则

- **玻璃只给浮在内容之上的那一层**:侧栏(四周留白的 22px 圆角面板)、工具栏里的胶囊、吸顶标题、行情带瓦片。
  内容滚到标题下面时是一整条均匀的玻璃栏(`.page-head::before`,用 `animation-timeline: scroll()` 渐显)。
  卡片是内容,用着色的实面、不加 `backdrop-filter`:几十张卡各自模糊会让滚动掉帧。
- 玻璃边压暗、顶上一道高光(`--glass-edge`)。所有面的透明度由一个变量 `--glass-tint` 计算(设置 › 外观 › Liquid Glass 滑杆,0 通透、1 完全着色);
  系统打开「减弱透明度」时强制为 1 并关闭模糊。Windows 没有 vibrancy,主进程给窗口不透明的底色。
- 窗口底是 iOS 分组灰加两抹几乎看不出的冷色(`--ambient`)。
- 圆角同心:面板 22 → 卡片 20 → 卡内瓦片 14 → 控件 12;按钮、分段控件、标签都是胶囊;开关 46×26。
- 字号:大标题 28px、分组标题 17px、正文 13px、说明 11px;数字用 `--font-display`(SF Pro Rounded,Windows 用 Segoe UI Variable Display)与等宽数字。
- **用色克制**(规则写在 `graphics.css` 开头):面是中性的,颜色只表达语义(涨跌、成败、警告)。饱和实心色只给主按钮和开关,其余约 11% 淡染;
  代码徽章、小组件、事实瓦片灰底;实心图标瓦片只在设置页行首,平涂、不加渐变与彩色投影。
- **文字着色用可访问变体** `--green-text` / `--red-text` / `--orange-text` 与 `--up-text` / `--down-text`;基础色只用于面与图。0 不着色。
- 涨跌色成对做成变量(`--up` / `--down`),「涨跌配色」设置(绿涨红跌 / 红涨绿跌)让界面与图表一起翻转,记在本地。
- 颜色只留给要一眼看见的东西:纸面账户标签是二级色文字;实盘账户、券商托管、自动平仓已开用橙色。
- 状态颜色只有一份:`lib/OrderStatus.tsx`(成交绿、在途蓝、被拒红、撤单灰、熔断橙),看板与记录页共用。
- 元数据(时间、账户、金额)是二级色文字;说明文字行长不超过 760px。
- 图区近黑(`--chart-bg`,浅色下是白),8px 圆角嵌在卡片里。
- 焦点环只有一种(3.5px、强调色 30%);按钮按下只变暗、缩小到 97%,没有水波纹;尊重「减弱动态效果」。

**构件**:`ui/kit.tsx` 是按这套外观配好的组合件(`StatusCard`、`Group` / `GroupRow` / `SwitchRow` / `NumberRow`、`Notice`、`Primer`、`EmptyState`、
`Feed`、`StatTile`、`Working` / `LoadingBlock`、`SectionTitle`、`StepList`);`ui/graphics.tsx` 是图形构件(`IconTile` / `Pill` / `Ring` / `Sparkline` /
`DeltaBar` / `MeterBar` / `SegBar` / `PriceRail` / `PayoffChart` / `StagePath` / `SymBadge` / `Widget`),内联 SVG 与 CSS,颜色只取变量。
新页面要"画一个数"先在这里找。就绪清单、连接指引的步骤列表与记录详情的状态时间线是自己的标记(`.steplist`、`.tl`),尺寸写死在 `shell.css`,
不跟着组件库的内部结构变。`theme/antd.ts` 用 CSS 变量模式配组件 token,值从 `:root` 的 CSS 变量现读。
往 `.ant-*` 上加样式时,用开发者工具(或 `__ui.rulesFor`)确认规则真的生效:组件库的选择器更具体时,自家规则会被盖住。

## 界面文案

- 界面上不出现配置键名与引擎枚举。拒绝卡片的码经 `lib/labels.ts` 的 `REJECT_CODE_LABEL` 翻成中文(「未允许实盘下单」),
  引擎的拒绝信息写设置项的名字;词表里没有的码照旧显示英文。协议取值(`OPT` / `BUY` / `LMT` / `Submitted`)统一翻译,翻不过来的原样显示。
  `tests/desktop-quality-ui.spec.ts` 检查引擎能报的每个码都有中文、黄金基线的 message 里不出现 `auto_execute` / `allow_live_trading`。
- 券商名跟着 `broker_provider` 走:按钮、快捷键提示、执行条件说明、确认框。
- 回测参数的中文名写在引擎的 `STRATEGIES` 里,界面认不出就显示原名。
- 时间:列表里用紧凑格式(`08-21 21:41`,当天只显示时分),完整时间放提示框;详情里用完整格式。到期日显示成 `2026-08-21`。
- 每页开头的说明收成一行三级色的折叠项(`Primer`),展开状态按页记住;「这一页会真的发单」这类安全警告不收。
  「读盘常识」「连不上时照着做」这类参考资料在需要的时候自动展开(没连上时展开、连上收起),用户手动点过一次之后按用户的选择。
- 报错不带 `Error invoking remote method 'rpc': Error:` 这段前缀。
- 横幅的「<动作>失败:」前缀由界面加,只加一次:引擎没起来、入参校验这些报错不经过 handler,只有界面每条路都看得见。
  `ideas.analyze` / `ideas.digest` / `pa.comment` / `backtest.parse_rules` 与一键拉起 TWS / OpenD 的引擎报错自己带着同一个前缀
  (引擎测试钉着原话),这几处用 `bridge.ts` 的 `errorWithPrefix`,已经带着就不再叠一层。

## 交互

- **就绪清单**:「交易指令」页在缺 API Key、缺券商账号、没连券商时列出还差的步骤,每条跳到能解决它的页;条件满足就整块消失,不能永久关闭。
- 「发送」按钮点不动时,悬停说明原因(未打开自动执行 / 未连接 / 已熔断);⌘⇧Enter 与按钮同一个判定。
- 交易指令页的编辑器状态与提交动作在 `store/trade.ts`,切页回来原文与结果都在;主输入框在启动与切回时自动聚焦。
- 长操作显示转圈。横幅(`shell/Toasts.tsx`)从窗口顶部中央落下:提示 6 秒自动消失,错误留着等人看,都可以关。
- 记录详情是一张单据(这笔单、合约、订单、成交、模型、状态时间线、成交明细),原始 JSON 收在折叠区;`Esc` 收起。
- 交易记录的状态筛选带条数、空档禁用;紧凑模式一行 28px,各列位置写死。
- 持仓追踪的设置表单默认收起,一次只展开一张卡。
- 设置页:两个执行闸门的"关"当场生效;有未保存的修改时页头出现提示与保存按钮;保存前检查(`lib/settingsForm.ts`),问题列在保存按钮上方。
- 回传的数据缺字段时,缺哪一格空哪一格,页面其余部分照常。
- 「关于」页列出全部快捷键,按平台显示真实的键名。
- 价位提醒、异动、SPX 走到 25 的整数倍用不抢焦点的置顶弹窗,见 [股票池](quality-watch.md)。

## 两个平台

- 窗口按钮:macOS 用 `hiddenInset`,工具栏左边给红绿灯留 88px(全屏时不留:主进程的 `window` 事件带 `fullscreen`,渲染层设 `data-fullscreen`);
  Windows 用 `titleBarStyle: 'hidden'` + `titleBarOverlay`,系统按钮画在应用工具栏右侧,叠加层透明、配色随深浅色。
- 字体:macOS 用系统字体与苹方;Windows 用 `Segoe UI Variable Text` / `Segoe UI` 与 `Microsoft YaHei UI`。
- 非 macOS 平台上按钮、导航项、记录行的光标是手形。
- 快捷键标签按平台显示(`⌘↩` / `Ctrl+Enter`),监听端认 `metaKey || ctrlKey`。
- 窗口位置与大小记在 `userData/window-state.json`,下次打开回到原处;那个位置已经不在任何一块屏上时居中。

## Mac 版

- **关窗 = 隐藏。** 红灯与 ⌘W 只隐藏主窗口(全屏时先退出全屏),引擎与渲染层照常运行;每次启动第一次关窗时发一条通知说明。
  点 Dock、⌘0、再启动一个实例都经 `showMainWindow()` 叫回窗口。真正退出只有 ⌘Q、Dock「退出」、关机:`before-quit` 先置 `quitting`,`close` 再放行。
- **菜单栏说中文**:每一项显式写中文,用系统自己的叫法(拷贝、隐藏其他、前置全部窗口);⌘, 打开设置、「关于」跳关于页、⌘W、⌘0 主窗口、
  切换全屏幕、「帮助 › 在访达中显示日志」。「窗口」「帮助」挂 `role`,系统的窗口列表与帮助搜索框才挂得上。
- **Dock 右键菜单**:显示主窗口、熔断。从这里(或窗口隐藏时按快捷键)熔断,结果另发一条系统通知。
- **系统界面的语言**:`build.mac.electronLanguages` 写成 `zh_CN / zh_TW / en`(macOS 的语言目录名),存储面板这类系统界面显示中文。
- 「移到应用程序」用 `ditto` 拷贝应用包,扩展属性与框架里的符号链接原样带过去。DMG 用 `ULFO`(LZFSE)压缩。只出 Apple Silicon 包。

### 应用图标

`desktop/tools/make_icon.swift` 画一次矢量,按每个尺寸直接栅格化,产出 `build/icon.icns`(Mac)、`build/icon.ico`(Windows)、
`build/icon.png`(开发态 `npm start` 的 Dock 图标)。

- 造型:Mac 图标网格(1024 画布、824 底板、四周留 100、自带落影),底板是 n = 5 的超椭圆;深海蓝渐变、左上漫射光、上沿亮的玻璃内描边;
  三根逐级走高、越往右越实的白色 K 线,右上一大一小两颗暖金四角星。颜色只有蓝、白、一点金。Windows 版不带落影,底板四周留 32。
- 用 Swift:渐变、柔和投影、抗锯齿的矢量渲染 CoreGraphics 本机就有。`.icns` 由脚本按格式拼出(每个尺寸一段 PNG),不调用 `iconutil`。
- CoreGraphics 的阴影偏移与模糊按设备像素计算,不受坐标变换影响,要自己换算;半透明的 K 线把影线和实体合成一个形状一次填充。
- 顶栏左上角的品牌标与分享卡片的角标画的是同一枚图标:`renderer-react/src/ui/AppMark.tsx` 把脚本的几何与配色抄成常量
  (`<AppMark>` 画 SVG、`paintAppMark` 画 canvas)。**改图标时两处一起改**,重跑脚本并提交 `build/` 下三个产物;打包不依赖这个脚本。

### Developer ID 签名与公证

有证书时本机 `npm run dist:mac:signed`,CI 在仓库 Secrets 里配六项;没证书时 `dist:mac` 出 ad-hoc 签名的包(`identity: "-"`)。

- 签名身份按 Team ID 选:electron-builder 拿 `identity` 在钥匙串的证书名里做子串匹配,Team ID 写在证书名的括号里,不会误中。
- 证书与公证凭据(Apple ID + App 专用密码 / API 密钥 / 钥匙串配置三选一)在打包之前逐项检查。
- 应用包与 DMG 都送公证并装订;最后按 Gatekeeper 的规则自验(`codesign --strict`、`spctl`、`stapler validate`),期望 `source=Notarized Developer ID`。
- 项目在 iCloud 同步目录(File Provider)里时,`tools/dist_mac.js` 把构建输出放到 `~/Library/Caches/IBKR-Assistant/`,DMG 最后拷回 `dist/`:
  File Provider 会异步给应用包目录挂上 `com.apple.FinderInfo`,codesign 当它是垃圾数据拒签。两种包打完都过一遍 `codesign --strict`。
- 签名版用 `build/entitlements.mac.signed.plist`(只有 `allow-jit`);ad-hoc 版的权限文件保留 `disable-library-validation`,没有 Team ID 时去掉它应用起不来。

## 命名

产品名是 IBKR-Assistant(窗口标题、顶栏、安装包名、快捷方式)。`appId`、`window.dafri`、`DAFRI_*` 环境变量、localStorage 的 `dafri-*` 键沿用旧名,
改了会丢用户的偏好;userData 目录按产品名取,旧目录在、新目录里还没有 `settings.json` 时继续用旧目录(`main.js` 开头)。

## 验证

```
cd desktop && npm run ui:typecheck
npm run ui:preview
npx electron tools/capture_pages.js renderer-react/dist-preview/index.html .uipreview/check --theme dark --check --demo
```

- 截图台两套主题各拍一遍,17 个叶子页控制台零报错,CSP 违规同样算报错。
- 预览台的演示数据:`mock-bridge.js` / `mock-bridge-stress.js` 是 IBKR 模拟账户已连、富途配置好但 OpenD 没开;
  `DAFRI_MOCK=mock-bridge-empty.js` 是首次启动(三个占位账户、什么都没连);地址后加 `?consent=0` 看条款同意页。
- 截图台在隐藏窗口里的几个坑(过渡不推进、canvas 要第二帧、受控输入框要派发事件)记在 `desktop/tools/README.md`。
- 组件库或框架升级时用 `desktop/tools/ui_compare.js` 比对前后,见 [依赖选型](dependencies.md)「界面升级怎么验证」。
- README 的截图用 `capture_pages.js … .uipreview/shots --theme dark --demo` 重拍(要能开 Electron 的机器)。
