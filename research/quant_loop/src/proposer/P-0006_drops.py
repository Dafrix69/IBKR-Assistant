"""P-0006 diagnostic, TRAINING ONLY: which leg trips the 3.0-pt spread cap on the 36 'wide' days."""
import os
import pandas as pd
R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "P-0006_tables")
TRAIN_END = pd.Timestamp("2024-11-01")
df = pd.read_csv(f"{OUT}/days_all.csv", parse_dates=["date"])
df = df[df.date < TRAIN_END]                           # TIME WALL
cal = pd.read_parquet(f"{R}/data/clean/calendar.parquet")
cal = cal[cal.index < TRAIN_END]                       # TIME WALL
spot = pd.read_parquet(f"{R}/data/clean/spot.parquet")
spot = spot[spot.ts < TRAIN_END].set_index("ts")       # TIME WALL
rows = []
for d in df[df["drop"] == "wide"].date:
    ch = pd.read_parquet(f"{R}/data/clean/chain_{d:%Y%m%d}.parquet")
    ch = ch[ch.ts < TRAIN_END]                         # TIME WALL
    t = pd.Timestamp(f"{d:%Y-%m-%d} 14:00"); S = spot.loc[t, "spot"]
    q = ch[(ch.ts == t) & ~ch.flag_bad].set_index(["strike", "right"])
    ks = q.index.get_level_values(0).unique(); K = float(ks[abs(ks - S).argmin()])
    I = q.loc[(K, "C"), "mid"] + q.loc[(K, "P"), "mid"]
    w = min([20, 25, 30, 50, 75], key=lambda x: abs(x / I - 2))
    legs = {"PK-w": (K - w, "P"), "PK": (K, "P"), "CK": (K, "C"), "CK+w": (K + w, "C"),
            "PK-5": (K - 5, "P"), "CK+5": (K + 5, "C"), "PK+w(ITM, PF only)": (K + w, "P")}
    sp = {n: float(q.loc[x, "ask"] - q.loc[x, "bid"]) for n, x in legs.items()}
    tripped = [n for n, v in sp.items() if v > 3.0]
    rows.append({"date": d.date(), "w": w, "I": round(I, 2), "fomc": bool(cal.loc[d, "fomc"]),
                 "tripped": ",".join(tripped), "PF_leg_only": tripped == ["PK+w(ITM, PF only)"]})
r = pd.DataFrame(rows); r.to_csv(f"{OUT}/wide_drops.csv", index=False)
print(r.to_string()); print("PF-ITM-leg only:", r.PF_leg_only.sum(), "of", len(r), "; fomc", r.fomc.sum())
