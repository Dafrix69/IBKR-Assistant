// 窗口位置记忆(shell/window_state,照 main.js 的 loadWindowBounds / saveWindowBounds):存了读得回;
// 记下的位置已经不在任何一块屏上(显示器拔了)、文件坏了、字段不是数:都退回默认(返回空)。
#include "shell/window_state.h"

#include <QFile>
#include <QTemporaryDir>
#include <QTest>

using namespace ibkr::shell;
using namespace Qt::StringLiterals;

class TestWindowState : public QObject {
    Q_OBJECT
private slots:
    void roundTripAndOffScreen() {
        QTemporaryDir dir;
        const QString path = dir.filePath(u"window-state.json"_s);
        const QList<QRect> laptop{QRect(0, 25, 1512, 949)};
        QVERIFY(!loadWindowState(path, laptop));  // 第一次
        saveWindowState(path, {QRect(100, 80, 1360, 900), true});
        const auto back = loadWindowState(path, laptop);
        QVERIFY(back);
        QCOMPARE(back->bounds, QRect(100, 80, 1360, 900));
        QVERIFY(back->maximized);
        // 存的时候在外接屏上,外接屏拔了
        saveWindowState(path, {QRect(2000, 100, 1360, 900), false});
        QVERIFY(!loadWindowState(path, laptop));
        QVERIFY(loadWindowState(path, {QRect(0, 25, 1512, 949), QRect(1512, 0, 2560, 1415)}));
        // 边界:左边只露出不到 80 像素、顶上高出 20 以上、底下只剩不到 60
        saveWindowState(path, {QRect(-1300, 100, 1360, 900), false});
        QVERIFY(!loadWindowState(path, laptop));
        // 顶边比工作区高出 20 以上(菜单栏底下 25,y = 0 只高出 25):同 main.js,算不在屏上
        saveWindowState(path, {QRect(100, 0, 1360, 900), false});
        QVERIFY(!loadWindowState(path, laptop));
        saveWindowState(path, {QRect(100, 5, 1360, 900), false});
        QVERIFY(loadWindowState(path, laptop));
    }

    void brokenFiles() {
        QTemporaryDir dir;
        const QString path = dir.filePath(u"window-state.json"_s);
        for (const QByteArray& text : {QByteArray("{"), QByteArray(R"({"x":"1","y":2,"width":3,"height":4})"), QByteArray(R"({"x":1,"y":2,"width":3})")}) {
            QFile f(path);
            QVERIFY(f.open(QIODevice::WriteOnly));
            f.write(text);
            f.close();
            QVERIFY(!loadWindowState(path, {QRect(0, 0, 5000, 5000)}));
        }
    }
};

QTEST_GUILESS_MAIN(TestWindowState)
#include "tst_window_state.moc"
