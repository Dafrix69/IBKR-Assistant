# TS 重写进度报告(阶段 0–7 完成 + 阶段 8 新功能)

按 `docs/briefs/ts-rewrite.md` 执行。本文档随阶段推进滚动更新。

## 阶段 8:趋势位警报 + 想法知识总结(用户需求,两引擎同步)

### 趋势位警报(均线/52周高低点自动提醒)
"用户提前选好标的,标的到达 MA60/MA120 这类历史低位标尺时自动提醒"——
- 纯计算层(alerts.py / alerts.ts):`trend_levels`(60/120/200 日均线 + 52 周高低点,
  均线凑不满周期不算、高低点用最高/最低价、历史不足 52 周降级为"上市以来"并改标签)、
  `trend_snapshot`(含 range_pos_pct:现价在一年区间的位置,0 = 贴着 52 周低点);
  `build_levels` 增加 `history` 参数,趋势位与墙/整数关口走同一套合并与状态机,
  穿过报一次、落防、冷却,全部现成。
- RPC 层:`alerts.refresh` 拉日线历史(`historical_bars`,TTL 600s 缓存——富途历史
  K 线是 30 天 100 标的的额度制),失败降级并回传 `history_error`;响应新增 `trend`。
- 黄金对拍:gen_golden 新增 trend_levels / build_with_history 样例,TS 逐字段一致。
- 桌面端:价位标签补 60/120/200 日线与 52 周高低点;历史降级 banner。

### 想法知识总结(归档想法 → 可回看的知识)
"想法归档后应该存储下来,之后还能总结知识"——归档本来就永久落库(status 流转,
从不删除);新增的是提炼与留存:
- store:新表 `idea_digests`(scope / idea_count / idea_ids / digest JSON),
  只增不改;两侧建表语句一致,老库打开自动补表。
- RPC:`ideas.digest`(归档/完成的想法按时间正序喂给 LLM,产出主题/教训/规律/
  下一步,IdeaDigest 模型软件层复验,结果落库)、`ideas.digests`(历史列表)。
  S2 白名单不变:只发想法文本/时间/状态,账号持仓不出本机。
- 桌面端:想法页「总结知识」按钮 + 最新总结卡片(含基于几条想法、模型、时间)。
- 新 LLM schema 资产 `baseline/llm/idea_digest_schema.json` 由 Python 模型生成,
  与既有资产同一格式(CRLF、1 空格缩进)。

**验收:Python 519 项全过(+11 新测试);TS 306 项全绿、tsc 零错误;RPC 契约回放
扩到 76 步(新增 ideas.digest 引导文案/错误码/成功流程与 ideas.digests),逐条一致。**

### 本地速记解析"全链路 17 秒"的根因与修复(两引擎同步)
界面显示"毫秒级本地解析"却要等 17 秒。解析本身 ~100 ms;慢在**排队**:引擎 RPC 是
单线程顺序处理,连上券商后界面每 2 秒打一次 `macro.board`,VIX/美债10Y 两格走公开源
(串行、每格最多 6 秒超时),再加每秒一次的 `tracker.reconcile`——用户的
`instruction.submit` 只能排在这些轮询后面。离线复现:两条冷缓存的 macro.board 排在前面时,
submit 要等 13.7 秒。
- **公开源改"陈旧即返、后台刷新"**(macro.py / macro.ts):过期但未超过 10 分钟的旧值
  立刻返回并标 `refreshing`,新值由后台线程/Promise 单飞取回;只有从未取到过的格子才
  同步等;用户点强制刷新(force)仍同步。速记解析用的 `public_index_price` 同样处理。
- **RPC 请求分优先级**(rpc.py `serve` / rpc.ts `serve`):读 stdin 的线程把请求按优先级
  排队,周期轮询(system.status / macro.board / alerts.poll / tracker.poll /
  tracker.reconcile / pending.poll / positions.list / sectors.quotes / pa.analyze /
  book.snapshot)排在用户请求之后;仍是单线程执行,不引入任何并发——券商 SDK、SQLite、
  引擎状态都不是线程安全的。EOF 排在所有已收到的请求之后。
- **慢请求可见**:任何超过 1 秒的 RPC 在 stderr 记一行 `[rpc] 慢请求 <method> <ms>`,
  以后再拖慢主循环的方法一眼可见。
