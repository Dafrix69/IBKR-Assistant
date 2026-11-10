# 文献证据档案：盘前盘后因消息跳涨 ≥ 5 % 后在同一时段卖出

编写日期 2026-11-09。只查了文献，没有读或碰任何本地行情数据。

**被测规则**（用户自己的交易纪律）：正股在盘后（16:00–20:00 ET）或盘前（04:00–09:30 ET）相对上一常规收盘涨 ≥ 5 %（多为财报或其他好消息），在同一延长时段内约 30–60 分钟内按 bid 卖出；基准是持有到反应日常规收盘。股票池：每年 20–40 只波动大的美股科技中小盘，2018–2026。

## 0. 怎么读这份档案

- **标注规则**同 `lit_dossier.md` §0：
  - 「WP」= 工作论文版；「发表版」= 期刊版。
  - 「二手」= 只看到 CXO Advisory、UCLA Anderson Review、检索摘要之类的转述。
  - 「只看摘要」= 只看到出版社或 OpenAlex 摘要。
  - 「未核实」= 没亲眼看到原文数字；「没找到」= 找了但没有。
  - 「我算」= 本档案作者的算术或推断，不是文献结论。
- **原文抽取**：PDF 由脚本抽成文本后核对，放在
  `/private/tmp/claude-501/-Users-dafrix-Developer-ibkr/131b9ce7-b3d3-4034-9ade-446408eb8392/scratchpad/eh/txt/`（临时目录，重启会丢）。
- **brief 更正**：Barclay & Hendershott 2004 是 *Journal of Finance* 59(2)，不是 JFQA。
- **最重要的一句**：**没有一篇论文直接检验这条规则**（延长时段 bid 对反应日收盘、≥ 5 % 跳涨、中小盘）。下面拆成两段单独找证据：**A 段**延长时段价格 → 次日开盘，**B 段**开盘 → 收盘。规则赚钱，要求两段合起来是**反转**（收盘低于卖出时的 bid），且反转幅度大于多付的点差。

## 1. 共用问题（先读这一节）

### 1.1 样本时间

- 样本覆盖 2018 年以后的只有四篇：Eaton–Shkilko–Werner（2024-01 至 05）、Barber–Huang–Odean–Schwarz（2018-05 至 2020-08）、Friedman–Zeng（2010–2021）、Christensen–Timmermann–Veliyev（到 2020 年）。
- 其余都在 2015 年以前结束，其中 Barclay–Hendershott 是 2000 年，那时还没有十进制报价，最小价位 1/16 美元，点差会被抬高。
- 2020 年以后，散户经 Robinhood 等进入盘前盘后，24 小时交易场所也出现了。这一时代能看到的系统证据只有 Eaton 等 2025 一篇 WP，样本只有 5 个月。

### 1.2 规则相关的口径陷阱

- **成交价和报价不是一回事**。Grégoire & Martineau（JAR 2022，只看到引言，vLex 摘录）：盘后用成交价算的收益"significantly lag the adjustment in midquotes"，这对 S&P MidCap 400 和 SmallCap 600 成立，对 S&P 500 不成立。
  - 正面消息后，ask 调整快，bid 调整慢。
  - 卖方拿到的是慢的那一边，所以用盘后成交价或中间价回测会高估卖出所得。
- **≥ 5 % 的条件本身就是选择**。无条件的反转系数（§2A 各表）不能直接套到 5 % 跳涨上（我算的换算都带这个告诫）。
- **常规时段为 0 的天也要算**：股票在 4–8 pm 期间完全没有成交的情况常见。Grégoire–Martineau 引言："approximately 20%" 的公司-财报观测在公告后盘后无成交，中位成交仅 16 笔。

### 1.3 成本换算：都折成每笔占股价 %，和半点差比

