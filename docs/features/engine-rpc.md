# 引擎 RPC

引擎是桌面端拉起的一个 Node 子进程。两者之间只有 stdio 上的换行分隔 JSON-RPC 2.0,没有监听端口;
stdout 只传协议,日志一律走 stderr。引擎单线程,请求按方法分三条道调度。

## 三条道

| 道 | 调度 | 放什么 |
|---|---|---|
| 本地道 | 来了就答 | 同步的本地库与配置读写:板块增删、想法列表与检索、记录、设置读取、熔断状态、追踪列表、`tracker.poll` / `tracker.reconcile`(只读引擎最近一轮盯盘的结果)、`quality.*`、`pool.set_watch`、`data.backups` / `data.backup`、`options.iv_recorder*`、`system.status`、`keychain.set` / `futu.set_password` / `follow.set_token`(写系统凭证库,可能等 macOS 弹窗,不该挡住下单)、`follow.status` / `follow.reconnect` |
| 读道 | 最多 4 个并发 | 只读的行情、探测与纯计算:`positions.list`、`pa.analyze`、`book.snapshot`、`macro.board`、`screener.*`、`backtest.run` / `sweep`、`options.fly_plan`、`options.spot`、`review.performance` / `signals`、`ideas.similar_trades`、`tracker.target_preview`、`tws.*` / `futu.*` 探测 |
| 交易道 | 严格顺序 | 其余全部:`instruction.submit`、`pending.poll`、熔断、连接与切换券商、`settings.patch`,以及调用大模型的 `ideas.analyze` / `ideas.digest` / `backtest.parse_rules` / AI 选股 |

- 只有交易道需要顺序:下单、熔断、连接切换共享引擎状态,并发会让批内熔断、重复单这类检查出现竞态。
- 交易道里周期轮询类的方法(`LOW_PRIORITY_METHODS`)排在用户亲手发的请求之后;执行仍是单线程,只是插队。
- 道表以 `rpc/server.ts` 的 `LOCAL_METHODS` / `READ_METHODS` 为准,上表只列代表。
- 超过 1 秒的请求记到 stderr(`[rpc] 慢请求 …`)。
- 公开数据源不阻塞调度:10 分钟内的旧值先给、后台去取新值;从来没取到过、或旧得超过 10 分钟的才同步等。

## 代码分层

| 位置 | 管什么 |
|---|---|
| `rpc/server.ts` | 传输(读行、三条道、回执与事件)、生命周期(配置、券商 router、引擎的建与丢)、装配(把各域的方法表合成一张)。不写业务 |
| `rpc/handlers/<域>.ts` | 一个域一张方法表:`system` `trading` `ideas` `sectors` `screener` `backtest` `market` `alerts` `quality` `review` `tracker` `connection` `settings` |
| `rpc/context.ts` | handler 看到的上下文接口 `RpcContext` 与基类 |
| `rpc/contractMethods.ts` | 登记契约方法的入口:入参先过 schema,再调 handler |
| `rpc/params.ts` | 两个域都要用的入参小工具:`optFloat` / `optInt` / `symbolOrRaise` / `drawdownTiersOf` 等 |
| `services/*.ts` | 带状态的编排:`marketData`(K 线、日线、期权墙缓存)、`alerts`(价位与穿越)、`anomaly`(5 秒一轮的异动循环)、`pool`(股票池两个开关)、`brokerLink`(自动连接与重连)、`flyPlanner`、`ivRecorder`、`ideaSemantic`、`similarContext`、`stockTrips`、`tradeHistory`;宿主接口在 `services/host.ts` |

- handler 之间不互相 import,也不 import server。两个域都要的东西往下放:带状态的进 `services/`,纯函数进 `rpc/params.ts`。
  K 线缓存被行情、扫描、价位提醒、交易分析共用,所以它是 service;IBKR 把 15 秒内相同的历史请求算作超频,各处各缓存一份等于没缓存。
- service 只认宿主(`ServiceHost`),每次用到 `settings` / `router` / `engine` 都从宿主现取:配置会重载、券商会重连、引擎会重建。
- 错误码的类 `RpcError` 在 util 层的 `rpcError.ts`,service 抛带码的错(例如 −32017「需要先连券商」)不用 import 传输层。
  凭证库的错(`KeychainError`,含等系统弹窗超时)在 `server.ts` 统一报 −32008、原话给界面,见 [系统凭证库](credentials.md)。
- 报错的 message 写原因,不写「AI 选股失败:」这类动作前缀:前缀由界面加(见 [界面](ui.md) 的「界面文案」),两头都加横幅上就说两遍。
- 方法表是无原型对象,请求里的 `constructor` 这类外来字符串取不到东西;同名方法重复登记时构造当场报错。
- 新域在 `server.ts` 的 `domains` 里加一行。`npm run depcruise` 检查分层,规则在 `engine-ts/.dependency-cruiser.cjs`。

**引擎启动时**:`serve()` 启动异动循环与 IV 记录循环,预取 SPX 公开现价并每 4 分钟刷新;
只有真正的 stdio 入口(`main()`)才按 `broker.auto_connect` 自动连券商,测试直接调 `serve()`,碰不到本机的 TWS。

## 引擎重建

`settings.patch` / `llm.patch`、连接与断开、切换券商都会丢掉当前引擎、再建一个;连着券商时当场重建,盯盘节拍器随新引擎启动。
券商会话上的回报监听只挂一次,所以:

- 换下来的引擎把接回报的五个入口(`onOrderStatus` / `onExecDetails` / `onCommission` / `onIbError` / `wireSession`)
  改成转给当前引擎。之后才连上的会话经 `sessionHook` 挂到当时的引擎上。
