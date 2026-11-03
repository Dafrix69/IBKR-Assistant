# Opening-range breakout on IREN / AXTI and their 2x ETFs

Written 2026-10-31 BEFORE any bars were downloaded. Changes after that are listed
at the bottom with a reason, so nothing is silently tuned to the results.

## Question
After real costs, does an intraday opening-range breakout make money on IREN and
AXTI, and is the 2x ETF a better or worse way to hold the same signal than the stock?

## Data
TWS, read-only, regular hours, 1-minute bars, bar START time in America/New_York.
- TRADES: IREN, AXTI from 2024-10-31; IRE, AXTX since listing (real ETF results).
- BID_ASK: IREN, AXTI, IRE, IREX, AXTX, last 8 weeks, for the spread cost.

## Rules (signal on the STOCK; ETF trades follow the stock's signal)
- Range: high/low of the first N minutes from 09:30. N in {5, 15, 30}.
- Entry: first 1-minute CLOSE outside the range, filled at the next bar's OPEN. No
  entries after 15:00. One trade per symbol per day.
- Stop: the other side of the range, or a fraction f in {0.5, 1.0} of the range width
  from the entry-side edge. f = 1.0 is the opposite side.
- A stop fills at the worse of the stop price and the bar's open (gaps go through).
- Exit: stop, or the open of the 15:55 bar. Nothing held overnight.
- Sides: long+short, long only.
- Volume filter: none, or opening-range volume > 1.0x / 1.5x its trailing 14-day mean
  of the same window, using prior days only ("stocks in play").

That is 3 x 2 x 2 x 3 = 36 configurations. Both symbols use one shared configuration.

## Costs
Per side, in price terms: half the median 1-minute quoted spread for that minute of
day (measured from BID_ASK), plus commission 0.0035 USD/share (min not modelled), plus
one extra half-spread on stop exits, which cross a moving market. Short borrow on the
stock is NOT charged (day trades carry no overnight borrow); shorting the ETF is not
tested, the short side uses the inverse ETF concept only by the stock proxy.

## Inference
- Pooled by day. Unit: net return on notional, and R (risk = entry to stop).
- First 2/3 of dates = in-sample, last 1/3 = out-of-sample. The one configuration is
  picked on in-sample Sharpe. Only the out-of-sample number for that pick is the result.
- 95 % CI: stationary block bootstrap of daily returns, block mean 5 days, 10000 draws.
- Baselines: long open-to-15:55 every day; same entries with a random direction.
- 36 tries is a multiple-testing problem: all 36 out-of-sample numbers are reported.

## Pass bar, set before seeing results
The pick must have out-of-sample net mean > 0 with the CI excluding 0 and beat both
baselines, and survive 2x cost. Otherwise the answer is "not shown to work".

## Option walls (added 2026-10-31 at the user's request, before any backtest result was seen)
The user's prior: these small caps respect option walls. Tested as its own hypothesis.

Data: ThetaData open_interest + greeks/eod, 2024-10-31 onward. OI stamped 06:30 ET on day
D is known before D's open. Gamma and spot come from day D-1's EOD report, so every wall
is fixed before the open.

Per day, expirations 0-30 DTE, strikes within +/-25 % of the D-1 close:
gex(K) = gamma x OI x 100 x spot^2 x 0.01, summed by strike and right.
- Call wall: the strike above spot with the largest call gex.
- Put wall: the strike below spot with the largest put gex.
- Net GEX: call gex - put gex, on the usual "dealer long calls, short puts" convention.
  That convention is an assumption, not a fact, so W4 is read as a split, both ways.
- A side needs at least 500 contracts of OI at its wall, otherwise that wall is absent
  and the overlay does nothing that day.

A. Does a wall act at all, independent of ORB. First 1-minute touch of the wall from the
   prior close's side. Measure the signed return over the next 30 minutes, away from the
   wall counted positive. Placebo: the same percent distance from the prior close taken
   from a random other day. Support needs real > placebo with the block-bootstrap CI of
   the paired difference excluding 0.

