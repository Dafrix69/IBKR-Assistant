# datrix guard — 第 1 节核实结果

本文件只记任务书第 1 节「先核实再动手」的结论,以及据此要你拍板的事。代码一行没写。
账户层面的具体数字(净值、持仓、各标的单数)不进仓库,放在本机的 `guard/state/account-snapshot-2026-11-06.md`;`state/`、`logs/` 已由 `guard/.gitignore` 挡住,仓库是公开的。

> **定了:方案 B,做进 C++ 引擎。** Step 1 的实现、口径与默认值见 [docs/features/guard.md](../docs/features/guard.md),
> 用法见 [docs/user-guide/07-交易纪律守护.md](../docs/user-guide/07-交易纪律守护.md)。下面是做之前的核实记录,原样留着。

## 0. 和任务书前提不符的地方

任务书写「复用项目里已有的 ib_async 连接层」,用 Python。**datrix-qt 里没有 ib_async,也没有任何 Python 连接层。**
Datrix 是 C++ 引擎(`native/engine/`),TWS 线协议是自己写的(`native/engine/execution/tws/`)。仓库里的 `.py` 只有变异测试脚本与研究脚本。
`docs/features/dependencies.md` 的「刻意不引入」表里没有 Python 或 ib_async,所以加它不违反现有规矩,但它是一套新运行时。

因此「复用」这条做不到,只能二选一:

| 方案 | 做法 | 好处 | 代价 |
|---|---|---|---|
| A. 独立 Python 进程 | `guard/` 用 ib_async 自己连 TWS,单独的 clientId | 正合任务书「要能单独跑」;Datrix 关着也照跑;能放到另一台机器 | 新依赖与新运行时;和 Datrix 引擎是两套止损逻辑,可能互相打架(都去补挂、都去撤) |
| B. 做进 C++ 引擎 | 在已有的「持仓追踪」上加 gate 与强制止损 | 「持仓追踪」已经有托管到券商:正股 STP、GTC、OCA、`outsideRth`、orderRef 认领、重启后对账。纸面账户上跑通的是组合的托管、原地改价、关掉应用后单子还在、重启认领;正股 STP 托管本身没有真机核对记录 | 依赖 Datrix 整个应用开着;任务书第 6 节「不依赖 datrix 其他模块」做不到 |

两点和方案选择有关的现状:

- 「持仓追踪」(`docs/features/tracker.md`)已经覆盖任务书 Step 2 的大半:股票的服务器端止损、跟踪止损、组合按中间价盯盘、到点平仓、标的止损价、追价平仓。本地库里追踪表现在是 0 条,也就是这条路径你没在用。
- 你说过「以后只改 qt」。方案 A 不改 Qt 应用,是旁边单独一个进程;这算不算违背那句话,要你说。

## 1. 连接方式

| 项 | 结论 | 依据 |
|---|---|---|
| TWS 还是 Gateway | TWS 桌面版,跑在这台 Mac 上 | 进程是 Java 应用,不是 IB Gateway |
| 端口 | 实盘 7496 在监听,而且监听的是所有网卡;纸面 7497 没在监听 | `lsof` |
| 是否纸面 | Datrix 默认账户是实盘「主账户」;配置里的纸面账户是占位号 `DU0000000` | `~/Library/Application Support/Datrix/settings.json` |
| clientId | Datrix 用 12(实盘)、11(纸面);探测连接再加 90 | 同上与 `tws_detect.cpp` |
| 每日断线 | TWS 设置的自动登出在北京 23:45,自动重启是关的;冬令时下就是美东 10:45,正在盘中 | 记忆里 10-28 与 11-03 的记录;本节没有重新到 TWS 设置里核对 |

**影响:** 任务书 2.5 与 3.4 的验收全部要纸面账户。现在纸面 TWS 没开,纸面账号也没配。
如果 guard 跑在 RTX 台式机上,还要在这台 Mac 的 TWS 里把台式机加进受信 IP,或者台式机上自己登一个 TWS / Gateway。

## 2. 下单走哪里,手动单占多少

