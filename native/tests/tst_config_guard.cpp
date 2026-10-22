// 保序 JSON(shell/ordered_json)与配置恢复(shell/config_guard)对着原模块现算的结果:
// JSON.stringify(JSON.parse(…), null, 2) 一字不差、JSON.parse 不认的这边也不认;各种配置 / 备份组合的体检与恢复(真文件)。
#include "json_compare.h"
#include "shell/config_guard.h"

#include <QDir>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QTemporaryDir>
#include <QTest>

using namespace ibkr;
using namespace ibkr::shell;
using namespace Qt::StringLiterals;

namespace {
QJsonObject fixture() {
    QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/config-guard.json"));
    return f.open(QIODevice::ReadOnly) ? QJsonDocument::fromJson(f.readAll()).object() : QJsonObject();
}
}  // namespace

class TestConfigGuard : public QObject {
    Q_OBJECT
private slots:
    void roundtripMatchesJs() {
        const QJsonObject doc = fixture();
        QCOMPARE(doc.value(u"exitConfig"_s).toInt(), config::kExitConfig);
        for (const QJsonValue& v : doc.value(u"roundtrip"_s).toArray()) {
            const QJsonObject c = v.toObject();
            const QString text = c.value(u"text"_s).toString();
            const auto parsed = parseOJson(text);
            QVERIFY2(bool(parsed) == c.value(u"ok"_s).toBool(), qPrintable(text));
            if (parsed) QCOMPARE(stringifyOJson(*parsed, 2), c.value(u"out"_s).toString());
        }
    }

    void scenariosMatchJs() {
        const QJsonObject doc = fixture();
        const QTimeZone zone(doc.value(u"tz"_s).toString().toUtf8());
        QVERIFY(zone.isValid());
        for (const QJsonValue& v : doc.value(u"scenarios"_s).toArray()) {
            const QJsonObject s = v.toObject();
            const QString name = s.value(u"name"_s).toString();
            QTemporaryDir dir;
            const QString cfg = dir.filePath(u"settings.json"_s);
            const auto put = [](const QString& path, const QJsonValue& text) {
                if (!text.isString()) return;
                QFile f(path);
                QVERIFY(f.open(QIODevice::WriteOnly));
                f.write(text.toString().toUtf8());
            };
            put(cfg, s.value(u"current"_s));
            put(cfg + u".bak"_s, s.value(u"backup"_s));
            const config::Inspection in = config::inspect(cfg);
            const QJsonObject got{{u"exists"_s, in.exists}, {u"syntaxOk"_s, in.syntaxOk}, {u"hasSyntaxError"_s, !in.syntaxError.isEmpty()},
                                  {u"backupUsable"_s, in.backupUsable}, {u"hasBackupAt"_s, bool(in.backupAt)}, {u"sameAsCurrent"_s, in.sameAsCurrent}};
            const QString d1 = test::jsonDiff(s.value(u"inspect"_s), got);
            QVERIFY2(d1.isEmpty(), qPrintable(name + u" 体检:"_s + d1));

            QString error;
            const auto r = config::restoreBackup(cfg, doc.value(u"now"_s).toDouble(), &error, zone);
            const QJsonObject want = s.value(u"restore"_s).toObject();
            QCOMPARE(bool(r), want.value(u"ok"_s).toBool());
            if (r) {
                QCOMPARE(QJsonArray::fromStringList(r->closedGates), want.value(u"closedGates"_s).toArray());
                QCOMPARE(r->brokenCopy.isEmpty() ? QJsonValue() : QJsonValue(QFileInfo(r->brokenCopy).fileName()), want.value(u"brokenCopy"_s));
                QFile written(cfg);
                QVERIFY(written.open(QIODevice::ReadOnly));
                QCOMPARE(QString::fromUtf8(written.readAll()), want.value(u"written"_s).toString());
                QCOMPARE(QFileInfo(cfg).permissions() & (QFileDevice::ReadGroup | QFileDevice::ReadOther), QFileDevice::Permissions());
            } else {
                // V8 的 JSON 报错原文(Unexpected end of JSON input)搬不过来:只对前半句和我们自己的那几句
                const QString msg = want.value(u"error"_s).toString();
                QVERIFY2(error.startsWith(u"没有可用的备份:"_s), qPrintable(error));
                if (msg.endsWith(u"文件不存在"_s) || msg.endsWith(u"最外层不是一个 { } 对象"_s)) QCOMPARE(error, msg);
            }
            QStringList files = QDir(dir.path()).entryList(QDir::Files, QDir::Name);
            QCOMPARE(QJsonArray::fromStringList(files), s.value(u"files"_s).toArray());
        }
    }
};

QTEST_GUILESS_MAIN(TestConfigGuard)
#include "tst_config_guard.moc"
