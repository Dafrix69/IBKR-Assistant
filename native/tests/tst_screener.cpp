// engine/analysis/screener(screener.ts)对着原模块现跑的答案(tests/fixtures/gen_screener_engine.mjs):黄金基线的 RS 强度、周线、
// CD 背离、拐点与偏离,合成 K 线(坏根、日期写坏、分钟线)上的同一套,逐字符比 JSON。
#include "analysis/screener.h"
#include "js_fixture.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using jsfix::enc;
using util::OJson;
namespace js = util::js;
namespace sc = analysis::screener;

namespace {
std::vector<double> numbers(const OJson& raw) {
    std::vector<double> out;
    for (const OJson& x : raw.items) out.push_back(jsfix::num(&x));
    return out;
}
std::optional<double> optNum(const OJson* v) {
    if (jsfix::isUndefined(v) || v->type == OJson::Null) return std::nullopt;
    return jsfix::num(v);
}
QStringList strs(const OJson& a) {
    QStringList out;
    for (const OJson& x : a.items) out << x.s;
    return out;
}
}  // namespace

class TestScreener : public QObject {
    Q_OBJECT
    OJson fx_;
    QList<OJson> sets_;

    /// 夹具里 K 线写成下标(指 sets)、"__undefined__"、null 或别的原样值
    const OJson* setRef(const OJson* v, OJson& holder) {
        if (jsfix::isUndefined(v)) return nullptr;
        if (v->type == OJson::Number) return &sets_[qsizetype(v->n)];
        holder = dec(*v);
        return &holder;
    }

private slots:
    void initTestCase() {
        fx_ = jsfix::load(u"screener_engine.json"_s);
        for (const OJson& s : fx_.get(u"sets"_s)->items) sets_ << dec(s);
    }

    void golden() {
        const OJson& g = *fx_.get(u"golden"_s);
        for (const OJson& c : g.get(u"rs"_s)->items) {
            const OJson members = dec(*c.get(u"members"_s)), bench = dec(*c.get(u"bench"_s));
            const OJson* w = c.get(u"windows"_s);
            const std::vector<double> windows = jsfix::isUndefined(w) || w->type == OJson::Null ? sc::rsWindows() : numbers(*w);
            JSFIX_EXPECT(c, [&] { return sc::rsStrength(members, &bench, c.get(u"benchmark"_s)->s, windows); }, u"golden rs"_s);
        }
        const OJson& wk = *g.get(u"weekly"_s);
        const OJson wbars = dec(*wk.get(u"bars"_s));
        JSFIX_EXPECT(wk, [&] { return sc::resampleWeekly(&wbars); }, u"golden weekly"_s);
        for (const OJson& c : g.get(u"cd"_s)->items) {
            const OJson bars = dec(*c.get(u"bars"_s));
            const OJson& kw = *c.get(u"kw"_s);
            const OJson* age = kw.get(u"max_age"_s);
            JSFIX_EXPECT(c, [&] { return sc::cdDivergence(&bars, optNum(kw.get(u"ma_period"_s)), sc::kDefaultPivotStrength, sc::kDefaultMaxSpan, age ? age->n : sc::kDefaultMaxAge); },
                         u"golden cd "_s + js::stringify(kw));
        }
        for (const OJson& c : g.get(u"inflections"_s)->items) {
            const OJson members = dec(*c.get(u"members"_s));
            JSFIX_EXPECT(c, [&] { return sc::screenInflections(members, strs(*c.get(u"timeframes"_s)), optNum(c.get(u"ma_period"_s))); }, u"golden inflections"_s);
        }
        for (const OJson& c : g.get(u"deviation"_s)->items) {
            const OJson bars = dec(*c.get(u"bars"_s));
            const OJson& kw = *c.get(u"kw"_s);
            const auto k = [&](const char16_t* key, double d) { const OJson* v = kw.get(QString::fromUtf16(key)); return v ? v->n : d; };
            JSFIX_EXPECT(c, [&] { return sc::deviationReview(&bars, k(u"period", sc::kDefaultDevPeriod), k(u"lookback", sc::kDefaultDevLookback), k(u"smooth", sc::kDefaultPressureSmooth),
                                                       k(u"z_extreme", sc::kDefaultZExtreme), k(u"keep", sc::kDefaultKeep)); },
                         u"golden deviation "_s + js::stringify(kw));
        }
    }

