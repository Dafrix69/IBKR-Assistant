"""Apply SPEC change 2 steps b–d to universe/screen_<day>.csv → universe/screen_passed_<day>.csv + universe/UNIVERSE_<day>.txt.
FUNDS was written before any screen of 2020–2023 was looked at (SPEC change 3); it must reproduce the 2024-10-31 pick exactly.
Run: ../spx_fly/.venv/bin/python src/select_universe.py YYYYMMDD [--check]"""
import os, sys
import pandas as pd

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ORIGINAL15 = set("IREN AXTI LITE OKLO CRDO NBIS QUBT NVTS APLD CLSK SNDK WOLF ALAB QBTS RKLB".split())
# indices, ETFs, ETNs, leveraged / inverse / single-stock ETPs, trusts (by name only)
FUNDS = set("""
SPX SPXW NDX NDXP RUT RUTW XSP DJX OEX XEO VIX VIXW MRUT
SPY QQQ IWM DIA MDY EEM EFA EWZ BRZU EWJ EWW EWY EWT EWH EWG EWU INDA MCHI FXI ASHR KWEB CWEB CHAU YINN YANG
XLF XLE XLK XLV XLI XLU XLP XLY XLB XLRE XLC SMH SOXX KRE KBE XBI IBB XOP OIH XME ITB XHB XRT JETS TAN ICLN LIT URA URNM REMX COPX
GDX GDXJ SIL SILJ GLD IAU SLV PSLV SPPP USO BNO UNG UNL UCO SCO CORN WEAT SOYB DBA DBC PDBC BOIL KOLD AGQ ZSL USLV DSLV UGAZ DGAZ UGLD DGLD
TLT IEF SHY HYG JNK LQD TMF TMV TBT TBF EMB
TQQQ SQQQ QLD QID SOXL SOXS UPRO SPXU SPXS SPXL SSO SDS SH PSQ DOG DDM DXD UDOW SDOW TNA TZA URTY SRTY UWM RWM TWM
LABU LABD FAS FAZ NUGT DUST JNUG JDST GUSH DRIP ERX ERY TECL TECS CURE DPST DRN DRV NAIL RETL FNGU FNGD BULZ WEBL WEBS
UVXY SVXY VXX VIXY VXZ UVIX SVIX TVIX ZIV VIXM
TSLL TSLQ TSLT TSLZ TSDD NVDL NVDS NVDU NVDX NVD AMDL CONL MSTU MSTX MSTZ SMCX SMCL PLTU AAPU GGLL AMZU MSFU METU
BITX BITO BITU SBIT IBIT FBTC GBTC ETHE ETHA ETHU ARKK ARKG ARKF ARKW ARKQ MSOS
""".split())

if __name__ == "__main__":
    day = sys.argv[1]
    d = pd.read_csv(os.path.join(HERE, "universe", f"screen_{day}.csv"))
    d = d[(d.S >= 2) & (d.atm_iv30 >= 0.70) & d.weekly].sort_values("traded_contracts", ascending=False).reset_index(drop=True)
    d["excluded"] = None
    d.loc[d.sym.isin(FUNDS), "excluded"] = "fund/ETP"
    d.loc[d.sym.isin(ORIGINAL15), "excluded"] = "original 15"
    keep = d.excluded.isna()
    d["rank"] = None
    d.loc[keep, "rank"] = range(1, keep.sum() + 1)
    d["selected"] = keep & (d["rank"].fillna(99) <= 40)
    picked = d[d.selected].sym.tolist()
    if "--check" in sys.argv:
        want = open(os.path.join(HERE, "universe", "UNIVERSE.txt")).read().strip().split(",")
        old = pd.read_csv(os.path.join(HERE, "universe", f"screen_passed_{day}.csv"))
        print("passed b:", len(d), "vs", len(old), "| same picks in same order:", picked == want)
        sys.exit(0 if picked == want and len(d) == len(old) else 1)
    d.to_csv(os.path.join(HERE, "universe", f"screen_passed_{day}.csv"), index=False)
    open(os.path.join(HERE, "universe", f"UNIVERSE_{day}.txt"), "w").write(",".join(picked) + "\n")
    print(day, "passed b:", len(d), "excluded:", d.excluded.value_counts().to_dict(), "picked:", len(picked))
    print(",".join(picked))
