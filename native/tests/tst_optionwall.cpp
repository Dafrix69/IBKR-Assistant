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

    // gexWalls:手算的合成链。现价 100、乘数 100,用券商 gamma ⇒ 一行的 GEX = gamma × OI × 100 × 100² × 1% = gamma × OI × 10000
    void gexWalls() {
        const auto row = [](double k, const char16_t* right, double oi, std::optional<double> gamma) {
            ow::OptionRow r;
            r.strike = k;
            r.right = QString::fromUtf16(right);
            r.oi = oi;
            r.gamma = gamma;
            return r;
        };
        const std::vector<ow::OptionRow> rows{
            row(105, u"C", 1000, 0.01),  // +100k
            row(110, u"C", 3000, 0.01),  // +300k ← 看涨 GEX 最大
            row(110, u"P", 3500, 0.01),  // −350k ← 看跌 GEX 最大;110 净 −50k
            row(95, u"C", 500, 0.02),    // +100k
            row(95, u"P", 1000, 0.02),   // −200k;95 净 −100k
            row(90, u"P", 1500, 0.01),   // −150k ← 净绝对值最大
            row(120, u"C", 9000, std::nullopt),  // 没 gamma 也没 IV:不称
        };
        const OJson got = ow::gexWalls(rows, 100, 0.01);
        QCOMPARE(js::stringify(got), js::stringify(js::object({
            {u"call_gex_wall"_s, js::object({{u"strike"_s, js::N(110)}, {u"gex"_s, js::N(300000)}, {u"distance_pct"_s, js::N(10)}})},
            {u"put_gex_wall"_s, js::object({{u"strike"_s, js::N(110)}, {u"gex"_s, js::N(350000)}, {u"distance_pct"_s, js::N(10)}})},
            {u"max_gamma"_s, js::object({{u"strike"_s, js::N(90)}, {u"gex"_s, js::N(-150000)}, {u"distance_pct"_s, js::N(-10)}})},
        })));
        // 一样大取离现价近的(98 比 103 近),与先后无关
        const OJson tie = ow::gexWalls({row(103, u"C", 1000, 0.01), row(98, u"C", 1000, 0.01)}, 100, 0.01);
        QCOMPARE(tie.get(u"call_gex_wall"_s)->get(u"strike"_s)->n, 98.0);
        QCOMPARE(tie.get(u"put_gex_wall"_s)->type, OJson::Null);
        // 什么都称不出来:三道都是 null
        const OJson none = ow::gexWalls({row(100, u"C", 1000, std::nullopt), row(100, u"P", 0, 0.01)}, 100, 0.01);
        for (const char16_t* k : {u"call_gex_wall", u"put_gex_wall", u"max_gamma"}) QCOMPARE(none.get(QString::fromUtf16(k))->type, OJson::Null);
        // 没有券商 gamma 只有 IV:按 BS 在现价处重算,和 bsGamma 对得上
        ow::OptionRow ivOnly = row(100, u"C", 1000, std::nullopt);
        ivOnly.iv = 0.2;
        const double want = ow::bsGamma(100, 100, 0.01, 0.2) * 1000 * 10000;
        QCOMPARE(ow::gexWalls({ivOnly}, 100, 0.01).get(u"call_gex_wall"_s)->get(u"gex"_s)->n, std::round(want));
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
