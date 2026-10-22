// 诊断包(shell/diagnostics)对着原模块(desktop/diagnostics.js)在同样的文件上现算的整份文本逐字对。
// 只差两处、都写明:配置读不出来时 V8 的 JSON 报错原文搬不过来(那一行只对前半句);摘要的第二行写 Qt 的版本(见 diagnostics.h)。
#include "shell/diagnostics.h"

#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>
#include <QTemporaryDir>
#include <QTest>

using namespace ibkr::shell;
using namespace Qt::StringLiterals;

namespace {

QJsonObject fixture() {
    QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/diagnostics.json"));
    return f.open(QIODevice::ReadOnly) ? QJsonDocument::fromJson(f.readAll()).object() : QJsonObject();
}

std::optional<OJson> parsed(const QJsonValue& v) { return v.isString() ? parseOJson(v.toString()) : std::nullopt; }

/// V8 的 JSON 报错原文 → 一个占位
QString normalize(QString text) {
    static const QRegularExpression v8(uR"((配置文件 <DIR>/broken\.json 读不出来:)[^\n]*)"_s);
    return text.replace(v8, u"\\1<JSON 报错>"_s);
}

}  // namespace

class TestDiagnostics : public QObject {
    Q_OBJECT
private slots:
    void reportsMatchJs() {
        const QJsonObject doc = fixture();
        QCOMPARE(doc.value(u"logTailLines"_s).toInt(), diagnostics::kLogTailLines);
        QTemporaryDir dir;
        const QJsonObject files = doc.value(u"files"_s).toObject();
        for (auto it = files.begin(); it != files.end(); ++it) {
            QFile f(dir.filePath(it.key()));
            QVERIFY(f.open(QIODevice::WriteOnly));
            f.write(it.value().toString().toUtf8());
        }
        for (const QJsonValue& rv : doc.value(u"reports"_s).toArray()) {
            const QJsonObject r = rv.toObject();
            diagnostics::Input in;
            in.app = *parseOJson(doc.value(u"app"_s).toString());
            in.configPath = dir.filePath(r.value(u"configFile"_s).toString());
            in.logPath = dir.filePath(r.value(u"logFile"_s).toString());
            if (r.value(u"oldLogFile"_s).isString()) in.oldLogPath = dir.filePath(r.value(u"oldLogFile"_s).toString());
            if (r.value(u"engine"_s).isObject()) {
                const QJsonObject e = r.value(u"engine"_s).toObject();
                diagnostics::Engine eng;
                eng.running = e.value(u"running"_s).toBool();
                eng.restarts = e.value(u"restarts"_s).toInt();
                eng.status = parsed(e.value(u"status"_s));
                eng.selftest = parsed(e.value(u"selftest"_s));
                eng.backups = parsed(e.value(u"backups"_s));
                for (const QJsonValue& x : e.value(u"errors"_s).toArray()) eng.errors << x.toString();
                in.engine = eng;
            }
            in.extra = parsed(r.value(u"extra"_s));
            in.now = doc.value(u"now"_s).toDouble();
            in.homedir = u"/Users/zhangsan"_s;
            const QString name = r.value(u"name"_s).toString();
            const QString report = normalize(diagnostics::buildReport(in).replace(dir.path(), u"<DIR>"_s));
            const QString want = normalize(r.value(u"report"_s).toString());
            if (report != want) {
                const QStringList a = report.split(u'\n'), b = want.split(u'\n');
                for (qsizetype i = 0; i < std::min(a.size(), b.size()); ++i)
                    QVERIFY2(a[i] == b[i], qPrintable(u"%1 第 %2 行\n实际 %3\n期望 %4"_s.arg(name).arg(i + 1).arg(a[i].left(200), b[i].left(200))));
                QCOMPARE(a.size(), b.size());
            }
            const QString summary = diagnostics::buildSummary(in).replace(dir.path(), u"<DIR>"_s);
            QCOMPARE(summary, r.value(u"summary"_s).toString().replace(u"Electron ? · Node ?"_s, u"Qt 6.12.0"_s));
        }
    }

    void tailsAndFileName() {
        const QJsonObject doc = fixture();
        QTemporaryDir dir;
        const QJsonObject files = doc.value(u"files"_s).toObject();
        for (auto it = files.begin(); it != files.end(); ++it) {
            QFile f(dir.filePath(it.key()));
            QVERIFY(f.open(QIODevice::WriteOnly));
            f.write(it.value().toString().toUtf8());
        }
        for (const QJsonValue& tv : doc.value(u"tails"_s).toArray()) {
            const QJsonObject t = tv.toObject();
            const diagnostics::Tail got = diagnostics::tailFile(dir.filePath(t.value(u"file"_s).toString()), 3);
            QCOMPARE(got.ok, t.value(u"ok"_s).toBool());
            QCOMPARE(got.total, t.value(u"total"_s).toInt());
            QCOMPARE(QJsonArray::fromStringList(got.lines), t.value(u"lines"_s).toArray());
            if (!got.ok) QCOMPARE(got.error, t.value(u"error"_s).toString());
        }
        QCOMPARE(diagnostics::defaultFileName(doc.value(u"now"_s).toDouble(), QTimeZone(doc.value(u"tz"_s).toString().toUtf8())), doc.value(u"fileName"_s).toString());
    }
};

QTEST_GUILESS_MAIN(TestDiagnostics)
#include "tst_diagnostics.moc"
