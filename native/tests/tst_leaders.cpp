// engine/analysis/leaders(leaders.ts)对着原模块现跑的答案(tests/fixtures/gen_leaders.mjs):77 份合成日线上的清洗、均线、RS 与百分位、
// 趋势模板、收缩与 VCP、派发日与大盘方向,30 个池子的整池筛选与「今天新进第二阶段」,逐字符比 JSON。
#include "analysis/leaders.h"
#include "js_fixture.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using jsfix::enc;
using util::OJson;
namespace js = util::js;
namespace ld = analysis::leaders;

namespace {
double num(const OJson* v) { return jsfix::num(v); }
std::optional<double> optNum(const OJson* v) {
    if (jsfix::isUndefined(v) || v->type == OJson::Null) return std::nullopt;
    return num(v);
}
OJson optN(const std::optional<double>& v) { return v ? js::N(*v) : OJson::null(); }
OJson barJson(const ld::Bar& b) {
    return js::object({{u"time"_s, js::S(b.time)}, {u"high"_s, js::N(b.high)}, {u"low"_s, js::N(b.low)}, {u"close"_s, js::N(b.close)}, {u"volume"_s, js::N(b.volume)}});
}
OJson barsJson(const std::vector<ld::Bar>& v) {
    OJson a = js::array();
    for (const auto& b : v) a.items.append(barJson(b));
    return a;
}
OJson numbers(const std::vector<double>& v) {
    OJson a = js::array();
    for (double x : v) a.items.append(js::N(x));
    return a;
}
}  // namespace

class TestLeaders : public QObject {
    Q_OBJECT
    OJson fx_;
    QList<OJson> series_;

private slots:
    void initTestCase() {
        fx_ = jsfix::load(u"leaders.json"_s);
        for (const OJson& s : fx_.get(u"series"_s)->items) series_ << dec(s);
    }

    void clean() {
        for (const OJson& c : fx_.get(u"clean"_s)->items) {
            const OJson* s = c.get(u"s"_s);
            const OJson raw = s ? series_[qsizetype(s->n)] : dec(*c.get(u"raw"_s));
            const bool full = !s || c.get(u"full"_s)->b;
            JSFIX_EXPECT(c, [&] {
                const auto bars = ld::cleanDaily(raw);
                if (full) return barsJson(bars);
                return js::array({js::N(double(bars.size())), barJson(bars.front()), barJson(bars.back())});
            }, u"cleanDaily"_s);
        }
    }

    void basics() {
        for (const OJson& c : fx_.get(u"sma"_s)->items) {
            std::vector<double> v;
            for (const OJson& x : c.get(u"values"_s)->items) v.push_back(x.n);
            const auto got = ld::smaAt(v, c.get(u"n"_s)->n, optNum(c.get(u"end"_s)));
            QCOMPARE(js::stringify(enc(optN(got))), js::stringify(*c.get(u"out"_s)));
        }
        for (const OJson& c : fx_.get(u"rs"_s)->items) {
            std::vector<double> closes;
            for (const auto& b : ld::cleanDaily(series_[qsizetype(c.get(u"s"_s)->n)])) closes.push_back(b.close);
            QCOMPARE(js::stringify(enc(optN(ld::rsScore(closes)))), js::stringify(*c.get(u"out"_s)));
        }
        for (const OJson& c : fx_.get(u"ratings"_s)->items) {
            std::vector<std::optional<double>> scores;
            for (const OJson& x : c.get(u"scores"_s)->items) scores.push_back(x.type == OJson::Null ? std::nullopt : std::optional(num(&x)));
            OJson got = js::array();
            for (const auto& r : ld::ratings(scores)) got.items.append(optN(r));
            QCOMPARE(js::stringify(enc(got)), js::stringify(*c.get(u"out"_s)));
        }
        for (const OJson& c : fx_.get(u"template"_s)->items) {
            const OJson t = dec(*c.get(u"t"_s));
            ld::TrendInputs in;
            in.close = num(t.get(u"close"_s));
            in.ma50 = optNum(t.get(u"ma50"_s));
            in.ma150 = optNum(t.get(u"ma150"_s));
            in.ma200 = optNum(t.get(u"ma200"_s));
            in.ma200Months = optNum(t.get(u"ma200Months"_s));
            in.high52 = num(t.get(u"high52"_s));
            in.low52 = num(t.get(u"low52"_s));
            in.fullYear = t.get(u"fullYear"_s)->b;
            in.rsRating = optNum(t.get(u"rsRating"_s));
            in.rsVsBench = optNum(t.get(u"rsVsBench"_s));
            in.universe = num(t.get(u"universe"_s));
            JSFIX_SAME(*c.get(u"out"_s), ld::trendTemplate(in), u"trendTemplate "_s + js::stringify(*c.get(u"t"_s)));
        }
    }