    void rs() {
        for (const OJson& c : fx_.get(u"rs"_s)->items) {
            OJson members = js::array();
            QList<OJson> holders;
            for (const OJson& m : c.get(u"members"_s)->items) {
                OJson mm = js::object();
                for (const auto& [k, v] : m.fields) {
                    if (k == u"bars") {
                        if (jsfix::isUndefined(&v)) continue;
                        mm.set(k, v.type == OJson::Number ? sets_[qsizetype(v.n)] : dec(v));
                    } else if (!jsfix::isUndefined(&v)) {
                        mm.set(k, dec(v));
                    }
                }
                members.items.append(mm);
            }
            OJson bh;
            const OJson* bench = setRef(c.get(u"bench"_s), bh);
            const OJson* w = c.get(u"windows"_s);
            const std::vector<double> windows = jsfix::isUndefined(w) ? sc::rsWindows() : numbers(*w);
            JSFIX_EXPECT(c, [&] { return sc::rsStrength(members, bench, u"SPY"_s, windows); }, u"rs "_s + js::stringify(*c.get(u"members"_s)).left(200));
        }
    }

    void weekly() {
        for (const OJson& c : fx_.get(u"weekly"_s)->items) {
            OJson h;
            const OJson* bars = c.get(u"set"_s) ? &sets_[qsizetype(c.get(u"set"_s)->n)] : (jsfix::isUndefined(c.get(u"raw"_s)) ? nullptr : (h = dec(*c.get(u"raw"_s)), &h));
            JSFIX_EXPECT(c, [&] { return sc::resampleWeekly(bars); }, u"weekly"_s);
        }
    }

    void cd() {
        int hits = 0;
        for (const OJson& c : fx_.get(u"cd"_s)->items) {
            const OJson& bars = sets_[qsizetype(c.get(u"set"_s)->n)];
            JSFIX_EXPECT(c, [&] { return sc::cdDivergence(&bars, optNum(c.get(u"ma"_s)), c.get(u"strength"_s)->n, c.get(u"maxSpan"_s)->n, c.get(u"maxAge"_s)->n); },
                         u"cd set "_s + QString::number(c.get(u"set"_s)->n));
            if (c.get(u"out"_s) && c.get(u"out"_s)->get(u"signal"_s)->type != OJson::Null) ++hits;
        }
        QVERIFY(hits > 40);
    }

    void inflections() {
        for (const OJson& c : fx_.get(u"inflections"_s)->items) {
            OJson members = js::array();
            for (const OJson& m : c.get(u"members"_s)->items) {
                OJson mm = js::object();
                for (const auto& [k, v] : m.fields) {
                    if (jsfix::isUndefined(&v)) continue;
                    if (k == u"frames") {
                        OJson f = js::object();
                        for (const auto& [tf, idx] : v.fields) f.set(tf, sets_[qsizetype(idx.n)]);
                        mm.set(k, f);
                    } else {
                        mm.set(k, dec(v));
                    }
                }
                members.items.append(mm);
            }
            JSFIX_EXPECT(c, [&] { return sc::screenInflections(members, strs(*c.get(u"timeframes"_s)), optNum(c.get(u"ma"_s))); }, u"inflections"_s);
        }
    }

    void deviation() {
        for (const OJson& c : fx_.get(u"deviation"_s)->items) {
            const OJson& bars = sets_[qsizetype(c.get(u"set"_s)->n)];
            const std::vector<double> kw = numbers(*c.get(u"kw"_s));
            JSFIX_EXPECT(c, [&] { return sc::deviationReview(&bars, kw[0], kw[1], kw[2], kw[3], kw[4]); }, u"deviation "_s + js::stringify(*c.get(u"kw"_s)));
        }
    }
};

QTEST_GUILESS_MAIN(TestScreener)
#include "tst_screener.moc"
