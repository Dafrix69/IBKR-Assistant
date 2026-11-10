# 文献证据档案：候选期权机制的先验依据

编写日期 2026-11-08。只查了文献，没有碰你的行情数据。

唯一的例外：E、F、G 的衰减表，是子代理对 Chen & Zimmermann 公开的多空月收益序列求的分段均值，未经独立复核。主引用仍以他们 SignalDoc 里抄录的原文数字为准。

## 0. 怎么读这份档案

- **标注规则**：每个数字都注明（出处，版本/年份，表或页）。
  - 「WP」表示工作论文版。
  - 「发表版」表示期刊版。
  - 只看到二手摘要（CXO Advisory、Alpha Architect、搜索片段）的，标「二手」。
  - 没有亲眼看到原文数字的，写「未核实」。
  - 找不到复现的，写「没找到」。
- **「我算」**：标了「我算」的是本档案作者做的算术或推断，不是文献结论。
- **原文抽取**：原文 PDF 由脚本抽成文本后核对。抽出的文本在
  `/private/tmp/claude-501/-Users-dafrix-Developer-ibkr/131b9ce7-b3d3-4034-9ade-446408eb8392/scratchpad/txt/`（临时目录，重启会丢；需要留档就拷走）。
- **期刊归属更正**：brief 里有两处期刊写错了，本档案已更正：
  - Jones & Shemesh 是 *Journal of Finance* 2018，不是 Management Science。
  - Boyer & Vorkink 是 *Journal of Finance* 2014，不是 RFS。
- **brief 要求核实的出处**：Cao, Vasquez, Xiao, Zhan 发表在 *Quarterly Journal of Finance* 2023，题目改成了 "Why Does Volatility Uncertainty Predict Equity Option Returns?"。

## 1. 所有机制共用的五个问题（先读这一节）

### 1.1 样本时间：我们的 2018–2026 几乎全部在「发表之后」

- 除了 Horenstein–Vasquez–Xiao（RFS 2025/26，样本到 2021）、Muravyev–Pearson–Pollet（JFE 2025）和 Duarte 等（RFS 2026）之外，其余原始论文的样本都在 2016 年以前结束。
- 所以 McLean & Pontiff (2016) 的发表后衰减（见 §3.1）几乎整段适用。
- 但 McLean–Pontiff 同时发现，集中在高特质风险、低流动性股票上的预测因子，发表后衰减得少。原文："Post-publication returns are lower for predictors that are less costly to arbitrage, that is predictor portfolios with liquid stocks and low idiosyncratic risk stocks"（JF 2016 发表前稿 p.1，counterpointfunds 托管）。
- 我们的股票池正是「贵于套利」的那一类。

### 1.2 前视偏差：日终数据回测最常见的虚高来源

- **Duarte, Jones, Khorram, Mo & Wang**，"Too Good to Be True: Look-Ahead Bias in Empirical Options Research"，*RFS* 2026，DOI 10.1093/rfs/hhag061。
  - 摘要说，偏差来自"using information unavailable at the portfolio formation time to filter out observations suspected of being noisy or erroneous"。
  - 去掉前视之后，"illiquidity is not strongly priced in stock options and that only a small set of stock characteristics are in fact associated with option expected returns"（摘要，Crossref）。
  - 二手（CXO 对 2023 WP 的摘要），正文未核实：
    - 一个基于股票特征的策略（盈利能力），2012-01 至 2020-06，毛收益从 2.27% 降到 0.10%/月。
    - 看涨期权的流动性策略，1996-01 至 2016-04，从 1.52% 降到 0.19%/月。
- **Goyenko & Zhang**，"Demand Pressures and Option Returns"，SSRN 3489347，WP，发表情况未核实。
  - 摘要：用收盘价算的 delta 对冲收益和跨式收益"are always higher compared to those based on any other price of the day"，差距"can easily reach more than 100 bps per day or week"。
  - 意思是：只用日终数据的回测本身就偏乐观，没有日内数据没法校正，只能打折。
- **Xing, Zhang & Zhao (2010)**：因为期权和股票收盘不同步，信号到收益之间跳过 1 天；原文说不跳的话"results are even stronger"。
- **统一规则**：t 日收盘算信号和筛选条件，t+1 日的报价进场；任何筛选都不能用当天或持有期内的信息。

### 1.3 交易成本：换算成你的单位

- **期权费的粗估（我算）**：ATM 单腿期权费 ≈ 0.4·σ·√T·S。
  - σ = 0.8 时：周期权（T = 7/365）约 4.4% S；月期权（30/365）约 9.2% S。
  - 所以你的单边成本 0.1–0.2% S，等于周期权费的 2.3–4.5%，月期权费的 1.1–2.2%。
- **文献里的实际点差**：Muravyev & Pearson，"Options Trading Costs Are Lower than You Think"，*RFS* 33(11) 2020。
  - 摘要："Effective spreads of traders who time executions are less than 40% of the size of conventional measures"。
  - 网络附录 Table IA.6（2004–2015 全部普通股，半点差占中间价）：

    | 分组 | 报价 | 有效 | 调整后 | 算法 |
    |---|---|---|---|---|
    | 市值最小五分位 | 14.8% | 11.3% | 9.3% | 7.3% |
    | 波动最高五分位 | 12.8% | 9.9% | 7.9% | 5.5% |
    | 点差最宽五分位 | 21.1% | 15.5% | 13.6% | 11.7% |

  - 点差最宽那一档里，「会择时」的人仍然要付报价半点差的 55%；点差最窄那一档只要 6%。也就是说，「只付报价 20%」这个好处只在流动名字上成立。
- **两者对比（我算）**：你给的 0.1–0.2% S 远低于文献对小盘、高波动名字的估计。可能是 2018 年以后这些名字（GME、AMC 这类）的期权确实极活跃，也可能是估计偏乐观。建议在测试前，用自己数据里 (ask−bid)/2 ÷ mid 的分布核对一次（这是数据工作，不在本档案范围内）。
- **把论文结果换算成股价百分比**：同一套成本放在一起比的话，Horenstein–Vasquez–Xiao 用占股价 S 的单位报多空月收益：

  | 信号 | 10−1 多空，%S/月（看涨 / 看跌） |
  |---|---|
  | HV−IV | 0.78 / 0.80 |
  | 特质波动 | −0.45 / −0.40 |
  | IV 期限斜率 | 0.51 / 0.55 |
  | VOV | −0.59 / −0.56 |

  （RFS 2025/26，1996–2021，中间价，每日对冲，Table 1。）
  - 多空两腿、月度进出场，就是 4 次单边成本，0.4–0.8% S；持有到期免去出场成本，是 0.2–0.4% S。这还没算对冲正股的成本。
  - 结论（我算）：多空版本的毛收益和你的成本同一个量级。
- **一边倒的反证**：O'Donovan & Yu，"A Transaction Cost Perspective on Option Anomalies"，SSRN 4806038，WP。
  - 摘要："Of the 24 portfolio sort variables studied, 17 generate positive and significant gross returns, but none remain profitable after accounting for trading costs"。降成本的办法能救回其中 7 个；delta 对冲的频率对成本是一阶影响。
  - 具体是哪 24 个变量：未核实。
- **反方证据**：
  - Zhan, Han, Cao & Tong，"Option Return Predictability"，*RFS* 35(3) 2022：2003 年 5 月以后的 OPRA 子样本里，实际有效点差约为报价的 55%；扣掉实际点差后，10−1 收益平均降 32%，10 个里有 9 个仍显著。
  - Bali, Beckmeyer, Moerke & Weigert，*RFS* 36(9) 2023：非线性机器学习组合在付全额有效点差（含对冲腿）后仍有 0.67%/月。
  - 两者都是全市场、OptionMetrics 口径。

### 1.4 股票池不匹配，以及单边和多空的差别

- **股票池**：
  - 文献普遍按价格、点差、成交量筛掉的，正是你池子里这类名字。
  - 多数论文的股票池偏大盘：
    - Jones–Shemesh 用 S&P 500 成分股。
    - Gao–Xing–Zhang 的样本中位市值 23 亿美元。
    - Option Momentum 的平均市值 106 亿美元。
  - 你的池子每年只有 40 只。做十分位只有每组 4 只，噪声很大；更现实的是三分位或五分位，或者池内的时间序列条件。
