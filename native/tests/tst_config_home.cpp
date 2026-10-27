// 配置放到 userData 之后的第一次迁移(shell/config_home):从哪一份拷、拷了就不再动、权限只给自己、界面偏好一并带过来。
#include "shell/config_home.h"

#include <QDir>
#include <QFile>
#include <QTemporaryDir>
#include <QTest>

using namespace ibkr::shell;
using namespace Qt::StringLiterals;

namespace {
void put(const QString& path, const QByteArray& text) {
    QDir().mkpath(QFileInfo(path).absolutePath());
    QFile f(path);
    QVERIFY(f.open(QIODevice::WriteOnly | QIODevice::Truncate));
    f.write(text);
}
QByteArray read(const QString& path) {
    QFile f(path);
    return f.open(QIODevice::ReadOnly) ? f.readAll() : QByteArray();
}
}  // namespace

class TestConfigHome : public QObject {
    Q_OBJECT
private slots:
    void sourcesInOrder() {
        QCOMPARE(config_home::migrationSources(u"/r"_s, {u"/a"_s, u"/b"_s}, u"/x/settings.example.json"_s),
                 (QStringList{u"/r/config/settings.json"_s, u"/a/settings.json"_s, u"/b/settings.json"_s, u"/x/settings.example.json"_s}));
        // 没有仓库(装在别的机器上):从旧目录开始
        QCOMPARE(config_home::migrationSources(QString(), {u"/a"_s}, u"/x/settings.example.json"_s),
                 (QStringList{u"/a/settings.json"_s, u"/x/settings.example.json"_s}));
    }

    void copiesTheFirstThatExists() {
        QTemporaryDir tmp;
        const QString repo = tmp.filePath(u"repo"_s), legacy = tmp.filePath(u"IBKR-Assistant"_s), example = tmp.filePath(u"res/settings.example.json"_s);
        put(legacy + u"/settings.json"_s, "legacy");
        put(example, "example");
        const QString target = config_home::configPath(tmp.filePath(u"Datrix"_s));
        // 仓库那份不在:用旧目录的
        auto m = config_home::migrate(target, config_home::migrationSources(repo, {legacy}, example));
        QCOMPARE(m.from, legacy + u"/settings.json"_s);
        QVERIFY(m.error.isEmpty() && !m.fromExample());
        QCOMPARE(read(target), QByteArray("legacy"));
        QCOMPARE(QFile::permissions(target) & (QFileDevice::ReadGroup | QFileDevice::ReadOther), QFileDevice::Permissions());
        // 已经有了:什么也不做,哪怕仓库那份后来出现了
        put(repo + u"/config/settings.json"_s, "repo");
        m = config_home::migrate(target, config_home::migrationSources(repo, {legacy}, example));
        QVERIFY(m.from.isEmpty());
        QCOMPARE(read(target), QByteArray("legacy"));
        // 旧的那几份原样留着
        QCOMPARE(read(legacy + u"/settings.json"_s), QByteArray("legacy"));
    }

    void repoFirstThenExample() {
        QTemporaryDir tmp;
        const QString repo = tmp.filePath(u"repo"_s), example = tmp.filePath(u"settings.example.json"_s);
        put(repo + u"/config/settings.json"_s, "repo");
        put(tmp.filePath(u"old/settings.json"_s), "old");
        put(example, "example");
        const QString a = tmp.filePath(u"A/settings.json"_s);
        QCOMPARE(config_home::migrate(a, config_home::migrationSources(repo, {tmp.filePath(u"old"_s)}, example)).from, repo + u"/config/settings.json"_s);
        QCOMPARE(read(a), QByteArray("repo"));
        // 什么都没有,只有示例:从示例建,算"新建"
        const QString b = tmp.filePath(u"B/settings.json"_s);
        const auto m = config_home::migrate(b, config_home::migrationSources(tmp.filePath(u"none"_s), {}, example));
        QVERIFY(m.fromExample());
        QCOMPARE(read(b), QByteArray("example"));
        // 连示例都没有:不建,也不算错
        const auto none = config_home::migrate(tmp.filePath(u"C/settings.json"_s), {tmp.filePath(u"missing.json"_s)});
        QVERIFY(none.from.isEmpty() && none.error.isEmpty());
        QVERIFY(!QFile::exists(tmp.filePath(u"C/settings.json"_s)));
    }

    void carriesUiPrefsOnce() {
        QTemporaryDir tmp;
        const QString old = tmp.filePath(u"IBKR-Assistant"_s), now = tmp.filePath(u"Datrix"_s);
        put(old + u"/qt-settings.ini"_s, "[market]\nsymbol=SPX\n");
        QVERIFY(config_home::carryPrefs({tmp.filePath(u"none"_s), old}, now));
        QCOMPARE(read(now + u"/qt-settings.ini"_s), QByteArray("[market]\nsymbol=SPX\n"));
        put(now + u"/qt-settings.ini"_s, "mine");
        QVERIFY(!config_home::carryPrefs({old}, now));
        QCOMPARE(read(now + u"/qt-settings.ini"_s), QByteArray("mine"));
    }
};

QTEST_GUILESS_MAIN(TestConfigHome)
#include "tst_config_home.moc"
