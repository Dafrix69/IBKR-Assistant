# 期权墙、宏观行情一直「超时(120s)」,重连也不好(2026-11-03,实盘 TWS,打包版)

起因是「交易指令」页墙条的一张截图:SPX、QQQ 两行都是「调用 options.wall 超时(120s)」,一直不恢复。

**根因:读道 4 个名额被 4 个永远等不到 TWS 回音的读请求占死,引擎层没有期限,之后所有读道方法都排在后面等到界面超时。**

## 经过

时间是北京时间(`qt-main.log`),美东减 13 小时。打包版 14:42 启动(引擎 pid 19791)。

| 北京 | 事 |
|---|---|
| 17:36:51.957 | 「慢请求 options.wall 2800 ms」 |
| 17:36:52.116 | 「慢请求 macro.board 150 ms,排队 2800 ms」「慢请求 options.spot 0 ms,排队 2950 ms」:4 个名额那一刻全占着 |
| 17:38:54 | 第一行「宏观行情读取失败:调用 macro.board 超时(120s)」,之后每两分钟一行,到 19:22 没断过 |
| 17:42:30 起 | 每十分钟那行 `[perf]` 里再没有任何读道方法(`options.wall`、`macro.board`、`options.spot`、`positions.list`……);本地道、交易道(`alerts.poll` 60 次 / 10 分钟)照常 |
| 19:2x | `sample 19791`:主线程 2409/2466 次停在 `poll`,引擎没有卡在计算上,是协程在等一个不来的回调 |
| 19:2x | `lsof`:引擎到 7496 的连接 `ESTABLISHED`,TWS 进程在;17:37 之后没有「撤掉重订」那类行情看门狗的日志 |

日志里 `options.wall` 最长的一次 run 是 5 110 731 ms(85 分钟):这些等待有时会很久之后回来,有时不回来。

## 机制

- 读道最多 `kReadConcurrency = 4` 个并发,名额在 handler 答完时才还。引擎这一层没有期限;界面每个调用等 120 s 就放弃,但引擎里的请求还占着名额。
- 墙走的是 `BrokerRouter::optionChain` → `optionExpiries` → `IbApiNextSession::secDefOptParams`;夜盘取现价还会走 `futuresSpot` → `historicalData`。这两样在 `ib_session.cpp` 里直接 `co_await` IB 的回应,没有上限。合约确认、交易时段、`getManagedAccounts` 早就套了 `withTimeout`。
- 日志说不出 17:36 之后是哪一个 await 没回来(没有在途请求的记录),所以两层都补。

## 改法

- `RpcServer` 读道加期限 `kReadDeadlineMs = 110 s`,从收到算起(含排队),按醒着的时间算:过了就回 -32020、让出名额、记一行 stderr;handler 之后再答完,结果丢弃、不写第二个回执;排队就过了期限的不再去跑。110 s 比界面的 120 s 短,界面看到的是引擎说的原因。
- `historicalData` 90 s、`secDefOptParams` 30 s 的上限(`withTimeout`)。超时不撤 TWS 那边的请求。
- 交易道没有加期限:半路放弃一张在发的单比堵住更糟。交易道同样可能被一个不回的 await 堵死,这一条留着。
