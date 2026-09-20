# 引擎 RPC:三条道,交易道严格顺序

引擎跑在一个 Node 进程里,单线程;但瓶颈从来不是 CPU,而是"一次只处理一个请求":等网络的行情请求
把纯本地的一次 SQLite 写也挡在后面(2026-09-08 用户反馈"移除板块成分股太慢")。现在请求按方法分三条道:

| 道 | 方法 | 调度 |
|---|---|---|
| 本地道 | `sectors.*`(AI 选股除外)、`ideas.*`、`records.*`、`settings.get`、`breaker.state`、`alerts.list`、`tracker.list`、目录类 | 同步的本地库 / 配置读写,来了就答 |
| 读道 | `pa.analyze`、`book.snapshot`、`options.wall`、`positions.list`、`sectors.quotes`、`macro.board`、`screener.*`、`backtest.*`、`tws.*` / `futu.*` 探测 | 只读,最多 4 个并发 |
| 交易道 | 其余:`instruction.submit`、`pending.poll`、`tracker.poll`、熔断、连接切换、`settings.patch` | 严格顺序,用户请求插到周期轮询前面 |

只有交易道需要顺序:下单、熔断、连接切换共享引擎状态,并发会把"批内熔断""重复单"这些闸门变成竞态。
道表在 `rpc/server.ts` 的 `LOCAL_METHODS` / `READ_METHODS`,`tests/rpc-lanes.spec.ts` 钉住调度行为。交易道内两条纪律:

- **轮询类方法低优先级**:读 stdin 的线程把请求按优先级排队,用户请求先执行。执行仍是
  单线程,只是插队。
- **公开数据源永不阻塞主循环**:过期但没老到没用(10 分钟内)的旧值先给、后台去取新值;
  只有从没取到过的格子才同步等。用户点强制刷新才同步等。
- 超过 1 秒的请求记到 stderr(`[rpc] 慢请求 …`),别让下一个拖慢主循环的方法躲起来。

## 代码怎么摆:传输、各域的 handler、带状态的 service

`rpc.ts` 曾经是一个 3,500 行的类:350 行传输,其余是 13 个业务域和四块带状态的编排。2026-09-19 按域搬开
(函数体逐字搬,`golden-rpc` 回放的 stdio 契约一个字节没变),`rpc.ts` 只剩一个转出的壳:

| 位置 | 管什么 | 不管什么 |
|---|---|---|
| `rpc/server.ts` | 传输(读行、三条道、回执与事件)、生命周期(配置 / router / 引擎的建与丢)、装配(把各域的表合成一张) | 任何一个方法的业务 |
| `rpc/handlers/<域>.ts` | 一个域一张方法表:`system` `trading` `ideas` `sectors` `screener` `backtest` `market` `alerts` `quality` `review` `tracker` `connection` `settings` | 别的域——handler 之间不互相 import |
| `rpc/context.ts` | handler 看到的上下文接口(`RpcContext`)与基类 | — |
| `rpc/params.ts` | 入参小工具:`optFloat` / `optInt` / `symbolOrRaise` / `drawdownTiersOf` | — |
| `services/*.ts` | 带状态的编排:`marketData`(K 线 / 日线 / 期权墙缓存)、`alerts`(算价位、盯穿越、自动补价位)、`anomaly`(5 秒一轮的异动循环)、`pool`(股票池两个开关与一次性迁移) | RPC——它们只认 `ServiceHost`(settings / router / engine / emit),离线测试可以塞假的 |

几条设计决策:

- **两个域都要的东西往下沉,不横着借。** K 线缓存被 K线 PA、扫描器、价位提醒、交易分析四处用,所以它是 service
  而不是某个 handler 的私有字段;缓存是节流(IBKR 15 秒内相同历史请求算超频),各处各缓一份等于没缓。
  `depcruise` 的 `handlers-are-leaves` 把这条钉成了机器检查。
