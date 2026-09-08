# 界面预览台

Electron 的窗口截不了图,而 UI 不看见就没法改——这次的界面优化能做,靠的就是它。

```bash
python tools/build_preview.py . .uipreview/preview.html tools/mock-bridge.js
```

然后用浏览器打开 `.uipreview/preview.html`。

## 它是什么

把**真正的** `renderer/index.html` / `styles.css` / `app.js` 原样装进一个自包含的
HTML 里,只把 `window.dafri`(contextBridge)换成 `tools/mock-bridge.js` 里那份
假数据源。所以看到的排版、间距、层级、状态色和真应用完全一致——改的是同一份
CSS,不是另一套预览专用样式。

三个细节值得说明:

* **全部内联**。预览页可能被当成静态快照转成 `data:` URL,那时外链的 css/js 会
  一并断掉,只剩一个没有样式的骨架。
* **垫了一个内存版 localStorage**。`data:` 是 opaque origin,`localStorage` 在那里
  会抛 SecurityError,而 `app.js` 顶层就在读它——不垫的话脚本会在中途静默中断,
  后面的所有定义都不存在,表现为"界面渲染了但一点数据都没有"。
* **假数据挑的是典型值,不是空值**。空数据看不出密度问题:一列价格对不对得齐、
  状态色够不够分、长标的名会不会撑破卡片,都要有真实长度的数据才看得出来。

## 什么时候要更新 mock-bridge.js

引擎新增了 RPC 方法、或者某个方法的返回结构变了,这里要跟着补一条。缺了会怎样:
对应的面板会停在"加载中",而不会报错——`app.js` 里每个加载函数都自己 catch 了。

## 两份数据源

| 文件 | 用来看什么 |
|---|---|
| `mock-bridge.js` | 有数据的样子:密度、对齐、状态色、长文本会不会撑破卡片 |
| `mock-bridge-empty.js` | **首次启动的样子**:什么都没配、什么都没连、一条记录都没有 |

第二份更重要。它是新用户唯一会看到的状态,却是开发时最少看到的——手上有数据的时候
一切都好看,空的时候才知道哪里缺引导、哪里会漏 undefined、哪个面板会一直停在"加载中"。
「还差 N 步才能开始」那块引导就是照着它做出来的。

## 静态审计

```bash
python tools/audit_ui.py
```

查四类人眼容易漏的问题:无可访问名字的按钮、没有标签也没有 placeholder 的输入框、
app.js 引用了但 index.html 里不存在的 DOM id(点了没反应的按钮多半是这个)、
界面文案里漏出来的内部枚举。不是替代人眼看,是把人眼不擅长的那部分交给机器。

## 截图集

```bash
npx electron tools/capture_pages.js .uipreview/preview.html .uipreview/baseline/data --theme dark --scale 1 --widths 1360
npx electron tools/capture_pages.js .uipreview/preview.html .uipreview/baseline/data --theme dark --scale 1.5 --widths 1360
npx electron tools/capture_pages.js .uipreview/preview-empty.html .uipreview/baseline/empty --theme light --scale 1 --widths 1360
npx electron tools/capture_pages.js .uipreview/preview.html .uipreview/baseline/pa-widths --theme dark --widths 1080,1900 --only pa
```

用 Electron 自己把预览台的每一页拍成 PNG(`<theme>-<scale>x-<width>-<tab>.png`),K线 PA 页会先填标的、
点「分析」再拍。为什么不用浏览器:窄窗口丢弃顶栏胶囊、`titleBarOverlay` 留白、系统字体栈,这些只在
Electron 里才是真实的。`--scale 1.5` 对应 Windows 150% 显示缩放——用户的问题截图就是在那个缩放下拍的,
100% 下看不出同样的问题。

每次运行都用一个全新的 `userData`:Electron 会把 `file://` 页面的 localStorage 持久化到 `%AppData%/Electron`,
不清的话上一次记住的折叠态、列表密度、标的会带进下一次截图,拍出来的就不是首次启动的样子(这个坑真踩过一次:
速记说明明明默认收起,截图里却一直是展开的)。

加 `--check` 就是 renderer 的 smoke:16 页各点一遍,渲染进程有任何 error 级控制台消息(已知的 6 条内联样式 CSP 提示除外)、
或 K线 PA 页没画出 canvas,就 FAIL;结论写在 `<outDir>/check.txt`,退出码 0/1。

界面改动的验收方式是**截图对比**:改前改后各出一套,并排看,差异只允许出现在该次改动声明要改的地方。
`.uipreview/` 已 gitignore,截图集不进仓库。

K线 PA 页的数据由 `python tools/gen_pa_mock.py` 生成(引擎纯函数 × 黄金基线 K 线,写进两份 mock);
`--stress` 另写一份 `mock-bridge-stress.js`:首根巨量、6 个关键位挤在 0.6% 区间、FVG 与订单块重叠,
专门用来看标签避让与量能归一化。

## 打包前置:引擎暂存与自检

```bash
npm run stage:engine:win     # tools/stage_engine_ts.js → build/engine-ts/(按 package-lock 生产依赖闭包,只带本平台 better-sqlite3)
npm run smoke:engine         # tools/smoke_engine_ts.js:Electron 自带 Node + 只有 System32 的 PATH,拉起暂存引擎发 system.status
```

`npm run dist:win` / `dist:mac` 会先跑这两步。为什么不用 `npm ci --omit=dev`:better-sqlite3 没有 install 脚本,
npm 见到 binding.gyp 会去跑 node-gyp,没有 C++ 工具链的机器直接失败;而它的 tarball 本来就带了全部平台的预编译二进制。

## 解析链路时延压测

```bash
node tools/latency_bench.js                 # TS 引擎,进程内,固定交易日时钟(美东 2026-08-14 10:32,盘中)
node tools/latency_bench.js --engine py     # Python 引擎,走 stdio RPC(真实时钟)
node tools/latency_bench.js --only A,B      # 只跑某几类;--repeat N 重复;--cold 不预热 SPX 现价
node tools/latency_bench.js --match 英伟达,SPY # 只跑指令文本含这些片段的行:改完提示词抽查几条,少打付费端点
```

38 条自拟指令分八类(固定行话 / 蝴蝶与组合 / 正股 / 期权 / 触发与多单 / 应拒 / 边界 / 重复),逐条
`instruction.submit`(`execute:false`,**绝不下单**),记墙钟时延、走的是本地速记还是大模型、模型自报时延、
token 用量(含前缀缓存命中)、结果计数,写到 `.uipreview/latency/<engine>-<clock>.json`,末尾打一份分位数汇总和
"路径与预期不符"的清单。数据库一律指到临时目录,不碰真实的 trades.db(解析模式也会落拒绝记录)。

为什么要固定时钟:速记的默认到期是"当日",周末跑出来全是"非交易日"的拒绝,量的不是解析。第一次跑就是在周日跑的,
八条行话七条落到了大模型——查下来是周末,不是语法;固定时钟后八条全中,中位 1.6 毫秒。
大模型那一段是真调用(会花钱,几十条约几分钱);数字见 `OPTIMIZATION_REPORT.md` §7。