B. Overlays on the base pick, each compared with the base on the same days:
- W1 barrier: skip a trade if the wall ahead is closer than 1.0 opening-range width.
- W2 target: take profit at the wall ahead, filled at the wall price on touch.
- W3 cleared wall: trade only if the entry is already beyond the wall of that side.
- W4 regime: trade only when net GEX < 0; reported also for net GEX >= 0.
Four overlays are four tries. Each must improve the base both in-sample and out-of-sample,
with the out-of-sample CI of the daily difference excluding 0 at 98.75 % (0.05 / 4).

## Universe extension (added 2026-10-31 after the two-name result, before any universe data was seen)
Two names cannot answer the question. The ORB literature's edge is on a daily "stocks in play"
screen, so the test is repeated on such a screen, with the two-name pick carried over unchanged
(15-minute range, stop at the other side, long only) so this is a true out-of-sample test of it.

Pool: every plain US ticker that has listed options in ThetaData's lists, daily bars from
ThetaData's EOD report (FREE tier), including names since delisted. Nothing is excluded for
having died, so there is no survivorship filter.

Eligible on day D, using only D-1 and earlier: close(D-1) >= 5 USD; 20-day mean dollar volume
>= 30 M USD; at least 30 prior days of history.

Screen on D, known at 09:30: gap = open(D) / close(D-1) - 1. Candidates = the 10 eligible names
with the largest |gap|, requiring |gap| >= 3 %. The two-name opening-range volume filter is
dropped here: it needs 14 prior days of minute bars per name, which TWS pacing does not allow
for a rotating universe. The gap screen stands in for "in play". This is a change of the rule,
stated here before results.

Minute bars: TWS TRADES 1-minute for each (candidate, day) only. Spread: TWS BID_ASK 1-minute
for a random 15 % of the candidate days (seed 3); the median spread fraction per 15-minute bucket
is modelled as a function of price and D-1 dollar volume (log-log OLS), and the model is applied
to all candidate days. Commission as before.

Inference: pooled by day across candidates (equal weight per trade, per day mean). Same IS / OOS
split dates as the two-name test. Reported: OOS net mean, block-bootstrap CI, Sharpe; the same
random-direction baseline; long-open-to-close baseline on the same candidates (the gap-day drift
itself). The pass bar is unchanged. One configuration, no grid, so no multiple-testing correction.

### Universe amendment, 2026-11-01, after the first screen and before any universe minute bar
The first screen's top-10 lists are dominated by leveraged ETFs (KORU, ETHU, SMCX, MSTX,
OKLL, AXTX, ... 15 of the 15 most frequent names): their gaps are 2-3x the underlying's
by construction, and several of them track one underlying, so the same event enters the
list several times. The universe is restricted to COMMON stock as classified by IB's
contract details (universe/types.csv, classify_tws.py); ETFs, ADRs, trusts and anything
unresolved are dropped, and the screen is re-run until the top-10 lists hold classified
common stock only. The ETF is still the instrument in the ETF comparison, as before.
The raw first screen is kept as universe/candidates_raw.csv for the record.

## VWAP and take-profit exits (added 2026-10-31 at the user's request, before any VWAP
## result was seen; IREN / AXTI bars had already been used for the ORB test above)
The user's framing: the 2x ETF is a scalp, a few percent on the ETF (1-2 % on the stock)
is enough. So two things are tested, on the named set and on the universe candidates:

VWAP, session cumulative sum(price x volume) / sum(volume) from 09:30, typical price
(h+l+c)/3, from the stock's 1-minute bars.
- V1 "pullback": after 09:45, price is above VWAP (close > VWAP for 5 straight bars) and
  pulls back to within 0.1 % of VWAP, then closes back above it: long at the next open.
  Mirror for short. Stop: 0.5 x the opening-range width (15 min) beyond VWAP.
- V2 "cross": first 1-minute close through VWAP after 09:45 in the direction of the gap
  (gap up: close above VWAP from below). Stop: the session low (gap up) / high so far.
- Both: no entries after 15:00, one trade per symbol per day, else exit at 15:55.