- 程序下单只有一个出口:`native/engine/execution/broker_orders.cpp` 调 `IbSession::placeOrder`(新单、托管单、改单三处)。程序单都把 `orderRef` 写成记录 id 或 `trk:` 前缀,所以凭 `orderRef` 是否为空能分出手动单。
- 本地成交库 2026-10-01 起的全部订单都是 TWS 手动下的,程序单没有一张成交。程序指令一共 16 条,只有 2026-09-30 一张 SPX 蝶成交。
- 本地成交库停在 2026-11-04 08:06 UTC,之后的成交(包括现在的 QQQ 蝶)没同步进来。

**影响:** 任务书 2.1 的「在下单函数前 raise」几乎拦不到任何东西。实际要做的是第二种:监听新仓位,发现没有意图记录就推送,60 秒内没补录就按默认规则强制挂止损。
补录意图在不做界面的前提下只能是编辑一个文件或敲一条命令。手动买完股票后 60 秒内写好止损价、理由、thesis、invalidation,时间偏紧,你要不要放宽到比如 5 分钟,或者先挂默认止损、补录后再改到你的价。

## 3. IBKR 的止损单什么情况下保留

原文都从 IBKR 官网取下并逐句核对过,每条后面是出处。

| 情况 | 结论 | 把握 | 出处 |
|---|---|---|---|
| API 客户端断线 | 止损单留在 IBKR,继续有效。断线只结束这个客户端的请求;TWS API 没有「断线即撤单」的设置,能一次撤全部的只有主动调用的 `reqGlobalCancel` | 中高:没有一句原话直说,是三处文档合起来推的 | [断开连接](https://www.interactivebrokers.com/docs/tws-api/sync-doc/disconnect-stop-connection.md)、[API 设置字段表](https://www.interactivebrokers.com/docs/tws-api/protobuf/api-settings-config.md)、[撤单](https://www.interactivebrokers.com/docs/tws-api/doc/orders/cancel-order.md) |
| 关掉 TWS、每日自动登出 | 留在 IBKR。美股各交易所的 Stop、Trailing Stop、GTC 都是 IBKR 服务器「模拟」的单型,存在 IBKR 系统里,不在本机 TWS 里 | 高(模拟单存在 IBKR);中高(关 TWS 后仍有效,直接说这句的是 IBKR 员工在官网课程下的回复) | [NYSE 等交易所单型表](https://www.interactivebrokers.com/en/trading/exchanges.php?exch=NYSE&showcategories=STK)、[订单状态颜色](https://www.ibkrguides.com/traderworkstation/order-status-colors.htm)、[员工回复](https://www.interactivebrokers.com/campus/trading-lessons/conditional-orders/) |
| 「TWS 关着时订单被删」那句 | 只管 TWS 与 IBKR 之间断开期间、IBKR 还没收下的新单,不是说关 TWS 会撤掉已挂的单 | 高 | [智能重发](https://www.interactivebrokers.com/docs/tws-api/doc/tws-settings/intelligent-order-resubmission.md) |
| IBKR 每日系统重置 | 北美时段 00:15–01:45 ET 内,模拟单的触发会推迟到重置结束 | 高 | [系统状态](https://www.interactivebrokers.com/en/software/systemStatus.php) |
| 周末 | GTC 留着;DAY 当天收盘即失效。GTC 遇到拆股、超过前收 3% 的分红或特别股息、90 天没登录、下下个季度末会被自动撤 | 高 | [GTC](https://www.interactivebrokers.com/en/trading/orders/gtc.php) |
| 盘前盘后 | **普通 STP 在常规时段以外不触发。** API 文档说 `outsideRth` 让单子「在常规时段外也能触发或成交」,但 IBKR 员工两次明确回复普通 Stop 盘外不工作,盘外要用 STP LMT | 中:官方说法互相矛盾,员工回复更具体 | [Order 字段](https://www.interactivebrokers.com/docs/tws-api/ref/order.md)、[员工回复一](https://www.interactivebrokers.com/campus/trading-lessons/trading-outside-regular-trading-hours-rth/)、[员工回复二](https://www.interactivebrokers.com/campus/trading-lessons/ibkr-desktop-stop-limit-orders/) |
| 夜盘 | IBKR 夜盘场所 IBEOS 只有原生限价单,单型表里没有 Stop | 高 | 同交易所单型表 |
| 三腿蝶挂 STP | 文档把 BAG 列进 Stop 可用的品种,但 2026-10-28 在实盘 TWS 上试算,三腿蝶拒 STP、接受 STP LMT | 低(文档与实测不符,以实测为准) | [基本单型](https://interactivebrokers.github.io/tws-api/basic_orders.html);实测是之前一次会话里的试算,没有落进仓库,`docs/features/tracker.md` 仍写着「没核对过」 |

**看得见、动得了手动单吗**(这决定 guard 怎么监听):

- 非 0 的 clientId 只收到自己下的单的 `openOrder` / `execDetails`。要实时收到 TWS 手动单,guard 得用 **clientId 0** 连,或者在 TWS 里把「主 API 客户端 ID」设成 guard 的 id;后者对手动单是否生效,文档没写清楚。出处:[主客户端 ID](https://www.interactivebrokers.com/docs/tws-api/doc/order-management/master-client-id.md)、[未成交单](https://www.interactivebrokers.com/docs/tws-api/doc/order-management/open-orders.md)。
- 别的客户端和 TWS 界面下的单,API 不能单独撤或改;clientId 0 可以「绑定」手动单再改,但绑定会撤了重下,丢排队位置。出处:[改单](https://www.interactivebrokers.com/docs/tws-api/doc/orders/modify-order.md)。这和任务书「不能撤别人的单,但可以强制配止损」一致:guard 只新挂自己的止损单。
- 反过来,**你在 TWS 里手动撤 guard 挂的止损单是可以的**,guard 靠对账发现、重新挂上,正合 3.3。

**对设计的影响:**

1. 断线、关 TWS、自动登出都不会让已挂的止损单消失,所以「重连后对账补挂」是兜底,不是止损生效的前提。仍然要做,用来补断线期间新开、还没配止损的仓位。
2. 任务书要求股票止损用 STP、`outsideRth` 默认 True、不准用 STP LMT。按 IBKR 员工的说法,普通 STP 盘前盘后不触发,夜盘更是没有 Stop。你的持仓如果在盘后跳空,STP 要等到 9:30 开盘才触发,以开盘价附近成交。这正是你要的「接受滑点换确定性」,只是保护从开盘才开始。要不要在盘外另加一层,要你定。
3. Datrix「持仓追踪」的文档写着正股托管 STP 打了 `outsideRth`「盘前盘后在券商侧也能触发」。按上面的员工回复,这句很可能不对,而且没在真机上核对过。这是现有功能的问题,不属于 guard,单独记在这里。
4. guard 若用 clientId 0,同一时间只能有它一个用 0;Datrix 用的是 11、12,不冲突。

## 4. 当前持仓结构

- 正股一只,没有任何止损单;账户里现在一张挂单都没有。
- 期权:两只三腿 call 蝶,同一标的、同一到期日、行权价交错;另有一张单腿 call。
- **组合能不能认成一组:** IBKR 的持仓接口按腿给,不给分组;两只蝶的中腿都是 −2,只看持仓分不出来哪条腿属于哪只蝶。
  能分组的依据是开仓成交:每只蝶都是一张组合单成交,三条腿共用一个 order_id / permId。所以分组要靠近 7 天的成交回报(`reqExecutions`),不能靠 Datrix 本地成交库,本地库在 11-04 之后就没同步。超过 7 天的老仓位只能人工录意图时写明组成。
- 配置里有两个实盘账户。IBKR 连接器只看到一个。guard 管哪几个账户要你定。

## 5. 要你拍板的事

1. 方案 A(独立 Python + ib_async)还是方案 B(做进 C++ 引擎的持仓追踪)。
2. 纸面账户:有没有纸面登录?纸面 TWS 能不能和实盘 TWS 在这台 Mac 上同时开?
3. 手动单补录意图的时限:60 秒,还是放宽。
4. guard 管哪几个实盘账户。
5. guard 跑在这台 Mac 还是 RTX 台式机。
6. 股票止损盘外怎么办:只挂 STP(盘外不触发,开盘才止损),还是盘外再由程序按价格盯着、到价发限价单平。后者是程序层的备份,掉线就没了。
7. guard 用 clientId 0 连 TWS,好收到你手动下的单。可以吗?
