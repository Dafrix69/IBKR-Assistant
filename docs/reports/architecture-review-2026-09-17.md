# 架构体检(2026-09-17)

对 `engine-ts/src`(38 个文件,23,854 行)与 `desktop/renderer-react/src`(63 个文件,12,470 行)跑了一遍
import 图、圈复杂度粗筛、函数长度与 `any` 分布,再对着源码逐条核过。结论先说:

**这个仓库离屎山很远。** 黄金基线、42 个 spec、lint + typecheck 进 CI、每个功能一份 `docs/features/*.md`、
`dependencies.md` 把"为什么不引入"写清楚——这些是大多数项目到死都没有的东西。界面这一侧的依赖图干净得
不像 AI 写的:零循环、`shell → pages → lib → store → bridge` 分层没有一处反向。

真正会让它在半年后变难改的,是下面五件事。按"再不管就会扩散"的顺序排,前两条是结构性的,后三条是体积。

## 一、引擎 ↔ 界面的契约没有单一事实来源

同一个 RPC 方法名现在写在四个地方,彼此之间靠正则测试缝着:

| 位置 | 形态 | 类型 |
|---|---|---|
| `engine-ts/src/rpc.ts` `methods()` | 77 个 `"tracker.add": (p) => this.trackerAdd(p)` | 入参 `Rec`(= `Record<string, any>`),出参 `Rec` |
| `desktop/main.js` `ALLOWED_RPC` / `SENSITIVE_RPC` | 字符串 Set | 无 |
| `desktop/preload.js` | 78 个 `method: 'tracker.add'` | 无(JS) |
| `desktop/renderer-react/src/bridge.ts` `DafriBridge` | 78 个方法签名 | 约 60 个返回 `Rpc<any>`,入参多为 `unknown` |

`tests/desktop-whitelist.spec.ts` 用正则把 preload 与 main.js 对一遍——这是对的,而且它抓到过真事故
(2026-09-10 `tracker.target_preview` 漏登记)。但它只能对**方法名**,对不了**字段**。引擎把 `positions.list`
返回里的 `avg_cost` 改名成 `avg_price`,四个地方没有一个会报错,只有 `Tracker.tsx` 上的数字变成 `NaN`。
`bridge.ts` 文件头自己也写着"迁到哪一页就把那一页用到的结构收紧成具体接口"——收紧了 `Status` / `Settings` /
`PoolWatch` 三个,剩下的还是 `any`。

这是最值得先修的一条,因为它决定了以后**每一个**跨引擎与界面的改动的成本。

**建议做法**:在 `engine-ts/src/` 下建一个 `contract/` 目录(或单文件 `contract.ts`),每个 RPC 方法一条
`{ params: zod schema, result: TypeScript interface }`。引擎已经用 zod 校验模型输出,同一套工具:

- `rpc.ts` 的 `methods()` 表从 `contract` 生成,入参在 `handleInner` 里统一 `schema.parse`,handler 拿到的就是
  具体类型,`Rec` 自然消失;
- `bridge.ts` 的 `DafriBridge` 用 `import type` 从 `engine-ts/src/contract` 引类型(Vite 只取类型,不会把引擎
  打进渲染层;tsconfig 加一个 `paths` 就行);
- `main.js` 的 `ALLOWED_RPC` / `SENSITIVE_RPC` 由构建脚本从 `contract` 里的 `sensitive: true` 标记生成,或者
  `desktop-whitelist.spec.ts` 改成对着 `contract` 核而不是对着 preload 的正则。

不用一次做完。**每碰一个方法就把它迁进 contract**,新方法一律只能从 contract 加——这条写进 CLAUDE.md,
半年后自然就全了。

## 二、`rpc.ts`:传输层里长出了一个业务层

`rpc.ts` 3,360 行,import 了 37 个模块里的 28 个(见 `engine-deps-2026-09-17.svg`,左下角那个扇出)。它的
名字说自己是 RPC,但里面有:

- 传输:`serve` / `handle` / 三条道的调度 / `emit`——这部分约 350 行,是它该有的;
- **业务编排**:股票池的两个开关与迁移(`setPoolWatch` / `ensurePoolMigrated`,约 180 行)、价位提醒的整套轮询
  (`alertsPoll` / `tickWatchLevels` / `dailyHistory`,约 250 行)、异动循环(`startAnomalyLoop` / `anomalyTickInner`
  154 行,是全文件最长的函数)、扫描器编排(`screenMembers` / `screenBars`);
- **状态**:`paCache` / `wallCache` / `histCache` 三个缓存、`trackerChain` 锁、异动循环的计时器。

`TradingEngine`(`engine.ts`,2,059 行)是同样的故事的另一半:指令处理、执行、追踪循环、托管单、IB 事件回调
四种职责在一个类里,`handleInstruction` 239 行。

两个文件加起来 5,400 行,是引擎的 23%。它们是所有"改一个功能要读半天"的根源,也是 Claude Code 生成代码时
最容易"顺手加在这里"的地方——因为什么都在这里。

**建议做法**:不重写,只搬家。`rpc.ts` 拆成 `rpc/server.ts`(传输 + 三条道,不动)+ `rpc/handlers/<域>.ts`
(`tracker.ts` / `alerts.ts` / `pool.ts` / `screener.ts` …,每个导出一张 `{ "tracker.add": fn }` 的表,
`server.ts` 把它们 `Object.assign` 起来)。`alertsPoll` 与 `anomalyTick` 这种带状态的循环,连同它们的缓存一起
搬进 `services/alerts.ts` / `services/anomaly.ts`,handler 只剩一行转调。`golden-rpc.spec.ts` 回放的是
stdio 契约,不看内部结构,拆完它照样绿。

`engine.ts` 同理:托管单(`syncHosted` / `adoptHosted` / `placeHostedOne` … 约 400 行)和 IB 事件回调
(`onOrderStatus` / `onExecDetails` / `onCommission` / `stashUnmatched` / `replayUnmatched` 约 250 行)各自是一个
清晰的边界,可以先搬这两块。

## 三、下单层反向依赖了分析层

用 `dependency-cruiser` 按"依赖只能往下流"跑了一遍(规则在 `engine-ts/.dependency-cruiser.cjs`),8 条违规,
全部集中在执行层:

```
broker.ts     → tracker.ts      取 legOf / makeKey / positionLabel + HostedOrderPlan 类型
broker.ts     → priceaction.ts  取 MIN_BARS / TIMEFRAMES
futuBroker.ts → priceaction.ts  同上
broker.ts     → tradereview.ts  取 utcIso(一个时间格式化函数)
broker.ts     → anomaly.ts      取 VolumeSnapshot 类型
store.ts      → validator.ts    取 RecentOrder 类型
broker.ts    ↔ ibSession.ts     ibSession 从 broker 拿 IbSession 等接口定义(纯类型环)
futu.ts      ↔ futuBridge.ts    futuBridge 动态 import futu 取 FutuUnavailable
```

没有一条是真的业务耦合,每一条都是**一个小东西放错了文件**:持仓的 key / leg 是领域概念不是追踪器的;
K 线周期表是行情的不是价格行为的;`utcIso` 是 `tz.ts` 的;`IbSession` 接口应该和 `ibSession.ts` 在一起或者
单独一个 `ibTypes.ts`。总共大概搬 6 个函数、4 个类型,半天的活,搬完 8 条全绿,然后把这条检查放进 CI,
反向依赖就再也进不来了。

界面那边同样的规则跑出 3 条,都在 `theme/appearance.ts`——它读 settings、写 banner,其实是个 store,
挪到 `store/appearance.ts` 就完了。

## 四、`Rec = Record<string, any>` 在九个文件里各声明了一次

`rpc.ts` 220 处、`store.ts` 75 处、`engine.ts` 60 处。`eslint` 关掉 `no-explicit-any` 的理由(券商与模型回包
的结构由对方定)是成立的,但 `Rec` 已经从 `broker.ts`(2 处)漏到了内部领域:交易记录、追踪器行、
RPC 入参。`tsconfig` 开着 `strict` + `noUncheckedIndexedAccess`,可是一个 `Rec` 就把整条链路的类型检查关掉了。

这一条不单独修,它会随着第一条自然收窄:契约有了具体类型,`rpc.ts` 里的 `Rec` 自动没了;`store.ts` 的
`Rec` 换成 `RecordRow` / `TrackerRow` 接口(字段就是 SQLite 表的列,已经是固定的)。可以先加一条 lint:
**新文件禁止声明 `type Rec`**,`Rec` 只允许出现在 `broker.ts` / `ibSession.ts` / `futuBroker.ts` /
`providers.ts` 这四个"对外"文件里。

## 五、界面上的大组件

| 组件 | 行数 | 位置 |
|---|---|---|
| `buildAntdTheme` | 313 | `theme/antd.ts` |
| `PaPanel` | 252 | `pages/Market.tsx` |
| `FutuPanel` / `LlmPanel` / `TwsPanel` | 231 / 196 / 93 | `pages/Access.tsx`(725 行) |
| `TradePage` | 218 | `pages/Trade.tsx` |
| `RecordsPage` | 215 | `pages/Records.tsx` |
| `TrackerPage` 整页 | 848 | `pages/Tracker.tsx` |

比引擎那边轻得多,而且不影响正确性,只影响改起来顺不顺手。`buildAntdTheme` 是一张大配置表,不算问题。
`Access.tsx` 三个 panel 各自独立,拆成 `pages/access/{Tws,Futu,Llm}Panel.tsx` 是纯搬家。`Tracker.tsx`
848 行里表格、表单、试算弹窗三块可以各自成文件。原则:**一个页面文件超过 400 行,先想它是不是三个东西**。

## 引擎各文件的体量与扇入扇出

| 文件 | 行数 | import 了 | 被 import | 备注 |
|---|---|---|---|---|
| `rpc.ts` | 3,360 | 28 | 1(cli) | 见第二条 |
| `broker.ts` | 2,673 | 10 | 5 | `BrokerRouter` 53 个方法;IB 合约工具函数(`stockContract` … `optionContract`,约 200 行)可以单独成 `ibContracts.ts` |
| `engine.ts` | 2,059 | 14 | 2 | 见第二条 |
| `futuBroker.ts` | 1,732 | 9 | 2 | 与 `broker.ts` 平行的富途实现 |
| `tracker.ts` | 1,522 | 2 | 3 | 纯计算为主,健康 |
| `priceaction.ts` | 1,064 | 3 | 4 | 纯计算,健康 |
| `store.ts` | 1,051 | 1 | 5 | 见第四条 |
| `py.ts` | 137 | 0 | **21** | Python 语义兼容工具,扇入最高,正确 |
| `tz.ts` | 148 | 0 | 13 | 同上 |
| `config.ts` | 715 | 2 | 12 | 正确 |

1,376 个函数里超过 100 行的 25 个,超过 300 行的 1 个(`buildAntdTheme`)。这个比例是健康的。

## 机制:让它保持住

上面五条修完,半年后会不会长回来,取决于下面三件事有没有变成机器检查。

**1. 依赖方向进 CI。** 两份 `.dependency-cruiser.cjs` 已经写好并跑过(引擎 8 条、界面 3 条,都是上面列的那些)。
加到两个 package.json:

```json
"depcruise": "depcruise src --config .dependency-cruiser.cjs"
```

CI 里排在 `lint` 之后。第一次跑会红,把现有 8 + 3 条修掉之后就绿了;之后 Claude Code 再往 `broker.ts`
里 import `priceaction` 会直接被 CI 拦住。`npm i -D dependency-cruiser`,开发依赖,不进安装包。

**2. CLAUDE.md。** 仓库根目录现在没有这个文件。README 与 `docs/features/*.md` 写得很好,但 Claude Code
每次开工只会自动读 CLAUDE.md,不会主动去翻 `docs/`。所以要把**约束**(不是说明)提炼到那里:分层、
契约只能从 `contract` 加、`Rec` 的禁区、文件体积预算、改黄金基线的流程。草稿已放在根目录,是从这份报告
和现有文档里抽出来的规则,不重复 README 的内容。

