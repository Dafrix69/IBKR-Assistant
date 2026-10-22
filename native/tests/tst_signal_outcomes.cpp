// engine/analysis/signal_outcomes(signalOutcomes.ts)对着原模块现跑的答案(tests/fixtures/gen_signal_outcomes.mjs):事件折成信号、
// 美东零点与收盘、进场时段、进场那一根、收益与基线、持有期分段与 t、门槛网格、12 份整份成绩单,逐字符比 JSON。
#include "analysis/signal_outcomes.h"
#include "js_fixture.h"
#include "util/market_calendar.h"
#include "util/market_js.h"

#include <QDate>
#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using jsfix::enc;
using util::OJson;
namespace js = util::js;
namespace so = analysis::signal_outcomes;

namespace {
double num(const OJson* v) { return jsfix::num(v); }
OJson optN(const std::optional<double>& v) { return v ? js::N(*v) : OJson::null(); }
std::vector<so::DailyClose> barsOf(const OJson& a) {
    std::vector<so::DailyClose> out;
    for (const OJson& b : a.items) out.push_back({b.get(u"date"_s)->s, b.get(u"close"_s)->n});
    return out;
}
OJson numbers(const std::vector<double>& v) {
    OJson a = js::array();
    for (double x : v) a.items.append(js::N(x));
    return a;
}
OJson optNumbers(const std::vector<std::optional<double>>& v) {
    OJson a = js::array();
    for (const auto& x : v) a.items.append(optN(x));
    return a;
}
bool weekday(const QString& d) {
    const QDate q = QDate::fromString(d, u"yyyy-MM-dd"_s);
    return q.isValid() && q.dayOfWeek() < 6;
}
}  // namespace

class TestSignalOutcomes : public QObject {
    Q_OBJECT
    OJson fx_;
    std::vector<std::vector<so::DailyClose>> series_;
    QSet<QString> none_, custom_, holidays_;

    so::EarlyCloses early(const OJson* name) {
        if (name->s == u"none") return &none_;
        if (name->s == u"custom") return &custom_;
        return nullptr;
    }
    std::function<bool(const QString&)> calendar(const QString& name) {
        if (name == u"nyse") return [this](const QString& d) { return weekday(d) && !holidays_.contains(d); };
        if (name == u"weekday") return weekday;
        if (name == u"always") return [](const QString&) { return true; };
        return [](const QString&) { return false; };
    }

private slots:
    void initTestCase() {
        fx_ = jsfix::load(u"signal-outcomes.json"_s);
        for (const OJson& s : fx_.get(u"series"_s)->items) series_.push_back(barsOf(s));
        for (const OJson& d : fx_.get(u"custom"_s)->items) custom_.insert(d.s);
        for (const QString& d : util::builtinCalendar().holidays) holidays_.insert(d);
    }

    void events() {
        for (const OJson& c : fx_.get(u"events"_s)->items) {
            const OJson e = dec(*c.get(u"e"_s));
            const QString kind = c.get(u"kind"_s)->s;
            JSFIX_EXPECT(c, [&] {
                if (kind == u"watch") return so::signalFromWatchEvent(e);
                if (kind == u"anomaly") return so::signalFromAnomaly(e);
                if (kind == u"leader") return so::signalFromLeader(e, num(c.get(u"atMs"_s)));
                return so::signalFromPa(e, num(c.get(u"atMs"_s)));
            }, kind + u' ' + js::stringify(*c.get(u"e"_s)));
        }
    }

    void days() {
        for (const OJson& c : fx_.get(u"days"_s)->items) {
            const QString d = c.get(u"date"_s)->s;
            JSFIX_EXPECT(*c.get(u"start"_s), [&] { return js::S(so::etDayStart(d)); }, u"etDayStart "_s + d);
            JSFIX_EXPECT(*c.get(u"close"_s), [&] { return js::N(so::closeEpoch(d, early(c.get(u"early"_s)))); }, u"closeEpoch "_s + d);
        }
        for (const OJson& c : fx_.get(u"sessions"_s)->items)
            JSFIX_EXPECT(c, [&] { return js::S(so::entrySessionStart(c.get(u"nowMs"_s)->n, calendar(c.get(u"cal"_s)->s), early(c.get(u"early"_s)))); },
                         u"entrySessionStart %1"_s.arg(c.get(u"nowMs"_s)->n, 0, 'f', 0));
    }

