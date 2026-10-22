// engine/analysis/priceaction(priceaction.ts)对着原模块现跑的答案(tests/fixtures/gen_priceaction.mjs):黄金基线的 4 个场景
// (分析结果、事实块、高周期摘要)与 agreement,合成 K 线上的分析(最后一根走没走完、行情档、盘前盘后、周期名)、事实块(含高周期)、
// 时间戳解析、几点收盘、K 线多久了、偏向,逐字符比。
#include "analysis/priceaction.h"
#include "js_fixture.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using jsfix::enc;
using util::OJson;
namespace js = util::js;
namespace pa = analysis::priceaction;

namespace {
std::optional<pa::PaClock> clockOf(const OJson& c) {
    const QString kind = c.get(u"kind"_s)->s;
    if (kind == u"none") return std::nullopt;
    pa::PaClock k;
    k.epochMs = c.get(u"epochMs"_s)->n;
    if (kind == u"clock") {
        if (const OJson* v = c.get(u"barsAsOfMs"_s)) k.barsAsOfMs = v->n;
        if (const OJson* v = c.get(u"feed"_s)) k.feed = v->s;
        if (const OJson* v = c.get(u"extendedSession"_s)) k.extendedSession = v->b;
    }
    return k;
}
OJson wallJson(const std::optional<util::WallParts>& p) {
    if (!p) return OJson::null();
    return js::object({{u"year"_s, js::N(p->year)}, {u"month"_s, js::N(p->month)}, {u"day"_s, js::N(p->day)},
                       {u"hour"_s, js::N(p->hour)}, {u"minute"_s, js::N(p->minute)}, {u"second"_s, js::N(p->second)}});
}
OJson optN(const std::optional<double>& v) { return v ? js::N(*v) : OJson::null(); }
OJson swingsJson(const std::vector<pa::Swing>& v) {
    OJson o = js::array();
    for (const pa::Swing& s : v)
        o.items.append(js::object({{u"index"_s, js::N(s.index)}, {u"time"_s, js::S(s.time)}, {u"price"_s, js::N(s.price)}, {u"kind"_s, js::S(s.kind)}, {u"label"_s, js::S(s.label)}}));
    return o;
}
OJson numsJson(const std::vector<double>& v) {
    OJson o = js::array();
    for (double x : v) o.items.append(js::N(x));
    return o;
}
}  // namespace

class TestPriceAction : public QObject {
    Q_OBJECT
    OJson fx_;
    QList<OJson> sets_;

    bool check(const OJson& c, const QString& what) {
        const OJson& rows = sets_[qsizetype(c.get(u"set"_s)->n)];
        const auto clock = clockOf(*c.get(u"clock"_s));
        const QString symbol = c.get(u"symbol"_s)->s, tf = c.get(u"timeframe"_s)->s;
        const double strength = c.get(u"strength"_s) ? c.get(u"strength"_s)->n : pa::kSwingStrength;
        const bool ext = c.get(u"extended"_s)->b;
        if (!jsfix::expect(c, [&] { return pa::analyze(rows, symbol, tf, strength, clock, ext); }, what)) return false;
        if (!c.get(u"out"_s)) return true;
        const OJson r = pa::analyze(rows, symbol, tf, strength, clock, ext);
        if (!jsfix::same(*c.get(u"htf"_s), pa::htfSummary(r), what + u" htf"_s)) return false;
        QString facts;
        if (const OJson* higherV = c.get(u"higher"_s)) {
            const OJson higher = dec(*higherV);
            if (!jsfix::same(*c.get(u"agreement"_s), pa::agreement(r, higher.type == OJson::Null ? nullptr : &higher), what + u" agreement"_s)) return false;
            OJson withHtf = r;
            withHtf.set(u"htf"_s, higher);
            withHtf.set(u"agreement"_s, pa::agreement(r, higher.type == OJson::Null ? nullptr : &higher));
            facts = pa::factsText(withHtf);
        } else {
            facts = pa::factsText(r);
        }
        if (facts != c.get(u"facts"_s)->s) {
            QTest::qFail(qPrintable(u"%1 facts\n  TS :%2\n  C++:%3"_s.arg(what, c.get(u"facts"_s)->s, facts)), __FILE__, __LINE__);
            return false;
        }
        return true;
    }

private slots:
    void initTestCase() {
        fx_ = jsfix::load(u"priceaction.json"_s);
        for (const OJson& s : fx_.get(u"sets"_s)->items) sets_ << dec(s);
    }

    void golden() {
        for (const OJson& c : fx_.get(u"golden"_s)->items) QVERIFY(check(c, u"golden "_s + c.get(u"name"_s)->s));
        for (const OJson& a : fx_.get(u"agreement"_s)->items) {
            pa::PaClock now;
            now.epochMs = a.get(u"now"_s)->n;
            const OJson up = pa::analyze(sets_[qsizetype(a.get(u"upSet"_s)->n)], u"UP"_s, u"5m"_s, pa::kSwingStrength, now);
            const OJson down = pa::analyze(sets_[qsizetype(a.get(u"downSet"_s)->n)], u"DN"_s, u"5m"_s, pa::kSwingStrength, now);
            const OJson* b = a.get(u"b"_s);
            const OJson higher = b->type == OJson::Null ? OJson::null() : pa::htfSummary(b->s == u"uptrend" ? up : down);
            JSFIX_SAME(*a.get(u"out"_s), pa::agreement(up, b->type == OJson::Null ? nullptr : &higher), u"agreement"_s);
        }
    }

    void cases() {
        int ok = 0, n = 0;
        for (const OJson& c : fx_.get(u"cases"_s)->items) {
            QVERIFY(check(c, u"case %1 %2 %3"_s.arg(n).arg(c.get(u"timeframe"_s)->s, js::stringify(*c.get(u"clock"_s)))));
            if (c.get(u"out"_s)) ++ok;
            ++n;
        }
        QVERIFY(ok > 60);
    }

