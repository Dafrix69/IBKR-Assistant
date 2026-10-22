// engine/analysis/tracker_rules(trackerExits.ts、trackerDrawdown.ts、trackerSpotStop.ts)对着原模块(tests/fixtures/gen_tracker_rules.mjs):
// 钟点、下一次到点的时刻(夏令时那几天)、到点 / 作废、分批止盈的校验与该触发哪一档、档位记号的延续、追价节奏、正股与标的止损的确认秒数、
// 利润回撤的阈值 / 激活 / 最少回吐、标的止损价与它的设置校验——每一个输出逐字比。
#include "analysis/tracker_rules.h"
#include "util/jsobj.h"

#include <QFile>
#include <QTest>

#include <cmath>

using namespace ibkr;
using util::OJson;
namespace js = ibkr::util::js;
namespace a = ibkr::analysis;
using namespace Qt::StringLiterals;

namespace {
bool isUndef(const OJson* v) { return v && v->type == OJson::String && v->s == u"__undefined__"; }
/// 夹具里的 "__undefined__" → 删掉这一键(或空指针),"__NaN__" → NaN
OJson deU(const OJson& v) {
    if (v.type == OJson::String && v.s == u"__NaN__") return OJson::number(std::nan(""));
    if (v.type == OJson::Array) {
        OJson out = v;
        for (OJson& x : out.items) x = deU(x);
        return out;
    }
    if (v.type == OJson::Object) {
        OJson out = js::object();
        for (const auto& [k, x] : v.fields)
            if (!isUndef(&x)) out.set(k, deU(x));
        return out;
    }
    return v;
}
struct Arg {
    std::optional<OJson> v;
    const OJson* p() const { return v ? &*v : nullptr; }
};
Arg arg(const OJson* raw) {
    if (!raw || isUndef(raw)) return {};
    return {deU(*raw)};
}
/// 输出里的 NaN 写成 "__NaN__"(同夹具)
OJson nanMark(const OJson& v) {
    if (v.type == OJson::Number && std::isnan(v.n)) return OJson::string(u"__NaN__"_s);
    OJson out = v;
    for (OJson& x : out.items) x = nanMark(x);
    for (auto& f : out.fields) f.second = nanMark(f.second);
    return out;
}
QString S(const OJson& v) { return js::stringify(nanMark(v)); }
OJson optNum(const std::optional<double>& v) { return v ? OJson::number(*v) : OJson::null(); }
OJson optStr(const std::optional<QString>& v) { return v ? OJson::string(*v) : OJson::null(); }
OJson clockJson(const std::optional<a::BreachClock>& c) { return c ? js::object({{u"side"_s, js::S(c->side)}, {u"sinceMs"_s, js::N(c->sinceMs)}}) : OJson::null(); }
std::optional<a::BreachClock> clockOf(const OJson* v) {
    if (!v || v->type == OJson::Null) return std::nullopt;
    return a::BreachClock{v->get(u"side"_s)->s, v->get(u"sinceMs"_s)->n};
}
}  // namespace