- 修复后离线复现:submit 排在两条冷 macro.board 前面 1.5 秒出结果(冷 Cboe 取价),
  缓存热时 117 ms;过期后的 macro.board 379 ms(旧值先给)而不是 12 秒。
- 验收:Python 522 项(+3:SWR ×2、serve 优先级);TS 308 项(+2)。

### 期权腿身份:蝴蝶只显示成"SPX 1 张"的根因与修复(两引擎同步)
持仓行的 key 是 `账户|symbol|sec_type`,一只蝴蝶三条腿都是 `模拟|SPX|OPT`,聚合时互相
覆盖只剩最后一条;追踪表 UNIQUE(account, symbol, sec_type) 也让三条腿只能追踪一条,
自动平仓可能认错腿(平掉不该平的那条)。
- **腿身份**(tracker.py / tracker.ts):`leg_of(contract)` = `到期|行权价|C/P`;
  `position_key(account, symbol, sec_type, leg)` 期权带腿、正股形状不变(老追踪记录照常
  匹配);`position_label` 给人看的票面名 `SPX 7615P 2026-09-01`;`track_key(track)`
  统一所有 key 构造点(engine / rpc 两侧共 5 处)。
- **券商持仓行**(broker.py / broker.ts、futu 侧补空 leg):每行带 `leg` 与 `label`。
- **存储迁移**(store.py / store.ts):position_tracks 加 `leg` 列、唯一约束改为
  (account, symbol, sec_type, leg);SQLite 改不了约束,老库整表重建、老记录 leg=''。
  两侧迁移语句同一段;黄金 store 夹具重生成(tracks 含 leg)。
- **组合识别**(`group_legs` / `groupLegs`,纯函数、黄金对拍):同账户/标的/到期日的
  腿按形状认成 买入/卖出看涨(跌)蝴蝶、垂直价差、铁鹰/铁蝶,认不出的叫"组合(N 腿)",
  绝不猜;`positions.list` 响应新增 `combos`(净成本、组合盈亏、腿 key 列表)。
  只做展示——追踪与平仓仍按腿。
- 桌面端:组合一张卡(标题"SPX · 买入看跌蝴蝶 7600/7615/7630 · 1 组"),腿各自一行带
  自己的追踪表单;单腿与追踪卡片改用票面名。
- 验收:Python +7(test_legs.py:身份/标签/组合识别/迁移);TS +1 迁移单测 +
  黄金 tracker 新增 legs / track_key / group_legs 三组对拍。

### 持仓归属:追踪只认账户实际持仓(两引擎同步)
用户要求"追踪持仓必须是账户实际持仓"。持仓本来只来自券商查询(IBKR portfolio /
positions、富途持仓查询),已校验未发送、排队、未成交的订单从不进这条路;但 IBKR 侧的
账号是从**合约**上取的,而 ib_insync 把账号放在持仓项上,于是永远取不到 → 所有账户的仓
都记到默认账户名下,别的账户的仓会挂在「模拟」下被追踪。
- broker.py / broker.ts:账号取自持仓项(item.account);券商报了账号但不在别名表里的
  一律跳过(不显示、不追踪),每个账号在 stderr 提醒一次(掩码);没报账号才退默认账户。
- 界面持仓区加说明:只列券商账户实际持仓、只含配置里有别名的账户。
- 验收:Python +4(test_positions.py:归属/兜底/蝴蝶三腿/零仓过滤);TS +1(router
  positions 归属与腿保留)。

### 组合整体追踪 + 盈亏/价格实时(两引擎同步)
用户反馈"四张期权都显示了、只能单独追踪,没有整体追踪,应该优先显示组合价格;
未实现盈亏和价格也要实时更新"。
- **组合虚拟行**(`combo_row` / `with_combos`):每个识别出的组合折成一条 `sec_type=BAG`
  的可追踪行,口径与单腿同一套——数量 N 组,借方=多头 +N、贷方=空头 -N(贷方组合权利金
  缩水才赚,和空头一样);成本 = |Σ腿比例×腿成本|(IBKR 口径含乘数);现价 = |Σ腿比例×腿现价|,
  任何一条腿没现价就是 None,绝不凑数;市值/盈亏累加券商各腿数字。key 带到期与腿签名
  (`+1x7600P,-2x7615P,+1x7630P`)。所有按 key 找持仓的地方(engine 轮询/对账、rpc
  positions.list / tracker.add / close_now)都改走 `with_combos`。
