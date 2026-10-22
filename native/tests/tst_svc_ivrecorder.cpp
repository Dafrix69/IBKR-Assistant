// IvRecorderService(services/ivRecorder.ts)对着原模块现跑的答案:脚本驱动的假 router 与假盘口读取 + 真的交易库与日文件(fly-iv/)+ 虚拟钟。
// 夹具:fixtures/svc_ivrecorder.json(gen_svc_ivrecorder.mjs)。
#include "orchestrate/services/iv_recorder.h"
#include "svc_world.h"

#include <QTest>

using namespace svcw;

namespace {

Svc buildIv(World& w, Host& host, const OJson& script, Runner&) {
    auto svc = std::make_shared<IvRecorderService>(host, std::make_shared<ScriptedMarks>(&w, script));
    Svc s;
    s.methods[u"tickOnce"_s] = [svc](OJson a) -> Task<OJson> {
        const OJson* n = a.get(u"now"_s);
        co_return co_await svc->tickOnce(n ? std::optional<double>(js::num(n)) : std::nullopt);
    };
    s.methods[u"setEnabled"_s] = [svc](OJson a) -> Task<OJson> { co_return svc->setEnabled(flag(a, u"on"_s)); };
    s.methods[u"recordPlan"_s] = [svc](OJson a) -> Task<OJson> { co_return js::B(svc->recordPlan(*a.get(u"sample"_s))); };
    s.methods[u"status"_s] = [svc](const OJson&) -> Task<OJson> { co_return svc->status(); };
    s.gets[u"status"_s] = [svc](const OJson&) { return svc->status(); };
    s.gets[u"enabled"_s] = [svc](const OJson&) { return js::B(svc->enabled()); };
    s.ops[u"start"_s] = [svc](const OJson& step, OJson&) { svc->start(int(num(step, u"tickMs"_s))); };
    s.ops[u"stop"_s] = [svc](const OJson&, OJson&) { svc->stop(); };
    s.stop = [svc] { svc->stop(); };
    return s;
}

}  // namespace

class TstSvcIvRecorder : public QObject {
    Q_OBJECT
private slots:
    void scenarios() {
        const OJson fx = jsfix::load(u"svc_ivrecorder.json"_s);
        const OJson& base = *fx.get(u"base"_s);
        QStringList failures;
        int n = 0;
        for (const OJson& sc : fx.get(u"scenarios"_s)->items) {
            const QString what = sc.get(u"name"_s)->s;
            if (qEnvironmentVariableIsSet("SVC_TRACE")) fprintf(stderr, "scenario %s\n", qPrintable(what));
            const OJson script = jsfix::dec(*sc.get(u"script"_s));
            Runner runner(script, base, buildIv);
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

QTEST_GUILESS_MAIN(TstSvcIvRecorder)
#include "tst_svc_ivrecorder.moc"
