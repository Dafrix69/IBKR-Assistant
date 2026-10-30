"""Mining family `ml`: do machine-learned INTERACTIONS add anything to the single-factor screens?

    .venv/bin/python src/mining/ml.py            # reports/mining/ml_tables/*.csv + summary.json

Feature table = one row per day x entry (13:00, 14:00) x width, ATM put fly held to settlement,
built from winrate_panel + factor_panel + wall_panel_spx/qqq/spy + gex_daily + calendar + regime
labels. Only columns known at the entry minute. Training population for the models is the
BRIEF's main target (width 25/30); the fitted models then score the baseline rows (14:00, width
whose w/implied is nearest 2, skip spx_ret_prev <= -1%) for the increment test.

Discipline: train < 2024-11-01, test >= 2024-11-01; TimeSeriesSplit over DATES (both entries and
all widths of one day fall in the same fold); every cut, threshold, hyper-parameter and feature
ranking comes from the training period only; test numbers are confirmation.

LightGBM installs but cannot load libomp on this Mac, so the GBDT is sklearn's
HistGradientBoostingClassifier (depth <= 3, strong regularisation), as the brief allows.
"""
import itertools
import json
import os
import sys
import warnings

import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import TimeSeriesSplit
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

HERE = os.path.dirname(os.path.abspath(__file__))
R = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(R, "src"))
import fly_grid as Y  # noqa: E402
import winrate_study as S  # noqa: E402

CLEAN = os.path.join(R, "data", "clean")
TABLES = os.path.join(R, "reports", "mining", "ml_tables")
SPLIT = pd.Timestamp("2024-11-01")
SEED = int(S.CFG["edge"]["seed"])
BIG_DOWN = -float(S.CFG["edge"]["prev_ret_big"])
ENTRIES = ["13:00", "14:00"]
TRAIN_WIDTHS = (25, 30)
N_SPLITS = 5
TOP_FEATURES = 10
TOP_PAIRS = 5

warnings.filterwarnings("ignore", category=FutureWarning)
warnings.filterwarnings("ignore", category=RuntimeWarning)


# ----------------------------------------------------------------------------- feature table
def build_table():
    p = pd.read_parquet(os.path.join(CLEAN, "winrate_panel.parquet"))
    p = p[(p.structure == "put_fly") & p.entry.isin(ENTRIES)].copy()
    cal = pd.read_parquet(os.path.join(CLEAN, "calendar.parquet"))
    assert not p.date.isin(cal.index[cal.half_day]).any(), "half days must already be excluded"

    # row level (vary with width)
    p["cost_over_width"] = p.cost / p.width
    p["entry_14"] = (p.entry == "14:00").astype(int)
    row_cols = ["width", "w_over_implied", "cost", "cost_over_width", "dist", "range60_over_implied", "entry_14"]

    # factor_panel: ~40 entry-time features (implied_pts duplicates winrate.implied, dropped)
    f = pd.read_parquet(os.path.join(CLEAN, "factor_panel.parquet")).drop(columns=["implied_pts"])
    f_cols = [c for c in f.columns if c not in ("date", "entry")]
    p = p.merge(f, on=["date", "entry"], how="left")

    # SPX 0DTE OI walls (in implied units). pnl_*/center_* are outcomes -> excluded;
    # vol_*/flow_* exist only from 2024-10-30 (test period) -> excluded.
    w = pd.read_parquet(os.path.join(CLEAN, "wall_panel_spx.parquet"))
    w_cols = ["oi_cw_dist", "oi_pw_dist", "oi_span", "oi_between", "oi_max_dist", "oi_nearest_dist", "oi_pc_ratio_atm"]
    p = p.merge(w[["date", "entry"] + w_cols], on=["date", "entry"], how="left")

    etf_cols = []
    for sym in ("qqq", "spy"):
        e = pd.read_parquet(os.path.join(CLEAN, f"wall_panel_{sym}.parquet")).drop(columns=[f"{sym}_spot"])
        cols = [c for c in e.columns if c not in ("date", "entry")]
        etf_cols += cols
        p = p.merge(e, on=["date", "entry"], how="left")

    # gex_daily (D-1 close OI, known before the open); levels converted to distances in implied units
    g = pd.read_parquet(os.path.join(CLEAN, "gex_daily.parquet"))
    p["gex_iv_atm_med"] = p.date.map(g.iv_atm_med)
    p["gex_oi_0dte_share"] = p.date.map(g.oi_0dte / g.oi_total)
    p["gex_cw_dist"] = (p.date.map(g.call_wall) - p.spot) / p.implied
    p["gex_pw_dist"] = (p.spot - p.date.map(g.put_wall)) / p.implied
    p["gex_zg_dist"] = (p.spot - p.date.map(g.zero_gamma)) / p.implied
    p["gex_above_zg"] = np.where(p.gex_zg_dist.isna(), np.nan, (p.gex_zg_dist > 0).astype(float))
    g_cols = ["gex_iv_atm_med", "gex_oi_0dte_share", "gex_cw_dist", "gex_pw_dist", "gex_zg_dist", "gex_above_zg"]

    # calendar events + previous-day return (vix_prev_close already in factor_panel)
    c_cols = []
    for c in ["fomc", "cpi", "nfp", "pce", "opex", "triple_witching"]:
        p[f"cal_{c}"] = p.date.map(cal[c]).astype(int)
        c_cols.append(f"cal_{c}")
    p["spx_ret_prev"] = p.date.map(cal.spx_ret_prev)
    c_cols.append("spx_ret_prev")

    # regime labels by DATE (edge_labels has no 13:00 row; gamma side is recomputed above)
    lab = Y.regime_labels().drop_duplicates("date").set_index("date")
    p["vix_t"] = p.date.map(lab.vix_t.map({"low": 0, "mid": 1, "high": 2}))
    wd = p.date.dt.day_of_week
    r_cols = ["vix_t"]
    for i, name in enumerate(["mon", "tue", "wed", "thu"]):
        p[f"wd_{name}"] = (wd == i).astype(int)
        r_cols.append(f"wd_{name}")

    feats = row_cols + f_cols + w_cols + etf_cols + g_cols + c_cols + r_cols
    assert len(set(feats)) == len(feats)
    p["period"] = np.where(p.date >= SPLIT, "test", "train")
    p["year"] = p.date.dt.year
    p = p.sort_values(["date", "entry", "width"]).reset_index(drop=True)
    return p, feats


