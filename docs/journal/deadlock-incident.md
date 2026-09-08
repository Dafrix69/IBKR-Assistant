# 一次死锁事故与它留下的约束

实盘联调时撞到过一次:界面整个变砖,连不碰券商的 `system.status` 都连续超时 159 次。
链条是这样的:

1. `Error 1100` —— **TWS 与 IBKR 服务器**之间断了(不是本机和 TWS 之间);
2. 本机到 TWS 的 socket 仍然活着,`ib.isConnected()` 仍然是 `True`,`sessions()` 照常放行;
3. 于是 `qualifyContracts()` 发得出去、却永远等不到回应 —— 它是 ib_insync 里**唯一没有
   `timeout` 参数**的阻塞调用(`reqHistoricalData` 自带 `timeout=60`,反而是安全的);
4. RPC 服务是**串行**的:这一次阻塞把后面所有请求堵在管道里,整个应用跟着死。

留下三条约束:

| 约束 | 落点 |
|---|---|
| 合约确认必须有硬超时(12 秒),宁可报错不能挂着 | `broker.py: _qualify_or_raise` |
| 要能分辨「socket 通但 TWS 没上游」——`isConnected()` 分辨不出来,只能靠 1100/1101/1102 事件 | `broker.py: _on_ib_connectivity`,顶栏第三态「TWS 上游中断」 |
| 界面的周期性轮询一律防叠加:引擎慢的时候不该攒出一队请求 | `app.js` 的 `statusPoll` / `macro.inFlight` / `auto.running` |

`test_qualify_times_out_instead_of_wedging_the_whole_engine` 钉着第一条。

**尚未解决**:RPC 服务本身仍是串行的,任何一个慢调用都会拖住其他请求。上面做的是
「不让它无限期挂住」,不是「让它并发」。真要根治得给 sidecar 加工作线程或按方法分流。
