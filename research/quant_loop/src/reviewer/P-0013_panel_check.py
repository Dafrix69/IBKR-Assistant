import pandas as pd, numpy as np
R="/Users/dafrix/Developer/ibkr/work/datrix-qt/research"
wp=pd.read_parquet(f"{R}/spx_fly/data/clean/winrate_panel.parquet")
print(wp.columns.tolist())
d=pd.read_csv(f"{R}/quant_loop/src/validator/V-0013_tables/daily_test.csv",parse_dates=["date"])
x=wp[(wp.entry=="14:00")&(wp.date>="2024-11-01")]
p=x[x.structure=="put_fly"].set_index(["date","width"]); i=x[x.structure=="iron_fly"].set_index(["date","width"])
j=p.join(i,lsuffix="_p",rsuffix="_i",how="inner").reset_index()
m=d.merge(j,left_on=["date","w"],right_on=["date","width"])
print("days matched",len(m),"of",len(d))
for c in ("pnl","pnl_k0","pnl_k05"):
    print(c,"iron - put mean USD",round((m[c+"_i"]-m[c+"_p"]).mean(),2))
print("validator G20 mean on same days",round(m.G20.mean(),2))
print("file mtime check: winrate_panel")
import os,time; print(time.strftime("%Y-%m-%d %H:%M",time.localtime(os.path.getmtime(f"{R}/spx_fly/data/clean/winrate_panel.parquet"))))
# tick artifact: iron k_own
c=pd.read_parquet(f"{R}/quant_loop/src/validator/V-0013_tables/tape_test_filtered.parquet")
ir=c[c.struct=="iron"]
print("iron H quantiles",ir.H.quantile([.1,.25,.5,.75,.9]).round(3).tolist())
print("iron s_own value shares",ir.s_own.round(3).value_counts(normalize=True).head(6).round(3).to_dict())
print("iron share k_own exactly 0:",round((ir.s_own<1e-9).mean(),3)," share with s_own==0.05 & H==0.25:",round(((ir.s_own.round(3)==0.05)&(ir.H.round(3)==0.25)).mean(),3))
pt=c[c.struct=="put"]
print("put  s_own value shares",pt.s_own.round(3).value_counts(normalize=True).head(6).round(3).to_dict())
print("lots==1 share",c.groupby("struct").lots.apply(lambda s:(s==1).mean()).round(3).to_dict())