def baseline_rows(p):
    """BRIEF rule 5: 14:00, width nearest w/implied = 2 (one per day), skip spx_ret_prev <= -1%."""
    g = p[p.entry == "14:00"]
    pick = g.assign(err=(g.w_over_implied - 2.0).abs()).sort_values(["date", "err"]).groupby("date").head(1)
    return pick[~(pick.spx_ret_prev <= BIG_DOWN)].copy()


# ----------------------------------------------------------------------------- models
def make_lr(C):
    return make_pipeline(SimpleImputer(strategy="median"), StandardScaler(),
                         LogisticRegression(l1_ratio=1.0, C=C, solver="liblinear", max_iter=2000, random_state=SEED))


def make_gbdt(depth, max_iter, min_leaf, l2):
    return HistGradientBoostingClassifier(max_depth=depth, max_iter=max_iter, learning_rate=0.03, min_samples_leaf=min_leaf,
                                          l2_regularization=l2, max_bins=64, random_state=SEED)


LR_GRID = [0.01, 0.03, 0.1, 0.3, 1.0]
GB_GRID = list(itertools.product([100, 300], [30, 60], [1.0, 10.0]))  # max_iter, min_samples_leaf, l2


def model_specs():
    specs = {"lr1_w_over_implied": [("single", None)]}
    specs["lr_l1"] = [("lr", C) for C in LR_GRID]
    specs["gbdt_depth1"] = [("gb1", g) for g in GB_GRID]
    specs["gbdt_depth3"] = [("gb3", g) for g in GB_GRID]
    return specs


def build(kind, hp):
    if kind == "single":
        return make_pipeline(SimpleImputer(strategy="median"), LogisticRegression(C=1e6, max_iter=1000))
    if kind == "lr":
        return make_lr(hp)
    depth = 1 if kind == "gb1" else 3
    return make_gbdt(depth, *hp)


def feature_cols(kind, feats):
    return ["w_over_implied"] if kind == "single" else feats


def date_folds(dates):
    u = np.array(sorted(dates.unique()))
    for tr, va in TimeSeriesSplit(n_splits=N_SPLITS).split(u):
        yield u[tr], u[va]