- **单边和多空**：
  - 论文报的是 10−1 多空。你已经知道，在这批股票上无条件卖方扣成本后约为 0，买方为负。
  - 所以对 A、C、I 这类机制，可实施的版本是「只在信号最强的那组卖」。它能带来的增量，大约是「该组均值减全体均值」，而不是 10−1 的差。下文凡是论文给了分组均值的，都单列出来。

### 1.5 你的数据有什么、缺什么

- **greeks_eod 的字段**：我看了 GME 一个文件的表头，字段是 symbol, expiration, strike, right, timestamp, open/high/low/close, volume, count, bid_size/bid/ask_size/ask（含交易所和条件码）、各阶希腊值、implied_vol, iv_error, underlying_timestamp, underlying_price。
  - **没有 open interest。**
  - ThetaData 有单独的 oi 接口，`research/small_cap_orb` 用过（2024-10-31 起）。我抽查了池子里的 4 只（GME、AMC、MARA、COIN），在 `~/Data/thetadata/<SYM>/` 下都只有 greeks_eod_byexp 目录，没有 oi。其余名字没查。
- **需要核对的一行**：抽看的一行里 underlying_timestamp 为 `17:15:13`。时区需要核对：如果是美东时间，标的价格就是盘后价，和期权收盘报价不同步，正是 §1.2 说的问题。
- **ThetaData 的 IV 有没有计入借券费，未核实。** 这一点对 E 很关键，见 E5。

---

## 2. 逐条机制

### A. 隐含波动与历史波动之差（Goyal & Saretto 2009）

**A1. 原始文献**
- Goyal & Saretto，"Cross-Section of Option Returns and Volatility"，*JFE* 94(2):310–326，2009。
- 发表版数字未核实。下面的数字来自两个 WP 版本，样本都是 1996–2005，OptionMetrics 全部美股期权，每只股取最接近 ATM、下个月到期的合约，按 log(HV)−log(IV) 分十组，持有到期，中间价。
- **2008-04 版**（rice.edu 托管，32,589 个股票-月，2,919 只股票）：
  - 多空跨式（买 HV≫IV 的，卖 HV≪IV 的）平均 22.5%/月，月标准差 31.4%，最差月 −40.5%。
  - 按有效点差占报价点差的比例扣成本（transaction cost 表 Panel A）：50% 时 14.0%（t 4.27），75% 时 10.7%（t 3.30），100% 时 7.5%（t 2.32）。
  - delta 对冲看涨多空：中间价 2.7% → 100% 点差时 0.6%（t 1.32）。看跌：2.6% → 0.6%（t 1.44）。
  - delta 对冲收益的分母定义未核实。
- **2006 版**（ERIM 托管，120,028 个观测）：多空跨式 21.9%/月；原文："reduced from 21.9% to 4.1% per month if we consider trading options at an effective spread equal to the quoted spread"。
- **单边可读**（2008 版 Table 3 Panel A，跨式各分组的中间价月收益）：
  - 第 1 组（IV 远高于 HV，即应卖的那组）为 −9.9%，也就是卖方毛赚 9.9% 的跨式价格。
  - 第 2–9 组分别为 −6.5, −4.1, −1.0, −0.1, 0.4, 1.1, −0.6, 4.5；第 10 组为 12.6%。
- **两个版本的异同**：数字不同（22.5% vs 21.9%；扣成本后 7.5% vs 4.1%），方向一致。

**A2. 发表后复现**
- **Goyal & Saretto，"Are Equity Option Returns Abnormal? IPCA Says No"**，Dallas Fed WP 2214，2022（WP）。
  - 1996-01 至 2020-11，delta 对冲看涨，按 (ΔS−C) 计。
  - RV−IV 的 10−1 = 3.56%/月（t 20.05），Table 1。
  - 用 IPCA 调整后的 alpha 仍显著，是少数几个之一（原文："only five … still have a statistically significant IPCA alpha: IV ATM, IV slope, IV term, RV − IV, and BM"）。
  - 这是同作者的扩展样本，不算独立复现。
- **Horenstein, Vasquez & Xiao，"Common Factors in Equity Option Returns"**，*RFS* 39:835–874（2025-10 在线）。
  - 1996–2021，按 Duarte 等的方法去前视。
  - HV−IV 的 10−1 = 0.78%（看涨）/ 0.80%（看跌）占 S 每月，并被选为四个因子之一。
- **Bali 等 *RFS* 2023**：样本外 2003–2020，IV−RV 在非线性模型里排进前十重要的特征（负号）。
- **Zhan 等 2016 WP**（1996–2012）：Fama-MacBeth 回归里 VOL_deviation 系数 −0.039（t −19.38）。
- **衰减**：没有找到「发表前 vs 发表后」的分段比较，只有并入后期年份的全样本，效应仍然很强（中间价口径）。衰减幅度：没找到。

**A3. 小盘、高波动上的证据**
- GS 2008 WP 成本表按期权点差分组：
  - 点差最宽三分位：中间价 27.7% → 100% 点差时 5.9%（t 1.37，不显著）。
  - 点差最窄三分位：18.2% → 9.4%（t 2.26）。
- 期权成交量最低组：23.4% → 5.2%（t 1.38）。
- 也就是说，毛效应在不流动的名字上更大，扣成本后反而更弱。
- Bali 等 2023：多空在摩擦最低五分位为 0.75%/月，最高五分位 3.34%（中间价）。

**A4. 成本**
- 文献直接讨论过：跨式版本到 100% 报价点差时只剩 4.1–7.5%/月；delta 对冲版本到 100% 时不显著（GS 2008 WP）。
- 换算（我算）：第 1 组单边卖跨式中间价毛赚约 9.9% 的跨式价格；跨式价格约 0.8σ√T·S。按你池子 σ≈0.8，月度约 18% S，毛收益约 1.8% S/月，要付两腿进场成本（持有到期）。
- 这一组是在 1996–2005 全市场测得的，不是你的池子。

**A5. 机制**
- 原文的解释是投资者对近期波动反应过度：IV 预测了未来波动的变化，但实际波动的变化幅度小于 IV 的变化。
- 谁付钱：高 IV 期权的买方（过度外推的人）。
- 为什么没套利掉：做空高 IV 期权要交保证金，原文引用 Santa-Clara & Saretto；另外点差宽。

**A6. 日终数据可行性：能。**
- HV 用标的过去日收盘价算（GS 用过去 12 个月），IV 用 ATM 中间价。
- t 收盘算信号，t+1 进场。

### B. IV 期限结构斜率（Vasquez 2017）

**B1. 原始文献**
- Vasquez，"Equity Volatility Term Structures and the Cross Section of Option Returns"，*JFQA* 52(6):2727–2754，2017。
- 发表版摘要（Cambridge）："The slope of the implied volatility term structure is positively related to future option returns… Straddle portfolios with high slopes … outperform straddle portfolios with low slopes"。
- 发表版数字未核实（付费墙，SSRN 拦截）。
- **2011-10 WP**（二手，CXO）：
  - 1996-01 至 2007-06，约 260 只/月，ATM，十分位。
  - 多空跨式毛 27.1%/月，其中多头 14.8%、空头 12.2%。
  - 摩擦等于报价点差时净 12.3%。
  - delta 对冲看涨 4.0% → 1.5%，看跌 3.5% → 0.8%。
  - 1996–2000 为 29.9%，2001–07 为 24.9%。
- **另一版 WP**（二手，Alpha Architect 搜索片段）：毛 19.6%，净 5.5%，1.25 倍报价点差时不显著。未核实。

**B2. 发表后复现**
- HVX（1996–2021）：
  - IV 斜率定义为「长期 IV 减短期 IV」，10−1 = 0.51%（看涨）/ 0.55%（看跌）占 S 每月。
  - 收益是持有 delta 对冲期权（买方）的收益，所以斜率越高收益越高，与 Vasquez 一致。
