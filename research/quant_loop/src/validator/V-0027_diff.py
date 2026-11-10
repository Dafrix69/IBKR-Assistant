"""V-0027 training-only code check against the proposer's P-0023/0024 trade table (used ONLY as a diff target).
Entry and exit < 2023-10-31 on both sides."""
import os, importlib.util
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
WALL = pd.Timestamp("2023-10-31")
spec = importlib.util.spec_from_file_location("st", os.path.join(HERE, "V-0027_stats.py"))
ST = importlib.util.module_from_spec(spec); spec.loader.exec_module(ST)

V = pd.read_pickle(os.path.join(HERE, "V-0027_cache/trades_train.pkl"))
V = V[(V.E < WALL) & (V.M < WALL)]
Pp = pd.read_pickle(os.path.join(HERE, "../proposer/P-0023_0024_cache/trades.pkl"))
Pp = Pp[(Pp.E < WALL) & (Pp.M < WALL)]
L = []; P = L.append
key = ["pool", "M", "sym"]
pc = Pp[Pp.right == "C"].set_index(key); pp = Pp[Pp.right == "P"].set_index(key)
v = V.set_index(key)
P(f"cycles: mine {V.groupby(['pool','M']).ngroups}, proposer {Pp.groupby(['pool','M']).ngroups}; "
  f"same (pool,M) set {set(V.groupby(['pool','M']).groups) == set(Pp.groupby(['pool','M']).groups)}")
j = v.join(pc[["ivol", "vov", "excl", "status", "K", "pnl_k05", "S_E", "iv0"]], rsuffix="_pc", how="outer")
P(f"rows mine {len(v)}, proposer call rows {len(pc)}, joined {len(j)}")
d = (j.ivol - j.ivol_pc).abs()
P(f"IVOL: both valid {(j.ivol.notna() & j.ivol_pc.notna()).sum()}, max |diff| {d.max():.2e}, mine-only {(j.ivol.notna() & j.ivol_pc.isna()).sum()}, theirs-only {(j.ivol.isna() & j.ivol_pc.notna()).sum()}")
d = (j.vov - j.vov_pc).abs()
P(f"VOV : max |diff| {d.max():.2e}, n diff > 1e-6: {(d > 1e-6).sum()}, mine-only {(j.vov.notna() & j.vov_pc.isna()).sum()}, theirs-only {(j.vov.isna() & j.vov_pc.notna()).sum()}")
P(f"excl: mine {j.excl.notna().sum()} theirs {j.excl_pc.notna().sum()} disagree {(j.excl.notna() != j.excl_pc.notna()).sum()}")
P(f"S_E max |diff| {(j.S_E - j.S_E_pc).abs().max():.2e}")
# quintiles
Qm = ST.assign(V, "ivol").set_index(key)
Qp = Pp[Pp.right == "C"].copy()
Qp = ST.assign(Qp, "ivol").set_index(key)
q = Qm[["q"]].join(Qp[["q"]], rsuffix="_p", how="outer")
P(f"IVOL quintile agreement: {(q.q == q.q_p).sum()}/{len(q)}; Q5 mine {(q.q==5).sum()} theirs {(q.q_p==5).sum()} both {((q.q==5)&(q.q_p==5)).sum()}")
# diag structure vs proposer call+put sum on the same stock-cycles
pj = pc[["status", "pnl_k0", "pnl_k05", "pnl_k1", "K"]].join(pp[["status", "pnl_k0", "pnl_k05", "pnl_k1", "K", "iv0"]], rsuffix="_p", how="inner")
pj = pj[(pj.status == "ok") & (pj.status_p == "ok")]
pj["str05"] = pj.pnl_k05 + pj.pnl_k05_p
x = v[v.d_status == "ok"][["d_pnl_k05", "d_Kc", "d_Kp", "pnl_k05", "status"]].join(pj[["str05", "K", "K_p"]], how="inner")
dd = (x.d_pnl_k05 - x.str05)
P(f"diag structure vs proposer call+put on common trades: n {len(x)}, strikes equal C {(x.d_Kc == x.K).mean():.3f} P {(x.d_Kp == x.K_p).mean():.3f}; "
  f"|diff| median {dd.abs().median():.4f}, p99 {dd.abs().quantile(.99):.4f}, max {dd.abs().max():.3f}; mean mine {x.d_pnl_k05.mean():+.3f} theirs {x.str05.mean():+.3f}")
big = x.assign(diff=dd).sort_values("diff", key=np.abs, ascending=False).head(8)
P(big[["d_Kc", "K", "d_Kp", "K_p", "d_pnl_k05", "str05", "diff"]].to_string())
P(f"diag ok mine {(v.d_status=='ok').sum()} vs proposer both-legs-ok {len(pj)}; mine-not-theirs {len(set(v[v.d_status=='ok'].index)-set(pj.index))}, theirs-not-mine {len(set(pj.index)-set(v[v.d_status=='ok'].index))}")
# Q5 diag on proposer's assignment vs mine
q5m = Qm[(Qm.q == 5) & (Qm.d_status == "ok")]
P(f"Q5 diag k0.5 mine {q5m.d_pnl_k05.mean():+.3f} (n {len(q5m)})")
q5p = pj.join(Qp[["q"]], how="inner"); q5p = q5p[q5p.q == 5]
P(f"Q5 call+put k0.5 from proposer's table with proposer's quintiles {q5p.str05.mean():+.3f} (n {len(q5p)})")
txt = "\n".join(L); print(txt)
os.makedirs(os.path.join(HERE, "V-0027_tables"), exist_ok=True)
with open(os.path.join(HERE, "V-0027_tables/diff_train.txt"), "w") as f:
    f.write(txt + "\n")