    void entriesAndReturns() {
        for (const OJson& c : fx_.get(u"entries"_s)->items) {
            const auto& bars = series_[size_t(c.get(u"s"_s)->n)];
            QCOMPARE(so::entryIndex(bars, num(c.get(u"atMs"_s)), early(c.get(u"early"_s))), c.get(u"out"_s)->n);
        }
        for (const OJson& c : fx_.get(u"returns"_s)->items) {
            const auto& bars = series_[size_t(c.get(u"s"_s)->n)];
            const OJson sig = dec(*c.get(u"signal"_s));
            QCOMPARE(js::stringify(enc(optNumbers(so::signalReturns(sig, bars, early(c.get(u"early"_s)))))), js::stringify(*c.get(u"out"_s)));
        }
        for (const OJson& c : fx_.get(u"baselines"_s)->items) {
            const auto bars = c.get(u"bars"_s) ? barsOf(*c.get(u"bars"_s)) : series_[size_t(c.get(u"s"_s)->n)];
            const auto got = so::baselineReturn(bars, c.get(u"entry"_s)->n, c.get(u"k"_s)->n, c.get(u"abs"_s)->b);
            QCOMPARE(js::stringify(enc(optN(got))), js::stringify(*c.get(u"out"_s)));
        }
    }

    void stats() {
        for (const OJson& c : fx_.get(u"blocks"_s)->items) {
            std::vector<double> days;
            for (const OJson& d : c.get(u"days"_s)->items) days.push_back(num(&d));
            // [...new Set(days)].sort((a, b) => a - b):Set 按 SameValueZero 去重(NaN 只留一个),排序同 V8
            std::vector<double> sorted;
            for (double d : days) {
                bool seen = false;
                for (double u : sorted) seen = seen || u == d || (std::isnan(u) && std::isnan(d));
                if (!seen) sorted.push_back(d);
            }
            util::market::sortNumbers(sorted);
            const double k = c.get(u"k"_s)->n;
            QCOMPARE(js::stringify(enc(numbers(so::windowBlocks(sorted, k)))), js::stringify(*c.get(u"blocks"_s)));
            QCOMPARE(js::stringify(enc(js::N(so::independentWindows(days, k)))), js::stringify(*c.get(u"independent"_s)));
        }
        for (const OJson& c : fx_.get(u"overlap"_s)->items) {
            std::vector<so::Observation> obs;
            for (const OJson& o : c.get(u"obs"_s)->items) obs.push_back({num(o.get(u"day"_s)), num(o.get(u"excess"_s))});
            JSFIX_SAME(*c.get(u"out"_s), so::overlapT(obs, c.get(u"k"_s)->n).toJson(), u"overlapT"_s);
        }
        for (const OJson& c : fx_.get(u"thresholds"_s)->items)
            QVERIFY2(js::stringify(enc(js::N(so::tThreshold(c.get(u"m"_s)->n, c.get(u"w"_s)->n)))) == js::stringify(*c.get(u"out"_s)),
                     qPrintable(u"tThreshold(%1, %2)"_s.arg(c.get(u"m"_s)->n).arg(c.get(u"w"_s)->n)));
    }

    void scores() {
        for (const OJson& c : fx_.get(u"scores"_s)->items) {
            const OJson sigs = dec(*c.get(u"signals"_s));
            std::vector<std::pair<QString, std::vector<so::DailyClose>>> bars;
            for (const OJson& kv : c.get(u"bars"_s)->items) bars.push_back({kv.items[0].s, barsOf(kv.items[1])});
            const OJson d = dec(*c.get(u"days"_s));
            const std::optional<double> days = d.type == OJson::Null ? std::nullopt : std::optional(d.n);
            JSFIX_EXPECT(c, [&] { return so::scoreSignals(sigs.items, bars, days, early(c.get(u"early"_s))); }, u"scoreSignals"_s);
        }
    }
};

QTEST_GUILESS_MAIN(TestSignalOutcomes)
#include "tst_signal_outcomes.moc"