- GS-IPCA（1996–2020）：IV term 10−1 = −2.40%/月（t −19.74），按 (ΔS−C)。
  - 它的收益也是买方口径：原文"buying options positions in portfolio 10 and writing option positions in portfolio 1"。
  - 它的文字定义是"ATM implied volatility extracted from the 360 days volatility surface and the corresponding implied volatility extracted from the 30 days surface"，即 360 天减 30 天。
  - 照这个定义，−2.40 说明斜率越高、买方收益越低，与 Vasquez 和 HVX 都相反。
  - 两者不能同时成立：要么文字定义和实际计算的方向不一致，要么结果真的冲突。**方向未核实。**
- 发表前后分段衰减：没找到。

**B3. 小盘、高波动**：按规模或点差的分组，没找到。

**B4. 成本**
- 文献讨论过，但只在 WP 二手摘要里：12.3%（1 倍）或 1.25 倍时不显著，两个版本口径冲突，未核实。
- 换算见 §1.3：HVX 的 0.5% S/月 多空，与你 0.2–0.8% S 的往返成本同一量级。

**B5. 机制**：原文的解释是投资者对短期 IV 过度反应（短期 IV 相对长期过高的，期权偏贵）。谁付钱：短期期权的买方。

**B6. 日终数据可行性：能。** 两个到期日的 ATM IV。
- 注意（我推断）：财报前，事件方差会把前端 IV 抬高、斜率倒挂（见 J）。没有财报日，你分不清「斜率低」是过度反应还是财报临近。Vasquez 有没有剔除财报月，未核实。

### C. 特质波动与 delta 对冲期权收益（Cao & Han 2013）

**C1. 原始文献**
- Cao & Han，"Cross Section of Option Returns and Idiosyncratic Stock Volatility"，*JFE* 108(1):231–249，2013。读的是作者接受稿（多伦多大学 TSpace）。
- **样本**：1996-01 至 2009-10，OptionMetrics 全部有期权的股票（看涨覆盖 6,141 只），约 50 天到期的 ATM 期权。
- **收益口径**：delta 对冲收益 /（ΔS−C），%/月，每日调对冲，中间价。
- **主结果**（Table 8 Panel B，卖 delta 对冲看涨，按 IVOL 五分组，等权）：
  - 各组：Q1 0.80，Q2 0.92，Q3 1.12，Q4 1.41，Q5 2.20。
  - 5−1 = 1.40%/月（t 8.11）；按股票市值加权只有 0.76。
- **扣成本**（Table 10）：
  - 中间价 1.40；有效点差取报价的 10% 时 1.16，25% 时 0.79，50% 时 0.17。
  - 原文：50% 时"no longer significant statistically or economically"。

**C2. 发表后复现**
- GS-IPCA（1996–2020）：特质波动 10−1 = −0.92%/月（t −5.31），按 (ΔS−C)。
- HVX（1996–2021）：−0.45%（看涨）/ −0.40%（看跌）占 S 每月。
- Zhan 等 2016 WP（1996–2012）：IVOL 10−1 中间价 3.92%，50% 点差 2.74%，100% 点差 1.61%（t 10.97）。
  - 和 Cao & Han 自己的成本表冲突：Cao & Han 在 50% 时已不显著，Zhan 等到 100% 仍显著。差别可能来自十分位和五分位、样本、成本口径的不同（未核实）。
  - 另外，Duarte 等 2026 认为 Zhan 等这类股票特征结果受前视影响。
- 发表前后分段：Cao & Han 自己的四个子期（1996–99、2000–03、2004–06、2007–09）都在 1%/月以上（Fig.1）。发表后分段：没找到。

**C3. 小盘、高波动**
- 按市值分五档的 5−1：最小档 1.63（t 9.11，其中高 IVOL 那条腿 3.45），最大档 0.32（t 1.66）。
- Amihud 最不流动档 2.04，最低价档 1.99。
- 都是中间价。效应集中在小盘、不流动、低价股。

**C4. 成本**
- 文献直接讨论过：50% 报价点差就吃光（Cao & Han Table 10；十分位版本到 75% 才不显著，脚注 18）。
- 换算（我算）：最高 IVOL 档卖方 2.20% × (ΔS−C)。ATM、σ≈0.8、50 天时 ΔS−C ≈ 0.44S，约 0.97% S/月。比五档平均（1.29%）多出约 0.4% S/月，这个增量就是条件化带来的。
- 你的无条件卖方 ≈ 0，说明这 0.4% S 左右的条件增量，大致要和单腿成本加对冲成本相抵。

**C5. 机制**
- 原文："Dealers charge a higher premium for options on high idiosyncratic volatility stocks due to their higher arbitrage costs"。
- 控制套利限制的代理变量后，关系减弱约 40%。
- 谁付钱：期权买方付给做市商的风险溢价。不是错误定价，所以不一定会被套利掉。

**C6. 日终数据可行性：部分能。**
- 总波动用标的收盘价就能算。
- 特质波动还需要市场或 Fama-French 日收益（可从 Ken French 网站下）。在你这类名字上，特质波动接近总波动。

### D. 期权收益的周末效应（Jones & Shemesh 2018）

**D1. 原始文献**
- Jones & Shemesh，"Option Mispricing around Nontrading Periods"，***Journal of Finance*** 73(2):861–900，2018（不是 Management Science）。读的是作者主页的发表版 PDF。
- **样本**：1996-01-04 至 2014-08-28，日度。主样本是连续 5 天有成交的 S&P 500 成分股期权，平均百分比点差约 15%（Table I）。
- **收益口径**：收盘中间价到收盘中间价，%期权价/日，按持仓金额加权。
- **Table II**：
  - delta 对冲看跌：交易日 +0.03%，非交易期 −0.82%，差 −0.86%（t −11.93）。
  - 对冲看涨：差 −0.51%（t −5.11）。
  - 不对冲的看涨加看跌：差 −0.68%（t −7.86）。
- 普通周末单独看：−0.79%（t −8.06）（Table IV Panel D）。

**D2. 发表后复现**
- 原文内部：19 年里年年为负，其中 11 年显著。原文说"second half of the sample is substantially more volatile and slightly smaller on average"。
- 单只股票、2014 年以后的独立复现：没找到。
- Terstegge (2025 WP)：只看 S&P 500 指数期权，1996–2023，周末缺口还在。
- 相关：Muravyev & Ni，"Why Do Option Returns Change Sign from Day to Night?"，*JFE* 136(1):219–238，2020。
  - 摘要：SPX delta 对冲 −0.7%/日，其中收盘到开盘 −1%，开盘到收盘 +0.3%；"A similar return pattern holds for … equity options"。

**D3. 小盘、高波动**
- 不限成交量的全部股票：对冲看跌 −0.42%（t −16.31）。
- 成交量 > 100 的子样本：约大 40%。
- 原文："perhaps twice as large for the most heavily traded options"。
- 也就是说，在不活跃的名字上效应更弱。

**D4. 成本**
- 原文直接说吃掉："none of the calculations in the table factor in the effects of transaction costs … not feasible as a stand-alone trading strategy"；它只是"the additional return that would result from holding previously written options for another day"。
- 换算（我算）：周期权费约 4.4% S，× 0.8% ≈ 0.035% S，远小于你 0.1–0.2% S 的单边成本。

**D5. 机制**
- 原文：IV 对非交易期给了过高的方差预期，时间衰减被低估了；不是风险补偿。
- 估计每个周末约 15 亿美元从期权买方转给卖方。

**D6. 日终数据可行性：能（周五收盘到周一收盘）。**
- 不能单独交易，只能当叠加规则用：已经卖出的仓位，周末继续持有；要买期权的话，放到周一收盘再买。
- 拆分日内和隔夜：不能（需要开盘价）。

### E. 看涨看跌 IV 差预测股票收益（Cremers & Weinbaum 2010；Bali & Hovakimian 2009）

**E1. 原始文献**
- **Cremers & Weinbaum**，"Deviations from Put-Call Parity and Stock Return Predictability"，*JFQA* 45(2)，2010。
  - 摘要：看涨相对贵的股票比看跌相对贵的股票"by 50 basis points per week"。
  - 样本 1996–2005，是从 An 等 NBER WP 的引用推出的，未直接核实。
  - 没有成本分析。