def cv_select(train_pop, train_all, feats):
    """For every model family pick the hyper-parameter with the best mean fold AUC (training only);
    return per-family CV table, chosen spec and out-of-fold scores on ALL training rows of the
    validation dates (every width, so the baseline rows get OOF scores too)."""
    rows, chosen, oof = [], {}, {}
    folds = list(date_folds(train_pop.date))
    for fam, cands in model_specs().items():
        best = None
        for kind, hp in cands:
            cols = feature_cols(kind, feats)
            aucs, scores = [], pd.Series(np.nan, index=train_all.index)
            for trd, vad in folds:
                tr = train_pop[train_pop.date.isin(trd)]
                va_pop = train_pop[train_pop.date.isin(vad)]
                va_all = train_all[train_all.date.isin(vad)]
                m = build(kind, hp).fit(tr[cols], tr.win)
                s_all = m.predict_proba(va_all[cols])[:, 1]
                scores.loc[va_all.index] = s_all
                aucs.append(roc_auc_score(va_pop.win, scores.loc[va_pop.index]))
            pooled = roc_auc_score(train_pop.win[scores.loc[train_pop.index].notna()],
                                   scores.loc[train_pop.index].dropna())
            rec = {"family": fam, "kind": kind, "hp": str(hp), "cv_auc_mean": np.mean(aucs), "cv_auc_sd": np.std(aucs),
                   "cv_auc_pooled_oof": pooled, **{f"fold{i + 1}": a for i, a in enumerate(aucs)}}
            rows.append(rec)
            if best is None or rec["cv_auc_mean"] > best[0]["cv_auc_mean"]:
                best = (rec, kind, hp, scores)
        chosen[fam] = (best[1], best[2])
        oof[fam] = best[3]
    return pd.DataFrame(rows), chosen, pd.DataFrame(oof)


def fit_final(chosen, train_pop, feats):
    return {fam: build(kind, hp).fit(train_pop[feature_cols(kind, feats)], train_pop.win) for fam, (kind, hp) in chosen.items()}


# ----------------------------------------------------------------------------- importance / interactions
def permutation_importance_cv(train_pop, feats, kind, hp, n_repeats=5):
    """Permutation importance (AUC drop) measured on the validation dates of each training fold."""
    rng = np.random.default_rng(SEED)
    drops = {f: [] for f in feats}
    for trd, vad in date_folds(train_pop.date):
        tr, va = train_pop[train_pop.date.isin(trd)], train_pop[train_pop.date.isin(vad)]
        m = build(kind, hp).fit(tr[feats], tr.win)
        base = roc_auc_score(va.win, m.predict_proba(va[feats])[:, 1])
        for f in feats:
            for _ in range(n_repeats):
                x = va[feats].copy()
                x[f] = rng.permutation(x[f].values)
                drops[f].append(base - roc_auc_score(va.win, m.predict_proba(x)[:, 1]))
    return pd.Series({f: np.mean(v) for f, v in drops.items()}).sort_values(ascending=False)


def permutation_importance_fixed(model, X, y, feats, n_repeats=10):
    rng = np.random.default_rng(SEED)
    base = roc_auc_score(y, model.predict_proba(X[feats])[:, 1])
    out = {}
    for f in feats:
        d = []
        for _ in range(n_repeats):
            x = X[feats].copy()
            x[f] = rng.permutation(x[f].values)
            d.append(base - roc_auc_score(y, model.predict_proba(x)[:, 1]))
        out[f] = np.mean(d)
    return pd.Series(out).sort_values(ascending=False)


def grid_for(x, n=10):
    q = np.quantile(x.dropna(), np.linspace(0.05, 0.95, n))
    return np.unique(q)


def pd_1d(model, X, feats, f, grid):
    """Partial dependence on the logit scale, brute force over the sample X."""
    out = []
    for v in grid:
        x = X[feats].copy()
        x[f] = v
        out.append(model.decision_function(x).mean())
    return np.array(out)


def pd_2d(model, X, feats, f1, g1, f2, g2):
    out = np.zeros((len(g1), len(g2)))
    for i, a in enumerate(g1):
        for j, b in enumerate(g2):
            x = X[feats].copy()
            x[f1] = a
            x[f2] = b
            out[i, j] = model.decision_function(x).mean()
    return out