- **组合只提醒、不自动平仓**:平组合要发 BAG 单,这条路没有真机核对;tracker.add 对 BAG
  行拒绝 auto_close / host_at_broker,close_now 对 BAG 追踪拒绝,文案指向"按腿追踪"。
- **期权腿现价**(broker.py `_fill_option_prices`):持仓里的期权腿走常驻 reqMktData
  (每腿一条线路,订阅一次留着),读盘口中间价,没盘口退最新价/标记价;断开时按 ticker
  自己的合约撤订阅。没有这一步组合价格永远是"—"。(TS 侧同样接 subscribeTicker。)
- **本地算盈亏**(rpc `_fill_pnl` / `fillPnl`):券商没报盈亏(positions() 兜底只有成本)
  但有现价时,用追踪器同一套 `unrealized` 算出盈亏与百分比,标 `pnl_source=computed`,
  界面注明"本地按现价计算";对账以券商为准。
- 桌面端:组合一张卡在最前(组合现价、净付/净收、组合盈亏、整组追踪表单;自动平仓与
  托管开关对组合禁用并说明),腿明细折叠在 `<details>` 里可按腿追踪;追踪页每 5 秒
  重读持仓(引擎侧 positions.list 是低优先级请求,不挡用户操作)。
- 黄金对拍新增 `with_combos` 七组样例;Python +5(组合折行/贷方组合/缺价/自定义/
  rpc 端到端),TS 黄金替换。

### K 线"落后实际时间":交易所时区没换成美东(两引擎同步)
用户问"twsapi 给的不应该是实时数据吗"。实测实盘账户对 SPX 是实时权限(marketDataType=1),
5 分钟 K 线最后一根 `11:40:00-05:00` 就是当前这根——数据是实时的。问题在 `bar_timestamp`:
ib_insync 给的是**交易所时区**的 aware datetime(SPX 在 Cboe → 美中),直接 strftime 把
11:40 美中当成 11:40 美东,于是 K 线永远"落后一小时",新鲜度超过 30 分钟就误报。
- broker.py `bar_timestamp`:aware datetime 先 `astimezone(ET)`;原样透出的带时区名字符串
  (`20260902 11:40:00 US/Central`)按 ZoneInfo 换算;没带时区照旧当美东。
- broker.ts `barTimestamp`:第三段是 IANA 时区名时用 tz.ts 的 wallToEpoch/wallParts 换成美东。
- 黄金 broker.bar_timestamp 新增 4 组时区样例;Python +1 测试(aware/UTC/固定偏移/字符串)。

## 阶段状态

| 阶段 | 状态 | 验收 |
|---|---|---|
| 0 勘察 + 黄金对拍基线 | ✅ 完成 | Python 基线 418 项测试全过;11 份黄金数据已生成 |
| 1 工程骨架 | ✅ 完成 | TypeScript strict + vitest + zod(npm,本机无 pnpm) |
| 2 纯函数核心移植 | ✅ 完成 | `tsc --noEmit` 零错误;122 项测试全绿,黄金对拍零超差 |
| 3 存储层(store) | ✅ 完成 | **Python 生成的库文件 TS 直接打开**,折叠/防抖/列表逐字段一致;反向(TS 写 → Python 读)实测通过;append-only 触发器两侧都生效 |
| 4 LLM 层(providers/llm/keychain) | ✅ 完成 | test_providers.py 全部移植;结构化输出降级链路离线可测;**DPAPI 密文跨实现互读实测通过**(TS 写 → Python 解密) |
| 5 券商层 | ✅ 业务层完成 | 定价数学黄金对拍;tws/futu 诊断层、BrokerRouter、FutuRouter 全部离线测试;**真机联调三结论全部保留并有测试钉住**。传输适配器状态见下 |
| 6 engine + rpc + CLI | ✅ 完成 | **71 步 RPC 契约回放逐条一致**(方法表 61 个方法、错误码、中文错误文案、全流程结果);CLI 五个子命令可用;同一配置下两个实现的提示词指纹逐字节一致 |
| 7 桌面端接线 + UI 优化 + 新功能 | ✅ 完成 | Electron 外壳实测拉起 TS 引擎(EngineClient 冒烟全通);期权速记面板与利润回撤追踪平仓上线(两引擎同步、黄金对拍钉住);打包配置就位(实机打包验证见清单) |