- **Bali & Hovakimian**，"Volatility Spreads and Expected Stock Returns"，*Management Science* 55(11):1797–1812，2009。
  - 只看了摘要。数字取自 Chen & Zimmermann 的 SignalDoc：
    - CPVolSpread：1996–2004，五分位市值加权 1.045%/月（t 4.2，Table 3B）。
    - RIVolSpread（RV−IV）：0.732%/月（t 2.9）。
- **Yan 2011 JFE 的 SmileSlope**（delta 0.5 的看跌 IV 减看涨 IV，等于 E 的反号）：1996–2005，1.8%/月（t 8.17）。

**E2. 发表后复现和衰减**
- 来源：Chen & Zimmermann 开源资产定价，2026.10 版的多空月收益序列（期权类信号因为 OptionMetrics IvyDB 6.0 改了 IV 算法，只到 2022-12）。下表是子代理对这些公开序列求的分段均值，未经独立复核（以下 E、F、G 凡标「子代理算」的都是这个来源）：

  | 信号 | 原样本内 | 发表后 | 2018 至 2023-01 |
  |---|---|---|---|
  | CPVolSpread | 0.98 (t 3.16) | 0.47 (t 3.28)，−52% | 0.43 (t 1.62) |
  | RIVolSpread | 1.05 | 0.16 (t 0.56) | — |
  | SmileSlope | 1.83 | 0.85 (t 5.15) | 0.85 (t 2.78) |

- Cremers & Weinbaum 原文自己就说"The degree of predictability decreases over the sample period"。An 等说它在 2001–2005 不显著。

**E3. 小盘、高波动、散户**
- Cremers & Weinbaum："larger when option liquidity is high and stock liquidity low"。
- 只留市值大于 NYSE 20% 分位的股票，SmileSlope 发表后从 0.85 降到 0.62（子代理算，用 Chen & Zimmermann 的筛选版序列）。

**E4. 成本**
- 这是预测股票收益的信号，成本是正股交易成本加借券费。
- Muravyev, Pearson & Pollet，"Why Does Options Market Information Predict Stock Returns?"，*JFE* 172，2025（摘要）：剔除高借券费股票后，IV spread 和 skew 的预测力"decreases by at least two-thirds"。
- Chen & Zimmermann 的 GitHub issue #156：维护者也独立看到，改用含借券费的 IV 后，CPVolSpread 的预测力大部分消失。
- 用期权合成空头的话，价格里本来就含借券费，「超额收益」被抵掉（我推断）。
- 扣成本后的直接估计：没找到。Chen & Velikov 的信号清单不含 IV spread。

**E5. 机制**
- 原文的解释是知情交易先在期权市场发生。
- 后来的证据（Muravyev 等 2025）显示，主要是借券费：难借的股票看跌相对贵，股票后来表现差，做空的人要付出借方费用。
- Cremers & Weinbaum 当年说"cannot be explained by short sale constraints"，已被这篇推翻。
- GME、AMC 这类名字正是高借券费那一类（我推断）。

**E6. 日终数据可行性：能。**
- 同行权价的 call、put IV 对，或用平价关系反推。
- 但如果 ThetaData 的 IV 没计入借券费（未核实），这个信号基本就是隐含借券费本身，而借券费你通过期权赚不到。

### F. IV 微笑 / smirk（Xing, Zhang & Zhao 2010）

**F1. 原始文献**
- Xing, Zhang & Zhao，"What Does the Individual Option Volatility Smirk Tell Us About Future Equity Returns?"，*JFQA* 45(3)，2010。读的是清华托管的发表版。
- **样本**：1996–2005，OptionMetrics，周频。
- **信号**：SKEW = 价外看跌（K/S≈0.95）的 IV 减 ATM 看涨的 IV。
- **结果**：五分组多空 FF3 alpha 21 bp/周（年化 10.90%），t 2.93（Table 3）；持有 4 周为年化 6.52%。
- 没有成本分析。

**F2. 发表后复现**：Chen & Zimmermann 的 skew1 从原样本 0.63（t 3.10）降到发表后 0.18（t 1.19），−71%；2018 年以后 0.09（t 0.32）（子代理算）。

**F3. 小盘、高波动**
- Table 7：股票换手率越低，预测力越强。
- 即使只留市值大于 NYSE 20% 分位的股票，发表后也只有 0.17（子代理算）。

**F4. 成本**
- 文献未直接讨论。
- 换算（我算）：多空利差约 21 bp/周；用期权表达，一买一卖是 0.2–0.4% S，和利差同量级。

**F5. 机制**
- 原文：知情交易者买价外看跌。
- 后来的解释：借券费（Muravyev 等 2025；Chen & Zimmermann issue #156）。

**F6. 日终数据可行性：能。**

### G. 看涨、看跌 IV 的变化（An, Ang, Bali & Cakici 2014）

**G1. 原始文献**
- An, Ang, Bali & Cakici，"The Joint Cross Section of Stocks and Options"，*JF* 69(5)，2014。读的是 NBER w19590（2013-10）。
- **样本**：1996–2011，OptionMetrics 波动率曲面，30 天、delta 0.5。
- **结果**：
  - 按看涨 IV 的月变化分十组，等权多空 1.09%/月（Newey-West t 3.45）。
  - FF3 alpha 1.00；按特征匹配调整后 0.86（t 2.87）。
  - 看跌 IV 变化：−0.42%/月（t −2.03）。
- 原文："may be some liquidity frictions involved in implementing a tradable strategy"。未扣成本。

**G2. 发表后复现**（Chen & Zimmermann，子代理算）：

| 信号 | 原样本 → 发表后 | 2018 年以后 |
|---|---|---|
| dVolCall | 0.89 → 0.59（−34%） | 0.65（t 1.78） |
| dCPVolSpread | 1.36 → 0.69（−49%） | 0.43（t 1.67） |

- 原文自己的三个子期（1996–2000、2001–05、2006–11）都稳健。

**G3. 小盘、高波动**
- 原文："strongest in the smallest stocks, but … still economically large … among big stocks"。
- 剔除小盘股后，dCPVolSpread 发表后 0.37（t 2.0），2018 年以后 0.09（子代理算）。

**G4. 成本**：文献未直接讨论。和 E、F 一样，主要是正股成本加借券费。

**G5. 机制**
- 原文：知情交易，加上一个有噪音的理性预期模型。
- Muravyev 等 2025 说其他由 IV 算出的信号情况相似，但没单独给这条的数字。

**G6. 日终数据可行性：能。** 需要把到期日和 delta 插值到 30 天、delta 0.5，取月度变化。

### H. 事前偏度 / 彩票需求（Boyer & Vorkink 2014；Bali & Murray 2013）

**H1. 原始文献**
- **Boyer & Vorkink**，"Stock Options as Lotteries"，***Journal of Finance*** 69(4):1485–1527，2014（不是 RFS）。
  - 摘要（RePEc）："Differences in average returns for option portfolios sorted on ex ante skewness range from 10% to 50% per week, even after controlling for risk"。
  - 2011 WP（二手，CXO）：约 1996–2009，不对冲、持有到期、中间价；7 天看涨低减高偏度 36.8%/周，看跌 55.0%/周。
  - 发表版表格未核实。
- **Bali & Murray**，"Does Risk-Neutral Skewness Predict the Cross-Section of Equity Option Portfolio Returns?"，*JFQA* 48(4):1145–1171，2013。
  - 网络附录：1996-01 至 2010-10，构造 delta 和 vega 都中性的「偏度资产」。
  - 摘要："strong negative relation between risk-neutral skewness and the skewness asset returns"。
  - 主效应的大小未核实。
  - 讨论人 Gruber（EFA 2011）问 "Why restrict to large cap stocks?"。

**H2. 发表后复现**
- GS-IPCA（1996–2020）：MF skew 10−1 = −0.34%/月（t −2.78）；换成 HVX 模型 alpha 后 −0.21（t −1.08），不显著。
- Boyer & Vorkink 的复现：没找到。

**H3. 小盘、高波动**：没找到直接分组。从机制看，你池子里这类彩票型名字是需求最集中的地方（我推断）；Bryzgalova 等 2023 见 L。

**H4. 成本**
- 文献直接讨论过（Boyer & Vorkink 2011 WP，二手）："Option bid-ask spread increases dramatically with skewness, implying that investors selling highly skewed options near the bid generally cannot capture the skewness premium"。
- 也就是说，溢价最大的地方点差也最宽。

