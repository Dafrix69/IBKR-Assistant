# 界面与体积优化报告

任务书:`docs/briefs/ui-size-optimization.md`。本文按其「交付物」一节的结构组织,随每个提交更新。

## 1. 基线(2026-09-05,提交 `883ca12` 之后,未改任何产品代码)

### 体积(`npm run dist:win`,electron-builder 26.15.3,Electron 40.10.6)

| 项 | 大小 | 说明 |
|---|---|---|
| `DafriTrading-0.2.0-win-x64.exe`(NSIS 安装器) | **119.6 MB** | 上一次构建(8 月 18 日,尚未打入 TS 引擎)是 90.2 MB |
| `dist/win-unpacked/` | **472 MB** | 上一次 331 MB |
| ├ Electron 本体(`win-unpacked` 去掉 `resources/`) | 330 MB | 固定开销,**不是优化对象**;含全部语言包 |
| ├ `resources/engine-ts/` | 140 MB | **全部是 `node_modules`**;`dist/` 与 `baseline/llm` 不到 1 MB |
| ├ `resources/engine/`(Python 引擎源码 + 提示词) | 2 MB | |
| ├ `resources/app.asar`(壳 + 界面) | 1 MB | |
| └ `elevate.exe` | 1 MB | electron-builder 自带 |

`engine-ts/node_modules` 前 15 项(MB):better-sqlite3 27 · **typescript 23** · protobufjs 19 · **@esbuild 12** ·
@anthropic-ai 12 · rxjs 9 · @stdlib 9 · **@rollup 5** · zod 4 · **vite 3 · rollup 3 · @types 3** · @stoqey 3 ·
**vitest 2** · futu-api 2。加粗的是 devDependencies,合计约 51 MB,一个字节都不该进包。

仓库磁盘占用(不算项目体积,列在这里只为对照):`trade/` 1.1 GB,其中 `desktop/node_modules` 428 MB、
`desktop/dist` 422→~600 MB(构建产物)、`.venv` 237 MB,源码 2 MB;`trade-ts/` 149 MB,其中 `node_modules` 142 MB。

### 验证闸门

| 闸门 | 结果 |
|---|---|
| Python `pytest -q` | 642 通过(README 写的 418 已过时) |
| TS `npm test`(含 golden 与 RPC 契约回放 76 步) | 395 通过 |
| TS `npm run typecheck` | 通过 |
| `python tools/audit_ui.py` | 未发现问题(0) |
| `build_preview.py` 两份预览 | 生成成功(324 KB / 263 KB) |
| 打包版干净环境启动 | **未做**:当前有开发态实例在运行,单实例锁会挡住打包版;留到阶段 1 每次打包后做 |

### 截图集(`.uipreview/baseline/`,不进仓库)

| 目录 | 内容 |
|---|---|
| `data/` | 有数据 mock × 16 页 × {深色 100%、深色 150%、浅色 100%},宽 1360 |
| `empty/` | 首启空态 mock × 16 页 × {深色、浅色},宽 1360 |
| `pa-widths/` | K线 PA 页,深色,宽 1080 / 1900 |
| `reference/` | 用户提供的两张问题截图(交易指令页 150% 缩放、K 线图)——**由用户放入**,本会话拿不到图片文件 |

工具:`tools/capture_pages.js`(本次新增,用法见 `tools/README.md`)。

**基线阶段发现的一个预览台缺口**:`mock-bridge.js` 的 `paAnalyze` 返回 `{}`,K线 PA 页在预览台里整页
`undefined`,K 线图根本画不出来——也就是说这张图从来没在预览台里被看过。已补一份由引擎 `analyze()`
对黄金基线 K 线算出的真实形状数据(见 §6)。

## 2. 视觉审计表

参照物:macOS 自带应用(Notes / Mail / Finder 的源列表,System Settings 的内嵌分组列表,Xcode 统一工具栏);
K 线参照富途/moomoo 的图表工程标准。"现状"来自基线截图与代码;行号以提交 `883ca12` 为准。

### 2.1 壳:侧栏 / 顶栏 / 行情带