- **service 拿的是宿主,不是值。** 配置会重载、券商会重连、引擎会重建;service 每次用到都从宿主现取
  `settings` / `router` / `engine`,不在构造时存一份会过期的拷贝。
- **错误码在最底层。** `RpcError` 放在 `rpcError.ts`(util 层):service 也要抛带码的错(-32017「需要先连券商」),
  不该为一个错误类去 import 传输层。
- **方法表是无原型对象。** 请求里的 `method` 是外来字符串,`"constructor"` 不该从 `Object.prototype` 上捞到东西。
- **加方法**:先进契约(见下一节),再在所属域的 `methods()` 里用 `contractMethods` 实现;新域就在 `server.ts` 的
  `domains` 里加一行。同名方法重复登记,构造时直接抛。
  `tests/desktop-whitelist.spec.ts` 双向核对引擎方法表 ↔ `main.js` 的 `ALLOWED_RPC`,并核对三张道表里的名字都是真方法。

## 契约:入参与返回只写一处(`src/contract/`)

同一个形状以前写两遍:引擎的 `anomaly.ts` 一份,界面的 `bridge.ts` 手抄一份,中间靠一条正则测试逐字段对——
`block_share` 就是手抄时漏掉的,`enabled` 库里是 `0 | 1`、界面那份写成了 `number | boolean`。引擎改一个返回字段名,
四个登记处没有一个报错,只有界面上出一个 `NaN`。2026-09-20 起,形状只在 `contract/` 定义一处:

| 位置 | 内容 |
|---|---|
| `contract/<域>.ts` | 这个域的入参与返回类型(纯 TS,零 import) |
| `contract/index.ts` | `RpcMethods`:方法名 → `{ params, result }`;`RpcParams<M>` / `RpcResult<M>` |
| `contract/schema/` | 入参的 zod schema 与总表 `PARAMS_SCHEMAS`(对着 `RpcMethods` 的映射类型:缺一个、形状对不上都是编译错) |
| `rpc/contractMethods.ts` | handler 登记契约方法的入口:入参先过 schema,再调 handler;方法名、入参、返回三样对着契约检查 |

`bridge.ts` 用 `import type` 引同一份,所以契约里改一个字段名,引擎在**产出**它的地方、界面在**消费**它的地方同时编译不过
(拿 `block_share` 验过:`anomaly.ts` 与 `PoolStock.tsx` 一起红)。几条设计决策:

- **类型文件零 import,schema 另放一个子目录。** 体检报告原本建议"每个方法一条 `{ zod schema, result 类型 }`"放在一起。
  做不到:界面的 tsc 会顺着 `import type` 把整个文件纳入检查,而 CI 的 `desktop-ui` 不装引擎的依赖,一个 `import "zod"`
  就解析不了。所以类型是源头,schema 写成 `ParamsSchema<契约类型>` 去对它,而不是反过来 `z.infer`。
- **定义搬进 contract,原处改成转出。** `anomaly.ts` 的 `AnomalyConfig` / `Metrics` / `AnomalyEvent` 现在是从契约转出的,
  十几处 import 不用改。契约在依赖分层的最底下,分析层、store、service 都可以引它。
- **schema 只管结构,领域校验留在 handler。** 缺字段、类型不对是调用方写错了,报「`quality.add` 的参数不对:缺少 symbol」;
  代码形状、上限、阈值范围是用户填错了,还是 handler 那句给人看的话(「price / anomaly 至少要传一个」),界面原样显示。
  schema 不许比老 handler 严:异动阈值一直认数字串(表单里敲出来的就是字符串),所以 `config` 在契约里是
  "键同 `AnomalyConfig`、值 `unknown`",由 `normalizeAnomalyConfig` 校验;可选字段带 `null` 和不带是一回事。
- **库的行也写成接口。** `QualityStockRow`、`Watch`、`Sector` 分别是 `quality_stocks` / `alert_watches` / `sectors` 的一行,
  store 的这些方法不再回 `Rec`;允许改哪几列写成 `WatchPatch` / `QualityStockPatch`。类型断言只留在库的边界
  (`qualityRow` / `watchRow` / `sectorRow`)。运行时那道"不允许修改的字段"白名单照留——它是给绕过类型的调用方准备的。
