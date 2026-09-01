# 订单簿(Order Book)知识手册 — 面向本项目

> 放在 docs/ 下作为项目参考;配套代码见 `ibkr/depth.py`。
> 目标:让平台从"只看 K 线"升级到理解盘口微观结构,并用它改进执行假设与日内研究。

## 1. 基本概念

限价订单簿(LOB)是交易所撮合的核心数据结构:买单按价格从高到低、卖单从低到高排队,同价位按时间先后(price-time priority)。

- **L1(top of book)**:最优买价 bid、最优卖价 ask 及各自挂单量。IBKR 的 `reqMktData` / `reqTickByTickData("BidAsk")` 给的就是这层。
- **L2(market depth)**:各价位的聚合挂单量,通常取 top 5~10 档。IBKR 用 `reqMktDepth` 获取,需付费订阅(美股常见为 NASDAQ TotalView / ArcaBook 等)。
- **L3(market by order)**:逐笔订单级别,零售渠道基本拿不到,不指望。

关键术语:spread(ask-bid,流动性成本的直接体现)、mid((bid+ask)/2)、depth(某档/前 k 档挂单量)、市价单吃流动性(taker)、限价单提供流动性(maker)、队列位置(同价位排队越靠前越先成交)、冰山单(显示量小于真实量)。

## 2. 核心微观结构特征(公式)

以下均可由 `ibkr/depth.py` 的采集数据直接计算:

**Spread 与相对价差**
`spread = ask1 - bid1`;`rel_spread_bps = spread / mid * 10000`。相对价差是滑点建模的基础量。

**Microprice(挂单量加权中间价)**
`micro = (ask_size1 * bid1 + bid_size1 * ask1) / (bid_size1 + ask_size1)`
比 mid 更接近"下一笔成交价"的无偏估计:买盘厚时 micro 被推向 ask,反之亦然。

**订单簿失衡 OBI(top-k)**
`OBI_k = (Σ bid_size_i - Σ ask_size_i) / (Σ bid_size_i + Σ ask_size_i)`,i=1..k
取值 [-1,1],正值表示买压占优。是最常用的短时方向特征,预测力集中在秒级到分钟级,衰减很快。

**订单流失衡 OFI(Cont-Kukanov-Stoikov)**
对相邻两个快照,买侧:bid 价升→ +当前 bid_size;bid 价降→ -上期 bid_size;价不变→ size 差值。卖侧对称取负。OFI 累积量与短期价格变动近似线性关系,比 OBI 更"因果"。

**成交方向标注(Lee-Ready)**
成交价 > mid → 主动买;< mid → 主动卖;= mid 时用 tick rule(比上一笔成交价高为买)。由此可得签名成交量、买卖成交比,衡量主动性资金方向。

## 3. 对本项目的实际用途(按价值排序)

1. **实证滑点表(最优先)**:现在 settings.yaml 对所有标的统一 5bps 滑点。录几天真实盘口后,按标的算出 `median_rel_spread_bps / 2 + 冲击项`,生成 per-symbol 滑点配置回填给 backtrader。小市值/低流动性标的的真实成本往往远高于 5bps,这直接改变回测结论的可信度。
2. **入场时机过滤**:EOD 信号在次日执行时,可用开盘后的 spread 与 OBI 决定"立即市价 / 挂 mid 限价 / 等半小时"——同一策略,执行层面就能省出可观成本。
3. **日内信号研究**:OBI/OFI 对秒~分钟级 mid 变动的预测力研究(notebooks),是走向日内策略的第一课。
4. **异常检测**:spread 突然拉宽、深度骤减常先于剧烈波动,可作为风控告警输入。

## 4. IBKR 接入须知(踩坑清单)

- `reqMktDepth` 需要 L2 数据订阅,无订阅返回空;先用 `reqTickByTickData("BidAsk")`(L1)起步,第 2 节多数特征只需 L1。
- `isSmartDepth=True` 聚合多交易所深度(推荐研究用);False 则看单一交易所。
- 深度订阅占用行情数据线路(默认账户约 100 条线路,深度按 1 条/标的计,且同时深度订阅数另有上限,通常 3 起步、随权益增加),不要一次订阅整个 universe。
- API pacing:约 50 msg/s 上限;深度数据量大,录制时**在本地聚合采样**(如 1~5 Hz 快照)再落盘,不要每次 update 都写盘。
- 快照数据(snapshot=True)不占线路但有节流,不适合连续录制。
- 无实时订阅时行情延迟 15 分钟,研究失真,录制务必确认数据是实时的(`ib.reqMarketDataType(1)`)。
- 落盘选 Parquet 而非 SQLite:深度快照一天一只标的就是数十万行,SQLite 会成为瓶颈;pandas `to_parquet` 即可(需 pyarrow)。

## 5. 常见误区

- **OBI 不是圣杯**:预测力半衰期以秒计,EOD 策略直接拿它当因子没有意义,它的价值在执行层与日内。
- **深档位噪音大**:top-3 档以外常有大量"装饰性"挂单(随时撤),特征以 top 1~3 档为主。
- **逆向选择**:你的限价单最容易在"不该成交的时候"成交(知情者吃单),被动执行省了 spread 但承担逆选成本,评估执行策略要算 realized spread 而非仅 quoted spread。
- **录制数据的时钟**:统一用交易所时间戳(数据自带)而非本机时间;本机在 UTC+8,混用必错。

## 6. 阶段路线图

阶段 1:`record_book()` 录 3~5 只标的 × 几个交易日(L1 起步,有订阅上 L2)。
阶段 2:notebooks 里算特征、验证 OBI/OFI 预测力,亲手建立直觉。
阶段 3:产出 per-symbol 实证滑点表,回填 backtest 配置,重跑既有策略对比结论变化。
阶段 4(可选):事件驱动重放做日内策略;届时再考虑引擎选型,不在本阶段范围。