| 来源 | 样本 | 盘后 / 盘前 | 常规时段 | 口径 |
|---|---|---|---|---|
| Barclay & Hendershott, JF 2004, Table II Panel A（p.691） | Nasdaq 成交额前 200 只，2000-03 至 12 | 盘后有效半点差 0.572 %，盘前 0.677 % | 0.169 % | 有效半点差，% |
| 同上，成交额最低四分位 | 同上 | 盘后 0.883 %，盘前 0.989 % | 0.226 % | 同上 |
| Christensen 等, JFE 2025, §4.1（arXiv 版 p.21） | S&P 500 里盘后最活跃的 50 只，2008-06 至 2020-12 | 盘后平均报价点差 58.1 bp；财报时点中位 60 bp，10–20 分钟后 30 bp | 8.4 bp | 全幅报价点差 |
| 同上，Appendix F.2 | 同上 | 盘后中位点差多在常规时段的 4–10 倍 | | |
| Eaton, Shkilko & Werner, WP 2025, Table 5/6（正文 p.15–17） | BOATS，2024-01 至 05 | **20:00–04:00**：报价 89 bp，有效 69 bp（Hagströmer 调整后 64） | 报价约 37 bp，有效 30 bp | 全幅（有效点差定义为 2×\|价−中间价\|，Table 6 注） |
| 同上，频繁交易的 393 只 | 同上 | 夜间报价 28 bp | 20 bp | 全幅 |

- **折成半点差（我算）**：
  - 液态大盘的盘后半点差约 0.15–0.30 %（Christensen 等）。
  - 2000 年 Nasdaq 前 200 只里最不活跃的四分位，盘后约 0.88 %。
  - 2024 年夜盘全样本约 0.35 %。
- 常规收盘卖出的半点差约 0.04–0.2 %。所以**规则相对基准多付约 0.15–0.7 % 股价**。
- **2018 年以后美股科技中小盘、在 5 % 跳涨那一刻的盘后点差：没找到系统数字**。
  - 检索到的只有券商和教育网站的定性说法，以及 Lim（SSRN 6610883，2026，二手）的 30 只活跃股夜盘有效点差"平均高 7 美分"。
  - 表里所有样本都比本研究的池子更液态，所以 0.15–0.7 % 是**下界**。

### 1.4 只限财报，还是任何消息

- **只看财报**：Jiang 等 2012、Michaely 等 2014、Li 2016、Grégoire–Martineau 2022、Christensen 等 2025、Lyle 等 2018、Martineau 2022、Friedman–Zeng 2022、Chordia 等 2009、Eaton 等 Table 4。
- **任何消息或注意力事件**：Barclay–Hendershott 2003 及 Eaton 等 Table 1–3（全部交易日，不按消息条件）、Walkup 2009、Berkman 等 2012、Barber–Odean 2008、Aboody 等 2018、Barber 等 2022、Chan 2003（新闻标题）。
- 规则的触发条件是「好消息」，而财报类证据和注意力类证据的方向恰好相反（见 §2），所以这条区分很要紧。

## 2. 逐条证据

### A. 盘后价格效率：盘后跳动到次日收盘是反转还是延续

**A1. Barclay & Hendershott (2003)**，"Price Discovery and Trading After Hours"，*RFS* 16(4):1041–1073。读的是作者站点的发表版 PDF。
- **样本**：Nasdaq 成交额前 250 只，2000-03 至 12。
- **价格发现的分布**（p.1056）：收盘到开盘之间的价格发现，74 % 在盘前（08:00–09:30），15 % 在盘后（16:00–18:30），9 % 在开盘那笔成交。
- **无偏回归**（Fig.6，p.1068）：在每个 15 分钟时点 i，用 close-to-close 收益对 close-to-i 收益回归。
  - 盘后斜率在 16:15 约 0.45，随盘后时段推进升到约 0.6。
  - 盘前斜率 0.8–0.9。
  - 盘后与盘前的最小差 0.25，t 约 6。
- **含义（我算）**：
  - 无条件地看，盘后走出的变动，到次日收盘只保留 45–60 %，其余回吐。
  - 对 5 % 的变动，这相当于回吐 2–2.75 %。
  - 但这里包含了 1/16 价位时代的买卖价跳动，也没有按消息条件。
- 作者在结论（p.1070）里预测盘后发布会带来"larger price reversals"。这是预测，不是检验。

**A2. Walkup (2009)**，"The Cost of Illiquidity: Evidence from After-Hours Trading"，WP。**二手**，只看到 CXO 2009-09-17 的转述；原文和发表情况没找到。
- **样本**：2006 年三大交易所的盘后成交。
- **结果**：
  - 盘后成交笔数在正常范围内（均值 ±2σ）时，盘后价格变动的 40–65 % 在次日开盘即回吐。
  - 正向变动回吐 44 %，负向 56 %。小盘股回吐多约 7.7 %。
  - **成交笔数异常高（> +2σ，多为公司消息）时，回吐"shrinks considerably, even becoming a continuation"**。没有给数字。
