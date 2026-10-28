// 下单页的 SPX / QQQ 期权墙(shell/wall_store):一个取完再取下一个、页面卸下就停、一个失败不清掉另一个也不清掉自己上次的结果;
// 给人看的那一行:墙离现价的百分比、贴着现价的标橙、没连上时的空态。
#include "shell/wall_store.h"

#include <QJsonArray>
#include <QSignalSpy>
#include <QTest>

using namespace ibkr;
using namespace ibkr::shell;
using namespace Qt::StringLiterals;

namespace {

QJsonObject wallResult(double spot) {
    return {
        {u"symbol"_s, u"SPX"_s},
        {u"expiry"_s, u"20261028"_s},
        {u"spot"_s, spot},
        {u"call_wall"_s, QJsonObject{{u"strike"_s, 7800}, {u"size"_s, 12000}}},
        {u"put_wall"_s, QJsonObject{{u"strike"_s, 7700}, {u"size"_s, 9000}}},
        {u"call_vol_wall"_s, QJsonObject{{u"strike"_s, 7760}}},
        {u"put_vol_wall"_s, QJsonValue()},
        {u"max_pain"_s, QJsonObject{{u"strike"_s, 7750}, {u"pain"_s, 1}}},
        {u"gamma_flip"_s, 7735.5},
        {u"regime"_s, u"positive"_s},
        {u"gross_gex"_s, 100.0},
        {u"net_gex_ratio"_s, 0.25},
        {u"oi_missing"_s, 0},
        {u"coverage"_s, QJsonObject{{u"lower"_s, 7675}, {u"upper"_s, 7825}, {u"strikes"_s, 31}, {u"grid_strikes"_s, 31}, {u"thinned"_s, false}}},
    };
}

struct Fake {
    QStringList asked;
    QList<walls::StoreDeps::Reply> pending;
    walls::StoreDeps deps() {
        walls::StoreDeps d;
        d.wall = [this](const QJsonObject& p, walls::StoreDeps::Reply done) {
            asked << p.value("symbol"_L1).toString() + u'/' + QString::number(p.value("width"_L1).toInt());
            pending << done;
        };
        d.nowMs = [] { return 1793196000000.0; };  // 2026-10-28 14:00 UTC = 美东 10:00
        return d;
    }
    void answer(const QJsonValue& result) {
        EngineReply r;
        r.ok = true;
        r.result = result;
        pending.takeFirst()(r);
    }
    void fail(const QString& error) {
        EngineReply r;
        r.error = error;
        pending.takeFirst()(r);
    }
};

QJsonObject itemNamed(const QJsonObject& row, const QString& prefix) {
    for (const QJsonValue& v : row.value("items"_L1).toArray())
        if (v[u"text"].toString().startsWith(prefix)) return v.toObject();
    return {};
}

}  // namespace

class TstWallStore : public QObject {
    Q_OBJECT
private slots:
    void fetchesOneAfterAnother() {
        Fake fake;
        WallStore store(fake.deps());
        store.setVisible(true);
        QCOMPARE(fake.asked, QStringList{u"SPX/15"_s});
        // 上一轮还没回来:再按也不再发
        store.refresh();
        QCOMPARE(fake.asked.size(), 1);
        fake.answer(wallResult(7752));
        QCOMPARE(fake.asked, (QStringList{u"SPX/15"_s, u"QQQ/15"_s}));
        fake.answer(wallResult(600));
        QVERIFY(fake.pending.isEmpty());
        store.refresh();
        QCOMPARE(fake.asked.size(), 3);
    }

    void stopsWhenHidden() {
        Fake fake;
        WallStore store(fake.deps());
        store.setVisible(true);
        store.setVisible(false);
        fake.answer(wallResult(7752));
        // 卸下了:QQQ 不再取,下一次挂上从头取
        QCOMPARE(fake.asked.size(), 1);
        store.setVisible(true);
        QCOMPARE(fake.asked.last(), u"SPX/15"_s);
    }

    void timerOnlyWhileVisible() {
        Fake fake;
        WallStore store(fake.deps());
        store.refreshMs = 20;
        store.setVisible(true);
        fake.answer(wallResult(7752));
        fake.answer(wallResult(600));
        QTRY_COMPARE_WITH_TIMEOUT(fake.asked.size(), 3, 1000);
        fake.answer(wallResult(7752));
        fake.answer(wallResult(600));
        store.setVisible(false);
        const qsizetype n = fake.asked.size();
        QTest::qWait(80);
        QCOMPARE(fake.asked.size(), n);
    }

    void failureKeepsLastResult() {
        Fake fake;
        WallStore store(fake.deps());
        store.setVisible(true);
        fake.answer(wallResult(7752));
        fake.fail(u"要先连上 TWS"_s);
        QJsonArray rows = store.rows();
        QCOMPARE(rows[0][u"spot"].toString(), u"7752.00"_s);
        QCOMPARE(rows[1][u"items"].toArray().size(), 0);
        QCOMPARE(rows[1][u"failure"].toString(), u"要先连上 TWS"_s);
        // SPX 第二轮失败:上次的墙还摆着,并说明是上一次的
        store.refresh();
        fake.fail(u"超时"_s);
        rows = store.rows();
        QCOMPARE(rows[0][u"items"].toArray().size(), 7);
        QCOMPARE(rows[0][u"failure"].toString(), u"超时"_s);
        QVERIFY(rows[0][u"note"].toString().contains(u"上一次"_s));
    }

    void rowText() {
        const QJsonObject row = walls::rowModel(u"SPX"_s, {{u"result"_s, wallResult(7752)}, {u"at"_s, 1793196000000.0}});
        QCOMPARE(row.value("expiry"_L1).toString(), u"10-28"_s);
        QCOMPARE(itemNamed(row, u"看涨墙"_s).value("text"_L1).toString(), u"看涨墙 7800(+0.62%)"_s);
        QCOMPARE(itemNamed(row, u"看跌墙"_s).value("text"_L1).toString(), u"看跌墙 7700(−0.67%)"_s);
        QCOMPARE(itemNamed(row, u"量墙 P"_s).value("text"_L1).toString(), u"量墙 P —"_s);
        // 0.25% 以内标橙:最大痛点 7750 离 7752 只有 0.03%
        QCOMPARE(itemNamed(row, u"最大痛点"_s).value("tone"_L1).toString(), u"near"_s);
        QCOMPARE(itemNamed(row, u"看涨墙"_s).value("tone"_L1).toString(), u""_s);
        QVERIFY(row.value("note"_L1).toString().startsWith(u"取于美东 10:00"_s));
        QVERIFY(row.value("note"_L1).toString().contains(u"7675–7825 共 31 档"_s));
    }

    void emptyStates() {
        QCOMPARE(walls::rowModel(u"QQQ"_s, {{u"busy"_s, false}}).value("note"_L1).toString(), u"连上 TWS 之后显示"_s);
        QCOMPARE(walls::rowModel(u"QQQ"_s, {{u"busy"_s, true}}).value("note"_L1).toString(), u"正在取期权链…"_s);
        QCOMPARE(walls::distanceText(QJsonValue(), 100), QString());
        QCOMPARE(walls::distanceText(100, QJsonValue()), QString());
    }
};

QTEST_GUILESS_MAIN(TstWallStore)
#include "tst_wall_store.moc"
