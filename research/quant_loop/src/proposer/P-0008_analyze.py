"""P-0008 analysis: M tests (no pnl) + pnl sign lines. TRAINING PERIOD ONLY.
    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0008_analyze.py
"""
import os
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = f"{HERE}/P-0008_tables"
TRAIN_END = pd.Timestamp("2024-11-01")
df = pd.read_csv(f"{OUT}/days_all.csv", parse_dates=["date"])
df = df[df.date < TRAIN_END]                           # TIME WALL
df = df[df["drop"].isna() | (df["drop"] == "")]
df = df[df.spx_ret_prev > -0.01].copy()
ICUT = (10.6, 14.25)
df["it"] = pd.cut(df.I, [-1, *ICUT, 1e9], labels=["iL", "iM", "iH"])
df["x"] = (df.settle - df.S).abs() / df.I
df["mom"] = (df.S - df.O).abs() / df.I
df["mon"] = df.date.dt.to_period("M")
seg = df.groupby("mon").apply(lambda g: np.sign(np.median(g.settle - g.F)))
df["seg"] = df.mon.map(seg).map({1.0: "up", -1.0: "down", 0.0: "down"})
mmed = df.mom.median()
df["momh"] = np.where(df.mom > mmed, "mom_hi", "mom_lo")
rng = np.random.default_rng(8)


def mstats(g):
    r = {}
    parts = []
    for it, h in g.groupby("it", observed=True):
        L, H = h[h.state == "L"], h[h.state == "H"]
        if len(L) < 3 or len(H) < 3:
            continue
        parts.append(((L.x <= 0.5).mean() - (H.x <= 0.5).mean(), (H.x > 1.5).mean() - (L.x > 1.5).mean(),
                      H.x.mean() - L.x.mean(), len(L), len(H)))
    if not parts:
        return {"Mc": np.nan, "Mt": np.nan, "Mx": np.nan, "nL": 0, "nH": 0}
    a = np.array(parts)
    return {"Mc": a[:, 0].mean(), "Mt": a[:, 1].mean(), "Mx": a[:, 2].mean(), "nL": int(a[:, 3].sum()), "nH": int(a[:, 4].sum())}


def boot(g, B=2000):
    idx = np.arange(len(g)); res = []
    for _ in range(B):
        res.append(mstats(g.iloc[rng.choice(idx, len(idx))]))
    b = pd.DataFrame(res)
    return {k + "_ci": (round(b[k].quantile(.025), 3), round(b[k].quantile(.975), 3)) for k in ("Mc", "Mt", "Mx")}


rows = []
def add(name, g, ci=False):
    r = {"cell": name, "n": len(g), **mstats(g)}
    if ci:
        r.update(boot(g))
    rows.append(r)

add("all", df, ci=True)
for y, g in df.groupby(df.date.dt.year):
    add(f"year {y}", g)
for it, g in df.groupby("it", observed=True):
    L, H = g[g.state == "L"], g[g.state == "H"]
    rows.append({"cell": f"I tercile {it}", "n": len(g), "Mc": (L.x <= .5).mean() - (H.x <= .5).mean(),
                 "Mt": (H.x > 1.5).mean() - (L.x > 1.5).mean(), "Mx": H.x.mean() - L.x.mean(), "nL": len(L), "nH": len(H)})
for k in ("momh", "seg"):
    for lab, g in df.groupby(k):
        add(f"{k} {lab}", g)
add("no FOMC", df[~df.fomc.astype(str).eq("True")])
m = pd.DataFrame(rows)
pd.set_option("display.width", 200)
print("n days", len(df), "states", df.state.value_counts().to_dict(), "mom median", round(mmed, 3))
print("x by state (raw):", df.groupby("state").x.agg(["mean", "median", "count"]).round(3).to_dict())
print(m.round(3).to_string(index=False))
m.to_csv(f"{OUT}/m_cells.csv", index=False)

# pnl
def bmean(a, B=4000):
    a = np.asarray(a); bs = rng.choice(a, (B, len(a))).mean(1)
    return round(a.mean(), 1), (round(np.quantile(bs, .025), 1), round(np.quantile(bs, .975), 1))
out = []
for tag in ("", "_k05", "_k0"):
    out.append({"k": tag or "k0.20", "D_vs_R2": bmean(df[f"p_R{tag}"] - df[f"p_w2{tag}"]),
                "D_vs_B": bmean(df[f"p_R{tag}"] - df[f"p_wB{tag}"])})
print(pd.DataFrame(out).to_string(index=False))
print("sd daily diff vs R2", round((df.p_R - df.p_w2).std(), 1))
df["D3"] = df.p_w3 - df.p_w2; df["D15"] = df.p_w15 - df.p_w2
inter = df.groupby("state")[["D3", "D15"]].mean().round(1)
print("interaction (k0.20):\n", inter)
print("I1: D3|L - D3|H =", round(inter.loc["L", "D3"] - inter.loc["H", "D3"], 1),
      " I2: D15|H - D15|L =", round(inter.loc["H", "D15"] - inter.loc["L", "D15"], 1))
# stratified-by-I interaction (diagnostic)
si = df.groupby(["it", "state"], observed=True)[["D3", "D15"]].mean().unstack()
print("interaction within I tercile:\n", si.round(1))
by = df.assign(D=df.p_R - df.p_w2).groupby(df.date.dt.year).agg(n=("D", "size"), D=("D", "mean"),
      R=("p_R", "mean"), R2=("p_w2", "mean"), B=("p_wB", "mean"), winR=("p_R", lambda s: (s > 0).mean()),
      winR2=("p_w2", lambda s: (s > 0).mean()))
print(by.round(3))
st = df.groupby("state").agg(n=("x", "size"), R=("p_R", "mean"), R2=("p_w2", "mean"), w2=("w2", "mean"), wR=("wR", "mean"),
      winR=("p_R", lambda s: (s > 0).mean()), winR2=("p_w2", lambda s: (s > 0).mean()))
print(st.round(3))
print("totals: R", round(df.p_R.mean(), 1), (df.p_R > 0).mean().round(3), " R2", round(df.p_w2.mean(), 1), (df.p_w2 > 0).mean().round(3),
      " B", round(df.p_wB.mean(), 1), (df.p_wB > 0).mean().round(3))
by.to_csv(f"{OUT}/pnl_by_year.csv"); inter.to_csv(f"{OUT}/interaction.csv")