- 这是本档案里**与规则最直接相关的一条**：有消息、成交放量的盘后跳动，开盘前**不**回吐。

**A3–A4. 只看摘要的两篇。**
- Jiang, Likitapiwat & McInish (2012)，"Information Content of Earnings Announcements: Evidence from After-Hours Trading"，*JFQA* 47(6):1303–1330：S&P 500，2004–2008，盘外季报；大部分价格发现在发布后立即发生，"Prices in AHT show a large degree of informational efficiency"。反转或延续的数字：未核实。
- Michaely, Rubin & Vedrashko (2014)，*Review of Finance* 18(6):2003–2044：交易时段内发布的财报，即时反应比同类盘外发布的小约 50 %；样本期未核实。同作者 2016 *JAE* 62(1):24–45：摘要没拿到，未核实。

**A5. Jiasun Li (2016)**，"Slow Price Adjustment to Public News in After-Hours Trading"，*Journal of Trading* 11(3):16–31（发表版），SSRN 2323752（WP）。**二手**，看的是 CXO 对 2014-01 WP 的转述。
- **样本**：2002–2012 年 5,881 次带意外的盘后季报，限流动性尚可的股票。
- **结果**：盘后 16:00–20:00 内，顺着意外方向的累计收益"generally increases"，次日"does not immediately reverse"。
- **策略**：顺势进场，持有 ≤ 4 小时：零延迟 1.53 %/笔；延迟 1 分钟 0.72 %；延迟 1 分钟并扣成本 0.66 %。按实际成交价计，已含有效点差。
- 方向是**延续**，对规则不利。
- 发表后复现：只在检索摘要里看到一篇 2025 年 GSU 博士论文（Blackstone），说 Li 发表后盘外价格发现变快了。原文打不开（403），未核实。

**A6. Grégoire & Martineau (2022)**，"How Is Earnings News Transmitted to Stock Prices?"，*JAR* 60(1):261–297。**只看到引言**（vLex 摘录）。
- **样本**：S&P 1500，2011–2015，盘后。
- **结果**：
  - 价格主要通过报价调整，而不是靠成交。
  - 正面意外后 ask 先动、bid 滞后。
  - 公告前的点差往往已经包住次日 16:00 的收盘价。
  - "midquote price adjustments to news occur quickly but are followed by price drifts for stocks with large surprises"。也就是说，**大意外之后中间价继续漂移（延续）**，幅度未核实。

**A7. Christensen, Timmermann & Veliyev (2025)**，"Warp Speed Price Moves: Jumps after Earnings Announcements"，*JFE*，DOI 10.1016/j.jfineco.2025.104010。读的是 arXiv 2024-11 版，正文加附录共 114 页。
- **样本**：S&P 500 里盘后成交最活跃的 50 只，2008-06 至 2020-12，盘后财报 2,193 次（p.32、§6.2）。
- **结果**：
  - 约 70 % 的公告后价格在 5 分钟内发现（Fig.F.4）。
  - 把加权价格贡献（WPC）延伸到次日 09:30，曲线在公告日之后"essentially flat"（附录脚注 76）。
  - 正文 p.34："little evidence of elevated returns during the overnight period … or at the opening of trading on the next day"。
- **策略**：跳空后顺向进场、18:30 平仓。
  - 2008–2015：中间价 2.00 %/笔。
  - 2016–2020：中间价 0.80 %；付点差后"small and insignificant"。
- **含义**：对大盘、液态股，2016 年以后盘后价格已经接近有效，既不延续也不反转。

**A8. Eaton, Shkilko & Werner (2025)**，"Nocturnal Trading"，WP 2025-03-16（AFA 站点 PDF，已读）。
- **样本**：
  - **Tape A/B 证券**（NYSE 与 NYSE Arca/区域所上市，**不含 Nasdaq 上市的 Tape C**），每个时段至少 10 笔成交，2024-01 至 05。
  - 共 484 只，其中股票和 ADR 347 只。
