"""Daily bars for every plain US ticker that has listed options, from ThetaData (FREE tier),
including names since delisted. Two <=365-day requests per symbol, 4 workers, resumable.

    python3 fetch_eod.py            # writes universe/eod/<SYMBOL>.csv + universe/eod_manifest.jsonl
"""
import json, os, re, sys, threading, time, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "tools", "thetadata"))
import download as D  # noqa: E402

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "universe", "eod")
MANIFEST = os.path.join(ROOT, "universe", "eod_manifest.jsonl")
WINDOWS = [("20241001", "20250930"), ("20251001", "20260930"), ("20261001", "20261030")]  # <= 365 days each
lock = threading.Lock()


def get(url, tries=6):
    for i in range(tries):
        try:
            return urllib.request.urlopen(url, timeout=120).read().decode()
        except urllib.error.HTTPError as e:
            if e.code in (472,):  # no data
                return ""
            if e.code in (429, 470, 474, 571):
                time.sleep(2 ** i)
                continue
            raise OSError(f"HTTP {e.code} {e.read()[:120]!r} {url}")
        except Exception:
            time.sleep(2 ** i)
    raise OSError("gave up " + url)


def symbols():
    stk = set(x.strip().strip('"') for x in get(D.BASE + "/stock/list/symbols").splitlines()[1:])
    opt = set(x.strip().strip('"') for x in get(D.BASE + "/option/list/symbols").splitlines()[1:])
    ok = re.compile(r"^[A-Z]{1,5}$")
    return sorted(s for s in stk & opt if ok.match(s))


def one(sym):
    path = os.path.join(OUT, sym + ".csv")
    parts, rows = [], 0
    for a, b in WINDOWS:
        txt = get(f"{D.BASE}/stock/history/eod?symbol={sym}&start_date={a}&end_date={b}")
        lines = txt.splitlines()
        if len(lines) > 1:
            parts.append(lines if not parts else lines[1:])
            rows += len(lines) - 1
    if parts:
        with open(path + ".part", "w") as f:
            f.write("\n".join(l for p in parts for l in p) + "\n")
        os.replace(path + ".part", path)
    with lock, open(MANIFEST, "a") as f:
        f.write(json.dumps({"symbol": sym, "rows": rows}) + "\n")
    return rows


def main():
    os.makedirs(OUT, exist_ok=True)
    proc = D.start_terminal()
    try:
        done = set()
        if os.path.exists(MANIFEST):
            done = {json.loads(l)["symbol"] for l in open(MANIFEST)}
        syms = [s for s in symbols() if s not in done]
        print(len(syms), "symbols to fetch", flush=True)
        t0, n, failed = time.time(), 0, []
        with ThreadPoolExecutor(4) as pool:
            futs = {pool.submit(one, s): s for s in syms}
            for fu in as_completed(futs):
                n += 1
                try:
                    fu.result()
                except Exception as e:
                    failed.append(futs[fu]); print("FAILED", futs[fu], repr(e)[:100], flush=True)
                if n % 200 == 0:
                    print(f"{n}/{len(syms)} {time.time()-t0:.0f}s", flush=True)
        print("done, failed:", failed, flush=True)
    finally:
        if proc: proc.terminate()


if __name__ == "__main__":
    main()
