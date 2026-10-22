// SPX 关口提醒:判定(shell/spot_levels)对着原模块(lib/spotLevels.ts)现算的序列逐步对;
// 轮询(shell/spot_store,照 store/spot.ts)对着假引擎:连着券商、提醒开着两秒一问,关着只在面板看得见时问;
// 穿过关口响一声、交给弹窗(没收下退回系统通知);断开不留旧数;开关记在本机。
#include "json_compare.h"
#include "shell/alert_tone.h"
#include "shell/alerter.h"
#include "shell/bridge.h"
#include "shell/consent.h"
#include "shell/popup_rules.h"
#include "shell/spot_store.h"
#include "shell/status_store.h"
#include "shell_harness.h"

#include <QJsonArray>
#include <QTemporaryDir>

#include <cmath>

using namespace ibkr;
using namespace ibkr::test;
using namespace ibkr::shell::spot;
using namespace Qt::StringLiterals;

namespace {

QJsonObject fixture() {
    QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/spot-levels.json"));
    if (!f.open(QIODevice::ReadOnly)) return {};
    return QJsonDocument::fromJson(f.readAll()).object();
}

QJsonValue optNum(const std::optional<double>& v) { return v ? QJsonValue(*v) : QJsonValue(); }

QJsonObject stateJson(const WatchState& s) {
    return {{u"last"_s, s.last ? QJsonValue(QJsonObject{{u"price"_s, optNum(s.last->price)}, {u"source"_s, s.last->source}, {u"at"_s, s.last->at}}) : QJsonValue()},
            {u"muted"_s, optNum(s.muted)}};
}

QJsonValue hitJson(const std::optional<Hit>& h) {
    if (!h) return QJsonValue();
    return QJsonObject{{u"level"_s, h->level}, {u"direction"_s, h->direction}, {u"price"_s, h->price}, {u"source"_s, h->source}, {u"at"_s, h->at}, {u"skipped"_s, h->skipped}};
}

Sample sampleOf(const QJsonObject& o) {
    Sample s;
    const QJsonValue p = o.value("price"_L1);
    if (p == u"NaN"_s) s.price = std::nan("");
    else if (p.isDouble()) s.price = p.toDouble();
    s.source = o.value("source"_L1).toString();
    s.at = o.value("at"_L1).toDouble();
    return s;
}

struct FakeOutputs : shell::AlertOutputs {
    QList<QByteArray> sounds;
    QList<QPair<QString, QString>> notices;
    void playWav(const QByteArray& wav) override { sounds.append(wav); }
    bool notify(const QString& t, const QString& b) override {
        notices.append({t, b});
        return true;
    }
};

constexpr double kT0 = 1'760'000'000'000;

struct Rig {
    QTemporaryDir dir;
    QString resultsPath = dir.filePath(u"results.json"_s);
    shell::EngineClient engine;
    QStringList logs;
    struct Yes : shell::Prompter {
        void ask(const shell::ConfirmBox&, std::function<void(bool)> d) override { d(true); }
    } yes;
    shell::ConsentStore consent{dir.path()};
    shell::Bridge bridge{&engine, &yes, &consent};
    shell::StatusStore status{&engine, 60'000};
    shell::PopupQueue popup;
    FakeOutputs outputs;
    shell::Alerter alerter{&popup, &outputs, QString()};
    shell::SpotStore spot;
    double clock = kT0;

    explicit Rig(bool connected = true, const QString& ini = QString())
        : engine(fakeEngine({{u"FAKE_STATUS"_s, connected ? u"{\"broker_connected\":true}"_s : u"{\"broker_connected\":false}"_s},
                             {u"FAKE_LOG_PARAMS"_s, u"1"_s}, {u"FAKE_RESULTS_FILE"_s, resultsPath}}),
                 40),
          spot(&bridge, &status, &alerter, ini) {
        QObject::connect(&engine, &shell::EngineClient::logLine, [this](const QString& l) { logs.append(l); });
        spot.now = [this] { return clock; };
        quote(7712, u"quote"_s);
        status.refresh();
        QTRY_VERIFY(status.status().contains(u"broker_connected"_s));
    }
    ~Rig() {
        shell::StopOptions o;
        o.drainMs = 0;
        stopSync(engine, o);
    }
    void quote(double price, const QString& source) { write(QJsonObject{{u"price"_s, price}, {u"source"_s, source}, {u"at"_s, clock}}); }
    void write(const QJsonObject& result) {
        QFile f(resultsPath);
        QVERIFY(f.open(QIODevice::WriteOnly));
        f.write(QJsonDocument(QJsonObject{{u"options.spot"_s, result}}).toJson());
    }
    int calls() const { return int(logs.filter(u"[fake] options.spot "_s).size()); }
    /// 一拍;expectCall:这一拍该不该问引擎
    void tick(bool expectCall) {
        const int before = calls();
        spot.tick();
        if (expectCall) {
            QTRY_COMPARE(calls(), before + 1);
            QTest::qWait(30);
        } else {
            QTest::qWait(80);
            QCOMPARE(calls(), before);
        }
    }
};

}  // namespace

class TestSpotStore : public QObject {
    Q_OBJECT
private slots:
    void matchesTsModule_data() {
        QTest::addColumn<QJsonArray>("steps");
        const QJsonObject seqs = fixture().value(u"sequences"_s).toObject();
        QVERIFY(seqs.size() >= 15);
        for (auto it = seqs.begin(); it != seqs.end(); ++it) QTest::newRow(qPrintable(it.key())) << it.value().toArray();
    }
    void matchesTsModule() {
        QFETCH(QJsonArray, steps);
        WatchState state;
        int i = 0;
        for (const QJsonValue& v : steps) {
            const Step next = stepLevelWatch(state, sampleOf(v[u"sample"].toObject()));
            state = next.state;
            QString diff = jsonDiff(v[u"state"], stateJson(state), u"$.state"_s);
            if (diff.isEmpty()) diff = jsonDiff(v[u"hit"], hitJson(next.hit), u"$.hit"_s);
            QVERIFY2(diff.isEmpty(), qPrintable(u"第 %1 笔:"_s.arg(i) + diff));
            ++i;
        }
    }
    void constantsAndText() {
        const QJsonObject f = fixture();
        QCOMPARE(f[u"step"].toDouble(), kLevelStep);
        QCOMPARE(f[u"gapMs"].toDouble(), kGapMs);
        for (const QJsonValue& n : f[u"near"].toArray()) {
            const auto [below, above] = nearLevels(n[u"price"].toDouble());
            QCOMPARE(below, n[u"out"][u"below"].toDouble());
            QCOMPARE(above, n[u"out"][u"above"].toDouble());
        }
        for (const QJsonValue& t : f[u"text"].toArray()) {
            const QJsonObject h = t[u"hit"].toObject();
            const Hit hit{h[u"level"].toDouble(), h[u"direction"].toString(), h[u"price"].toDouble(), h[u"source"].toString(), h[u"at"].toDouble(), h[u"skipped"].toInt()};
            QCOMPARE(levelHitTitle(u"SPX"_s, hit), t[u"title"].toString());
            QCOMPARE(levelHitBody(hit), t[u"body"].toString());
        }
    }

