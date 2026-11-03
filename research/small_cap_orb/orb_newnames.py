"""Post hoc, not pre-registered: the four-name ORB pick (grid.csv top row) replayed on the 11 new
names, pooled by day, with the same block-bootstrap CI as the other tests. Reads data/ only."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pandas as pd, backtest as B
grid = pd.read_csv(os.path.join(B.ROOT, "grid.csv")); top = grid.iloc[0]
cfg = (int(top.n), float(top.f), top.side, float(top.vol))
names = "CRDO NBIS QUBT NVTS APLD CLSK SNDK WOLF ALAB QBTS RKLB".split()
P = B.Panel(names)
per = {}
for s, df in P.stocks.items():
    tr = B.run(df, cfg)
    r = B.stock_returns(tr, P.spreads[s])
    per[s] = B.daily(tr.date, r, P.dates) if len(tr) else pd.Series(0.0, index=P.dates)
    oo = tr.date.isin(P.oos_d)
    print(f"  {s}: {len(tr)} trades ({int(oo.sum())} OOS) per-trade net {r.mean()*1e4:.0f} bps  OOS per-trade {r[oo].mean()*1e4:.0f}  win {(r>0).mean():.0%}")
p = P.pool(per); o = p.reindex(P.oos_d).dropna(); i = p.reindex(P.is_d).dropna()
lo, hi = B.block_ci(o.values); lo2, hi2 = B.block_ci(o.values, alpha=0.05/107)
print(f"base {cfg} on 11 new names: IS {i.mean()*1e4:.1f} bps/day Sharpe {B.sharpe(i):.2f}  OOS {o.mean()*1e4:.1f} bps/day 95% CI [{lo*1e4:.1f}, {hi*1e4:.1f}]  99.95% CI [{lo2*1e4:.1f}, {hi2*1e4:.1f}]  Sharpe {B.sharpe(o):.2f}  days {len(o)}")
# by half-year
q = p.groupby(pd.to_datetime(p.index).to_period("Q")).agg(["mean","count"]); q["mean"] *= 1e4; print(q.round(1))