- **反转系数**（Bogousslavsky–Muravyev 口径）：时段收益之后到当日收盘的收益，对该时段收益的回归斜率。0 表示不回吐，−100 % 表示全部回吐。
  - Table 2 Panel A，股票和 ADR，全部交易日，不按消息条件：
    - 16:00–20:00：−9.82 %。
    - 04:00–09:30：−8.95 %。
    - 20:00–24:00：−53.80 %。
  - Table 3，按 2023Q4 成交量分三档：
    - 低成交档：盘后 −15.21 %，盘前 −4.62 %。
    - 高成交档：盘前 −19.16 %。
- **财报日**（Table 4，2024Q1；盘前发布 66 只，盘后发布 42 只）：
  - 盘后发布：16:00–20:00 的 WPC 69.03 %（中位 70.14 %），**常规时段 WPC 32.46 %（中位 18.12 %）**。
  - 盘前发布：04:00–09:30 的 WPC 34.53 %（中位 36.07 %），常规时段 39.03 %（中位 45.01 %）。
  - WPC 带符号、按总变动加权。常规时段为正，表示财报日之后的常规时段**继续朝总变动方向走**，也就是延续。
- **含义（我算）**：
  - 无条件的 −10 % 套到 5 % 跳涨上，约等于回吐 0.5 %。
  - 但财报日的 WPC 显示延续。样本小，而且不含 Nasdaq 股。

**A9. Lyle, Rigsby, Stephan & Yohn (2018)**，"The Speed of the Market Reaction to Pre-Open versus Post-Close Earnings Announcements"，WP 2018-04（已读）。
- **样本**：2006–2015 年 WSH 时间戳，48 % 的盘外财报在盘前发布。
- **结果**：盘前发布的 t+1 反应更弱，t+2 至 t+5 跟着财报意外走得更多（Table 5，p.17–18）。
- **对规则的含义**：盘前那条腿，价格是**反应不足**而不是过度。

**A10. 小结**
- 只有 2000 年的无条件证据（A1），和 2006 年正常成交量的盘后变动（A2），指向反转。
- 凡是按消息、财报、放量来条件化的证据（A2 放量组、A5、A6、A7、A8 Table 4、A9），都指向**延续或有效**。没有一条指向反转。

### B. 开盘价压力与日内反转（注意力买盘）

**B1. Berkman, Koch, Tuttle & Zhang (2012)**，"Paying Attention: Overnight Returns and the Hidden Cost of Buying at the Open"，*JFQA* 47(4):715–741。
- **二手**：KU 托管的 WP 返回 403，出版社页面只有摘要；数字取自 CXO 对 2010-06 WP 的转述。
- **样本**：美国市值最大的 3,000 只，1996–2008。
- **结果**：
  - 全体：隔夜 +0.1 %，日内 −0.07 %。
  - 高散户关注、低机构持股组：隔夜 +0.2 至 +0.3 %，日内 −0.2 至 −0.4 %。
  - 不流动、高卖空组：隔夜 +0.4 至 +0.6 %，日内 −0.4 至 −0.7 %。
  - 高情绪月份，效应"more than twice as large"。
- 摘要说，开盘买入高关注股的隐性成本常常超过有效半点差。
- 这是规则 B 段（开盘 → 收盘）**有利**的证据，但条件是「近期受关注」，不是「当晚有好消息」。

**B2. Lou, Polk & Skouras (2019)**，"A Tug of War: Overnight versus Intraday Expected Returns"，*JFE* 134(1):192–213。读的是 LSE 接受稿。
- **样本**：1993–2013，月度组合。
- **结果**：
  - 动量和短期反转的溢价几乎全部在隔夜赚得。
  - 盈余动量（SUE）多空：隔夜 CAPM alpha 0.56 %/月（t 3.20），日内与 0 无差别（p.17）。
- 是组合层面的证据，不是事件日；只说明「消息溢价在隔夜实现、日内不再追加」。

**B3. Barber & Odean (2008)**，"All That Glitters"，*RFS* 21(2):785–818。已读发表版。
- 散户按笔数算的买卖不平衡（Table 3，§4.3，p.801–803）：大型折扣券商（1991–1996）不在新闻里的股票 2.70 %、在新闻里的 9.35 %；大型零售券商（1997–1999）−1.84 % 对 16.17 %。散户是注意力事件的净买方，这是「谁在付钱」的来源。

