// engine/util/killswitch:只有手动熔断。起始文件的几种样子(没有、正常、老版本的自动熔断、坏的、顶层标量 / 数组)怎么读,
// engage / release 返回什么、之后读到什么、文件里写了什么;写不进去必须抛。at 是当时的钟:比"有没有"与形状(本机时区、到秒)。
#include "util/error.h"
#include "util/killswitch.h"

#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>
#include <QTemporaryDir>
#include <QTest>

using namespace ibkr::util;
using namespace Qt::StringLiterals;

namespace {
void put(const QString& path, const QByteArray& text) {
    QDir().mkpath(QFileInfo(path).absolutePath());
    QFile f(path);
    QVERIFY(f.open(QIODevice::WriteOnly | QIODevice::Truncate));
    f.write(text);
}
QJsonObject fileJson(const QString& path) {
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly)) return {};
    return QJsonDocument::fromJson(f.readAll()).object();
}
const QRegularExpression kIso(u"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}[+-]\\d{2}:\\d{2}$"_s);
}  // namespace

class TestKillSwitch : public QObject {
    Q_OBJECT
private slots:
    void startingFiles_data() {
        QTest::addColumn<QByteArray>("start");
        QTest::addColumn<bool>("engaged");
        QTest::addColumn<QString>("reason");
        QTest::newRow("正常、没合上") << QByteArray(R"({"engaged":false,"reason":"","at":""})") << false << QString();
        QTest::newRow("手动合上") << QByteArray(R"({"engaged":true,"reason":"用户按下暂停","at":"2026-10-01T09:00:00+08:00"})") << true << u"用户按下暂停"_s;
        QTest::newRow("老版本的手动熔断(带计数)")
            << QByteArray(R"({"engaged":true,"reason":"手动","at":"x","consecutive_failures":2,"consecutive_parse_failures":0,"auto":false})") << true << u"手动"_s;
        QTest::newRow("老版本的自动熔断:按没合上读")
            << QByteArray(R"j({"engaged":true,"reason":"连续 3 次失败后自动熔断(最近一次:x)","at":"x","consecutive_failures":3,"consecutive_parse_failures":0,"auto":true})j")
            << false << u"连续 3 次失败后自动熔断(最近一次:x)"_s;
        QTest::newRow("类型不对:engaged 是字符串") << QByteArray(R"({"engaged":"yes","reason":7})") << true << u"7"_s;
        QTest::newRow("空对象") << QByteArray("{}") << false << QString();
        QTest::newRow("坏的 JSON:按已熔断") << QByteArray("{\"engaged\":") << true << u"熔断状态文件损坏,已按安全侧处理"_s;
        QTest::newRow("顶层标量") << QByteArray("1") << false << QString();
        QTest::newRow("顶层数组") << QByteArray("[true]") << false << QString();
    }
    void startingFiles() {
        QFETCH(QByteArray, start);
        QFETCH(bool, engaged);
        QFETCH(QString, reason);
        QTemporaryDir dir;
        const QString file = dir.filePath(u"sub/breaker.json"_s);
        put(file, start);
        const BreakerState s = KillSwitch(file).state();
        QCOMPARE(s.engaged, engaged);
        QCOMPARE(s.reason, reason);
    }

    void noFileIsReleased() {
        QTemporaryDir dir;
        KillSwitch ks(dir.filePath(u"sub/breaker.json"_s));
        QVERIFY(QDir(dir.filePath(u"sub"_s)).exists());  // 构造时把目录建好
        const BreakerState s = ks.state();
        QVERIFY(!s.engaged);
        QVERIFY(s.reason.isEmpty());
        QVERIFY(s.at.isEmpty());
        QVERIFY(!QFile::exists(ks.path()));
    }

    void engageThenRelease() {
        QTemporaryDir dir;
        KillSwitch ks(dir.filePath(u"breaker.json"_s));
        const BreakerState on = ks.engage(u"用户在界面上按下暂停"_s);
        QVERIFY(on.engaged);
        QCOMPARE(on.reason, u"用户在界面上按下暂停"_s);
        QVERIFY(kIso.match(on.at).hasMatch());
        QVERIFY(ks.isEngaged());
        QCOMPARE(ks.state().reason, on.reason);
        // 文件只有这三项,键序 engaged / reason / at
        QFile f(ks.path());
        QVERIFY(f.open(QIODevice::ReadOnly));
        QVERIFY(f.readAll().startsWith(QString(u"{\"engaged\":true,\"reason\":\"用户在界面上按下暂停\",\"at\":\""_s).toUtf8()));
        QCOMPARE(fileJson(ks.path()).keys(), (QStringList{u"at"_s, u"engaged"_s, u"reason"_s}));

        const BreakerState off = ks.release();
        QVERIFY(!off.engaged);
        QCOMPARE(off.reason, u"由 user 手动解除"_s);
        QVERIFY(kIso.match(off.at).hasMatch());
        QVERIFY(!ks.isEngaged());
        QCOMPARE(ks.release(u"cli"_s).reason, u"由 cli 手动解除"_s);
    }

    // 老版本自动合上的那一份:读出来没合上;再手动合上一次,写回去的是新格式
    void legacyAutoFileThenEngage() {
        QTemporaryDir dir;
        const QString file = dir.filePath(u"breaker.json"_s);
        put(file, R"({"engaged":true,"reason":"连续 3 次失败后自动熔断","at":"x","consecutive_failures":3,"consecutive_parse_failures":0,"auto":true})");
        KillSwitch ks(file);
        QVERIFY(!ks.isEngaged());
        ks.engage(u"手动"_s);
        QVERIFY(ks.isEngaged());
        QVERIFY(!fileJson(file).contains(u"auto"_s));
    }

    // 写不进去时 engage 必须抛,而且文件里不能是已熔断——不然界面说熔断了,盯盘读到的却没熔断
    void writeFailureThrows() {
        QTemporaryDir dir;
        const QString sub = dir.path() + u"/ro"_s;
        QVERIFY(QDir().mkpath(sub));
        KillSwitch ks(sub + u"/breaker.json"_s);
        QVERIFY(QFile::setPermissions(sub, QFileDevice::ReadOwner | QFileDevice::ExeOwner));
        bool threw = false;
        try {
            ks.engage(u"测试"_s);
        } catch (const JsError& e) {
            threw = true;
            QVERIFY2(e.message().startsWith(u"EACCES: permission denied, open '"_s), qPrintable(e.message()));
        }
        QVERIFY(threw);
        QVERIFY(!ks.state().engaged);
        QFile::setPermissions(sub, QFileDevice::ReadOwner | QFileDevice::WriteOwner | QFileDevice::ExeOwner);
    }

    void localIsoShape() { QVERIFY(kIso.match(localIsoSeconds()).hasMatch()); }
};

QTEST_GUILESS_MAIN(TestKillSwitch)
#include "tst_killswitch.moc"
