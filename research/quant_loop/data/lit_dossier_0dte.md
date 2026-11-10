# 文献证据档案（0DTE 分册）：SPX 0DTE 期权收益的先验依据

编写日期 2026-11-09。只查了文献，没有碰本地任何行情数据。格式同主档案 `lit_dossier.md`（标注规则见其 §0）。

## 0. 怎么读这份分册

- **标注**：每个数字注明（出处，版本，表/页）。「WP」= 工作论文；「发表版」= 期刊版；「二手」= 只看到别人转述；「只读摘要」= 只看到摘要；「仅图」= 原文只在图里给，没有表；「我算」= 本档案作者的算术或推断。
- **原文抽取**：PDF 用 pypdf 抽成文本后核对，文本在
  `/private/tmp/claude-501/-Users-dafrix-Developer-ibkr/131b9ce7-b3d3-4034-9ade-446408eb8392/scratchpad/txt0/`；Vilkov 的复现包（论文 Markdown 版与 `.tex` 表）在同目录的 `vk/`。临时目录，重启会丢。
- **SSRN 本会话被封（403 / Cloudflare）**。凡只挂在 SSRN 上的稿子都没读到全文，下文逐条标明。
- **单位换算（我算）**：文献多用「占标的 %」。1 bp 标的 × SPX × 100 乘数 = 每 1 组的美元。取 SPX ≈ 3,800（2020-01…2022-04 的粗略均值：2020 年均约 3,220，2021 约 4,270，2022-01…04 约 4,400，按天数加权，**未核实**），**1 bp 标的 ≈ 0.38 点 ≈ 每 1 组 38 美元**。
- **方向约定（重要）**：Vilkov 的表里每一行都是 `code/build_data.py` 定义的那一边：strangle = 买 P + 买 C（**买方**）；iron_condor = 买翅、卖身（**卖方**）；bull call = 买低 C、卖高 C；bear put = 买高 P、卖低 P。下文凡写「卖跨式」「卖信用价差」的数字，都是我把原表取了反号。

### 0.1 版本对照（工作论文 vs 发表版）

| 文献 | 读到的版本 | 其他版本 | 状态 |
|---|---|---|---|
| Vilkov, "0DTE Trading Rules" | 2026-03 版（GitHub 复现包里的论文 Markdown）+ 2026-08 修正后的 `.tex` 表 | SSRN 4641356 初版 2023-11（标题无副标题）；2026 版标题加 "Tail Risk, Implementation, and Tactical Timing" | WP，未发表 |
| Almeida, Freire & Hizmeri (AFH), "0DTE Asset Pricing" | 2025-05-23 稿（FMA Derivatives 2025 会议 PDF，含网络附录） | SSRN 4701401，初稿 2024-01-20 | WP |
| Chong & Todorov, "Do Equity and Options Markets Agree about Volatility?" | 2024-12 SMU 讲座稿 PDF | SSRN 4933153；*Journal of Finance* 2026-07-23 在线（DOI 10.1111/jofi.70070），**发表版未读**（付费墙）。HKUST 新闻稿标题 "Are 0DTE Options Mispriced?" 是同一篇 | 发表 |
| Beckmeyer, Branger & Gayda (BBG), "Retail Traders Love 0DTE Options… But Should They?" | 2023-12-15 版（Lancaster FoFI 2024 会议 PDF） | SSRN 4404704 初版 2023-03-30（媒体报的 18.4 万 / 35.8 万美元/日是初版数字，二手） | WP |
| Bandi, Fusari & Renò (BFR), "0DTE Option Pricing" | **未读**（只在 SSRN） | SSRN 4503344（2023-07）；Renò 主页列为 *Journal of Finance* forthcoming（已核实主页） | 待发表 |
| Adams, Dim, Eraker, Fontaine, Ornthanalai & Vilkov, "Do S&P 500 Options Increase Market Volatility? Evidence from 0DTEs" | 2026-07-15 稿（Fontaine 主页 PDF） | 合并了 Dim–Eraker–Vilkov "0DTEs: Trading, Gamma Risk and Volatility Propagation"（SSRN 4692190，2024）与 Adams–Fontaine–Ornthanalai 的稿子（论文脚注原话） | WP |
| Muravyev & Ni, "Why Do Option Returns Change Sign from Day to Night?" | 只读网络附录（作者主页）；正文未读 | SSRN 2820264（2016）→ *JFE* 136(1):219–238, 2020 | 发表 |
| Brogaard, Han & Won, SSRN 4426358 | **未读**，只看到元数据：题目两种写法（Crossref "Does 0DTE Options Trading Increase Volatility?"；Semantic Scholar "How Does Zero-Day-To-Expiry Options Trading Affect the Volatility of Underlying Assets?"） | — | WP。主题是对标的波动的影响，**不是期权收益** |
| Perz, "Profitability of selected 0DTE index options strategies" | 只读摘要（OpenAlex） | IBIMA 会议论文集 2024（DOI 10.5171/2024.4452224）；SSRN 7162898 | 会议论文 |

