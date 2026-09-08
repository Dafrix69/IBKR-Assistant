# 任务:把 dafritrade 桌面端的界面做成"苹果自带应用"的样子、K 线做成"富途"的样子,同时压缩分发体积——功能零回归

## 背景

本仓库是一个跑真钱的自然语言交易指令引擎:**Electron 桌面端 + 引擎 sidecar**(TS 引擎优先,
`DAFRI_ENGINE=python` 回退 Python 引擎),两者走 stdio 上的 JSON-RPC 2.0。

| 目录 | 是什么 | 体积构成(实测) |
|---|---|---|
| `trade/` | Python 引擎(`src/ibkr_agent`)+ Electron 壳(`desktop/`)+ 全项目设计决策记录 `README.md` | 1.1 GB,其中 `desktop/node_modules` 428M、`desktop/dist` 422M(上次构建产物)、`.venv` 237M;**源码只有 2M** |
| `trade-ts/` | 引擎的 TypeScript 重写,行为规格 = Python 版 | 149M,其中 `node_modules` 142M |
| `trade/desktop/renderer/` | 界面本体,**无框架、无打包器、三个裸文件** | `app.js` 4906 行、`index.html` 823 行、`styles.css` 1164 行 |

先通读 `trade/README.md` 的「界面」「打包分发」「桌面端架构与安全边界」「测试」四节,以及
`trade/desktop/tools/README.md`(界面预览台的用法——**没有它 Electron 窗口截不了图,UI 只能盲改**)。

`styles.css` 开头写着"参照 Apple HIG",token 体系(系统语义色、13/11px 字号、0.5px 发丝线、10px 圆角)
也确实是按 HIG 建的。**问题不在 token,在用法**:实际渲染出来是一个"深色 Bootstrap 后台",
K 线图则是一张按 660×300 画好再被拉伸到整页宽的 SVG。这次任务就是把"骨架对、皮相错"的部分改对。

---

## 视觉目标(两个参照物,不许混)

### 界面壳(侧栏 / 顶栏 / 表单 / 卡片):参照 **macOS 自带应用**

对标对象:**Notes、Mail、Finder 的源列表侧栏;System Settings 的内嵌分组列表;Xcode/Pages 的统一工具栏。**
判断标准很简单:把改完的截图和这几个应用并排放,一个不熟这个项目的人应当分不出哪个是 Apple 做的。

Apple 自带应用的深色模式有几个反直觉的事实,照做,不要"我觉得":

- **颜色几乎只出现在一个地方**:强调色(accent)用在选中项和唯一的主按钮上,其余全是灰阶层次。
  状态用**一个 8px 圆点 + 常规文字**表达,不用彩色填充的胶囊。红/绿/橙只出现在真正的正负/告警数值上。
- **层次靠背景亮度阶梯,不靠边框**:窗口底 → 侧栏 → 内容区 → 卡片,每层比上一层亮一点
  (深色:约 `#1e1e20` / `#28282a` / `#1e1e20` 内容 / `#2c2c2e` 卡片这个量级)。Windows 上没有 vibrancy,
  更要靠这个阶梯,否则侧栏和内容糊成一片——**现在就是这样**。
- **卡片没有彩色左边条。** `.card::before` 那条 3px 色条(`styles.css:645-652`)、`.readiness` 的
  `border-left: 3px solid var(--orange)`(`:879`)、`.flow-card` 的色条(`:546-555`)全部去掉。
  状态用标题旁的 SF Symbol 风格圆形图标(√ / ! / ×)表示,和 System Settings 一致。
- **源列表(侧栏)的度量**:行高 28px、左右各 10px 内缩、圆角 5px、图标 16px 描边 1.4、文字 13px;
  组标题 11px semibold 三级文字色、组间距 14px;选中项 = 强调色实底 + 白字(窗口失焦时退成 `--bg-fill-strong`)。
  现在 `.nav-item`(`:240`)的 padding 5×8、gap 8、无左右内缩,视觉上"贴边、松散、高"。
- **焦点环只有一种**:3.5px、强调色 30% 透明度(`.switch` 已经这么做了,`:423`);主输入框现在是
  2px 实色蓝框(`:355`),两套并存。统一到一个 `--focus-ring` token。
- **禁用态是三级文字色,不是别的颜色。** 「发送到 IBKR」禁用时现在显示橙字,看起来像"警告"而不是"不可用"。
- **文案层级**:一页只有一个 h1(20px/700 已对),其余标题 13px/semibold,说明 11px 二级色。
  「期权速记与默认值」下面那段带粗体的长段落(`.shorthand`)收成折叠的要点列表,二级文字色。

### K 线图:参照 **富途牛牛 / moomoo 的分时·K 线面板**

