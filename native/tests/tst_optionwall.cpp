// engine/analysis/optionwall(optionwall.ts)对着原模块现跑的答案(tests/fixtures/gen_optionwall.mjs):黄金基线的 3 条链与 2 句报错、
// 一百多条合成的链(墙、GEX、翻转位、最大痛点、说明的每个字)、toRows、bsGamma、yearsToExpiry、GEX 各函数与 levelsForPa,逐字符比 JSON。
#include "analysis/optionwall.h"
#include "js_fixture.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using util::OJson;
namespace js = util::js;
namespace ow = analysis::optionwall;

namespace {
OJson rowsJson(const std::vector<ow::OptionRow>& rows) {
    OJson a = js::array();
    for (const ow::OptionRow& r : rows) a.items << r.toJson();
    return a;
}
std::vector<ow::OptionRow> rowsOf(const OJson& a) {
    std::vector<ow::OptionRow> out;
    for (const OJson& r : a.items) {
        ow::OptionRow row;
        row.strike = r.get(u"strike"_s)->n;
        row.right = r.get(u"right"_s)->s;
        row.oi = r.get(u"oi"_s)->n;
        row.oiMissing = r.get(u"oiMissing"_s)->b;
        row.volume = r.get(u"volume"_s)->n;
        if (r.get(u"gamma"_s)->type == OJson::Number) row.gamma = r.get(u"gamma"_s)->n;
        if (r.get(u"iv"_s)->type == OJson::Number) row.iv = r.get(u"iv"_s)->n;
        out.push_back(row);
    }
    return out;
}
OJson gexJson(const ow::Gex& g) { return js::object({{u"net"_s, js::N(g.net)}, {u"gross"_s, js::N(g.gross)}, {u"rows"_s, js::N(g.rows)}}); }
}  // namespace

class TestOptionWall : public QObject {
    Q_OBJECT
    OJson fx_;

private slots:
    void initTestCase() { fx_ = jsfix::load(u"optionwall.json"_s); }

    void constants() {
        QCOMPARE(ow::kMultiplier, fx_.get(u"constants"_s)->get(u"MULTIPLIER"_s)->n);
        QCOMPARE(double(ow::kMinStrikes), fx_.get(u"constants"_s)->get(u"MIN_STRIKES"_s)->n);
    }

    void analyze() {
        int n = 0;
        for (const OJson& c : fx_.get(u"analyze"_s)->items) {
            const QList<OJson> rows = dec(jsfix::stripUndefined(*c.get(u"rows"_s))).items;
            const double spot = dec(*c.get(u"spot"_s)).n, mult = dec(*c.get(u"multiplier"_s)).n;
            const OJson now = dec(*c.get(u"now"_s));
            const std::optional<double> nowMs = now.type == OJson::Number ? std::optional(now.n) : std::nullopt;
            JSFIX_EXPECT(c, [&] {
                const OJson r = ow::analyze(rows, spot, c.get(u"expiry"_s)->s, c.get(u"symbol"_s)->s, mult, nowMs, c.get(u"tradingClass"_s)->s);
                return js::object({{u"result"_s, r}, {u"levels"_s, ow::levelsForPa(r)}});
            }, c.get(u"name"_s)->s);
            ++n;
        }
        QVERIFY(n > 140);
    }

    void pieces() {
        for (const OJson& c : fx_.get(u"rows"_s)->items) {
            const QList<OJson> raw = dec(*c.get(u"raw"_s)).items;
            JSFIX_EXPECT(c, [&] { return rowsJson(ow::toRows(raw)); }, js::stringify(*c.get(u"raw"_s)));
        }
        for (const OJson& c : fx_.get(u"gamma"_s)->items) {
            const double got = ow::bsGamma(dec(*c.get(u"spot"_s)).n, c.get(u"strike"_s)->n, dec(*c.get(u"t"_s)).n, dec(*c.get(u"sigma"_s)).n);
            const OJson* want = c.get(u"out"_s) ? c.get(u"out"_s) : c.get(u"expect"_s);
            QCOMPARE(js::stringify(jsfix::enc(js::N(got))), js::stringify(*want));
        }
        for (const OJson& c : fx_.get(u"years"_s)->items) {
            const double got = ow::yearsToExpiry(c.get(u"expiry"_s)->s, c.get(u"now"_s)->n, c.get(u"symbol"_s)->s, c.get(u"tc"_s)->s);
            QVERIFY2(js::stringify(jsfix::enc(js::N(got))) == js::stringify(*c.get(u"out"_s)), qPrintable(js::stringify(c)));
        }
        for (const OJson& c : fx_.get(u"gex"_s)->items) {
            const auto rows = rowsOf(dec(*c.get(u"rows"_s)));
            const double spot = c.get(u"spot"_s)->n, t = c.get(u"t"_s)->n, mult = c.get(u"mult"_s)->n;
            std::vector<double> strikes;
            for (const OJson& s : dec(*c.get(u"strikes"_s)).items) strikes.push_back(s.n);
            JSFIX_SAME(*c.get(u"at"_s), gexJson(ow::gexAt(rows, spot, t, mult)), u"gexAt"_s);
            JSFIX_SAME(*c.get(u"bs"_s), gexJson(ow::bsGexAt(rows, spot * 1.01, t, mult)), u"bsGexAt"_s);
            QCOMPARE(ow::gexSignConflict(rows, spot, t, mult), c.get(u"conflict"_s)->b);
            const auto flip = ow::gammaFlip(rows, strikes, spot, t, mult);
            JSFIX_SAME(*c.get(u"flip"_s), flip ? js::N(*flip) : OJson::null(), u"gammaFlip"_s);
        }
        for (const OJson& c : fx_.get(u"levels"_s)->items) JSFIX_SAME(*c.get(u"out"_s), ow::levelsForPa(*c.get(u"r"_s)), js::stringify(*c.get(u"r"_s)));
    }
};

QTEST_GUILESS_MAIN(TestOptionWall)
#include "tst_optionwall.moc"