**3. 体积预算。** 不需要工具,写在 CLAUDE.md 里就够:引擎单文件 1,500 行、函数 150 行、页面组件 400 行。
超过的不是不能提交,是提交前要先问一句"它是不是两个东西"。现在超线的就是 `rpc.ts` / `broker.ts` /
`engine.ts` / `futuBroker.ts` / `tracker.ts` 五个,其中 `tracker.ts` 是纯计算,不用动。

## 顺序

1. 半天:搬第三条的 6 个函数 4 个类型,`depcruise` 全绿,进 CI。
2. 一天:`rpc.ts` 按域拆 handlers,带状态的循环进 `services/`。`golden-rpc` 不动。
3. 持续:`contract/` 建起来,新方法只走这里,老方法碰到一个迁一个。
4. 顺手:`engine.ts` 的托管单与 IB 回调各搬一个文件;`Access.tsx` / `Tracker.tsx` 拆页;
   `theme/appearance.ts` → `store/`。

第 1 步做完就有了护栏,后面的可以慢慢来。不建议开一个"大重构"分支——这个仓库的 `docs/briefs/` 里已经有
`ts-rewrite` 和 `type-safety-refactor` 两份,说明你知道大重构的代价。这次全部是搬家式的改动,每一步单独
可提交、测试照跑。

---

工具:import 图与环检测用 Tarjan SCC 自写脚本核对了 `dependency-cruiser` 的结果,两者一致;函数长度用
括号配对粗算,对箭头函数与类方法都覆盖,误差在 ±3 行。`.git` 未纳入(没跑 churn 热点),如果想看
"改得最勤的文件是不是最大的文件",`git log --format= --name-only | sort | uniq -c | sort -rn | head`
一行就够。

## 进展

**2026-09-17,第 1 步做完。** 引擎 8 条、界面 3 条违规全部归零,`depcruise` 进了两边的 `npm run` 与 CI(排在 lint 之后)。
改动全是搬家,没有一行逻辑变化;`tsc`、`eslint`、42 个 spec / 917 个用例(含全部黄金基线)、`ui:typecheck`、
`ui:build` 都绿。具体:

| 搬了什么 | 从 | 到 | 老路径 |
|---|---|---|---|
| `IbContract` `IbSession` `IbSessionFactory` `OrderIntent` `TickerData` `TickerHandle` `RawBar` `OptChainParam` `PortfolioItemLike` `PositionItemLike` `TradeLike` | `broker.ts` | 新 `ibTypes.ts` | `broker.ts` 继续 `export type` 转出 |
| `makeKey` `legOf` `positionLabel` `fmtStrike` `HostedOrderPlan` | `tracker.ts` | 新 `positions.ts` | `tracker.ts` 转出 |
| `TIMEFRAMES` `MIN_BARS` | `priceaction.ts` | 新 `marketdata.ts` | `priceaction.ts` 转出 |
| `VolumeSnapshot` | `anomaly.ts` | `marketdata.ts` | `anomaly.ts` 转出 |
| `RecentOrder` | `validator.ts` | `models.ts` | `validator.ts` 转出 |
| `utcIso` | `tradereview.ts` | `tz.ts` | `tradereview.ts` 转出 |
| `FutuUnavailable` | `futu.ts` | `futuBridge.ts`(桥自己抛,不再动态 import 回去) | `futu.ts` 转出 |
| `appearance.ts` | `theme/` | `store/`(它读 settings、写 banner,本来就是 store) | 7 处 import 已改 |
| `Toasts.tsx` | `ui/` | `shell/`(它读 banner store) | `App.tsx` 已改 |
| `useAntdTheme()` | 自己读 store | 改为 `useAntdTheme(dark)`,由 `App` 传入 | — |

"老路径转出"意味着测试与其它模块的 import 一行没改;等下一次碰到这些文件时再把 import 指到新家,
转出行就可以删。`schemaOut.ts` 被 `depcruise` 标为孤儿(只有 `unit-side.spec.ts` 用它,生产代码没有):
`providers.ts` 走的是 SDK 自带的 structured outputs,这个 Python 版的 schema 清洗大概率已经用不上了,
留给你决定删不删。

**2026-09-19,第 2 步做完。** `rpc.ts` 从 3,500 行的一个类搬成 22 个文件,最大的 448 行
(`handlers/tracker.ts`),`rpc.ts` 自己剩 15 行转出的壳(cli、`latency_bench.js` 与测试的 import 一行没改)。

| 去了哪 | 内容 |
|---|---|
| `rpc/server.ts`(360 行) | 传输与三条道、配置 / router / 引擎的生命周期、把各域的表合成一张 |
| `rpc/handlers/*.ts`(13 个) | `system` `trading` `ideas` `sectors` `screener` `backtest` `market` `alerts` `quality` `review` `tracker` `connection` `settings` |
| `rpc/context.ts` `rpc/params.ts` | handler 的上下文接口与基类;入参小工具 |
| `services/marketData.ts` | `paBars` / `dailyHistory` / `wallFor` / `spotOf` 与三个缓存 |
| `services/alerts.ts` | 算价位、盯穿越、盯上了自动补价位(连同按标的退避的两张表) |
| `services/anomaly.ts` | 异动循环、样本、指标、心跳 |
| `services/pool.ts` | 股票池的两个开关与一次性迁移 |
| `rpcError.ts`(util 层) | `RpcError`:service 也要抛带码的错,不该为它去 import 传输层 |

怎么保证是搬家不是重写:用脚本按行号从 HEAD 切片拼文件,函数体逐字搬,只有接线处做字符串替换且每条替换断言
命中次数;搬完做了一次逐行对账——旧文件 3,278 个非空行里在新文件中找不到的 250 行,全部是 import、
`RpcServer.X` 改归属、`this.x(` 改成 `this.ctx.<service>.x(`、`private` 改公开这四类,没有一行业务逻辑。
`golden-rpc` 的 stdio 契约回放没动基线就是绿的;另外用 `dist/src/cli.js rpc` 起真进程打了 14 条请求
(含 `futu.scan`——它按 `import.meta.url` 往上找 `node_modules`,搬了两级目录后层数要跟着改)。

测试只改了"从哪儿调"(`s.qualityAdd(` → `s.domains.quality.qualityAdd(`、`s.anomalyTickOnce(` →
`s.anomaly.tickOnce(` 这一类,7 个文件),断言一个字没动。

顺手补的三道护栏:

- `depcruise` 多三条:`rpc-outermost`(传输层之外谁也不 import 它,services 因此不认识 RPC)、
  `rpc-facade-one-way`、`handlers-are-leaves`(handler 之间不互相 import)。各放了一个故意违规的探针文件验过会红。
- `desktop-whitelist.spec.ts` 以前只对 preload ↔ `ALLOWED_RPC`,现在加上引擎方法表 ↔ `ALLOWED_RPC` 双向,
  以及三张道表里的名字都得是真方法。拆成 13 张表之后,漏接一张表和漏登记白名单是同一种事故。
- 第四条里建议的 lint 落地了:`type Rec` 只许出现在一张豁免表里的文件(`eslint.config.js`),那张表只许变短。

唯一一处不是纯搬家的改动:方法表改成无原型对象、`handler` 判 `typeof === "function"`。以前
`{"method":"constructor"}` 会从 `Object.prototype` 上捞到 `Object` 当 handler 调;主进程有白名单挡着,
界面打不到,但引擎自己不该靠别人挡。

**没做、留给下一步的**:handler 的入参与返回还是 `Rec`。这是第一条(契约)的活,不该混在搬家里——
搬家的价值就在于 diff 里没有逻辑。下一步是第 3 步:建 `contract/`,从 `quality.*` 与 `pool.set_watch` 开始
(`bridge.ts` 那头这几个已经有具体接口,两边对得上,是最便宜的起点)。

**2026-09-20,第 3 步开了头:`contract/` 建起来,先迁 6 个方法(`quality.*` 五个 + `pool.set_watch`),77 个里还剩 71 个。**
机制与设计决策写在 `docs/features/engine-rpc.md` 的「契约」一节,这里只记和本报告第一条的建议**不一样**的地方,以及验证:

- 报告建议"每个方法一条 `{ params: zod schema, result: 接口 }`"放在一起、`bridge.ts` 用 `import type` 引。落地时发现做不到:
  界面的 tsc 会顺着 `import type` 把整个文件纳入检查,而 CI 的 `desktop-ui` 不装引擎的依赖,文件里有一个 `import "zod"` 就解析不了。
  所以拆成两层:`contract/*.ts` 是零 import 的纯类型(源头),`contract/schema/*.ts` 是 zod,写成 `ParamsSchema<契约类型>`
  反过来对类型。两条 depcruise 规则加一条测试守着"类型文件不 import 任何东西"。
- 报告建议 `ALLOWED_RPC` / `SENSITIVE_RPC` 由契约里的标记生成。没做:迁进来的 6 个方法都不发单,`sensitive` 标记现在没有
  消费者;等第一个会发单的方法迁的时候再加。
- 类型不是新写的,是**搬**的:`anomaly.ts` 的 `AnomalyConfig` / `Metrics` / `AnomalyEvent` 搬进契约、原处转出;`bridge.ts`
  手抄的 121 行接口删掉、改成转出。搬的时候对出两处已经漂了的:`enabled` 库里是 `0 | 1`,界面那份写的是 `number | boolean`;
  `quality.remove` 的 `deleted` 界面那份是 `unknown`,实际是 `string`。
- 第四条(`Rec`)跟着收窄了一块:`quality_stocks` 的 store 方法回 `QualityStockRow`,`PoolService.setWatch` 回 `PoolWatch`,
  `AnomalyService.monitor()` 回 `QualityMonitor`,`handlers/quality.ts` 里已经没有 `Rec`。

验证:把契约里的 `block_share` 临时改名,引擎的 tsc 在 `anomaly.ts`(产出它的地方)报错、界面的 tsc 在 `PoolStock.tsx`
(消费它的地方)报错——这就是第一条开头那个 `avg_cost → avg_price` 的场景,现在两头一起红。五道护栏(类型文件引包、
`bridge.ts` 不带 type 的 import、绕开契约加方法、分析层引 schema、页面直接引引擎目录)各放探针验过会红。
`dist/src/cli.js rpc` 真进程 19 条请求全过,其中 5 条专门核契约路径:缺字段 / 类型不对由 schema 报,领域错还是 handler
那句人话,小写带空格的代码、`null` 当没传、阈值给数字串——老 handler 认的,现在照认。

一处有意的文案变化:结构错(调用方写错了)的报错从各 handler 自己的说法统一成「`<方法>` 的参数不对:<字段> …」,
错误码不变(-32602)。例:`quality.set_config` 的 `config` 传了数组,以前是「触发条件格式不对:config 应是一个对象」。
界面走类型化的 bridge,打不出这种请求;给用户看的领域文案一句没动,测试钉着。

接下来按域迁:`alerts.*` 与 `sectors.*`(和 pool 同一片,store 行类型可以一起收)→ `tracker.*` / `positions.list`
(第一个会发单的域,到时把 `sensitive` 标记加进契约)。

**2026-09-20,第 3 步第二批:`alerts.*`(5 个)与 `sectors.*`(8 个)迁完,77 个里已迁 19 个、还剩 58 个。**

- 判据是 `golden-rpc`:它回放的 96 条请求里有 22 条打的是这两个域,**没更新基线就是绿的**——线上形状一个字节没变。
- 这一批的手抄藏得更深:`bridge.ts` 回的是 `any`,而界面的 `store/alerts.ts` / `store/sectors.ts` 里各自手写了一套接口,
  两者之间没有任何检查。对出来猜错的:价位的 `kind` 写成 `'support' | 'resistance' | 'neutral'`(引擎给的是 `pivot`,
  从来没有 `neutral`;`LevelStrip` 只比前两个、其余走默认,所以没出过事);字段全标成可选;`Sector` 上还挂着一个
  `[key: string]: unknown`。现在这两个文件只做转出,页面的 import 一行没改,界面一次编译通过。
- 类型从源头标起,不在 handler 里断言:`StockQuote` 标到两家券商适配层的 `stockQuotes` 上,`OptionWallCore` 标到
  `optionwall.analyze` 上(`golden-analysis` 的数值基线没动),`WatchLevel` / `WatchEvent` 标到 `alerts.ts` 上。验证:
  把 `change_pct` 改名,`broker.ts`、`futuBroker.ts` 与 `PoolStock.tsx` 同时报错;把 `last_price` 改名,`store.ts`、
  `services/alerts.ts` 与 `PoolStock.tsx` 同时报错。期权墙的形状(`contract/options.ts`)因为盯单上存着整份,先进了契约,
  `options.wall` 下一批顺带就能迁。
