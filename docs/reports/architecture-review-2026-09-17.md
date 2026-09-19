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
