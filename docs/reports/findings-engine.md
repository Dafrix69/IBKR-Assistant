

## [broker.py leg_quotes / broker.ts legQuotes] 取腿盘口不撤订阅,漏光行情线路后 AUTO_MID 永远拿不到报价
**类型**:盘中必现的退化(2026-09-04 纸面账户实测)
**现状**:每次解析 AUTO_MID 组合,三条腿各 `reqMktData` 一次,**从不 `cancelMktData`**——broker 里另外
四处取行情都撤了,唯独这里没有。一天反复解析几十次后行情线路配额(约 100 条)漏光,TWS 对新请求
回 `101 Max number of tickers has been reached`,所有腿 ticker 永远 NaN → 归零 → 守卫拒单,界面只剩
"盘口不可用(bid=0.0 ask=0.0)"。同一 TWS 用新 clientId 请求同一合约 0.5 秒就有盘口,证明不是订阅问题。
同时三腿**串行**各等满 4 秒,加上同一条拥塞连接上的合约确认往返,"毫秒级本地解析"全链路 17–23 秒。
错误回调只接 1100/1101/1102,101 / 354 / 10167 这些行情类错误码全被丢掉,用户无从得知原因。
**已实施(2026-09-04)**:两侧同步——
1. 各腿一起订阅、一起轮询,上限 4 秒为**全部腿合计**(`_QUOTE_WAIT` / `QUOTE_WAIT_MS`);
2. `finally` 里逐腿 `cancelMktData` / `cancelTicker`,异常路径同样撤;
3. 取盘口期间临时挂 errorEvent,收集 `_MD_ERROR_CODES` / `MD_ERROR_CODES`(101、354、10089、10090、10091、
   10167、10168、10197),缺盘口且有错误码时抛翻译后的 BrokerError(`_quote_error_message` / `quoteErrorMessage`,
   两侧文案一致);报价齐了则忽略错误码,无错误码时仍回零值交守卫(行为不变)。
4. 三腿合约确认合并成一次往返(`_qualify_all_or_raise` / `qualifyAllOrRaise`,TS 侧从 buildBag 抽出复用)。
TS 会话层新增 `offError`(`IbSession` 接口可选方法)。
测试:Python `tests/test_leg_quotes.py` 9 条;TS `broker-router.spec.ts` 「盘口定价」6 条。
纯 I/O 编排,不涉及黄金对拍与 RPC 契约,未重生成基线。
**遗留**:已经漏出去的线路要重连 TWS 才释放(顶栏「断开 TWS」再连)。
