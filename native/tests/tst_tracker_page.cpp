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
};

QTEST_GUILESS_MAIN(TestTrackerPage)
#include "tst_tracker_page.moc"