    void hunted() {
        // 变异测试里活下来的边界改动,反过来找出来的探针(gen_priceaction.mjs 的 HUNTS):结果去掉整段 K 线与均线再比
        QVERIFY(fx_.get(u"hunted"_s)->items.size() > 20);
        for (const OJson& c : fx_.get(u"hunted"_s)->items) {
            const QString what = u"hunted "_s + c.get(u"label"_s)->s;
            const OJson& rows = sets_[qsizetype(c.get(u"set"_s)->n)];
            const auto clock = clockOf(*c.get(u"clock"_s));
            OJson r = pa::analyze(rows, c.get(u"symbol"_s)->s, c.get(u"timeframe"_s)->s, pa::kSwingStrength, clock, false);
            OJson slim = r;
            slim.remove(u"bars"_s);
            slim.remove(u"ma"_s);
            JSFIX_SAME(*c.get(u"out"_s), slim, what);
            JSFIX_SAME(*c.get(u"htf"_s), pa::htfSummary(r), what + u" htf"_s);
            QCOMPARE(pa::factsText(r), c.get(u"facts"_s)->s);
        }
    }

    void smallFunctions() {
        for (const OJson& c : fx_.get(u"helpers"_s)->items) {
            const pa::PABars bars = pa::toBars(sets_[qsizetype(c.get(u"set"_s)->n)]);
            const QString what = u"helpers set %1"_s.arg(c.get(u"set"_s)->n);
            QCOMPARE(js::stringify(enc(js::N(pa::atr(bars)))), js::stringify(*c.get(u"atr"_s)));
            QCOMPARE(js::stringify(enc(js::N(pa::atr(bars, 5)))), js::stringify(*c.get(u"atr5"_s)));
            const std::vector<double> atrs = pa::atrSeries(bars);
            JSFIX_SAME(*c.get(u"atrs"_s), numsJson(atrs), what + u" atrs"_s);
            JSFIX_SAME(*c.get(u"atrs3"_s), numsJson(pa::atrSeries(bars, 3)), what + u" atrs3"_s);
            std::vector<double> trs;
            for (size_t k = 0; k < bars.size(); ++k) trs.push_back(pa::trueRange(bars[k], k ? &bars[k - 1] : nullptr));
            JSFIX_SAME(*c.get(u"tr"_s), numsJson(trs), what + u" tr"_s);
            const double st = c.get(u"st"_s)->n;
            const auto swings = pa::findSwings(bars, st);
            JSFIX_SAME(*c.get(u"swings"_s), swingsJson(swings), what + u" swings"_s);
            const auto zz = pa::zigzag(swings);
            JSFIX_SAME(*c.get(u"zigzag"_s), swingsJson(zz), what + u" zigzag"_s);
            JSFIX_SAME(*c.get(u"labeled"_s), swingsJson(pa::labelSwings(zz)), what + u" labeled"_s);
            JSFIX_SAME(*c.get(u"ma"_s), pa::movingAverages(bars), what + u" ma"_s);
            JSFIX_SAME(*c.get(u"ma2"_s), pa::movingAverages(bars, {1, 3, 50}, 20), what + u" ma2"_s);
            const auto hist = [&](const std::function<double(qsizetype)>& tol, double strength, qsizetype ke, qsizetype sw, qsizetype ks) {
                const pa::StructureHistory h = pa::structureHistory(bars, tol, strength, ke, sw, ks);
                return js::object({{u"points"_s, swingsJson(h.points)}, {u"events"_s, js::array(h.events)}, {u"sweeps"_s, js::array(h.sweeps)}});
            };
            JSFIX_SAME(*c.get(u"hist"_s), hist([&](qsizetype k) { return atrs[size_t(k)] * 0.35; }, 2, 3, 20, 2), what + u" hist"_s);
            JSFIX_SAME(*c.get(u"hist2"_s), hist([](qsizetype) { return 0.01; }, 3, 6, 40, 3), what + u" hist2"_s);
        }
        for (const OJson& c : fx_.get(u"subs"_s)->items) JSFIX_SAME(*c.get(u"out"_s), pa::subScores(dec(*c.get(u"ev"_s))), u"subScores"_s);
    }

    void helpers() {
        for (const OJson& c : fx_.get(u"parse"_s)->items) QCOMPARE(js::stringify(wallJson(pa::parseBarTime(c.get(u"s"_s)->s))), js::stringify(*c.get(u"out"_s)));
        for (const OJson& c : fx_.get(u"closeAt"_s)->items)
            QCOMPARE(js::stringify(enc(optN(pa::barCloseEpochMs(c.get(u"t"_s)->s, c.get(u"tf"_s)->s, c.get(u"ext"_s)->b)))), js::stringify(*c.get(u"out"_s)));
        for (const OJson& c : fx_.get(u"age"_s)->items) {
            const OJson* now = c.get(u"now"_s);
            QCOMPARE(js::stringify(enc(optN(pa::barAgeSeconds(c.get(u"t"_s)->s, now->type == OJson::Null ? std::nullopt : std::optional(now->n))))), js::stringify(*c.get(u"out"_s)));
        }
        for (const OJson& c : fx_.get(u"bias"_s)->items) {
            const auto [bias, label] = pa::biasOf(jsfix::num(c.get(u"s"_s)));
            QCOMPARE(bias, c.get(u"out"_s)->get(u"bias"_s)->s);
            QCOMPARE(label, c.get(u"out"_s)->get(u"label"_s)->s);
        }
    }
};

QTEST_GUILESS_MAIN(TestPriceAction)
#include "tst_priceaction.moc"