## 1. 共用问题（先读）

### 1.1 市场结构：2022 年的到期日扩张（对应 brief 第 5 项）

- **SPXW 到期日的引入日期**（AFH 2025 稿 §3.1 p.17，逐日给出）：周五 2005-10-28；周三 2016-02-23；周一 2016-08-15；周二 2022-04-18；周四 2022-05-11。
- **Cboe 原始公告**（2022-04-13 新闻稿，已读）原话："Tuesday expirations beginning Monday, April 18, and Thursday expirations beginning Wednesday, May 11"。这是**挂牌开始日**，公告没有写第一个到期日。
- **各文对「每日到期」起点的取法不同**：
  - AFH 用 2022-05-11 切分前后样本。
  - Vilkov 的前期截到 2022-04-14，后期从 2022-05-11 起，**剔除 04-18…05-10 作过渡期**（Table structbreak 注）。
  - BBG 用 2022-05-16（第一个完整的每日到期周）。
- **对本研究 A-hist 的含义（我算）**：A-hist 窗口止于 2022-04-29，已含约两周的周二 0DTE（PROTOCOL 记的周二 16 天、周四 10 天，大部分是月末/假日顺延，见下条）。
- **MWF 时代的「例外」周二、周四**：Adams 等 2026 稿 §2.2 p.7：2016 → 2022-04 之间，月末、季末到期或周一/三/五逢假日顺延时，周二、周四也会有 0DTE；"During the 2021 calendar year … there were eleven days when 0DTE contracts traded on a Tuesday or a Thursday, and four of these cases occurred when end-of-month SPX options expired"（脚注 7）。
- **0DTE 占 SPX 期权成交量的比例**（按年）：
  - 2012 约 2%（AFH p.17，正文文字）。
  - 2015 不到五分之一（Adams 等 p.8，正文文字，OPRA 口径）。
  - 2016 约 5%（Cboe 的 Robert Hocking，Benzinga 2024-09 转述，二手）。
  - **2020、2021：没找到表格数字**（AFH Fig.1 与 Adams Fig.1 有，但仅图）。
  - 2022 年初约 20%（Cboe 2023-01 报告，Benzinga 转述，二手）。
  - 2023 Q1 约 43%，2023 年底约 45%（Cboe 高管，二手）。
  - 2024 约 47%（Hocking，二手）；Adams 等 p.8："nearly half … in 2024"。
  - 2025-02 56%、2025-05 61%（Cboe Mandy Xu 2025-06-02 博文，已读，同文：零售占 0DTE 成交 54%）、2025-07 66.2%（二手）。
- **结论（我算）**：A-hist 那段 0DTE 份额大约只有 2024 年后的三分之一到一半，做市商存量 gamma、零售流向都不同（见 §M5）。

### 1.2 各研究的样本是否覆盖 2020-01 → 2022-04（MWF 时代），以及前后是否不同

| 研究 | 样本 | 覆盖 MWF 时代？ | 2022 前后差异 |
|---|---|---|---|
| Vilkov 2026 | 2016-09 → 2026-01（`.tex` 修正表实为截至 2024-05-01 的面板，见 M1） | 是；子期表 2016–19、**2020–21**、2022–23 | 结构突变检验各策略 Δ 均不显著（p 0.22–0.96）；但卖跨式的符号按子期翻转 |
| AFH 2025 | 2012-01-06 → 2025-03-18，1,815 天，约 40% 在 2022-05-11 之后 | 是 | VRP 两段都显著为正，前期更大（主要是下行部分）；错价策略 2022 后停滞 |
| Chong & Todorov | 2020–2023（剔除 FOMC 与半天） | 是（原文点明 2022 春前只有 MWF） | 未分段报告 |
| BBG 2023 | 2021-02 → 2023-09（零售识别码 2021-02 起才有） | 部分（2021-02 → 2022-05） | 零售日均亏损：全样本 24.1 万美元，2022-05-16 后 35.0 万 |
| Adams 等 2026 | 2018-01 → 2024-12 | 是：识别**依赖** MWF 时代 | 每日到期后，星期间的波动差异消失 |
| BFR 2023 | 2014-01-02 → 2023-05-11（JHU Carey 新闻稿，二手） | 是 | 未读 |
| Muravyev & Ni 2020 | 2004 → 2013 | 否，且不是 0DTE | — |
| Perz 2024 | 「过去 12 个月」（约 2023–24，摘要原话） | 否 | — |