**H5. 机制**
- 摘要：溢价是"compensate intermediaries for bearing unhedgeable risk when accommodating investor demand for lottery-like options"。
- 谁付钱：买彩票型（价外、短期）期权的人。
- 为什么没套利掉：不可对冲的风险，加上宽点差。

**H6. 日终数据可行性：能。**
- 事前偏度用标的历史收益和合约条款算（Boyer & Vorkink 的具体算法未核实）。
- 风险中性偏度用价外期权的 IV 截面算，质量取决于行权价覆盖。

### I. 波动的波动（vol-of-vol）

**I1. 原始文献（出处已核实）**
- **Ruan**，"Volatility-of-volatility and the cross-section of option returns"，*Journal of Financial Markets* 48，article 100492，2020，doi 10.1016/j.finmar.2019.03.002，单作者。
  - 摘要：期权收益与 VOV 显著负相关，标准风险因子解释不了。
  - 样本和数值未核实。
- **Cao, Vasquez, Xiao & Zhan**，"Why Does Volatility Uncertainty Predict Equity Option Returns?"，*Quarterly Journal of Finance* 13(1)，2350005，2023（旧名 "Volatility Uncertainty and the Cross-Section of Option Returns"）。读的是 City 大学开放获取版。
  - **样本**：1996-01 至 2016-04；卖 delta 中性看涨，每日调对冲，按 (ΔS−C)。
  - **IMPLIED-VOV 等权五分组**：Q1 0.89，Q2 1.09，Q3 1.26，Q4 1.54，Q5 1.77；5−1 = 0.88%/月（t 13.77）。
  - 三种 VOV 的 5−1 在 0.52–1.04% 之间。
  - 文中没找到成本分析。
- **Baltussen, van Bekkum & van der Grient**，*JFQA* 53(4) 2018："Unknown Unknowns"。
  - 这篇预测的是股票收益，不是期权收益。
  - 1996-01 至 2014-10，市值加权高减低 −0.69%/月（t −2.96）。

**I2. 发表后复现**
- HVX（1996–2021）：VOV 10−1 = −0.59%（看涨）/ −0.56%（看跌）占 S 每月，被选为四个因子之一。
- GS-IPCA（1996–2020）：IV vol 10−1 = −0.64%/月（t −3.71）；但换成 HVX 模型 alpha 后变成 +0.51（t 3.07）。
- 发表前后分段：没找到。

**I3. 小盘、高波动**
- Baltussen 等原文说，股票收益那一版的效应在"larger, more liquid"股票上。
- 期权收益那一版按规模的分组：没找到。

**I4. 成本**：没找到直接讨论。换算见 §1.3：0.56–0.59% S/月 的多空毛收益，与你的往返成本同一量级。

**I5. 机制**
- Cao 等 2023 的解释是模型风险（做市商要价更高）加赌博偏好。
- 控制需求压力（持仓量 / 正股成交量）后，系数降约 20%。
- 驱动项是 IV 上升时的 VOV+。

**I6. 日终数据可行性：能。**
- implied VOV = 过去一个月 ATM IV 日变化率的标准差；EGARCH-VOV 也能算。
- 日内 VOV 不能（需要分钟线）。
- 需求压力那一路也不能（没有正股成交量；持仓量不在 greeks_eod 里）。

### J. 财报前跨式（Gao, Xing & Zhang 2018）和从期权推断财报日

**J1. 原始文献**
- Gao, Xing & Zhang，"Anticipating Uncertainty: Straddles around Earnings Announcements"，*JFQA* 53(6):2587–2617，2018。读的是 2017-11 WP（清华托管）。
- **样本**：1996–2013，OptionMetrics。筛选：股价 ≥ 5 美元、期权价 ≥ 0.125、持仓量 > 0、10–60 天到期。约 4 万个公司-季度，中位市值 23 亿美元。
- **结果**：
  - 从 −3 日到 0 日的 delta 中性 ATM 跨式收益 3.34%；从 −1 到 0 是 1.88%（t 16.36）。
  - 对照：平常日子 −0.19%/日，−2.12%/周。
- 中间价，未扣成本。原文："we only use end of the day bid and ask prices"。

**J2. 发表后复现**
- BSIC（博科尼学生协会博客，非同行评审）：S&P 500，2011–2021，窗口 −3 到 +1：中间价 1.17%；按 ask 买、bid 卖为 −9.07%。
- MDPI JRFM 2023 关于周期权的论文：页面 403，搜索片段说没有显著收益，未核实。
- 同行评审的复现：没找到。

**J3. 小盘、高波动、散户**
- 规模四分位：最小 2.15%，最大 1.24%。
- 期权点差四分位：最窄 1.14%，最宽 4.93%（差 t 5.33）。
- 期权成交量：最低 5.82%，最高 0.90%。
- 也就是说，效应恰好集中在成本最高的地方。
- de Silva, So & Smith，"Losing is Optional: Retail Option Trading and Expected Announcement Volatility"，*Review of Finance* 2025（卷页未核实；数字来自 2024-04 幻灯片）：
  - 约 3.2 万次财报，2010–2021。
  - 财报日卖 ATM 跨式（t−1 收盘到 t 收盘，中间价）：按 AbnormalIV 分组，最低五分位 7%，最高五分位 18%（以跨式价格计），5−1 为 11%（t 19.55）。
  - 散户付的半点差约为中间价的 7.5–9.5%。
  - 和预期波动相关的散户需求"increasing over time"，没有被学习掉。

**J4. 成本**
- 文献直接讨论过：Gao–Xing–Zhang 自己承认没做可交易性检验。BSIC 显示，按 ask 买、bid 卖后为大幅负值。
- 换算（我算）：3.34% 的跨式价格，远小于两腿四次过点差的成本。

**J5. 机制**
- 买财报前：散户买盘把 IV 推高，前端 IV 上升，持有者在财报前吃到 IV 的上涨（de Silva 等：散户买入最多的那一组，IV 多涨约 40%）。
- 穿过财报持有：隐含的跳跃波动高于实际，所以亏。Dubinsky, Johannes, Kaeck & Seeger 的 2017 幻灯片写着"−8%/EAD"，发表版表格未核实。
- 谁付钱：散户买方。做市商靠点差保护。

**J6. 日终数据可行性：部分能。**
- **从期限结构推断财报日**：
  - Dubinsky 等，"Option Pricing of Earnings Announcement Risks"，*RFS* 32(2):646–687，2019，给出了用两个跨越财报的到期日估计财报跳跃的方法（与时间序列估计的相关性 93%，幻灯片）。
  - 它是在已知财报日的前提下估计跳跃大小，不是推断日期。
  - IV²·T 在到期日之间的拐点，能把财报定位到两个到期日之间。有周期权的话，精度是「周」，不是「日」。
  - IV 崩塌能精确到日，但只能事后看到（前视）。
- **事前、不需要日期的旗标**：Alexiou, Goyal, Kostakis & Rompolis，"Pricing Event Risk: Evidence from Concave Implied Volatility Curves"，*Review of Finance* 29(4):963–1007，2025。财报前短期 IV 曲线常呈凹形，凹的公司跨式收益更低（数值未核实）。
- **专门从期权数据还原财报日并据此回测的文献：没找到。**
- 结论：
  - 买 −3 到 0：精度不够，能不能做取决于周级定位，基本不能做。
  - 卖穿财报：可以用「前端事件方差跳升」作为周级条件，部分能。

### K. 到期日钉住（Ni, Pearson & Poteshman 2005）

**K1. 原始文献**
- Ni, Pearson & Poteshman，"Stock Price Clustering on Option Expiration Dates"，*JFE* 78(1):49–87，2005。
- 摘要："returns of optionable stocks are altered by an average of at least 16.5 basis points" 每个到期日，约 90 亿美元市值。
- 机制检验用的是可能做 delta 对冲者的净头寸（专有数据），样本区间未核实。
- 相关：
  - Golez & Jackwerth，*JFE* 106(3):566–585，2012：只看 S&P 500 期货，到期日每次至少 1.15 亿美元的名义平移，数据到 2009。
  - Ni, Pearson, Poteshman & White，*RFS* 34(4):1952–1986，2021：对冲者的净 gamma 越大，股票绝对收益越低。数值未核实。