这里"参照"指的是**图表工程标准**,不是抄它的皮肤。富途 K 线看着专业,靠的是这几件事,每件都要有:

1. **按真实像素画,不按 viewBox 拉伸。** 现在 `renderPaChart`(`app.js:2783`)固定 `viewBox 0 0 660 300` +
   CSS `width:100%; height:auto`,容器 1700px 宽时字号 9 → 23px、蜡烛芯线跟着变粗、比例锁死 11:5。
   改成:`ResizeObserver` 量容器 → 按像素坐标绘制(SVG 或 `<canvas>` + devicePixelRatio 都可,选一种写清理由)
   → 字号固定 11px、线宽固定 1px、高度由布局给(价格区 + 量能区 + 时间轴)。
2. **右侧价格轴 + 底部时间轴 + 极淡网格。** 价格轴 6–8 个"好看的"刻度(1/2/5 步进),时间轴每 N 根一个
   `HH:mm`、跨日处加日期;网格线 1px、5–8% 透明度。现在的图**没有坐标轴**,只有两端两个时间戳。
3. **现价一条虚线 + 轴上一个价格标签(带底色的小矩形)**,富途那种。关键位的价格标签同样放在轴上,
   并且**做碰撞避让**(按 y 排序,重叠的向上/向下推开或合并为一个标签)——现在 229.6867 / 229.62 /
   229.57 / 229.52 四个标签叠成一团,这是截图里最刺眼的一处。
4. **区域(FVG / 订单块)要退到背景里。** 现在 `fill-opacity 0.12` 的饱和绿从产生点一直铺到右边缘,
   成了图上最大的色块。改成 6–8% 透明度、1px 边线 20% 透明度、右端在**最后一根 K 线**处结束而不是画到轴上,
   左上角一个 9px 小标签(`FVG↑`)。关键位从 `4 3` 虚线 55% 改成 `2 2` 虚线 40%,颜色用去饱和的
   支撑/阻力色(不是蜡烛的红绿——线和蜡烛撞色,读图时分不出哪个是哪个)。
5. **量能子图有自己的高度和刻度**,柱子按蜡烛涨跌着色、不透明度 60%。现在的量能区只见第一根柱子:
   `maxVol = Math.max(...)` 被开盘第一根巨量拉爆,其余全部压成 0.5px。用 95 分位或对数轴归一化,
   并在报告里给出那根 bar 的实际数值证明这是缩放问题而不是数据问题。
6. **十字光标 + 读数条**:鼠标悬停显示竖线、横线、时间/价格标签,图上方一行显示该根 K 线的
   `开 高 低 收 量 涨跌%`。这一项只读现有 `r.bars` 的字段,不新算任何东西,符合
   `app.js:2784` 的注释约束("图上出现的每一条线都对应引擎算出的一个字段")。
7. **摆动点标签(HH/HL/LL)**收成 9px、40% 透明度,放在 K 线上下 4px,不用白色。
8. **图例**:去掉图下那行 120 字的说明段落(`app.js:2919`),换成图左上角一行紧凑图例(色块 + 词),
   完整解释进「读盘常识」折叠区。
9. **涨跌色成对做成 token**(`--up` / `--down`),现在 `#30D158` / `#FF453A` 在 `app.js` 里硬编码了 29 处、
   `styles.css` 里 9 处,而且用的是深色模式的值,浅色模式下是错的。做成一对 token 之后,
   "红涨绿跌 / 绿涨红跌"就是一个设置项——富途有这个开关,做交易的人对这件事很敏感。默认保持现在的绿涨。

**关于均线(MA5/10/20)**:富途默认叠均线,这张图没有,而 `priceaction.py` 的输出里也没有均线序列
(只有一个 `ema` 权重项)。按 `app.js:2784` 的约束,界面不许自己算。这是一个**需要用户拍板**的项:
要么在引擎侧加一个 `ma: {5:[],10:[],20:[]}` 输出字段(Python 与 TS **两侧同步加**,重新生成契约样例与黄金基线),
要么这版不画均线。先问,不要自己定。

---

## 最高优先级约束(动手前先读完)

### 绝对禁止

- **禁止运行任何可能下真单的代码。** 验证一律 `auto_execute=false`,不连实盘。不确定的不要跑。
- **禁止修改引擎语义**:`trade/src/ibkr_agent/`、`trade-ts/src/`、`trade/prompts/` 的行为一行不动。
  唯一允许的引擎改动是**纯新增的输出字段**(如上面的均线),且必须 Python/TS 同步、跑
  `scripts/gen_golden.py` → `scripts/verify_baseline.py`、`trade-ts` 跑 `npm run golden`,并重新生成 RPC 契约样例。