### 1.3 成本是怎么扣的（各文口径不同，比较前先对齐）

- **Vilkov**：入场按每条腿付观测到的半点差，再加 0.5 bp 标的的滑点/费用；持有到 16:00 结算，无出场成本。
  - **2026-08 勘误**（复现包 `KNOWN-ISSUES.md`，已读）：原稿把占标的分数的半点差当成百分数去减，**半点差只扣了 1/100**（0.022 bp 而不是 2.2 bp）。这个错由 gex.live 团队独立复现原表到四位小数后发现。
  - 修正后："No structure retains a materially positive net Sharpe ratio"。例如卖铁蝶/铁鹰 net SR −2.67（原报 −0.96）；条件化后最好的 put ratio net SR 从 +0.93 变成 −0.75；前三篮子从 +0.82 变成 −0.82。
  - **论文 PDF 与 `paper-digest.md`、`results-summary.md` 里的 net 数字都是错的**（作者自己说 "Paper revision in progress"）。本档案只引修正后的 `.tex` 表。
  - 修正后的平均成本（我算，取 `0dte_implementable_pnl.tex` 的 Mid 与 B/A 两列之差）：跨式/宽跨 1.06 bp，铁蝶/铁鹰 2.51 bp，bull call 3.17 bp，bear put 2.97 bp，均为占标的、每笔、按格点平均。
- **AFH**：买按 ask、卖按 bid（全点差，"worst case"），只在入场付；对冲腿成本原文未提（Table 6 注）。
- **Chong & Todorov**：Table 3 没有写明扣了成本。正文 p.18 说期权部分的相对成本「约 4–6%」（相对于 T·σ² 的口径）；对冲股票部分见其 Fig.5。
- **BBG**：毛利润按交易时的中间价；净利润按实际成交价（即付了有效点差）。零售有效点差：看涨 6.0%、看跌 5.0%（占中间价），非零售 12.5% / 9.6%（Table 1）。
- **本研究的口径**（PROTOCOL A-hist 节）：`mid ± k × 半点差`，k 0.5 为主。申报过的 14:00 ATM 跨式半点差中位：2020 年 0.35 点（中间价的 3.0%）、2021 年 0.25（2.3%）、2022-01…04 0.30（1.5%）。
  - 所以卖 1 组 ATM 跨式在 k 0.5 下约付 0.13–0.18 点 = **13–18 美元**，或权利金的 0.75–1.5%（我算）。
  - 铁蝶多两条翅腿，成本更高，另加佣金（`config.yaml` 未读）。

## 2. 逐条机制

### M1. 0DTE 卖波动 / 方差风险溢价（持有到结算）

**M1-1 机制（E1）：谁在付钱**
- AFH 摘要："investors mainly require compensation for positive market returns … reflected in a high variance risk premium, which is largely driven by compensation for upside risk"。
  - 0DTE 年化 VRP 1.54–2.95（百分点，方差单位），大于 1DTE 的 0.55 和 22DTE 的 0.81（AFH p.28）。
- BBG：零售是 0DTE 的净买方，做市商净空（p.3–4）。零售的借方单（买期权）日均净亏 36.4 万美元，贷方单（卖期权）日均净赚 12.2 万（全样本，Table 2 Panel A，单位为 10 万美元）。
  - 2022-05-16 之后：借方 −80.5 万/日，贷方 +45.5 万/日（Panel B）。毛利润（中间价）口径：贷方 +21.3 万（全样本）、+57.3 万（之后）。
  - 也就是说，钱从零售买方经由点差和 VRP 流向卖方与做市商。
- 为什么没被套利掉：尾部。Vilkov 修正表里所有结构的 ES₁% 为标的的 0.77–1.64%，是日均 PnL 的几十到上百倍（`0dte_tail_risk_diagnostics.tex`）。Chong & Todorov 的不对冲卖波动偏度 −8 到 −12，峰度 100–205（Table 3）。

**M1-2 原始证据与独立确认（E2）**
- **Vilkov**（2026 版，SPXW，Cboe 30 分钟 NBBO 快照，10:00 入场，中间价，`0dte_stratret2000_2100_main.tex`，N≈1,318 天，全样本）。卖方口径为我取反号；1 bp ≈ 38 美元/组：
  - 卖 ATM 跨式：+0.11 bp（SR 0.03）。
  - 卖宽跨 0.995/1.005：+0.09 bp；0.99/1.01：+0.67 bp（SR 0.28；t ≈ 0.6，我算 = SR·√(N/252)）。
  - 卖铁蝶 0.995/1/1.005：+0.02 bp（SR 0.02）；0.99/1/1.01：−0.56 bp。
  - 卖铁鹰 0.995/0.997/1.003/1.005：−0.06 bp；0.99/0.995/1.005/1.01：−0.58 bp。
  - **买蝶 = 卖铁蝶**（同一个到期盈亏：买 K−w、卖 2K、买 K+w 的蝶，与卖 K 跨式、买 K±w 翅的铁蝶，按平价差的只是现金，我算）。所以铁蝶行**原样**就是买蝶的数字：全样本 0.995/1/1.005 +0.02 bp ≈ 0。
  - VRP 本身：10:00 到收盘的已实现 VRP 中位数 "approximately 0.0011% of underlying"（§3.1 正文）。原话："These magnitudes are difficult to monetize after realistic trading frictions"。