**当前验收基线:TS 279 项测试全绿,tsc 零错误;Python 425 项全过(418 + 新功能 7 项)。**

## 阶段 7:桌面端接线 + UI + 新功能

### 引擎接线(desktop/rpc-client.js + main.js)
- EngineClient 增加 TS 引擎路径:**有 `trade-ts/dist` 就优先用**——开发机用系统
  node,打包版用 Electron 自带 Node(ELECTRON_RUN_AS_NODE);`DAFRI_ENGINE=python`
  强制回退,Python 首启引导整条链路原样保留为兜底。
- 端到端冒烟(真实 EngineClient + 真实 TS sidecar):ready 事件、system.status、
  selftest(指纹与 Python 逐字节一致)、策略目录、未连接券商时的正确拒绝文案。
- 打包配置:extraResources 增加 engine-ts(dist + baseline/llm + node_modules);
  打包布局下提示词目录由 `DAFRI_PROMPT_DIR` 显式指向 resources/engine/prompts。
  **实机打包核对清单**(本环境无法执行 electron-builder 全流程):
  ① better-sqlite3 需按 Electron ABI 重编(`electron-rebuild` 或 prebuild);
  ② 打包版首启无 Python 时确认走 TS 引擎、不再触发 venv 引导;
  ③ `npm run dist:win` 后在干净机器上验证。

### UI 优化(按用户习惯,预览台截图验证 + 静态审计零问题)
- **期权速记面板**(交易指令页):速记 chips(`7520的20cm蝴蝶`/call spread/
  卖出铁鹰/权利金上限/补理由,点击插入光标处)+ 默认值一览(1 张 · 0DTE ·
  组合默认 SPX · 蝴蝶默认买入 · N cm=翼宽 N 点 · 末尾数字=权利金上限)。
  **内容与提示词的既定偏好逐条同源**,界面不发明解析器不认识的写法;
  面板可折叠,折叠状态记在本地。
- 持仓追踪表单增加「利润回撤 %」「平仓比例 %」两个字段(见下)。

### 新功能:利润回撤追踪平仓(用户需求)
"当前利润比历史最高利润低 30% 时,卖出 50% 仓位"——
- `targets.profit_drawdown_pct`:利润相对**峰值利润**回撤达阈值时触发。
  峰值利润不新增持久化字段:利润对价格单调,由已持久化的峰值价格换算,
  **重启不丢**;从未盈利(峰值利润 ≤ 0)不触发——谈不上"利润回撤"。
- `auto_close.close_fraction_pct`:触发后平掉持仓的百分比(默认 100 全平)。
  **向下取整、至少 1 股/张、绝不超过持仓**——"一股不多"原则不破;
  触发后落闩逻辑不变(重新启用即武装下一段)。
- 优先级:止损 > 利润回撤 > 止盈(同 tick 都满足时按最坏的算)。
- **两引擎同步实现**(Python tracker.py/rpc.py + TS tracker.ts/rpc.ts),
  Python 新增 7 项测试,黄金对拍重生成并在 TS 侧逐字段钉住
  (含 `利润回撤平仓:卖出 50 AAPL(市价,平 50/101)` 的部分平仓文案)。

## 阶段 6:engine + rpc + CLI

- [src/engine.ts](src/engine.ts):全流程编排逐条移植——解析→硬校验→(auto_execute 闸门)
  →下单→落库→通知;方式 B 盯盘队列(先落闩再发单、批内熔断、触发时刻熔断复查);
  持仓追踪轮询与自动平仓(同一套先落闩纪律);回报入库(推式监听 + 富途拉式
  syncBrokerOrders 归一成同形对象;无主回报缓冲重放,防"快速成交停在 Submitted");
  订单级 errorEvent 终态(110/201/203 只走这条路);券商名跟着生效通道
  (IBKR_ERROR / FUTU_ERROR)。
- [src/rpc.ts](src/rpc.ts):**61 个方法逐个复刻**,stdio 换行分隔 JSON-RPC 2.0,
  stdout 只跑协议(main() 先私有化真 stdout,console.log 全走 stderr);
  settings.patch 拒绝 accounts/connections、账号掩码、llm.patch 白名单、
  期权墙与 PA 的 TTL 节流缓存、AI 三条链路(想法分析/板块选股/条件生成)的
  提示词逐字复制并经软件层复验。
