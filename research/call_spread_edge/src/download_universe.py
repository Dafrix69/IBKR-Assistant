"""Download greeks_eod for the ex-ante universe, one request per (symbol, expiration) over that expiration's
last 30 calendar days (first 136 files: 45) inside 2024-10-31 .. 2026-11-05. Resumable (skips files that exist).
Raw files: ~/Data/thetadata/<SYM>/greeks_eod_byexp/<YYYYMMDD>.csv.gz (outside the repo; ThetaData licence).
Run: ../spx_fly/.venv/bin/python src/download_universe.py SYM1,SYM2,...   [workers=2]
Env (SPEC change 3): CSE_START / CSE_END (expiration window edges), CSE_SUBDIR (raw folder name under <SYM>/)."""
import gzip, os, sys, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
import pandas as pd

DATA = os.path.expanduser("~/Data/thetadata")
BASE = "http://127.0.0.1:25503/v3"
START = pd.Timestamp(os.environ.get("CSE_START", "2024-10-31"))
END = pd.Timestamp(os.environ.get("CSE_END", "2026-11-05"))
SUBDIR = os.environ.get("CSE_SUBDIR", "greeks_eod_byexp")   # SPEC change 3: one folder per universe
WINDOW = 30


def get(url, timeout=600):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.read()


def jobs_for(sym):
    try:
        body = get(f"{BASE}/option/list/expirations?symbol={sym}&format=csv").decode()
    except urllib.error.HTTPError as x:
        print(sym, "expirations HTTP", x.code, flush=True); return []
    exps = pd.to_datetime([l.split(",")[1].strip('"') for l in body.strip().splitlines()[1:]])
    out = []
    for e in exps:
        lo, hi = max(e - pd.Timedelta(days=WINDOW), START), min(e, END)
        if lo > hi:
            continue
        dest = os.path.join(DATA, sym, SUBDIR, e.strftime("%Y%m%d") + ".csv.gz")
        url = (f"{BASE}/option/history/greeks/eod?symbol={sym}&expiration={e:%Y%m%d}"
               f"&start_date={lo:%Y%m%d}&end_date={hi:%Y%m%d}&format=csv")
        out.append((sym, e, url, dest))
    return out


def run(job):
    sym, e, url, dest = job
    if os.path.exists(dest) or os.path.exists(dest + ".nodata"):
        return sym, e, "cached", 0
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    err = ""
    for i in range(6):
        try:
            body = get(url)
            with gzip.open(dest + ".part", "wb") as f:
                f.write(body)
            os.replace(dest + ".part", dest)
            return sym, e, "ok", len(body)
        except urllib.error.HTTPError as x:
            if x.code in (472, 404):            # no data for this expiration in range
                open(dest + ".nodata", "w").close()
                return sym, e, "nodata", 0
            err = repr(x)
        except Exception as x:  # noqa: BLE001
            err = repr(x)
        time.sleep(10 * (i + 1))
    return sym, e, "FAILED " + err, 0


if __name__ == "__main__":
    syms = sys.argv[1].split(",")
    workers = int(sys.argv[2]) if len(sys.argv) > 2 else 2
    jobs = [j for s in syms for j in jobs_for(s)]
    print(f"{len(jobs)} expiration files for {len(syms)} symbols", flush=True)
    t0, n = time.time(), 0
    with ThreadPoolExecutor(workers) as ex:
        futs = [ex.submit(run, j) for j in jobs]
        for f in as_completed(futs):
            s, e, st, b = f.result(); n += 1
            print(f"[{n}/{len(jobs)}] {s} {e:%Y-%m-%d} {st} {b/1e6:.1f}MB {(time.time()-t0)/60:.0f}min", flush=True)
    print("DONE", flush=True)
