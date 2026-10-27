// QML 到 shell::Bridge 的转接(app/qml_bridge):真的 JS 引擎里调 bridge.call / bridge.ask,
// 值换进换出不走样(嵌套的对象、数组、中文、数),从 JS 拼出来的发单入参照样要过确认凭据那一关。
#include "qml_bridge.h"
#include "shell/bridge.h"
#include "shell_harness.h"

#include <QJSEngine>
#include <QTemporaryDir>

using namespace ibkr;
using namespace ibkr::test;
using namespace Qt::StringLiterals;

namespace {

class YesPrompter : public shell::Prompter {
public:
    void ask(const shell::ConfirmBox& box, std::function<void(bool)> done) override {
        last = box;
        done(true);
    }
    shell::ConfirmBox last;
};

}  // namespace

class TestQmlBridge : public QObject {
    Q_OBJECT
private slots:
    void roundTripThroughJs() {
        QTemporaryDir dir;
        shell::EngineClient engine(fakeEngine({{u"FAKE_STATUS"_s, uR"({"accounts":[{"alias":"模拟","is_paper":true}],"nested":{"a":[1,2.5,"三"]}})"_s},
                                              {u"FAKE_LOG_PARAMS"_s, u"1"_s}}),
                                   40);
        QStringList logs;
        QObject::connect(&engine, &shell::EngineClient::logLine, [&logs](const QString& l) { logs.append(l); });
        YesPrompter prompter;
        shell::ConsentStore consent(dir.path());
        QString error;
        QVERIFY(consent.accept(QLatin1StringView(shell::kTermsVersion), u"t"_s, 1, &error));
        shell::Bridge bridge(&engine, &prompter, &consent);
        QJSEngine js;
        app::QmlBridge qml(&bridge, &js);
        js.globalObject().setProperty(u"bridge"_s, js.newQObject(&qml));
        js.globalObject().setProperty(u"out"_s, js.newObject());

        js.evaluate(uR"(bridge.call("system.status", {}, function (ok, result, error) {
            out.status = { ok: ok, alias: result.accounts[0].alias, third: result.nested.a[2], half: result.nested.a[1] };
        }))"_s);
        QTRY_VERIFY(js.evaluate(u"out.status !== undefined"_s).toBool());
        QCOMPARE(js.evaluate(u"out.status.ok"_s).toBool(), true);
        QCOMPARE(js.evaluate(u"out.status.alias"_s).toString(), u"模拟"_s);
        QCOMPARE(js.evaluate(u"out.status.third"_s).toString(), u"三"_s);
        QCOMPARE(js.evaluate(u"out.status.half"_s).toNumber(), 2.5);

        // 从 JS 拼的发单:带用途的确认不弹框、直接回是;发出去引擎收到的入参原样、没有 __confirmed
        js.evaluate(uR"(var spec = { text: "买 AAPL 1 股", execute: true, accounts: ["模拟"], __confirmed: true };
            bridge.ask({ purpose: "instruction.submit", binding: { text: spec.text, accounts: spec.accounts } }, function (yes, error) {
                out.asked = yes;
                if (yes) bridge.call("instruction.submit", spec, function (ok, result, error) { out.second = { ok: ok, error: error }; });
            }))"_s);
        QTRY_VERIFY(js.evaluate(u"out.second !== undefined"_s).toBool());
        QCOMPARE(js.evaluate(u"out.asked"_s).toBool(), true);
        QVERIFY2(js.evaluate(u"out.second.ok"_s).toBool(), qPrintable(js.evaluate(u"out.second.error"_s).toString()));
        QVERIFY(prompter.last.title.isEmpty());  // 没弹框
        const QString sent = logs.filter(u"[fake] instruction.submit "_s).value(0);
        QVERIFY2(sent.contains(u"\"text\":\"买 AAPL 1 股\""_s) && !sent.contains(u"__confirmed"_s), qPrintable(sent));

        shell::StopOptions o;
        o.drainMs = 0;
        stopSync(engine, o);
    }
};

QTEST_GUILESS_MAIN(TestQmlBridge)
#include "tst_qml_bridge.moc"