- [src/cli.ts](src/cli.ts):selftest / validate / parse / run / records / idea(s) /
  halt / resume / export / set-key / rpc,危险程度阶梯与确认旗标照旧。
- **契约回放**([tests/golden-rpc.spec.ts](tests/golden-rpc.spec.ts)):Python 版
  RpcServer 在固定时钟(美东 2026-08-14 10:32,盘中)、假 LLM、无券商连接下执行
  71 步请求序列([../trade/scripts/gen_rpc_samples.py](../trade/scripts/gen_rpc_samples.py)),
  归一化(uuid/时间戳/本机路径/机器相关块打掩码,有状态 id 用 $VAR 捕获替换)后
  TS 逐条对拍。覆盖:参数校验错误、§9.6 拒绝面、熔断往返、instruction.submit
  全流程(含模型拒绝落库与 records 折叠汇总)、想法/板块/警告/追踪的完整
  有状态生命周期、券商未连接时的引导文案(跟着生效券商变)。
- 交叉验证:`cli selftest` 在同一配置下,Python 与 TS 的提示词指纹逐字节一致
  (2d8cef827ad186b6),系统提示词字数一致(9731)。
- 两个可回放性修正在契约测试中被抓出:时段相关输出依赖真实时钟(已加可注入
  时钟 setClock,两侧同刻回放);错误文案内嵌 uuid 未被归一化(已改子串掩码)。

## 阶段 5:券商层

按用户指示"能用库就不自己写":IBKR 侧用 @stoqey/ib 的 **IBApiNext**(它扮演
ib_insync 的角色:自动 reqId 配对、订阅管理、Promise/Observable 调用面);
glob 换 Node 内建 `fs.globSync`;erf 换 `@stdlib/math-base-special-erf`
(黄金对拍确认与 Python math.erf 到 1e-15 一致)。

结构:业务语义层 1:1 移植并离线测试;传输层是薄适配器,单独隔离。

| 模块 | 内容 | 验证 |
|---|---|---|
| [src/broker.ts](src/broker.ts) | 纯定价数学(combo mid / AUTO_MID 限价 / bag_signed_limit / 盘口流动性 / 行权价宽度)+ BrokerRouter(路由改道、qualify 12 秒硬超时、1100 第三态、方式 A 条件单、BAG 一律 BUY 提交) | 纯函数黄金对拍(含全部中文守卫报错逐字节);FakeIbSession 注入的 17 项行为测试,含死锁事故那条约束 |
| [src/ibSession.ts](src/ibSession.ts) | IBApiNext 适配器(qualify=getContractDetails、下单=placeNewOrder、行情=getMarketData 流) | ⚠ 待真机:tick 类型映射 / 深度 / greeks 字段名要在 TWS 上核对 |
| [src/tws.ts](src/tws.ts) | 端口探测(真 TCP)/ 应用检测拉起 / 错误翻译 / 握手诊断 / 别名核对 / 指引 | test_tws.py 全部移植(15 项,真 socket) |
| [src/futu.ts](src/futu.ts) | OpenD 检测诊断(tws 的孪生;端口探测复用同一实现) | 假桥注入 |
| [src/futuBroker.ts](src/futuBroker.ts) | FutuRouter 全量:代码换算(查不猜)、指数闸门、订阅额度纪律、parity 反推、交易解锁、拉式回报 + 合成成交、trd_env 核对、熔断只撤自己的单 | test_futu.py 券商层部分移植(21 项);**真机三结论各有专属测试** |
| [src/futuBridge.ts](src/futuBridge.ts) | 富途 SDK 桥接口(与 Python SDK 调用语义逐一对应) | ⚠ npm futu-api 适配待真机——默认桥显式抛"尚未完成真机核对",绝不假装能用 |

**parity 反推整链验证**:FutuRouter.optionChain 在指数上走 put-call parity,
测试构造 S=7500、D=e^(−4%/12) 的干净链,反推现价误差 <0.5 点,`spot_source=parity`。

**传输适配器的真机清单**(阶段 7 后、纸面账户联调时逐项核对):
IBApiNext 的 tick 映射 / PriceCondition 构造 / 深度流;futu-api npm 的全部接口签名。
这与 Python 版当年"接口签名、返回列名、枚举取值全部按真机对过"是同一条必经之路,
离线测试证明的是业务语义,不能替代它。