def h_statistics(model, X, feats, top, n_sample=500):
    """Friedman H^2 for every pair among `top`, on the training sample X (logit scale)."""
    rng = np.random.default_rng(SEED)
    Xs = X.iloc[rng.choice(len(X), size=min(n_sample, len(X)), replace=False)]
    grids = {f: grid_for(X[f]) for f in top}
    pd1 = {f: pd_1d(model, Xs, feats, f, grids[f]) for f in top}
    pd1 = {f: v - v.mean() for f, v in pd1.items()}
    rows, surfaces = [], {}
    for f1, f2 in itertools.combinations(top, 2):
        s = pd_2d(model, Xs, feats, f1, grids[f1], f2, grids[f2])
        s = s - s.mean()
        add = pd1[f1][:, None] + pd1[f2][None, :]
        denom = (s ** 2).sum()
        rng2 = s.max() - s.min()
        # a pair the final model never splits on has a flat surface: H^2 is 0/0, reported as NaN, ranked last
        h2 = ((s - add) ** 2).sum() / denom if rng2 > 1e-6 else np.nan
        rows.append({"f1": f1, "f2": f2, "H2": h2, "range_2d_logit": rng2,
                     "range_interaction_logit": (s - add).max() - (s - add).min()})
        surfaces[(f1, f2)] = (grids[f1], grids[f2], s, s - add)
    return pd.DataFrame(rows).sort_values("H2", ascending=False, na_position="last").reset_index(drop=True), surfaces, grids, pd1


# ----------------------------------------------------------------------------- evaluation tables
def st(g):
    """stats() by day: the baseline is one trade per day already; other populations have several
    rows per day, so n here counts rows and n_days counts days (intervals are honest only on days)."""
    s = S.stats(g)
    s["n_days"] = g.date.nunique()
    return s


def quintile_table(scores_train, y_train_df, scores_test, test_df, label):
    cuts = np.quantile(scores_train.dropna(), [0.2, 0.4, 0.6, 0.8])
    rows = []
    for per, sc, df in (("train(OOF)", scores_train, y_train_df), ("test", scores_test, test_df)):
        # searchsorted instead of pd.cut: a degenerate (near-constant) score may repeat cut values
        q = pd.Series(np.array(["Q1", "Q2", "Q3", "Q4", "Q5"])[np.searchsorted(cuts, sc.values, side="right")], index=sc.index)
        for k, g in df.groupby(q, observed=True):
            s = st(g)
            rows.append({"model": label, "period": per, "quintile": k, "n": int(s.n), "n_days": int(s.n_days), "win": s.win,
                         "win_lo": s.win_lo, "win_hi": s.win_hi, "ev": s.ev, "ev_k05": s.ev_k05, "pred_mean": float(sc[q == k].mean())})
    return pd.DataFrame(rows), cuts


def increment(base_tr, base_te, mask_tr, mask_te, name):
    """BRIEF rule 5: baseline vs baseline restricted by a mask, both periods."""
    out = {"rule": name}
    for per, b, m in (("train", base_tr, mask_tr), ("test", base_te, mask_te)):
        s0, s1 = st(b), st(b[m]) if m.sum() else None
        out[f"{per}_n_base"] = int(s0.n)
        out[f"{per}_win_base"] = s0.win
        out[f"{per}_ev_base"] = s0.ev
        out[f"{per}_n_rule"] = int(m.sum())
        if s1 is not None:
            out[f"{per}_win_rule"], out[f"{per}_win_lo"], out[f"{per}_win_hi"], out[f"{per}_ev_rule"] = s1.win, s1.win_lo, s1.win_hi, s1.ev
            out[f"{per}_delta_win"] = s1.win - s0.win
            out[f"{per}_delta_ev"] = s1.ev - s0.ev
        else:
            for k in ("win_rule", "win_lo", "win_hi", "ev_rule", "delta_win", "delta_ev"):
                out[f"{per}_{k}"] = np.nan
    out["passes"] = bool(np.sign(out["train_delta_win"]) == np.sign(out["test_delta_win"]) and out["test_delta_win"] >= 0.03
                         and out["train_n_rule"] >= 30 and out["test_n_rule"] >= 30)
    return out