- **契约一直通到产出数据的地方。** 返回类型不是在 handler 里断言出来的,是从源头一路标过来的:`StockQuote` 标在两家
  券商适配层的 `stockQuotes` 上,`OptionWallCore` 标在 `optionwall.analyze` 上,`WatchLevel` / `WatchEvent` 标在 `alerts.ts` 上。
  验过:把行情的 `change_pct` 改名,`broker.ts`、`futuBroker.ts` 和界面的 `PoolStock.tsx` 同时报错。
- **契约如实写,不顺手"修"。** 迁的过程会照出线上形状里的毛病,写进契约的注释、留给人定夺,不在迁移里改——迁移的
  判据是 `golden-rpc` 不更新基线还绿。例:`alerts.create` / `tracker.add` 的回执里 `enabled` 曾经是数字 `1`(回的是刚插入的
  那一行,没过读库的转换),列表里同一条是 `true`;基线钉着,所以迁的时候 `enabled` 如实写成了 `boolean | 0 | 1`。
  用户定了之后才**单独一笔**统一成布尔(2026-09-20,`golden:update` 的 diff 恰好一行),契约类型随之收成 `boolean`。
  可空也如实写:`alerts.refresh` 中间有 `await`(而且自动补价位跑在异动循环里,会和用户的删除交错),回执里重读的那一行
  可能已经被删,类型是 `Watch | null`;中间没有 `await` 的那几个重读不可能落空,类型不带 `null`。
  一个类型上的 `| null` 值得追一下它是怎么来的:`sectors.pick` 的可空就是这样查出一个老 bug 的——等大模型的那几秒里
  板块被删(`sectors.delete` 在本地道,来了就答),新选的股照样被打开两个开关,成了不在任何板块里的孤儿。现在等完大模型
  先确认板块还在,不在就报错、一个开关都不开;修完之后那个 `| null` 也就没了。
- **迁移渐进,只许往前。** 还没迁的老方法钉在 `tests/contract.spec.ts` 的 `LEGACY_METHODS`(还剩几个以那张表为准,
  这里不抄数),那张表只许变短;引擎里出现一个既不在契约、也不在名单里的方法,测试就红。迁的顺序是先便宜后贵:
  `quality.*`、`pool.set_watch`(界面那头本来就有具体接口)→ `alerts.*`、`sectors.*`、`options.wall`(界面的 store 里
  各手写了一份猜的:价位的 `kind` 写成了 `… | 'neutral'`,引擎给的其实是 `pivot`;字段全标成可选,引擎其实每个都给)。
  每一批的经过记在 `docs/reports/architecture-review-2026-09-17.md` 的「进展」里。

- **授权发单的域,schema 反过来要严。** `tracker.add` / `update` 是在授权软件自动发单。zod 的 `z.object` 默认把没列的键
  静默丢掉:键名写错一个字母(`stoploss`)、或者 schema 漏列一个键,结果是追踪照建、那道保护悄悄没设上。所以这个域的 schema
  是 `.strict()` 的,不认识的键当场拒(「有不认识的键:stoploss」);两个授权开关只收布尔——`Boolean("false")` 是 `true`,
  老 handler 会把它当成"打开"。数值字段照界面的真实载荷来:`Tracker.tsx` 发的全是字符串,`''` 表示不设,所以契约类型是
  `number | string | null`,"是不是一个数"由 handler 的 `optFloat` 判。这一段先有 `tests/tracker-rpc.spec.ts`(界面原样的载荷、
  走完整条 RPC 路径)才动的手,迁移没改它一个断言;schema 自己又做了一轮变异(只收数字、强转、漏列键且去掉 strict…),6 个全被抓住。