- 第四条(`Rec`)又收了一块:`alert_watches` / `sectors` 的 store 方法回 `Watch` / `Sector`,`handlers/alerts.ts`、
  `handlers/sectors.ts`、`services/pool.ts` 里已经没有 `Rec`;`services/alerts.ts` 的 `refresh` 里两个 `!` 断言也顺手消掉了
  (改成先取到再赋值,逻辑不变)。
- "迁一个划一个"那条棘轮验过会拦:13 个方法迁完、名单还没改的时候,`contract.spec` 是红的。

**照出来、但没有改的两处**(都需要你定夺,所以只写进了契约的注释):

1. `alerts.create` 的回执里 `enabled` 是数字 `1`,`alerts.list` 里同一条盯单是 `true`——`addWatch` 回的是刚插入的那一行,
   没过读库那道转换。真进程里核过确实如此,而且被 `golden-rpc` 钉着。要统一就得 `golden:update` 并在提交里说明改了口径;
   界面只按真假用,现在不碍事,所以契约里先如实写成 `boolean | 0 | 1`。
2. `sectors.pick` 等大模型的那几秒里如果板块被删了:`setSectorStocks` 静默改 0 行,但新选出来的股照样被打开两个开关,
   成了"有开关却不在任何板块"的孤儿(一次性迁移不会再跑,没有别的东西清它们)。写契约时发现回执里的 `sector` 可能是 `null`,
   顺着查出来的;用一次性用例复现过:回执 `sector: null`,NVDA 不在任何板块,却同时有盯价位与盯异动两行。
   窗口很窄,是老行为,不混进这笔"线上形状不变"的迁移——紧跟着单独一笔提交修。
   **已修**:等完大模型先确认板块还在,不在就报「板块不存在:…(选股期间被删了,这次的结果没有保存)」,一个开关都不开;
   回归用例在 `pool-watch.spec.ts`(先红后绿)。修完之后契约里 `sectors.pick` 的 `sector` 不再带 `null`。

接下来:`options.wall`(形状已经在契约里)→ `tracker.*` / `positions.list`(第一个会发单的域,到时把 `sensitive` 标记加进契约)。

**2026-09-20,`options.wall` 迁完(已迁 20 个,还剩 57 个)。** 形状上一批就在契约里了,这次只是登记方法、配 schema
(`width` 老 handler 认数字串,schema 照认)。界面目前没有页面调它——墙是经 `alerts.refresh` 存在盯单上给界面的——但它在
白名单和 preload 里,`bridge.ts` 的签名从 `(spec: unknown) => any` 收成了契约类型。`golden-rpc` 里它那条没动基线就是绿的。

**2026-09-20,`tracker.*` / `positions.list`:没有迁,先补了一张安全网。** 动手前核了一下这个域的保护,结论是不能照前几批的办法做:

- 前几批敢迁,是因为 `golden-rpc` 钉着线上形状(alerts / sectors 22 条)、还有 `quality-rpc` / `pool-watch` 全程走 `s.handle`。
  而这个域在 `golden-rpc` 里只有 5 条空转的请求(`list`、对不存在的 id 做 `update` / `delete`、`reconcile`、没连券商的
  `positions.list`)。**没有任何测试经由 RPC 层调过 `tracker.add`、带真实目标的 `tracker.update`、`tracker.close_now`、
  `tracker.target_preview`**——盯盘与托管的测试很细,但都是直接调引擎层,绕过了入参这一段。
- 而这一段恰恰最容易在迁移里出事:界面发给 `tracker.add` 的数值**全是字符串**(`str(tp)`),`''` 表示不设。照"看起来自然"的写法配
  `z.number().optional()`,真应用里每一次建追踪都会被拒;换成会强转的写法,`''` 可能变成 `0`。更隐蔽的是 `z.object` 会**静默丢掉**
  没列进 schema 的键——对 `quality.add` 无所谓,对 `tracker.add` 就是"追踪建成了,那道保护却没设上"。引擎层的测试会一路绿灯。
- 所以先写了 `tests/tracker-rpc.spec.ts`(32 条):输入照界面的原样,经 `s.handle` 走完整条路径,假券商只记下收到的单;
  钉的是现在的行为。它自己也验过——把解析改坏成上面几种样子,6 个变异全部被抓住。细节与两处如实钉住的现状
  (`tracker.add` 回执里 `enabled` 是数字 `1`;`tracker.update` 的 `auto_close` 是整份替换)写在 `docs/features/tracker.md`。

这个域接下来分三段走,每一段单独提交:

1. **入参 + 能从源头标类型的返回**:`tracker.list` / `add` / `update` / `delete` / `target_preview` 与 `positions.list`。
   `Targets` / `AutoClose` / `SpotTarget` 在 `tracker.ts` 里本来就是具体类型,照 `anomaly.ts` 的样板搬进契约。数值入参的契约类型写成
   `number | string`(`''` = 不设);schema 用 `.strict()`,不认识的键当场拒。判据:`tracker-rpc.spec` 不改一个断言。
   这一段把 `sensitive`(要界面确认)标记加进契约,并让 `desktop-whitelist.spec` 拿它对 `main.js` 的 `SENSITIVE_RPC`。
   可行性试过了:`engine.ts` 里有 84 处用到追踪行,但把 store 的 `listTracks` / `getTrack` 临时收成具体类型后,类型错误只有 5 处,
   而且全是同一个被调方——`tk.sweepReason` 的参数写成了 `Record<string, unknown>`(接口类型传不进去)。它在纯计算的 `tracker.ts` 里,
   改它的签名就行,**`engine.ts` 一行不用动**。所以这一段不受第 3 段阻塞,可以先做。
2. **`tracker.poll` / `reconcile` / `close_now` 的返回**:这三样是在 `engine.ts` 的下单路径里用 `Rec` 拼出来的。要从源头标类型就得
   动那个文件,而仓库自己的 lint 配置里写着"为类型去改下单路径,是拿真钱的风险换零收益"。所以排在第 3 段之后。
3. **先拆 `engine.ts`**(本报告第二条的后半:托管单、IB 回调各搬一个文件)。搬完之后盯盘行在一个几百行的文件里,再给它标类型才是低风险的事。

**2026-09-20,`tracker` 域第 1a 段:`tracker.list` / `add` / `update` / `delete` / `target_preview` 迁完(已迁 25 个,还剩 52 个)。**
判据如前所定:`tests/tracker-rpc.spec.ts` 一个断言没改,32 条全绿;`golden-rpc` 没动基线。

- **入参 schema 是 strict 的**,数值字段照界面的真实载荷收 `number | string`(`''` = 不设),两个授权开关只收布尔。对 schema 又做了一轮变异
  (只收数字、用强转、漏列追价上限、漏列键且去掉 strict、漏列尾盘收紧、`update` 漏列 `enabled`),6 个全被特征测试抓住。
- **钱路径上的文件拿编译产物说话**:`Targets` / `AutoClose` / `SpotTarget` 搬进契约、`tracker.ts` 只剩转出;`drawdownThreshold` 对库里读回来的
  JSON 逐项兜底的写法没碰,只给两个局部变量加了类型标注;store 的追踪行收成 `Track` / `TrackInput` / `TrackPatch`。改动前后各编译一次,
  去掉注释逐字节比对,`tracker` / `flyexit` / `store` / `engine` / `broker` / `futuBroker` / `positions` 七个文件一致;`handlers/tracker.js`
  的差异正好是方法表与一处非空检查。`engine.ts` 一行没动。
- **反向验证抓到我自己的一个错。** 第一版只把 `addTracker(spec)` 的参数标成契约类型,还在注释里写了"写错一个键名这里就编译不过"。
  改掉契约里一个键名去验,引擎红了,**界面没红**:`Tracker.tsx` 先拼一个没标类型的变量再传进去,TypeScript 不对变量查多余的键。
  现在那个字面量直接标成 `TrackerAddSpec`,再验一次,界面正好红在拼载荷的那一行。这条写进了 CLAUDE.md。
- **`sensitive` 标记进了契约**(`SENSITIVE_METHODS`),`desktop-whitelist.spec` 拿它和 `main.js` 的 `SENSITIVE_RPC` 双向对;同一份测试钉住了
  一个因为 strict 才变得承重的耦合——`__confirmed` 由主进程在转给引擎之前摘掉。三条新护栏各放探针验过会红。
- 一处顺序上的变化:畸形的入参(比如 `profit_drawdown_tiers` 传了个字符串)以前要先过"连没连券商"那一关,现在在 schema 这一步就被拒,
  码同样是 -32602。联合类型字段的报错补成了人话(「stop_loss 应为 number 或 string,收到 boolean」「缺少 profit_drawdown_tiers.0.pct」)。
- 契约如实记下的现状没变:`tracker.add` 回执里 `enabled` 是数字 `1`;`tracker.update` 的 `auto_close` 是整份替换。
- 顺带看到、没有动的一处:平一半(`close_fraction_pct: 50`)时,那张平仓单的 `notional` 仍按整份持仓算(100 股 × 120 = 12000),
  不是实际平掉的那一半。查过 `engine.ts` 的 `closePosition`:它取的是 `|position.quantity| × 现价 × 乘数`,没看平仓比例;这个数只写进
  交易记录的 `notional_estimate`(给人看的名义金额)——平仓单不过开仓那套限额,所以**不会拦单**,只是分批平仓的记录上名义金额偏大。
  改它要动下单路径上的一个表达式,没有混进这一批。

还没迁的:`positions.list`(第 1b 段,行要从两家券商适配层标起)、`tracker.poll` / `reconcile` / `close_now`(等 `engine.ts` 拆开)。

**2026-09-20,`tracker` 域第 1b 段:`positions.list` 迁完(已迁 26 个,还剩 51 个)。** 持仓行(`contract/positions.ts` 的 `PositionRow`)是从
产出它的三处一路标过来的:两家券商适配层的 `positions()` / `positionRow()`、`tracker.ts` 的 `comboRow` / `withCombos`、handler 里补
`tracked` 与盈亏口径的 `fillPnl`——全是返回值与局部变量的类型标注。判据同 1a:改动前后编译产物去掉注释逐字节比对,`tracker` / `flyexit` /
`store` / `engine` / `broker` / `futuBroker` / `positions` 七个文件一致,`handlers/tracker.js` 只差登记方式和一个没用的参数;`engine.ts`
一行没动;`tracker-rpc.spec` 没改断言。`withCombos` 写成了泛型(`<T>(rows: T[]) => Array<T | PositionRow>`):引擎和测试还在传
松散的行,不用为了这一批去改它们。

验证用的就是本报告第一条开头举的那个例子:把契约里的 `avg_cost` 改名,引擎这头 `broker.ts`、`futuBroker.ts`、`tracker.ts`、handler 与两份测试
同时报错,界面那头 `Tracker.tsx` 报错——当初写的是"四个地方没有一个会报错,只有 `Tracker.tsx` 上的数字变成 NaN"。

`tracker` 域只剩 `tracker.poll` / `reconcile` / `close_now`,等 `engine.ts` 拆开。

**2026-09-20,拆 `engine.ts`:量了耦合、定了方案,没有动手。** `TradingEngine` 是一个共享 `this` 状态的类(2,527 行),按 `this.xxx` 的
双向引用把四块候选量了一遍:

| 块 | 行数 | 类的其余部分怎么用它 | 它用到块外的方法 | 判断 |
|---|---|---|---|---|
| 托管单(`syncHosted` … `hostedOnStatus`) | 457 | 只有 3 个入口:`syncHosted` / `hostedOnError` / `hostedOnStatus` | 6 个:`accountIsPaper` `applySpotTarget` `chaseQuote` `chaseWarnIfStuck` `baseRecord` `onIbError` | **最干净,先搬它**。它的状态(`hosted` / `hostedIndex` / `hostedRetryAt` / `hostedAdopted`)几乎只有它自己用,块外只有 `sweepExisting` 读一次 `hosted`、IB 回调读一次 `hostedIndex` |
| 执行对账(`reconcileOrders` …) | 157 | 3 个入口:`reconcileSoon` / `reconcileDue` / `reconcileOrders` | 1 个:`replayUnmatched` | 第二个搬。和别处共用 `orderIndex` / `finalized` / `seenFills` |
| IB 回调与落库索引 | 250 | `brokerCode` `indexPlacement` `onIbError` `replayUnmatched` | 4 个,其中 2 个是托管单的入口 | 去重表、订单索引和所有人共用,**放到最后**;报告原文说它"边界清晰",量下来不是 |
| 追价平仓 | 138 | 5 个入口,和 `closePosition` / 托管单互相调 | 1 个 | 不单独搬,它是平仓逻辑的一部分 |

测试直接摸的引擎私有成员只有 `indexPlacement` / `autoOutsideRth` / `parser` 三个,搬托管单和执行对账都碰不到它们。

方案(照拆 `rpc.ts` 的办法):`engine/hosted.ts` 里一个 `HostedOrders` 类,构造时拿一个宿主接口(store / router / notifier / settings /
killswitch + 上面那 6 个方法),用基类 getter 把它们摊成 `this.store` 这样的写法,**函数体逐字搬**;引擎保留三个入口做转调。
用脚本按行号切片、每条替换断言命中次数、搬完逐行对账。这一步编译产物不可能逐字节一致(代码换了文件),判据换成:逐行对账 +
`hosted`(11)/ `sweep`(45)/ `tracker-loop` / `reconcile` / `combo-close` / `tracker-rpc` 全绿。

**为什么现在不动手**:到今天为止的 11 笔提交**还没有一笔在真机上走过**——测试按规矩全是离线的,而改动已经落在真应用会走的路径上
(`tracker.add` 前面加了 strict 的 schema、持仓行换了类型、`rpc.ts` 整个拆了)。今天(周日)本机 7496 / 7497 都没开,只读探针连不上。
在没核对过的改动上再叠一层下单路径的重构,以后真机上出了问题,就得在"契约 / 类型"和"引擎重构"两批里二分。顺序应当是:
先合并、在真机上跑一遍 `npm run probe`(只读),再在模拟账户里从真界面建一条追踪、切一次启停、点一次立即平仓——这三下正好走过
`tracker.add` / `update` / `close_now` 与 `__confirmed` 那条承重的耦合;都对,再拆 `engine.ts`,而且单独一个分支。

**2026-09-20,设置域:`settings.get` / `settings.patch` / `keychain.set` / `data.export` 迁完(已迁 30 个,还剩 47 个)。** 不碰 `engine.ts`,
所以不受"先真机核对"那一条阻塞。`llm.*` 留着——它的返回来自 `providers.ts`(模型供应商那一侧,形状由对方定)。

- 界面手抄的那份只抄了一半:引擎的 `Policies` 有 9 个字段、`bridge.ts` 里 3 个;`Limits` 8 个、那边 5 个。现在 `Limits` / `Policies` /
  三条保护规则的配置定义在 `contract/settings.ts`,`config.ts` 与 `protections.ts` 转出,`bridge.ts` 转出(导出名不变)。
- 动手前先探了 `settings.patch` 的现状,因为它改的是「允许自动执行」「允许实盘下单」:担心的是"键名写错 → 我关了自动执行悄悄没生效"。
  结果这个洞引擎自己早就堵了——`config.fromDict` 对每一段都拒绝不认识的键、查类型与范围、给中文原因,校验不过不写盘。所以契约的 schema
  对 `patch` **里面**只确认"是个对象",不再抄一遍校验(两边抄就会走样);顶层照敏感方法的规矩用 strict。这几句原话与"不写盘"钉进了
  `contract.spec`,连同界面原样的三段载荷。
- 判据同前:`config` / `protections` / `engine` / `validator` / `store` 的编译产物去掉注释逐字节一致;`golden-rpc` 没动基线
  (它钉着 `settings.get` 的完整形状与 `settings.patch` 的三种情况)。
- 验证:把契约里的 `auto_execute` 改名,引擎这头 `config.ts`、`engine.ts`、`cli.ts`、三个 handler 同时报错;界面「设置」页读它的两处、
  以及**发补丁的那个对象字面量**都报错。
- `SENSITIVE_METHODS` 加了 `settings.patch` 与 `keychain.set`,和 `main.js` 的双向对账照过。`depcruise` 的 `util-bottom` 放开了
  "util 可以引契约的类型文件"(`protections.ts` 在 util 层)。
- 顺带看到、没有动的一处:`settings.patch` 对**顶层**不认识的段不报错(`{patch: {foo: {a: 1}}}` 会成功,`foo` 被原样写进配置文件)。
  不影响任何行为,只是配置文件里会留垃圾;要堵得先把 `fromDict` 认的顶层键列全,单独一件事。

**2026-09-20,想法域:`ideas.*` 六个方法迁完(已迁 36 个,还剩 41 个)。** 同样不碰 `engine.ts`、不在下单路径上。

- 先补特征测试,再迁。golden-rpc 钉了这个域 10 条请求,但都是没连券商的——`analysis.brief` 恒为 `null`,界面「想法」卡片上
  「行情(代码计算)」「价格锚点」那两行读的键一个都没被钉住。`tests/ideas-rpc.spec.ts`(13 个)用假券商、假模型补上:380 天日线的
  取数区间、情报与锚点的完整形状、标的自愈、行情取不到时的 `{error}`、模型失败不写库、总结的范围 / 顺序 / 喂给模型的原文。
  先在旧代码上跑绿,迁完一个断言没改;变异 12 处(兜底 SPX、锚点取错价、顺序反了、失败也写库、schema 写严了……)12 处全红,
  每一处都断言了"改上了"。
- 形状从源头标过来:`research.symbolBrief` / `resolveAnchor` / `briefText`、`store` 的想法与总结那几个方法、`ideaRow`(库的边界)。
  `store.js` / `research.js` 的编译产物去掉注释逐字节一致。界面 `Ideas.tsx` 里手抄的三个接口删了,从 `bridge.ts` 拿契约类型。
- **基线钉着的"缺字段"原话怎么办**——这一批定下来的做法,后面还会用到。`ideas.update` 不带 id,golden-rpc 钉的是 handler 那句
  「缺少想法 id」;照前几批的分工它该由 schema 报「缺少 id」,但那就是为了迁移去改基线。做法:`schema/kit.ts` 加了
  `requiredButReportedByHandler()`——类型上必填,"没给"解成空串交给 handler 说原话(和老 handler 的 `String(x ?? "")` 同一个结果),
  类型不对照样当场拒;只给基线钉着的字段用。把还没迁的方法过了一遍,基线钉着同类原话的还有:`instruction.submit`(「指令为空」
  「accounts 必须是账户别名数组」)、`screener.inflection`(「timeframes 要是非空数组」「整数参数不合法」)、
  `backtest.parse_rules`(「策略描述为空」)。
- `analysis` / `digest` 是库里的两列 JSON:写的一方要全(少一段编译不过),读的一方标成 `Partial<…>`。
- 验证:契约里改四个字段名(`symbols` / `themes` / `vs_sma200_pct` / `chg_from_anchor_pct`),引擎这头 `research.ts`、`store.ts`、
  handler 共 8 处报错,界面 `Ideas.tsx` 4 处报错(含那张「键 → 中文名」的表)。真进程 stdio 冒烟加了 5 条,36 / 36。
- 这个功能原来没有 feature 文档,补了 `docs/features/ideas.md`:只写被测试钉住的口径,没有另外发挥。

**2026-09-20,回测域:`backtest.strategies` / `run` / `parse_rules` 迁完(已迁 39 个,还剩 38 个)。** 纯计算,不接下单链路。

- 同样先补特征测试:`tests/backtest-rpc.spec.ts`(11 个,假券商 + 假模型)。回测的数值 golden-backtest 钉着,入参报错 golden-rpc 钉着,
  但 `backtest.run` **跑成功**要连券商取日线,基线走不到——回执的完整形状、`instrument` / `rules` 被 `models.ts` 的 schema 补齐之后的样子、
  期权品种每笔多出来的 `exit_reason`、几种失败各报哪个码,原来都没人钉。先在旧代码上跑绿(10 个),迁完断言没改。
- 变异第一轮 11 个漏了 2 个,都看了:一个是变异本身打偏了(回执里的 `instrument` 现在由 handler 显式给,改传给 `runBacktest` 的那份
  不影响回执),换成"回执里放原始入参"后抓住;另一个是**真的缺口**——300 根日线时抽样步长是 1,"曲线最后一个点必在"那条断言恒真。
  补了一条 650 根日线的用例(每 3 根取 1、共 218 个点、首尾必在),第二轮 11 / 11。这一条是迁完之后才加的:它断言的 `bars` 与 `curve`
  都出自 `backtest.ts`,而 `backtest.js` 的编译产物去掉注释与迁移前逐字节一致,所以它在旧代码上同样成立。
- `requiredButReportedByHandler()` 第二次用上,而且多了一种情形:基线里 `backtest.run` 有一条**只带一个坏代码**的请求,期望「股票代码不合法」。
  handler 先查代码、再查日期;`start` / `end` / `strategy` 要是在 schema 里必填,这一条就成了「缺少 start」。检查的先后次序也是被钉住的行为。
  `kit.ts` 的注释、CLAUDE.md、`engine-rpc.md` 都按这个改了。
- 发过去的样子和回来的样子是两个类型:`RuleOperandInput`(搭建器拼的,用不上的键不带、数字可以是数字串)与 `RuleOperand`
  (过了 `CustomRulesSchema`,补齐成 `null`);后者能赋给前者,「一句话生成」的结果可以直接放进搭建器。`rules` / `instrument` 另有校验者,
  在 handler 眼里是 `unknown`(`BacktestRunParams`),界面用写全了形状的 `BacktestRunSpec`,那个载荷字面量直接标了类型。
- `runBacktest` 的产出里 `rules` / `instrument` / `symbol` 是一层层补上去的,在 `BacktestReport` 里可选;RPC 的回执 `BacktestRunResult`
  把后两样收成必有。handler 末尾从"往结果上写一个 `symbol`"改成了 `{ ...report, instrument, symbol }`(键的顺序不变、内容相同)——
  这是本批唯一一处运行时代码的改写。券商适配层的日线进 `runBacktest` 时仍有一处边界断言(`historicalBars` 的返回类型还是松的)。
- 界面 `Backtest.tsx` 的结果原来是 `useState<any>`、交易表是 `any[]`;现在对着契约。反向验证:契约里改五个字段名,引擎 7 处
  (`backtest.ts` 5、handler 2)、界面 7 处(含拼载荷的那一行)编译不过。真进程 stdio 冒烟加了 4 条,40 / 40。
- 没做:回测没有 feature 文档(口径在 `backtest.ts` 的文件头与 golden-backtest 里),这次没有补。

**2026-09-20,盘口与行情带:`book.snapshot` / `macro.board` 迁完(已迁 41 个,还剩 36 个)。** 两样都只读,不碰 `engine.ts`。

- 特征测试 `tests/market-rpc.spec.ts`(9 个)。这一份和前几批不同的地方:**它把全局 `fetch` 换成了假的**。宏观行情带在没连券商时
  会去打公开数据源,而 `tests/` 必须离线;假 fetch 只认登记过的 URL,别的一律抛——谁把网络打开了,红的是"这个 URL 没登记",
  而不是变成一条看天气的用例。行情带自己的双来源与降级仍由 `unit-side.spec` 用注入的 fetcher 钉着,这里钉的是**从 RPC 进来这一段**。
- 变异 11 处:第一轮漏了"schema 把 force 收紧成只认布尔"——`contract.spec` 里有纯 schema 的断言,但 RPC 这一层没走过它。
  补了一条能看见 force 效果的用例(不给 force 吃缓存、给了重取,而且故意给个真值字符串),第二轮 11 / 11。
- 类型从源头标过来:`BookSnapshot` 标在两家适配层的 `orderBook` 与共用的 `bookLiquidity` 上,`MacroRow` 标在 `macro.ts` 上。
  `broker` / `futuBroker` / `macro` / `engine` / `tracker` / `store` / `flyexit` 七个文件的编译产物去掉注释逐字节一致。