**K2. 发表后复现**
- Zhang, Chen & Cai (2015) 关于周期权的钉住：文本未能抽取，未核实。
- 可交易的、扣成本的检验：没找到。

**K3. 小盘、高波动**：没找到。

**K4. 成本**：16.5 bp 小于你 0.1–0.2% S 的单边成本（我算）。

**K5. 机制**
- 做市商的对冲再平衡。
- 外加原文提到的公司自营交易者的操纵。

**K6. 日终数据可行性：不能。**
- greeks_eod 没有持仓量，机制本身还需要做市商的净头寸。
- 如果另外下载 ThetaData 的 oi，可以做一个「最大持仓量行权价当磁铁」的代理，部分能。

### L. 另选的几条

#### L1. 期权动量（证据最适合你的数据）

**L1-1. 原始文献**
- Heston, Jones, Khorram, Li & Mo，"Option Momentum"，*JF* 78(6):3141–3192，2023。读的是 2021-09 WP，发表版数字未核实。
- **样本**：1996-01 至 2019-06，OptionMetrics；1 个月 ATM 零 delta 跨式持有到期，中间价进场；平均市值 106 亿美元；跨式平均收益 −5.3%/月。
- **结果**：用过去 1–12 个月收益分五组，静态 3.64%/月，每日对冲 5.59%/月。
- **扣成本**（Table 13，滞后 2–12 个月，五分组）。按 Muravyev & Pearson，「算法」「调整后」「有效」分别付报价半点差的 20.3%、51.6%、75.8%：

  | 成本口径 | 月收益 |
  |---|---|
  | 不扣 | 6.22% |
  | 算法 | 3.62% |
  | 调整后 | −0.40% |
  | 有效 | −3.56% |
  | 全额报价 | −6.78% |

- **低成本版本**（十分位，期权点差 < 10%）：7.23 / 5.99 / 4.08 / 2.60（t 1.75）/ 1.12（t 0.75），顺序同上。
- 原文："not profitable if one assumes that the entire quoted spread must be paid"。

**L1-2. 发表后复现**：独立复现没找到。

**L1-3. 小盘、高波动**（Table 12，三分位双重排序）
- 小盘 5.44%，大盘 4.22%。
- 期权高不流动 5.07%，低 4.35%（差 t 0.67）。
- 低信用评级 5.71%，高 1.43%。
- 原文："momentum is more prominent in stocks facing high impediments to arbitrage"。

**L1-4. 成本**：文献直接讨论过，见上表。

**L1-5. 机制**：作者倾向于反应不足（没有长期反转、没有崩盘风险），但不能排除风险溢价随时间变化。

**L1-6. 日终数据可行性：能。**
- 只需要历史跨式收益（日终中间价）。
- 每个名字至少需要 1 年历史，池子每年重选，会损失部分新进名字。

#### L2. 期权流动性溢价（Christoffersen, Goyenko, Jacobs & Karoui 2018）

**L2-1. 原始文献**
- "Illiquidity Premia in the Equity Options Market"，*RFS* 31(3):811–851，2018。
- 摘要："risk-adjusted return spread for illiquid over liquid equity options is 3.4% per day for at-the-money calls and 2.5% for at-the-money puts"。
- 用的是日内有效点差。
- 2012 WP：S&P 500 成分股，1996–2007。

**L2-2. 发表后复现：被否定。**
- Duarte 等 *RFS* 2026 摘要："illiquidity is not strongly priced in stock options"。
- 二手：看涨的流动性策略从 1.52% 降到 0.19%/月（去掉前视之后）。

**L2-3. 小盘、高波动**：WP 只有 S&P 500，没找到。

**L2-4. 成本**：溢价归流动性提供者（净多头的做市商），吃单方拿不到。

**L2-5. 机制**：做市商持有大量净多头，溢价是对他们的补偿。

**L2-6. 日终数据可行性：部分能。** 报价点差有；原文用的日内有效点差没有。

#### L3. 订单流不平衡（Muravyev 2016）

**L3-1. 原始文献**
- "Order Flow and Expected Option Returns"，*JF* 71(2):673–708，2016。
- 摘要："past order imbalances have greater predictive power than any other commonly used predictor of option returns"。
- 效应大小未核实。

**L3-2. 发表后复现**：没找到。

**L3-3 至 L3-5**：未查到分组和成本讨论，不展开。

**L3-6. 日终数据可行性：不能。** 需要带方向的成交量。

#### L4. 需求压力（Garleanu, Pedersen & Poteshman 2009）

**L4-1. 原始文献**
- "Demand-Based Option Pricing"，*RFS* 22(10):4259–4299，2009。
- 样本：CBOE 非做市商净头寸，1996–2001。
- 结论："end users are net short single-stock options"；需求越负的股票，期权越便宜。
- 这是讲价格水平的论文，不是交易策略，没有成本分析。

**L4-2. 发表后复现**：2018 年以后的复现，没找到。

**L4-3. 对你池子的含义（我推断）**：Bryzgalova, Pavlova & Sikorskaya，"Retail Trading in Options and the Rise of the Big Three Wholesalers"，*JF* 78(6) 2023，说散户超过期权成交量的 60%，偏好便宜的周期权。所以你池子里的净需求方向，可能和 GPP 1996–2001 的样本相反。

**L4-6. 日终数据可行性：不能。** 需要带方向的终端用户头寸。

#### L5. 散户买短期期权（Bryzgalova, Pavlova & Sikorskaya 2023）：对「谁付钱」的直接证据

- 2019-11 至 2021-06，按 10 天持有期算，散户整体亏 21 亿美元；相对中间价的交易成本 64 亿美元。
- 原文：亏损集中在"those who buy short-term options and lose money, and those who sell these contracts and make significant profits, even after transaction costs"。
- 这和你「卖方约为 0、买方为负」的结果一致：付钱的人存在，但在你的成本下，无条件卖方拿到的差不多就是点差。
- 按股票波动的分组：没找到。

#### L6. 到期周数错配（Eisdorfer, Sadka & Zhdanov 2022）

- "Maturity Driven Mispricing of Options"，*JFQA* 57(2):514–542，2022。
- 1996–2017：两次月度到期之间相隔 4 周的月份，短期期权收益低于相隔 5 周的月份。delta 对冲每周 16–29 bp，跨式每周 101–187 bp。
- 原文归因于投资者不注意。
- 日终数据可行性：能（只需要日历）。但定义建立在月度到期周期上，周期权时代是否还适用，未核实。

---

## 3. 方法引用核实

### 3.1 McLean & Pontiff (2016)

- "Does Academic Research Destroy Stock Return Predictability?"，*JF* 71(1)，2016 年 2 月。读的是发表版 PDF 第一页（gwern 托管）和发表前稿（counterpointfunds 托管）。
- 97 个预测变量，来自 79 篇研究；都是五分位多空。
- 摘要原文："Portfolio returns are 26% lower out-of-sample and 58% lower post-publication. The out-of-sample decline is an upper bound estimate of data mining effects. We estimate a 32% (58%–26%) lower return from publication-informed trading."
- 摘要还说："Post-publication declines are greater for predictors with higher in-sample returns"。
- 正文："Post-publication returns are lower for predictors that are less costly to arbitrage, that is predictor portfolios with liquid stocks and low idiosyncratic risk stocks"。
- 注意：这是股票收益预测因子的结果，不是期权收益异象。期权异象的衰减没有对应的大样本研究（没找到）。上面 Chen & Zimmermann 那组 E、F、G 的数字（衰减 34–85%）可以作为参照。

### 3.2 Sellke, Bayarri & Berger (2001)

