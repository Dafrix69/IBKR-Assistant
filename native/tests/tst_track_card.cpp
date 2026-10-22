// 持仓追踪卡片(shell/track_card)对着原组件 TrackCard.tsx 用 SSR 渲染出来的文字逐段比(tests/fixtures/gen_track_card.mjs,27 个场景):
// 标题、状态胶囊、元数据、分批止盈、托管、盈亏、价位轨、量表、关键价位、追价、被拦、按钮。
#include "json_compare.h"
#include "shell/track_card.h"

#include <QFile>
#include <QJsonDocument>
#include <QTest>

using namespace ibkr;
using namespace ibkr::shell;
using namespace Qt::StringLiterals;

class TestTrackCard : public QObject {
    Q_OBJECT
private slots:
    void matchesTsComponent_data() {
        QTest::addColumn<QJsonObject>("c");
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/track-card.json"));
        QVERIFY(f.open(QIODevice::ReadOnly));
        const QJsonArray cases = QJsonDocument::fromJson(f.readAll()).object().value(u"cases"_s).toArray();
        QVERIFY(cases.size() >= 25);
        for (const QJsonValue& c : cases) QTest::newRow(qPrintable(c[u"name"].toString())) << c.toObject();
    }
    void matchesTsComponent() {
        QFETCH(QJsonObject, c);
        track::CardInput in;
        in.track = c[u"t"].toObject();
        in.live = c[u"live"].toObject();
        in.hosted = c[u"hosted"];
        in.delayed = c[u"delayed"].toBool();
        in.connected = c[u"connected"].toBool();
        in.gateway = c[u"gateway"].toString();
        in.watches = c[u"watches"].toArray();
        for (const QJsonValue& b : c[u"busy"].toArray()) in.busy << b.toString();
        const QStringList got = track::cardTexts(track::trackCardModel(in));
        QStringList expected;
        for (const QJsonValue& v : c[u"texts"].toArray()) expected << v.toString();
        if (got != expected) {
            for (qsizetype i = 0; i < std::max(got.size(), expected.size()); ++i) {
                if (got.value(i) != expected.value(i))
                    QFAIL(qPrintable(u"第 %1 段:期望「%2」,实际「%3」\n期望 %4\n实际 %5"_s.arg(i).arg(expected.value(i), got.value(i), expected.join(u" | "_s), got.join(u" | "_s))));
            }
        }
    }
};

QTEST_GUILESS_MAIN(TestTrackCard)
#include "tst_track_card.moc"
