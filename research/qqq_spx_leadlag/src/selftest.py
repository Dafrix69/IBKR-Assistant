"""Known-answer check of analyze.py on synthetic data: target = source lagged LAG seconds + own noise."""
import sys, numpy as np
import analyze as A
LAG = int(sys.argv[1]) if len(sys.argv) > 1 else 1
rng = np.random.default_rng(int(sys.argv[2]) if len(sys.argv) > 2 else 1)
def fake_day():
    e = rng.standard_t(4, A.N + 10) * 0.3e-4          # common factor, fat tails
    src = 600 * np.exp(np.cumsum(e[10:] + rng.normal(0, 0.1e-4, A.N)))
    tgt = 700 * np.exp(np.cumsum(0.8 * e[10 - LAG:A.N + 10 - LAG] + rng.normal(0, 0.1e-4, A.N)))
    d = {"QQQ": src, "NQ": src * 40, "SPY": tgt, "ES": tgt * 10, "SPX": tgt * 10}
    d["SPY_hs"] = np.full(A.N, 0.005); d["ES_hs"] = np.full(A.N, 0.125)
    return d
data = {f"d{i}": fake_day() for i in range(10)}
c = A.t1(data, [("QQQ", "SPY")])
print(c[["k-2", "k-1", "k+0", "k+1", "k+2", "k+3"]].to_string(index=False))
r = A.t2(data, "QQQ", "SPY"); print(r[(r.w == 1) & (r.h == 5)].to_string(index=False))
v = dict(src="QQQ", tgt="SPY", sig="S1", w=1, theta=4, h=5)
print(A.summarize(A.run_variant(data, v, A.beta_1m(data, "QQQ", "SPY"))).to_string(index=False))
v["sig"] = "S2"; print(A.summarize(A.run_variant(data, v, A.beta_1m(data, "QQQ", "SPY"))).to_string(index=False))
