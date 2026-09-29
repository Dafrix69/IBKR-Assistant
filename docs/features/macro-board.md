# 顶栏宏观行情带

顶栏下面常驻七格行情。每一格显示标的本身的价:连着 TWS 时读 IBKR 的流式行情,读不到的格子退到公开数据源。
RPC 是 `macro.board`(读道、低优先级),形状在 `contract/macro.ts`。清单写死在 `engine-ts/src/macro.ts` 的 `MACRO_SYMBOLS`,界面不能注入别的代码。

## 七格

| 格 | 公开源代码 | TWS 合约 | 界面标注 |
|---|---|---|---|
| 标普500 | `^GSPC` | `IND:SPX@CBOE` | SPX |
| 纳指100 | `^NDX` | `IND:NDX@NASDAQ` | NDX |
| VIX | `^VIX` | `IND:VIX@CBOE` | VIX |
| 美债10Y | `^TNX` | `IND:TNX@CBOE`,乘 0.1 | TNX |
| 纽约金 | `GC=F` | `CONTFUT:GC@COMEX`(连续期货) | COMEX GC |
| 布油 | `BZ=F` | `CONTFUT:BZ@NYMEX`(布伦特连续期货) | 布伦特 BZ |
| 比特币 | `BTC-USD` | `CRYPTO:BTC`(PAXOS 现货,免订阅) | PAXOS |

**不用 ETF 替身。** SPY / QQQ / GLD / BNO / IBIT 的价位和标的差一个量级,VIXY 有展期损耗,TLT 与收益率反向;
用户看到一个和标的无关的数却没有任何提示,比空着更糟。TNX 在 TWS 与 Cboe 上按 10 倍报价(48.06 = 4.806%),这两条路乘 0.1;Yahoo 直接给百分数,不乘。涨跌幅是比值,都不乘。

## 取数

**TWS 那一路**(`BrokerRouter.streamQuotes`):

- 第一次用到时按前缀解析合约并确认;确认失败缓存为不可用,断开重连之前不再重试。
- 订阅之后,有新订阅等 1.5 秒,否则等 150 毫秒;价取 `last`,没有就取 `marketPrice`,涨跌幅对 `close` 计算。
- 取不到价的格子(没有这档行情权限、指数盘前没有报价)留给公开源。
- 这一路出任何错误,这一轮就当没有流式报价:七格全部退到公开源,`macro.board` 本身不报错。
- 富途没有这些市场,见到带前缀的代码一律跳过,七格都走公开源。

**公开源**:

- Yahoo 的日线接口(`query1.finance.yahoo.com/v8/finance/chart/…?interval=1d&range=5d`),超时 6 秒;价取 `regularMarketPrice`,
  涨跌幅对 `chartPreviousClose`(没有时用 `previousClose`)计算。
- Yahoo 失败时,标普、纳指、VIX、美债 10Y 退到 Cboe 的延迟行情(`cdn.cboe.com/api/global/delayed_quotes/…`),这一格标注 "Cboe"。
- 纽约金、布油、比特币没有备用源,取不到就给空值和一句原因。
- HTTP 错误或返回的不是 JSON,报一句人话。

**缓存。** 这一轮有任何一格拿到流式报价时缓存 10 秒,否则 60 秒;`force` 不用缓存。过期但不超过 10 分钟的格子先给旧值,
后台单飞去取新值;从没取到过、超过 10 分钟或 `force` 的才同步等,逐格依次取。同步取失败时给旧值并标"旧"。
速记解析用的 `publicIndexPrice` 共用这份缓存(键带 `cboe:` 前缀),SPX / NDX / VIX / RUT 先取 Cboe、缓存 30 秒。

## 界面(`store/macro.ts`、`shell/MacroStrip.tsx`)

- 应用启动就开始轮询,与当前在哪一页无关:连着券商时 2 秒一次,否则 60 秒一次,同一时刻只有一个请求在途。
- 流式的格子在数值后面画一个绿点;标注非空时显示小字标注(Cboe 救回来的格子只有 "Cboe" 没有绿点);旧值显示「旧」;涨跌用着色文字加三角。
- 本次开机攒到 3 个不同的读数之后多一根迷你走势(最多 90 个点,只在内存里)。
- 七格都没有值时整条收起。

## 代码与测试

`engine-ts/src/macro.ts`、`rpc/handlers/market.ts`、`broker.ts` 的 `streamQuotes`;界面 `store/macro.ts`、`shell/MacroStrip.tsx`。

测试:`unit-side.spec.ts` 的 `macro`(不用 ETF 替身、TNX 换算、流式与公开源混合、单格失败、Cboe 备用、旧值保留、单飞刷新)、
`market-rpc.spec.ts` 的 `macro.board`(全流式、券商抛错时退到公开源、没连券商、`force`)、`golden-brokerpure.spec.ts`(合约前缀解析)、
`desktop-consent.spec.ts`(Yahoo 与 Cboe 的域名写进了隐私说明)。