**B4. Aboody, Even-Tov, Lehavy & Trueman (2018)**，"Overnight Returns and Firm-Specific Investor Sentiment"，*JFQA* 53(2):485–505。**只看摘要**。
- 隔夜收益短期持续（难估值公司更强），长期反转。数字未核实。

**B5. Barber, Huang, Odean & Schwarz (2022)**，"Attention-Induced Trading and Returns: Evidence from Robinhood Users"，*JF* 77(6):3141–3190。读的是 2020-11 WP（SSRN 3715077），数字取自 WP。
- **样本**：Robintrack，2018-05-02 至 2020-08-13。
- **结果**：
  - 发表版摘要：每天买入最多的股票，20 日超额收益 −4.7 %。
  - 羊群日当天平均收益 14 %，其中开盘收益 11 %（p.9）。约 1/3 的事件当日为负。
  - 之后 5 日超额收益 −2.6 至 −2.9 %，"all of these losses can be traced to intraday day returns"（p.19）。
- **我算**：羊群日当天，开盘到收盘大约还**涨**约 3 %（1.14/1.11 − 1）。
  - 但羊群日是按当天用户增加来选的，这是事后选择。
  - 正负事件混在一起，不能读成「好消息跳空后当日日内反转」。

**B6. Cui, Gozluklu & Haykir (2024)**，"A Pond for Small Fish? News and (Retail) Trading After-Hours"，WP。**二手**，只看到 Eaton 等的引述和 QUB 研讨会摘要。
- 盘后的公司新闻吸引 Robinhood 散户，**尤其是正面、预定的新闻**。收益数字没找到。
- 这是 E1「谁付钱」在盘后时段最直接的证据。

**B7. 跳空回补（gap fade）和跳空延续（gap-and-go）的同行评审数字：没找到。**
- 检索到的「约一半回补」来自博客和教育站，不引用。

### C. 反方：PEAD、新闻动量，以及当日开盘 → 收盘

**C1. Bernard & Thomas (1989)**，*JAR* 27（增刊）；**(1990)**，*JAE* 13(4)。只看到题录和关键词，本档案不引用其数字。

**C2. Chordia, Goyal, Sadka, Sadka & Shivakumar (2009)**，"Liquidity and the Post-Earnings-Announcement Drift"，*FAJ* 65(4):18–32。**只看摘要**。
- 多空月收益：最液态组 0.04 %，最不液态组 2.43 %（市值加权）。
- 交易成本吃掉纸面利润的 70–100 %。

**C3. Martineau (2022)**，"Rest in Peace Post-Earnings Announcement Drift"，*Critical Finance Review* 11(3–4):613–646。读的是 CFR 终稿 PDF。
- **样本**：1984–2019，I/B/E/S。微盘股 = 市值低于 NYSE 第 20 百分位。
- **Table 3（p.23）**：
  - Panel A，[0,1] 窗口对意外十分位的系数：非微盘股从 1984–90 的 0.002 升到 2016–19 的 0.012（R² 0.017 → 0.117）；微盘股从 0.003 升到 0.010。
  - Panel B，[2,60] 窗口：非微盘股 2006 年后不显著（2016–19 为 −0.002）；微盘股 2016–19 为 0.002，不显著。
- **注意**：day 0 把公告日和下一交易日合并（p.18），**分不出盘后价、开盘价和收盘价**。

**C4. Subrahmanyam (2025)**，SSRN 5930255，WP。**二手**（UCLA Anderson Review）。
- 2001-02 至 2024-12 复现盈余漂移因子：全体 t 2.18，剔除微盘股后 t 1.43。

**C5. Chan (2003)**，"Stock Price Reaction to News and No-News: Drift and Reversal after Headlines"，*JFE* 70(2):223–260。**只看摘要**。
- 有新闻标题的股票，之后有漂移，坏消息后尤其强；没有新闻的极端涨跌，之后反转。效应集中在小盘、不流动股。
- 是月度口径，数字未核实。
- 方向：「有消息」的跳动倾向延续，**和规则相反**。

