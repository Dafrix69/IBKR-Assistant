// 追踪卡片的三个按钮(shell/track_actions)对着原文件 TrackCard.tsx 的 toggle / closeNow / remove 跑出来的 10 个场景逐步对:
// 确认框上的每一个字、发给引擎的入参、横幅、重读与转圈的先后。
#include "json_compare.h"
#include "shell/track_actions.h"

#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QTest>

#include <memory>

using namespace ibkr;
using namespace ibkr::shell;
using namespace Qt::StringLiterals;

namespace {
QJsonArray replay(const QJsonObject& c) {
    auto calls = std::make_shared<QJsonArray>();
    auto answers = std::make_shared<QJsonArray>(c[u"confirms"].toArray());
    const QJsonValue result = c[u"result"];
    const auto reply = [calls, result](const QString& call, const QJsonValue& arg, const track::ActionDeps::Reply& done) {
        calls->append(QJsonObject{{u"call"_s, call}, {u"args"_s, QJsonArray{arg}}});
        if (result.isString()) return done(QJsonValue(), result.toString().mid(6));
        done(result, QString());
    };
    track::ActionDeps deps;
    deps.confirm = [calls, answers](const QJsonObject& opts, std::function<void(bool)> done) {
        QJsonObject rec = opts;
        rec.insert(u"call"_s, u"confirm"_s);
        calls->append(rec);
        done(answers->isEmpty() ? false : answers->takeAt(0).toBool());
    };
    deps.update = [reply](const QJsonObject& spec, const track::ActionDeps::Reply& done) { reply(u"updateTracker"_s, spec, done); };
    deps.closeNow = [reply](const QString& id, const track::ActionDeps::Reply& done) { reply(u"closePositionNow"_s, id, done); };
    deps.remove = [reply](const QString& id, const track::ActionDeps::Reply& done) { reply(u"deleteTracker"_s, id, done); };
    deps.reload = [calls](bool refresh, std::function<void()> done) {
        calls->append(QJsonObject{{u"call"_s, u"reload"_s}, {u"refresh"_s, refresh}});
        done();
    };
    deps.records = [calls] { calls->append(QJsonObject{{u"call"_s, u"records"_s}}); };
    deps.banner = [calls](const QString& text, bool info) { calls->append(QJsonObject{{u"call"_s, u"banner"_s}, {u"text"_s, text}, {u"info"_s, info}}); };
    deps.busy = [calls](const QString& b) { calls->append(QJsonObject{{u"call"_s, u"busy"_s}, {u"busy"_s, b.isEmpty() ? QJsonValue() : QJsonValue(b)}}); };
    const QJsonObject t = c[u"track"].toObject();
    const QString action = c[u"action"].toString();
    if (action == u"toggle") track::toggleTrack(t, deps);
    else if (action == u"closeNow") track::closeTrackNow(t, deps);
    else track::removeTrack(t, deps);
    return *calls;
}
}  // namespace

class TestTrackActions : public QObject {
    Q_OBJECT
private slots:
    void matchesTsCard_data() {
        QTest::addColumn<QJsonObject>("c");
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/track-actions.json"));
        QVERIFY(f.open(QIODevice::ReadOnly));
        const QJsonArray cases = QJsonDocument::fromJson(f.readAll()).object().value(u"cases"_s).toArray();
        QVERIFY(cases.size() >= 10);
        for (const QJsonValue& c : cases) QTest::newRow(qPrintable(c[u"name"].toString())) << c.toObject();
    }
    void matchesTsCard() {
        QFETCH(QJsonObject, c);
        // React 版 reload 与 records 一起起(Promise.all),都完了才收起转圈:次序上 records 记在 reload 之后、收圈之前
        QJsonArray expected = c[u"calls"].toArray();
        QJsonArray got = replay(c);
        const QString diff = test::jsonDiff(expected, got);
        QVERIFY2(diff.isEmpty(), qPrintable(diff));
    }
};

QTEST_GUILESS_MAIN(TestTrackActions)
#include "tst_track_actions.moc"
