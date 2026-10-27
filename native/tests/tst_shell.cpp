// 界面能起来:把真的 Datrix 跑一次(--smoke-test,无窗口平台),QML 加载成功、第一帧真的画出来、退出码 0。
// 自检不拉引擎(main.cpp 钉着);这里再把配置指到不存在的地方:万一哪天自检拉了引擎,也碰不到真配置、真 TWS。
// QML 报任何一条警告(绑定里的 TypeError 之类)应用自己就以 6 退出,这里只看退出码。
#include "shell/consent.h"
#include "shell/engine_command.h"

#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QProcess>
#include <QSettings>
#include <QTemporaryDir>
#include <QTest>

namespace {

QProcessEnvironment safeEnv(const QString& userData) {
    QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
    env.insert(QStringLiteral("QT_QPA_PLATFORM"), QStringLiteral("offscreen"));
    env.insert(QStringLiteral("DAFRI_CONFIG"), QStringLiteral("/nonexistent/settings.json"));
    // 同意记录、Qt 版的锁:临时目录,不读不写用户的那一份
    env.insert(QStringLiteral("IBKR_USER_DATA_DIR"), userData);
    return env;
}

}  // namespace

class TestShell : public QObject {
    Q_OBJECT
private slots:
    void startsAndQuits() {
        QTemporaryDir userData;
        QProcess app;
        app.setProcessEnvironment(safeEnv(userData.path()));
        app.start(QStringLiteral(IBKR_APP_PATH), {QStringLiteral("--smoke-test")});
        QVERIFY2(app.waitForStarted(5000), qPrintable(app.errorString()));
        QVERIFY(app.waitForFinished(20000));
        const QByteArray err = app.readAllStandardError();
        QVERIFY2(app.exitCode() == 0, err.constData());
        QVERIFY2(app.readAllStandardOutput().startsWith("shell ok 1360x900, first frame drawn, engine none"), err.constData());
    }

    // 带预览引擎(mock 数据,不连券商)把整个外壳画一遍:顶栏、侧栏、占位页、同意页(临时目录里没有同意记录,所以它会盖在上面)。
    // 页面的绑定只有拿到引擎的状态才会走到,自检那一条走不到
    void drawsWithPreviewEngine() {
        if (ibkr::shell::findNode().isEmpty()) QSKIP("没有 node");
        QTemporaryDir userData;
        const QString png = userData.filePath(QStringLiteral("shell.png"));
        QProcess app;
        app.setProcessEnvironment(safeEnv(userData.path()));
        app.start(QStringLiteral(IBKR_APP_PATH), {QStringLiteral("--engine"), QStringLiteral("preview"), QStringLiteral("--screenshot"), png});
        QVERIFY2(app.waitForStarted(5000), qPrintable(app.errorString()));
        QVERIFY(app.waitForFinished(40000));
        const QByteArray err = app.readAllStandardError();
        QVERIFY2(app.exitCode() == 0, err.constData());
        QVERIFY2(QFileInfo(png).size() > 0, err.constData());
        // 日志落在 userData/logs/qt-main.log(这里是临时目录),有启动那一行
        QFile log(userData.filePath(QStringLiteral("logs/qt-main.log")));
        QVERIFY(log.open(QIODevice::ReadOnly));
        QVERIFY(log.readAll().contains("[boot] Datrix(Qt)"));
    }

    // 提醒小窗(AlertPopup.qml):示例 + 两条提醒推进去,小窗露面、画出来、QML 没有报错
    void drawsTheAlertPopup() {
        if (ibkr::shell::findNode().isEmpty()) QSKIP("没有 node");
        QTemporaryDir userData;
        const QString png = userData.filePath(QStringLiteral("popup.png"));
        QProcess app;
        app.setProcessEnvironment(safeEnv(userData.path()));
        app.start(QStringLiteral(IBKR_APP_PATH), {QStringLiteral("--engine"), QStringLiteral("preview"), QStringLiteral("--open"), QStringLiteral("popup"), QStringLiteral("--screenshot"), png});
        QVERIFY2(app.waitForStarted(5000), qPrintable(app.errorString()));
        QVERIFY(app.waitForFinished(40000));
        const QByteArray err = app.readAllStandardError();
        QVERIFY2(app.exitCode() == 0, err.constData());
        QVERIFY2(QFileInfo(png).size() > 0, err.constData());
    }

