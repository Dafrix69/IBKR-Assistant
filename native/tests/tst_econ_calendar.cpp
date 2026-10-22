// engine/analysis/econ_calendar(econCalendar.ts)对着原模块现跑的答案(tests/fixtures/gen_econ_calendar.mjs):表、内置日程与每周初请、
// 美东日期 + 钟点、联邦假日、家族与讲话人、日历源载荷的解析(写坏的形状与时刻)、三路合并、口径校验,逐字符比 JSON。本机时区按 Asia/Shanghai。
#include "analysis/econ_calendar.h"
#include "js_fixture.h"
#include "util/intel_dateparse.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using util::OJson;
namespace js = util::js;
namespace ec = analysis::econ_calendar;

namespace {
const QTimeZone& shanghai() {
    static const QTimeZone tz(QByteArrayLiteral("Asia/Shanghai"));
    return tz;
}
OJson list(const QList<OJson>& l) { return js::array(l); }
QList<OJson> items(const OJson* v) { return dec(*v).items; }
OJson releases(const std::vector<ec::Release>& rs) {
    OJson a = js::array();
    for (const ec::Release& r : rs) a.items << r.toJson();
    return a;
}
}  // namespace

class TestEconCalendar : public QObject {
    Q_OBJECT
    OJson fx_;

private slots:
    void initTestCase() { fx_ = jsfix::load(u"econ-calendar.json"_s); }

    void tables() {
        const OJson& t = *fx_.get(u"tables"_s);
        QCOMPARE(js::stringify(ec::defaultEventsConfig()), js::stringify(*t.get(u"config"_s)));
        QCOMPARE(js::stringify(ec::lingerMinTable()), js::stringify(*t.get(u"linger"_s)));
        QCOMPARE(js::stringify(ec::starsTable()), js::stringify(*t.get(u"stars"_s)));
        QCOMPARE(js::stringify(ec::kindLabelTable()), js::stringify(*t.get(u"labels"_s)));
        QCOMPARE(js::stringify(releases(ec::builtinReleases())), js::stringify(*t.get(u"releases"_s)));
        QCOMPARE(js::stringify(js::strings(ec::builtinProblems())), js::stringify(*fx_.get(u"problems"_s)));
        for (const OJson& c : fx_.get(u"impact"_s)->items) QCOMPARE(ec::impactOfStars(dec(*c.get(u"s"_s)).n), c.get(u"out"_s)->s);
    }

    void dates() {
        for (const OJson& c : fx_.get(u"etEpoch"_s)->items) {
            const auto got = ec::etEpoch(c.get(u"d"_s)->s, c.get(u"t"_s)->s);
            QVERIFY2(js::stringify(js::NOrNull(got)) == js::stringify(*c.get(u"out"_s)), qPrintable(c.get(u"d"_s)->s + u' ' + c.get(u"t"_s)->s));
        }
        for (const OJson& c : fx_.get(u"holiday"_s)->items) QVERIFY2(ec::thursdayIsFederalHoliday(c.get(u"d"_s)->s) == c.get(u"out"_s)->b, qPrintable(c.get(u"d"_s)->s));
    }

    void builtin() {
        for (const OJson& c : fx_.get(u"claims"_s)->items) {
            const double from = dec(*c.get(u"from"_s)).n, to = dec(*c.get(u"to"_s)).n;
            JSFIX_EXPECT(c, [&] { return releases(ec::claimsReleases(from, to)); }, u"claims"_s);
        }
        for (const OJson& c : fx_.get(u"builtin"_s)->items) {
            const double from = dec(*c.get(u"from"_s)).n, to = dec(*c.get(u"to"_s)).n;
            JSFIX_EXPECT(c, [&] { return list(ec::builtinEvents(from, to)); }, u"builtinEvents %1 %2"_s.arg(from, 0, 'f', 0).arg(to, 0, 'f', 0));
        }
    }

    void family() {
        for (const OJson& c : fx_.get(u"family"_s)->items) QVERIFY2(ec::familyOf(c.get(u"t"_s)->s) == c.get(u"out"_s)->s, qPrintable(c.get(u"t"_s)->s));
        for (const OJson& c : fx_.get(u"starsFor"_s)->items)
            QCOMPARE(ec::starsFor(c.get(u"k"_s)->s, c.get(u"t"_s)->s, c.get(u"s"_s)->n), c.get(u"out"_s)->n);
    }

    void feed() {
        int n = 0;
        for (const OJson& c : fx_.get(u"feed"_s)->items) {
            const OJson* p = c.get(u"payload"_s);
            const OJson payload = dec(*p);
            const OJson* arg = jsfix::isUndefined(p) ? nullptr : &payload;
            JSFIX_EXPECT(c, [&] { return list(ec::parseFeed(arg, shanghai())); }, js::stringify(*p).left(300));
            ++n;
        }
        QVERIFY(n > 200);
    }

    void merge() {
        QList<QList<OJson>> builtinSets{ec::builtinEvents(util::v8DateParse(u"2026-10-12T00:00:00Z"_s), util::v8DateParse(u"2026-11-01T00:00:00Z"_s)),
                                        ec::builtinEvents(util::v8DateParse(u"2026-10-01T00:00:00Z"_s), util::v8DateParse(u"2027-02-01T00:00:00Z"_s)),
                                        {}};
        builtinSets << fx_.get(u"builtin4"_s)->items;
        for (const OJson& c : fx_.get(u"merge"_s)->items) {
            const auto& b = builtinSets[qsizetype(c.get(u"b"_s)->n)];
            const QList<OJson> feed = items(c.get(u"feed"_s)), custom = items(c.get(u"custom"_s));
            JSFIX_EXPECT(c, [&] { return list(ec::mergeEvents(b, feed, custom)); }, u"merge"_s);
        }
        for (const OJson& c : fx_.get(u"expires"_s)->items) QCOMPARE(ec::expiresAt(dec(*c.get(u"e"_s))), dec(*c.get(u"out"_s)).n);
    }

    void config() {
        const QList<OJson> bases = fx_.get(u"bases"_s)->items;
        for (const OJson& c : fx_.get(u"config"_s)->items) {
            const OJson* in = c.get(u"input"_s);
            const OJson input = dec(*in);
            const OJson* arg = jsfix::isUndefined(in) ? nullptr : &input;
            const OJson& base = bases[qsizetype(c.get(u"base"_s)->n)];
            JSFIX_EXPECT(c, [&] { return ec::normalizeEventsConfig(arg, base); }, js::stringify(*in));
        }
    }
};

QTEST_GUILESS_MAIN(TestEconCalendar)
#include "tst_econ_calendar.moc"