- `MacroRow` 分成两层:取数阶段的 `MacroRowData` 没有 `source`(取数的人不知道自己被哪条路调用),`macroBoard` 最后填。
  同 `PositionRow` / `BacktestReport`。另外照出一件事:`macro.ts` 的那张缓存表是**两种形状共用**的——行情带存整格,
  `publicIndexPrice`(速记解析要现价时走的那条)只存一个价,靠 `"cboe:"` 前缀分开键。类型如实写成联合,取整格的地方一处断言。
- `futuBroker.orderBook` 里有四处 `out["bids"][0]["price"]` 这样的下标访问,同一行的 `.length` 就是守卫,但编译器看不穿。
  用了 `!`——`?? 兜底` 会改掉编译产物,而这一批要的就是逐字节一致。CLAUDE.md 的"不要用 `!` 绕过"针对的是没有守卫的情况。
- 界面:`store/macro.ts` 手抄的 `MacroRow` 换成契约的转出(手抄那份的 `instrument` 少了 `| null` 那一半);`Market.tsx` 的盘口
  从 `any` 收成 `BookSnapshot`。盘口墙每格要么是盘口、要么是读取失败那一句,类型写成联合,两处判断从 `.error` 改成 `'error' in cell`;
  `BookBody` 里 `snapshot.l1 || {}` 的兜底去掉了(契约保证有)——这是界面这头唯一两处运行时改动。
- 反向验证:契约里改五个字段名,引擎 18 处、界面 9 处(含顶栏 `MacroStrip.tsx`)编译不过。真进程 stdio 冒烟加了 3 条,43 / 43。
- **一处现状,钉住了没改**:券商的流式报价抛异常时,**整条 `macro.board` 报错**,而不是这一轮降级到公开源。`macroBoard` 自己是
  防住了的(它对 `router.streamQuotes` 包了 try/catch,注释写着"行情带永远不该把界面搞崩"),但 handler 为了把异步的
  `streamQuotes` 摊平成 `macroBoard` 要的同步面,在外面先 `await` 了一次,那一次没有护栏。界面这头 `loadMacroBoard` 会 catch 掉、
  只 `console.warn`,所以看到的是"行情带不再更新",不是白屏。要堵就是把 handler 那次 await 包起来、失败时按"没有流式报价"往下走
  ——一行的事,但它是改行为,留给人定夺。
- `book.snapshot` 不带 symbol 这一句改了:原来是 handler 的「股票代码不合法:'undefined'」,golden-rpc 没钉它,按"缺必填字段归
  schema 报"的规矩换成了「book.snapshot 的参数不对:缺少 symbol」(同域已迁的 quality.add / alerts.create 都是这样)。
  界面的 preload 永远带 symbol,走不到这条。**这是本批唯一一处刻意改掉的文案。**

**2026-09-20,用户定了:"按你的意见办"——前面各批记下、留待定夺的现状逐条落实。** 每一处单独一笔提交、带测试;`engine.ts` 仍然不动
(真机核对之前不在下单路径上叠改动,这一条也是意见之一),所以"分批平仓记录的名义金额按整仓算"那一处顺延到拆 `engine.ts` 的分支。

- `macro.board`:券商的流式报价抛异常时,这一轮降级到公开源,不再整条报错。handler 里那次没有护栏的 `await` 包上了。
- `settings.patch`:顶层只认契约里写着的三段(`policies` / `limits` / `protections`)。原来 `{foo: {…}}` 会成功并被原样写进配置文件;落实时又看到更要紧的一面——`{llm: {…}}` 能绕过 `llm.patch` 的字段白名单(改 `keychain_service`),`{storage: {db_path}}` 能从界面通道换库。现在都当场拒,一个字不写盘。调用方只有「设置」页,发的就是这三段;golden-rpc 钉的三条不受影响。
- 新建回执里的 `enabled`:`alerts.create` / `tracker.add` 从数字 `1` 统一成 `true`(和列表、和读库那道转换一个口径),契约类型从 `boolean | 0 | 1` 收成 `boolean`。全量测试里只红了 golden-rpc 第 63 步这一条,`golden:update` 的 diff 恰好一行;`tracker-rpc.spec` 那条断言随之改了并写明缘由。引擎与界面里没有任何地方拿它和 `1` 做比较(grep 过)。优质股那张表没动:它两头一直都是 `0 | 1`,自洽。
- `tracker.update` 的 `auto_close`:从整份替换改成合并。落实时把隐患看具体了:只改一个 `close_fraction_pct`,库里那份就只剩这一个键,读的那一头补默认值——限价平仓悄悄变回市价、托管被关掉。界面只用 `update` 切启停,所以真应用里行为不变;`tracker-rpc.spec` 里那条写着"谁要改这个行为,得是有意的"的用例改成钉新行为。我自己在测试里先假设了"给 `null` = 这一项不动",跑出来不是:strict schema 对 `auto_close` 里面的键不收 `null`,当场拒——注释和用例都按实际改了。
- **顺延的一处**:分批平仓记录的名义金额按整仓算(`engine.ts` 的 `closePosition`)。它只影响记录里的 `notional_estimate`、不影响发出去的单,而 `engine.ts` 在真机核对之前不动,所以留到拆 `engine.ts` 的那个分支一起改。
- **合进 main 了**:`main` 从 `38adb2d` 快进到 `1649e31`(本分支 + `claude/gifted-mcclintock-850a7f` 的 keychain 测试时限修复,后者用真合并,
  免得它一直显示"未合并")。合之前两头全量检查、真进程冒烟 43 / 43。**没有推送。**
- **只读探针还没跑成**:2026-09-20(周日)15:25 本机 7496 / 7497 都没在听;4001 在听,但它不在配置的连接里,没有去连。
  等 TWS 开着:`cd engine-ts && npm run probe`;然后在**模拟账户**里从真界面建一条追踪、切一次启停、点一次立即平仓
  (走过 `tracker.add` / `update` / `close_now` 与 `__confirmed` 那条承重的耦合)。这一步要人来点——会发单的操作不由助手代做,模拟账户也一样。
  都对了,再开分支拆 `engine.ts`。

**2026-09-20,大模型接入:`llm.catalog` / `llm.patch` / `llm.test` 迁完(已迁 44 个,还剩 33 个)。** 设置域到此全部在契约里。
之前把它往后放,理由是"返回来自 `providers.ts`,形状由对方定"——看下来不对:由对方定的只有 `usage` 里的数值,目录、当前配置、
测试回执的形状都是我们自己的。

- 特征测试 `tests/llm-rpc.spec.ts`(8 个)。`llm.test` 从来没被钉过,因为它要真打一次请求;这里起一个本机 http 服务当端点
  (127.0.0.1,同 `provider-http.spec` 的办法),连通 / 401 / 端点关着三条路都走:带一把没保存的 key 先试时用的就是那一把、
  试一下不等于保存、测不通是 `ok: false` 的回执而不是 RPC 报错、报错里不回显 key。不读也不写系统凭证库里的任何密钥。
  我自己先写错了两处(事件回调收的是整行 JSON 而不是 `(event, payload)`;假 key 里放了中文,HTTP 头不收),都是测试的错,不是引擎的。
- 变异 9 处 9 处全红。最值得留意的一条:**schema 漏列 `api_key`**——`llm.test` 不是 strict 的,zod 会把没列的键静默丢掉,
  那把没保存的 key 就被无声忽略、改用凭证库里的旧 key 去测,界面上看到的是"连通",测的却不是用户刚填的那一把。特征测试抓得住。
- `LLMConfig` 的定义搬进 `contract/llm.ts`,`config.ts` 转出(同 `Limits` / `Policies`);`PROVIDERS` / `providerCatalog` / 两个解析器的
  `test()` 标成契约类型。测试回执写成按 `ok` 区分的联合;`usage` 的数值在"对方回包"的边界上认成 `LlmUsage`(两处断言,都在
  `providers.ts`——那本来就是允许回包结构松的四个文件之一)。`config.js` / `providers.js` 编译产物去掉注释逐字节一致。
- `llm.patch` 顶层 strict、登记进 `SENSITIVE_METHODS`(`main.js` 那头本来就有,双向对账过了);`llm` **里面**不在 schema 校验——
  哪几项能改由 handler 的白名单说(「不允许修改的字段:bogus」,golden-rpc 钉着),同 `settings.patch` 的处理。
- 界面:`store/llm.ts` 手抄的三个接口换成契约转出(手抄那份字段全标成可选,还少了 `key_hint` 与 `keychain_*`);`Access.tsx` 的
  `collect()` 直接标成 `LlmPatch`,测试结果的 state 从 `any` 收成"回执 | 正在测"的联合、渲染处按 `'pending' in` / `ok` 收窄。
  测试失败时界面自己拼的那张卡补上了 `provider` / `model` 两项(联合类型要求的)。
- 反向验证:契约改四个字段名,引擎 14 处、界面 7 处(含交易页就绪清单读 `key_configured` 的那一处)编译不过。真进程冒烟 46 / 46。

**2026-09-20,扫描器:`screener.rs` / `inflection` / `deviation` 迁完(已迁 47 个,还剩 30 个)。** 纯计算,只读,不碰 `engine.ts`。

- 特征测试 `tests/screener-rpc.spec.ts`(14 个)。算法那一半 golden-screener 钉着,但**跑成功**那条路要连券商拉 K 线,
  基线走不到:池子怎么取(单个板块 / 全部并集 / 同一只去重)、某只拉不到 K 线时那一行降级而不是整次失败、日内 40 个的上限、
  以及回执里界面读的每一个键,原来都没人钉。
- **变异第一轮 12 个漏了 2 个,两个都是我的测试太松**,不是引擎的问题:
  · "不给 ma_period 也编一个确认状态"没抓住——我的假数据**根本没产出背离信号**,那条 `confirm 是 null` 的断言是空过的。
  · "极值判定反了"没抓住——我只断言了 `extreme` 在三个取值之内。
  补了两组确定性的数据:一组价格创新低而 DIF 抬高(稳定出底背离,且站回 20 日线 → confirmed),一组尾部急涨 6 根(z 冲到 3.97 → 超买),
  再断言 `extreme_label` 与 `extreme` 的对应。第二轮 12 / 12。**"变异全红"只有在假数据真的走到那条分支时才说明问题。**
- 类型从源头标过来:`rsStrength` / `screenInflections` / `deviationReview` 的返回标成 `Omit<…, "sector" | "fetched_at">`
  ——handler 最后补的那两项(`deviation` 是三项)在算的时候还不知道,同 `MacroRowData` / `BacktestReport` 的分层。
  handler 里三处 `result["x"] = …` 改成了展开新对象(这是本批仅有的运行时改写,键序与内容不变)。`screener.js` 编译产物去掉注释逐字节一致。
- 照出一处两段形状:`confirmation()` 内部给的 `at` 是**下标**,`cdDivergence` 再把它换成那一根的时间才交出去。
  契约里 `CdConfirm.at` 是时间字符串,内部那一段单起一个 `ConfirmByIndex`,交界处认一次。
- 枚举型的字段就写成联合:`signal: "bull" | "bear" | null`、`dif_side`、`extreme`。`per_timeframe` 的键和 `signal` 同名,
  计数时直接拿它当键(`Record<"bull" | "bear" | "confirmed", number>`)。
- 界面:`Screener.tsx` 的 `rs` / `infl` / `result` 三个 state 从 `any` 收成契约类型;`ScanRow` 改成 `Omit<RsRow, "company"> & { infl?: InflectionRow }`;
  背离还没回来时的占位写成联合(`InflPending`,同 `llm.test` 的做法),判断从 `infl.pending` 改成一个 `isPending` 守卫。
- 反向验证:契约改四个字段名,引擎 6 处、界面 6 处编译不过。真进程 stdio 冒烟加了 4 条,50 / 50。

**2026-09-20,K 线 PA:`pa.timeframes` / `pa.analyze` / `pa.comment` 迁完(已迁 50 个,还剩 27 个)。** 行情页那一整块到此都在契约里。
这是迄今形状最大的一批:一次分析的回执有 37 个键、十几个子结构。