- "Calibration of p Values for Testing Precise Null Hypotheses"，*The American Statistician* 55(1):62–71，2001。读的是 UNC 课程托管的 PDF。
- 下界：当 p < 1/e 时，B(p) = −e·p·ln p，是 **H0 对 H1 的贝叶斯因子（几率）的下界**，也就是对 H0 最不利时的值。
- 对应的条件错误概率：α(p) = (1 + [−e·p·ln p]⁻¹)⁻¹。
- 原文："p = .05 translates into odds B(.05) = .407 (roughly 1 to 2.5) of Ho to H1, and frequentist error probability α(.05) = .289"；"Even p = .01 corresponds to only about 8 to 1 odds against Ho"。
- Table 3 的 −e·p·ln p 值：p = .1 时 .6259，.05 时 .4072，.01 时 .1252，.001 时 .01878。
- 只适用于精确（点）原假设。
- **对打先验的用法（我算）**：后验几率(H1:H0) ≤ 先验几率 × 1/B(p)。
  - 例：先验 P(H1) = 0.2（几率 0.25），测出 p = 0.01，则后验几率 ≤ 0.25 × 7.99 ≈ 2.0，即 P(H1 | 数据) ≤ 0.67。
  - p = 0.05 时，后验几率 ≤ 0.25 × 2.46 ≈ 0.61，即 P(H1) ≤ 0.38。

---

## 4. 总表

单位照原文：「%S」= 占股价；「(ΔS−C)」= 占对冲组合净投入；跨式 % = 占跨式价格。「中间价」= 没扣成本。

| 机制 | 原始效应 | 复现情况与衰减 | 小盘高波动上的证据 | 成本是否吃掉 | 数据可行性 |
|---|---|---|---|---|---|
| A HV−IV（Goyal-Saretto，JFE 2009） | 1996–2005，多空跨式 22.5%/月（2008 WP）或 21.9%（2006 WP），中间价；delta 对冲 2.6–2.7%/月；发表版数字未核实 | 同作者 IPCA WP 1996–2020：10−1 = 3.56%/月 (ΔS−C)（t 20）；HVX 1996–2021：0.78–0.80 %S/月，被选为因子；发表前后分段衰减没找到 | 毛效应在点差宽、成交少的期权上更大，扣成本后更弱（最宽点差三分位到 100% 点差为 5.9%，t 1.37） | 跨式到 100% 报价点差剩 4.1–7.5%/月；delta 对冲版本不显著；单边卖第 1 组中间价毛约 9.9% 跨式价 | 能 |
| B IV 期限斜率（Vasquez，JFQA 2017） | WP 1996–2007：多空跨式 27.1%/月（二手），另一版 19.6%（二手）；发表版未核实 | HVX：0.51–0.55 %S/月，与 Vasquez 同方向；GS-IPCA：t ≈ 20，但按其文字定义方向相反，方向未核实；衰减没找到 | 没找到 | WP 二手：报价点差下剩 12.3% 或 5.5%（两版冲突），1.25 倍时不显著；HVX 量级和你的往返成本相当 | 能（注意财报会污染斜率） |
| C 特质波动（Cao-Han，JFE 2013） | 1996–2009，卖 delta 对冲看涨 5−1 = 1.40%/月 (ΔS−C)（t 8.1），最高档 2.20% | GS-IPCA：−0.92%/月（买方口径）；HVX：−0.45 / −0.40 %S/月；原文四个子期都 > 1%；发表后分段没找到 | 更强：最小市值档 1.63 vs 最大 0.32；最不流动档 2.04 | 原文：有效点差取报价 50% 时就不显著 | 部分能（需要市场因子，可外部下载） |
| D 周末效应（Jones-Shemesh，JF 2018） | 1996–2014，S&P 500 股票期权，对冲看跌非交易期 −0.82%/日 vs 交易日 +0.03%（差 t −11.9） | 原文内 19 年年年为负，后半段略小；单只股票、2014 年后的复现没找到；SPX 上仍在（Terstegge 2025 WP） | 更弱：成交越活跃效应越大 | 原文：不能单独交易；换算约 0.035 %S/周末 ≪ 你的成本 | 能，但只能当叠加规则（周五别买，卖方持有过周末） |
| E 看涨看跌 IV 差（Cremers-Weinbaum 2010；Bali-Hovakimian 2009） | 50 bp/周；1.045%/月（1996–2004） | Chen-Zimmermann：0.98 → 0.47（−52%），2018 年后 t 1.6；排除高借券费股票后再降至少 2/3（Muravyev 等，JFE 2025） | 原文：股票越不流动越强；剔除小盘后更弱 | 股票预测因子，主要是借券费，通过期权赚不到；扣成本的估计没找到 | 能，但很可能就是隐含借券费 |
| F Smirk（Xing-Zhang-Zhao，JFQA 2010） | 1996–2005，FF3 alpha 21 bp/周 | skew1：0.63 → 0.18（−71%，t 1.2），2018 年后 0.09 | 换手率低时更强 | 文献未讨论；用期权表达的往返成本和利差同量级 | 能（先验很低） |
| G ΔIV（An-Ang-Bali-Cakici，JF 2014） | 1996–2011，ΔCall IV 10−1 = 1.09%/月（t 3.45） | dVolCall：0.89 → 0.59（−34%），2018 年后 0.65（t 1.8）；dCPVolSpread 2018 年后 0.43 | 原文：最小股票最强；剔除小盘后 2018 年后 0.09 | 文献未讨论；借券费可能吸收一部分 | 能 |
| H 偏度 / 彩票（Boyer-Vorkink，JF 2014；Bali-Murray，JFQA 2013） | 低减高偏度 10–50%/周（摘要，不对冲）；Bali-Murray 主效应未核实 | GS-IPCA：MF skew −0.34%/月，经 HVX 调整后不显著；Boyer-Vorkink 复现没找到 | 没找到分组；Bali-Murray 可能只用大盘 | 原文 WP：点差随偏度急剧变宽，卖方在 bid 附近基本拿不到 | 能 |
| I Vol-of-vol（Ruan，JFM 2020；Cao-Vasquez-Xiao-Zhan，QJF 2023） | 1996–2016，卖 delta 对冲看涨 5−1 = 0.88%/月 (ΔS−C)（t 13.8）；Ruan 数值未核实 | HVX：0.56–0.59 %S/月，被选为因子；GS-IPCA：−0.64，但经 HVX 调整后反号；衰减没找到 | 没找到（股票收益那一版集中在大盘） | 没找到直接讨论；和你的往返成本同量级 | 能（implied VOV） |
| J 财报前跨式（Gao-Xing-Zhang，JFQA 2018） | 1996–2013，从 −3 到 0 为 3.34%（中间价） | 只有学生博客：中间价 1.17%，按 ask 买 bid 卖 −9.07%；同行评审的复现没找到 | 更强：点差最宽四分位 4.93%、成交最低 5.82%，正是成本最高处 | 吃掉（BSIC；原文未做可交易检验） | 部分能：财报日只能从期限结构定位到周；还原财报日的文献没找到 |
| K 到期钉住（Ni-Pearson-Poteshman，JFE 2005） | 每个到期日至少 16.5 bp 的收益扭曲 | 可交易版本没找到 | 没找到 | 16.5 bp 小于单边成本 | 不能（没有持仓量和做市商净头寸） |
| L1 期权动量（Heston 等，JF 2023） | 1996–2019，五分组 3.64%/月（静态跨式） | 独立复现没找到 | 小盘 5.44 vs 大盘 4.22；期权不流动的差异不显著 | 主版本付「调整后」半点差就转负；低成本十分位付有效点差后 2.60%（t 1.75） | 能 |
| L2 流动性溢价（Christoffersen 等，RFS 2018） | 3.4%/日（看涨）、2.5%/日（看跌）（摘要） | 被 Duarte 等（RFS 2026）否定，属于前视偏差 | 没找到（只有 S&P 500） | 溢价归流动性提供者 | 部分能 |
| L3 订单流（Muravyev，JF 2016） | 效应大小未核实 | 没找到 | 未查到 | 未查到 | 不能 |
| L4 需求压力（Garleanu-Pedersen-Poteshman，RFS 2009） | 讲价格水平，不是策略 | 没找到 | 散户主导后方向可能相反（推断） | 不适用 | 不能 |
| L6 到期周数（Eisdorfer 等，JFQA 2022） | 16–29 bp/周（对冲）、101–187 bp/周（跨式） | 没找到 | 没找到 | 原文说不是成本造成的；可交易性未核实 | 能（周期权是否适用未核实） |

## 5. 对打先验的含义（我的判断，不是文献结论）

