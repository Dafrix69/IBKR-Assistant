# 因子挖掘共用说明（给并行 agent）

目标：为 SPX 0DTE ATM 蝶找出**样本外站得住**的胜率 / 期望因子。前面已经筛过约 50 个因子（见 `reports/winrate_study.md`，只当背景，不要被它的结论框住），存活的只有"翅宽按隐含定、13:00–14:00 入场、跳过前一日大跌的下午"。你的任务是在分给你的因子族里系统挖掘，用下面统一的纪律验证，把结果写成一份可复现的报告。

## 环境
- 研究目录 `R = /Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly`，Python 用 `R/.venv/bin/python`（pandas 3、numpy、scipy、pyarrow、matplotlib、yaml 已装；没有 sklearn / statsmodels，需要就 `R/.venv/bin/pip install` 到 venv）。
- 只读：`R/data/raw/**`（ThetaData 原始 gz）、`R/data/clean/*.parquet`（已清洗）、`R/data/tws/**`。不要启动 Theta Terminal，不要连 TWS，数据全在本地。
- 你的产出放 `R/src/mining/<族名>.py`（可复现脚本）和 `R/reports/mining/<族名>.md`（报告）+ `R/reports/mining/<族名>_tables/*.csv`。不要改现有文件，不要 git 操作。
- 中等体量任务（读 1127 个 chain parquet）用 `concurrent.futures.ProcessPoolExecutor(6)`，几分钟能跑完。读 501 个 trade_quote gz 更慢（每个 8–25 MB），只读需要的列。

## 数据字典（`R/data/clean/`）
- `calendar.parquet`：index = 交易日（1129 天，2022-05-02 → 2026-10-29）。列：`settle`（官方收盘价 = SPXW 结算价）、`half_day`、`session_end`、`has_0dte`、`fomc/cpi/nfp/pce/opex/triple_witching`、`vix_prev_close`、`spx_ret_prev`。
- `spot.parquet`：`ts`（分钟，naive 美东）、`spot`（t 分钟时已知的 SPX 价 = t−1 那根 TWS K 线收盘；09:30 用开盘价）、`parity_F`（平价反推，只作校验）。
- `chain_{YYYYMMDD}.parquet`（1127 个，仅当天到期 SPXW）：`strike, right('C'/'P'), ts, bid_size, bid, ask_size, ask, mid, spread, flag_*`，`flag_bad` 为真的行不要用。09:30–15:59（半天到 12:59）。**16:00 快照没有**（不可用）。
- `winrate_panel.parquet`：目标变量面板。每行 = 一天 × 入场 × 翅宽 × 结构 的 ATM 蝶持到结算。列：`date, entry('09:35','10:30','12:00','13:00','14:00','14:30','15:00','15:30'), width(20/25/30/50/75), structure('put_fly'/'iron_fly'), K(ATM 行权价), spot, implied(ATM 跨式中间价), w_over_implied, cost(点), payoff, pnl(k=0.25 美元, 含费), pnl_k0, pnl_k05, win(pnl>0)`。**主目标：`structure=='put_fly'`, `width in (25,30)`, `entry in ('13:00','14:00')` 的 `win` 与 `pnl`。**
- `edge_panel.parquet`：四个入场时点的 ATM 跨式、realized、ratio、`iv_ann`、fly25/50/75 mid 与 pay。
- `gex_daily.parquet`：index 日期 D（用的是 D−1 收盘 OI 与报价，开盘前已知）：`gex_total, zero_gamma, call_wall, put_wall, oi_total, oi_0dte, gex_0dte, iv_atm_med`。
- `factor_panel.parquet`、`wall_panel_spx/qqq/spy.parquet`、`offcenter_panel.parquet`、`wall_touch*_panel.parquet`、`round_touch_panel.parquet`、`fly_trades.parquet`（Step 3 的 37 万笔蝶，含止盈止损规则）、`spread_panel.parquet`、`weekly_*.parquet`：前面各研究的面板，列名自解释，可复用。
- `R/data/tws/spx_1m|qqq_1m|spy_1m/*.parquet`：`ts`(tz-aware 美东, K 线开始时间) `open high low close`；`vix_1d.parquet`：`date, vix_close`。

