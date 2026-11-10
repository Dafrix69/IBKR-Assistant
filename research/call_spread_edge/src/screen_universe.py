"""Ex-ante universe screen on one day (SPEC changes 2 and 3). Raw files go to ~/Data/thetadata/_screen/<day> (not the repo).
Run: ../spx_fly/.venv/bin/python src/screen_universe.py [YYYYMMDD=20241031]  → universe/screen_<day>.csv"""
import gzip, io, os, sys, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bs
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.expanduser("~/Data/thetadata")
DAYS = sys.argv[1] if len(sys.argv) > 1 and __name__ == "__main__" else "20241031"
SCREEN = os.path.join(DATA, "_screen", DAYS)
DAY = pd.Timestamp(DAYS)
BASE = "http://127.0.0.1:25503/v3"


def fetch(sym):
    dest = os.path.join(SCREEN, f"{sym}.csv.gz")
    if os.path.exists(dest):
        return sym, "cached"
    url = f"{BASE}/option/history/greeks/eod?symbol={sym}&expiration=*&start_date={DAYS}&end_date={DAYS}&format=csv"
    for i in range(5):
        try:
            with urllib.request.urlopen(url, timeout=300) as r:
                body = r.read()
            with gzip.open(dest + ".part", "wb") as f:
                f.write(body)
            os.replace(dest + ".part", dest)
            return sym, "ok"
        except urllib.error.HTTPError as e:
            if e.code in (472, 404):
                return sym, "nodata"
            err = repr(e); time.sleep(10 * (i + 1))
        except Exception as e:  # noqa: BLE001
            err = repr(e); time.sleep(5 * (i + 1))
    return sym, "failed " + err


def metrics(sym):
    d = pd.read_csv(os.path.join(SCREEN, f"{sym}.csv.gz"), usecols=["expiration", "strike", "right", "bid", "ask", "volume", "underlying_price"])
    if d.empty:
        return None
    S = float(d.underlying_price.iloc[0])
    d["exp"] = pd.to_datetime(d.expiration); d["dte"] = (d.exp - DAY).dt.days
    weekly = bool(((d.dte >= 1) & (d.dte <= 7)).any())
    c = d[(d.dte >= 20) & (d.dte <= 45)]
    iv = np.nan
    if not c.empty and S > 0:
        e = c.loc[(c.dte - 30).abs().idxmin(), "exp"]
        ce = c[(c.exp == e) & (c.ask >= c.bid) & (c.ask > 0)]
        if not ce.empty:
            k = ce.strike.values[np.argmin(np.abs(ce.strike.values - S))]
            r = ce[ce.strike == k]
            v = bs.iv(S, r.strike.values, (e - DAY).days / 365.0, ((r.bid + r.ask) / 2).values, (r.right == "CALL").values)
            iv = float(np.nanmean(v)) if np.isfinite(v).any() else np.nan
    return dict(sym=sym, S=S, atm_iv30=iv, weekly=weekly, opt_volume=int(d.volume.sum()))


if __name__ == "__main__":
    os.makedirs(SCREEN, exist_ok=True)
    cf = os.path.join(DATA, f"_contracts_trade_{DAYS}.csv")
    if not os.path.exists(cf):
        for i in range(6):
            try:
                with urllib.request.urlopen(f"{BASE}/option/list/contracts/trade?date={DAYS}&format=csv", timeout=600) as r:
                    body = r.read()
                break
            except urllib.error.HTTPError as e:
                if e.code not in (429, 470, 474, 500, 503, 571):   # 500/503: transient upstream (RST_STREAM), retry
                    sys.exit(f"contracts list {DAYS}: HTTP {e.code} (no access to this date?)")
                time.sleep(30 * (i + 1))
        else:
            sys.exit(f"contracts list {DAYS}: still throttled")
        open(cf + ".part", "wb").write(body); os.replace(cf + ".part", cf)
    c = pd.read_csv(cf)
    n = c.groupby("symbol").size()
    roots = n[n >= 100].sort_values(ascending=False)
    with ThreadPoolExecutor(2) as ex:
        for i, (s, st) in enumerate(ex.map(fetch, roots.index)):
            print(i, s, st, flush=True)
    rows = [m for s in roots.index if os.path.exists(os.path.join(SCREEN, f"{s}.csv.gz")) for m in [metrics(s)] if m]
    out = pd.DataFrame(rows).merge(roots.rename("traded_contracts").rename_axis("sym").reset_index(), on="sym")
    out.sort_values("traded_contracts", ascending=False).to_csv(os.path.join(HERE, "universe", f"screen_{DAYS}.csv"), index=False)
    print("screened", len(out))