    // 订单看板的「通知」接没接上 Main.qml 的通知流(曾经 `feed: feed` 在 BoardPage 里解析到它自己的属性,恒为空):
    // 同意过条款(否则同意页盖在上面),打开看板、推两条,量出来的字里要有它们
    void boardShowsTheFeed() {
        if (ibkr::shell::findNode().isEmpty()) QSKIP("没有 node");
        QTemporaryDir userData;
        QFile consent(userData.filePath(QStringLiteral("consent.json")));
        QVERIFY(consent.open(QIODevice::WriteOnly));
        consent.write(QStringLiteral(R"({"accepted":[{"version":"%1","at":"2026-10-18T05:00:00.000Z","app_version":"test"}]})").arg(QLatin1StringView(ibkr::shell::kTermsVersion)).toUtf8());
        consent.close();
        const QString png = userData.filePath(QStringLiteral("board.png"));
        const QString dump = userData.filePath(QStringLiteral("board.json"));
        QProcess app;
        app.setProcessEnvironment(safeEnv(userData.path()));
        app.start(QStringLiteral(IBKR_APP_PATH), {QStringLiteral("--engine"), QStringLiteral("preview"), QStringLiteral("--open"), QStringLiteral("page:board#form:feed"),
                                                  QStringLiteral("--screenshot"), png, QStringLiteral("--dump-texts"), dump});
        QVERIFY2(app.waitForStarted(5000), qPrintable(app.errorString()));
        QVERIFY(app.waitForFinished(40000));
        const QByteArray err = app.readAllStandardError();
        QVERIFY2(app.exitCode() == 0, err.constData());
        QFile texts(dump);
        QVERIFY(texts.open(QIODevice::ReadOnly));
        const QString all = QString::fromUtf8(texts.readAll());
        QVERIFY2(all.contains(QStringLiteral("测试通知 · 第一条")), err.constData());
        QVERIFY(all.contains(QStringLiteral("\"测试通知二\"")));
        QVERIFY(!all.contains(QStringLiteral("暂无通知")));
    }

    // 行情页接上了:带着标的跳过来(标的档案的「K 线」)→ 分析 → 结论卡片、图、同一只的盘口;QML 没报警告
    void marketAnalyzesTheFocus() {
        if (ibkr::shell::findNode().isEmpty()) QSKIP("没有 node");
        QTemporaryDir userData;
        QFile consent(userData.filePath(QStringLiteral("consent.json")));
        QVERIFY(consent.open(QIODevice::WriteOnly));
        consent.write(QStringLiteral(R"({"accepted":[{"version":"%1","at":"2026-10-18T05:00:00.000Z","app_version":"test"}]})").arg(QLatin1StringView(ibkr::shell::kTermsVersion)).toUtf8());
        consent.close();
        const QString dump = userData.filePath(QStringLiteral("market.json"));
        QProcess app;
        app.setProcessEnvironment(safeEnv(userData.path()));
        app.start(QStringLiteral(IBKR_APP_PATH), {QStringLiteral("--engine"), QStringLiteral("preview"), QStringLiteral("--open"), QStringLiteral("page:market@600#focus:nvda"),
                                                  QStringLiteral("--screenshot"), userData.filePath(QStringLiteral("market.png")), QStringLiteral("--dump-texts"), dump});
        QVERIFY2(app.waitForStarted(5000), qPrintable(app.errorString()));
        QVERIFY(app.waitForFinished(40000));
        const QByteArray err = app.readAllStandardError();
        QVERIFY2(app.exitCode() == 0, err.constData());
        QVERIFY2(!err.contains("QML 报了"), err.constData());
        QFile texts(dump);
        QVERIFY(texts.open(QIODevice::ReadOnly));
        const QString all = QString::fromUtf8(texts.readAll());
        // 滚到 600:结论卡片的下半、整张图、同一只盘口的头都在视线里
        QVERIFY2(all.contains(QStringLiteral("K 线(5 分钟)")), err.constData());
        QVERIFY(all.contains(QStringLiteral("盘口 · NVDA")));
        // 图画出来了(不是「窗口太窄」/「数据不足」)、顶部是均线读数
        QVERIFY(!all.contains(QStringLiteral("窗口太窄")));
        QVERIFY(!all.contains(QStringLiteral("数据不足")));
        QVERIFY(all.contains(QStringLiteral("MA20 ")));
        // 标的记在本机:下次打开还是它
        QCOMPARE(QSettings(userData.filePath(QStringLiteral("qt-settings.ini")), QSettings::IniFormat).value(QStringLiteral("market/symbol")).toString(), QStringLiteral("NVDA"));
    }

