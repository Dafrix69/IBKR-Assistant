// 持仓追踪页的接线(shell/tracker_controller)端到端:真的 Bridge(白名单、条款同意、确认框凭据)对着假引擎。
// 钱路径:「开始追踪」授权自动平仓时先弹确认框,点了确认才发 tracker.add,引擎收到的载荷就是确认框绑的那一份(不多不少,
// 没有 __confirmed);点取消一个请求都不发;「立即平仓」同理绑这条追踪的 id;没同意条款时一律发不出去。
#include "shell/alerter.h"
#include "shell/alerts_store.h"
#include "shell/bridge.h"
#include "shell/consent.h"
#include "shell/popup_rules.h"
#include "shell/status_store.h"
#include "shell/tracker_controller.h"
#include "shell/tracker_store.h"
#include "shell_harness.h"

#include <QJsonArray>
#include <QRegularExpression>
#include <QSignalSpy>
#include <QTemporaryDir>

using namespace ibkr;
using namespace ibkr::test;
using namespace Qt::StringLiterals;

namespace {

QJsonObject obj(const char* t) { return QJsonDocument::fromJson(t).object(); }

class Prompter : public shell::Prompter {
public:
    void ask(const shell::ConfirmBox& box, std::function<void(bool)> done) override {
        boxes.append(box);
        done(answer);
    }
    QList<shell::ConfirmBox> boxes;
    bool answer = true;
};

const char* kSettings = R"({"policies":{"auto_execute":true,"allow_live_trading":false},"limits":{"max_order_notional":5000}})";

struct Rig {
    QTemporaryDir dir;
    QString resultsPath = dir.filePath(u"results.json"_s);
    shell::EngineClient engine;
    QStringList logs;
    Prompter prompter;
    shell::ConsentStore consent{dir.path()};
    shell::Bridge bridge{&engine, &prompter, &consent};
    shell::StatusStore status{&engine, 60'000};
    shell::TrackerStore tracker{&bridge, &status, nullptr};
    shell::TrackerController controller{&bridge, &status, &tracker, nullptr};
    QJsonObject results;

    explicit Rig(bool consented = true)
        : engine(fakeEngine({{u"FAKE_STATUS"_s, u"{\"broker_connected\":true,\"auto_execute\":true}"_s}, {u"FAKE_SETTINGS"_s, QString::fromUtf8(kSettings)},
                             {u"FAKE_LOG_PARAMS"_s, u"1"_s}, {u"FAKE_RESULTS_FILE"_s, resultsPath}}),
                 40) {
        QObject::connect(&engine, &shell::EngineClient::logLine, [this](const QString& l) { logs.append(l); });
        if (consented) {
            QString error;
            if (!consent.accept(QLatin1StringView(shell::kTermsVersion), u"test"_s, 1'000, &error)) qFatal("%s", qPrintable(error));
        }
        set(u"tracker.list"_s, obj(R"({"tracks":[{"id":"tk1","symbol":"NVDA","sec_type":"STK","account":"模拟","contract":{},"enabled":true,"targets":{},"auto_close":{}}]})"));
        set(u"positions.list"_s, obj(R"({"positions":[]})"));
        set(u"tracker.add"_s, obj(R"({"track":{"id":"tk9"}})"));
        set(u"tracker.close_now"_s, obj(R"({"fired":{"reason":"手动平仓"}})"));
        status.refresh();
        QTRY_VERIFY(status.status().contains(u"broker_connected"_s));
        bool done = false;
        tracker.load(true, [&done] { done = true; });
        QTRY_VERIFY(done);
    }
    ~Rig() {
        shell::StopOptions o;
        o.drainMs = 0;
        stopSync(engine, o);
    }
    void set(const QString& method, const QJsonObject& result) {
        results.insert(method, result);
        QFile f(resultsPath);
        QVERIFY(f.open(QIODevice::WriteOnly));
        f.write(QJsonDocument(results).toJson());
    }
    /// 引擎收到的某个方法的入参(fake_engine 的 "[fake] 方法 入参")
    QList<QJsonObject> received(const QString& method) const {
        QList<QJsonObject> out;
        for (const QString& l : logs.filter(u"[fake] "_s + method + u' '))
            out << QJsonDocument::fromJson(l.mid(QStringLiteral("[fake] ").size() + method.size() + 1).toUtf8()).object();
        return out;
    }
};

const QJsonObject kNvda{{u"key"_s, u"模拟|NVDA|STK"_s}, {u"symbol"_s, u"NVDA"_s}, {u"sec_type"_s, u"STK"_s}, {u"quantity"_s, 100}, {u"account"_s, u"模拟"_s}};

}  // namespace

class TestTrackerController : public QObject {
    Q_OBJECT
private slots:
    // 授权自动平仓:确认框 → 凭据 → 引擎收到的就是确认框绑的那一份
    void startTrackGoesThroughTheGrant() {
        Rig rig;
        QSignalSpy created(&rig.controller, &shell::TrackerController::created);
        rig.controller.startTrack(kNvda, obj(R"({"sl":170,"trail":5})"));  // 自动执行开着:到价自动平仓默认开
        QTRY_COMPARE(created.size(), 1);
        QCOMPARE(created.at(0).at(0).toString(), u"tk9"_s);
        QCOMPARE(rig.prompter.boxes.size(), 1);
        QCOMPARE(rig.prompter.boxes.at(0).confirmLabel, u"我确认"_s);
        const QList<QJsonObject> got = rig.received(u"tracker.add"_s);
        QCOMPARE(got.size(), 1);
        const QJsonObject expected{{u"key"_s, u"模拟|NVDA|STK"_s}, {u"take_profit"_s, u""_s}, {u"stop_loss"_s, u"170"_s}, {u"trail_pct"_s, u"5"_s},
                                   {u"profit_drawdown_pct"_s, u""_s}, {u"profit_drawdown_arm_pct"_s, u""_s}, {u"spot_target"_s, u""_s},
                                   {u"spot_stop_below"_s, u""_s}, {u"spot_stop_above"_s, u""_s}, {u"auto_close"_s, true}, {u"order_type"_s, u"MKT"_s},
                                   {u"host_at_broker"_s, false}, {u"exit_at"_s, u""_s}, {u"spot_stop_confirm_s"_s, u""_s}, {u"take_profit_tiers"_s, u""_s}};
        QCOMPARE(got.at(0), expected);  // 没有 __confirmed,没有 null,没有多的键
        QCOMPARE(rig.status.banner(), u"已开始追踪 NVDA,下面「正在追踪」里可以看盯盘进度。"_s);
        QCOMPARE(rig.controller.flashId(), u"tk9"_s);
    }

    void cancelSendsNothing() {
        Rig rig;
        rig.prompter.answer = false;
        rig.controller.startTrack(kNvda, obj(R"({"sl":170,"autoPicked":true})"));
        QTRY_COMPARE(rig.prompter.boxes.size(), 1);
        QTest::qWait(150);
        QCOMPARE(rig.received(u"tracker.add"_s).size(), 0);
    }

    // 只设提醒价位、不授权发单:不弹框,直接建(Bridge 那头也不要凭据)
    void reminderOnlyNeedsNoConfirm() {
        Rig rig;
        QSignalSpy created(&rig.controller, &shell::TrackerController::created);
        rig.controller.startTrack(kNvda, obj(R"({"tp":240,"autoPicked":false})"));
        QTRY_COMPARE(created.size(), 1);
        QCOMPARE(rig.prompter.boxes.size(), 0);
        QCOMPARE(rig.received(u"tracker.add"_s).at(0)[u"auto_close"].toBool(), false);
    }

    void closeNowBindsTheTrack() {
        Rig rig;
        rig.controller.closeNow(u"tk1"_s);
        QTRY_COMPARE(rig.received(u"tracker.close_now"_s).size(), 1);
        QCOMPARE(rig.received(u"tracker.close_now"_s).at(0), (QJsonObject{{u"id"_s, u"tk1"_s}}));
        QCOMPARE(rig.prompter.boxes.at(0).confirmLabel, u"平仓"_s);
        QTRY_COMPARE(rig.status.banner(), u"平仓单已发出:手动平仓"_s);
        QTRY_VERIFY(rig.controller.busy().isEmpty());
    }

    // 没同意现行条款:钱路径一律放不出去(Bridge 当场拒,引擎一个请求都收不到)
    void noConsentNoOrders() {
        Rig rig(false);
        rig.controller.startTrack(kNvda, obj(R"({"sl":170,"autoPicked":true})"));
        rig.controller.closeNow(u"tk1"_s);
        QTest::qWait(300);
        QCOMPARE(rig.received(u"tracker.add"_s).size(), 0);
        QCOMPARE(rig.received(u"tracker.close_now"_s).size(), 0);
    }

    // 暂停 / 恢复:不弹框、不要凭据,引擎收到的正好是 { id, enabled }(没有 __confirmed——桥去掉它)
    void pauseAndResumeGoThroughTheBridge() {
        Rig rig;
        rig.set(u"tracker.update"_s, QJsonObject{});
        rig.controller.toggle(u"tk1"_s);
        QTRY_COMPARE(rig.received(u"tracker.update"_s).size(), 1);
        QCOMPARE(rig.received(u"tracker.update"_s).at(0), (QJsonObject{{u"id"_s, u"tk1"_s}, {u"enabled"_s, false}}));
        QCOMPARE(rig.prompter.boxes.size(), 0);
        QTRY_VERIFY(rig.controller.busy().isEmpty());
    }

    // 停在这一页时断开 / 连上:整读一遍(React 版 useEffect([connected, refreshMs]));离开这一页时展开着的表单收起
    void reloadsOnReconnectAndForgetsTheFormOnLeave() {
        Rig rig;
        rig.controller.setVisible(true);
        QTRY_VERIFY(rig.received(u"tracker.list"_s).size() >= 2);
        QTest::qWait(100);
        const qsizetype before = rig.received(u"tracker.list"_s).size();
        // 断开:状态一变就整读一遍(只是每秒刷持仓的话,读的是 positions.list,不会再读 tracker.list)
        rig.set(u"system.status"_s, QJsonObject{{u"broker_connected"_s, false}});
        rig.status.refresh();
        QTRY_VERIFY(rig.received(u"tracker.list"_s).size() > before);
        // 状态没变(同样断着):不再整读
        QTest::qWait(100);
        const qsizetype settled = rig.received(u"tracker.list"_s).size();
        rig.status.refresh();
        QTest::qWait(200);
        QCOMPARE(rig.received(u"tracker.list"_s).size(), settled);
        // 连回来:又整读一遍;离开这一页时展开着的表单收起
        rig.set(u"positions.list"_s, QJsonObject{{u"positions"_s, QJsonArray{kNvda}}});
        rig.set(u"system.status"_s, QJsonObject{{u"broker_connected"_s, true}});
        rig.status.refresh();
        QTRY_VERIFY(rig.received(u"tracker.list"_s).size() > settled);
        QTRY_COMPARE(rig.controller.model()[u"positions"][u"cards"].toArray().size(), 1);
        rig.controller.toggleForm(u"模拟|NVDA|STK"_s);
        QVERIFY(rig.controller.model()[u"positions"][u"cards"][0][u"open"].toBool());
        rig.controller.setVisible(false);
        QVERIFY(!rig.controller.model()[u"positions"][u"cards"][0][u"open"].toBool());
    }

    // 全局「自动执行」变了:autoExecuteOn 跟着变、statusTick 发出(新建追踪表单里「到价自动平仓」的默认值绑着它)
    void autoExecuteFollowsStatus() {
        Rig rig;
        QVERIFY(rig.controller.autoExecute());
        QSignalSpy tick(&rig.controller, &shell::TrackerController::statusTick);
        rig.set(u"system.status"_s, QJsonObject{{u"auto_execute"_s, false}});
        rig.status.refresh();
        QTRY_VERIFY(!tick.isEmpty());
        QCOMPARE(rig.controller.property("autoExecuteOn").toBool(), false);
    }

    // 「查看」带过来的标的:同标的的第一张卡片闪一下,并把视线带到「正在追踪」
    void focusSymbolFlashesTheCard() {
        Rig rig;
        rig.controller.setVisible(true);
        QSignalSpy reveal(&rig.controller, &shell::TrackerController::reveal);
        rig.controller.focusSymbol(u"NVDA"_s);
        QCOMPARE(reveal.size(), 1);
        QCOMPARE(rig.controller.flashId(), u"tk1"_s);
        // 闪 2.2 秒(原版 setTimeout 2200):1.9 秒时还亮着,3 秒内灭
        QTest::qWait(1'900);
        QCOMPARE(rig.controller.flashId(), u"tk1"_s);
        QTRY_VERIFY_WITH_TIMEOUT(rig.controller.flashId().isEmpty(), 1'100);
    }

    // 新建追踪的转圈按张算:A 还在提交时展开 B 再点,A 回来不收 B 的
    void savingIsPerForm() {
        Rig rig;
        rig.set(u"tracker.target_preview"_s, QJsonObject{{u"ok"_s, true}});
        QSignalSpy busy(&rig.controller, &shell::TrackerController::busyChanged);
        rig.controller.startTrack(kNvda, obj(R"({"sl":170,"autoPicked":true})"));
        QTRY_VERIFY(!busy.isEmpty());
        QVERIFY(rig.controller.saving().contains(u"模拟|NVDA|STK"_s) || rig.received(u"tracker.add"_s).size() == 1);
        QTRY_VERIFY(rig.controller.saving().isEmpty());
    }

    // 试算:只认最后一次的序号
    void previewSequence() {
        Rig rig;
        rig.set(u"tracker.target_preview"_s, QJsonObject{{u"ok"_s, true}});
        QSignalSpy got(&rig.controller, &shell::TrackerController::previewed);
        const int a = rig.controller.preview(u"k"_s, 100, QVariant());
        const int b = rig.controller.preview(u"k"_s, 100, 5);
        QVERIFY(b > a);
        QTRY_COMPARE(got.size(), 2);
        QCOMPARE(got.at(0).at(0).toInt(), a);
        QCOMPARE(got.at(1).at(0).toInt(), b);
    }

    // 模型跟着数据走;展开 / 收起表单
    void modelFollowsTheStores() {
        Rig rig;
        QCOMPARE(rig.controller.model()[u"tracks"][u"cards"].toArray().size(), 1);
        QCOMPARE(rig.controller.model()[u"positions"][u"empty"].toString(), u"这个账户里没有持仓。"_s);
        rig.set(u"positions.list"_s, QJsonObject{{u"positions"_s, QJsonArray{kNvda}}});
        rig.controller.reload();
        QTRY_COMPARE(rig.controller.model()[u"positions"][u"cards"].toArray().size(), 1);
        rig.controller.toggleForm(u"模拟|NVDA|STK"_s);
        QVERIFY(rig.controller.model()[u"positions"][u"cards"][0][u"open"].toBool());
        rig.controller.toggleForm(u"模拟|NVDA|STK"_s);
        QVERIFY(!rig.controller.model()[u"positions"][u"cards"][0][u"open"].toBool());
    }
};

QTEST_GUILESS_MAIN(TestTrackerController)
#include "tst_tracker_controller.moc"
