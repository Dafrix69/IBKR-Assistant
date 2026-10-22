// 交易库的恢复(shell/store_guard)对着原模块(desktop/store-guard.js)在真文件上现算的结果:
// 备份列表的次序、给人看的那一行、恢复时主文件与 -wal / -shm 怎么挪、哪些名字与文件不认;外加 [fatal:store:…] 那几行。
#include "json_compare.h"
#include "shell/fatal_line.h"
#include "shell/store_guard.h"

#include <QCryptographicHash>
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
    QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/store-guard.json"));
    return f.open(QIODevice::ReadOnly) ? QJsonDocument::fromJson(f.readAll()).object() : QJsonObject();
}

/// 按生成器的造法造一份备份:SQLite 头 + extra 个 0x07,或者原样的文字
QByteArray make(const QJsonObject& recipe) {
    if (recipe.contains(u"db"_s)) return QByteArray("SQLite format 3\0", 16) + QByteArray(recipe.value(u"db"_s).toInt(), '\x07');
    return recipe.value(u"text"_s).toString().toLatin1();
}

void lay(const QString& dbPath, const QJsonObject& backups) {
    QDir().mkpath(store::backupDir(dbPath));
    for (auto it = backups.begin(); it != backups.end(); ++it) {
        QFile f(QDir(store::backupDir(dbPath)).filePath(it.key()));
        QVERIFY(f.open(QIODevice::WriteOnly));
        f.write(make(it.value().toObject()));
    }
}

}  // namespace

class TestStoreGuard : public QObject {
    Q_OBJECT
private slots:
    void listAndDescribe() {
        const QJsonObject doc = fixture();
        QCOMPARE(doc.value(u"exitStore"_s).toInt(), store::kExitStore);
        const QTimeZone zone(doc.value(u"tz"_s).toString().toUtf8());
        QTemporaryDir dir;
        const QString db = dir.filePath(u"trades.db"_s);
        lay(db, doc.value(u"backups"_s).toObject());
        const QList<store::Backup> list = store::listBackups(db);
        QJsonArray got, described;
        for (const store::Backup& b : list) {
            got.append(QJsonObject{{u"name"_s, b.name}, {u"reason"_s, b.reason}, {u"at"_s, b.at}, {u"bytes"_s, double(b.bytes)}});
            described.append(QJsonObject{{u"name"_s, b.name}, {u"line"_s, store::describeBackup(b, zone)}});
        }
        QString d = test::jsonDiff(doc.value(u"list"_s), got);
        QVERIFY2(d.isEmpty(), qPrintable(d));
        d = test::jsonDiff(doc.value(u"described"_s), described);
        QVERIFY2(d.isEmpty(), qPrintable(d));
        for (const QJsonValue& e : doc.value(u"extra"_s).toArray()) {
            const QJsonObject b = e.toObject().value(u"backup"_s).toObject();
            QCOMPARE(store::describeBackup({b[u"name"].toString(), b[u"reason"].toString(), b[u"at"].toString(), qint64(b[u"bytes"].toDouble())}, zone), e.toObject().value(u"line"_s).toString());
        }
    }

    void restoresMatchJs() {
        const QJsonObject doc = fixture();
        const QTimeZone zone(doc.value(u"tz"_s).toString().toUtf8());
        for (const QJsonValue& v : doc.value(u"restores"_s).toArray()) {
            const QJsonObject r = v.toObject();
            const QString name = r.value(u"name"_s).toString();
            QTemporaryDir dir;
            const QString db = dir.filePath(u"trades.db"_s);
            lay(db, doc.value(u"backups"_s).toObject());
            const QJsonObject setup = r.value(u"setupFiles"_s).toObject();
            for (auto it = setup.begin(); it != setup.end(); ++it) {
                QFile f(db + it.key());
                QVERIFY(f.open(QIODevice::WriteOnly));
                f.write(it.value().toString().toUtf8());
            }
            QString error;
            const QString aside = r.value(u"opts"_s).toObject().value(u"aside"_s).toString(u"before-restore"_s);
            const auto done = store::restoreBackup(db, r.value(u"target"_s).toString(), doc.value(u"now"_s).toDouble(), &error, aside, zone);
            const QJsonObject want = r.value(u"result"_s).toObject();
            QVERIFY2(bool(done) == want.value(u"ok"_s).toBool(), qPrintable(name + u" " + error));
            if (done) {
                QCOMPARE(done->restored, want.value(u"restored"_s).toString());
                QCOMPARE(done->kept.isEmpty() ? QJsonValue() : QJsonValue(QFileInfo(done->kept).fileName()), want.value(u"kept"_s));
            } else {
                QCOMPARE(error, want.value(u"error"_s).toString());
            }
            QStringList files = QDir(dir.path()).entryList(QDir::Files, QDir::Name);
            QCOMPARE(QJsonArray::fromStringList(files), r.value(u"files"_s).toArray());
            const QJsonObject contents = r.value(u"contents"_s).toObject();
            for (const QString& f : files) {
                QFile in(dir.filePath(f));
                QVERIFY(in.open(QIODevice::ReadOnly));
                QCOMPARE(QString::fromLatin1(QCryptographicHash::hash(in.readAll(), QCryptographicHash::Sha256).toHex()), contents.value(f).toString());
            }
        }
    }

    void fatalLinesMatchJs() {
        for (const QJsonValue& v : fixture().value(u"fatal"_s).toArray()) {
            const QJsonObject c = v.toObject();
            const auto got = storeFatalLine(c.value(u"text"_s).toString());
            const QJsonValue want = c.value(u"out"_s);
            QCOMPARE(bool(got), want.isObject());
            if (!got) continue;
            QCOMPARE(got->kind, want[u"kind"].toString());
            QCOMPARE(got->message, want[u"message"].toString());
            QCOMPARE(got->dbPath ? QJsonValue(*got->dbPath) : QJsonValue(), want[u"dbPath"]);
        }
    }
};

QTEST_GUILESS_MAIN(TestStoreGuard)
#include "tst_store_guard.moc"
