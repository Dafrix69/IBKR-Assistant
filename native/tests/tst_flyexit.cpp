// engine/analysis/flyexit(flyexit.ts)对着原模块现跑的答案(tests/fixtures/gen_flyexit.mjs):黄金基线的 18 个场景与合成的整天回放
// (每一分钟的蝶价、阶段、触发价,每一笔出手的话)、参数整理、方差与阶段、回撤档位、Bachelier 与反解,逐字符比 JSON;
// stdlib 的 erf 在 2 万个输入上逐位比。
#include "analysis/flyexit.h"
#include "js_fixture.h"
#include "util/jsmath.h"

#include <QTest>

#include <cstring>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using jsfix::enc;
using util::OJson;
namespace js = util::js;
namespace fx = analysis::flyexit;

namespace {
double num(const OJson* v) { return jsfix::num(v); }
double fromHex(const QString& h) {
    const quint64 u = h.toULongLong(nullptr, 16);
    double d;
    std::memcpy(&d, &u, 8);
    return d;
}
quint64 bits(double d) {
    quint64 u;
    std::memcpy(&u, &d, 8);
    return u;
}
/// 夹具里 "__undefined__" 的参数 → 空指针
const OJson* undefOr(const OJson* v, OJson& holder) {
    if (jsfix::isUndefined(v)) return nullptr;
    holder = dec(*v);
    return &holder;
}
OJson optN(const std::optional<double>& v) { return v ? js::N(*v) : OJson::null(); }
}  // namespace

class TestFlyExit : public QObject {
    Q_OBJECT
    OJson fx_;

private slots:
    void initTestCase() { fx_ = jsfix::load(u"flyexit.json"_s); }

    void erf() {
        int n = 0;
        for (const OJson& r : fx_.get(u"erf"_s)->items) {
            const double x = fromHex(r.items[0].s), want = fromHex(r.items[1].s), got = util::jsmath::stdlibErf(x);
            if (std::isnan(want) && std::isnan(got)) continue;
            QVERIFY2(bits(want) == bits(got), qPrintable(u"erf(%1):stdlib %2,C++ %3"_s.arg(x, 0, 'g', 17).arg(want, 0, 'g', 17).arg(got, 0, 'g', 17)));
            ++n;
        }
        QVERIFY(n > 19000);
    }

    void params() {
        for (const OJson& c : fx_.get(u"params"_s)->items) {
            OJson holder;
            const OJson* raw = undefOr(c.get(u"raw"_s), holder);
            JSFIX_EXPECT(c, [&] { return fx::paramsFrom(raw); }, u"paramsFrom "_s + js::stringify(*c.get(u"raw"_s)));
        }
        for (const OJson& c : fx_.get(u"minutes"_s)->items)
            QCOMPARE(js::stringify(enc(js::N(fx::minutesOf(c.get(u"s"_s)->s)))), js::stringify(*c.get(u"out"_s)));
        for (const OJson& c : fx_.get(u"fmt"_s)->items) QCOMPARE(fx::fmtMinute(num(c.get(u"m"_s))), c.get(u"out"_s)->s);
    }

