#include "analysis/backtest_lab.h"

#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/py.h"

#include <QSet>
#include <QStringList>

#include <algorithm>
#include <cmath>
#include <limits>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace jm = ibkr::util::jsmath;
namespace bt = ibkr::analysis::backtest;

namespace ibkr::analysis::backtest_lab {

namespace {
constexpr double kInf = std::numeric_limits<double>::infinity();
/// 不满这么多天的段,年化是外推出来的:"年化"的单位就是一年
constexpr double kYearDays = 365;

QString n2s(double v) { return util::jsNumberToString(v); }
OJson optN(const std::optional<double>& v) { return v ? js::N(*v) : OJson::null(); }
std::optional<double> optOf(const OJson* v) { return v && v->type == OJson::Number ? std::optional(v->n) : std::nullopt; }
double numOf(const OJson& o, const QString& k) { return js::num(o.get(k)); }
}  // namespace

QList<OJson> gridCombos(const OJson& grid) {
    QList<OJson> out{js::object()};
    for (const auto& [key, values] : grid.fields) {
        QList<OJson> next;
        for (const OJson& combo : out)
            for (const OJson& v : values.items) {
                OJson c = combo;
                c.set(key, v);
                next.append(c);
            }
        out = next;
    }
    return out;
}

std::vector<SymbolBars> alignSeries(const std::vector<SymbolBars>& series) {
    if (series.size() <= 1) return series;
    // new Set(first 的日期):插入序,重复的只留第一次
    QStringList first;
    QSet<QString> seen;
    for (const bt::Bar& b : series[0].bars)
        if (!seen.contains(b.date)) {
            seen.insert(b.date);
            first << b.date;
        }
    std::vector<QSet<QString>> rest;
    for (size_t i = 1; i < series.size(); ++i) {
        QSet<QString> s;
        for (const bt::Bar& b : series[i].bars) s.insert(b.date);
        rest.push_back(s);
    }
    QSet<QString> common;
    for (const QString& d : first)
        if (std::all_of(rest.begin(), rest.end(), [&](const QSet<QString>& s) { return s.contains(d); })) common.insert(d);
    std::vector<SymbolBars> out;
    for (const SymbolBars& s : series) {
        SymbolBars f{s.symbol, {}};
        for (const bt::Bar& b : s.bars)
            if (common.contains(b.date)) f.bars.push_back(b);
        out.push_back(f);
    }
    return out;
}

namespace {
struct Stats {
    double days = 0, ret = 0, ann = 0, mdd = 0;
    std::optional<double> calmar;
    double rod = 0;
    bool floored = false, under = false;
    std::optional<double> sharpe;
    double trades = 0;
    std::optional<double> win;
    double bench = 0, excess = 0;
    OJson toJson() const {
        return js::object({
            {u"days"_s, js::N(days)},
            {u"return_pct"_s, js::N(ret)},
            {u"annualized_pct"_s, js::N(ann)},
            {u"max_drawdown_pct"_s, js::N(mdd)},
            {u"calmar"_s, optN(calmar)},
            {u"return_over_dd"_s, js::N(rod)},
            {u"dd_floored"_s, js::B(floored)},
            {u"dd_under_one_day"_s, js::B(under)},
            {u"sharpe"_s, optN(sharpe)},
            {u"trades"_s, js::N(trades)},
            {u"win_rate_pct"_s, optN(win)},
            {u"bench_return_pct"_s, js::N(bench)},
            {u"excess_return_pct"_s, js::N(excess)},
        });
    }
};

Stats statsOf(const OJson& r) {
    const double dd = std::abs(numOf(r, u"max_drawdown_pct"_s));
    const double day = optOf(r.get(u"held_day_move_pct"_s)).value_or(0);
    // 回撤下限:在场时的单日波动 × √在场天数
    const double floor = day * std::sqrt(numOf(r, u"held_days"_s));
    const double risk = jm::max(dd, floor);
    Stats s;
    s.days = numOf(r, u"days"_s);
    s.ret = numOf(r, u"total_return_pct"_s);
    s.ann = numOf(r, u"annualized_pct"_s);
    s.mdd = numOf(r, u"max_drawdown_pct"_s);
    if (dd > 0) s.calmar = util::pyRound(s.ann / dd, 2);
    // 一直空仓:收益 0、回撤 0、没有持仓日 → 0
    s.rod = risk > 0 ? util::pyRound(s.ret / risk, 4) : 0;
    s.floored = floor > dd;
    s.under = day > dd;
    s.sharpe = optOf(r.get(u"sharpe"_s));
    s.trades = numOf(r, u"trades"_s);
    s.win = optOf(r.get(u"win_rate_pct"_s));
    s.bench = numOf(r, u"buy_hold_return_pct"_s);
    s.excess = numOf(r, u"excess_return_pct"_s);
    return s;
}

double mean(const std::vector<double>& xs) {
    if (xs.empty()) return 0;
    double a = 0;
    for (double x : xs) a += x;
    return a / double(xs.size());
}

std::optional<double> median(const std::vector<double>& xs) {
    if (xs.empty()) return std::nullopt;
    std::vector<double> s = xs;
    std::stable_sort(s.begin(), s.end());
    const size_t mid = s.size() / 2;
    return s.size() % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/// 几只标的同一段的成绩取平均。笔数是合计,胜率按有已平仓交易的那些平均
Stats averageStats(const std::vector<Stats>& list) {
    std::vector<double> calmars, sharpes, wins, rets, benches, anns, mdds, rods;
    for (const Stats& s : list) {
        if (s.calmar) calmars.push_back(*s.calmar);
        if (s.sharpe) sharpes.push_back(*s.sharpe);
        if (s.win) wins.push_back(*s.win);
        rets.push_back(s.ret);
        benches.push_back(s.bench);
        anns.push_back(s.ann);
        mdds.push_back(s.mdd);
        rods.push_back(s.rod);
    }
    Stats o;
    o.ret = util::pyRound(mean(rets), 2);
    o.bench = util::pyRound(mean(benches), 2);
    o.days = list.empty() ? 0 : list[0].days;
    o.ann = util::pyRound(mean(anns), 2);
    o.mdd = util::pyRound(mean(mdds), 2);
    if (calmars.size() == list.size() && !list.empty()) o.calmar = util::pyRound(mean(calmars), 2);
    o.rod = util::pyRound(mean(rods), 4);
    o.floored = std::any_of(list.begin(), list.end(), [](const Stats& s) { return s.floored; });
    o.under = std::any_of(list.begin(), list.end(), [](const Stats& s) { return s.under; });
    if (sharpes.size() == list.size() && !list.empty()) o.sharpe = util::pyRound(mean(sharpes), 2);
    double trades = 0;
    for (const Stats& s : list) trades += s.trades;
    o.trades = trades;
    if (!wins.empty()) o.win = util::pyRound(mean(wins), 1);
    o.excess = util::pyRound(o.ret - o.bench, 2);
    return o;
}

double scoreOfStats(const Stats& s, const QString& objective) { return objective == u"return" ? s.ret : s.rod; }

/// 秩,同分取平均秩
std::vector<double> ranks(const std::vector<double>& xs) {
    std::vector<size_t> idx(xs.size());
    for (size_t i = 0; i < xs.size(); ++i) idx[i] = i;
    std::stable_sort(idx.begin(), idx.end(), [&](size_t a, size_t b) { return xs[a] < xs[b]; });
    std::vector<double> out(xs.size(), 0);
    size_t k = 0;
    while (k < idx.size()) {
        size_t j = k;
        while (j + 1 < idx.size() && xs[idx[j + 1]] == xs[idx[k]]) j += 1;
        const double r = double(k + j) / 2 + 1;
        for (size_t t = k; t <= j; ++t) out[idx[t]] = r;
        k = j + 1;
    }
    return out;
}

struct Centred {
    std::vector<double> ra, rb;
    double da, db;
};
/// 两列数各自的秩减去均值;样本不到 3 个、长度不等或一边全是同一个数时是空
std::optional<Centred> centredRanks(const std::vector<double>& a, const std::vector<double>& b) {
    if (a.size() != b.size() || a.size() < 3) return std::nullopt;
    const auto centre = [](const std::vector<double>& xs) {
        std::vector<double> r = ranks(xs);
        const double m = mean(r);
        for (double& v : r) v = v - m;
        return r;
    };
    Centred c{centre(a), centre(b), 0, 0};
    for (double v : c.ra) c.da = c.da + v * v;
    for (double v : c.rb) c.db = c.db + v * v;
    if (c.da == 0 || c.db == 0) return std::nullopt;
    return c;
}

double dot(const std::vector<double>& a, const std::vector<double>& b) {
    double acc = 0;
    for (size_t i = 0; i < a.size(); ++i) acc += a[i] * b[i];
    return acc;
}

/// mulberry32(Math.imul 是 32 位乘法回绕;JS 的 ^ / >>> 都按 32 位)
struct Mulberry32 {
    quint32 state;
    double operator()() {
        state = state + 0x6d2b79f5u;
        quint32 t = state;
        t = (t ^ (t >> 15)) * (t | 1u);
        t ^= t + (t ^ (t >> 7)) * (t | 61u);
        return double(t ^ (t >> 14)) / 4294967296.0;
    }
};
}  // namespace

double scoreOf(const OJson& stats, const QString& objective) {
    return objective == u"return" ? numOf(stats, u"return_pct"_s) : numOf(stats, u"return_over_dd"_s);
}

std::optional<double> spearman(const std::vector<double>& a, const std::vector<double>& b) {
    const auto c = centredRanks(a, b);
    if (!c) return std::nullopt;
    return util::pyRound(dot(c->ra, c->rb) / std::sqrt(c->da * c->db), 2);
}

std::optional<double> spearmanP(const std::vector<double>& a, const std::vector<double>& b, int draws) {
    const auto c = centredRanks(a, b);
    if (!c) return std::nullopt;
    const double observed = dot(c->ra, c->rb);
    const double tolerance = 1e-9 * std::sqrt(c->da * c->db);
    // 种子只跟组数有关:同一次扫描重跑,p 值一位不变
    Mulberry32 random{quint32(a.size())};
    std::vector<double> shuffled = c->rb;
    double atLeast = 0;
    for (int d = 0; d < draws; ++d) {
        for (size_t i = shuffled.size() - 1; i > 0; --i) {
            const size_t j = size_t(std::floor(random() * double(i + 1)));
            std::swap(shuffled[i], shuffled[j]);
        }
        if (dot(c->ra, shuffled) >= observed - tolerance) atLeast += 1;
    }
    return util::pyRound((1 + atLeast) / (1 + double(draws)), 4);
}

void checkGrid(const QString& strategy, const OJson& grid, double symbols) {
    const OJson* meta = bt::strategies().get(strategy);
    const bool proto = !meta && (bt::onObjectPrototype(strategy) || strategy == u"__proto__");
    if (!meta && !proto) throw bt::BacktestError(u"未知策略:"_s + strategy);
    if (strategy == u"custom" || strategy == u"buy_hold") {
        throw bt::BacktestError(u"「%1」没有参数可扫,选一个带参数的策略"_s.arg(meta->get(u"label"_s)->s));
    }
    const QStringList keys = js::keys(&grid);
    if (keys.isEmpty()) throw bt::BacktestError(u"参数网格是空的:至少给一个参数、两个以上的取值"_s);
    for (const QString& key : keys) {
        // Object.prototype 上的名字当策略:meta 是个函数(或 Object.prototype),它的 params 是 undefined
        if (proto) throw util::JsError(u"Cannot use 'in' operator to search for '%1' in undefined"_s.arg(key));
        const OJson& params = *meta->get(u"params"_s);
        if (!params.get(key) && !bt::onObjectPrototype(key) && key != u"__proto__") {
            throw bt::BacktestError(u"策略 %1 没有参数 %2(可扫:%3)"_s.arg(strategy, key, js::keys(&params).join(u"、"_s)));
        }
        const OJson& values = *grid.get(key);
        if (values.items.isEmpty()) throw bt::BacktestError(u"参数 %1 没有给取值"_s.arg(key));
        if (values.items.size() > kMaxValuesPerParam) throw bt::BacktestError(u"参数 %1 最多试 %2 个取值"_s.arg(key).arg(kMaxValuesPerParam));
    }
    double combos = 1;
    for (const QString& k : keys) combos = combos * double(grid.get(k)->items.size());
    if (combos > kMaxCombos) throw bt::BacktestError(u"组合太多:%1 组,最多 %2 组。少给几个取值"_s.arg(n2s(combos)).arg(kMaxCombos));
    if (combos * symbols > kMaxRuns) {
        throw bt::BacktestError(u"组合 × 标的 = %1,最多 %2。少扫几只或少给几个取值"_s.arg(n2s(combos * symbols)).arg(kMaxRuns));
    }
}

namespace {
struct OptionSeries {
    bt::Series vol, sessionShare;
};
struct Run {
    const bt::Bars* bars;
    std::vector<double> held;
    OJson used;
    const OptionSeries* option;
};
struct ComboRun {
    OJson params;
    std::vector<Run> runs;
};

/// 结算 [lo, hi) 这一截:lo 那一根是起点,它收盘时的持仓决定下一根的涨跌算不算
Stats segment(const ComboRun& run, double lo, double hi, const SweepInput& input) {
    std::vector<Stats> list;
    for (const Run& r : run.runs) {
        bt::SegmentInput seg;
        seg.bars = r.bars;
        seg.held = &r.held;
        seg.strategy = input.strategy;
        seg.params = r.used;
        seg.inst = input.instrument;
        seg.costPct = input.costPct;
        seg.lo = lo;
        seg.hi = hi;
        if (r.option) {
            seg.vol = &r.option->vol;
            seg.sessionShare = &r.option->sessionShare;
        }
        list.push_back(statsOf(bt::evaluateSegment(seg)));
    }
    return averageStats(list);
}

struct Fold {
    QString trainEnd, testStart, testEnd;
    OJson params;
    bool floored, under;
    double testRet, benchRet;
};
struct WalkForward {
    std::vector<Fold> folds;
    double total, bench;
    OJson toJson() const {
        OJson fs = js::array();
        for (const Fold& f : folds)
            fs.items.append(js::object({
                {u"train_end"_s, js::S(f.trainEnd)},
                {u"test_start"_s, js::S(f.testStart)},
                {u"test_end"_s, js::S(f.testEnd)},
                {u"params"_s, f.params},
                {u"dd_floored"_s, js::B(f.floored)},
                {u"dd_under_one_day"_s, js::B(f.under)},
                {u"test_return_pct"_s, js::N(f.testRet)},
                {u"bench_return_pct"_s, js::N(f.benchRet)},
            }));
        return js::object({{u"folds"_s, fs}, {u"total_return_pct"_s, js::N(total)}, {u"bench_return_pct"_s, js::N(bench)}});
    }
};

std::optional<WalkForward> walkForward(const std::vector<ComboRun>& valid, double n, const QStringList& dates, const SweepInput& input) {
    const double k = input.folds;
    if (!(k >= 2) || valid.empty()) return std::nullopt;
    std::vector<double> cuts;
    for (double j = 1; j <= k + 1; j += 1) cuts.push_back(std::floor((n * j) / (k + 1)));
    WalkForward wf;
    double chain = 1, bench = 1;
    for (double j = 0; j < k; j += 1) {
        const double trainEnd = cuts[size_t(j)];
        const double testEnd = j + 1 < double(cuts.size()) ? cuts[size_t(j + 1)] : n;
        if (trainEnd < kMinSegmentBars || testEnd - trainEnd < kMinSegmentBars) continue;
        const ComboRun* best = nullptr;
        double bestScore = -kInf;
        std::optional<Stats> bestTrain;
        for (const ComboRun& run : valid) {
            const Stats train = segment(run, 0, trainEnd, input);
            const double sc = scoreOfStats(train, input.objective);
            if (sc > bestScore) {
                bestScore = sc;
                best = &run;
                bestTrain = train;
            }
        }
        if (!best || !bestTrain) continue;
        // 按总收益挑的时候得分里没有回撤,这两个标记无从谈起
        const bool byDrawdown = input.objective == u"calmar";
        // 测试段从训练段最后一根起:那一根收盘时的持仓决定测试段第一天的涨跌算不算
        const Stats test = segment(*best, trainEnd - 1, testEnd, input);
        chain *= 1 + test.ret / 100;
        bench *= 1 + test.bench / 100;
        wf.folds.push_back({dates[qsizetype(trainEnd - 1)], dates[qsizetype(trainEnd)], dates[qsizetype(testEnd - 1)], best->params,
                            byDrawdown && bestTrain->floored, byDrawdown && bestTrain->under, test.ret, test.bench});
    }
    if (wf.folds.empty()) return std::nullopt;
    wf.total = util::pyRound((chain - 1) * 100, 2);
    wf.bench = util::pyRound((bench - 1) * 100, 2);
    return wf;
}

QString pctText(double p) { return n2s(util::pyRound(p * 100, 1)) + u'%'; }
/// 置换 p 值最小是 1 ÷ (次数 + 1):舍到一位小数会印成"0%",那不是它的意思
QString smallPctText(double p) { return p < 0.001 ? u"不到 0.1%"_s : pctText(p); }

struct Row {
    OJson params;
    double score;
    Stats is, oos;
    double oosRank;
    OJson toJson() const {
        return js::object({{u"params"_s, params}, {u"score"_s, js::N(score)}, {u"is"_s, is.toJson()}, {u"oos"_s, oos.toJson()}, {u"oos_rank"_s, js::N(oosRank)}});
    }
};

QStringList drawdownNotes(const std::optional<Row>& best, const std::optional<WalkForward>& wf) {
    QStringList notes{u"排名用的是 总收益 ÷ max(最大回撤, 回撤下限),不年化。回撤下限 = 在场时的单日波动 × √在场天数:"_s +
                      u"这么大的日波动、在场这么多天,净值本来就该有这个量级的起落,回撤比它还小的按它算"_s +
                      (best && best->is.floored ? u";样本内第一名就是按它算的"_s : QString())};
    if (best && best->is.under) {
        notes << u"样本内第一名在样本内的回撤还不到它在场时一天的典型波动:基本没经历过回撤(多半只进过一两次场),这个名次不可靠"_s;
    }
    const std::vector<Fold> folds = wf ? wf->folds : std::vector<Fold>{};
    double floored = 0, thin = 0;
    for (const Fold& f : folds) {
        if (f.floored) floored += 1;
        if (f.under) thin += 1;
    }
    if (floored > 0) {
        notes << u"滚动前推 %1 折里有 %2 折,挑出来的那组在训练段的回撤是按下限算的"_s.arg(folds.size()).arg(n2s(floored)) +
                     (thin > 0 ? u";其中 %1 折那组的回撤还不到在场时一天的典型波动(基本没经历过回撤,那一折的参数不可靠)"_s.arg(n2s(thin)) : QString());
    }
    return notes;
}
}  // namespace

OJson runSweep(const SweepInput& input) {
    if (input.series.empty()) throw bt::BacktestError(u"没有标的"_s);
    if (input.series.size() > kMaxSymbols) throw bt::BacktestError(u"一次最多扫 %1 只"_s.arg(kMaxSymbols));
    if (!(input.splitPct >= 50 && input.splitPct <= 90)) throw bt::BacktestError(u"样本内占比要在 50%~90% 之间"_s);
    const double fd = input.folds;
    if (!(fd == 0 || (std::isfinite(fd) && fd == std::trunc(fd) && fd >= 2 && fd <= 6))) {
        throw bt::BacktestError(u"滚动前推的折数要是 2~6(不做填 0)"_s);
    }
    checkGrid(input.strategy, input.grid, double(input.series.size()));
    const std::vector<SymbolBars> series = alignSeries(input.series);
    const double n = double(series[0].bars.size());
    if (n < kMinSegmentBars * 2) {
        throw bt::BacktestError(u"几只标的共同的交易日只有 %1 天,切不出样本内外(至少 %2 天)"_s.arg(n2s(n)).arg(kMinSegmentBars * 2));
    }
    const double split = std::floor((n * input.splitPct) / 100);
    if (split < kMinSegmentBars || n - split < kMinSegmentBars) {
        throw bt::BacktestError(u"样本内 %1 天、样本外 %2 天,每段至少 %3 天"_s.arg(n2s(split), n2s(n - split)).arg(kMinSegmentBars));
    }
    QStringList dates;
    for (const bt::Bar& b : series[0].bars) dates << b.date;

    const QList<OJson> combos = gridCombos(input.grid);
    const OJson* instType = input.instrument.get(u"type"_s);
    const bool isStock = instType && instType->type == OJson::String && instType->s == u"stock";
    std::vector<std::optional<OptionSeries>> options;
    for (const SymbolBars& s : series) {
        if (isStock) {
            options.emplace_back(std::nullopt);
            continue;
        }
        std::vector<double> closes;
        for (const bt::Bar& b : s.bars) closes.push_back(b.close);
        options.emplace_back(OptionSeries{bt::trailingVol(closes), bt::trailingSessionShare(s.bars)});
    }
    OJson skipped = js::array();
    std::vector<ComboRun> valid;
    for (const OJson& params : combos) {
        try {
            ComboRun cr{params, {}};
            for (size_t k = 0; k < series.size(); ++k) {
                const bt::Signal sig = bt::signalPositions(series[k].bars, input.strategy, &params, nullptr);
                cr.runs.push_back({&series[k].bars, bt::heldAfterOpen(sig.positions), sig.usedParams, options[k] ? &*options[k] : nullptr});
            }
            valid.push_back(cr);
        } catch (const bt::BacktestError& exc) {
            skipped.items.append(js::object({{u"params"_s, params}, {u"reason"_s, js::S(exc.message())}}));
        }
    }

    struct Scored {
        const ComboRun* run;
        Stats is, oos;
        double score, oosScore;
    };
    std::vector<Scored> scored;
    for (const ComboRun& run : valid) {
        const Stats is = segment(run, 0, split, input);
        const Stats oos = segment(run, split - 1, n, input);
        scored.push_back({&run, is, oos, util::pyRound(scoreOfStats(is, input.objective), 4), scoreOfStats(oos, input.objective)});
    }
    std::vector<size_t> ordered(scored.size());
    for (size_t i = 0; i < ordered.size(); ++i) ordered[i] = i;
    std::stable_sort(ordered.begin(), ordered.end(), [&](size_t a, size_t b) { return scored[b].score < scored[a].score; });
    std::vector<Row> rows;
    for (size_t i : ordered) {
        const Scored& x = scored[i];
        double higher = 0;
        for (const Scored& y : scored)
            if (y.oosScore > x.oosScore) higher += 1;
        rows.push_back({x.run->params, x.score, x.is, x.oos, 1 + higher});
    }
    const std::optional<Row> best = rows.empty() ? std::nullopt : std::optional(rows[0]);
    std::vector<double> isScores, oosScores, oosRets;
    for (const Scored& x : scored) {
        isScores.push_back(x.score);
        oosScores.push_back(x.oosScore);
        oosRets.push_back(x.oos.ret);
    }
    const std::optional<double> rankCorr = spearman(isScores, oosScores);
    const std::optional<double> rankCorrP = rankCorr ? spearmanP(isScores, oosScores) : std::nullopt;
    std::optional<double> pickP;
    if (!ordered.empty()) {
        const double topOos = scored[ordered[0]].oosScore;
        double atLeast = 0;
        for (const Scored& y : scored)
            if (y.oosScore >= topOos) atLeast += 1;
        pickP = util::pyRound(atLeast / double(scored.size()), 4);
    }
    const std::optional<double> oosMedian = median(oosRets);
    const std::optional<WalkForward> wf = walkForward(valid, n, dates, input);

    OJson symbols = js::array();
    for (const SymbolBars& s : series) symbols.items.append(js::S(s.symbol));
    OJson rowsJson = js::array();
    for (size_t i = 0; i < rows.size() && i < 20; ++i) rowsJson.items.append(rows[i].toJson());

    // 说明:只摆算得准的数和已知的偏差,不替人下"能用 / 不能用"的结论
    QStringList notes;
    const double ranked = double(scored.size());
    if (best && ranked >= 3 && pickP) {
        notes << u"样本内第一名在样本外排第 %1 / %2:随手挑一组,样本外不比它差的机会是 %3"_s.arg(n2s(best->oosRank), n2s(ranked), pctText(*pickP));
    }
    if (rankCorr && rankCorrP) {
        notes << (*rankCorr > 0 ? u"样本内外排名的秩相关 %1:两边的排名要是毫无关系,碰巧得到这么高(或更高)的机会是 %2"_s.arg(n2s(*rankCorr), smallPctText(*rankCorrP))
                                : u"样本内外排名的秩相关 %1,不为正:样本内排得靠前的,样本外并不靠前"_s.arg(n2s(*rankCorr)));
    }
    if (best && (best->is.days < kYearDays || best->oos.days < kYearDays)) {
        notes << u"样本内 %1 天、样本外 %2 天:不满一年的那一段,年化与 Calmar 是外推出来的,只作参考"_s.arg(n2s(best->is.days), n2s(best->oos.days));
    }
    if (input.objective == u"calmar") notes << drawdownNotes(best, wf);
    if (input.costPct == 0) notes << u"没扣成交成本(佣金、买卖价差):换手越多,实际比这里差得越多"_s;
    if (!isStock) {
        notes << u"期权按 Black-Scholes 理论价估(r=0、近 20 日已实现波动率逐日重估、时间按交易日计、行权价贴标准挂牌间隔):没有方差风险溢价、偏斜与买卖价差,"_s +
                     u"单腿买方被算便宜了;每只标的前 20 根日线只用来算波动率,不开仓;理论价不到 0.01 美元的不开仓"_s;
    }
    if (series.size() > 1) notes << u"几只标的只用大家都有的交易日"_s;
    notes << u"代码是现在还在交易的,退市、被剔除的不在里面,结果偏乐观(幸存者偏差);只扫一只也一样"_s;

    return js::object({
        {u"strategy"_s, js::S(input.strategy)},
        {u"symbols"_s, symbols},
        {u"objective"_s, js::S(input.objective)},
        {u"cost_pct"_s, js::N(input.costPct)},
        {u"instrument"_s, input.instrument},
        {u"start"_s, js::S(dates[0])},
        {u"end"_s, js::S(dates[qsizetype(n - 1)])},
        {u"split_date"_s, js::S(dates[qsizetype(split)])},
        {u"combos"_s, js::N(double(combos.size()))},
        {u"skipped"_s, skipped},
        {u"ranked"_s, js::N(ranked)},
        {u"rows"_s, rowsJson},
        {u"best"_s, best ? best->toJson() : OJson::null()},
        {u"rank_corr"_s, optN(rankCorr)},
        {u"rank_corr_p"_s, optN(rankCorrP)},
        {u"pick_p"_s, optN(pickP)},
        {u"oos_median_return_pct"_s, oosMedian ? js::N(util::pyRound(*oosMedian, 2)) : OJson::null()},
        {u"walk_forward"_s, wf ? wf->toJson() : OJson::null()},
        {u"notes"_s, js::strings(notes)},
    });
}

}  // namespace ibkr::analysis::backtest_lab