    // 想法页接上了:进页即读(预览台的两条想法),QML 没报警告
    void ideasListsTheMock() {
        if (ibkr::shell::findNode().isEmpty()) QSKIP("没有 node");
        QTemporaryDir userData;
        QFile consent(userData.filePath(QStringLiteral("consent.json")));
        QVERIFY(consent.open(QIODevice::WriteOnly));
        consent.write(QStringLiteral(R"({"accepted":[{"version":"%1","at":"2026-10-18T05:00:00.000Z","app_version":"test"}]})").arg(QLatin1StringView(ibkr::shell::kTermsVersion)).toUtf8());
        consent.close();
        const QString dump = userData.filePath(QStringLiteral("ideas.json"));
        QProcess app;
        app.setProcessEnvironment(safeEnv(userData.path()));
        app.start(QStringLiteral(IBKR_APP_PATH), {QStringLiteral("--engine"), QStringLiteral("preview"), QStringLiteral("--open"), QStringLiteral("page:ideas"),
                                                  QStringLiteral("--screenshot"), userData.filePath(QStringLiteral("ideas.png")), QStringLiteral("--dump-texts"), dump});
        QVERIFY2(app.waitForStarted(5000), qPrintable(app.errorString()));
        QVERIFY(app.waitForFinished(40000));
        const QByteArray err = app.readAllStandardError();
        QVERIFY2(app.exitCode() == 0, err.constData());
        QVERIFY2(!err.contains("QML 报了"), err.constData());
        QFile texts(dump);
        QVERIFY(texts.open(QIODevice::ReadOnly));
        const QString all = QString::fromUtf8(texts.readAll());
        QVERIFY2(all.contains(QStringLiteral("AXTI 周五尾盘买入,量能起来了")), err.constData());
        QVERIFY(all.contains(QStringLiteral("随手记,不解析、不下单")));
        QVERIFY(!all.contains(QStringLiteral("还没有进行中的想法")));
    }

    // 板块页:折叠时保留行情空间,展开时读得到纪律与样本范围;QML 没报警告。
    void sectorsShowsThePool_data() {
        QTest::addColumn<bool>("expanded");
        QTest::newRow("compact") << false;
        QTest::newRow("discipline_expanded") << true;
    }

    void sectorsShowsThePool() {
        QFETCH(bool, expanded);
        if (ibkr::shell::findNode().isEmpty()) QSKIP("没有 node");
        QTemporaryDir userData;
        QFile consent(userData.filePath(QStringLiteral("consent.json")));
        QVERIFY(consent.open(QIODevice::WriteOnly));
        consent.write(QStringLiteral(R"({"accepted":[{"version":"%1","at":"2026-10-18T05:00:00.000Z","app_version":"test"}]})").arg(QLatin1StringView(ibkr::shell::kTermsVersion)).toUtf8());
        consent.close();
        const QString dump = userData.filePath(QStringLiteral("sectors.json"));
        if (expanded)
            QSettings(userData.filePath(QStringLiteral("Dafri/Datrix.ini")), QSettings::IniFormat).setValue(QStringLiteral("primer/sector-discipline-v1"), QStringLiteral("1"));
        QProcess app;
        app.setProcessEnvironment(safeEnv(userData.path()));
        app.start(QStringLiteral(IBKR_APP_PATH), {QStringLiteral("--engine"), QStringLiteral("preview"), QStringLiteral("--open"), QStringLiteral("page:sectors"),
                                                  QStringLiteral("--screenshot"), userData.filePath(QStringLiteral("sectors.png")), QStringLiteral("--dump-texts"), dump});
        QVERIFY2(app.waitForStarted(5000), qPrintable(app.errorString()));
        QVERIFY(app.waitForFinished(40000));
        const QByteArray err = app.readAllStandardError();
        QVERIFY2(app.exitCode() == 0, err.constData());
        QVERIFY2(!err.contains("QML 报了"), err.constData());
        QFile texts(dump);
        QVERIFY(texts.open(QIODevice::ReadOnly));
        const QString all = QString::fromUtf8(texts.readAll());
        QVERIFY2(all.contains(QStringLiteral("AI 算力(3)")), err.constData());
        QVERIFY(all.contains(QStringLiteral("监控中 · 每 5 秒一轮")));
        QVERIFY(all.contains(QStringLiteral("提醒后的交易纪律")));
        if (expanded) {
            QVERIFY(all.contains(QStringLiteral("先写退出条件")));
            QVERIFY(all.contains(QStringLiteral("跨时段重新评估")));
            QVERIFY(all.contains(QStringLiteral("按可成交价格计划")));
            QVERIFY(all.contains(QStringLiteral("未满两年")));
        } else {
            QVERIFY(all.contains(QStringLiteral("核电(2)")));
            QVERIFY(all.contains(QStringLiteral("财报提醒")));
            QVERIFY(all.contains(QStringLiteral("2026-11-18")));
            QVERIFY(all.contains(QStringLiteral("整数关口步长")));
        }
    }