    void vcpAndRegime() {
        for (const OJson& c : fx_.get(u"vcp"_s)->items) {
            const auto bars = ld::cleanDaily(series_[qsizetype(c.get(u"s"_s)->n)]);
            JSFIX_SAME(*c.get(u"vcp"_s), ld::detectVcp(bars), u"detectVcp %1"_s.arg(c.get(u"s"_s)->n));
            for (const OJson& k : c.get(u"contractions"_s)->items) {
                const auto r = ld::contractions(bars, k.get(u"start"_s)->n);
                JSFIX_SAME(k, js::object({{u"start"_s, *k.get(u"start"_s)}, {u"peaks"_s, numbers(r.peaks)}, {u"depths"_s, numbers(r.depths)}}), u"contractions"_s);
            }
            QCOMPARE(js::stringify(enc(js::strings(ld::distributionDays(bars)))), js::stringify(*c.get(u"dist"_s)));
        }
        for (const OJson& c : fx_.get(u"regime"_s)->items)
            JSFIX_EXPECT(c, [&] { return ld::marketRegime(c.get(u"symbol"_s)->s, series_[qsizetype(c.get(u"s"_s)->n)]); }, u"marketRegime"_s);
    }

    void screens() {
        int rows = 0;
        for (const OJson& c : fx_.get(u"screens"_s)->items) {
            QList<ld::LeaderMember> members;
            for (const OJson& m : c.get(u"members"_s)->items) {
                ld::LeaderMember lm;
                lm.symbol = m.get(u"symbol"_s)->s;
                if (const OJson* t = m.get(u"tag"_s)) lm.tag = t->s;
                if (const OJson* t = m.get(u"company"_s)) lm.company = t->s;
                if (const OJson* e = m.get(u"error"_s)) lm.error = *e;
                const double s = m.get(u"bars"_s)->n;
                lm.bars = s < 0 ? js::array() : series_[qsizetype(s)];
                if (m.get(u"trim"_s)->b) lm.bars.items.removeLast();
                members << lm;
            }
            const OJson& bench = series_[qsizetype(c.get(u"bench"_s)->n)];
            const QString benchmark = c.get(u"benchmark"_s)->s;
            OJson result;
            JSFIX_EXPECT(c, [&] {
                result = ld::screenLeaders(members, bench, benchmark);
                return result;
            }, u"screenLeaders"_s);
            rows += int(result.get(u"rows"_s)->items.size());
            JSFIX_EXPECT(*c.get(u"fresh"_s), [&] { return ld::newStage2(members, bench, benchmark, result.get(u"rows"_s)->items); }, u"newStage2"_s);
        }
        QVERIFY(rows > 150);
        // 没有基准日线
        const OJson none = ld::newStage2({}, js::array(), u"SPY"_s, {});
        QCOMPARE(js::stringify(none), u"{\"day\":\"\",\"rows\":[]}"_s);
    }
};

QTEST_GUILESS_MAIN(TestLeaders)
#include "tst_leaders.moc"