Take-profit (TP) ladder, applied to ORB(15, 1.0), V1 and V2 alike: exit at +0.5 %,
+1 %, +2 %, +3 % on the stock (= +1 to +6 % on the 2x ETF), or none. A TP is treated
as filled only if a bar's CLOSE is beyond it (filled at that close), not on an intrabar
touch, so a quote that was never hit is not counted. Stop checks use the bar's low/high
as before, so the test is pessimistic on both sides.

That is 3 rules x 5 TP levels x 2 sides = 30 more configurations on top of the 36. The
pick is by in-sample Sharpe across all 66; everything else as under Inference and the
pass bar, with the CI widened to 99.92 % (1 - 0.05/66; first written as 99.2 %, an
arithmetic slip noticed when the code printed 99.9 % on the first run; the pick does not
depend on it and the result was already outside the 95 % bar). Costs as above; a TP exit pays
half a spread like a passive exit.

## Pre-market and after-hours (added 2026-10-31 at the user's request, before any
## extended-hours bar was downloaded)
The user's rule of thumb: IREN runs up pre-market and sells off from the open. The user
wants every strategy to see the whole session, 04:00-20:00 ET. The exploratory gap test
on regular-hours bars (scratchpad gap_fade.py, 498 IREN days, gap buckets 3/5/8 %) found
nothing; it is not a test of the claim because the pre-market high is invisible there.

Data: 1-minute TRADES 04:00-20:00 ET for IREN, AXTI, LITE, OKLO from 2024-10-31
(data/<SYM>_TRADES_EXT), and BID_ASK for the same hours over the last 8 weeks for the
pre-market cost. Regular-hours tests above read the same files filtered to 09:30-15:59.
Night session too (the user: 夜盘也要有): IBKR's OVERNIGHT exchange, 20:00-03:50 ET,
Sunday night to Friday morning, same span, data/<SYM>_TRADES_OVN and _BID_ASK_OVN. A
bar from 20:00 on belongs to the NEXT trading day, so one "day" runs 20:00 -> 20:00 and
pm_ret / pm_high / pm_vol below are measured over 20:00-09:29, the whole overnight
plus pre-market stretch. How far back IBKR's overnight history goes for these names
is unknown until pulled; the report states the first overnight bar per name. Night-
session entries fall under the same spread gate as pre-market entries.

Features known at 09:30 of day D (the after-hours of D-1 counts as part of the move):
- pm_ret = last pre-market trade (09:29 bar close) / D-1 regular close - 1
- pm_high, pm_low, pm_vol over 04:00-09:29; fade_in = open / pm_high - 1

H1 (the user's claim), as a trade: pm_ret >= X, X in {3, 5, 8} %: short at the 09:31
open, stop at pm_high (filled at the worse of stop and bar open), exit on the TP ladder
(0.5 / 1 / 2 / 3 % / none, on a bar close) or at 15:55. Variant "fade started": the same
only when fade_in <= -1 % at the open. 3 x 5 x 2 = 30 configurations. Short borrow is not
charged (day trade); the regular-hours spread cost applies.
H1 descriptive: open-to-t return by pm_ret bucket, as in gap_fade.py, with pm_high
instead of the gap. Reported whatever H1 says.
H2 overlay: ORB(15, 1.0, long) only when the breakout close is also above pm_high
(the pre-market high as a wall, like W3). One configuration.
Pre-market entries themselves (trading 04:00-09:29) are NOT tested until the pre-market
spread is measured; it is reported, and if the median pre-market spread is above 30 bps
the answer for pre-market scalping is "cost too high" without a backtest.

Inference and pass bar as before. The tally is now 36 + 30 + 31 = 97 configurations; the
widened CI is 1 - 0.05/97 = 99.95 %.

## Short in the night / pre-market session (added 2026-11-01 14:20 Beijing, after the H1 result
## and the descriptive finding that 96-100 % of pm >= 5 % days open below the pre-market high)
The user: 那肯定盘前就做空或者夜盘就做空啊. The descriptive table was seen before this was written,
so the hypothesis is data-suggested; the entry / stop / exit rules below are fixed before any
trade of this kind is simulated.

Window: the whole 20:00 (prev day) - 09:29 stretch, night and pre-market together, from the
_OVN and _EXT TRADES files. One trade per name per day, the first trigger.
- Signal: a bar CLOSE at or above prev regular close x (1 + X), X in {5, 8} %, at or before
  09:20. Short at the NEXT bar's open (so a bar must exist; empty minutes are not bars).
- Stop: entry x (1 + X / 2), i.e. the move extends by half again; checked on the bar high,
  filled at the worse of the stop and the bar open.
- Exit: E1 = the 09:30 open; E2 = the 10:00 open (the first-half-hour move is included).
  Stop checks continue after 09:30 for E2.
2 x 2 = 4 configurations, short only. Tally 97 + 4 = 101, widened CI 1 - 0.05 / 101 = 99.95 %.

Costs: half the median quoted spread of the entry's 15-minute bucket (night and pre-market
buckets from _BID_ASK_OVN / _EXT, last 8 weeks), half the 09:30 or 10:00 bucket's spread on
exit, commission as before, the extra half-spread on stops. Short borrow and locate are NOT
charged and availability is assumed; these names are often hard to borrow, so the result is
an upper bound. The 30 bps gate: a name-session whose median spread is above 30 bps is
reported but marked "cost too high"; the pooled headline uses only entries that pass the gate
(IREN night + pre-market; AXTI and LITE night only; OKLO none), the all-entries number is
reported beside it.