    // 扫描页接上了:点「扫描」后标签卡、表、榜首那只的极值偏离都出来了,再筛一遍强势股;QML 没报警告
    void screenerScans() {
        if (ibkr::shell::findNode().isEmpty()) QSKIP("没有 node");
        QTemporaryDir userData;
        QFile consent(userData.filePath(QStringLiteral("consent.json")));
        QVERIFY(consent.open(QIODevice::WriteOnly));
        consent.write(QStringLiteral(R"({"accepted":[{"version":"%1","at":"2026-10-18T05:00:00.000Z","app_version":"test"}]})").arg(QLatin1StringView(ibkr::shell::kTermsVersion)).toUtf8());
        consent.close();
        const QString dump = userData.filePath(QStringLiteral("screener.json"));
        QProcess app;
        app.setProcessEnvironment(safeEnv(userData.path()));
        app.start(QStringLiteral(IBKR_APP_PATH), {QStringLiteral("--engine"), QStringLiteral("preview"), QStringLiteral("--open"), QStringLiteral("page:screener@500#form:scan-leaders"),
                                                  QStringLiteral("--screenshot"), userData.filePath(QStringLiteral("screener.png")), QStringLiteral("--dump-texts"), dump});
        QVERIFY2(app.waitForStarted(5000), qPrintable(app.errorString()));
        QVERIFY(app.waitForFinished(40000));
        const QByteArray err = app.readAllStandardError();
        QVERIFY2(app.exitCode() == 0, err.constData());
        QVERIFY2(!err.contains("QML 报了"), err.constData());
        QFile texts(dump);
        QVERIFY(texts.open(QIODevice::ReadOnly));
        const QString all = QString::fromUtf8(texts.readAll());
        QVERIFY2(all.contains(QStringLiteral("仅供研究,不构成投资建议")), err.constData());
        QVERIFY(all.contains(QStringLiteral("大盘:承压")));
        QVERIFY(all.contains(QStringLiteral("趋势模板 8/8 · 第二阶段 · VCP 放量突破枢轴 95.57")));
        QVERIFY(all.contains(QStringLiteral("第 1 / 5 只")));
    }

    // 回测页接上了:读回策略目录,填 NVDA 跑一次,结果卡片与成交明细出来;QML 没报警告
    void backtestRuns() {
        if (ibkr::shell::findNode().isEmpty()) QSKIP("没有 node");
        QTemporaryDir userData;
        QFile consent(userData.filePath(QStringLiteral("consent.json")));
        QVERIFY(consent.open(QIODevice::WriteOnly));
        consent.write(QStringLiteral(R"({"accepted":[{"version":"%1","at":"2026-10-18T05:00:00.000Z","app_version":"test"}]})").arg(QLatin1StringView(ibkr::shell::kTermsVersion)).toUtf8());
        consent.close();
        const QString dump = userData.filePath(QStringLiteral("backtest.json"));
        QProcess app;
        app.setProcessEnvironment(safeEnv(userData.path()));
        app.start(QStringLiteral(IBKR_APP_PATH), {QStringLiteral("--engine"), QStringLiteral("preview"), QStringLiteral("--open"), QStringLiteral("page:backtest@600#form:run"),
                                                  QStringLiteral("--screenshot"), userData.filePath(QStringLiteral("backtest.png")), QStringLiteral("--dump-texts"), dump});
        QVERIFY2(app.waitForStarted(5000), qPrintable(app.errorString()));
        QVERIFY(app.waitForFinished(40000));
        const QByteArray err = app.readAllStandardError();
        QVERIFY2(app.exitCode() == 0, err.constData());
        QVERIFY2(!err.contains("QML 报了"), err.constData());
        QFile texts(dump);
        QVERIFY(texts.open(QIODevice::ReadOnly));
        const QString all = QString::fromUtf8(texts.readAll());
        QVERIFY2(all.contains(QStringLiteral("交易统计(已平仓 4 笔 / 共 4 笔)")), err.constData());
        QVERIFY(all.contains(QStringLiteral("净值曲线(起点 = 1.0)")));
        QVERIFY(all.contains(QStringLiteral("Sharpe / Sortino 按逐日净值算,无风险利率按 0、一年 252 个交易日")));
    }