    void varianceAndPhases() {
        for (const OJson& c : fx_.get(u"variance"_s)->items) {
            const double m = num(c.get(u"m"_s));
            QCOMPARE(js::stringify(enc(js::N(fx::remainingVariance(m)))), js::stringify(*c.get(u"R"_s)));
            QCOMPARE(js::stringify(enc(js::N(fx::sigmaRemaining(36, m)))), js::stringify(*c.get(u"s"_s)));
            QCOMPARE(js::stringify(enc(js::N(fx::sigmaRemaining(17.3, m)))), js::stringify(*c.get(u"s2"_s)));
        }
        QList<OJson> paramSets;
        for (const OJson& c : fx_.get(u"phase"_s)->items) {
            const OJson params = dec(*c.get(u"params"_s));
            paramSets << params;
            QCOMPARE(js::stringify(enc(js::N(fx::cutoffMinute(params)))), js::stringify(*c.get(u"cut"_s)));
            const double widths[] = {10, 20, 25, 40, 0.5};
            for (int i = 0; i < 5; ++i)
                QCOMPARE(js::stringify(enc(js::N(fx::switchMinute(widths[i], params)))), js::stringify(c.get(u"sw"_s)->items[i]));
            for (const OJson& p : c.get(u"phases"_s)->items) QCOMPARE(fx::phaseAt(num(&p.items[0]), p.items[1].n, params), p.items[2].s);
        }
        for (const OJson& c : fx_.get(u"trail"_s)->items) {
            const OJson& params = paramSets[qsizetype(c.get(u"p"_s)->n)];
            const double peak = c.get(u"peak"_s)->n, d = c.get(u"d"_s)->n, m = num(c.get(u"m"_s));
            QCOMPARE(js::stringify(enc(js::N(fx::trailPct(peak, d, m, params)))), js::stringify(*c.get(u"pct"_s)));
            QCOMPARE(js::stringify(enc(js::N(fx::trailStop(peak, d, m, params)))), js::stringify(*c.get(u"stop"_s)));
        }
    }

    void drawdown() {
        for (const OJson& c : fx_.get(u"drawdown"_s)->items) {
            OJson holder;
            const OJson* raw = undefOr(c.get(u"raw"_s), holder);
            const OJson cost = dec(*c.get(u"cost"_s));
            const std::optional<double> unit = cost.type == OJson::Null ? std::nullopt : std::optional(cost.n);
            const QString what = js::stringify(*c.get(u"raw"_s));
            QCOMPARE(js::stringify(enc(fx::drawdownTiers(raw))), js::stringify(*c.get(u"tiers"_s)));
            QCOMPARE(js::stringify(enc(fx::drawdownLate(raw))), js::stringify(*c.get(u"late"_s)));
            QCOMPARE(js::stringify(enc(js::N(fx::drawdownArm(raw)))), js::stringify(*c.get(u"arm"_s)));
            QVERIFY2(js::stringify(enc(fx::drawdownUsdPreset(unit, raw))) == js::stringify(*c.get(u"usd"_s)), qPrintable(what));
            QCOMPARE(js::stringify(enc(js::N(fx::drawdownFloor(raw)))), js::stringify(*c.get(u"floor"_s)));
        }
    }

    void pricing() {
        for (const OJson& c : fx_.get(u"price"_s)->items) {
            const double s = c.get(u"s"_s)->n, k = c.get(u"k"_s)->n, sigma = c.get(u"sigma"_s)->n;
            QCOMPARE(js::stringify(js::N(fx::bachelierCall(s, k, sigma))), js::stringify(*c.get(u"call"_s)));
            QCOMPARE(js::stringify(js::N(fx::bachelierPut(s, k, sigma))), js::stringify(*c.get(u"put"_s)));
            QCOMPARE(js::stringify(js::N(fx::modelPrice(*c.get(u"prof"_s), s, sigma))), js::stringify(*c.get(u"model"_s)));
            std::vector<fx::StructureLeg> legs;
            for (const OJson& l : c.get(u"legs"_s)->items) legs.push_back({l.get(u"strike"_s)->n, l.get(u"right"_s)->s, l.get(u"ratio"_s)->n});
            QCOMPARE(js::stringify(js::N(fx::structureValue(legs, s, sigma))), js::stringify(*c.get(u"structure"_s)));
        }
        // legValue 的 right 在夹具里没记:重算一遍对照 call / put
        for (const OJson& c : fx_.get(u"implied"_s)->items) {
            const double s = num(c.get(u"s"_s)), k = num(c.get(u"k"_s));
            QCOMPARE(js::stringify(enc(optN(fx::impliedSigmaLeg(s, k, num(c.get(u"price"_s)), c.get(u"right"_s)->s)))), js::stringify(*c.get(u"leg"_s)));
            QCOMPARE(js::stringify(enc(optN(fx::impliedSigmaFly(*c.get(u"prof"_s), s, num(c.get(u"fp"_s)))))), js::stringify(*c.get(u"fly"_s)));
        }
        for (const OJson& c : fx_.get(u"tranches"_s)->items) {
            const auto [a, b] = fx::trancheSizes(num(c.get(u"q"_s)));
            QCOMPARE(js::stringify(enc(js::array({js::N(a), js::N(b)}))), js::stringify(*c.get(u"out"_s)));
        }
    }