1. **证据最硬、又能算的是 A（HV−IV）和 I（VOV）。**
   - 两者都在 2021 年为止的独立样本里仍是因子（HVX，RFS）。
   - 但它们的毛收益和你的往返成本同一量级。
   - 你池子里无条件卖方已经约为 0。单边条件卖出能带来多少增量，两组文献数字差得很远，都是中间价：
     - **Cao & Han 最高 IVOL 档的 delta 对冲卖方**：相对平均水平的增量约 0.4 %S/月（C4）。
     - **Goyal & Saretto 第 1 组的跨式卖方**：毛约 1.8 %S/月（A4）。这个数字最有利，但要打几个折扣：
       - 它是 1996–2005 全市场的结果。
       - 它是按你池子 σ≈0.8 换算的，原样本的平均 IV 约 0.5。
       - 它还要付两腿进场成本。
       - 同一篇 WP 的多空版本，到 100% 报价点差时损失了约三分之二（22.5% → 7.5%）。
   - 先验可以中等偏低，而且要按 Goyenko-Zhang 和 Duarte 的结论再打折。A 的跨式卖方是其中最值得测的一条。
2. **C（IVOL）和 B（斜率）同一类**，C 的成本证据更差：原文在 50% 点差时已不显著。
3. **E、F、G 在你这个池子上先验很低。** 发表后衰减 34–85%，2018 年后多不显著，并且很大一块是借券费，而借券费正是 GME、AMC 这类名字最高。
4. **D、K、J（买方）不能作为独立策略。**
   - D 可以做执行层面的叠加规则。
   - J 的卖方一侧（de Silva 等：卖穿财报，散户付钱，没被学习掉）是对你最友好的那一面，但需要周级的财报定位，而且没有文献验证过这种定位方法。
5. **L1 期权动量**是现有证据里，对数据要求最低、在高套利成本名字上更强的一条。但成本敏感度很高（付「调整后」半点差就转负），也没有独立复现。

## 6. 主要来源

- Goyal & Saretto WP 2008：http://www.ruf.rice.edu/~jgsfss/goyal_041808.pdf ；WP 2006（ERIM）：https://www.erim.eur.nl/fileadmin/erim_content/documents/10
- Goyal & Saretto, "Are Equity Option Returns Abnormal? IPCA Says No", Dallas Fed WP 2214：https://www.dallasfed.org/-/media/documents/research/papers/2022/wp2214.pdf
- Horenstein, Vasquez & Xiao, "Common Factors in Equity Option Returns", RFS：https://www.repository.cam.ac.uk/bitstreams/84d849d1-d42f-4a52-a60c-f5de782a69a5/download
- Vasquez 2017 JFQA 摘要：https://www.cambridge.org/core/journals/journal-of-financial-and-quantitative-analysis/article/equity-volatility-term-structures-and-the-cross-section-of-option-returns/F0A40E99FD2458367DD9A56A89783D38 ；WP 二手：https://www.cxoadvisory.com/volatility-effects/exploiting-the-implied-volatility-term-structure/
- Cao & Han 2013 接受稿：https://utoronto.scholaris.ca/bitstreams/9a194795-47c8-4979-b07f-3e15445d967b/download
- Zhan, Han, Cao & Tong RFS 2022 作者稿：https://utoronto.scholaris.ca/bitstreams/5c530340-f282-4a35-a281-76336e3757b1/download ；2016 WP：https://abfer.org/media/abfer-events-2016/annual-conference/investment-finance/226-option-return-predictability.pdf
- Bali, Beckmeyer, Moerke & Weigert RFS 2023：https://libra.unine.ch/server/api/core/bitstreams/22f02a64-96bf-4bdb-801d-6734fce4f7c7/content
- Jones & Shemesh JF 2018：http://faculty.marshall.usc.edu/Christopher-Jones/pdf/jones_shemesh_2018_jf.pdf
- Muravyev & Ni JFE 2020：https://ideas.repec.org/a/eee/jfinec/v136y2020i1p219-238.html
- Terstegge 2025 WP：https://fmai.memberclicks.net/assets/docs/Derivatives2025/Terstegge.pdf
- Cremers & Weinbaum JFQA 2010 摘要：https://www.cambridge.org/core/journals/journal-of-financial-and-quantitative-analysis/article/deviations-from-putcall-parity-and-stock-return-predictability/D9BA8F97580328AAFD7988B092FE5D50
- Bali & Hovakimian MS 2009：https://econpapers.repec.org/RePEc:inm:ormnsc:v:55:y:2009:i:11:p:1797-1812
- Xing, Zhang & Zhao JFQA 2010：https://www.pbcsf.tsinghua.edu.cn/__local/A/24/EA/815CC33800CAA0F7D894E9292A1_6CC8B38B_27B25.pdf
- An, Ang, Bali & Cakici（NBER w19590）：https://www.nber.org/system/files/working_papers/w19590/w19590.pdf
- Chen & Zimmermann：https://raw.githubusercontent.com/OpenSourceAP/CrossSection/master/SignalDoc.csv ；https://huggingface.co/datasets/OpenSourceAP/CrossSection ；https://github.com/OpenSourceAP/CrossSection/issues/156
- Muravyev, Pearson & Pollet JFE 2025：https://ideas.repec.org/a/eee/jfinec/v172y2025ics0304405x25001618.html
- Boyer & Vorkink JF 2014：https://ideas.repec.org/a/bla/jfinan/v69y2014i4p1485-1527.html ；WP 二手：https://www.cxoadvisory.com/equity-options/sell-lottery-tickets-for-their-fun-and-your-profit
- Bali & Murray 网络附录：https://static.cambridge.org/content/id/urn:cambridge.org:id:article:S0022109013000410/resource/name/S0022109013000410sup001.pdf ；Gruber 讨论稿：https://people.lu.usi.ch/gruberp/static/files/gruber_discussion_bali_murray.pdf
- Cao, Vasquez, Xiao & Zhan QJF 2023：https://openaccess.city.ac.uk/id/eprint/30606/1/2023Mar_VOV_QJF.pdf
- Gao, Xing & Zhang WP：https://www.pbcsf.tsinghua.edu.cn/__local/B/7B/EF/9C90E5DE82928B64858EFBA685C_E7B3C45C_4183B.pdf
- Dubinsky 等 2017 幻灯片：https://www.stern.nyu.edu/sites/default/files/assets/documents/NYU%20conference%20Johannes%20final.pdf
- de Silva, So & Smith 2024 幻灯片：https://qgroup.wildapricot.org/resources/2024%20Spring%20Seminar/Presentations/LosingIsOptional_20240430%20So.pdf
- BSIC 复现（非同行评审）：https://bsic.it/straddling-outside-and-into-earnings-part-ii-2/
- Golez & Jackwerth JFE 2012：https://d-nb.info/1112655492/34
- Option Momentum 2021 WP：https://www.acem.sjtu.edu.cn/sffs/2021w/pdfs/3.pdf
- Christoffersen 等 2012 WP（CREATES）：https://repec.econ.au.dk/repec/creates/rp/13/rp13_48.pdf ；RFS 摘要：https://econpapers.repec.org/RePEc:oup:rfinst:v:31:y:2018:i:3:p:811-851
- GPP（NBER w11843）：https://www.nber.org/papers/w11843.pdf
- Muravyev & Pearson 网络附录：https://www.dmurav.com/MuravyevPearson.OptionsTradingCosts.InternetAppendix.pdf
- Duarte 等，前视偏差（二手）：https://cxoadvisory.com/equity-options/look-ahead-bias-in-option-trading-backtests
- Bryzgalova, Pavlova & Sikorskaya JF 2023：https://lbsresearch.london.edu/id/eprint/2827/
- McLean & Pontiff JF 2016：https://www.gwern.net/doc/economics/2016-mclean.pdf ；发表前稿：https://counterpointfunds.com/wp-content/uploads/2017/07/PredictabilityMcleanPontiff.pdf
- Sellke, Bayarri & Berger 2001：https://hannig.cloudapps.unc.edu/STOR654/handouts/SellkeBayarriBerger2001.pdf
- Chen & Velikov（FEDS 2020-039）：https://www.federalreserve.gov/econres/feds/files/2020039pap.pdf