- **禁止松动任何一条 Electron 硬化**:contextIsolation / sandbox / IPC 白名单 / 发起方校验 /
  严格 CSP(`'self'` only,**不引任何外部字体、图标库、图表库 CDN**)/ textContent-only
  (全 `app.js` 现在只有 1 处 `innerHTML`,不许变多)。
- **禁止引入前端框架、打包器或运行时依赖**。K 线图不许上 lightweight-charts / ECharts 之类——
  它们是几十万行的依赖,而这张图的需求(蜡烛、轴、网格、十字光标、几条水平线)手写 400 行以内能做完,
  并且 CSP 面不扩大。renderer 保持零依赖。
- **禁止改变任何交互流程与信息架构**:侧栏 16 个页面、每页的功能、按钮的作用、快捷键、README「界面」一节
  记录的平台差异处理(Windows `titleBarOverlay`、字体栈、`pointer`、快捷键按平台显示、vibrancy 无底材时切实底、
  顶栏窄窗口按重要性整颗丢弃、侧栏 `role="tablist"` + 方向键、`prefers-reduced-motion`)——一条不动。
  这次改的是**皮相和图表工程**,不是产品。
- **禁止用"我觉得好看"替代参照物。** 每个视觉决定要能指出对应的 Apple 应用 / 富途面板的哪个部分。
- **禁止读取、打印、提交**真实账号、API Key、Keychain/DPAPI 内容、`config/settings.json` 敏感字段。
- **禁止一次性大改**。每一步都是"一个可独立回滚的小提交 + 一次完整验证闸门"。

### 必须保留

- README「按可用性启发式过了一遍」一节里的每一项行为:「还差 N 步」块不可永久关闭、禁用按钮 hover 说明原因、
  内部枚举翻译、密度切换、参考资料按需展开、开机即聚焦、残缺负载不塌页……改样式时逐条对照,不许倒退。
- `tools/build_preview.py` 是把 renderer 三个文件**原样内联**进一个 HTML;若拆分 `app.js`,
  它必须仍能工作(内联顺序 = 运行时加载顺序),**同一提交里改**。
- `desktop/package.json` `build.extraResources` 的运行时布局与 `main.js` 的路径推导一致;改一处必改另一处。

---

## 分发体积(顺带做,收益大风险低)

以 `npm run dist:win` 产出为准(上次构建:exe 91M,`win-unpacked` 332M)。目标:**各缩减 ≥ 30%**,
且打包版在**干净环境**(藏起仓库的 `trade-ts/node_modules` 与 `.venv`)能启动、连引擎、完成一次「解析并校验」。

| 线索(先复核再动手) | 证据 | 方向 |
|---|---|---|
| `extraResources` 把**整个 `trade-ts/node_modules`** 打进包 | 过滤器只排除 `test/docs/example`;含 devDependencies:`typescript` 23M、`@esbuild` 12M、`rollup/vite/vitest` ≈ 11M、`@types` 2.9M | 只打 production 依赖树;逐包核对 `better-sqlite3` 27M(`deps/`、`build/` 中间产物)、`protobufjs` 19M、`rxjs` 8.8M、`@stdlib` 9.2M(只用了 erf) |
| Electron 本体约 90M | 固定开销 | **不是优化对象**,基线里单列 |
| `trade-ts/nul/`(含 `config.js`/`store.js` 等编译产物) | 疑为 `tsc` outDir 写成 Windows `nul` 留下的 | 确认无引用后删,找到成因防复发 |
| `./~/Library`、`trade-ts/~/Library`(空目录树) | 疑为在 Windows 上按 macOS 路径习惯创建的副作用 | 找到写它的代码,修根因 |
| `desktop/dist/`、`.uipreview/`、`.venv`、两处 `node_modules` | 可再生 / 开发依赖,已 gitignore | 不算项目体积,报告单列 |

---

## 工作方式

### 阶段 0:基线(不改任何代码)

1. 跑全部验证闸门(见下),结果原样记进 `trade/desktop/OPTIMIZATION_REPORT.md`「基线」节。
2. `npm run dist:win`,记录 exe / `win-unpacked` 大小与 `resources/` 前 20 大项,Electron 本体单列。
3. **截图集**:两份 mock(`mock-bridge.js` 有数据态、`mock-bridge-empty.js` 首启空态)× 浅色/深色 × 16 页,
   外加 K 线 PA 页在 **1080 / 1360 / 1900px** 三个宽度下的截图(验证第 1 条"按像素画")。放 `.uipreview/baseline/`。
   用户手上的两张问题截图放 `.uipreview/reference/`,作为"改前"对照。
4. `audit_ui.py` 现有问题数记为基线。
5. 做一页**视觉审计**:把 Apple 应用 / 富途的参照点和本项目当前实现逐条对照成表(对照点 / 现状 / 差在哪 / 改法 / 涉及文件行号),
   **发给用户确认后再进阶段 1**。上面"视觉目标"两节是起点,不是全部——你还要自己看。

