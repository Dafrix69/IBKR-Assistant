# FINDINGS —— 重写过程中发现的疑似问题(只记录,不修改)

## [trade/src/ibkr_agent/config.py:504-509] `_assert_account_connections` 里的死分支
**类型**:死代码
**现状**:循环体内 `if not acct.is_paper and not settings.policies.allow_live_trading: continue`
是循环最后一条语句,continue 与自然结束等价,整个分支无效果。
**为什么可疑**:从注释看原意可能是想对"配置了实盘账户但未开 allow_live_trading"的
情况做点什么(警告或标记),写成了空操作。当前行为无害(下单时 validator 会拦),
但注释与代码不符。
**建议**:删掉该分支或补上原本想做的警告。(未实施)

## [trade/src/ibkr_agent/prompts.py:143-146] `_num` 的精度上限
**类型**:边界情况
**现状**:非整数限额用 `"%f"`(固定 6 位小数)再去尾零。小于 1e-6 的限额会渲染成 "0"。
**为什么可疑**:限额配置有 `minimum=0.01` 兜底,实际打不到;但若未来放宽,
提示词里会出现 "单笔上限 0 USD"。
**建议**:改用 repr 或显式位数。(未实施;TS 版按现行为逐字节复刻)

## [trade/src/ibkr_agent/optionwall.py:85] `_opt_float` 对布尔值的处理
**类型**:边界情况
**现状**:`float(True)` 在 Python 合法(=1.0),链数据里若混入布尔 gamma/iv 会被当成 1.0。
**为什么可疑**:1.0 的 IV 是合法值域内的极端值,静默接受会污染 GEX。
**建议**:显式排除 bool。(未实施;TS 版 Number(true)=1 行为一致)

## [trade/src/ibkr_agent/rpc.py:1256-1282 / trade-ts/src/rpc.ts trackerUpdate] `tracker.update` 改目标价不过 `tk.validate`
**类型**:校验缺口(2026-09-03 模拟盘实测)
**现状**:`tracker.add` 会用 `tk.validate()` 拦方向写反的目标(多头止盈低于现价、止损高于止盈等),
但 `tracker.update` 改 `take_profit` / `stop_loss` 时直接写库。实测对多头 AAPL 持仓
把止盈改成 320、止损 322(止盈低于止损、且低于现价)被原样接受。
**为什么可疑**:README「算错了会赔钱的三个地方 · 方向」承诺"设置时就拦";改成这样的目标在下一轮
`evaluate()` 里 `hit_take` 立刻为真,开盘第一轮轮询就会平仓——正是 add 那道检查要防的事。
**建议**:update 里合并现有 targets 后同样跑 `tk.validate(position, targets, market_price)`
(现价拿不到时至少做止盈/止损相对顺序检查)。两侧引擎都要改。(未实施)

## [trade/src/ibkr_agent/engine.py sync_broker_orders / _wire_session] IBKR 断线期间的成交不会回填
**类型**:记录缺口(2026-09-03 模拟盘实测)
**现状**:IBKR 通道只靠事件监听入库;富途才有 `poll_order_updates` 拉取。用 CLI/短连接发单后
进程断开,单子随后在盘前成交,重新连接后 `pending.poll` 的 `synced=0`,记录停在 `Submitted`,
`fills=[]`、`avg_fill_price=null`,而 TWS 侧持仓已是 1 股 @ 326。
**为什么可疑**:桌面端常驻连接时没问题,但 `python -m ibkr_agent run` 这条命令行路径、以及
桌面端重启/TWS 重启期间成交的单,都会永久停在 Submitted——"自动记录每笔交易"在这些场景是空话。
**建议**:IBKR 通道在 `_wire_session` 时用 `reqExecutions` / `reqCompletedOrders` 按 record 的
`order_id`/`perm_id` 回填成交与终态。(未实施)

## [trade/src/ibkr_agent/broker.py:1233] Python `positions()` 读 `item.unrealizedPnL`,ib_insync 的字段是 `unrealizedPNL`
**类型**:属性名错误(2026-09-03 模拟盘实测,持仓非空时必现)
**现状**:`AttributeError: 'PortfolioItem' object has no attribute 'unrealizedPnL'`,`positions.list` 与追踪轮询整体失败。
`PortfolioItem._fields` 里是 `unrealizedPNL` / `realizedPNL`。TS 版用的是自己的 session 映射,不受影响。
**建议**:改成 `item.unrealizedPNL`(以及同函数里其它 PnL 字段名),补一条带假 PortfolioItem 的单测。
**已实施(2026-09-04)**:`broker.py:1349` 改为 `item.unrealizedPNL`。同函数其余 PnL 字段已按
`ib_insync` 的真实字段名逐个核对过——写了一次性扫描,把 `broker.py` / `ibtrades.py` 里所有属性
访问对照 15 个 ib_insync 类型的字段集比大小写,除本条外没有第二处。
根因是 fixture:`test_positions.py` 原先用 `SimpleNamespace(unrealizedPnL=...)`,假对象你写什么
字段它就有什么字段,于是测试跟着代码一起错、全绿。现已换成带 `__slots__` + 构造校验的替身
(字段名写错当场 AssertionError),外加一条 `importorskip` 的测试断言替身字段名与真库一致。
反向验证过:把代码改回旧拼写,`test_positions.py` 立刻红。