- **敏感标记进了契约。** `contract/index.ts` 的 `SENSITIVE_METHODS` 是这个目录里唯一的运行时值;`desktop-whitelist.spec` 拿它和
  `main.js` 的 `SENSITIVE_RPC` 双向对(只对已经进契约的方法)。同一份测试还钉着一个因为 strict 而变得承重的耦合:preload 给
  敏感方法加的 `__confirmed: true` 由主进程在转给引擎**之前**摘掉——漏过去的话,真应用里每次建追踪都会被拒。
- **类型查不了变量里多出来的键。** 第一版只把 `addTracker(spec)` 的参数标成了契约类型,反向验证时发现界面**不红**:
  `Tracker.tsx` 是先拼一个没标类型的 `const spec = {…}` 再传进去,而 TypeScript 只对标了类型的对象字面量查多余的键。
  现在那个字面量直接标成 `TrackerAddSpec`,契约里改一个键名,界面正好红在拼载荷的那一行。
- **动钱路径上的文件,拿编译产物说话。** 这一批要动 `tracker.ts`(类型搬进契约、`drawdownThreshold` 里两个局部变量加标注)、
  `store.ts`、`flyexit.ts`。改动前后各编译一次,去掉注释逐字节比对:`tracker` / `flyexit` / `store` / `engine` / `broker` /
  `futuBroker` / `positions` 七个文件的产物一致;`handlers/tracker.js` 的差异正好是方法表与一处非空检查。`engine.ts` 一行没动——
  它调 `tk.sweepReason` 的地方靠改被调方的参数类型(只读一个可选的 `fired_state`)解决。

- **已经有校验者的地方,schema 不再抄一遍。** `settings.patch` 的 `patch` 由 `config.fromDict` 校验:每一段都拒绝不认识的键
  (「policies 里有未知配置项:auto_excute」)、查类型与范围、校验不过不写盘。契约的 schema 对它只确认"是个对象",契约类型里它的值是
  `unknown`——和异动阈值的 `config` 同一个处理。顶层照敏感方法的规矩用 strict。动手前先探过现状才敢这么定:担心的那个洞
  (键名写错,"我关了自动执行"悄悄没生效)引擎自己早就堵上了。`fromDict` 不看的是**顶层**:不认识的段原来会成功、被原样写进
  配置文件,`llm` 段还能绕过 `llm.patch` 的字段白名单。2026-09-20 起 handler 只认契约里写着的三段(`policies` / `limits` / `protections`)。
- **持仓行从三处攒起来,类型在每一处都说真话。** 券商适配层给基础字段,`withCombos` 另外合成组合行(多 `kind` / `net_side` / `legs` / `ratios`),
  `positions.list` 最后补 `tracked` 与盈亏口径——所以后两段加的字段在 `PositionRow` 里是可选的,而不是拆成两三个类型再靠断言过渡。
  `withCombos` 是泛型的:引擎和测试还在传松散的行,传什么回什么、外加组合行,不用为了标类型去改它们。
- **golden-rpc 钉着原话的"缺字段",还让 handler 说。** 按上面的分工,缺必填字段是结构错、归 schema 报。但基线里钉了几句 handler 对
  "没给"的原话(`ideas.update` 不带 id →「缺少想法 id」),换成 schema 那句就是为了迁移去改基线。这种字段用 `schema/kit.ts` 的
  `requiredButReportedByHandler()`:类型上仍是必填(调用方不许不给),schema 把"没给"解成空串交给 handler——和老 handler 的
  `String(x ?? "")` 一个结果;给了却不是字符串,照样当场拒。**只给基线钉着的字段用**,同一个方法里没被钉的字段(`status`)仍归 schema。
  被钉住的不一定是这个字段自己那句:基线里 `backtest.run` 有一条只带一个坏代码的请求,期望「股票代码不合法」——handler 是先查代码、
  再查日期的,`start` / `end` / `strategy` 要是在 schema 里必填,这一条就先变成「缺少 start」了。检查的先后次序也是被钉住的行为。
  还没迁的方法里基线钉着同类原话的有:`instruction.submit` 的「指令为空」「accounts 必须是账户别名数组」、`screener.inflection` 的
  「timeframes 要是非空数组」「整数参数不合法」——迁到它们时照此办。