### 阶段 1:体积

每条一个提交;每个提交后重新打包 → 干净环境启动 → 解析并校验一条指令 → 记录体积变化。

### 阶段 2:界面壳(先做 token 与结构,再做页面)

1. 先建 token:背景亮度阶梯(`--bg-window/--bg-sidebar/--bg-content/--bg-elevated`)、`--up/--down`、`--focus-ring`、
   状态色只保留"圆点与数值"两种用途。把 `app.js` / `styles.css` 里 38 处硬编码色全部换成 token。
2. 侧栏 + 顶栏 + 宏观行情带一个提交(它们三个决定第一眼)。顶栏三颗彩色胶囊改成"圆点 + 文字";
   宏观行情带在**全部无数据**时不该显示一整行 `—`(收起或骨架)。
3. 卡片体系一个提交:去色条、状态图标、`.readiness` 改成 System Settings 式内嵌分组列表。
4. 表单控件一个提交:焦点环统一、禁用态统一、主按钮只此一个、账户勾选样式与 `.switch` 同族。
5. 每页一个提交过一遍,只改样式类,不改 DOM 结构与 id(`audit_ui.py` 会抓引用断裂)。

### 阶段 3:K 线图(一个独立模块)

1. 把 `renderPaChart` 抽成 `renderer/chart/`(或单文件 `pa-chart.js`)——**先改 `build_preview.py`**,再拆。
2. 按上面 9 条逐条实现,顺序:像素坐标系 → 轴与网格 → 蜡烛与量能归一化 → 现价与关键位标签避让 → 区域降噪 → 十字光标 → 图例。
3. 用 mock 数据里**故意构造**的极端样例验证:第一根巨量、200 根 bar、5 个关键位挤在 0.3% 价格区间内、
   FVG 与订单块重叠、只有 3 根 bar、指数无成交量。每个样例一张截图进报告。
4. 均线按用户拍板结果处理。

### 验证闸门(每个提交都要过)

```bash
# 引擎不回归(两侧都跑——正是为了证明没动到)
cd trade && .venv/Scripts/python -m pytest -q          # 418 项,离线
cd trade-ts && npm test && npm run typecheck && npm run golden

# 界面静态审计与预览
cd trade/desktop
python tools/audit_ui.py
python tools/build_preview.py . .uipreview/preview.html tools/mock-bridge.js
python tools/build_preview.py . .uipreview/preview-empty.html tools/mock-bridge-empty.js

# 真 Electron 启动(开发态 + 打包态各一次;打包态要藏起仓库依赖)
npm run dev                                             # 16 页各点一遍,控制台零报错
npm run dist:win && "dist/win-unpacked/Dafri Trading.exe"
```

**截图对比是硬闸门**:每个界面提交后重新出截图集,和上一版并排;差异只允许出现在该提交声明要改的地方。
Windows 上分别在 100% 和 150% 显示缩放下各看一次——用户的截图就是在缩放环境下拍的。

---

## 需要用户拍板的决策(遇到就停,不自己定)

1. **均线**:引擎侧新增 `ma` 输出(两侧同步 + 重生成基线)还是这版不画。
2. **涨跌色默认**:保持绿涨红跌,还是切到富途中文默认的红涨绿跌;无论哪种都做成设置项。
3. **K 线用 SVG 还是 canvas**:SVG 保持现状、可访问性好、200 根以内够用;canvas 十字光标更顺、bar 多也不卡。给出建议再问。
4. 打包版是否**继续同时携带两套引擎**(TS + Python 源码)。
5. 是否顺带补一份 renderer 的最小 smoke 测试(现在 renderer 零测试)。

---

## 交付物

`trade/desktop/OPTIMIZATION_REPORT.md`,结构固定:

1. **基线** —— 体积表、测试结果、审计问题数、截图集位置
2. **视觉审计表** —— 对照点 / 现状 / 差在哪 / 改法 / 文件行号 / 对应提交(阶段 0 那张表加"结果"列)
3. **体积变更逐项表** —— 改了什么 / 省了多少 / 怎么验证 / 对应提交
4. **K 线图** —— 9 条逐条的 before/after 截图,极端样例截图,坐标系与归一化的设计说明
5. **没做的与建议** —— 复核后不成立的线索、留给用户拍板的项、下一步建议
6. **FINDINGS** —— 过程中发现但按约束不许顺手改的疑似 bug,格式沿用 `type-safety-refactor-prompt.md`

README「界面」一节同步更新:只写**决策与原因**(为什么去掉色条、为什么按像素画、为什么状态不用彩色胶囊),
风格与现有内容一致,不写流水账。