- 特征测试 `tests/pa-rpc.spec.ts`(11 个)。算法那半 golden-analysis 钉着,但跑成功要连券商;这里钉的是从 RPC 进来这一段:
  回执的完整键集、高周期背景拿不到时 `htf` 置空而不毁掉整次分析、K 线缓存的 `cached` 标记、`pa.comment` 把哪些事实交给模型。
  我先写错了两处预期(漏了 `age_seconds` / `sweeps`,htf 摘要的键也记少了),跑出来按实际改准——**预期是读代码猜的,就得让测试来纠**。
- 照出一条以前没写下来的口径:**`force` 压不过 15 秒的最小重取间隔**(那是 IBKR 判超频的线,不是性能优化)。
  我原本以为 force 会立刻重拉,测出来不是;钉住了现状并写进契约注释。
- 变异 11 处:第一轮漏 2 个。一个是我的断言太松(`rth` 在 RPC 层没走过非布尔值),补上;另一个 `if (htfKey || true)` 追下去是
  **等价变异**——1d 时 `htfKey` 是 null,多走的那一次会在 `paBars` 里抛掉、被 catch 吞了,外部看不出差别,换成"给日线硬安一个高周期"才有观察点。
  第二轮 11 / 11。**漏网要先分清是测试弱、还是那个变异根本改不出行为。**
- 类型从源头标过来:`analyze` / `marketContext` / `makePlan` 都是"一路往上加"的(最后几项要等前面算完),所以内部保持松、
  返回处认一次——同 `MacroRowData` 那一批的处理。`priceaction.js` 编译产物去掉注释逐字节一致。
- 两处契约写错、被编译器纠回来的:`evidence` 是"哪一项、什么情况、加减多少分"的条目,不是一句话;`plan.watch` 是一串中文句子,
  不是对象数组。`factsText` 会读 `htf` / `agreement`(handler 补的),但黄金对拍直接拿一份分析调它,所以入参写成
  `PaAnalysis & Partial<Pick<PaAnalyzeResult, "htf" | "agreement">>`。
- 界面:`Market.tsx` 的 `data` / `comment` 两个 state 与六处 `: any` 回调参数收成契约类型。
- 反向验证:契约改四个字段名,引擎 12 处、界面 6 处编译不过。真进程 stdio 冒烟加了 4 条,54 / 54。

**2026-09-20,交易分析:`review.candidates` / `review.analyze` 迁完(已迁 52 个,还剩 25 个)。** 只依赖分析层与 store,不碰 `engine.ts`。

- 这个域原本就有测试(`stockreview.spec`),但那一份调的是 `domains.review.*`,**绕过了入参这一段**。新的 `tests/review-rpc.spec.ts`(6 个)
  走完整的 `handle()`:候选行的完整键集、没连券商时的降级(`synced` 是 null 而不是 0)、`limit` 截断、几句报错的码与原话。
- 我先写错了三处预期(回执的键以为是 `connected`,其实是 `synced` / `ibkr_available` / `fills_stored`;股票复盘的回执里没有 `timeframe`
  只有 `timeframe_label`),跑出来按实际改准。
- 变异 10 处:第一轮漏 3 个。一个是变异点写错了行(没命中,脚本当场抛——这正是"命中次数要断言"的用处);
  另外两个是断言太松(候选行的 `carried` 没断言、`exit` 在 RPC 层没走过非对象值)。补齐后 10 / 10。
- **这一批的类型比前几批深**:界面读到了分析块里的具体字段,所以 `profile` / `entry` / `outcome` / `stats` / `zone` / `series` /
  `exit_plan` 都按实际逐项写了出来,没有留成 `Record<string, unknown>`——留成松的,界面那头就得继续 `any`,等于白迁。
  两类复盘写成按 `kind` 分的联合(蝴蝶那支 `kind?: undefined`,界面按它分流)。
- 照出两处形状:`mae` / `mfe` 不是数字而是"每股多少、占成本几个点、一共多少钱、当时的价与时刻"五项;
  `fly_series`(蝴蝶自己那条价的分钟线)是 handler 补的,不在 `tradereview.review` 的返回里。
- 界面 `Review.tsx` 的 `data` 与七个 `: any` 组件参数收成契约类型;`r.exit_plan || {}` 这种"兜成空对象"的写法改成可选链——
  兜空对象会把类型冲成 `{}`,等于把刚标好的类型又丢掉。
- 反向验证:契约改四个字段名,引擎 2 处、界面 8 处编译不过。真进程 stdio 冒烟加了 3 条,57 / 57。

**2026-09-20,连接域:`broker.*` / `tws.*` / `futu.*` 十二个方法迁完(已迁 64 个,还剩 13 个)。** 一次迁完最大的一批。

- 先纠一个我自己的归类错误:上一轮把这个域写成"能迁,但要真机核对"。**迁类型是离线工作**,要真机的是整条分支合并前的核对,
  两件事不该混为一谈。
- 特征测试 `tests/connection-rpc.spec.ts`(14 个)。这一份的难处是**怎么在不碰本机的前提下测碰本机的代码**:
  · `scanPorts` / `diagnose` 本来就收一个探测器参数 → mock 只换最外面那层、转调真实现并注入假探测器,端口表怎么拼、
    诊断失败怎么降级,走的还是生产代码。
  · 第一版直接 mock `probePort`,**没用**:模块内部对它的引用不会被换(默认参数在定义时就绑好了),真探测照跑,
    本机此刻开着什么(4001 正开着)就渗进了断言。跑出来才发现。
- **变异验证里出了一件值得记的事**:"去掉 md5 校验"那条变异让 `futu.set_password` **真往凭证库写了一条**,
  于是下一次跑 `unlock_password_saved` 成了 true——一条留在机器上的残留让后面的测试假通过。
  幸好那一步已经把凭证库的服务名换成了测试专用的(默认那个是真应用在用的名字,查它等于读用户机器上存没存密码),
  清掉那条就行;测试现在前后各删一次。**变异可以有仓库之外的副作用,清理要写进测试本身。**
- 另外两处漏网也各有由来:诊断的降级分支要"诊断这一步自己抛了"才走得到(mock 里加了一条会炸的连接);
  拉起程序那道闸门被我的 mock 整个盖住了,测的是 mock 不是生产代码——改成直接对 `vi.importActual` 拿到的真函数断言
  (真函数在键不对时**先抛、后展开路径**,所以这么试不会拉起任何东西)。补齐后 12 / 12。
- 类型从源头标过来:`tws.ts` / `futu.ts` 的 `scanPorts` / `scanEndpoints` / `detectApps` / `launchApp` / `connectionGuide` /
  `checkAliasMapping`,以及 `futuBroker.unlock`。这五个文件的编译产物去掉注释逐字节一致。
- 界面 `Access.tsx` 手抄的 `Port` / `App` / `GuideStep` 换成契约转出(手抄那份把 `error` / `configured_as` 写成了可选,
  引擎给的其实是「有值或 null」);五处 `any` state 与两处回调参数收成契约类型。
- 诊断那一格的类型如实分两层:`diagnose()` 自己一定给全,但**它整个抛了**的时候 handler 只补得出四项,所以其余字段可选。
  富途的账户核对多 `trd_env` / `env_matches` 两项(is_paper 写反不会报错,只会让实盘闸门失效)。
- 五个会动配置 / 动密钥 / 拉外部程序的方法(`broker.connect` / `broker.select` / `tws.launch` / `futu.launch` /
  `futu.unlock` / `futu.set_password`)登记进 `SENSITIVE_METHODS`,与 `main.js` 双向对账过。
- 反向验证:契约改四个字段名,引擎 7 处、界面 11 处编译不过。真进程 stdio 冒烟加了 5 条,62 / 62。

**2026-09-20,拆 `engine.ts` 第一步:托管单整块搬进 `engine/hosted.ts`。** 2,527 行 → 2,072 行。

- 之前写着"先真机核对再拆"。那是我自己的稳妥判断(别在没核对过的改动上再叠一层下单路径的重构),**不是硬阻塞**:
  拆分本身可以离线验证。用户说继续,于是在单独分支 `claude/split-engine-hosted-orders` 上动手。
- 办法同 2026-09-19 拆 `rpc.ts`:按行号切片、**函数体逐字搬**、每处替换断言命中次数、搬完逐行对账。
  对账结果:**456 行里 452 行逐字未动,4 行只改了名**(两个入口改成公开名、一张静态表的引用改成本类),零处其他差异。
- `HostedOrders` 自己管四样状态(hosted / hostedIndex / hostedRetryAt / hostedAdopted),别的一律从宿主现取
  (store / router / notifier / settings / killswitch / orderIndex / earlyOrderErrors + 6 个方法)——同 `services/` 的规矩。
  引擎那头留下的接口只有四个小窗口:`syncHosted`、`onStatus`、`handleError`、`tpEntry`,外加熔断时的 `clear`。
- 判据(编译产物这次不可能逐字节一致,代码换了文件):逐行对账 + `hosted`(11)/ `sweep`(45)/ `tracker-loop` /
  `reconcile` / `combo-close` / `tracker-rpc` / `spot-target` 七套 200 个用例全绿,再跑全量 1,156 个全绿,真进程冒烟 62 / 62。
- 两处顺带的处理:
  · `nowIsoSecondsEt` 两边都要用,提成 `engine/clock.ts`(函数体一字未改)。
  · 新文件要那份松散的 `Rec`。**没有**往 eslint 的豁免表里加名字(那张表只许变短)——改成从 `store.ts` 转出它已有的那一份。
    先试过从 `services/host.ts` 引,depcruise 当场报环(它反过来引 `engine.ts`),换成 `store.ts` 才干净。
- `engine/*.ts` 归进 depcruise 的 orchestrate 层,CLAUDE.md 的分层表与体积预算同步。
- **仍然没在真机上走过**:这一步和前面那些一样,合并前要跑 `npm run probe`,并在模拟账户里从真界面走一遍追踪的建 / 改 / 平。
  托管单这一块尤其要看:它挂的是券商侧的真单。

**2026-09-20,拆 `engine.ts` 第二步:执行对账搬进 `engine/reconcile.ts`。** 2,072 行 → 1,932 行。

- 同一套办法。对账结果:**157 行里 152 行逐字未动,5 行只改了静态成员的引用**(`TradingEngine.RECONCILE_*` → `Reconciler.*`),零处其他差异。
- `Reconciler` 自己只管一样状态(上次对账的时刻);store / notifier / router / orderIndex / finalized / seenFills /
  pendingTriggers 与 `replayUnmatched` 从宿主现取。引擎那头留三个转调:`reconcileSoon` / `reconcileDue` / `reconcileOrders`。
- 全量 1,156 个用例全绿,冒烟 62 / 62。

**2026-09-20,拆 `engine.ts` 第三步:券商回报落库搬进 `engine/callbacks.ts`。** 1,932 行 → 1,782 行(自 2,527 行起,少了 745 行 / 29%)。

- 三块里最纠缠的一块,所以放在最后:它和引擎共用五本账(`orderIndex` / `finalized` / `seenFills` /
  `seenCommissions` / `unmatchedEvents`),前两块没有这个问题。
- **缝划在"回报进来之后怎么落库"**:`onIbError` / `onOrderStatus` / `onExecDetails` / `onCommission` /
  `replayUnmatched` / `stashUnmatched` 与那四张码表(终态映射、信息码区间、订单级警告码、行情订阅错误码)搬走;
  **怎么把回调挂上去**(`wireSession` / `attachListeners`)、以及下单侧的 `indexPlacement` / `brokerCode` /
  `syncBrokerOrders` 留在 `engine.ts`——挂回调是会话生命周期的事,不是落库的事。
- 对账结果:**177 行里 172 行逐字未动,5 行只改了静态成员的引用**(`TradingEngine.TERMINAL_IB_STATUS` 等
  → `IbCallbacks.*`)。engine.ts 那头另有 7 行只去掉了 `private`(见下),零处其他差异。
- 账共用,所以宿主接口比前两块宽:五本账 + `earlyOrderErrors` + `store` / `notifier`,外加托管单与追价平仓
  那两路的入口(`hostedOrders` 的 `handleError` / `onStatus`、`closeChaseIndex`、`closeChaseOnStatus`)。
  托管单那一路**没有**直接引 `HostedOrders`:本地写一个只有两只手的 `CallbackHostedOrders`,两块互不认识。
  `closeChaseIndex` 在接口里声明成 `ReadonlyMap`——回报只看一眼在不在,改是下单侧的事。