    // 交易分析页接上了:读回候选,点「分析」,蝶的复盘出来;QML 没报警告
    void reviewAnalyzes() {
        if (ibkr::shell::findNode().isEmpty()) QSKIP("没有 node");
        QTemporaryDir userData;
        QFile consent(userData.filePath(QStringLiteral("consent.json")));
        QVERIFY(consent.open(QIODevice::WriteOnly));
        consent.write(QStringLiteral(R"({"accepted":[{"version":"%1","at":"2026-10-18T05:00:00.000Z","app_version":"test"}]})").arg(QLatin1StringView(ibkr::shell::kTermsVersion)).toUtf8());
        consent.close();
        const QString dump = userData.filePath(QStringLiteral("review.json"));
        QProcess app;
        app.setProcessEnvironment(safeEnv(userData.path()));
        app.start(QStringLiteral(IBKR_APP_PATH), {QStringLiteral("--engine"), QStringLiteral("preview"), QStringLiteral("--open"), QStringLiteral("page:review@0#form:run"),
                                                  QStringLiteral("--screenshot"), userData.filePath(QStringLiteral("review.png")), QStringLiteral("--dump-texts"), dump});
        QVERIFY2(app.waitForStarted(5000), qPrintable(app.errorString()));
        QVERIFY(app.waitForFinished(40000));
        const QByteArray err = app.readAllStandardError();
        QVERIFY2(app.exitCode() == 0, err.constData());
        QVERIFY2(!err.contains("QML 报了"), err.constData());
        QFile texts(dump);
        QVERIFY(texts.open(QIODevice::ReadOnly));
        const QString all = QString::fromUtf8(texts.readAll());
        QVERIFY2(all.contains(QStringLiteral("标的走势(5 分钟,开仓前后到结局)")), err.constData());
        QVERIFY(all.contains(QStringLiteral("SPX 7600/7615/7630 看跌")));
    }

    // 涨跌配色只记一份(alerts/updown,提醒小窗也看它):记着红涨绿跌时设置页选中的是它;在设置页换回去,写回那一份
    void upDownIsOneSetting() {
        if (ibkr::shell::findNode().isEmpty()) QSKIP("没有 node");
        QTemporaryDir userData;
        QFile consent(userData.filePath(QStringLiteral("consent.json")));
        QVERIFY(consent.open(QIODevice::WriteOnly));
        consent.write(QStringLiteral(R"({"accepted":[{"version":"%1","at":"2026-10-18T05:00:00.000Z","app_version":"test"}]})").arg(QLatin1StringView(ibkr::shell::kTermsVersion)).toUtf8());
        consent.close();
        const QString ini = userData.filePath(QStringLiteral("qt-settings.ini"));
        QSettings(ini, QSettings::IniFormat).setValue(QStringLiteral("alerts/updown"), QStringLiteral("red-up"));
        const auto run = [&](const QString& route, const QString& dump) {
            QProcess app;
            app.setProcessEnvironment(safeEnv(userData.path()));
            app.start(QStringLiteral(IBKR_APP_PATH), {QStringLiteral("--engine"), QStringLiteral("preview"), QStringLiteral("--open"), route,
                                                      QStringLiteral("--screenshot"), userData.filePath(QStringLiteral("s.png")), QStringLiteral("--dump-texts"), dump});
            QVERIFY2(app.waitForStarted(5000), qPrintable(app.errorString()));
            QVERIFY(app.waitForFinished(40000));
            QVERIFY2(app.exitCode() == 0, app.readAllStandardError().constData());
        };
        const QString dump = userData.filePath(QStringLiteral("settings.json"));
        run(QStringLiteral("page:settings"), dump);
        QFile f(dump);
        QVERIFY(f.open(QIODevice::ReadOnly));
        const QJsonArray texts = QJsonDocument::fromJson(f.readAll()).array();
        const auto weightOf = [&](const QString& t) {
            for (const QJsonValue& v : texts)
                if (v[QStringLiteral("text")].toString() == t) return v[QStringLiteral("weight")].toInt();
            return -1;
        };
        QCOMPARE(weightOf(QStringLiteral("红涨绿跌")), 510);  // 选中的那一格
        QCOMPARE(weightOf(QStringLiteral("绿涨红跌")), 400);
        // 换回绿涨红跌之前先清成别的值:路由把它设成 red-up,应用退出后那一份就是 red-up
        QSettings(ini, QSettings::IniFormat).setValue(QStringLiteral("alerts/updown"), QStringLiteral("green-up"));
        run(QStringLiteral("page:settings#form:redup"), userData.filePath(QStringLiteral("s2.json")));
        QCOMPARE(QSettings(ini, QSettings::IniFormat).value(QStringLiteral("alerts/updown")).toString(), QStringLiteral("red-up"));
    }