## 阶段 3:存储层

- [src/store.ts](src/store.ts):**同一份 SCHEMA 字符串、同一组 append-only 触发器**
  (better-sqlite3,WAL + foreign_keys,与 Python 版逐字节相同的 DDL)。
- 兼容性对拍([tests/golden-store.spec.ts](tests/golden-store.spec.ts)):
  夹具由 [../trade/scripts/gen_store_fixture.py](../trade/scripts/gen_store_fixture.py) 用
  Python 版 TradeStore 生成(完整事件流:status/fill/commission/trigger/final/warning
  + watches/tracks/sectors/ideas/audit),TS 打开同一个 .db 文件,get_record 折叠、
  list_records、recent_orders(ValidatedOnly 排除)、各列表与 Python 期望逐字段一致。
- 反向验证:TS 写库 → Python `TradeStore` 完整读回(含触发器拒绝 UPDATE 实测)。
- 时间戳统一 UTC 秒级、"+00:00" 后缀,与 Python isoformat 风格一致;
  record_json 用键排序 JSON(数值表示走 JS 最短形式,读回逐位一致)。

## 阶段 4:LLM 层

- [src/providers.ts](src/providers.ts):Anthropic(@anthropic-ai/sdk)与 OpenAI 兼容
  (fetch)双通道;json_schema → json_object 降级并内嵌 schema 进系统提示词;
  refusal / max_tokens / content_filter 处理;`supportsSamplingParams` 模型闸门;
  错误翻译(`friendlyApiError`)与 Python 文案一致。
- **schema 资产化**:ParseResult / SectorPicks / IdeaAnalysis / PAComment / CustomRules
  五份 JSON Schema 由 Python 版 pydantic 导出并检入 `baseline/llm/`,TS 直接加载
  ——发给 API 的 schema 与 Python 版**完全相同**,不再依赖 zod 的 schema 生成。
  models 变更时重跑导出脚本(报告的「有意差异③」就此消除)。
- 少样本 assistant 消息用浮点感知序列化(`pyDumps`):分隔符 ", "/": " 与
  `7520.0` 的 `.0` 都与 Python `json.dumps(ensure_ascii=False)` 逐字节一致
  ——发到 API 的提示词字节级等同,提示词缓存命中不受迁移影响。
- [src/keychain.ts](src/keychain.ts):macOS `security` 命令;Windows DPAPI 走
  PowerShell `ProtectedData`(零原生依赖),**密文文件、键名、附加熵与 Python 版
  完全相同**——同一份 `credentials.dpapi.json` 两个实现交替读写,实测互通。
- 测试:test_providers.py 逐条移植(base_url 校验、目录、工厂、采样闸门、
  降级链路、截断/内容过滤拒绝、代码围栏、schema 关键字检查、DPAPI 往返)。

## 阶段 5 风险评估(动工前请确认)

券商层的移植基础是 **@stoqey/ib**(TWS API 的 TS 移植,含 EventEmitter 底层与
IBApiNext 响应式封装)。能力核对(文档级,未实测):

| broker.py 需要 | @stoqey/ib 对应 | 风险 |
|---|---|---|
| qualifyContracts | reqContractDetails | 低——但要自建 12 秒硬超时(库层没有) |
| BAG 组合单 | Contract.secType=BAG + comboLegs | 低 |
| 原生条件单(方式 A) | PriceCondition / order.conditions | 中——字段名与语义要按真机核对 |
| 盘口/流式行情 | reqMktData / reqMktDepth | 低 |
| 历史 K 线 + 节流 | reqHistoricalData | 低——TTL 缓存在引擎侧,照搬 |
| 1100/1101/1102 事件 | error/connectionClosed 事件 | 中——「socket 通但无上游」第三态要实测 |
| 行情类型切换(3↔1) | reqMarketDataType | 低 |
| 期权链 | reqSecDefOptParams + reqContractDetails | 低 |
| 账户/持仓 | reqPositions / reqAccountUpdates | 低 |

ib_insync 那层"await 即结果"的便利封装没有对应物,需要自建一层
request/response 关联(reqId 配对 + 超时),这是阶段 5 最大的工作量。
富途侧:npm `futu-api`(官方,protobuf),接口形状与 Python SDK 不同但语义
可映射;五处能力差异照搬为明确拒绝。
测试策略与 Python 版相同:**全部 mock,离线跑**,真机联调留到阶段 6 之后。

