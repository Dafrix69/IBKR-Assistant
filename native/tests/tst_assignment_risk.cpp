// engine/analysis/assignment_risk(assignmentRisk.ts)对着原模块现跑的答案(tests/fixtures/gen_assignment_risk.mjs):今天到期的实物交割腿、
// 各账户各标的的指派通知与给人看的那段话,逐字符比 JSON。
#include "analysis/assignment_risk.h"
#include "js_fixture.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using util::OJson;
namespace js = util::js;
namespace ar = analysis::assignment_risk;

class TestAssignmentRisk : public QObject {
    Q_OBJECT
    OJson fx_;

private slots:
    void initTestCase() { fx_ = jsfix::load(u"assignment-risk.json"_s); }

    void legs() {
        const QString today = fx_.get(u"today"_s)->s;
        QStringList cash;
        for (const OJson& s : fx_.get(u"cash"_s)->items) cash << s.s;
        const auto isCash = [&](const OJson* s) { return s && s->type == OJson::String && cash.contains(s->s); };
        for (const OJson& c : fx_.get(u"legsCases"_s)->items) {
            const QList<OJson> rows = dec(jsfix::stripUndefined(*c.get(u"rows"_s))).items;
            JSFIX_EXPECT(c, [&] { return js::array(ar::expiringOptionLegs(rows, today, isCash)); }, js::stringify(*c.get(u"rows"_s)).left(400));
        }
        for (const OJson& c : fx_.get(u"itm"_s)->items) {
            const OJson leg = js::object({{u"right"_s, *c.get(u"right"_s)}, {u"strike"_s, *c.get(u"strike"_s)}});
            QCOMPARE(ar::itmBy(leg, c.get(u"spot"_s)->n), c.get(u"out"_s)->n);
        }
    }

    void notices() {
        for (const OJson& c : fx_.get(u"notices"_s)->items) {
            const QList<OJson> legs = dec(*c.get(u"legs"_s)).items;
            const OJson spots = dec(*c.get(u"spots"_s));
            JSFIX_EXPECT(c, [&] { return js::array(ar::assignmentNotices(legs, spots)); }, js::stringify(*c.get(u"legs"_s)).left(400));
            const QList<OJson> got = ar::assignmentNotices(legs, spots);
            const QList<OJson>& texts = c.get(u"texts"_s)->items;
            QCOMPARE(got.size(), texts.size());
            for (qsizetype i = 0; i < got.size(); ++i) QCOMPARE(ar::noticeText(got[i]), texts[i].s);
        }
        for (const OJson& c : fx_.get(u"handTexts"_s)->items) QCOMPARE(ar::noticeText(*c.get(u"n"_s)), c.get(u"out"_s)->s);
    }
};

QTEST_GUILESS_MAIN(TestAssignmentRisk)
#include "tst_assignment_risk.moc"