- **子期**（同口径，卖方，bp 标的；括号为 SR，跨式/宽跨行是原表取反，**铁蝶/铁鹰行不取反**，原表本来就是卖方）：

  | 结构 | 2016–19（n 326） | **2020–21（n 227）** | 2022–23（n 344） |
  |---|---|---|---|
  | 卖 ATM 跨式 | −0.55（−0.20） | **+3.05（+0.78）** | −2.63（−0.71） |
  | 卖宽跨 0.995/1.005 | −1.92 | **+4.50（+1.30）** | −2.12 |
  | 卖宽跨 0.99/1.01 | −1.63 | **+5.87（+2.05；t ≈ 1.9 我算）** | −0.08 |
  | 卖铁蝶 0.995/1/1.005（= 买蝶） | +1.38（+1.37） | **−1.45（−1.43；t ≈ −1.4 我算）** | −0.51 |
  | 卖铁鹰 0.99/0.995/1.005/1.01 | −0.29 | **−1.37（−1.11）** | −2.03 |

  - 读法（我算）：2020–21 卖裸跨赚，但买了翅的结构（铁蝶、铁鹰）亏，说明这段的溢价集中在 0.5–1% OTM 的翅上，买保护比卖身亏得多；2016–19 正好相反。
  - 2020–21 那 227 天少于该段 MWF 加月末的天数，缺口原因未核实（面板只收有 Cboe 30 分钟数据的日子）；新冠段在内。
  - 修正后的可实施表（N 953，按策略内全部格点平均）：卖宽跨 Mid +0.59 bp，扣半点差后约 −0.47 bp（我算 = +0.59 − 1.06），再扣 0.5 bp 后 −0.97 bp；卖铁蝶/铁鹰 Mid −0.73、B/A −3.24、加费 −3.74 bp。
- **AFH**（2012–2025，1 分钟 Cboe 报价，中间价）：
  - 0DTE 的 delta 对冲 ATM call、跨式、delta 中性跨式，平均收益在 10:00–14:00 每个入场点都为负，"statistical significance … stronger from 12:00 to 14:00"（p.27）。具体数字**仅图**（Fig.6），并且收益序列在右尾 1% 处缩尾（Fig.6 注）。**右尾缩尾会让买方收益偏低，也就是把卖方溢价做大。**
  - VRP（年化百分点，Table 1）：10:00 1.80，12:00 1.81，13:00 1.98，14:00 2.96；p 值都是 0.000。
- **Chong & Todorov**（2020–2023，入场在收盘前 30/60/90/120 分钟，即 15:30…14:00，年化 SR，Table 3）：
  - 「卖波动」（静态卖 OTM 期权组合，每 5 秒用 SPY 对冲）SR 2.56 / 4.73 / 4.15 / 3.61。这依赖 5 秒级对冲，不是本研究能做的结构。
  - 「不对冲卖波动」SR 0.67 / 0.84 / 0.39 / **−0.10**（HAC 标准误约 2.0–2.3，全部不显著）。
  - 他们的主结论（2024 稿摘要）："in spite of the nontrivial risk premium embedded in zero-date options, their prices correctly reflect the time-varying volatility"。
  - 发表版摘要（OpenAlex 抄录）："transaction costs, estimation risk, and short-term volatility risk prevent investors from taking advantage"。
- **BFR**：未读全文。据 JHU 新闻稿（二手）：样本 2014-01-02 → 2023-05-11，估计了 0DTE 的收益与方差风险溢价，有"nearly instantaneous predictability (through leverage and the volatility-of-volatility)"。数字未核实。
- **Perz 2024**（只读摘要）：SPX 0DTE 铁鹰两个变体，用「过去 12 个月」1 分钟数据，"Both variants of the strategy proved profitable"。成本口径和数字未核实。会议论文集，权重低。
- **「发表后独立复现」怎么算（我判断）**：
  - 0DTE 文献全部是 2023–2026 年的同期工作论文，没有一篇在发表之后被别人用新样本复现过。McLean–Pontiff 意义上的发表后复现：**没找到**。
  - 但「毛 VRP > 0」被至少四组作者在不同数据上各自得到（Vilkov、AFH、Chong–Todorov、BFR）。
  - 唯一真正的独立复核是 gex.live 对 Vilkov 代码的复现（2026-08），结果是**扣成本后的结论被推翻**，方向对卖方不利。