- **库里的 JSON 列,读的一方按"可能缺"来标。** `ideas.analysis`、`idea_digests.digest` 是整份存进去的 JSON:写的时候是全的
  (`setIdeaAnalysis(id, analysis: IdeaAnalysis)`,少一段编译不过),读出来的是 `Partial<…>`——老版本写进去的可能缺后来才加的键,
  读不出来时 store 给的是 `null` / 空对象。界面原来那份手抄恰好也是全可选的,这回是契约如实这么写,不是界面自己留的余地。同 `Track.targets`。
- **发过去的样子和回来的样子是两个类型。** 回测的自定义条件,界面搭建器拼的操作数用不上的键可以不带、数字可以是数字串
  (`RuleOperandInput`);引擎这头过了 `models.ts` 的 `CustomRulesSchema`,回来的是补齐成 `null`、收成数字之后的(`RuleOperand`)。
  后者能赋给前者,所以「一句话生成」的结果可以直接放进搭建器。入参里这类"另有校验者"的字段(`rules` / `instrument`)在 handler 眼里是
  `unknown`(`BacktestRunParams`),界面用的是写全了形状的 `BacktestRunSpec`——同 `settings.patch` 的 `SettingsPatch` / `SettingsPatchInput`。

没做的:走哪条道还登记在 `server.ts` 的道表里,没有进契约。`tracker.poll` / `reconcile` / `close_now` 还是老方法:它们的返回是 `engine.ts`
在下单路径里拼出来的,等它拆开(体检报告第二条的后半)再标类型。

## 解析链路时延:量过一遍之后改了四处

用 `desktop/tools/latency_bench.js` 拿 38 条自拟指令(固定行话、蝴蝶与组合、正股、期权、触发单、应拒的、边界)
逐条 `instruction.submit`(只解析不下单)量了一遍,固定在一个交易日盘中的时钟上。结论:

| 路径 | 时延 | 由什么决定 |
|---|---|---|
| 本地速记(固定行话) | 中位 1.6 ms | 纯本地;第一次要取 SPX 公开现价,冷取 0.7–2.8 s |
| 大模型(DeepSeek V3,兼容端点) | 中位 3.0 s → 改后约 1.9 s | 端点本身:最小请求都要 2.1 s;提示词 12.5k token、99% 命中前缀缓存,只多 0.6–0.9 s;输出约 3.5 ms/token;网络 0.15 s;引擎自身 2.4 ms |

改了四处,前两处是"路径选错",后两处是"白跑":

- **周末的速记本地直接拒,不再回落给大模型。** 默认"当日到期"在周末不存在,原来交给大模型,大模型看不懂这套行话,
  花 4 秒回一个 UNCLEAR。现在本地 2 毫秒拒,话也说清楚:要下周一的写「明天」。第一次压测就是周日跑的,
  八条行话七条掉进这个坑——查下来不是语法,是日期。
- **带理由的速记本地接住(语法 v3)。** `1.8 挂15蝴蝶 15CM 理由:开盘冲高回落` 原来因为"理由"两个字整句交给大模型,
  而大模型看不懂"挂15""15CM",3.4 秒后拒。界面上的「补理由」按钮正好把用户推进这条死路。现在尾巴上的
  「理由:…」摘下来进 `reason`,前面照旧本地解析;「理由」后面是空的才回落。
- **`json_schema` 被端点拒过一次就记住。** 兼容端点先试 `json_schema`,DeepSeek 每次都回 400,再退到 `json_object`——
  原来每条指令都撞一次 400 再重发,12.5k token 的提示词上传两遍。现在一个进程里只撞一次,每条指令省约 1 秒。
- **引擎启动就预热 SPX 公开现价,之后每 4 分钟后台刷一次。** 速记的「15蝴蝶」中心靠它算;冷取一次 0.7 秒以上,
  预热后这条 2 毫秒的路径不再因为"第一次"或"十分钟没人用"变成 700 毫秒。