| # | 对照点 | 现状 | 差在哪 | 改法 | 文件:行 |
|---|---|---|---|---|---|
| S1 | Finder/Notes 深色:侧栏与内容区是两级不同亮度的面 | 侧栏与内容区同为 `--bg-window`≈`--bg-content` 的深灰,只有一条 0.5px 竖线 | Windows 无 vibrancy,两块糊成一片;这是"左边丑"的第一来源 | 新增 `--bg-sidebar`,深色比内容区亮一档(≈#26262a vs #1e1e20),浅色反之(≈#ececef vs #f6f6f8);卡片再亮一档 | styles.css:28-35, 62-68, 221 |
| S2 | 源列表行:高 28、左右内缩 10、圆角 5、图标 16 | `.nav-item` padding 5×8、无内缩、圆角 6;行高约 26 | 项贴着侧栏边,显得松散 | `min-height:28px; margin:0 10px; padding:0 8px; border-radius:5px` | styles.css:240-252 |
| S3 | 选中项:强调色实底白字,窗口失焦退灰 | 强调色实底白字 ✓;无失焦态 | 小 | `:root[data-window-blur] .nav-item.active` 用 `--bg-fill-strong`(main.js 已有 focus/blur 事件可转发则做,没有则不做) | styles.css:254 |
| S4 | 组标题 11px semibold 三级色,组间距约 14 | 11px/590/tertiary ✓,margin 12 | 基本对 | 组间距 14,首组顶部 6 | styles.css:231-238 |
| S5 | 工具栏状态:一个圆点 + 常规文字,不用彩色填充胶囊 | 三颗彩色填充胶囊(绿「OpenD 已连接」、橙「自动执行(仅纸面)」、绿「盘中 09:42」) | 这是"Bootstrap 后台感"的最大来源;三种颜色抢焦点 | `.chip` 改为透明底 + 8px 圆点(`.dot.ok/.warn/.bad`)+ `--label` 文字;颜色只在圆点上 | styles.css:178-198 |
| S6 | 工具栏按钮:标准按钮,不用彩色文字 | 「暂停自动执行」红字 | 常态下红字像持续告警 | 常态标准按钮;**已熔断**时才切红(那是真告警) | styles.css(`.btn.danger`)/app.js 顶栏渲染 |
| S7 | 富途顶部指数条:名称 + 数值 + 涨跌色 | 一致 ✓;但全部无数据时显示一整行 `—` | 空态浪费一整行 | 全部 `—` 时整条 `hidden`,或显示骨架 | app.js 宏观行情渲染,styles.css:559 |
| S8 | 涨跌色 token | `#30D158/#FF453A` 硬编码:app.js 29 处 + 另 `#0A84FF` 10、`#BF5AF2` 8、`#FF9F0A` 7;styles.css 9 处;全是深色值 | 浅色模式下绿 #30D158 在白底上对比度不足(基线浅色截图行情带可见) | 建 `--up/--down`(随主题取 systemGreen/Red 的深浅两套),全部替换;顺带做"红涨绿跌"设置项 | app.js 多处,styles.css:584-585, 611-612, 625-626 |

### 2.2 内容区:卡片 / 表单 / 列表

| # | 对照点 | 现状 | 差在哪 | 改法 | 文件:行 |
|---|---|---|---|---|---|
| C1 | Apple 卡片无彩色左边条 | `.card::before` 3px 色条(ok/warn/bad/info 四色)、`.readiness` 橙条、`.flow-card` 三色条、订单看板卡片绿/蓝条 | 每页都有几根彩条,是"后台感"第二来源 | 去掉全部左边条;状态改为标题前 16px 圆形图标(√ / ! / ×,SF Symbols 几何) | styles.css:636-652, 546-555, 874-898 |
| C2 | System Settings 内嵌分组列表 | 设置页已是 ✓(可作全站样板);「还差 N 步」块是带橙条的卡片 | 不统一 | `.readiness` 改成与 `.group` 同款的内嵌分组列表,每行右侧「去配置」按钮不变 | styles.css:874-898, app.js:170 |
| C3 | 状态用文字色或圆点,不用填充胶囊 | 记录列表右侧「已成交/已挂单/券商报错/校验拒绝」是彩色填充胶囊;「买入/卖出」也是 | 一行两三颗彩色胶囊 | `.status` / `.side` 改为无底色、仅文字着色(买卖方向保留色,因为这是扫列表首看字段) | styles.css:694-700, 950-955 |
| C4 | 分段控件是一个整体控件 | 记录页筛选「全部 4 / 已成交 1 / …」和「舒适 / 紧凑」是一排独立胶囊按钮;设置页「跟随系统/浅色/深色」是正确的分段控件但撑满整行 | 同一站两种做法 | 统一用 `.segmented`;分段控件按内容宽,不撑满 | styles.css:448-460, 记录页/密度切换 |
| C5 | 焦点环一种 | 输入框 2px 实色蓝框;开关 3.5px 30% 蓝;其他 2px `--accent` | 三套 | `--focus-ring: 0 0 0 3.5px color-mix(in srgb, var(--blue) 30%, transparent)`,全部改用 | styles.css:355, 423, 817, 1096, 1104 |
| C6 | 禁用态 = 三级文字色 | 「发送到 IBKR/富途」禁用时橙字;启用时也是橙字 | 橙字读作"警告"而非"不可用/次要" | 启用:标准次要按钮(`--label`);禁用:`--label-tertiary`;实盘账户勾选时才给橙色 | styles.css 按钮变体,app.js 发送按钮渲染 |
| C7 | 空态:居中二级色文字,无虚线框 | 「还没有解析结果」「暂无通知」是虚线边框盒子 | 虚线框是 web 后台习惯 | 去边框,`--label-tertiary` 居中文字 | styles.css `.empty`/`.placeholder` |
| C8 | 说明文字 11px 二级色,不加粗 | 「期权速记与默认值」下三段带粗体的长段落 | 密度过高,像文档不像界面 | 收成折叠区内的要点列表(3–4 条),粗体去掉 | index.html `.shorthand` 段,styles.css:1090-1110 |
| C9 | 一页一个 h1,其余 13px semibold | ✓ 基本对;卡片标题 12.5px/590 | 微调 | 卡片标题 13px | styles.css:654 |
| C10 | 内联样式与 CSP | 6 处 `style="…"` 被 CSP 拦下,从未生效(启动日志 12 条报错) | 界面上有 6 处间距/宽度和作者想的不一样 | 挪进 styles.css(已另开任务卡) | index.html:427-429, 463, 520, 657 |

### 2.3 K 线图(`renderPaChart`,app.js:2783-2925)

| # | 对照点(富途) | 现状 | 改法 |
|---|---|---|---|
| K1 | 按像素画 | 固定 `viewBox 0 0 660 300` + `width:100%`,整张图随容器等比拉伸;1900px 宽时 9px 字号变 26px、芯线变粗、比例锁 11:5 | `ResizeObserver` 量容器,按像素坐标绘制,字号/线宽固定 |
| K2 | 右侧价格轴 + 底部时间轴 + 淡网格 | 没有坐标轴,只有两端两个时间戳;无网格 | 6–8 个 1/2/5 步进刻度;时间轴每 N 根一个 `HH:mm`,跨日加日期;网格 1px 6% |
| K3 | 现价虚线 + 轴上价格标签;标签碰撞避让 | 现价有虚线,标签是裸文字;关键位标签直接按 y 放,重叠成一团(用户截图:4 个标签叠在 229.5–229.7) | 标签放轴上带底色;按 y 排序推开或合并 |
| K4 | 区域退到背景 | FVG 饱和绿 12% 从产生点铺到右边缘,是图上最大色块 | 6–8% + 1px 20% 边线,右端止于最后一根 K 线,9px 小标签 |
| K5 | 量能子图独立刻度 | `maxVol = max(...)` 被首根巨量拉爆,其余压成 0.5px(用户截图只见一根柱) | 95 分位归一化(或对数),柱按涨跌着色 60% |
| K6 | 十字光标 + OHLC 读数 | 无 | 只读 `r.bars` 现有字段 |
| K7 | 摆动点标签 | 8.5(viewBox 单位)白色,拉伸后约 22px | 9px 固定,40% 透明,上下 4px |
| K8 | 图例 | 图下 120 字说明段落 | 左上角一行紧凑图例;长说明进「读盘常识」 |
| K9 | 涨跌色 token | 硬编码深色值 | `--up/--down`,并做"红涨绿跌"设置 |
| K10 | 均线 | 无;引擎不输出均线序列 | **待用户拍板** |

### 2.4 基线截图里没问题、要原样保留的

设置页的内嵌分组列表与开关(全站样板);侧栏图标(SF Symbols 几何、`currentColor`);h1 与页头右侧元信息;
行情带的名称/代码/数值/涨跌四段式;150% 缩放下与 100% 完全一致的比例(没有 DPI 专属问题——用户看到的"字大"
只是系统缩放,不是设计错误);Windows 上系统窗口按钮与工具栏右侧按钮的相对位置。

### 2.5 阶段 2 完成情况

| 审计项 | 结果 | 提交 |
|---|---|---|
| S1 亮度阶梯 | 深色实底 窗口 #2b2b2e / 内容 #1e1e20 / 卡片 #2f2f33 | `24af9ac` |
| S2 源列表度量 | 行高 28、内缩 10、圆角 5,侧栏 220 | `a4814d3` |
| S3 窗口失焦态 | **未做**:需 main.js 转发 focus/blur 事件,超出"只改皮相"范围,留待后续 | — |
| S4 组标题 | 间距 14,与项文字左对齐 | `a4814d3` |
| S5 顶栏状态胶囊 | 圆点 + 文字 | `a4814d3` |
| S6 熔断按钮 | 常态普通按钮,已熔断才红 | `a4814d3` |
| S7 行情带空态 | 全部无数据时 hidden | `a4814d3` |
| S8 涨跌色 token | `--up/--down` + THEME 取色器,54 + 9 处替换;「涨跌配色」设置 | `24af9ac` |
| C1 卡片色条 | 去掉;ok/warn/bad 标题前圆标 | `c5140f1` |
| C2 readiness | 去橙条,内嵌分组列表 | `c5140f1` |
| C3 状态/方向胶囊 | 只着色文字 | `c5140f1` |
| C4 分段控件 | filterbar / 密度切换统一;全站分段控件按内容宽 | `c5140f1`、2-5 |
| C5 焦点环 | `--focus-ring` / `--focus-outline` 一种;补上从未定义的 `--accent` | `9bd68b7` |
| C6 禁用/次要按钮 | 发送按钮常态普通,勾了实盘才橙 | `9bd68b7` |
| C7 空态虚线框 | 去掉 | `c5140f1` |
| C8 速记说明 | 4 条要点列表,去粗体 | `9bd68b7` |
| C9 卡片标题 | 13px | `c5140f1` |
| C10 内联样式 | 另一会话的任务卡处理中 | — |
| 逐页过一遍 | TWS / 富途 / 大模型 / 订单簿页的染色提示条改为中性面;分段控件按内容宽 | 2-5 |

每一步的截图在 `.uipreview/step2-1 … step2-5b`,与 `baseline/` 并排即为 before/after。

### 2.6 第三轮:一致性与可读性(2026-09-06)

阶段 2 之后再对着 Mail / Stocks / System Settings 并排看,剩下的差距全在用法一致性上。全部只动 renderer 三个文件,
DOM id 不变(`audit_ui.py` 0 问题),`capture_pages --check` 16 页零报错;交互态(紧凑列表、记录详情、想法「全部」、
追踪卡片)另用一次性脚本拍过。截图在 `.uipreview/round3/`(`dark/`、`light/`、`light-empty/`、`states/`)。

| # | 对照点 | 现状 | 改法 |
|---|---|---|---|
| T1 | Mail / Stocks:列表元数据是二级色文字 | `.card-meta span` 每项一颗灰胶囊,一页几十颗 | 去底色,11.5px 二级色,项间 14px;`.status` 同样只着色文字 |
| T2 | 文字着色要过对比度 | systemGreen #28cd41 当 11px 文字放白底 ≈2.3:1,浅色"已成交"看不清 | 新增 `--green/red/orange-text`(Apple 可访问变体)与 `--up/down-text`;`.status/.side/.macro-chg/.pnl-*/.acct-*/.card ul/.notice.warn strong/.btn.warn/.banner` 等 20 处文字改走它 |
| T3 | 盈亏跟随「涨跌配色」 | `.pnl-up/.pnl-down` 钉死绿红,与设置页说明不符 | 走 `--up-text/--down-text`,红涨绿跌时自动翻转 |
| T4 | 颜色只给要一眼看见的 | 纸面账户标签绿色等宽字 | 纸面二级色;实盘 / 券商托管 / 自动平仓已开才橙 |
| T5 | 文案不露配置键名 | 「`auto_execute` 已开 … `allow_live_trading`」两处;看板 `BUY 2 NVDA`、`SPY >= 775`;详情标题 `NVDA · BUY 2` | 全部翻成用户语言;比较符走 `TRIGGER_OP_LABEL`(≥ / ≤) |
| T6 | 说明文字行长 | `.hint` 跑满 1100px | `max-width: 760px`;`.group > .hint` 补内边距(回测策略描述原来贴左边框) |
| T7 | 同一件事一种控件 | 想法页筛选是两个普通按钮;速记片段是 999px 胶囊;列表行悬停描蓝边 | 分段控件(`.segmented.compact`);6px 填充 token;悬停只提亮底 |
| T8 | 从未生效的样式 | 追踪量表条引用 `--line/--ok/--warn/--bad`(未定义,条透明);速记区 `--text-*`(未定义);`.account-picker` 的 `display:flex` 盖掉 `[hidden]` | 换成存在的 token;补 `[hidden]{display:none}` |
| T9 | 页头控件等高 | `.btn.tiny` 比旁边的分段控件矮 | `.page-head .btn.tiny` 3px 内边距 / 12px 字 |
| T10 | 卡片呼吸 | `.card` 10×12 内边距,和 `.readiness` 的 12×14 不一致 | 统一 12×14;标题后跟的状态词留 8px |

| T11 | 第一眼只看操作项 | 每页开头 2–6 行 11px 说明把输入框往下挤 | 6 页的说明收成 `details.primer.intro`(一行三级色 + 折叠箭头,按页记住);交易指令页速记片段常驻、规则与发送条件默认折叠 |
| T12 | 侧栏分级 | 16 项等权 | 「应用」组 `margin-top:auto` 沉底 |
| T14 | 侧栏功能分级 | 16 项 4 组平铺;持仓追踪在"研究";接入三页常驻 | 12 项 3 组(工作区 / 研究 / 应用);「行情」= K线 PA + 订单簿 + 期权墙,「接入」= TWS + 富途 + 大模型,页内分段切子页并记住;组可折叠;`activateTab` 统一切页,`.tab[data-tab]` 跳转兼容;`capture_pages` 改拍叶子页 |
| T15 | 图区底色 | 深色下蜡烛浮在卡片灰(#2f2f33)上 | `--chart-bg` 近黑 #0b0b0d(iOS 股市 / 富途夜间),画布自己铺底,8px 圆角嵌在卡片里 |
| T16 | 持仓追踪表单 | 十个字段摊在每张卡片里 | 默认收起,「设置追踪」展开,一次一张,展开的记在 `tracker.openKey` 刷新不收 |
| T17 | K线 PA 结论 | 九行散文 | `renderReadout`:按首个冒号拆成 dt/dd 两列(`.detail-grid`),首句与拆不开的行原样 |
| T18 | 价位提醒并入板块 | 独立页,和板块里的股是两份清单 | `tab-alerts` 变成板块页的 `page-section`;`activateTab` 对页内节:切到所在页再滚过去;徽标挪到「板块」 |
| T19 | 成分股行价位条 | 墙 / 均线只在提醒页的列表里 | `levelStrip`:横线上摆墙、MA20/60/120/200、52 周位、关口、现价;进文档后量标签宽度分层(≤3 层),条高按层数;行右侧「盯」建提醒并算墙 |
| T20 | 引擎 MA20 | 默认均线 60/120/200 | 两侧 `DEFAULT_MA_PERIODS` = 20/60/120/200,黄金基线重生成;pytest 642 / vitest 395 |
| T21 | 键盘与窗口 | 无数字键切页;minWidth 1080;失焦无变化 | Ctrl/⌘+1…9;窄于 1000px 侧栏 56px 图标栏(minWidth 900);main.js 转发 focus/blur → `data-window-blur` 退灰 |
| T22 | 零碎 | 交易分析与回测同图标;`配置:live`;均线 85% | `sf-review` 放大镜图标;"配置为实盘 / 模拟";均线 70% |
| T13 | 截图可复现 | Electron 把 file:// 的 localStorage 持久化在 %AppData%/Electron,上次的折叠态带进下次截图 | `capture_pages.js` 每次 `setPath('userData', mkdtemp)` |

**打包复核(2026-09-06,含本轮全部界面改动)**:`npm run dist:win` 通过(stage:engine → smoke:engine 184 ms 应答 → electron-builder),
安装器 91.0 MB、`win-unpacked` 310 MB(上次终态 86.8 / 301.3,增量来自本机 electron-builder 与依赖锁的漂移,
`app.asar` 本身只多了 pa-chart.js 的十几 KB)。打包版能启动并出窗口;开发态 `DAFRI_DEV=1` 跑 60 秒,渲染进程无 error 级消息。
逐页手点的真机验证需要接管屏幕,本会话未获授权,由用户自行点一遍。

**没做的**:`mock-bridge-empty.js` 的 `paAnalyze` 按设计抛错,所以 `--check` 对空态预览会报"K 线 PA 页没有画出 canvas"——
`git stash` 复核这一条在本轮之前就是这样,`--check` 只适用于有数据的预览;K 线本身、侧栏、顶栏、设置页本轮未动。

## 3. 体积变更逐项表

| # | 改了什么 | 省了多少 | 怎么验证 | 提交 |
|---|---|---|---|---|
| V1 | `extraResources` 不再直接指向 `trade-ts/node_modules`,改为 `tools/stage_engine_ts.js` 按 package-lock 的生产依赖闭包暂存到 `build/engine-ts/`:去掉 103 个 devDependencies 包,better-sqlite3 只留当前平台一个 `.node`(原来 8 个平台 + sqlite 源码),去掉 protobufjs 的命令行工具、@anthropic-ai/sdk 的 TS 源码,以及所有 `.map/.d.ts/.md/.ts` | `engine-ts` 140 MB → **14.9 MB** | `npm run smoke:engine`:用 Electron 自带 Node(`ELECTRON_RUN_AS_NODE`)、PATH 只留 System32,拉起暂存引擎发 `system.status`,184 ms 应答;`dist:*` 脚本把它作为打包前置 | 阶段 1-1 |
| V2 | 只带 TS 引擎(用户拍板):`resources/engine/src`(Python 源码)不进包;提示词与示例配置仍在 `engine/` 下,`main.js` 路径推导不变 | 2 MB | 同上;`DAFRI_ENGINE=python` 在打包版会明确失败而不是静默 | 阶段 1-1 |
| V3 | `electronLanguages: [zh-CN, zh-TW, en-US]`:Electron 自带 55 个语言包 | `locales` 46 MB → 3 个文件 | 打包版启动界面正常(界面文案本来就不走 Chromium 语言包) | 阶段 1-1 |
| — | 删除 `trade-ts/nul/`(5 个游离的编译产物,无任何引用) | 仓库 128 KB | — | 阶段 1-1 |

**结果**(同一台机器、同一 electron-builder 26.15.3 / Electron 40.10.6):

| | 基线 | 阶段 1-1 | 变化 |
|---|---|---|---|
| 安装器 exe | 119.6 MB | **86.8 MB** | −27% |
| `win-unpacked` | 472 MB | **301 MB** | −36% |
| 其中 `resources/` | 142 MB | 14.9 MB | −90% |

exe 没到 −30%:剩下的 86.8 MB 里约 80 MB 是 Electron 本体压缩后的体积,是地板。`compression: maximum` 试过,
NSIS 产物一个字节没变(86.8 MB),已撤回。**终态**(阶段 3 之后再打一次包,含 pa-chart.js):exe 86.8 MB,
`win-unpacked` 301.3 MB,`app.asar` 里确认含 `pa-chart.js`。

**打包版干净环境启动**:PATH 只留 `C:\Windows\System32`(机器上的 node / python 都不可见)启动
`dist/win-unpacked/Dafri Trading.exe`,窗口正常,引擎子进程(`Dafri Trading.exe … cli.js rpc`,即 Electron-as-Node)
20 秒后仍在运行。

## 4. K 线图

用户拍板:引擎加 `ma` 字段;保持绿涨红跌为默认并做成设置;canvas 重写。提交:`423edb5`(引擎 ma,两侧同步,
黄金基线与 RPC 样例重生成)、`5d9380d`(canvas 图)。

| # | 对照点 | 改后 | 截图 |
|---|---|---|---|
| K1 | 按像素画 | ResizeObserver + dpr,字号 11 / 线宽 1 固定;1080 / 1360 / 1900 三宽度文字大小一致 | `step3/dark-1x-{1080,1360,1900}-pa.png`、`dark-1.5x-1360-pa.png` |
| K2 | 坐标轴 + 网格 | 右轴 1/2/2.5/5 步进,底轴按像素间距抽样、跨日带日期,网格 7% | 同上 |
| K3 | 标签避让 | 关键位/现价标签在轴上,重叠推开 + 引线;现价固定 | `step3/stress/dark-1x-1360-pa.png`(6 个价位挤在 0.6% 内,全部可读) |
| K4 | 区域降噪 | 7% 填充 + 22% 边线,右端止于最后一根 K 线,9px 小标签 | stress 图:FVG 与 OB 重叠仍分得开 |
| K5 | 量能归一化 | 95 分位满格,首根 ×40 巨量只是顶格,其余柱子正常 | stress 图(基线里同样数据只见一根柱) |
| K6 | 十字光标 | 竖/横线 + 轴上价格/时间标签 + 开高低收量涨跌读数 | 交互态,截图工具拍不到,已在 Electron 里手动看过 |
| K7 | 摆动点 | 9px、45% 透明,上下 9px,只标最近 8 个 | 同 K1 截图 |
| K8 | 图例 | 左上一行色块 + 词;长说明进「图上画的是什么」折叠区 | 同 K1 截图 |
| K9 | 涨跌色 token | 全部从 CSS token 读;「涨跌配色」切换即重画(MutationObserver) | `step3/light-1x-1360-pa.png`(浅色系统色) |
| K10 | 均线 | 引擎 `ma` MA5/10/20,左上角读数随光标 | 同 K1 截图 |

### 4.1 第二轮:一套坐标系画全部的图(2026-09-06)

`pa-chart.js` 改成通用引擎(spec 描述:`times / bars / lines / hlines / bands / vlines / markers / last / legend / header / readout`),
K线 PA、交易分析的两张图、回测净值曲线全部走它;`window.DafriPaChart.mount` 保留为适配器,app.js 的 PA 代码未动。
截图在 `.uipreview/round5/`(`charts/` 深浅色、`wide/` 1900px、`stress/`)。

| # | 对照点 | 改后 |
|---|---|---|
| K11 | 蜡烛配色与几何 | `--chart-up/--chart-down`(#26a69a / #ef5350,随「涨跌配色」翻转);实体奇数宽、根间留空、影线 1px 居中;量能柱 50% 同色;主图高度 440 |
| K12 | 交易分析·标的走势 | 蜡烛 + 三条行权价(轴上标签)+ 盈利区底色 + 临界线(名字在线左端,不占轴)+ 开仓/到期竖线(顶部标签,靠右的写在线左边) |
| K13 | 交易分析·蝶价走势 | 稀疏蜡烛对齐到并集时间轴;模型价虚线、回撤触发价阶梯;止盈/止损档位价格进轴上标签、名字在左端;事件标签矩形避让(原来"策略 1 张 @ 3.3"压在"实际平仓 3.45"上) |
| K14 | 回测净值曲线 | 策略 / 买入持有两条线、1.0 基线、进出场三角标记;轴、网格、十字光标读数(日期 + 两条线的值);首尾时间标签不出画布 |
| K15 | 回测 mock | `runBacktest` 返回黄金基线 `sma_cross` 一例;预览台里回测结果第一次能看见 |
| K16 | 期权墙梯子 | `renderLadder`:竖轴 + 按价格定位的行,支撑/阻力/中性/现价四种,同价的行推开;mock 加了 8 个价位(含两个同价)的 NVDA |

**没做的**:蝶价图里 IBKR 分钟线的影线本身就很长(组合中间价的 bid/ask 噪声),这是数据不是画法;
均线颜色仍用系统橙/蓝/紫(85% 透明),要不要换成更淡的一组由你看图定。

设计说明(第一轮):价格区高度由布局给(380px,窄窗 320),量能子图 54px,右轴 64px;价格范围取 bars 的高低与均线并留 5% 边距;
关键位标签的最小间距 = 标签高 16px,最多 6 轮推挤后夹回绘图区。极端样例里"只有 3 根 bar"和"指数无成交量"由代码路径兜底
(不足 2 根写一句提示;成交量全 0 不画量能子图),引擎本身对 <30 根直接拒绝,真实链路不会出现。

## 5. 没做的与建议

- **`./~/Library/…/trades.db` 与 `trade-ts/~/Library/…/breaker.json` 没有删。** 任务书把它们列为"疑为副作用"。复核:
  成因是 TS 引擎早期不展开 `~`(`config.ts` 的 `expandHome` 注释记着 2026-09-04 已修),这两处是修复前留下的**数据**,
  不是空目录——根目录那份库里有 11 条交易记录、12 条成交、44 条事件、1 条持仓追踪。是不是要并回正式库、还是确认无用后删,
  由你定;按 §9 的数据规矩我不动 S1 数据。
- 打包版干净环境启动已做(见 §3);「解析并校验」一条指令的端到端走通需要在打包版界面里手点,未自动化。
- **renderer 最小 smoke 已补**(任务书决策 5):`npx electron tools/capture_pages.js … --check` 把 16 页各点一遍,
  收集渲染进程 error 级控制台消息(排除已知的 6 条内联样式 CSP 提示),并要求 K线 PA 页画出 canvas;
  结论写到 `<outDir>/check.txt`,退出码 0/1。当前:PASS。
- 十字光标(K6)的验证方式:隐藏窗口的截图拿不到悬停帧,改为在页面里派发 mousemove 后探像素——右轴价格标签
  与底部时间标签处为实底、远处透明,证明画出来了。
- 窗口失焦时侧栏选中项退灰(S3)未做:要 main.js 转发 focus/blur,超出"只改皮相"。
- `.uipreview/reference/`:用户的两张问题截图需由用户放入。

## 6. FINDINGS(按约束不许顺手改的疑似问题)

- **预览台 PA 数据缺失**:`tools/mock-bridge.js` `paAnalyze: async()=>({})`,`mock-bridge-empty.js` 同。真实 RPC
  未连券商时抛 `-32015`,不会返回空对象;返回空对象让 `renderPa` 渲染出一整页 `undefined`。属预览台工具问题,
  本次已修(见 §1)。顺带暴露 `renderPa` 对残缺负载没有像设置页那样"缺什么空哪格"——真实链路里不会发生,记录不改。
- **`scripts/verify_baseline.py` 在本次任何改动之前就不通过**(`git stash` 复核):`tracker.short_stock.steps[0]` 的
  `profit_peak / profit_trail_stop / profit_drawdown_threshold` 三个字段"基线中不存在,现值 None"。是追踪器加了
  利润回撤字段后没重跑 `make_baseline.py`,属基线过期,不是回归。按约束未顺手重生成——那是引擎侧的验收基线,应由改追踪器的人确认后再刷。
- **`README.md`「测试」一节写的 418 项**已过时(现 642),「界面」一节写的"七个页面"也已是 16 个;本次只补了新决策,没有整体重写。
- **trade-ts/ 不在版本控制里**(根目录与 trade-ts 都没有 .git):本次对 `trade-ts/src/priceaction.ts`、`broker.ts`、`ibSession.ts`、
  测试与黄金基线的改动只存在于磁盘上。建议把 trade-ts 纳入 trade 仓库或单独建库。
  2026-09-08 已处理:仓库根提到 `dafritrade/`,`trade-ts` 改名 `engine-ts` 一并纳入,见根 README「仓库布局」。
- **大模型解析质量(2026-09-07 压测,DeepSeek V3 兼容端点,提示词 v1.7.0,29 条大模型路径)**:
  (1) 提示词第 6 条让模型自己按限额估算并拒绝(EXCEEDS_LIMIT),模型算错就把合规的单拒了——`买2张英伟达周五180call 限价5.5`
  被拒,理由里自己写着"实际未超限,可执行";`铁鹰:SPX 今天 7300/7350/7700/7750,收 2 块` 被拒,理由里写"超过 5000?不,4800 < 5000";
  `买 1 张 SPY 本周五 560 put`、`spx到7500时…call spread` 同样自相矛盾。4/29,而限额本来就有硬校验层逐条复核。
  (2) `spx到7500时,买一张 7520 7550 7580 蝴蝶` 被拒,理由说"三个行权价均高于现价 7718"——数字比较错了。
  (3) `买 1 张 SPY 本周五 560 put` 另一处理由说"SPY 期权到期通常为每月第三个周五"——SPY 有日度到期,模型常识错。
  这些是提示词 / 模型的问题,不是引擎。用户定了原则"能本地校验的都不交给模型":(1)(3) 在提示词 v1.8.0 处理(§7.4);(2) 是模型算术错,v1.8.0 只加了"在 warning 里先并排写出两个数再给结论"的自查句,没加少样本(每组约 1k token,时延换不来确定性)。

## 7. 解析链路时延(2026-09-07)

工具:`tools/latency_bench.js`(用法见 `tools/README.md`)。38 条自拟指令,固定交易日时钟(美东 2026-08-14 10:32),
只解析不下单,数据库指临时目录。结果文件 `.uipreview/latency/ts-fixed.json`(TS 引擎)、`py-fixed.json`(Python 引擎,真实时钟)。

### 7.1 量到了什么

| 项 | 数字 | 说明 |
|---|---|---|
| 本地速记 | 8/8 命中,中位 1.6 ms,最大 3 ms | 第一次要取 SPX 公开现价:冷取 790 ms(一次 2.8 s) |
| 大模型路径(改前) | p50 3.06 s,p90 3.90 s,最大 4.68 s | 29 条全部走 DeepSeek |
| 端点最小请求(`llm.test`) | 2.1–2.7 s | 提示词只有一句话,说明端点本身就是 2 秒级 |
| 提示词 | 12.5k token,前缀缓存命中 12.4k(99%) | 相对最小请求只多 0.6–0.9 s |
| 输出 | 中位 129 token,最大 423;≈3.5 ms/token | 与时延相关系数 0.82 |
| 网络 | TCP 1 ms,TLS 75 ms,TTFB 150 ms;复用连接 80 ms | 不是瓶颈;空闲 15 / 40 秒后再打无差别 |
| 引擎自身开销 | TS 2.4 ms,Python 4.8 ms(墙钟 − 模型自报) | 校验、落库、事件全部在内 |
| 引擎启动到首个应答 | TS 22 ms(进程内)/ 231 ms(stdio);Python 366 ms | |

第一次压测在周日跑:八条行话七条落到大模型(4–5 s)且全被拒。查下来不是语法,是"默认当日到期"在周末不存在——
语法遇到周末直接放弃交给大模型,而大模型看不懂这套行话。这就是 7.2 的第一条。

### 7.2 改了什么

| # | 改动 | 效果 | 两侧 |
|---|---|---|---|
| L1 | 速记在周末本地直接拒(UNSUPPORTED,提示写「明天」),不回落大模型 | 周末的行话 4–5 s → 2 ms,拒绝理由更明确 | shorthand.py / shorthand.ts,黄金 weekend 样例重生成 |
| L2 | 速记语法 v3:尾巴上的「理由:…」摘进 `reason`,前面照旧本地解析;空理由回落 | `…15CM 理由:开盘冲高回落` 3.4 s 被拒 → 2 ms 命中;界面「补理由」按钮不再把用户推进大模型 | 同上,黄金新增 3 例 |
| L3 | 兼容端点:`json_schema` 被拒(400)一次后记住,后面直接 `json_object` | 每条指令少一个往返:同一指令 2.8–3.0 s → 1.8–1.9 s | providers.py / providers.ts |
| L4 | 引擎启动预热 SPX 公开现价,每 4 分钟后台刷 | 速记第一次不再冷取 0.7 s+ | rpc.py / rpc.ts serve() |
| L5 | `usage` 记 `cache_hit_tokens / cache_miss_tokens` | 界面与压测能看出缓存有没有中 | providers 两侧 |

验证:pytest 645 通过(含新增 4 条速记测试),vitest 395 通过,黄金基线重生成;改后压测 A/B/H 三类:本地 9 条中位 1.6 ms,
大模型路径 1.8–1.9 s(同一指令改前 2.8–3.0 s)。

### 7.3 没做的

- **端点本身的 2 秒**是天花板:换更快的模型 / 端点才能再降(Anthropic Haiku 4.5 的 `json_schema` 模式值得试,本机只配了 DeepSeek 的密钥,没法量)。
- **提示词 12.5k token** 只贡献 0.6–0.9 s,少样本 9 组减半大约省 0.3 s,不值得为此动提示词。
- **输出长度**:拒绝理由里带两个改写示例,中位 129 token ≈ 0.45 s;要缩得改提示词。
- 提示词第 6 条(模型自己算限额并拒绝):已按用户决定在 v1.8.0 拿掉,见 §7.4。

### 7.4 限额只在本地校验(提示词 v1.8.0,2026-09-07)

用户定的原则:能本地校验的判断都不交给模型,验证也尽量走本地。

| 项 | 改动 |
|---|---|
| 提示词 | 新建 v1.8.0(v1.0.0–v1.7.0 原样保留,回滚只改 `prompt_version`):第 6 条改为"限额不归你判断,由校验层复算";三个限额占位符移出系统提示词;用户消息去掉"本次生效限额"行;rejections 代码表去掉 EXCEEDS_LIMIT;合约是否存在由软件向券商核实、不凭常识拒;蝴蝶推断看涨看跌前先把现价与中心并排写出,高低关系不是拒绝理由 |
| 少样本 | 仍是 9 组;user 文本去掉限额行;删掉模型自己算"最大亏损 = … USD"的三句 warning 与"注意单笔仍受限额约束"一句 |
| 校验层 | 不改。黄金样例 `validator.tight_*` / `notional_only_*` 十二条(5000 USD / 5 张):模型误拒的四条放行——2 张 NVDA 180C @5.5 = 1100、1 张 SPY 560P @3 = 300、铁鹰 7300/7350/7700/7750 收 2 = 4800、AUTO_MID 7520/7550 价差 = 3000;被拦的——100 股 AAPL @230 = 23000、市价单按快照 229.4 算 22940 / 68820(200 股上限只在无参考价时生效)、无参考价的 1000 股市价单、贷方铁鹰 2 × (50 − 12) × 100 = 7600、6 张超 5 张(敞口 300 不超);只收紧金额上限时 6 张放行(张数上限回落到配置的 10,不是引擎默认的 5)。`tests/test_local_limits.py` 同一组用例 |
| 发给模型的 schema | 随提示词版本走(`schema.parse_schema_for_prompt` / `providers.parseSchemaForPrompt`):v1.8.0 起 rejection 代码 enum 不列 EXCEEDS_LIMIT——json_object 降级时 schema 整段进系统提示词,不能自相矛盾;pydantic / zod 模型保留该码,回滚与模型不听话时仍能解析(原样透传,测试钉住)。黄金 prompts.json 每个版本记 `rejection_codes_sent`,TS 对拍 |
| 审阅后补的 | 开头改成"经软件校验层后自动发送"(原来的"直接发送、无人把关"正是模型宁可误拒的心理来源);第 6 条划清"用户明确写的周六/周日仍拒,假日与挂牌由软件核实";第 9 条 confidence 不因数量、超限、挂牌打折;蝴蝶推断改成"在 warning 里并排写两个数"(原句没有落点);少样本第 7 组周六那条的拒绝理由不再拿"没写方向/标的"当依据 |
| 指纹 | 只随模型看到的东西变:改限额不换指纹,改别名表才换(v1.7.0 仍随限额变,测试两头都盯) |
| 版本 | `settings.example.json` / 测试基准 / 黄金 / RPC 契约样本 / store 夹具 / 预览桥全部升到 v1.8.0;本机 `config/settings.json` 只改了 `prompt_version` 一行 |
| 压测工具 | `latency_bench.js --match 片段,片段`:改完提示词只抽查几条,少打付费端点 |

本地验证:pytest 661(+16)、vitest 409(+14:12 条紧限额对拍、v1.8.0 提示词指纹、代码表随版本、指纹不随限额变),黄金 / store 夹具 / RPC 契约样本重生成。
审阅走的是多视角工作流(提示词一致性 / 版本完整性 / 双引擎对拍 / 安全与工具),两个视角跑完、12 条发现全部人工复核后采纳了 11 条,余下 1 条(开头措辞)按建议改写;另两个视角因会话额度中断,版本残留与安全边界改由 grep 与 git status 手工过了一遍。
付费端点只打了压测里误拒的那几条:5 条(误拒的 4 条 + 同文案的 1 条)模型全部交出订单,没有一条 EXCEEDS_LIMIT;4 条直接通过校验层,带触发条件的那条被校验层以 AMBIGUOUS_TRIGGER 拦下——压测台没连券商、拿不到 SPX 现价快照,是离线环境的限制,不是解析问题。时延 2.9–3.6 s;第一条 5.4 s 是提示词换版本后前缀缓存全未命中(12.3k token)再加撞一次 json_schema 400,之后 12288 token 缓存命中。