    // 同一份 userData 第二次打开:叫已经开着的那一个到前台,自己马上退出(不拉第二个引擎)
    void secondInstanceHandsOff() {
        if (ibkr::shell::findNode().isEmpty()) QSKIP("没有 node");
        QTemporaryDir userData;
        QProcess first;
        first.setProcessEnvironment(safeEnv(userData.path()));
        first.start(QStringLiteral(IBKR_APP_PATH), {QStringLiteral("--engine"), QStringLiteral("preview")});
        QVERIFY(first.waitForStarted(5000));
        // 等它在听:日志里有启动那一行之后再给一点时间
        QTRY_VERIFY_WITH_TIMEOUT(QFileInfo(userData.filePath(QStringLiteral("logs/qt-main.log"))).size() > 0, 15000);
        QTest::qWait(500);
        {
            QFile log(userData.filePath(QStringLiteral("logs/qt-main.log")));
            QVERIFY(log.open(QIODevice::ReadOnly));
            if (log.readAll().contains("单实例的本地套接字开不了")) {
                first.kill();
                first.waitForFinished(5000);
                QSKIP("这里开不了本地套接字(沙箱不让绑 Unix 套接字):在自己的终端里跑这一条");
            }
        }
        QProcess second;
        second.setProcessEnvironment(safeEnv(userData.path()));
        second.start(QStringLiteral(IBKR_APP_PATH), {QStringLiteral("--engine"), QStringLiteral("preview")});
        QVERIFY(second.waitForFinished(10000));
        QCOMPARE(second.exitCode(), 0);
        QVERIFY2(second.readAllStandardOutput().contains("已经开着一个"), second.readAllStandardError().constData());
        QCOMPARE(first.state(), QProcess::Running);
        first.terminate();
        if (!first.waitForFinished(10000)) first.kill();
    }

    // 退出(⌘Q 那条路):先停引擎、再退,退出码 0;日志里有收尾那一行
    void quitStopsTheEngineFirst() {
        if (ibkr::shell::findNode().isEmpty()) QSKIP("没有 node");
        QTemporaryDir userData;
        QProcess app;
        app.setProcessEnvironment(safeEnv(userData.path()));
        app.start(QStringLiteral(IBKR_APP_PATH), {QStringLiteral("--engine"), QStringLiteral("preview"), QStringLiteral("--quit-after"), QStringLiteral("4000")});
        QVERIFY(app.waitForStarted(5000));
        QVERIFY(app.waitForFinished(30000));
        QCOMPARE(app.exitStatus(), QProcess::NormalExit);
        QCOMPARE(app.exitCode(), 0);
        QFile log(userData.filePath(QStringLiteral("logs/qt-main.log")));
        QVERIFY(log.open(QIODevice::ReadOnly));
        const QByteArray text = log.readAll();
        QVERIFY2(text.contains("[shell] 退出:先停引擎"), text.constData());
    }
};

QTEST_GUILESS_MAIN(TestShell)
#include "tst_shell.moc"