## 黄金对拍基线(阶段 0)

- 生成脚本:[../trade/scripts/gen_golden.py](../trade/scripts/gen_golden.py)
- 数据:`baseline/golden/*.json`(11 份,约 600KB,全精度浮点)
- 覆盖:validator 42 例 + 批量、tracker 全函数、priceaction 4 组 K 线全输出、
  optionwall 3 条链 + 数学函数、backtest 11 个策略/品种、alerts 状态机走价序列、
  market 抽取 10 句、research 锚点/情报、config 时段与 14 条配置错误、
  prompts 8 个版本指纹、models 20 例
- 对拍标准:浮点 1e-9 相对容差;**所有中文 message/readout/facts 字符串逐字节相等**
- 重跑方式:`npm run golden`(TS 侧) / `python scripts/gen_golden.py`(重新生成期望值)

## 模块移植对照(阶段 2)

| Python | TypeScript | 对拍 |
|---|---|---|
| models.py(pydantic) | src/models.ts(zod) | ✅ 结构级(见「有意差异」①) |
| config.py | src/config.ts | ✅ 含全部配置错误信息逐字节 |
| validator.py | src/validator.ts | ✅ 42 例 + 批量,拒绝信息逐字节 |
| tracker.py | src/tracker.ts | ✅ |
| priceaction.py | src/priceaction.ts | ✅ 全输出含 readout/facts_text |
| optionwall.py | src/optionwall.ts | ✅ 含 put-call、GEX、翻转位 |
| backtest.py | src/backtest.ts | ✅ 净值曲线 1e-9;erf 用 Cody 有理逼近实现到 double 精度 |
| alerts.py | src/alerts.ts | ✅ 状态机逐步一致 |
| market.py | src/market.ts | ✅ 含 CM 硬排除、CJK 邻接规则 |
| research.py | src/research.ts | ✅ |
| prompts.py | src/prompts.ts + src/pyjson.ts | ✅ 8 版指纹逐字节(浮点感知 JSON) |
| schema.py | src/schemaOut.ts | 单测(见「有意差异」③) |
| killswitch.py | src/killswitch.ts | 单测(时间戳不可对拍) |
| macro.py | src/macro.ts | 单测(网络依赖,注入 fetcher);`VIX/10Y 永不用 ETF 替身` 测试已移植 |
| notify.py | src/notify.ts | 移植(平台副作用,无对拍) |

## Python 行为的兼容层(踩过的坑)

TS 与 Python 的数值/格式化语义差异全部集中在 [src/py.ts](src/py.ts) 与 [src/tz.ts](src/tz.ts):

1. **`pyRound`**:Python round 是十进制平分取偶;`toFixed` 是平分远离零。
   精确平局只发生在二进可表示的值上(46.25、7520.5 这类价格真实存在),
   已用十进制展开精确检测——对拍在 `exposure_pct: 46.25→46.2` 上抓到过一次。
2. **`fmtF`(%.Nf)**:C printf 平分取偶(-12.5 → "-12"),toFixed 给 "-13"。
   对拍在 PA 打分 "-12/100" 上抓到过。
3. **`pyFloat`(str(float))**:整数值带 `.0`("455.0(9077.0 张")、小数与指数
   格式差异。所有 `%s` 插值浮点的中文字符串都靠它。
4. **`pyG`(%g)**:6 位有效数字,订单指纹里的行权价用它。
5. **换行**:Python `read_text` 走 universal newlines(CRLF→LF),Node 不走——
   提示词指纹曾因此全挂,已在读取层归一。
6. **时区**:Node 没有"墙钟→时刻"原语,`tz.ts` 用 Intl 查表 + 迭代校正实现,
   美东/北京双时区与 DST 边界与 zoneinfo 一致(对拍含早收盘日)。
7. **浮点感知 JSON**([src/pyjson.ts](src/pyjson.ts)):`JSON.parse` 会把 `7520.0`
   变成 `7520`,而 Python 指纹里它序列化回 `7520.0`——自带解析器保留 float 标记。

## 有意差异(不影响行为等价的部分)

