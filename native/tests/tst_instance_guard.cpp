// 单实例与"退出时说了什么":Electron 版开着时不拉引擎(认它的 SingletonLock),两个 Qt 版不能同时开;
// 以及引擎退出时 stderr 里那一行 [fatal:…] 认得出来(用例照抄 desktop-config-guard / desktop-store-guard 的 spec)。
#include "shell/fatal_line.h"
#include "shell/instance_guard.h"

#include <QCoreApplication>
#include <QFile>
#include <QProcess>
#include <QTemporaryDir>
#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;

namespace {

void link(const QString& dir, const QString& target) {
    QFile::remove(dir + u"/SingletonLock"_s);
    QVERIFY(QFile::link(target, dir + u"/SingletonLock"_s));
}

}  // namespace

class TestInstanceGuard : public QObject {
    Q_OBJECT
private slots:
    void detectsALiveElectron() {
#if !defined(Q_OS_UNIX)
        QSKIP("Windows 上 Chromium 不用 SingletonLock 链接");
#endif
        QTemporaryDir dir;
        const qint64 me = QCoreApplication::applicationPid();
        link(dir.path(), u"DAFRIXWANG-MC3-%1"_s.arg(me));  // 主机名里可以有 -
        QCOMPARE(shell::runningElectronPid({dir.path()}, u"DAFRIXWANG-MC3"_s), std::optional<qint64>(me));
        // 有的机器 gethostname 带 .local:只比第一段,不分大小写
        QCOMPARE(shell::runningElectronPid({dir.path()}, u"dafrixwang-mc3.local"_s), std::optional<qint64>(me));
        const QString why = shell::engineStartBlocker({dir.path()}, u"DAFRIXWANG-MC3"_s);
        QVERIFY2(why.contains(u"Electron 版正在运行(进程 %1)"_s.arg(me)), qPrintable(why));
    }

    void ignoresStaleOrForeignLocks() {
#if !defined(Q_OS_UNIX)
        QSKIP("Windows 上 Chromium 不用 SingletonLock 链接");
#endif
        QTemporaryDir dir;
        // 已经退出的进程留下的
        QProcess done;
        done.start(u"/bin/sh"_s, {u"-c"_s, u"exit 0"_s});
        QVERIFY(done.waitForFinished(5000));
        const qint64 dead = done.processId() > 0 ? done.processId() : 999999;
        link(dir.path(), u"DAFRIXWANG-MC3-%1"_s.arg(dead));
        QCOMPARE(shell::runningElectronPid({dir.path()}, u"DAFRIXWANG-MC3"_s), std::nullopt);
        // 别的主机的(网络家目录)
        link(dir.path(), u"OTHER-HOST-%1"_s.arg(QCoreApplication::applicationPid()));
        QCOMPARE(shell::runningElectronPid({dir.path()}, u"DAFRIXWANG-MC3"_s), std::nullopt);
        // 认不出的样子、没有链接
        link(dir.path(), u"garbage"_s);
        QCOMPARE(shell::runningElectronPid({dir.path()}, u"DAFRIXWANG-MC3"_s), std::nullopt);
        QCOMPARE(shell::runningElectronPid({dir.path() + u"/nope"_s}, u"DAFRIXWANG-MC3"_s), std::nullopt);
        QVERIFY(shell::engineStartBlocker({dir.path()}, u"DAFRIXWANG-MC3"_s).isEmpty());
    }

    void onlyOneQtShell() {
        QTemporaryDir dir;
        const QString path = dir.filePath(u"sub/qt-shell.lock"_s);
        auto first = shell::lockQtShell(path);
        QVERIFY(first != nullptr);
        QVERIFY(shell::lockQtShell(path) == nullptr);
        first.reset();
        QVERIFY(shell::lockQtShell(path) != nullptr);
    }

    void configFatalLine() {
        const QString tail = u"[engine] 启动引擎(node):/x/dist\n[fatal:config:syntax] 配置文件不是合法的 JSON(多半是手改时少了逗号或引号):Unexpected end of JSON input"_s;
        const auto got = shell::configFatalLine(tail);
        QVERIFY(got);
        QCOMPARE(got->kind, u"syntax"_s);
        QCOMPARE(got->message, u"配置文件不是合法的 JSON(多半是手改时少了逗号或引号):Unexpected end of JSON input"_s);
        QCOMPARE(shell::configFatalLine(u"[fatal:config:invalid] 连接 paper 的 host 必须是本机地址"_s)->kind, u"invalid"_s);
        QVERIFY(!shell::configFatalLine(u"TypeError: x is not a function\n    at foo (bar.js:1:1)"_s));
        QVERIFY(!shell::configFatalLine(QString()));
    }

    void storeFatalLine() {
        const QString dbPath = u"/tmp/x/trades.db"_s;
        const QString tail = u"[engine] 启动引擎\n[fatal:store:path] %1\n[fatal:store:corrupt] 交易库文件已损坏,读不出来(file is not a database)。可以从备份恢复。"_s.arg(dbPath);
        const auto got = shell::storeFatalLine(tail);
        QVERIFY(got);
        QCOMPARE(got->kind, u"corrupt"_s);
        QCOMPARE(got->dbPath, std::optional<QString>(dbPath));
        QCOMPARE(got->message, u"交易库文件已损坏,读不出来(file is not a database)。可以从备份恢复。"_s);
        const auto newer = shell::storeFatalLine(u"[fatal:store:newer] 交易库是更新版本的软件写的"_s);
        QCOMPARE(newer->kind, u"newer"_s);
        QCOMPARE(newer->dbPath, std::nullopt);
        QVERIFY(!shell::storeFatalLine(u"SqliteError: disk I/O error"_s));
    }
};

QTEST_GUILESS_MAIN(TestInstanceGuard)
#include "tst_instance_guard.moc"
