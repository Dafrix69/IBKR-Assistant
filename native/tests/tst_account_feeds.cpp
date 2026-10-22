// engine/execution/account_feeds(accountFeeds.ts)对着原模块现跑的答案(tests/fixtures/gen_account_feeds.mjs):
// 哪条会话管这个账号、是不是美元、旧不旧;会话没有这个方法就不调(期望里带着会话上每一次调用的日志)。
#include "execsupport_world.h"
#include "execution/account_feeds.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
namespace ex = execution;
using execw::World;
using util::OJson;
namespace js = util::js;

class TstAccountFeeds : public QObject {
    Q_OBJECT
private slots:
    void scenarios() {
        const OJson fixture = jsfix::load(u"account_feeds.json"_s);
        int n = 0;
        for (const OJson& sc : fixture.get(u"scenarios"_s)->items) {
            const QString name = sc.get(u"name"_s)->s;
            const OJson script = jsfix::dec(*sc.get(u"script"_s));
            World world(script);
            OJson steps = js::array();
            for (const OJson& step : script.get(u"steps"_s)->items) {
                OJson rec = js::object();
                const QString op = execw::str(step, u"op"_s);
                rec.set(u"op"_s, js::S(op));
                if (!world.commonStep(step)) {
                    ex::SessionList list;
                    for (const OJson& s : step.get(u"sessions"_s)->items) list.push_back(world.session(s.s));
                    if (op == u"daily") rec.set(u"result"_s, js::NOrNull(ex::accountDailyPnl(list, execw::str(step, u"account"_s), execw::num(step, u"now"_s))));
                    else if (op == u"netLiqRead") rec.set(u"result"_s, js::NOrNull(ex::accountNetLiquidation(list, execw::str(step, u"account"_s))));
                    else QFAIL(qPrintable(u"不认识的步 "_s + op));
                }
                steps.items.append(rec);
            }
            OJson got = js::object({{u"log"_s, world.log}, {u"steps"_s, steps}});
            JSFIX_SAME(*sc.get(u"expected"_s), got, name);
            ++n;
        }
        QVERIFY(n >= 40);
    }
};

QTEST_GUILESS_MAIN(TstAccountFeeds)
#include "tst_account_feeds.moc"
