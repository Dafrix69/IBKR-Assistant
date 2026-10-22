// AssignmentWatchService(services/assignmentWatch.ts)对着原模块现跑的答案:脚本驱动的假 router + 真的交易库(审计)+ 虚拟钟。
// 夹具:fixtures/svc_assignment.json(gen_svc_assignment.mjs)。
#include "orchestrate/services/assignment_watch.h"
#include "svc_world.h"

#include <QTest>

using namespace svcw;

namespace {

std::optional<ibkr::domain::EtNow> etOf(const OJson& a) {
    const OJson* v = a.get(u"at"_s);
    if (!v) return std::nullopt;
    ibkr::domain::EtNow e;
    e.epochMs = num(*v, u"epochMs"_s);
    e.date = str(*v, u"date"_s);
    e.minutes = num(*v, u"minutes"_s);
    e.seconds = num(*v, u"seconds"_s);
    return e;
}

Svc buildAssignment(World&, Host& host, const OJson&, Runner&) {
    auto svc = std::make_shared<AssignmentWatchService>(host);
    Svc s;
    s.methods[u"tickOnce"_s] = [svc](OJson a) -> Task<OJson> { co_return js::N(co_await svc->tickOnce(etOf(a))); };
    s.gets[u"inWindow"_s] = [svc](const OJson& a) { return js::B(svc->inWindow(*etOf(a))); };
    s.ops[u"start"_s] = [svc](const OJson& step, OJson&) { svc->start(int(num(step, u"tickMs"_s))); };
    s.ops[u"stop"_s] = [svc](const OJson&, OJson&) { svc->stop(); };
    s.stop = [svc] { svc->stop(); };
    return s;
}

}  // namespace

class TstSvcAssignment : public QObject {
    Q_OBJECT
private slots:
    void scenarios() {
        const OJson fx = jsfix::load(u"svc_assignment.json"_s);
        const OJson& base = *fx.get(u"base"_s);
        QStringList failures;
        int n = 0;
        for (const OJson& sc : fx.get(u"scenarios"_s)->items) {
            const QString what = sc.get(u"name"_s)->s;
            if (qEnvironmentVariableIsSet("SVC_TRACE")) fprintf(stderr, "scenario %s\n", qPrintable(what));
            const OJson script = jsfix::dec(*sc.get(u"script"_s));
            Runner runner(script, base, buildAssignment);
            const OJson got = runner.run();
            if (qEnvironmentVariableIsSet("SVC_DUMP") && what == qEnvironmentVariable("SVC_DUMP")) {
                QFile f(QDir::tempPath() + u"/svc_got.json"_s);
                if (f.open(QIODevice::WriteOnly)) f.write(js::stringify(jsfix::enc(got)).toUtf8());
            }
            if (!jsfix::same(*sc.get(u"expected"_s), got, what)) failures.append(what);
            ++n;
        }
        QVERIFY2(failures.isEmpty(), qPrintable(failures.join(u"\n"_s)));
        QVERIFY(n > 0);
    }
};

QTEST_GUILESS_MAIN(TstSvcAssignment)
#include "tst_svc_assignment.moc"