**M1-3 按入场时点**
- **AFH Table 6**（卖 delta 对冲 ATM 0DTE call 的 SR，原文未注明是否年化，照抄；数量级像每笔 SR）：

  | 入场 | 10:00 | 11:00 | 12:00 | 12:30 | 13:00 | 13:30 | 14:00 |
  |---|---|---|---|---|---|---|---|
  | 扣成本前 | 0.002 | −0.015 | 0.003 | 0.015 | 0.017 | 0.016 | 0.010 |
  | 扣 bid/ask 后 | −0.037 | −0.039 | −0.023 | −0.011 | −0.010 | −0.012 | **−0.033** |

  - 原文："the benchmark produces mostly negative Sharpe ratios net of costs"（p.34）。这是全样本 2012–2025，没有 2022 前后分开的版本。
- **Vilkov**：13:00、15:00、前一日 16:00 入场**仅图**（附录 Fig.），原文说 "broadly similar across entry times"。
- **Chong & Todorov**：越接近收盘，不对冲卖波动的 SR 越低（0.67 → −0.10）。14:00 那一档 SR −0.10。
- **BBG Table 2 Panel E**：零售 0DTE 按小时的净盈亏，各小时都是负的；这是零售的总盈亏，不是某个策略。
- **「开盘 vs 午盘 vs 最后两小时」的直接对比表：没找到。**

**M1-4 注意**
- Vilkov 表里的 N 不一致：Table 1 是 1,318 天，可实施表是 953 天，子期加起来 952。修正表用的是 2024-05-01 截止的面板，2024–26 子期只有 55 天。原因未核实。
- AFH 的毛溢价对缩尾敏感（见上）。

### M2. 反向或冲突证据

- **Muravyev & Ni（JFE 2020）**：SPX delta 对冲期权平均每天 −0.7%，其中隔夜 −1%，日内 +0.3%（摘要，见主档案 §D2）。
  - 网络附录（已读）：
    - 跨式口径日内 +0.18%（t 2.5）、隔夜 −0.85%（t −17.7）（Table A.7）。
    - 剔除金融危机后，日内收益 t = 1.7，不显著。
    - SPX 有效点差约 6%，"Hardly any option trading strategy is profitable after accounting for these spreads"（A 节）。
    - 样本 2004–2013，期权是较长期限的，**不是 0DTE**。
  - 对 0DTE 的含义（我判断）：
    - M–N 的机制是：期权价格没有反映「日内波动远高于隔夜」，于是持有期权过日内的多方赚钱。
    - 照此推，开盘卖、持有到收盘，正站在不利的那一边。
    - 但 0DTE 在开盘后入场，剩余寿命全在日内，定价者直接面对日内波动。AFH 与 Vilkov 都测到日内 VRP 仍为正，Chong–Todorov 也认为 0DTE 价格正确反映了日内波动。所以 M–N 的方向**不能直接搬到** 0DTE；它真正告诫的是：**前一日收盘买入的 1DTE、隔夜持有**那一段才是卖方的钱。Vilkov 的「前一日 16:00 入场」只有图。
- **2022 以后溢价变小或消失**：
  - AFH OA.3：10:00 VRP 从 1.910（2022-05-11 前）降到 1.639（之后）；14:00 从 3.347 降到 2.361。
  - 下行部分 VRP− 降得多：10:00 从 1.053 到 0.524；14:00 从 1.377 到 0.389，p 0.075。
  - 原文："Such mispricing is highly profitable before 2022, but dissipates after the daily availability of 0DTEs"（摘要，说的是 SSD 错价策略，不是无条件卖方）。
  - Vilkov 结构突变表（卖方取反号，bp）：卖跨式/宽跨 前 +0.85 → 后 +0.97；卖铁蝶/铁鹰 前 −0.94 → 后 −0.10；Δ 的 p 值都 > 0.2。
- **扣成本后为零或为负**：
  - Vilkov 修正表（见 M1-2）。
  - AFH Table 6 扣 bid/ask 后，每个入场点都为负。
  - Chong–Todorov 发表版摘要：成本与估计风险使伪套利不可行。
  - BBG：零售总亏损里约 60% 来自交易成本（p.4）。

### M3. 短期信用价差：卖 OTM call 垂直 vs put 垂直

- **AFH**（Fig.4–5，**仅图**）："average OTM call returns are more negative than OTM put returns, suggesting more compensation for upside than downside risk"；"writing naked OTM calls is usually profitable in the 0DTE option market"（p.26）。
  - 有表的证据：Table 1 每个入场时点 VRP+ > VRP−（例如 10:00 0.957 vs 0.847；14:00 1.971 vs 0.985）。
  - 2022 前后（OA.3）：VRP+ 两段相近（10:00 0.857 → 1.114），VRP− 减半，说明 2022 后上行溢价占比更高。