**C6. Friedman & Zeng (2022)**，"Retail Investor Trading and Market Reactions to Earnings Announcements"，WP 2022-11（已读摘要和数据节）。
- 样本 2010–2021：财报窗口的散户交易，伴随更强的公告期反应和更强的短期 PEAD；散户买卖不平衡与公告收益无关。

**C7. 2016 年以后正面财报跳空、当日开盘 → 收盘（尤其小盘）是正还是负：没找到直接证据。**
- 最接近的是 A8 Table 4：2024Q1，Tape A/B，盘后发布的财报日常规时段 WPC 为正（延续），但不分正负意外，也没有小盘。
- 还有 B5 的羊群日：当天日内为正，但有事后选择问题。

## 3. 对打先验的含义（我的判断，不是文献结论）

**E1 谁在付钱。**
- 说得出：被盘后、盘前好消息吸引进场的散户注意力买盘（B3、B6，以及 B1 的开盘溢价），在流动性薄的时段把价格推过头。
- 对立面同样有名有姓：高频做市商主要靠报价来调整价格（A6），2016 年后液态股盘后价格已接近有效（A7）。
- 没被套利掉的理由只有一条：盘后点差宽、可借券少，做空推高的价格成本高（§1.3）。

**E2 发表后的独立复现。**
- **严格按规则的比较对象**（延长时段价格对反应日收盘，按好消息条件化）：原始证据只有 2000 年的无条件回归（A1），和 2006 年正常量组（A2，二手）。
- 发表后按消息、财报条件化的研究（A5、A6、A7、A8 Table 4、A9）**没有复现反转，而是看到延续或有效**。
- **宽松地只看 B 段**（开盘价压力 → 日内回吐）：Berkman 2012 之后有 Lou–Polk–Skouras 2019、Aboody 2018、Barber 等 2022（含 2018–2020 小盘、低价股）。但这些都是「注意力」或「隔夜」条件，不是「盘后好消息跳涨」；而且 Barber 等的羊群日当天日内是涨的。
- 小盘：Walkup（二手）说小盘回吐多约 7.7 %；Eaton 等的低成交档盘后 −15 %。两者都是无条件的。

**E3 成本比 R（我算）。**
- **毛效应**，按「5 % 跳涨回吐多少」折成占股价 %：
  - Eaton 等无条件 −9.82 % → 约 0.5 %。
  - 低成交档 −15 % → 约 0.75 %。
  - Berkman 不流动组 B 段 → 0.4–0.7 %。
  - Barclay–Hendershott 2000 → 2–2.75 %。但那是 1/16 价位时代、无条件，含买卖价跳动，不宜作为 2018 年以后的估计。
  - 条件化在财报或放量的那些研究给出的毛效应 ≤ 0（延续）。
- **成本**：规则相对「收盘卖」多付的半点差约 0.15–0.7 %，而且是下界（§1.3）。
- **R ≈ 0.5/0.3 ≈ 1.7**（液态、最乐观）到 **0.5/0.7 ≈ 0.7**（中小盘）。如果取财报条件下的延续证据，R ≤ 0。
- **结论**：任何合理读法下 R < 2；按中小盘的成本，R < 1。

**E4、E5（交给评估人核对）。**
- 我没读本地数据和账本。印象中 `research/small_cap_orb`（2026-11-02）测过盘前和夜盘**做空**，107 个配置全未过预设标准。那是相邻机制，方向和本规则不同（做空，不是了结多头），不宜直接当「同机制 FAIL」；请评估人按账本判断。
- 数据可行性：规则需要盘前盘后分钟级的 bid（TWS 的 BID_ASK 数据）、事件时点和消息来源。日终 greeks_eod 做不了。

**我的档位判断：15 %（区间 5–30 %）。**
- 按表起点：如果接受宽松的 E2（B 段注意力反转，有发表后复现、含小盘），起点 50 %；如果用严格的 E2（规则真正比较的那一段，发表后反而看到延续），起点 15 %。
- 下调：R < 2 降一档。若按中小盘的成本取 R < 1，协议规定直接 5 %。
- 所以宽松读法落在 30 %，严格读法加成本读法落在 5 %。
- 我取 15 %，理由是：
  1. 最直接相关的放量或财报条件化证据，方向和规则相反（A2 放量组、A5、A6、A8 Table 4、A9）。
  2. 支持规则的证据要么是 2000 年无条件的，要么是「注意力」而非「好消息」条件的。
  3. 本池子的盘后点差没有文献数字，只能取下界。