Inference and pass bar as before: pick by IS Sharpe among the 4, OOS CI, random-side
baseline on the same entries (the fill on a random side is the mirror long). Thin night
volume is a known limit: the report states the median 1-minute volume at the entry bars.

Amendment 2026-11-01 14:50, after the first run: IB's OVERNIGHT and pre-market history
returns a bar for every minute, with volume 0 where nothing traded (63-86 % of night bars).
42 % of the first run's fills landed on such bars, i.e. on no trade at all. The rule "empty
minutes are not bars" above is therefore enforced as: the signal bar and the fill bar must
both have volume > 0. The first run is kept as result_premarket_short_anybar.txt for the
record; the headline is the volume-required run. This is a fill-realism fix, not a tuning,
and it is applied to all 4 configurations alike.

## More tech small caps for the night / pre-market short (added 2026-11-01 15:10 Beijing, after
## the four-name result of that test, before the list was computed)
The user: 按照这个思路去跑其他的科技小盘股. To avoid picking names by hand (hindsight), the list
is produced by a rule written here before it is run:
- Pool: symbols in universe/candidates_raw.csv or candidates.csv (names that made a daily top-10
  gap list at least once) classified COMMON in universe/types.csv.
- Sector: IB contract-details `industry` == "Technology" or "Communications" (fetched by
  classify_tws.py --industry into universe/industry.csv). IB's taxonomy, not ours.
- Activity: days in 2024-10-28..2026-10-30 with open >= prev close x 1.05 while prev close >= 5 USD
  and 20-day dollar volume >= 30 M (EOD data) — the condition the short test fires on, not its
  outcome. At least 15 such days.