- **Vilkov 子期表**（10:00 入场，中间价，卖方，bp 标的）。其中 OTM 那两行是我用两行之差算的（例：卖 1.01C 买 1.02C = bull(1/1.01) − bull(1/1.02)），只有均值，没有标准误：

  | 卖出的垂直价差 | 2016–19 | 2020–21 | 2022–23 |
  |---|---|---|---|
  | call：卖 1.000C 买 1.005C | **+2.06**（SR 1.79） | −0.77 | 0.00 |
  | call：卖 1.01C 买 1.02C（我算） | −0.52 | −0.24 | −0.14 |
  | put：卖 1.000P 买 0.995P | −0.66 | −0.68 | −0.51 |
  | put：卖 0.99P 买 0.98P（我算） | −0.93 | **+0.85** | −0.44 |

  - 每组的成本约 3 bp（修正可实施表，按格点平均），比上表所有毛数字都大。
  - 方向在子期之间不稳定；put 侧卖 ATM 垂直在三段都为负。
  - 全样本风险逆转（买 OTM call、卖 OTM put）是唯一均值、中位数、25 分位都为正的结构，约 +1.0–1.5 bp（Table 1），但 Vilkov 认为这部分反映 2017–2023 的指数上行漂移。
- **BBG 零售**（Table 4，按保证金调整的收益，%）：put spread 中位 +3.0、均值 +0.1；call spread 中位 +3.3、均值 −0.2；方向（买或卖）未分开。只能算弱证据。
- **专门研究「日内卖 OTM 信用价差持有到结算」的文献：没找到。**

### M4. 条件化：高 VIX、大跌之后、IV/RV

- **Vilkov Table 6**（按 10:00 隐含方差三分位，修正面板，中间价，卖方取反号，bp）：
  - 卖铁蝶/铁鹰：低 +0.27，中 −0.24，**高 −2.05**（高减低 p 0.16）。
  - 卖跨式/宽跨：低 +0.18，中 −0.01，**高 +1.60**（p 0.66），方向相反。
  - 只有 put ratio spread 显著（按原定义：买 1 ATM put、卖 2 OTM put；高减低 +7.77 bp，t 2.50）。
  - 原文："downside structures earn more in high-VIX"。
- **AFH Table 7**（SSD 错价策略，扣成本后 SR）：低 RV 天 0.40–0.47，高 RV 天 0.00–0.08；低 0DTE 成交量、低关注度的日子更高。这是错价策略，不是无条件卖方。
- **BBG**："retail trades are particularly poor in high-IV contracts and in high-IV times"（p.4）；2022-05 后这一关系消失（p.5）。
- **Adams 等 2026**（2018–2024，用 MWF 时代周二、周四是否有 0DTE 做识别）：有 0DTE 到期的日子，10 分钟已实现波动低 61 个年化 bp，约为均值 9.10% 的 7%（p.1–2）。
  - 机制是做市商从更早的长期限仓位继承了多 gamma，对冲需求平均上升 25 bp（p.2）。
  - 对 A-hist 的含义（我判断）：MWF 时代，**到期日本身的日内实现波动就偏低**，这对到期日卖方有利。
- **「大跌日之后」1 日期限卖波动更差的 0DTE 证据：没找到。**
- **日内 IV / RV 比值的表：没找到**。Vilkov Fig.1（按 30 分钟段的 VRP）与 Chong–Todorov Fig.6（Q 与 P 的截断波动）都只有图。

### M5. 谁在交易（结构性背景，用于 E1）

- BBG：零售在 SPX 期权里超过 75% 是 0DTE（摘要）。用 SLAN/MLAT 码能识别的零售（≤10 张的价格改善单）占 0DTE 成交：2021 约 4%，2022 超过 6%（p.11）。这和 Cboe 说的「零售占 54%」口径不同，不能直接比。
- 单腿占零售 0DTE 交易：2021 不到 20% → 2023 超过 60%（p.11）。
- 单笔中位数：卖 0DTE 铁鹰 +135 美元，均值 −15.6 美元（Table 3），均值被少数大亏拖成负。
- Cboe 2025-05：零售占 SPX 0DTE 成交 54%（Xu 博文）。
- 推断（我判断）：A-hist（2020–2022-04）时零售份额与 0DTE 总份额都远低于 2023 年后，「零售买方付钱」这个 E1 在那段更弱。可是 AFH 测到的毛 VRP 在 2022 前反而更大（OA.3），两者方向不一致。

## 3. 总表

