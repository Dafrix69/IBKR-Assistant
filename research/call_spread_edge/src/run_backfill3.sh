#!/bin/zsh
# SPEC change 3: retry of the 2019 pool after run_backfill2.sh (its screen hit a transient HTTP 500) (newest first). Waits for any running download_universe.py,
# then per year: screen → select → download (own raw folder). Years ThetaData refuses are logged and skipped.
cd "$(dirname "$0")/.."
PY=../spx_fly/.venv/bin/python
while pgrep -f "src/run_backfill2.sh" >/dev/null || pgrep -f "src/download_universe.py" >/dev/null; do sleep 60; done
echo "start $(date)"
typeset -A NEXT=(20191031 2020-10-30 20181031 2019-10-31)
for DAY in 20191031; do
  echo "== $DAY screen $(date)"
  if ! $PY src/screen_universe.py $DAY > screen_$DAY.log 2>&1; then echo "screen $DAY failed:"; tail -2 screen_$DAY.log; continue; fi
  $PY src/select_universe.py $DAY || { echo "select $DAY failed"; continue; }
  END=$($PY -c "import pandas as pd;print((pd.Timestamp('${NEXT[$DAY]}')+pd.Timedelta(days=35)).date())")
  START=${DAY[1,4]}-${DAY[5,6]}-${DAY[7,8]}
  echo "== $DAY download $START..$END $(date)"
  CSE_START=$START CSE_END=$END CSE_SUBDIR=greeks_eod_byexp_$DAY \
    $PY src/download_universe.py $(cat universe/UNIVERSE_$DAY.txt | tr -d '\n') 4 > download_$DAY.log 2>&1
  CSE_START=$START CSE_END=$END CSE_SUBDIR=greeks_eod_byexp_$DAY \
    $PY src/download_universe.py $(cat universe/UNIVERSE_$DAY.txt | tr -d "\n") 4 >> download_$DAY.log 2>&1   # second pass: retry FAILED
  tail -1 download_$DAY.log; echo "failed in pass 2: $(tail -n +$(grep -n "expiration files" download_$DAY.log | tail -1 | cut -d: -f1) download_$DAY.log | grep -c FAILED)"
done
echo "ALL DONE $(date)"
