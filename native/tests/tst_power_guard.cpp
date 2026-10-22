// 电源与合盖(shell/power_guard)对着原模块(desktop/power-watch.js、lid-guard.js)驱动同一串事件现算的输出逐步对,
// 外加 lid-guard.json 的读写。
#include "json_compare.h"
#include "shell/power_guard.h"

#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QTemporaryDir>
#include <QTest>

using namespace ibkr;
using namespace ibkr::shell::power;
using namespace Qt::StringLiterals;

namespace {

QJsonValue actionJson(const Action& a, bool withSet) {
    QJsonObject o{{u"log"_s, a.log.isEmpty() ? QJsonValue() : QJsonValue(a.log)},
                  {u"notify"_s, a.notify ? QJsonValue(QJsonObject{{u"title"_s, a.notify->title}, {u"body"_s, a.notify->body}}) : QJsonValue()}};
    if (withSet) o.insert(u"set"_s, a.set ? QJsonValue(*a.set) : QJsonValue());
    return o;
}

QJsonValue opt(const std::optional<bool>& v) { return v ? QJsonValue(*v) : QJsonValue(); }

}  // namespace

class TestPowerGuard : public QObject {
    Q_OBJECT
private slots:
    void scriptsMatchJs_data() {
        QTest::addColumn<QJsonObject>("script");
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/power.json"));
        QVERIFY(f.open(QIODevice::ReadOnly));
        const QJsonObject doc = QJsonDocument::fromJson(f.readAll()).object();
        QCOMPARE(doc.value(u"offDelayMs"_s).toDouble(), kOffDelayMs);
        int n = 0;
        for (const QJsonValue& c : doc.value(u"cases"_s).toArray())
            QTest::newRow(qPrintable(u"%1 #%2"_s.arg(c.toObject().value(u"kind"_s).toString()).arg(n++))) << c.toObject();
    }
    void scriptsMatchJs() {
        QFETCH(QJsonObject, script);
        const bool lid = script.value(u"kind"_s) == u"lid"_s;
        PowerWatch w;
        const QJsonObject init = script.value(u"init"_s).toObject();
        LidGuard g(init.value(u"enabled"_s) != QJsonValue(false), init.value(u"owned"_s) == QJsonValue(true));
        int i = 0;
        for (const QJsonValue& sv : script.value(u"steps"_s).toArray()) {
            const QJsonObject step = sv.toObject();
            const QString op = step.value(u"op"_s).toString();
            const QJsonObject args = step.value(u"args"_s).toObject();
            QJsonValue out, state;
            if (!lid) {
                const Action a = op == u"observe" ? w.observe(args) : op == u"suspend" ? w.suspend(args.value(u"now"_s).toDouble()) : w.resume(args.value(u"now"_s).toDouble());
                out = actionJson(a, false);
                state = QJsonObject{{u"onBattery"_s, opt(w.onBattery)}, {u"live"_s, w.live}, {u"warned"_s, w.warned}, {u"lidAwake"_s, w.lidAwake}};
            } else {
                if (op == u"observe") out = actionJson(g.observe(args), true);
                else if (op == u"done") out = actionJson(g.done(args.value(u"on"_s).toBool(), args.value(u"outcome"_s).toString(), args.value(u"detail"_s).toString()), true);
                else if (op == u"setEnabled") { g.setEnabled(args.value(u"enabled"_s).toBool()); out = QJsonValue(); }
                else if (op == u"wantsReading") out = g.wantsReading(int(args.value(u"live"_s).toDouble()));
                else if (op == u"quitAction") out = actionJson(g.quitAction(), true);
                else if (op == u"state") out = QJsonObject{{u"enabled"_s, g.enabled}, {u"owned"_s, g.owned}};
                state = QJsonObject{{u"enabled"_s, g.enabled}, {u"owned"_s, g.owned}, {u"sleepDisabled"_s, opt(g.sleepDisabled)}, {u"live"_s, g.live},
                                    {u"declined"_s, g.declined}, {u"restoreDeclined"_s, g.restoreDeclined}, {u"busy"_s, g.busy}};
            }
            const QString d1 = test::jsonDiff(step.value(u"out"_s), out);
            QVERIFY2(d1.isEmpty(), qPrintable(u"第 %1 步 %2:%3"_s.arg(i).arg(op, d1)));
            const QString d2 = test::jsonDiff(step.value(u"state"_s), state);
            QVERIFY2(d2.isEmpty(), qPrintable(u"第 %1 步 %2 之后的状态:%3"_s.arg(i).arg(op, d2)));
            ++i;
        }
    }

    void helpersMatchJs() {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/power.json"));
        QVERIFY(f.open(QIODevice::ReadOnly));
        for (const QJsonValue& hv : QJsonDocument::fromJson(f.readAll()).object().value(u"helpers"_s).toArray()) {
            const QJsonObject h = hv.toObject();
            const QString fn = h.value(u"fn"_s).toString();
            const QJsonValue in = h.value(u"input"_s);
            QJsonValue got;
            if (fn == u"parseSleepDisabled") got = opt(parseSleepDisabled(in.toString()));
            else if (fn == u"pmsetScript") got = pmsetScript(in.toBool());
            else if (fn == u"isCancelled") got = isCancelled(in.toObject().value(u"stderr"_s).toString(), in.toObject().value(u"message"_s).toString());
            else if (fn == u"minutesText") got = minutesText(in.toDouble());
            else if (fn == u"batteryNotice") {
                const Notice n = batteryNotice(in.toObject().value(u"live"_s).toInt(), in.toObject().value(u"lidAwake"_s).toBool());
                got = QJsonObject{{u"title"_s, n.title}, {u"body"_s, n.body}};
            }
            const QString d = test::jsonDiff(h.value(u"out"_s), got);
            QVERIFY2(d.isEmpty(), qPrintable(fn + u":"_s + d));
        }
    }

    void lidGuardFile() {
        QTemporaryDir dir;
        const QString path = dir.filePath(u"lid-guard.json"_s);
        LidGuard fresh = loadLidGuard(path);
        QVERIFY(fresh.enabled && !fresh.owned);
        LidGuard g(false, true);
        saveLidGuard(path, g);
        const LidGuard back = loadLidGuard(path);
        QVERIFY(!back.enabled && back.owned);
        QFile bad(path);
        QVERIFY(bad.open(QIODevice::WriteOnly));
        bad.write("{");
        bad.close();
        QVERIFY(loadLidGuard(path).enabled);
    }
};

QTEST_GUILESS_MAIN(TestPowerGuard)
#include "tst_power_guard.moc"