- 同一个 router 下,新引擎接着使用旧引擎的回报账:`orderIndex`、终态、成交与佣金的 exec_id 去重、没对上的回报、早到的错误。
  换了 router 等于换了连接,旧订单号不作数。
- 新引擎第一轮托管对账之前还不认得旧引擎挂出去的托管单(要等 `adoptHosted` 按 orderRef 认领),
  这段时间的状态回报也交给旧引擎的托管缓存处理一次,成交照样标记已触发,不会被当成"没挂"再挂一张。
- 软件盯盘的条件单队列(`pendingTriggers`)随重建丢掉,执行对账会把它们标成「去向不明」;
  追价平仓的单由新引擎第一轮 `adoptCloseChase` 按 orderRef 认领回来。
- 追踪相关的操作(盯盘一轮、建 / 改 / 删追踪、立即平仓)排在同一把锁上,这把锁跨引擎实例共用。
  盯盘有触发或被拦下时,引擎主动推 `tracker` 事件给界面。

测试:`tests/fix-callbacks-rewire.spec.ts`。

## 契约

入参与返回的形状只在 `engine-ts/src/contract/` 定义一次,引擎与界面共用。界面的 `bridge.ts` 用 `import type` 引同一份,
改一个字段名,引擎产出它的地方与界面消费它的地方同时编译不过。

| 位置 | 内容 |
|---|---|
| `contract/<域>.ts` | 这个域的入参与返回类型,纯类型、零 import |
| `contract/index.ts` | `RpcMethods`(方法名 → `{ params, result }`)、`RpcParams<M>` / `RpcResult<M>`、`SENSITIVE_METHODS` |
| `contract/schema/` | 入参的 zod schema 与总表 `PARAMS_SCHEMAS`;缺一个方法或形状对不上都是编译错 |
| `rpc/contractMethods.ts` | handler 用它登记方法,方法名、入参、返回三样对着契约检查 |

- **全部 90 个方法都在契约里。** `tests/contract.spec.ts` 的 `LEGACY_METHODS` 是空表,只许变短;引擎里出现不在契约里的方法测试就红。
- **类型文件零 import。** 界面的 tsc 会顺着 `bridge.ts` 走进来,而 CI 的界面任务不装引擎依赖。所以类型是源头,
  schema 写成 `ParamsSchema<契约类型>` 去对照它。
- **schema 只管结构**(有哪些字段、什么 JSON 类型),领域校验(代码形状、上限、阈值范围)留在 handler,报 handler 自己那句话。
  schema 不比 handler 严:异动阈值认数字串(表单里敲出来的是字符串),契约里它的值是 `unknown`,由 `normalizeAnomalyConfig` 校验。
- **缺必填字段归 schema 报**;例外是黄金基线里请求不带它、期望的却是 handler 原话的字段(`ideas.update` 不带 id →「缺少想法 id」、
  `backtest.run` 只给一个坏代码 →「股票代码不合法」),用 `schema/kit.ts` 的 `requiredButReportedByHandler()`:类型上必填,
  schema 把"没给"交给 handler 报。检查的先后次序也属于行为。
- **授权发单的方法 schema 用 `.strict()`**(`tracker.add` / `update` / `close_now`、`instruction.submit`):不认识的键当场拒绝,
  两个授权开关只收布尔。这些方法登记在 `SENSITIVE_METHODS`,`desktop-whitelist.spec` 拿它和 `main.js` 的 `SENSITIVE_RPC` 双向核对。
  preload 给敏感调用加的 `__confirmed: true` 由主进程在转给引擎之前去掉。
- **界面拼载荷的对象字面量直接标契约类型**(`const spec: TrackerAddSpec = {…}`):TypeScript 只对标了类型的字面量检查多余的键。
- **已有校验者的字段不重复校验。** `settings.patch` 的 schema 只确认 `patch` 是以字符串为键的对象,各段的值在契约里是 `unknown`;
  handler 只认四段(`policies` / `limits` / `protections` / `risk_budget`),段内由 `config.fromDict` 拒绝未知键、检查类型与范围,校验不过不写盘。
- **库里的 JSON 列,读取一方按"可能缺"标类型**(`ideas.analysis`、`idea_digests.digest`、`Track.targets` 读出来是 `Partial<…>`)。
- **发出去的形状和回来的形状分成两个类型**,例如回测条件 `RuleOperandInput` / `RuleOperand`、设置 `SettingsPatchInput` / `SettingsPatch`。
- **持仓行由三处拼起来**(券商适配层、`withCombos` 合成组合行、`positions.list` 补追踪与盈亏),后两段加的字段在 `PositionRow` 里是可选的。
- 加新方法的顺序见 `CLAUDE.md`。

## 超时与迟到的回执

桌面端等一个调用最多 120 秒(`desktop/rpc-client.js`)。交易道严格顺序、不能取消,超时的请求可能只是还在排队,之后照样执行。

| 方法 | 超时之后 |
|---|---|
| `instruction.submit`、`tracker.add`、`tracker.update`、`tracker.close_now` | 报「结果未知:…可能已经执行,请先到订单看板和券商端核对,不要直接重发」。引擎之后回话了,主进程补一条系统通知与通知流,说明那次操作最终有没有执行,并让界面重读挂单 |
| 其余 | 报超时 |

只有调用方要求记(`call(..., { lateReply: true })`)的才等迟到回执,轮询与心跳不记;引擎进程退出时这些等待一并作废。