class TestTrackerRules : public QObject {
    Q_OBJECT
    OJson fx;
    const QList<OJson>& at(const char16_t* k) const { return fx.get(QString::fromUtf16(k))->items; }

private slots:
    void initTestCase() {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR) + u"/tracker-rules.json"_s);
        QVERIFY(f.open(QIODevice::ReadOnly));
        fx = *util::parseOJson(QString::fromUtf8(f.readAll()));
    }

    void clocks() {
        for (const OJson& c : at(u"clock")) QCOMPARE(S(optNum(a::clockMinutes(arg(c.get(u"c"_s)).p()))), S(*c.get(u"out"_s)));
        for (const OJson& c : at(u"next")) QCOMPARE(S(optNum(a::nextOccurrenceMs(arg(c.get(u"c"_s)).p(), c.get(u"t"_s)->n))), S(*c.get(u"out"_s)));
        for (const OJson& c : at(u"timeExit")) {
            const OJson t = deU(*c.get(u"targets"_s));
            const double now = c.get(u"now"_s)->n;
            QCOMPARE(a::timeExitDue(t, now), c.get(u"due"_s)->b);
            QCOMPARE(a::timeExitLapsed(t, now), c.get(u"lapsed"_s)->b);
            QCOMPARE(S(a::withTimeExit(*c.get(u"result"_s), t, now)), S(*c.get(u"withExit"_s)));
        }
    }

    void tiers() {
        for (const OJson& c : at(u"tiers")) {
            const Arg tiers = arg(c.get(u"tiers"_s));
            const bool isLong = c.get(u"long"_s)->b;
            const OJson* price = c.get(u"price"_s);
            QCOMPARE(S(optStr(a::tiersIssue(tiers.p(), isLong, price))), S(*c.get(u"issue"_s)));
            QCOMPARE(double(a::dueTier(tiers.p(), isLong, price)), c.get(u"due"_s)->n);
            QCOMPARE(double(a::pendingTier(tiers.p())), c.get(u"pending"_s)->n);
            OJson targets = js::object();
            if (tiers.v) targets.set(u"take_profit_tiers"_s, *tiers.v);
            QCOMPARE(S(a::withTier(*c.get(u"result"_s), targets, isLong)), S(*c.get(u"withTier"_s)));
        }
        for (const OJson& c : at(u"carry")) {
            const Arg next = arg(c.get(u"next"_s)), prev = arg(c.get(u"prev"_s));
            const auto out = a::carryTierMarks(next.p(), prev.p());
            QCOMPARE(S(out ? *out : OJson::null()), S(*c.get(u"out"_s)));
        }
        for (const OJson& c : at(u"mark")) QCOMPARE(S(a::markTier(deU(*c.get(u"tiers"_s)), int(c.get(u"index"_s)->n), *c.get(u"patch"_s))), S(*c.get(u"out"_s)));
    }

    void chase() {
        for (const OJson& c : at(u"chase")) {
            const Arg reason = arg(c.get(u"reason"_s));
            QCOMPARE(a::isStopReason(reason.p()), c.get(u"isStop"_s)->b);
            const auto p = a::chaseProfile(deU(*c.get(u"auto"_s)), reason.p());
            QCOMPARE(S(js::object({{u"grace"_s, js::N(p.grace)}, {u"step"_s, js::N(p.step)}, {u"maxPct"_s, js::N(p.maxPct)}})), S(*c.get(u"out"_s)));
        }
    }

    void confirms() {
        for (const OJson& c : at(u"stock")) {
            const auto [r, clock] = a::confirmStockStop(*c.get(u"result"_s), c.get(u"long"_s)->b, arg(c.get(u"confirm"_s)).p(), clockOf(c.get(u"clock"_s)), c.get(u"now"_s)->n);
            QCOMPARE(S(js::array({r, clockJson(clock)})), S(*c.get(u"out"_s)));
        }
        for (const OJson& c : at(u"spotConfirm")) {
            const auto [r, clock] = a::confirmSpotStop(*c.get(u"row"_s), arg(c.get(u"confirm"_s)).p(), clockOf(c.get(u"clock"_s)), c.get(u"now"_s)->n);
            QCOMPARE(S(js::array({r, clockJson(clock)})), S(*c.get(u"out"_s)));
        }
    }

    void drawdown() {
        for (const OJson& c : at(u"dd")) {
            const OJson t = deU(*c.get(u"targets"_s));
            QCOMPARE(S(optNum(a::drawdownThreshold(t, arg(c.get(u"peak"_s)).p(), arg(c.get(u"basis"_s)).p(), arg(c.get(u"minute"_s)).p()))), S(*c.get(u"threshold"_s)));
            QCOMPARE(a::drawdownArmed(t, arg(c.get(u"peak"_s)).p(), arg(c.get(u"basis"_s)).p()), c.get(u"armed"_s)->b);
            QCOMPARE(a::drawdownFloorMet(t, arg(c.get(u"peakPrice"_s)).p(), arg(c.get(u"price"_s)).p()), c.get(u"floorMet"_s)->b);
        }
    }

    void spot() {
        for (const OJson& c : at(u"spot")) {
            const OJson t = deU(*c.get(u"targets"_s));
            const Arg spot = arg(c.get(u"spot"_s));
            QCOMPARE(a::hasSpotStop(t), c.get(u"has"_s)->b);
            const OJson* stopWant = c.get(u"stop"_s);
            const QString note = stopWant->type == OJson::Object ? stopWant->get(u"spot_note"_s)->s : QString();
            const auto stop = a::spotStop(t, u"SPX"_s, spot.p(), note);
            QCOMPARE(S(stop ? *stop : OJson::null()), S(*stopWant));
            QCOMPARE(S(optStr(a::spotStopIssue(t, c.get(u"sec"_s)->s, u"SPX"_s, spot.p()))), S(*c.get(u"issue"_s)));
        }
    }
};

QTEST_GUILESS_MAIN(TestTrackerRules)
#include "tst_tracker_rules.moc"