- **按协议闸门**：15 % 刚好够测；5 % 不测。若测，事前写死：按 bid 成交而不用盘后最后成交价（§1.2）；财报和非财报消息、盘前和盘后（A9 说盘前更可能延续）分开报告。

## 4. 主要来源

- Barclay & Hendershott 2003 *RFS*：https://doi.org/10.1093/rfs/hhg030 ；PDF https://faculty.haas.berkeley.edu/hender/after_hours_price_discovery.pdf
- Barclay & Hendershott 2004 *JF* 59(2)：https://doi.org/10.1111/j.1540-6261.2004.00646.x ；PDF https://faculty.haas.berkeley.edu/hender/After_Hours_Costs.pdf
- Barclay & Hendershott 2008 *JEF* 15(5)：https://faculty.haas.berkeley.edu/hender/After_Hours_Over_Time.pdf
- Jiang, Likitapiwat & McInish 2012 *JFQA*：https://doi.org/10.1017/S002210901200049X
- Michaely, Rubin & Vedrashko 2014 *RoF*：https://doi.org/10.1093/rof/rft054 ；2016 *JAE*：https://doi.org/10.1016/j.jacceco.2016.04.002
- Walkup 2009（CXO 二手）：https://www.cxoadvisory.com/calendar-effects/abnormal-returns-from-providing-liquidity-after-hours/
- Li 2016 *J. Trading*：https://doi.org/10.3905/jot.2016.11.3.016 ；CXO：https://cxoadvisory.com/individual-investing/an-edge-for-attentive-traders-after-hours
- Grégoire & Martineau 2022 *JAR*：https://doi.org/10.1111/1475-679X.12394 ；引言摘录：https://law-journals-books.vlex.com/vid/how-is-earnings-news-1042471185
- Christensen, Timmermann & Veliyev 2025 *JFE*：https://doi.org/10.1016/j.jfineco.2025.104010 ；https://arxiv.org/abs/2601.08962
- Eaton, Shkilko & Werner 2025 WP：https://afajof.org/management/viewp.php?n=162176
- Lyle 等 2018 WP：https://business.columbia.edu/sites/default/files-efs/imce-uploads/LYLE%20LRSY_April_18_2018.pdf
- Berkman 等 2012 *JFQA*：https://doi.org/10.1017/S0022109012000270 ；CXO：https://www.cxoadvisory.com/calendar-effects/the-lure-of-trading-at-the-open/
- Lou, Polk & Skouras 2019 *JFE*：https://doi.org/10.1016/j.jfineco.2019.03.011 ；http://eprints.lse.ac.uk/87481/
- Barber & Odean 2008 *RFS*：https://doi.org/10.1093/rfs/hhm079
- Aboody 等 2018 *JFQA*：https://doi.org/10.1017/S0022109017000989
- Barber, Huang, Odean & Schwarz 2022 *JF*：https://doi.org/10.1111/jofi.13183 ；WP：https://www.smallake.kr/wp-content/uploads/2020/12/SSRN-id3715077.pdf
- Cui, Gozluklu & Haykir（研讨会页）：https://qub.ac.uk/schools/queens-business-school/events/past-seminars/APondforSmallFishNewsandRetailTradingAfterHoursArieGozluklu.html
- Bernard & Thomas 1989：https://doi.org/10.2307/2491062 ；1990：https://doi.org/10.1016/0165-4101(90)90008-R
- Chordia 等 2009 *FAJ*：https://doi.org/10.2469/faj.v65.n4.3
- Martineau 2022 *CFR*：https://cfr.ivo-welch.info/published/papers/martineau2021rest.pdf
- Subrahmanyam 2025（二手）：https://anderson-review.ucla.edu/is-post-earnings-announcement-drift-a-thing-again
- Chan 2003 *JFE*：https://doi.org/10.1016/S0304-405X(03)00146-6
- Friedman & Zeng 2022 WP：https://anderson-review.ucla.edu/wp-content/uploads/2023/01/RetailTrading-20221126.pdf