- 为此 `engine.ts` 有 7 处去掉了 `private`(`unmatchedEvents` / `seenCommissions` / `hostedOrders` /
  `closeChaseIndex` / `closeChaseOnStatus`,都写明了"给谁看")。`private` 只在编译期存在,发出来的 JS 一字不变。
- 全量 1,156 个用例全绿(含 `ib-events` / `ib-exec-time` / `combo-close` 这几套专门钉回报落库的),冒烟 62 / 62,
  depcruise 零 error。
- **`engine.ts` 仍有 1,782 行,超 1,500 的预算。** 剩下的是三块:下单与审批、追踪循环、IB 会话装配。
  下一刀该切哪儿要另外判断——这三块和"钱路径"贴得更紧,不该顺手做。

**2026-09-20,`system.*` 与 `breaker.*` 五个方法迁进契约(已迁 69 个,还剩 8 个)。** 状态条和那颗红按钮。

- 这五样一直钉在 LEGACY 名单上,却是界面刷得最勤的一份(状态条每隔几秒问一次 `system.status`)。
  特征测试 `tests/system-rpc.spec.ts`(17 个)先于迁移写成、在**老代码上跑绿**,迁的时候不改断言。
- 写的时候有三处我"照着代码猜"猜错了,跑出来才知道:`protocol` 是串不是数字;没合闸时 `reason` / `at` 是
  **空串不是 null**;撤单的方法叫 `cancelAllOpen`。三处都按真实行为改了测试,没去改代码迁就测试。
- **变异验证 8 个种子,抓住 7 个。** 逃掉的那个要写清楚:把 `[...text].length` 换成 `text.length`——
  两者只在代理对(emoji、扩展 B 区)上分家,而现有九版提示词一个代理对都没有(逐版数过:UTF-16 长度与码点数
  完全相等),所以它是个**等价变异**,不是断言太松。这一条写进了测试的注释里。
  另外两个一开始也逃了,但那是真问题:锁那条断言写成了"两件事都跑完了"(顺序没钉住),`index_spot`
  那条的测试配置只挂了一个指数(空值分支根本走不到)。改成断言调用顺序、配置里加第二个指数,两个都抓住了。
- 上游两处返回类型太松,顺手从源头收紧:`protectionsSummary` 的 `Record<string, unknown>` → `ProtectionsSummary`,
  `engine.trackerHeartbeat` 的 `Rec` → `TrackerHeartbeat`。`engine.ts` 在钱路径上,按规矩前后各编译一次,
  `dist/src/engine.js` 与 `protections.js` **逐字节一致**。
- 界面那边手抄的 `Status` / `Selftest` / `BreakerState` / `ProtectionsStatus` 换成契约转出。手抄那份带着
  `[key: string]: unknown` 的口子(写错字段名编译期查不出来),换完口子就没了,而且**一处都没改坏**——
  说明契约把界面实际读的字段都覆盖到了。
- `breaker.halt` **不进** `SENSITIVE_METHODS`:它是撤全部单的安全动作,菜单和快捷键都能直接按,
  要求界面先确认一次反而不对。这是原来就有的决定,迁移不改它(与 `main.js` 的 `SENSITIVE_RPC` 一致)。
- 反向验证:契约改一个字段名,引擎与界面各自编译不过。真进程 stdio 冒烟加了 8 条,70 / 70。

**2026-09-20,`records.*` 与 `pending.*` 四个方法迁进契约(已迁 73 个,还剩 4 个)。** 记录页、订单看板、条件单队列。

- 特征测试 `tests/records-rpc.spec.ts`(19 个),同样先于迁移写成、在老代码上跑绿。这一份要钉住的头一件事是
  **两条路给的形状不一样**:`records.list` 给 20 项的摘要(值是从嵌套结构里摘出来的),`records.get` 给整条记录。
  迁移最容易犯的错就是把这两样写成同一个类型。
- 第二件是**真账号一个字都不能漏**:两条路都断言 `JSON.stringify(结果)` 里不含真账号。打码是前二后三(`U1***567`)。
- 写夹具时踩了三处,都是"照着代码猜"猜不出来的:`approved.order` 自己还套着 `contract` 与 `order`
  (`expirePending` 读 `order.order.tif`);排队单的 `record_id` 必须是库里真有的一条(过期那一步要写 final_status,
  库上有外键);**时钟不钉住这一套就看星期几**——`expirePending` 只在休市时干活,当天是周六,全都走进了过期分支。
  时钟现在钉在 2026-09-16(周三)ET 11:00。
- **变异验证 9 个种子,抓住 8 个**(第一轮只抓住 6 个)。三个逃掉的各有各的由来:
  · 默认条数 30 改成 10——测试只放了 3 条记录,分不出来。改成放 31 条。
  · 队列空时不再同步券商回报——原断言只看 `"synced" in out`,改成数券商那只手被问了几次。
  · `{ ...record }` 改成 `record`——**这个是等价变异**:拦住回写的其实是库每次现解析一份
    (`getRecord` 读 `record_json` 再 `JSON.parse`),不是 handler 里那个展开。展开是防御深度,不是护栏,
    如实写进了测试注释,免得下一个人以为它在挡什么。
- 界面两个 store 里手抄的 `RecordSummary` / `PendingItem` 换成契约转出,两处 `[key: string]: unknown` 的口子一起去掉。
- 反向验证:契约改一个字段名,引擎 1 处、界面 1 处编译不过。真进程冒烟加了 7 条,77 / 77。
- 跑全量时 `tests/provider-http.spec.ts` 偶发红过一次(起真 HTTP 服务 + SDK 自带重试,全量并发下对时序敏感),
  之后单独跑 5 次、全量跑 2 次都绿。与本次改动无关(这条路一个字没动),另开一件事去修。

**2026-09-20,盯盘三样 `tracker.poll` / `reconcile` / `close_now` 迁进契约(已迁 76 个,还剩 1 个)。**
这三样都在**钱路径**上:poll 会发平仓单、reconcile 会挂/改/撤券商侧的真单、close_now 直接发一张平仓单。

- 上一轮写"等 `engine.ts` 拆开再标类型",现在拆开了:`pollTrackers` 与 `syncHosted` 的返回各自成型
  (`TrackerPollTick` / `TrackerSyncHostedTick`),RPC 再给它们加一份心跳。
- `tracker.close_now` 的入参 schema 是 **strict** 的,并登记进 `SENSITIVE_METHODS`(和 `main.js` 的
  `SENSITIVE_RPC` 双向对过)。`tests/tracker-rpc.spec.ts` 拿界面原样载荷钉着这个域,**一个断言都没改**就绿了
  ——这是判据本身:strict schema 没有把界面真实发的东西拒掉。
- **中途发现一件要紧的事:一开始我在 handler 里写了 `as unknown as …` 把返回强转成契约类型。
  反向验证当场露馅——契约改一个字段名,只有界面编译不过,引擎这头照过。** 强转等于把契约在引擎那一侧关掉了。
  改成从源头标类型(`engine.pollTrackers` / `engine.syncHosted` / `engine.closePosition` 的返回),
  再验一次:引擎 2 处、界面 1 处一起红。**迁移里出现 `as unknown as` 就该当成信号:那一侧没被契约管住。**
- 有四处是**界面手抄的那份比我写的准**,按界面改了契约:`max_ms` 从 0 起只增、不是可空;`last_error` 没出错是空串、
  不是 null;追价的 `limit` 可以是 null;盯盘那一行**整条追踪一定在**(两条路径都是 `{ ...track, … }`),
  写成 `Partial<Track>` 是我想当然。真进程冒烟把前两样也当场印了出来(`max_ms: 0`、`last_error: ""`)。
- 另有两处是**我漏了字段**,按引擎实际产出补上:被拦下的那条带 `reason`,发出去的那条带 `record_id` / `order_id`。
- `engine.ts` / `engine/hosted.ts` 在钱路径上:改动前后各编译一次,`hosted.js` 逐字节一致,
  `engine.js` 只多了一行注释(**去掉注释后逐字节一致**)。
- 引擎 1,192 个用例全绿,真进程冒烟加了 4 条,81 / 81。

**2026-09-20,`instruction.submit` 迁进契约。契约迁移到此完成:77 / 77,`LEGACY_METHODS` 空了。**

- 最后一个,也是最要紧的一个:它是"一句话 → 解析 → 校验 → 发单"的整条路。回执按**四个桶**分
  (发了的 / 排队的 / 只校验的 / 被拒的),一条指令可以同时落进几个桶——勾了两个账户就是两份,
  一个成一个被拒是常事,所以四个都是数组,不是"要么成功要么失败"。
- 入参 schema 顶层 **strict**,并登记进 `SENSITIVE_METHODS`。
- **黄金基线当场红了一条,而且红得对。** golden-rpc 钉着:`accounts` 传一个字符串时报的是 handler 那句
  「accounts 必须是账户别名数组」。我把 schema 写成了 `z.array(...)`,于是这句话被 schema 抢过去说成了结构错。
  按规矩**改代码不改基线**:`accounts` 在 schema 里收成 `z.unknown()`,是不是数组、每项是不是字符串、
  别名在不在表里,整条都归 handler。这正是「schema 不要比老 handler 严」那条规矩的一个活例子。
- 反向验证又一次逼出了真问题:第一版界面那头 `ResultCards({ payload }: { payload: any })`,
  契约改字段名只有引擎红。把它标成契约类型之后两头一起红。
  **`any` 和 `as unknown as` 是同一种东西:在哪一侧出现,契约就在哪一侧失效。**
- 界面那份 `__elapsedMs` 留在界面:它是界面自己量的墙钟耗时,不是引擎给的,所以不进契约,
  在 store 里写成 `InstructionSubmitResult & { __elapsedMs?: number }`。
- 引擎 1,192 个用例全绿(含黄金基线 76 步回放),真进程冒烟加了 4 条,85 / 85。

### 契约迁移收尾

77 个 RPC 方法全部在 `contract/` 里。`LEGACY_METHODS` 空了但**留着**——它现在是那道闸门:
想绕过契约加方法,得先往那张表里加一行,而那条用例不让。

一路上反复出现、值得写下来的四件事:

1. **反向验证不是形式**。每一批都做"改一个字段名,看两头红不红",五批里有两批当场露馅
   (`as unknown as`、`any`),否则那一侧的契约是假的。
2. **界面手抄的那份常常比我新写的准**。盯盘那一批有四处按界面改了契约(`max_ms` 不可空、
   `last_error` 是空串、追价 `limit` 可为 null、盯盘行不是 `Partial<Track>`)。手抄的人见过真数据。
3. **schema 不许抢 handler 的话**。两次踩到:`ideas.update` 的缺 id、`instruction.submit` 的 accounts。
   判据很简单——黄金基线钉着哪句话,哪句话就归 handler。
4. **变异验证里"逃掉了"要分清三种**:测试太松(补)、夹具走不到那条分支(补)、等价变异(如实记下来,
   别为了数字好看硬凑)。这一轮 26 个种子里有 2 个是等价变异,都写进了测试注释。

**2026-09-20,第 4 步的界面那一半起了个头:`Tracker.tsx` 的新建表单搬进 `lib/TrackForm.tsx`。** 875 → 530 行。

- 缝在"设目标 → 授权自动发单"和"列已有的持仓与追踪"之间。先量耦合:`TrackForm` 只用到模块级的
  `SIGMA_SOURCE_HINT`(跟着一起搬),页面那头只在一处用它——干净的一刀。
- 办法同拆引擎:按行号切片、函数体逐字搬、断言边界、搬完逐行对账。**边界断言又抓到一次 off-by-one**
  (610 是空行、611 是下一半的分节注释),和拆 `engine.ts` 那两次一样——这个断言每次都值回票价。
- 对账:338 行搬走,一行未改;两头各自只动了 import,以及函数签名多一个 `export`。
- `theme/appearance.ts → store/` 这一项之前已经做掉了。

**2026-09-20,第二刀:`Tracker.tsx` 的展示那一半搬进 `lib/TrackCard.tsx`。875 → 227 行,整页进预算。**