- Take the 10 with the most such days, excluding IREN / AXTI / LITE / OKLO. Ties by dollar volume.
Data and rules exactly as in "Short in the night / pre-market session" (volume-required fills,
30 bps gate per name-session, same IS / OOS cut, pooled by day). The 4 configurations are
re-run on the 10 new names alone (the four-name pick is NOT carried over, because it was chosen
on data that includes 2026 and the user's prior is about the rise, not the exit time) and on
the 14 together; the pick is by IS Sharpe on the 10. Tally 101 + 4 = 105, CI 99.95 %.
The spread gate will likely drop names: how many entries survive it is reported.

Addition 2026-11-01 14:25, by the user after the list was shown: RKLB. It is outside the rule
(IB industry Industrial / Aerospace, 23 gap-up days, would rank ~30th), so it is a hand-picked
name like LITE / OKLO: reported on its own line, and in the 15-name pool, with the
hindsight-selection caveat. Same data and rules.

Option data (the user, 14:27: 也要有期权数据): ThetaData oi + greeks_eod for the 11 new names over
the same span, so the wall overlays and the pre-market wall test below can run on them too.

## Pre-market call wall (added 2026-11-01 14:35 Beijing, before any such number was computed)
The user: IREN 就是盘前如果接近期权墙就会被打下来. The call wall is computed exactly as in "Option
walls" (OI stamped 06:30 on day D, gamma and spot from D-1's EOD, 0-30 DTE, +/-25 %, >= 500 OI),
so it is known before the night / pre-market session of D begins (the 06:30 OI stamp is after
the night session starts; the overnight part uses D-1's 06:30 wall, the pre-market part D's).

A. Descriptive test, as in wall test A but in the 20:00-09:29 window: the first bar whose HIGH
   reaches the call wall from below (bar volume > 0). Signed return from the wall level to the
   close 30 bars later (bars with volume > 0 only, so "30 traded minutes"), and to the 09:30
   open; positive = pushed down. Placebo: the same percent distance from D-1's close drawn
   from another day's wall distance (seed 11). Support needs the paired difference's
   block-bootstrap CI (by day) to exclude 0.
B. As a trade, one configuration: in the 20:00-09:20 window, short at the next traded bar's open
   once a bar's high is within 0.5 % below the call wall or at/above it (first time), stop at
   wall x 1.025 (worse of stop and open), cover at the 09:30 open. Costs, gate, fills as in the
   night / pre-market short section. Pass bar as always. Tally 105 + 1 = 106.
Reported for the four names (IREN separately, since the claim is about IREN) and for the 11
new names once their walls exist.

## Changes after the fact
- Option-wall section added, before results, see its heading.
- Universe section added after the two-name result, before universe data, see its heading.
- 2026-10-31, after the two-name and wall results were seen: the user named LITE and OKLO
  (plus AXTI, already in) as further names to test. They are added as a named set with the
  same ORB rules, costs and wall overlays as IREN / AXTI. This is hindsight selection: the
  names are chosen in late 2026 because they have been in play, so a positive result on them
  is weaker evidence than the same number on the pre-registered universe screen, and the
  report says so. Minute bars from 2024-10-31, options oi + greeks_eod over the same span.
- 2026-11-01 12:40 Beijing: the user dropped the whole-market universe test ("不用拉全市场的,要的是
  波动大小盘股"). The universe minute-bar pull was stopped after 72 of 4921 candidate-days; those
  72 days are not used. universe/eod, candidates.csv and types.csv stay on disk for the record.
  The study is now the named set only (IREN, AXTI, LITE, OKLO), so the hindsight-selection
  caveat above applies to the whole result, and there is no pre-registered out-of-sample
  universe to fall back on. Further names, if the user adds any, go into the same log.

## Run log for the new names (2026-11-02 00:09-00:37 Beijing)
All 11 names pulled (TRADES_EXT, TRADES_OVN, BID_ASK_EXT / OVN 9 weeks, ThetaData oi + greeks_eod);
the weeks lost to the 2026-11-01 TWS disconnect were refilled by a second pass that only
re-requested missing weeks and got "no data" for every one left (pre-listing or before the name
traded overnight: SNDK overnight from 2025-08, NVTS from 2025-05, WOLF listed 2025-09-29).
walls.py gained --names / --grid so the wall overlays can run on a name list (no rule change).
premarket_short.py gained --pick X EXIT: the first 14 / 15-name runs let the script re-pick on
the pool's own in-sample (it chose 0.05 / 09:30); the rule above says the pick is the 10-name
one (0.08 / 09:30), so those two runs were redone with --pick 0.08 0 and the re-picked numbers
are reported only as what the script's own search would have chosen.
Runs, exactly as written above: premarket_short on the 10 (--tag _tech), the 11 with RKLB
(_tech11), 14 (_all14) and 15 (_all15); walls on the 11; premarket_wall on the 11 (_tech).
Results in REPORT.md 「新名单」. None passes.

Post hoc, NOT pre-registered (logged here so it is counted): after seeing those results the
four-name ORB pick (grid.csv top row) was replayed unchanged on the 11 new names
(orb_newnames.py → result_orb_newnames.txt), with the usual pooled block-bootstrap
CI. It is a replication, not a search, but it was decided after the fact. Tally 106 + 1 = 107.