## [trade/src/ibkr_agent/config.py:155 / trade-ts/src/config.ts] 两侧引擎默认 db_path 在 Windows 上落到不同文件
**类型**:配置解释不一致(2026-09-03 实测)
**现状**:配置里 `storage.db_path` 是 `~/Library/Application Support/dafri/trades.db`。TS 引擎与 Python 引擎在
Windows 上展开 `~` 后指向了不同的库:Python 侧 `records.list` 只看到 2026-09-02 的旧记录(DU***779),
TS 侧才有今天的记录。用 `DAFRI_ENGINE=python` 切引擎时交易记录、追踪、想法全部"消失"。
**建议**:统一 `~` 展开(或 Windows 上默认落到 `%APPDATA%\dafri`),并在 `system.status` 里回显实际 db 路径。
**已实施(2026-09-04)**:根因是 `trade-ts/src/config.ts` 里 `settings.db_path = String(storage["db_path"])`
——直接用字符串,不展开 `~`。Node 把 `~` 当成普通目录名、相对 cwd 建出来,于是:
Python 打开家目录下的 `Library/Application Support/dafri/trades.db`(434 KB),
TS 打开 `<cwd>/~/Library/Application Support/dafri/trades.db`(4 KB,WAL 却有 1.5 MB)。
项目根目录下那个叫 `~` 的文件夹就是这么来的。默认值本来是对的(用了 `os.homedir()`),
只有配置里显式写 `~/…` 才踩。现已加 `expandHome()`(对应 Python 的 `Path.expanduser()`),
两侧现在打开同一个文件(实测同为 434176 字节)。两边各加了单测:
Python `test_prompts_store_broker.py` 的 tilde 用例、TS `unit-side.spec.ts` 的"db_path 家目录展开"。
**遗留**:`<项目根>/~/Library/Application Support/dafri/` 下那份旧库里有 TS 引擎写过的记录
(WAL 未 checkpoint),没有自动合并——要不要并回主库由用户决定。


## [validator.py / validator.ts] 下单侧用正股日历判期权时段
**类型**:时段判定错误(2026-09-04 纸面账户实测)
**现状**:`Validator` 构造时算一个全局 `market_status` 给所有订单用,来自 `Settings.market_status`
——那是照**美股正股**写的(4:00 盘前 / 9:30 盘中 / 16:00 盘后 / 20:00 休市)。美东 01:2x 提交一张
当日到期的 SPX 蝶,界面回「当前休市,订单将挂到下一个交易时段」,而 IBKR 报的 SPXW 那时正在
隔夜段(US/Central `19:15–次日 08:25`,即美东 20:15–09:25)里,能成交。
**已实施(2026-09-04)**:`Validator` 增加可选的 `market_status_fn`(TS: `marketStatusFn`)与
`status_for(order)`;engine 注入按合约的时段,来源与追踪那条路同一个 `broker.contract_hours`。
TS 侧校验链路是同步的,所以 engine 在构造 Validator 前先 `prewarmContractHours()` 预热按日缓存
——首次下单恰恰是缓存空的时候,那正是这个 bug 发生的场景。新增第三种状态「盘外」,与盘前/盘后
同等对待(能交易、只收限价单、要打 outsideRth),`EXTENDED_STATUSES` 两侧同步。
修复后同一条指令的警告变成「当前为盘外,outsideRth=false,订单要等到常规时段才会成交」。


## [broker.py auto_mid_limit / broker.ts autoMidLimit] AUTO_MID 定价不对齐最小价格变动
**类型**:下单被券商退回(2026-09-04 纸面账户实测,必现)
**现状**:`auto_mid_limit` 只做 `round(limit, 4)`,不把结果对齐到合约的最小跳动。
一张 SPX 蝶的组合中间价 0.125 + 滑点 0.05 = **0.1750**——那是 3.5 个 tick,IBKR 当场退单:
`110 价格不符合该合约的最小价格变动要求`。界面上先显示"已提交·订单号 64",随后状态轨迹
变成 `Submitted → Error`,单子根本没进订单簿。平仓那条路(`close_limit_price`)本来就有
tick 对齐,开仓这条漏了。
**根因**:IBKR 对 BAG 不给 contractDetails(`'BAG' isn't supported for contract data request`),
所以拿不到组合自己的 minTick;但每条 SPX 期权腿实测 `minTick=0.05`,组合净价按同一档走。
**已实施(2026-09-04)**:新增 `DEFAULT_COMBO_TICK=0.05` 与 `align_tick_up/down`,
`auto_mid_limit` 先对齐再夹翼宽上限。方向统一向上——与 `+slippage` 的让价方向一致:
借方多付一点、贷方少收一点,都朝更容易成交的方向,不会把本来能成的单改成挂着不动。
whatIf 真机复验:`0.1750 → 110 拒`,`0.20 → 通过`。两侧各加单测,黄金对拍加了 6 条
`tick_*` 用例与 `align_tick` 表。
**遗留**:tick 目前是常量。更严谨的做法是从腿的 `contractDetails.minTick` 取最严的一个
(SPX 全是 0.05,但别的标的未必),留待需要时再做。