- 这一页现在是三件事三个文件:页面只管「取数 + 列出来」(227),新建表单 `lib/TrackForm.tsx`(361),
  已有追踪怎么显示 `lib/TrackCard.tsx`(306)。三个都在 400 以内。
- 两个小助手(`Pnl` / `legLabel`)两边都要用:跟着组件走、从 `lib/` 转出,页面反过来引——`page → lib`
  是允许的方向,不必为它们再开一个文件。词表 `TRACK_STATE_LABEL` 归 `lib/labels.ts`(那里已经住着同类的几张)。
- 边界断言**这一刀又抓到两次**(分节注释的措辞记岔了、文件末尾那个空行)。三刀下来它抓到四次,
  每次都是几秒钟的事——手写行号一定会错,把它写成断言就行。
- 对账:300 行搬走一字未改;两头各自只动 import,四个签名多一个 `export`。

**2026-09-21,第三刀:`Access.tsx` 的大模型那一节搬进 `lib/LlmPanel.tsx`。** 716 → 509 行。

- 这一页本来就按 TWS / 富途 OpenD / 大模型分了三节,分节注释就是现成的缝。大模型那一节和另两节
  **没有共享状态**,只共用一个 `InfoCard` —— 把它下沉到 `lib/connectBits.tsx`,页面与各节都从那儿拿。
- 搬完顺手修了一处这一刀才暴露出来的类型错:`switchTo(provider: LlmProvider | any)`——**换券商**的函数
  标着大模型的类型,而且 `| any` 把整个类型化掉了。唯一的调用方传的就是券商目录里的一项,
  按实际改成 `BrokerProviderEntry`。这种错正是"一个文件装三件事"养出来的。
- 对账:197 行搬走一字未改;两头各自只动 import,两个签名多一个 `export`。

**2026-09-21,第四刀:`Access.tsx` 的 TWS 与富途两节也各自成文件。716 → 32 行,整页拆完。**

- 这一页现在是五个文件:页面只管「在三个子页签之间切」(32),三节各一个
  (`lib/TwsPanel.tsx` 108、`lib/FutuPanel.tsx` 261、`lib/LlmPanel.tsx` 212),
  两节共用的六个展示构件 + 两个类型别名在 `lib/connectBits.tsx`(150)。都远低于 400。
- 这一刀的边界断言一次写了 28 处,**第一次跑就抓到两处**(我把两行中文注释的原话记岔了)。
  之后把注释行的断言放宽成"必须是注释"、函数行保持严格——注释会被人改,函数签名不会。
- 对账:23 行"丢掉"全部说得清(9 行 import 重写、2 行页头注释换掉、2 个类型别名与 8 个函数签名加
  `export`、2 行分节注释被各文件自己的头注释取代),**函数体一行没少**。
- 搬家时照原样没动的一处:「0 · 当前券商接入」(换下单出口)长在富途那一节里。它该不该在那儿是另一件事,
  写进了 `FutuPanel.tsx` 的头注释,没顺手挪——挪它是改行为。

**2026-09-21,第五刀:`Screener.tsx` 拆成四块。** 709 → 226 行。

- 这一页缠在一起的是三件事:**行怎么拼**(把 RS 与背离合成一行、排序、着色)、**表怎么画**、
  **单只的极值偏离**。按这三件切:`lib/screenerRows.ts`(82,不认识 React 的纯逻辑)、
  `lib/ScanTable.tsx`(230)、`lib/DeviationSection.tsx`(208),页面只剩「扫一次 + 摆出来」(226)。
- 切完才看清有四样是**三处共用**的:`num`(自己的数字格式,和 `fmtNum` 不是一回事)、`TF_LABEL` /
  `TF_OPTIONS`(周期中文名)、`rsCellProps` + `heat`(单元格着色)、以及 `PoolStock` / `SortState` 两个
  本地接口。全部下沉进 `screenerRows.ts`——它们本来就该有一个家,挤在页面里只是因为没人拆过。
- 脚本里给函数批量加 `export` 时用了正则,**heredoc 把 `\(` 折掉了**,当场报 "Unterminated group"。
  这正是 memory 里 `env-bash-tool-escapes` 记的那个坑;改成纯字符串匹配就好了。
- 对账:27 行"丢掉"全说得清(6 行 import 重写、2 行分节注释被文件头取代、19 个声明加 `export`),
  **函数体一行没少**。

**2026-09-21,第六刀:`Market.tsx` 拆成三块。** 648 → 23 行。

- 按它自己那两条分节线切:`lib/PaPanel.tsx`(371,K线 PA)、`lib/BookWall.tsx`(189,盘口墙),
  页面只剩「两节摆一起」(23)。
- 切的时候发现一件不显然的事:**K线 PA 那一节里也嵌着一块盘口**(`<BookBody>`),所以
  `BookBody` / `BookSide` 不能跟着盘口墙走,和 `read` / `write`(本地记住选择)、`BookCell` / `Books`
  两个类型一起归 `lib/marketBits.tsx`(89)。两节画的是同一份快照,不该各画各的。
- 对账:26 行"丢掉"全是 import、分节注释、或加了 `export` 的声明,**函数体一行没少**。

**2026-09-21,第七刀:`Review.tsx` 拆成三块。** 607 → 244 行。

- `lib/ReviewResult.tsx`(231,结论怎么摆)、`lib/reviewCharts.tsx`(154,三张图),页面只剩
  「挑一笔 + 跑一次 + 把结果摆出来」(244)。两张词表(`PHASE_LABEL` / `REVIEW_KIND`)两边都要用,
  归 `lib/labels.ts`;只有结果卡用的 `REVIEW_TONE` 跟着它走。
- **顺手补了契约的一个真缺口**:`ExitPlan` 少了 `actual_exit_mult`——引擎确实产出它
  (`flyexit.ts`:实际那一笔相当于入场净价的几倍,只在真平了仓时才有),界面也一直在读。补进了
  `contract/review.ts` 并标成可选。
- **有一处 `any` 刻意留着**:`ExitPlan({ r }: { r: any })`。试着收成 `ButterflyReviewResult` 之后
  发现真正卡住的是契约里 `ExitPlan.phases` 是 `Record<string, unknown>`、`simulation` 兜底成 `{}`
  之后也还原不回来。**收紧它是一轮单独的活**(要配特征测试 + 反向验证),不该夹在一次搬家里做;
  代码里留了 TODO 说清原因。
- 对账:19 行"丢掉"全说得清(8 行 import、2 张词表搬家、1 行分节注释、8 个声明加 `export`),
  **函数体一行没少**。

**2026-09-21,第八刀:`Records.tsx` 的详情搬进 `lib/RecordDetail.tsx`。** 461 → 253 行。

- 页面只剩「列一张表 + 点开谁」(253),详情那一份单据 219 行。
- 逐行对账这一次**抓到脚本自己的一个错**:批量加 `export` 时把 `export` 贴到了文档注释前面
  (`export /** TODO … */ function …`)。TS 居然认(注释在 `export` 与声明之间是合法的),
  lint 也不报——只有对账看得出来。顺手把 `Row` / `Section` / `DetailBody` 的 `export` 去掉:
  页面只用 `RecordDetail`,别的是这个文件自己的。
- 对账:12 行"丢掉"全说得清(8 行 import、1 行分节注释、3 个声明加 `export`),**函数体一行没少**。

**2026-09-21,第九刀:`Backtest.tsx` 拆成三块。** 403 → 208 行。**界面拆页到此做完:9 个页面全部进预算。**

- `lib/RuleBuilder.tsx`(117,图形化条件搭建器)、`lib/BacktestResult.tsx`(101,结果那一节),
  页面只剩「选参数 + 跑一次 + 摆结果」(208)。三张只有搭建器用的常量表跟着它走;
  两边都用的 `BT_INST_LABELS` 归 `lib/labels.ts`。
- 对账第三次抓到"该不该转出":`fmtOperand` / `RuleSection` / `OperandEditor` 只在文件内部用,
  脚本一律加了 `export`。收掉——**批量加 `export` 之后要按"谁真的从外面引"过一遍**,
  否则一个文件的内部结构就白白暴露成了公开接口。

### 界面拆页收尾

九个页面全部在 400 行预算以内(最大的 Trade.tsx 333),`lib/` 里最大的 371(`PaPanel.tsx`)。
`pages/` 合计 2,599 行,拆之前光 Tracker + Access + Screener + Market + Review 五个就有 3,547 行。

九刀下来,方法本身值得记住的四条:

1. **先量耦合,再划缝**。每次都先数"哪个名字在哪一段出现几次",缝就自己浮出来了。
   Market 那一刀正是这么发现「K线 PA 里嵌着一块盘口」的——光看分节注释会切错。
2. **边界断言值回票价**。九刀里它抓到 **6 次**手写行号错(空行、分节注释措辞、文件末尾空行、
   函数真正的结束行)。手写行号一定会错,写成断言就几秒钟。
3. **逐行对账不是形式**。它抓到两类脚本自己的错:`export` 贴到了文档注释前面(TS 和 lint 都不报),
   以及**过度转出**(内部助手也被加了 `export`,共三处)。
4. **搬家就只搬**。三处 `any` 里只有 `switchTo` 那一处当场改对了(它是明显的错类型);
   `ExitPlan` / `DetailBody` 两处留了 TODO,因为要动函数体——**下面那一节就是把它们做完**。

**2026-09-21,收尾那一轮:把拆页过程中露出来的松类型收紧。**

- 契约(`contract/review.ts`)补/收三处,依据是引擎**实际产出**:
  · `ExitPlan.actual_exit_mult`(第七刀发现的缺口,标成可选——只在真平了仓时才有);
  · `ExitPlan.phases` 从 `Record<string, unknown>` 收成显式的 `ExitPhases`(六个字段,时刻是 `HH:MM` 墙钟串);
  · `ExitSimulation.reason`(不适用那一支才有,说明为什么不能回放)。
- 界面收掉四处 `any`:`ExitPlan`(→ `ButterflyReviewResult`)、`DetailBody`(→ `TradeRecord`)、
  `BookCard.snapshot`(→ `BookCell | null`)、偏离图里 4 个 `(s: any)`(→ `DeviationPoint`)。
  连带发现**界面手抄的两处局部类型和契约不一致**:时间线的 `status` 手抄成 `string | undefined`,
  引擎给的是 `string | null`;成交行也一样。按契约改了。
- **反向验证暴露了一件更要紧的事**:改 `ExitPhases` 的字段名,只有界面编译不过,**引擎照过**——
  因为 `flyexit.ts` 整个用 `Rec` 拼,契约在引擎那一侧根本没被检查。这和之前 handler 里的
  `as unknown as` 是同一个病。于是把 `levels()` → `ReviewLevel[]`、`zones()` → `ExitZone[]`、
  `plan()` 里的 `out` 标成契约类型。`flyexit.ts` 在钱路径上:**去掉注释后编译产物逐字节一致**。
- **字节比对当场抓到一个真问题**:我把 `import type` 放在了所有 import 的最前面,文件头那块 JSDoc
  就挂到了一个会被擦除的语句上,**编译产物里整块注释消失了**。挪到值 import 之后才一致。
  这条值得记:`import type` 不要插在文件头注释与第一个值 import 之间。
- `simulate()` 的返回**刻意还是 `Rec`**:标成 `ExitSimulation` 之后 `sim["totals"]["model_minutes"]`
  这几处要改成可选链——那是改函数体。正确的收法是把 `ExitSimulation` 改成**按 `applicable` 判别的
  联合类型**(不适用那支只有 reason,适用那支 totals / series 必有),那样这几处不用改就能收窄。
  签名上留了 TODO。**这是这条线上还欠的最后一件。**

> `tests/rpc-lanes.spec.ts` 这一轮又偶发红了一次(重跑即绿)。频率变高有个直接原因:修它的那个会话
> 正在同一台机器上跑,负载更高——这本身就是"它测的是墙钟而不是顺序"的旁证。

> 跑全量时 `tests/rpc-lanes.spec.ts` 也偶发红过一次(单独跑、再跑全量都绿),和 `provider-http.spec.ts`
> 同一类:对时序 / 负载敏感,而不是被测代码坏了。两件一起另开任务修,判据别改成放宽阈值。
