// 「持仓追踪」整页(shell/tracker_page)对着原页面 Tracker.tsx 用 SSR 渲染出来的文字逐段比(tests/fixtures/gen_tracker_page.mjs,15 个场景):
// 输入是 React 版各个 store 在渲染那一刻的原样快照,数据底子是预览台的 mock-bridge.js。
#include "shell/tracker_page.h"

#include <QFile>
#include <QJsonDocument>
#include <QTest>

using namespace ibkr;
using namespace ibkr::shell;
using namespace Qt::StringLiterals;

class TestTrackerPage : public QObject {
    Q_OBJECT
private slots:
    void matchesTsPage_data() {
        QTest::addColumn<QJsonObject>("c");
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/tracker-page.json"));
        QVERIFY(f.open(QIODevice::ReadOnly));
        const QJsonArray cases = QJsonDocument::fromJson(f.readAll()).object().value(u"cases"_s).toArray();
        QVERIFY(cases.size() >= 15);
        for (const QJsonValue& c : cases) QTest::newRow(qPrintable(c[u"name"].toString())) << c.toObject();
    }
    void matchesTsPage() {
        QFETCH(QJsonObject, c);
        track::PageInput in;
        in.tracker = c[u"tracker"].toObject();
        in.connected = c[u"connected"].toBool();
        in.gateway = c[u"provider"] == u"futu"_s ? u"OpenD"_s : u"TWS"_s;
        in.watches = c[u"watches"].toArray();
        for (const QJsonValue& b : c[u"busy"].toArray()) in.busy << b.toString();
        const QStringList got = track::pageTexts(track::trackerPageModel(in));
        QStringList expected;
        for (const QJsonValue& v : c[u"texts"].toArray()) expected << v.toString();
        for (qsizetype i = 0; i < std::max(got.size(), expected.size()); ++i) {
            if (got.value(i) != expected.value(i))
                QFAIL(qPrintable(u"第 %1 段:期望「%2」,实际「%3」\n前后:%4"_s.arg(i).arg(expected.value(i), got.value(i), expected.mid(std::max<qsizetype>(0, i - 3), 6).join(u" | "_s))));
        }
    }
    // 休市有券商标记价:盈亏和价都按它,不写成昨收;成本折回每股价,和价同单位
    void markBeatsCloseWhenMarketClosed() {
        const QJsonObject p{{u"key"_s, u"k"_s}, {u"symbol"_s, u"SPX"_s}, {u"sec_type"_s, u"OPT"_s}, {u"quantity"_s, 1}, {u"multiplier"_s, 100}, {u"avg_cost"_s, 586.63},
                            {u"market_price"_s, QJsonValue()}, {u"unrealized_pnl"_s, QJsonValue()}, {u"mark_price"_s, 8.58}, {u"close_price"_s, 83.6},
                            {u"close_pnl"_s, 271.37}, {u"close_pct"_s, 46.26}, {u"account"_s, u"main"_s}};
        const QJsonObject m = track::positionModel(p, false, QString());
        QCOMPARE(m[u"hero"_s].toString(), u"+271.37"_s);
        const QJsonArray facts = m[u"facts"_s].toArray();
        QCOMPARE(facts[1][u"value"_s].toString(), u"5.87"_s);
        QCOMPARE(facts[2][u"value"_s].toString(), u"8.58"_s);
        QCOMPARE(facts[2][u"label"_s].toString(), u"标记价"_s);
        QVERIFY(m[u"heroNotes"_s].toArray()[0][u"text"_s].toString().contains(u"券商标记价"_s));
        QJsonObject noMark = p;
        noMark.remove(u"mark_price"_s);
        QCOMPARE(track::positionModel(noMark, false, QString())[u"facts"_s].toArray()[2][u"label"_s].toString(), u"昨收"_s);
    }
};

QTEST_GUILESS_MAIN(TestTrackerPage)
#include "tst_tracker_page.moc"