单位：bp = 占标的（1 bp ≈ 38 美元/组，SPX 3,800）；「中间价」= 未扣成本。

| 机制 / 文献 | 毛效应 | 扣成本后 | 覆盖 2020-01…2022-04？ | 发表后复现 |
|---|---|---|---|---|
| 卖 0DTE 跨式/宽跨，10:00（Vilkov） | 全样本 +0.1…+0.7 bp；2020–21 +3.1…+5.9 bp | 格点平均 Mid +0.59 → B/A −0.47 → 加 0.5 bp −0.97 | 是（2020–21 子期） | 同期 WP；代码复核推翻了净结论 |
| 卖铁蝶/铁鹰 = 买蝶/买鹰，10:00（Vilkov） | 全样本 ≈0 或负；2016–19 +1.4；**2020–21 −1.45（买蝶，±0.5% 翅）** | Mid −0.73 → −3.74 bp | 是 | 同上 |
| 卖 delta 对冲 ATM call，10:00–14:00 每半小时（AFH） | SR −0.016…+0.017（原表） | SR −0.042…−0.010（bid/ask） | 是（未分段） | 没找到 |
| 不对冲卖波动，收盘前 30–120 分钟（Chong–Todorov） | 年化 SR 0.67…−0.10，均不显著 | 发表版：不可行 | 是（2020–23） | JF 2026 |
| 0DTE VRP（AFH） | 年化 1.5–3.0 pp，2022 后小约 13–29%（OA.3，我算） | — | 是 | 与 Vilkov、BFR、C–T 方向一致 |
| 日内多 vol 赚、隔夜卖赚（Muravyev–Ni） | 日内 +0.18…+0.3%/日（对冲） | 只有算法交易者付得起 | 否（2004–13，非 0DTE） | JFE 2020 |
| 卖 call 垂直 vs put 垂直（AFH 仅图；Vilkov 我算） | 各段 −0.9…+2.1 bp，符号不稳 | 约 −3 bp | 是 | 没找到 |
| 高波动下卖铁蝶更差（Vilkov T6） | 高三分位 −2.05 vs 低 +0.27 bp（p 0.16） | — | 是 | 没找到 |
| 到期日波动更低（Adams 等） | RV 低约 7% | — | 是（识别靠它） | WP |

## 4. 对打先验的含义（我的判断，不是文献结论）

按 PROTOCOL「补充（2026-11-08）」一的档位表。

1. **E1 有。** 付钱的是 0DTE 的净买方，主要是零售，为上行和下行尾部保险付费；做市商与卖方收钱，承担尾部（BBG、AFH）。没被套利掉的理由是尾部资本占用（ES₁% 是日均的几十倍以上）和点差。
2. **E2：毛溢价有多组独立的同期证据，但没有发表后复现。** 严格按「发表之后的独立复现」读，只能进 **15% 档**。若把四组独立数据都测到毛 VRP > 0 算作复现，可进 30% 档，但唯一的独立复核（gex.live）指向反面。我取 **15% 档为起点**。
3. **E3：R 远小于 2，多数结构 < 1。**
   - 以 Vilkov 10:00 全样本中间价为毛效应：卖宽跨 0.99/1.01 +0.67 bp ≈ 25 美元/组，卖 ATM 跨式 +0.11 bp ≈ 4 美元，卖铁蝶 ≈ 0；买蝶 ≈ 0。
   - 本研究 k 0.5 成本约 13–18 美元/组（ATM 跨式，2020–22 实测半点差，§1.3），铁蝶更高。
   - R（我算）：跨式约 0.25–0.3；铁蝶约 0；宽跨的本研究成本未知（PROTOCOL 只申报了 ATM 跨式半点差），若与 ATM 跨式同为 13–18 美元则 R ≈ 1.4–1.9。用 Vilkov 自己的全半点差口径，宽跨 R ≈ 0.56（0.59 / 1.06）。
   - **按档位表，R < 1 直接 5%。** 只有挑最有利的子期（2020–21 卖裸宽跨 +5.9 bp ≈ 220 美元/组，R ≈ 10 以上），R 才 > 2。但那是事后挑出来的子期，结构还和铁蝶相反，**不能当毛效应用**。
4. **账本**：本档案作者没有查本研究账本里的同机制 FAIL，由评估人补。
5. **综合（我判断）**：
   - 「无条件 0DTE 卖方持有到结算」（跨式、铁蝶、铁鹰、买蝶）先验 **5%**。
   - 「卖 OTM 信用价差」：文献没有直接证据；call 侧比 put 侧好的说法只有 AFH 的图，Vilkov 的子期数字符号不稳，而且都在约 3 bp 的成本之下。先验 **5%**。
   - 「按 VIX 或 RV 条件化」：只有 Vilkov Table 6 一张表，方向因结构而异，只有一个结构显著，并且是买方。先验 **5%**。
   - 例外：若提案的 E1 是「MWF 时代到期日实现波动更低」（Adams 等，因果识别，样本正好覆盖 A-hist），并且结构的成本足够低、R ≥ 2，可以论证到 **15%**。但那需要文献给出的毛效应（以 bp 或美元计），目前没有这个数，只有波动低 7%。
