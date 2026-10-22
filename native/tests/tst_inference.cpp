// engine/analysis/inference(inference.ts)对着原模块现跑的答案(tests/fixtures/gen_inference.mjs),逐字比 JSON。
#include "analysis/inference.h"
#include "js_fixture.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using util::OJson;
namespace js = util::js;
namespace inf = analysis::inference;

namespace {
double num(const OJson* v) { return jsfix::num(v); }
std::vector<double> nums(const OJson* v) {
    std::vector<double> out;
    for (const OJson& x : v->items) out.push_back(dec(x).n);
    return out;
}
std::vector<inf::Clustered> clustered(const OJson* v) {
    std::vector<inf::Clustered> out;
    for (const OJson& o : v->items) out.push_back({num(o.get(u"value"_s)), o.get(u"cluster"_s)->s});
    return out;
}
OJson iv(const std::optional<inf::Interval>& i) { return i ? js::object({{u"lo"_s, js::N(i->lo)}, {u"hi"_s, js::N(i->hi)}}) : OJson::null(); }
OJson mi(const std::optional<inf::MeanInterval>& i) {
    return i ? js::object({{u"mean"_s, js::N(i->mean)}, {u"lo"_s, js::N(i->lo)}, {u"hi"_s, js::N(i->hi)}}) : OJson::null();
}
OJson di(const std::optional<inf::DiffInterval>& i) {
    return i ? js::object({{u"diff"_s, js::N(i->diff)}, {u"lo"_s, js::N(i->lo)}, {u"hi"_s, js::N(i->hi)}}) : OJson::null();
}
}  // namespace

class TestInference : public QObject {
    Q_OBJECT
    OJson fx_;

private slots:
    void initTestCase() { fx_ = jsfix::load(u"inference.json"_s); }

    void tDistribution() {
        for (const OJson& c : fx_.get(u"gamma"_s)->items) JSFIX_SAME(*c.get(u"out"_s), js::N(inf::logGamma(num(c.get(u"x"_s)))), u"logGamma"_s);
        for (const OJson& c : fx_.get(u"beta"_s)->items)
            JSFIX_SAME(*c.get(u"out"_s), js::N(inf::incompleteBeta(num(c.get(u"x"_s)), num(c.get(u"a"_s)), num(c.get(u"b"_s)))), u"incompleteBeta"_s);
        for (const OJson& c : fx_.get(u"tcdf"_s)->items) JSFIX_SAME(*c.get(u"out"_s), js::N(inf::tCdf(num(c.get(u"t"_s)), num(c.get(u"df"_s)))), u"tCdf"_s);
        for (const OJson& c : fx_.get(u"tq"_s)->items) JSFIX_SAME(*c.get(u"out"_s), js::N(inf::tQuantile(num(c.get(u"p"_s)), num(c.get(u"df"_s)))), u"tQuantile"_s);
    }

    void intervals() {
        for (const OJson& c : fx_.get(u"wilson"_s)->items) JSFIX_SAME(*c.get(u"out"_s), iv(inf::wilsonInterval(num(c.get(u"s"_s)), num(c.get(u"n"_s)))), u"wilson"_s);
        for (const OJson& c : fx_.get(u"mean"_s)->items) JSFIX_SAME(*c.get(u"out"_s), mi(inf::meanInterval(nums(c.get(u"xs"_s)), num(c.get(u"level"_s)))), u"mean"_s);
        for (const OJson& c : fx_.get(u"median"_s)->items) JSFIX_SAME(*c.get(u"out"_s), iv(inf::medianInterval(nums(c.get(u"xs"_s)), num(c.get(u"level"_s)))), u"median"_s);
        for (const OJson& c : fx_.get(u"cmean"_s)->items)
            JSFIX_SAME(*c.get(u"out"_s), mi(inf::clusteredMeanInterval(clustered(c.get(u"a"_s)), num(c.get(u"level"_s)))), u"clusteredMean"_s);
        for (const OJson& c : fx_.get(u"cdiff"_s)->items)
            JSFIX_SAME(*c.get(u"out"_s), di(inf::clusteredDiffInterval(clustered(c.get(u"a"_s)), clustered(c.get(u"b"_s)), num(c.get(u"level"_s)))), u"clusteredDiff"_s);
        for (const OJson& c : fx_.get(u"cwilson"_s)->items) {
            std::vector<inf::ClusteredHit> hits;
            for (const OJson& h : c.get(u"hits"_s)->items) hits.push_back({h.get(u"hit"_s)->b, h.get(u"cluster"_s)->s});
            JSFIX_SAME(*c.get(u"out"_s), iv(inf::clusteredWilsonInterval(hits)), u"clusteredWilson"_s);
        }
        for (const OJson& c : fx_.get(u"welch"_s)->items)
            JSFIX_SAME(*c.get(u"out"_s), di(inf::welchInterval(nums(c.get(u"a"_s)), nums(c.get(u"b"_s)), num(c.get(u"level"_s)))), u"welch"_s);
        for (const OJson& c : fx_.get(u"mw"_s)->items) {
            const auto z = inf::mannWhitneyZ(nums(c.get(u"a"_s)), nums(c.get(u"b"_s)));
            JSFIX_SAME(*c.get(u"out"_s), z ? js::N(*z) : OJson::null(), u"mannWhitney"_s);
        }
        for (const OJson& c : fx_.get(u"pdiff"_s)->items)
            JSFIX_SAME(*c.get(u"out"_s), di(inf::proportionDiffInterval(num(c.get(u"x1"_s)), num(c.get(u"n1"_s)), num(c.get(u"x2"_s)), num(c.get(u"n2"_s)))),
                       u"proportionDiff"_s);
    }
};

QTEST_GUILESS_MAIN(TestInference)
#include "tst_inference.moc"