顺带把兼容端点报的前缀缓存命中数记进 `usage`(`cache_hit_tokens`),界面上能看出"慢是不是因为缓存没中"。

## 限额只在本地校验:提示词 v1.8.0

压测还看出一件不是时延的事:提示词第 6 条让模型自己按限额估算敞口并拒绝(EXCEEDS_LIMIT),模型算错就把合规的单
拒了——29 条大模型路径里 4 条,拒绝理由里自己写着"实际未超限,可执行""超过 5000?不,4800 < 5000"。而限额本来就有
硬校验层按统一口径逐条复算。定下来的原则:**能本地校验的判断都不交给模型,验证也尽量本地**。

- 系统提示词 v1.8.0 把第 6 条改成"限额不归你判断":不估算敞口、不因"可能超限"拒绝或改小数量、不输出
  EXCEEDS_LIMIT,用户写多少解析多少。三个限额数字不再进系统提示词,用户消息里那行"本次生效限额"也去掉——
  于是提示词指纹只随模型真正看到的东西(规则、别名表、少样本)变,改限额不再换指纹。同一条里顺手写明:
  合约存不存在由软件向券商核实,不要凭常识拒(压测里模型拿"SPY 期权每月第三个周五到期"拒过一条);
  蝴蝶推断看涨看跌前先把现价与中心并排写出来,行权价与现价的高低关系不是拒绝理由(模型比较错过"7550 高于 7718")。
- 校验层一行没改——它一直在复算:股票 = 数量 × 限价,单腿 = 张数 × 100 × 权利金,借方组合 = 张数 × 100 × 净权利金
  (AUTO_MID 时用宽度),贷方组合 = 张数 × 100 × (宽度 − 权利金),市价单有快照按快照、无参考价时按股数上限。黄金样例补了十二条
  紧限额用例(`validator.tight_*` / `notional_only_*`,5000 USD / 5 张):压测里被模型误拒的四条在校验层全部放行
  (1100 / 300 / 4800 / 3000 USD),真超限的被拦(23000 USD、按快照算的 22940 / 68820 USD、无参考价的 1000 股市价单、
  贷方铁鹰 7600 USD、6 张超 5 张),还有一条只收紧金额上限时 6 张放行——钉住"没覆盖的限额键回落到配置而不是引擎默认值";
  `engine-ts/tests/golden-prompts.spec.ts` 钉住了这一组用例。
- 发给模型的 schema 也随提示词版本走:v1.8.0 起 rejection 代码的 enum 不再列 EXCEEDS_LIMIT——兼容端点退到 json_object 时
  schema 会整段写进系统提示词,不能一边说"不要输出"一边把它列成合法值。pydantic / zod 模型保留该码,回滚到 v1.7.0
  或模型不听话时仍能解析(按模型侧拒绝原样透传,界面上 source=llm 可见)。
- v1.0.0 到 v1.7.0 原样保留,回滚只改 `prompt_version`。少样本里模型自己算"最大亏损 = … USD"的三句 warning 也删了:
  数字由校验层给(`notional`),模型算的不可靠。
- 本地验证:pytest 661、vitest 409、黄金 / store 夹具 / RPC 契约样本重生成后两侧对拍一致。付费端点只抽查了
  压测里误拒的那几条(`latency_bench.js --match`):5 条(误拒的 4 条 + 同文案的 1 条)模型全部交出订单,没有一条 EXCEEDS_LIMIT;4 条直接通过校验层,带触发条件的那条被校验层以 AMBIGUOUS_TRIGGER 拦下——压测台没连券商、拿不到 SPX 现价快照,是离线环境的限制,不是解析问题。时延 2.9–3.6 s;第一条 5.4 s 是提示词换版本后前缀缓存全未命中(12.3k token)再加撞一次 json_schema 400,之后 12288 token 缓存命中。