① **models 校验错误文案**:pydantic 与 zod 的错误消息生成器不同。对拍比较的是
   **决策**(哪条过/哪条拒/拒绝码/降级行为/字段归一化),不比较 pydantic 内部
   文案。用户可见的拒绝信息模板(`解析结果未通过软件层结构校验…`)逐字节一致。
② **notify 非 darwin 平台**:Python 版 print 到 stdout;TS 版写 stderr——
   stdout 只跑 RPC 协议是 §10.1 的纪律,Python 版靠 rpc.main() 里重定向补救,
   TS 版直接不犯。
③ ~~schema 输出形状差异~~ 已消除:阶段 4 起 schema 是 Python 导出的检入资产,
   发给 API 的字节与 Python 版完全相同。
④ **pnpm → npm**:本机无 pnpm,验收命令为 `npx vitest run` / `npx tsc --noEmit`。
⑤ **record_json 的数值表示**:Python 写 `230.0`,TS 写 `230`(JSON 数值读回
   逐位一致,折叠输出对拍已证明无影响);键排序两侧一致。

## 测试移植统计

- Python 基线:418 项(全部通过,17s)
- TS 当前:122 项(黄金对拍 103 + 行为单测 19),全绿,<1s
- 黄金对拍的覆盖面(全输出逐字段、字符串逐字节)超过原单测的断言粒度;
  Python 原测试文件的逐条移植(特别是"必须拒绝"样本集)排在对应模块的后续阶段:
  test_engine / test_rpc / test_tws / test_futu / test_prompts_store_broker(store、broker 部分)
  属于阶段 3–6。

## 下一步(等确认)

阶段 3:store.ts(better-sqlite3,同一份 schema + append-only 触发器,
用 Python 版生成的数据库文件做兼容性对拍)。

## 追加功能(阶段 7 之后):止盈/止损托管到券商服务器

软件盯盘有三个天生短板:轮询间隙漏插针、软件必须开着、本机行情可能延迟。本次把静态目标改为**券商托管**,动态目标由引擎**按秒调整托管单**:

- **托管形态**:止盈 = GTC 限价单;止损 = GTC 停损单;价格跟踪止损 = IBKR 原生 TRAIL 单(用持久化峰值播种初始停损,重启不放开已锁利润);同一追踪的托管单绑成 OCA 组(一张成交,其余自动撤)。触发全部发生在券商服务器的实时行情上,关机也生效。
- **利润回撤的托管化**:利润对价格线性,"利润从峰值回撤 N%" 可换算为一个随峰值棘轮上移的停损价(`profit_trail_stop_price`,与 `evaluate` 的触发条件严格同价,黄金对拍钉住)。引擎按秒对账(`tracker.reconcile`,RPC 第 62 个方法),价格变化 ≥1 美分才改单;软件关掉,停损停在最后一次调整的价位——行情延迟只会让调整偏保守(停损更松),绝不影响券商侧触发。
- **对账循环**(两引擎同构实现):挂缺的、改变了的(同 orderId 改单,不留无保护窗口)、撤多余的(托管关闭/闸门落下/持仓消失/追踪删除);`orderRef=trk:<id>:<kind>` 幂等,重启先认领再对账,不重挂不漏挂;托管单成交 → 追踪落闩,软件永不补第二枪;`host_at_broker` 开启时软件盯盘只算不发(防双重平仓)。挂托管单同样过授权闸门(auto_execute/实盘开关/熔断),失去授权即撤回。富途账户在设置那一刻即拒绝(OpenD 无同形 GTC+OCA/TRAIL)。
- **UI**:追踪表单新增「止盈/止损托管到券商(IBKR)」开关(强制与"到价自动平仓"联动 + 专用确认);追踪卡片显示托管单 chips(利润回撤动态停损标注"秒级调整")与行情延迟徽标;renderer 每秒驱动 reconcile,窗口 `backgroundThrottling:false` 保证最小化不停摆。
- **测试**:Python 443(+18:托管纯函数 10、engine 对账 8)/ TS 291(+12)全绿;黄金对拍新增 `profit_trail_stop`、`hosted_plan`、`hosted_needs_update` 三节;RPC 契约样本扩到 72 步(未连接时 reconcile 安静空转)。真机核对项:GTC/OCA/TRAIL 的 IBApiNext 参数映射、110 价格档位、改单竞态——与既有 TWS 真机清单合并执行。