    void levelsAndZones() {
        for (const OJson& c : fx_.get(u"levels"_s)->items) {
            const OJson prof = dec(*c.get(u"prof"_s)), params = dec(*c.get(u"params"_s));
            JSFIX_SAME(*c.get(u"levels"_s), fx::levels(prof, params), u"levels "_s + js::stringify(*c.get(u"prof"_s)));
            JSFIX_SAME(*c.get(u"zones"_s), fx::zones(prof, params), u"zones "_s + js::stringify(*c.get(u"prof"_s)));
        }
    }

    void plans() {
        int n = 0;
        for (const OJson& c : fx_.get(u"plans"_s)->items) {
            OJson pHolder, aHolder;
            const OJson* raw = undefOr(c.get(u"params"_s), pHolder);
            const OJson* actual = undefOr(c.get(u"actual"_s), aHolder);
            if (actual && actual->type == OJson::Null) actual = nullptr;
            const OJson* note = c.get(u"emNote"_s);
            const std::optional<QString> emNote = jsfix::isUndefined(note) ? std::nullopt : std::optional(note->s);
            const OJson profile = dec(*c.get(u"profile"_s));
            const OJson spx = dec(*c.get(u"spx"_s)), fly = dec(*c.get(u"fly"_s));
            JSFIX_EXPECT(c, [&] { return fx::plan(profile, c.get(u"entry"_s)->s, spx, fly, raw, actual, emNote); },
                         u"plan "_s + c.get(u"name"_s)->s);
            ++n;
        }
        QVERIFY(n >= 90);
    }

    void simulateDirect() {
        const OJson& plans = *fx_.get(u"plans"_s);
        const auto byName = [&](const QString& name) -> const OJson& {
            for (const OJson& p : plans.items)
                if (p.get(u"name"_s)->s == name) return p;
            qFatal("没有 %s", qPrintable(name));
        };
        const OJson& base = byName(u"syn0"_s);
        for (const OJson& c : fx_.get(u"sims"_s)->items) {
            const QString name = c.get(u"name"_s)->s;
            const OJson params = dec(*c.get(u"params"_s));
            if (const OJson* spx = c.get(u"spx"_s)) {
                const OJson bars = dec(*spx), profile = dec(*c.get(u"profile"_s));
                const OJson* flyOwn = c.get(u"fly"_s);
                const OJson fly = jsfix::isUndefined(flyOwn) ? *base.get(u"fly"_s) : dec(*flyOwn);
                JSFIX_EXPECT(c, [&] { return fx::simulate(profile, c.get(u"entry"_s)->s, bars, fly, params, nullptr); }, u"simulate "_s + name);
                continue;
            }
            const OJson& p = byName(name);
            OJson aHolder;
            const OJson* actual = undefOr(p.get(u"actual"_s), aHolder);
            if (actual && actual->type == OJson::Null) actual = nullptr;
            const OJson profile = dec(*p.get(u"profile"_s));
            JSFIX_EXPECT(c, [&] { return fx::simulate(profile, p.get(u"entry"_s)->s, *p.get(u"spx"_s), *p.get(u"fly"_s), params, actual); }, u"simulate "_s + name);
        }
    }
};

QTEST_GUILESS_MAIN(TestFlyExit)
#include "tst_flyexit.moc"