## 原始数据（`R/data/raw/`，gz CSV）
- `SPXW/trade_quote_dte0/YYYY/YYYYMMDD.csv.gz`（2024-10-30 起，501 天）：每笔 0DTE 成交 + 成交前 NBBO。列：`symbol, expiration, strike, right('CALL'/'PUT'), trade_timestamp, quote_timestamp, sequence, ext_condition1-4, condition, size, exchange, price, bid_size, bid_exchange, bid, bid_condition, ask_size, ask_exchange, ask, ask_condition`。**条件码 130/131/134/137/144 是组合单的腿，判断主动方向时剔除**；价 ≥ ask 记买、≤ bid 记卖。
- `SPXW|SPX|QQQ|SPY/oi/YYYY/YYYYMMDD.csv.gz`：`expiration, strike, right, timestamp, open_interest`。**D 日文件 = D−1 收盘的 OI**，含所有到期日。
- `SPXW|SPX/greeks_eod/YYYY/YYYYMMDD.csv.gz`：D 日 17:15 的日终报告，所有到期日：`expiration, strike, right, open/high/low/close, volume, count, bid/ask(收盘 NBBO), delta…gamma…implied_vol(用最后成交价算，别直接用), underlying_price(官方收盘)`。
- `SPXW/quote_1m_dte0`：chain parquet 的来源，不必再读。

## 验证纪律（必须照做）
1. **时间切分**：训练期 `date < 2024-11-01`，测试期 `>= 2024-11-01`。所有分位切点、阈值、模型参数只能来自训练期。
2. **因子必须在入场那一分钟已知**。OI 是前收，成交流只能用入场时刻之前的，日线特征用前一日。
3. **单变量筛**：训练期五分位 → 测试期用同样切点；报告 Q1、Q5 胜率、gap、Spearman。"成立" = 两期同号且 |gap| ≥ 5 个百分点。
4. **控制隐含波动**：按 `w_over_implied` 训练期三分位分组，看因子在每组内是否仍有效。很多因子只是"今天波动低"的影子，这一步会把它们筛掉。
5. **增量检验**：基准规则 = 14:00 入场、每天在 20/25/30/50/75 里选 `w_over_implied` 最接近 2 的翅宽（每天一笔）、跳过 `spx_ret_prev <= -1%` 的日子。在基准上叠加你的因子（用训练期阈值），报告训练期和测试期各自的 n、胜率、Wilson 95% 区间、期望（pnl 均值）。**两期增量同号且测试期 ≥ +3 个百分点才算有价值。**
6. **分年稳定性**：2022–2026 逐年给出因子高低组的胜率。
7. **多重比较**：报告你一共试了多少个因子 / 阈值 / 变体，显著结果里预期有多少是运气（5% 水平下约试验数 × 0.05）。
8. 胜率 = `pnl > 0`（k = 0.25，含费）。同时报告期望，别只报胜率：胜率可以靠变宽变晚无限抬高，期望会告诉你代价。

可直接复用的统计函数：`R/src/winrate_study.py` 里 `stats(g)`（n、win、Wilson 区间、ev、ev_k05、payoff）、`wilson(k,n)`；`R/src/fly_grid.py` 的 `regime_labels()`。导入方式 `sys.path.insert(0, R+'/src')`。

## 报告格式（`reports/mining/<族名>.md`）
1. 一句话结论（找到了什么 / 没找到）。
2. 试过的因子清单（名字、定义、为什么有道理）。
3. 单变量筛查表（全部，不只是成立的）。
4. 成立者的控制隐含、增量检验、分年表。
5. 多重比较账。
6. 可复现命令。
数字全部来自脚本输出，不要手改。写中文。不要给交易建议，只给证据。

## 坑
- 半天交易日（`calendar.half_day`）剔除。
- `chain` 里 bid=0 的深虚值行很多，是正常的，不是坏数据。
- 行权价间距 5 点，ATM 距现货最多 2.5 点。
- 入场时刻的"现货"用 `spot.parquet`，别用 chain 自己反推。
- 每个因子的样本量：训练期约 620 天、测试期约 500 天（13:00 和 14:00 各一笔时 ×2，但两笔高度相关，区间按天算更诚实）。

## 补充（2026-11-01）：VIX 期限结构日线

`data/tws/vix_term_1d.parquet`：`date`、`vix1d_close`（2023-04-26 起，CBOE 当日才推出）、`vix9d_close`、`vix3m_close`（2021-11-01 起），TWS 日线收盘，由 `src/fetch_vix_term_tws.py` 拉取。配合 `vix_1d.parquet`（VIX）可做 VIX1D/VIX、VIX9D/VIX、VIX/VIX3M 等比值。注意 VIX1D 训练期只有 2023-04 → 2024-10（约 380 天），用它做信号要在提案里写明样本。日期 D 的收盘只能用于 D+1 的信号。
