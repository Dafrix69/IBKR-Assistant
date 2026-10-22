// engine/execution/ib_link(ibLink.ts)对着原模块现跑的答案(tests/fixtures/gen_ib_link.mjs):账号掩码、liveSessions、coveredAccounts、
// UpstreamWatch。会话是脚本驱动的假会话,期望里带着会话上每一次调用的日志。
#include "execsupport_world.h"
#include "execution/ib_link.h"

#include <QTest>

#include <map>

using namespace ibkr;
using namespace Qt::StringLiterals;
namespace ex = execution;
using execw::FakeSession;
using execw::World;
using util::OJson;
namespace js = util::js;

class TstIbLink : public QObject {
    Q_OBJECT
private slots:
    void redact() {
        const OJson fixture = jsfix::load(u"ib_link.json"_s);
        for (const OJson& c : fixture.get(u"redact"_s)->items) {
            QCOMPARE(ex::redactForLog(c.items[0].s), c.items[1].s);
        }
    }

    void scenarios() {
        const OJson fixture = jsfix::load(u"ib_link.json"_s);
        int n = 0;
        for (const OJson& sc : fixture.get(u"scenarios"_s)->items) {
            const QString name = sc.get(u"name"_s)->s;
            const OJson script = jsfix::dec(*sc.get(u"script"_s));
            World world(script);
            std::map<QString, ex::UpstreamWatch> watches;
            OJson steps = js::array();
            for (const OJson& step : script.get(u"steps"_s)->items) {
                OJson rec = js::object();
                const QString op = execw::str(step, u"op"_s);
                rec.set(u"op"_s, js::S(op));
                if (!world.commonStep(step)) {
                    ex::NamedSessions map;
                    if (const OJson* m = step.get(u"map"_s)) {
                        for (const OJson& p : m->items) map.emplace_back(p.items[0].s, world.session(p.items[1].s));
                    }
                    if (op == u"live") {
                        try {
                            OJson names = js::array();
                            for (const auto& s : ex::liveSessions(map, [](const QString& m) { return std::make_exception_ptr(util::JsError(m)); })) {
                                names.items.append(js::S(std::static_pointer_cast<FakeSession>(s)->name));
                            }
                            rec.set(u"result"_s, js::object({{u"ok"_s, names}}));
                        } catch (const util::JsError& e) {
                            rec.set(u"result"_s, js::object({{u"error"_s, js::S(e.message())}}));
                        }
                    } else if (op == u"covered") {
                        std::vector<contract::AccountConfig> accounts;
                        for (const OJson& a : step.get(u"accounts"_s)->items) {
                            contract::AccountConfig c;
                            c.alias = execw::str(a, u"alias"_s);
                            c.account_id = execw::str(a, u"account_id"_s);
                            c.connection = execw::str(a, u"connection"_s);
                            accounts.push_back(c);
                        }
                        rec.set(u"result"_s, js::object({{u"ok"_s, js::strings(ex::coveredAccounts(accounts, map))}}));
                    } else if (op == u"newWatch") {
                        watches[execw::str(step, u"id"_s)] = ex::UpstreamWatch();
                    } else if (op == u"watch") {
                        const QString connection = execw::str(step, u"connection"_s);
                        watches.at(execw::str(step, u"watch"_s)).watch(connection, world.session(execw::str(step, u"session"_s)), [&world, connection](bool up) {
                            world.rec(QString(), u"onLinkCallback"_s, js::array({js::S(connection), js::B(up)}));
                        });
                    } else if (op == u"clear") {
                        watches.at(execw::str(step, u"watch"_s)).clear();
                    } else if (op == u"lost") {
                        const auto v = watches.at(execw::str(step, u"watch"_s)).lost();
                        rec.set(u"result"_s, v ? js::N(*v) : js::Null());
                    } else {
                        QFAIL(qPrintable(u"不认识的步 "_s + op));
                    }
                }
                OJson lost = js::object();
                for (const auto& [id, w] : watches) {
                    const auto v = w.lost();
                    lost.set(id, v ? js::N(*v) : js::Null());
                }
                rec.set(u"lost"_s, lost);
                steps.items.append(rec);
            }
            OJson got = js::object({{u"log"_s, world.log}, {u"steps"_s, steps}});
            JSFIX_SAME(*sc.get(u"expected"_s), got, name);
            ++n;
        }
        QVERIFY(n >= 40);
    }
};

QTEST_GUILESS_MAIN(TstIbLink)
#include "tst_ib_link.moc"