def univariate_screen(train_pop, test_pop, feats):
    rows = []
    for f in feats:
        x = train_pop[f]
        if x.nunique() < 5:
            continue
        cuts = np.unique(np.quantile(x.dropna(), [0.2, 0.4, 0.6, 0.8]))
        rec = {"feature": f}
        for per, d in (("train", train_pop), ("test", test_pop)):
            q = pd.Series(np.searchsorted(cuts, d[f].values, side="right"), index=d.index).where(d[f].notna())
            g = d.groupby(q, observed=True).win.mean()
            rec[f"{per}_Q1"], rec[f"{per}_Q5"] = g.get(0, np.nan), g.get(len(cuts), np.nan)
            rec[f"{per}_gap"] = rec[f"{per}_Q5"] - rec[f"{per}_Q1"]
            ok = d[f].notna()
            rec[f"{per}_spearman"] = spearmanr(d[f][ok], d.win[ok]).statistic if ok.sum() > 10 else np.nan
        rec["holds"] = bool(np.sign(rec["train_gap"]) == np.sign(rec["test_gap"]) and min(abs(rec["train_gap"]), abs(rec["test_gap"])) >= 0.05)
        rows.append(rec)
    return pd.DataFrame(rows)


def main():
    os.makedirs(TABLES, exist_ok=True)
    p, feats = build_table()
    train_all, test_all = p[p.period == "train"], p[p.period == "test"]
    train_pop = train_all[train_all.width.isin(TRAIN_WIDTHS)]
    test_pop = test_all[test_all.width.isin(TRAIN_WIDTHS)]
    base = baseline_rows(p)
    base_tr, base_te = base[base.period == "train"], base[base.period == "test"]
    summary = {"n_features": len(feats), "features": feats,
               "train_rows": len(train_pop), "train_days": int(train_pop.date.nunique()), "train_win": float(train_pop.win.mean()),
               "test_rows": len(test_pop), "test_days": int(test_pop.date.nunique()), "test_win": float(test_pop.win.mean()),
               "baseline_train": st(base_tr).to_dict(), "baseline_test": st(base_te).to_dict(),
               "baseline_width_share_test": base_te.width.value_counts(normalize=True).to_dict()}
    pd.DataFrame({"feature": feats, "train_nan_share": train_pop[feats].isna().mean().values,
                  "test_nan_share": test_pop[feats].isna().mean().values}).to_csv(os.path.join(TABLES, "features.csv"), index=False)

    # (0) univariate screen of every input, for context
    uni = univariate_screen(train_pop, test_pop, feats)
    uni.round(4).to_csv(os.path.join(TABLES, "univariate_screen.csv"), index=False)
    summary["univariate_tested"] = len(uni)
    summary["univariate_holds"] = uni[uni.holds].feature.tolist()

    # (1) CV model selection on training dates
    cv, chosen, oof = cv_select(train_pop, train_all, feats)
    cv.round(4).to_csv(os.path.join(TABLES, "cv_auc.csv"), index=False)
    print(cv.round(4).to_string())
    summary["chosen"] = {k: [v[0], str(v[1])] for k, v in chosen.items()}

    # (2) final fits on the whole training period, AUC on the test period
    models = fit_final(chosen, train_pop, feats)
    auc_rows = []
    for fam, m in models.items():
        cols = feature_cols(chosen[fam][0], feats)
        s_te = m.predict_proba(test_pop[cols])[:, 1]
        s_tr_in = m.predict_proba(train_pop[cols])[:, 1]
        o = oof[fam].loc[train_pop.index]
        best = cv[cv.family == fam].sort_values("cv_auc_mean").iloc[-1]
        auc_rows.append({"family": fam, "hp": str(chosen[fam][1]), "cv_auc_mean": best.cv_auc_mean, "cv_auc_sd": best.cv_auc_sd,
                         "train_oof_auc": roc_auc_score(train_pop.win[o.notna()], o.dropna()),
                         "train_insample_auc": roc_auc_score(train_pop.win, s_tr_in),
                         "test_auc": roc_auc_score(test_pop.win, s_te),
                         "test_auc_14": roc_auc_score(test_pop.win[test_pop.entry == "14:00"], s_te[(test_pop.entry == "14:00").values]),
                         "test_auc_13": roc_auc_score(test_pop.win[test_pop.entry == "13:00"], s_te[(test_pop.entry == "13:00").values]),
                         "test_auc_baseline_rows": roc_auc_score(base_te.win, m.predict_proba(base_te[cols])[:, 1])})
    auc = pd.DataFrame(auc_rows)
    auc.round(4).to_csv(os.path.join(TABLES, "auc_summary.csv"), index=False)
    summary["auc"] = auc.set_index("family").round(4).to_dict("index")

    # L1 logistic: surviving coefficients
    lr = models["lr_l1"]
    coef = pd.Series(lr[-1].coef_[0], index=feats)
    coef[coef != 0].sort_values(key=abs, ascending=False).round(4).to_csv(os.path.join(TABLES, "lr_l1_coefficients.csv"), header=["coef_std"], index_label="feature")
    summary["lr_l1_nonzero"] = int((coef != 0).sum())

    # (3) importance (training folds) + confirmation on test; interactions via H^2 on training
    kind3, hp3 = chosen["gbdt_depth3"]
    imp_cv = permutation_importance_cv(train_pop, feats, kind3, hp3)
    imp_te = permutation_importance_fixed(models["gbdt_depth3"], test_pop, test_pop.win, feats)
    imp = pd.DataFrame({"perm_auc_drop_train_cv": imp_cv, "perm_auc_drop_test": imp_te.reindex(imp_cv.index)})
    imp["rank_train"] = np.arange(1, len(imp) + 1)
    imp["rank_test"] = imp.perm_auc_drop_test.rank(ascending=False).astype(int)
    imp.round(5).to_csv(os.path.join(TABLES, "permutation_importance.csv"))
    top = imp.index[:TOP_FEATURES].tolist()
    summary["top_features_train"] = top
    summary["top_features_test"] = imp.sort_values("perm_auc_drop_test", ascending=False).index[:TOP_FEATURES].tolist()

    gb3 = models["gbdt_depth3"]
    hstat, surfaces, grids, pd1 = h_statistics(gb3, train_pop, feats, top)
    hstat.round(4).to_csv(os.path.join(TABLES, "interaction_h2.csv"), index=False)
    pd.DataFrame({f: pd.Series(pd1[f], index=np.round(grids[f], 4)) for f in top}).stack().rename("pd_logit_centered") \
        .rename_axis(["grid_value", "feature"]).reset_index()[["feature", "grid_value", "pd_logit_centered"]].round(4) \
        .to_csv(os.path.join(TABLES, "partial_dependence_1d.csv"), index=False)
    pairs = [(r.f1, r.f2) for r in hstat.head(TOP_PAIRS).itertuples()]
    summary["top_pairs_train"] = [{"f1": a, "f2": b, "H2": float(hstat.H2.iloc[i])} for i, (a, b) in enumerate(pairs)]
    surf_rows = []
    for (f1, f2) in pairs:
        g1, g2, s, inter = surfaces[(f1, f2)]
        for i, a in enumerate(g1):
            for j, b in enumerate(g2):
                surf_rows.append({"f1": f1, "f2": f2, "v1": a, "v2": b, "pd2d_logit": s[i, j], "interaction_logit": inter[i, j]})
    pd.DataFrame(surf_rows).round(4).to_csv(os.path.join(TABLES, "partial_dependence_2d_top_pairs.csv"), index=False)
    # same H^2 on the test period, confirmation only
    hstat_te, *_ = h_statistics(gb3, test_pop, feats, top)
    hstat.merge(hstat_te, on=["f1", "f2"], suffixes=("_train", "_test")).round(4).to_csv(os.path.join(TABLES, "interaction_h2_train_vs_test.csv"), index=False)

    # (4) quintiles of predicted probability on the BASELINE rows; cuts from training OOF
    qrows, inc_rows = [], []
    for fam, m in models.items():
        cols = feature_cols(chosen[fam][0], feats)
        s_tr = oof[fam].loc[base_tr.index]
        ok = s_tr.notna()
        s_te = pd.Series(m.predict_proba(base_te[cols])[:, 1], index=base_te.index)
        qt, cuts = quintile_table(s_tr[ok], base_tr[ok], s_te, base_te, fam)
        qrows.append(qt)
        for q_name, lo in (("Q5", cuts[3]), ("Q4+Q5", cuts[2])):
            inc_rows.append(increment(base_tr[ok], base_te, s_tr[ok] >= lo, s_te >= lo, f"{fam} {q_name} (train-OOF cut {lo:.3f})"))
        inc_rows.append(increment(base_tr[ok], base_te, s_tr[ok] < cuts[0], s_te < cuts[0], f"{fam} Q1 only (train-OOF cut {cuts[0]:.3f})"))
    q_all = pd.concat(qrows)
    q_all.round(4).to_csv(os.path.join(TABLES, "quintiles_baseline_rows.csv"), index=False)
    pd.DataFrame(inc_rows).round(4).to_csv(os.path.join(TABLES, "increment_model_scores.csv"), index=False)
    mono = {}
    for (fam, per), g in q_all.groupby(["model", "period"]):
        w = g.sort_values("quintile").win.values
        mono[f"{fam}|{per}"] = {"win_by_quintile": [round(float(x), 4) for x in w], "monotone": bool(np.all(np.diff(w) >= 0)),
                                "Q5_minus_Q1": round(float(w[-1] - w[0]), 4)}
    summary["quintiles"] = mono

    # same quintile view on the whole 13:00/14:00 width-25/30 population (rows, several per day)
    qrows2 = []
    for fam, m in models.items():
        cols = feature_cols(chosen[fam][0], feats)
        s_tr = oof[fam].loc[train_pop.index]
        ok = s_tr.notna()
        s_te = pd.Series(m.predict_proba(test_pop[cols])[:, 1], index=test_pop.index)
        qt, _ = quintile_table(s_tr[ok], train_pop[ok], s_te, test_pop, fam)
        qrows2.append(qt)
    pd.concat(qrows2).round(4).to_csv(os.path.join(TABLES, "quintiles_width25_30_rows.csv"), index=False)

    # (5) rules from the top interactions: median and tercile thresholds, 4 sign combinations each
    thr = {f: {"med": float(train_pop[f].median()), "t1": float(train_pop[f].quantile(1 / 3)), "t2": float(train_pop[f].quantile(2 / 3))} for f in top}
    rule_rows, rule_defs = [], []
    for f1, f2 in pairs:
        for scheme in ("med", "ter"):
            for s1, s2 in itertools.product(("high", "low"), repeat=2):
                def side(f, s):
                    if scheme == "med":
                        return (f">=", thr[f]["med"]) if s == "high" else (f"<", thr[f]["med"])
                    return (f">=", thr[f]["t2"]) if s == "high" else (f"<=", thr[f]["t1"])
                o1, v1 = side(f1, s1)
                o2, v2 = side(f2, s2)
                name = f"{f1} {o1} {v1:.4g} & {f2} {o2} {v2:.4g}"

                def mask(d, f1=f1, f2=f2, o1=o1, v1=v1, o2=o2, v2=v2):  # bind now: the closures are reused after the loop
                    a = d[f1] >= v1 if o1 == ">=" else (d[f1] < v1 if o1 == "<" else d[f1] <= v1)
                    b = d[f2] >= v2 if o2 == ">=" else (d[f2] < v2 if o2 == "<" else d[f2] <= v2)
                    return (a & b).fillna(False)
                rec = increment(base_tr, base_te, mask(base_tr), mask(base_te), name)
                rec.update({"f1": f1, "f2": f2, "scheme": scheme, "side1": s1, "side2": s2})
                rule_rows.append(rec)
                rule_defs.append((name, mask))
    rules = pd.DataFrame(rule_rows)
    rules.round(4).to_csv(os.path.join(TABLES, "rules_increment.csv"), index=False)
    passing = rules[rules.passes]
    summary["rules_tested"] = len(rules)
    summary["rules_passing"] = passing.rule.tolist()

    # control for w/implied (training terciles) and per-year table for every passing rule
    wcuts = train_pop.w_over_implied.quantile([1 / 3, 2 / 3]).values
    ctl_rows, yr_rows = [], []
    for name, mask in rule_defs:
        if name not in set(passing.rule):
            continue
        for per, d in (("train", base_tr), ("test", base_te)):
            wt = pd.cut(d.w_over_implied, [-np.inf, *wcuts, np.inf], labels=["w/impl T1", "w/impl T2", "w/impl T3"])
            m = mask(d)
            for t, g in d.groupby(wt, observed=True):
                a, b = g[m.loc[g.index]], g[~m.loc[g.index]]
                ctl_rows.append({"rule": name, "period": per, "w_tercile": t, "n_in": len(a), "win_in": a.win.mean() if len(a) else np.nan,
                                 "ev_in": a.pnl.mean() if len(a) else np.nan, "n_out": len(b), "win_out": b.win.mean() if len(b) else np.nan,
                                 "ev_out": b.pnl.mean() if len(b) else np.nan})
        m_all = mask(base)
        for y, g in base.groupby("year"):
            a, b = g[m_all.loc[g.index]], g[~m_all.loc[g.index]]
            yr_rows.append({"rule": name, "year": y, "n_in": len(a), "win_in": a.win.mean() if len(a) else np.nan, "ev_in": a.pnl.mean() if len(a) else np.nan,
                            "n_out": len(b), "win_out": b.win.mean() if len(b) else np.nan, "ev_out": b.pnl.mean() if len(b) else np.nan})
    pd.DataFrame(ctl_rows).round(4).to_csv(os.path.join(TABLES, "rules_control_w_over_implied.csv"), index=False)
    pd.DataFrame(yr_rows).round(4).to_csv(os.path.join(TABLES, "rules_by_year.csv"), index=False)

    # model-score Q5 overlay: control + per-year as well
    ctl2, yr2 = [], []
    for fam, m in models.items():
        cols = feature_cols(chosen[fam][0], feats)
        s_tr = oof[fam].loc[base_tr.index]
        cut = np.quantile(s_tr.dropna(), 0.8)
        s_all = pd.Series(np.nan, index=base.index)
        s_all.loc[base_tr.index] = s_tr
        s_all.loc[base_te.index] = m.predict_proba(base_te[cols])[:, 1]
        for per, d in (("train(OOF)", base_tr), ("test", base_te)):
            wt = pd.cut(d.w_over_implied, [-np.inf, *wcuts, np.inf], labels=["w/impl T1", "w/impl T2", "w/impl T3"])
            hi = s_all.loc[d.index] >= cut
            for t, g in d.groupby(wt, observed=True):
                a, b = g[hi.loc[g.index]], g[~hi.loc[g.index] & s_all.loc[g.index].notna()]
                ctl2.append({"model": fam, "period": per, "w_tercile": t, "n_Q5": len(a), "win_Q5": a.win.mean() if len(a) else np.nan,
                             "ev_Q5": a.pnl.mean() if len(a) else np.nan, "n_rest": len(b), "win_rest": b.win.mean() if len(b) else np.nan,
                             "ev_rest": b.pnl.mean() if len(b) else np.nan})
        hi_all = s_all >= cut
        for y, g in base.groupby("year"):
            a, b = g[hi_all.loc[g.index]], g[~hi_all.loc[g.index] & s_all.loc[g.index].notna()]
            yr2.append({"model": fam, "year": y, "n_Q5": len(a), "win_Q5": a.win.mean() if len(a) else np.nan, "ev_Q5": a.pnl.mean() if len(a) else np.nan,
                        "n_rest": len(b), "win_rest": b.win.mean() if len(b) else np.nan, "ev_rest": b.pnl.mean() if len(b) else np.nan})
    pd.DataFrame(ctl2).round(4).to_csv(os.path.join(TABLES, "model_q5_control_w_over_implied.csv"), index=False)
    pd.DataFrame(yr2).round(4).to_csv(os.path.join(TABLES, "model_q5_by_year.csv"), index=False)

    # multiple-comparison ledger
    n_hp = sum(len(v) for v in model_specs().values())
    ledger = {"model_families": len(model_specs()), "hyperparameter_fits": n_hp, "univariate_features_screened": int(len(uni)),
              "pairs_ranked_by_H2": int(len(hstat)), "rules_tested": int(len(rules)), "model_score_overlays_tested": len(inc_rows),
              "tests_judged_at_5pct": int(len(uni) + len(rules) + len(inc_rows)),
              "expected_false_positives_5pct": round(0.05 * (len(uni) + len(rules) + len(inc_rows)), 1)}
    summary["ledger"] = ledger
    with open(os.path.join(TABLES, "summary.json"), "w") as fh:
        json.dump(summary, fh, indent=1, default=float, ensure_ascii=False)
    print(json.dumps({k: v for k, v in summary.items() if k != "features"}, indent=1, default=float, ensure_ascii=False))


if __name__ == "__main__":
    main()