6. **A-hist 适用性**：
   - Vilkov 2020–21 子期、AFH 前期子样本、Chong–Todorov、Adams 等，都覆盖 2020-01 → 2022-04。外部证据**适用于**这段。
   - 但这些证据说的是：该段毛 VRP 更大（AFH OA.3），裸卖在 2020–21 毛赚（Vilkov），而带翅结构亏。
   - **本研究的基准（14:00 入场买蝶）最接近的外部数字是 Vilkov 的铁蝶 0.995/1/1.005 行**（铁蝶 = 买蝶）：2020–21 子期 10:00 入场、中间价、未扣成本，−1.45 bp ≈ −55 美元/组（SR −1.43，t ≈ −1.4），2016–19 +1.38 bp，2022–23 −0.51 bp。也就是说，唯一覆盖 A-hist 年代的外部表显示，这个结构在扣成本前就是亏的（不显著）。
   - 差异要注明：Vilkov 是 10:00 入场、翅宽固定为标的的 0.5%（SPX 3,800 时约 19 点），基准是 14:00 入场、翅宽约 2 倍隐含移动；14:00 的数字 Vilkov 只有图。
   - 其余 14:00 的证据：AFH 卖 delta 对冲 call，扣成本后 SR −0.033；C–T 14:00 不对冲卖波动 SR −0.10。

## 5. 主要来源

- Vilkov 复现包（论文 Markdown、修正后的 `.tex` 表、KNOWN-ISSUES、代码）：https://github.com/vilkovgr/0dte-strategies ；SSRN：https://ssrn.com/abstract=4641356 （未能打开）
- Almeida, Freire & Hizmeri 2025-05 稿：https://fmai.memberclicks.net/assets/docs/Derivatives2025/Almeida.pdf
- Chong & Todorov 2024-12 讲座稿：https://economics.smu.edu.sg/sites/economics.smu.edu.sg/files/economics/pdf/Seminar/2024/20241212.pdf ；JF 2026：https://onlinelibrary.wiley.com/doi/10.1111/jofi.70070 （未读）；HKUST 新闻稿：https://bm.hkust.edu.hk/bizinsight/2026/04/are-0dte-options-mispriced
- Beckmeyer, Branger & Gayda 2023-12 版：https://wp.lancs.ac.uk/fofi2024/files/2024/04/FoFI-2024-146-Leander-Gayda.pdf
- Adams, Dim, Eraker, Fontaine, Ornthanalai & Vilkov 2026-07：https://www.jean-sebastienfontaine.com/papers/0dte-options-volatility.pdf
- Bandi, Fusari & Renò：https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4503344 （未读）；JF forthcoming 见 https://roberto-reno.faculty.essec.edu/research
- Muravyev & Ni 网络附录：https://www.dmurav.com/MuravyevNi_WhyDoOptionReturnsChangeSign_IA.pdf ；JFE 2020：https://ideas.repec.org/a/eee/jfinec/v136y2020i1p219-238.html
- Brogaard, Han & Won：https://doi.org/10.2139/ssrn.4426358 （未读）
- Perz 2024：https://doi.org/10.5171/2024.4452224 （只读摘要）
- Cboe 2022-04-13 新闻稿：https://ir.cboe.com/news/news-details/2022/Cboe-to-Add-Tuesday-and-Thursday-Expirations-for-SPX-Weeklys-Options-04-13-2022/default.aspx
- Cboe Mandy Xu 2025-06-02：https://www.cboe.com/insights/posts/spx-0-dte-options-jump-to-61-share-on-retail-resurgence
- 0DTE 份额（二手）：https://benzinga.com/news/events/24/09/41074042/zero-dte-options-fuel-record-spx-trading-volumes-with-no-signs-of-slowing-down-expert ；https://feeds2.benzinga.com/markets/options/23/01/30566601/cboe-report-reveals-index-options-volume-has-grown-despite-a-bearish-2022-market
- 找到但未读、与收益无直接关系或无法获取的：O'Donovan 2026 "0DTE Options and the Price of Tail Protection"（SSRN 6836498）；Dorion, Orłowski & Song 2026 "The Factor Structure of 0DTE Option Returns"（SSRN 7149778）；Božović 2025（SSRN 5223127）；Bandi, Fusari, Gazzani & Renò 2026（arXiv 2603.29430，定价模型，无收益结果）。
