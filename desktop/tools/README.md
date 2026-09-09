# 界面预览与截图

Electron 的窗口平时截不了图,而 UI 不看见就没法改。这里的办法:用 Vite 的 `preview` 模式把
`window.dafri`(contextBridge)换成一份**假的、但形状真实**的数据源,再让 Electron 自己逐页拍照。
看到的排版、间距、层级、状态色和真应用完全一致——用的是同一份 CSS 与同一套组件。

```bash
npm run ui:preview                                          # 有数据的样子 → renderer-react/dist-preview/
DAFRI_MOCK=mock-bridge-empty.js npm run ui:preview          # 首次启动的样子
DAFRI_MOCK=mock-bridge-stress.js npm run ui:preview         # K线 PA 的极端数据(标签避让、量能归一化)
npx electron tools/capture_pages.js renderer-react/dist-preview/index.html .uipreview/dark --theme dark --check
```

## 数据源

| 文件 | 用来看什么 |
|---|---|
| `mock-bridge.js` | 有数据的样子:密度、对齐、状态色、长文本会不会撑破卡片 |
| `mock-bridge-empty.js` | **首次启动的样子**:什么都没配、什么都没连、一条记录都没有 |
| `mock-bridge-stress.js` | K线 PA 的压力数据:首根巨量、6 个关键位挤在 0.6% 区间、FVG 与订单块重叠 |

第二份更重要。它是新用户唯一会看到的状态,却是开发时最少看到的——手上有数据的时候
一切都好看,空的时候才知道哪里缺引导、哪里会漏 undefined、哪个面板会一直停在"加载中"。
「还差 N 步才能开始」那块引导就是照着它做出来的。

引擎新增了 RPC 方法、或者某个方法的返回结构变了,三份 mock 要跟着补。缺了会怎样:对应的面板会停在
"加载中"或空态,而不会报错——每个加载函数都自己 catch 了。K线 PA 的数据由 `node tools/gen_pa_mock.js`
生成(引擎纯函数 × 黄金基线 K 线,写进 mock;需要 engine-ts 已编译),`--stress` 另写压力那份。

## 截图集

```bash
npx electron tools/capture_pages.js renderer-react/dist-preview/index.html .uipreview/dark --theme dark --scale 1 --widths 1360
npx electron tools/capture_pages.js renderer-react/dist-preview/index.html .uipreview/dark15 --theme dark --scale 1.5 --widths 1360
npx electron tools/capture_pages.js renderer-react/dist-preview/index.html .uipreview/pa --theme dark --widths 1080,1900 --only pa
npx electron tools/capture_pages.js renderer-react/dist-preview/index.html .uipreview/demo --theme light --check --demo
```

每一页一个 PNG(`<theme>-<scale>x-<width>-<tab>.png`)。叶子页清单由 React 壳报出(`window.__dafriLeafTabs`:
侧栏项 + 合并页的子页),切页走 `window.__dafriNavigate`。K线 PA 页会先填标的、点「分析」再拍;
`--demo` 让各页先点一遍主按钮(解析 / 分析 / 回测 / 扫描 / 打开记录详情 / 展开追踪表单),拍出有内容的样子。
为什么不用浏览器:窄窗口丢弃顶栏胶囊、`titleBarOverlay` 留白、系统字体栈,这些只在 Electron 里才是真实的。
`--scale 1.5` 对应 Windows 150% 显示缩放——用户的问题截图就是在那个缩放下拍的,100% 下看不出同样的问题。

加 `--check` 就是渲染层的 smoke:每页各点一遍,渲染进程有任何 error 级控制台消息、或 K线 PA 页没画出 canvas,
就 FAIL;结论写在 `<outDir>/check.txt`,退出码 0/1。

界面改动的验收方式是**截图对比**:改前改后各出一套,并排看,差异只允许出现在该次改动声明要改的地方。
`.uipreview/` 已 gitignore,截图集不进仓库。

## 隐藏窗口的三个坑

这些都只在拍照用的隐藏窗口里出现,真机没有;脚本里都已处理,改脚本时别把它们改掉:

* **每次一个全新的 `userData`**。Electron 会把 `file://` 页面的 localStorage 持久化到 `%AppData%/Electron`,
  不清的话上一次记住的折叠态、列表密度、标的会带进下一次截图,拍出来的就不是首次启动的样子。
* **CSS 过渡不推进**。AntD 的开关、主按钮从"未加载"翻到"可用"时会停在起始色,拍出来一排灰的。
  载入后注入 `transition: none; animation: none`,截图只要终态。
* **窗口只在被截图时才合成一帧**。canvas 图的 `requestAnimationFrame` 绘制发生在那一帧之后,第一张里图是空的。
  `shoot()` 发现还有没画的 canvas(仍是默认 300×150)会再截,最多三次。
* **React 的受控输入框**。`--demo` 往输入框里填字要走原生 setter 再派发 `input` 事件,直接赋 `value` 状态不会变。

## 打包前置:引擎暂存与自检

```bash
npm run stage:engine:win     # tools/stage_engine_ts.js → build/engine-ts/(按 package-lock 生产依赖闭包,只带本平台 better-sqlite3)
npm run smoke:engine         # tools/smoke_engine_ts.js:Electron 自带 Node + 只有 System32 的 PATH,拉起暂存引擎发 system.status
```

`npm run dist:win` / `dist:mac` 会先构建界面(`ui:build`)再跑这两步。为什么不用 `npm ci --omit=dev`:better-sqlite3 没有 install 脚本,
npm 见到 binding.gyp 会去跑 node-gyp,没有 C++ 工具链的机器直接失败;而它的 tarball 本来就带了全部平台的预编译二进制。

## 解析链路时延压测

```bash
node tools/latency_bench.js                 # TS 引擎,进程内,固定交易日时钟(美东 2026-08-14 10:32,盘中)
node tools/latency_bench.js --only A,B      # 只跑某几类;--repeat N 重复;--cold 不预热 SPX 现价
node tools/latency_bench.js --match 英伟达,SPY # 只跑指令文本含这些片段的行:改完提示词抽查几条,少打付费端点
```

38 条自拟指令分八类(固定行话 / 蝴蝶与组合 / 正股 / 期权 / 触发与多单 / 应拒 / 边界 / 重复),逐条
`instruction.submit`(`execute:false`,**绝不下单**),记墙钟时延、走的是本地速记还是大模型、模型自报时延、
token 用量(含前缀缓存命中)、结果计数,写到 `.uipreview/latency/<engine>-<clock>.json`,末尾打一份分位数汇总和
"路径与预期不符"的清单。数据库一律指到临时目录,不碰真实的 trades.db(解析模式也会落拒绝记录)。

为什么要固定时钟:速记的默认到期是"当日",周末跑出来全是"非交易日"的拒绝,量的不是解析。第一次跑就是在周日跑的,
八条行话七条落到了大模型——查下来是周末,不是语法;固定时钟后八条全中,中位 1.6 毫秒。
大模型那一段是真调用(会花钱,几十条约几分钱);数字见 `docs/reports/desktop-optimization-report.md` §7。

## 启动前自动编 TS 引擎

`npm start` / `npm run dev` / `stage:engine:*` 之前都会先跑 `tools/ensure_engine_ts.js`:`../engine-ts/dist` 不存在或比
`src/*.ts`(含 tsconfig)旧就用 engine-ts 自带的 tsc 重编;engine-ts 没装依赖或 tsc 失败都直接报错不启动。
dist 不进仓库,新 clone 不用再记得手动编。