    // 两秒一问;穿过 7725 报一次:一声升调、弹窗一条(落到交易页)
    void pollsEveryTwoSecondsAndAnnounces() {
        Rig rig;
        rig.tick(true);
        QVERIFY(rig.logs.contains(u"[fake] options.spot {\"symbol\":\"SPX\"}"_s));
        QCOMPARE(rig.spot.quote()[u"price"].toDouble(), 7712.0);
        rig.clock += 1'000;
        rig.tick(false);  // 还没到两秒
        rig.clock += 1'000;
        rig.quote(7726.4, u"quote"_s);
        rig.tick(true);
        QCOMPARE(rig.outputs.sounds.size(), 1);
        QCOMPARE(rig.outputs.sounds.at(0), shell::tone::wav(u"up"_s));
        QCOMPARE(rig.popup.items().size(), 1);
        const QJsonObject item = rig.popup.items().at(0).toObject();
        QCOMPARE(item[u"id"].toString(), u"spot:SPX:7725:%1"_s.arg(qint64(rig.clock)));
        QCOMPARE(item[u"title"].toString(), u"SPX 上穿 7725"_s);
        QCOMPARE(item[u"body"].toString(), u"现价 7726.40"_s);
        QCOMPARE(item[u"page"].toString(), u"trade"_s);
        QCOMPARE(item[u"tone"].toString(), u"up"_s);
        QCOMPARE(rig.spot.lastHit()[u"level"].toDouble(), 7725.0);
        QCOMPARE(rig.outputs.notices.size(), 0);
    }

    // 弹窗关着:退回系统通知
    void popupOffFallsBackToNotice() {
        Rig rig;
        rig.alerter.setPopupEnabled(false);
        rig.quote(7712, u"futures"_s);  // 换了来源的一笔只登记:两笔都是期货推算的
        rig.tick(true);
        rig.clock += 2'000;
        rig.quote(7698, u"futures"_s);
        rig.tick(true);
        QCOMPARE(rig.outputs.notices.size(), 1);
        QCOMPARE(rig.outputs.notices.at(0).first, u"SPX 下破 7700"_s);
        QCOMPARE(rig.outputs.notices.at(0).second, u"现价 7698.00(按期货推算)"_s);
    }

    // 提醒关着:只在面板看得见时问,也不报;重新打开后的第一笔只登记
    void alertOffOnlyPollsWhenVisible() {
        Rig rig;
        rig.spot.setAlert(false);
        rig.tick(false);
        rig.spot.setVisible(true);  // 看得见:当场问一次
        QTRY_COMPARE(rig.calls(), 1);
        rig.clock += 2'000;
        rig.quote(7730, u"quote"_s);
        rig.tick(true);
        QCOMPARE(rig.outputs.sounds.size(), 0);
        rig.spot.setVisible(false);
        rig.clock += 2'000;
        rig.tick(false);
        rig.clock += 2'000;
        rig.spot.setAlert(true);  // 打开:当场问一次,这一笔只登记
        QTRY_COMPARE(rig.calls(), 3);
        QTest::qWait(30);
        rig.clock += 2'000;
        rig.quote(7751, u"quote"_s);
        rig.tick(true);
        QCOMPARE(rig.outputs.sounds.size(), 1);
        QCOMPARE(rig.spot.lastHit()[u"level"].toDouble(), 7750.0);
    }

    void disconnectedClearsAndDoesNotPoll() {
        Rig rig(false);
        rig.tick(false);
        QVERIFY(rig.spot.quote().isNull());
    }

    void failureIsKept() {
        Rig rig;
        rig.write(QJsonObject{{u"__error"_s, u"读道满了"_s}});
        rig.tick(true);
        QTRY_COMPARE(rig.spot.failure(), u"读道满了"_s);
        QVERIFY(rig.spot.quote().isNull());
    }

    // 开关记在本机,下次启动还是关着
    void alertPreferencePersists() {
        QTemporaryDir dir;
        const QString ini = dir.filePath(u"prefs.ini"_s);
        {
            Rig rig(true, ini);
            QVERIFY(rig.spot.alertOn());
            rig.spot.setAlert(false);
        }
        Rig rig(true, ini);
        QVERIFY(!rig.spot.alertOn());
    }
};

QTEST_GUILESS_MAIN(TestSpotStore)
#include "tst_spot_store.moc"
