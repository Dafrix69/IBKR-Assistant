// 情报页、档案抽屉、⌘K 查标的的接线(shell/intel_controller,照 pages/Intel.tsx、shell/DossierHost.tsx):对着假引擎。
//   · 进页拉一次时间线、记成看过了;切走清掉关键字;窗口回到前台只在人在这一页时记成看过;
//   · 种类分段「全部」不筛、别的只筛那一种;只看持仓带 held_only;关键字只在界面里筛(不问引擎);
//   · 券商没连时页头一句;档案开了有模型、关了是空的;查标的认得出代码、带着持仓与最近查过的。
#include "shell/alerter.h"
#include "shell/bridge.h"
#include "shell/consent.h"
#include "shell/feed_stores.h"
#include "shell/intel_controller.h"
#include "shell/popup_rules.h"
#include "shell/status_store.h"
#include "shell_harness.h"

#include <QJsonArray>
#include <QTemporaryDir>

using namespace ibkr;
using namespace ibkr::test;
using namespace Qt::StringLiterals;

namespace {

QJsonObject obj(const char* t) { return QJsonDocument::fromJson(t).object(); }

struct NoOutputs : shell::AlertOutputs {
    void playWav(const QByteArray&) override {}
    bool notify(const QString&, const QString&) override { return true; }
};

const char* kFeed = R"({"items":[
  {"id":"message:9","kind":"message","at":1792303000000,"symbols":["SPX"],"guesses":[],"held":["SPX"],"title":"7720 7725 bear call","body":"","tone":"info","source":"Charlie","trusted":true,"ref":"9"},
  {"id":"signal:4","kind":"signal","at":1792302000000,"symbols":["NVDA"],"guesses":[],"held":[],"title":"NVDA 上穿 220","body":"价位穿越","tone":"up","source":"cross","ref":"4"}],
  "held":["SPX","NVDA"],"total_messages":12,"at":1792303200000,"connected":true})";
const char* kDossier = R"({"symbol":"NVDA","at":1792303200000,"connected":true,"held":true,"quote":{"price":219.74,"change_pct":1.2,"source":"quote"},
  "positions":[],"tracks":[],"working":[],"sectors":[],"watch":null,"quality":null,"ideas":[],"events":[],"signals":[],"mentions_7d":0,"timeline":[]})";

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
    NoOutputs outputs;
    shell::Alerter alerter{&popup, &outputs, QString()};
    QJsonObject results;

    explicit Rig(bool connected = true)
        : engine(fakeEngine({{u"FAKE_STATUS"_s, connected ? u"{\"broker_connected\":true}"_s : u"{\"broker_connected\":false}"_s}, {u"FAKE_LOG_PARAMS"_s, u"1"_s},
                             {u"FAKE_RESULTS_FILE"_s, resultsPath}}),
                 40) {
        QObject::connect(&engine, &shell::EngineClient::logLine, [this](const QString& l) { logs.append(l); });
        set(u"intel.feed"_s, obj(kFeed));
        set(u"intel.dossier"_s, obj(kDossier));
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
        f.write(QJsonDocument(results).toJson(QJsonDocument::Compact));
    }
    int calls(const QString& method) const { return int(logs.filter(u"[fake] "_s + method + u' ').size()); }
    QStringList params(const QString& method) const {
        QStringList out;
        for (const QString& l : logs)
            if (l.startsWith(u"[fake] "_s + method + u' ')) out << l.mid(8 + method.size());
        return out;
    }
};

const char* kMention = R"({"kind":"held_mention","message_id":"m1","at":1792303200000,"author_name":"Charlie","text":"NVDA 走了","symbols":["NVDA"],"prices":{}})";

}  // namespace

class TestIntelController : public QObject {
    Q_OBJECT
private slots:
    void visibleLoadsAndMarksSeen() {
        Rig rig;
        shell::IntelStore store(&rig.bridge, &rig.alerter, QString());
        shell::IntelController page(&store, &rig.status);
        store.onEngineEvent(u"intel"_s, obj(kMention));
        QCOMPARE(store.unread(), 1);
        // 没挂上:窗口回到前台也不算看过
        page.windowFocused();
        QCOMPARE(store.unread(), 1);
        page.setVisible(true);
        QCOMPARE(store.unread(), 0);
        QTRY_VERIFY(page.page()[u"timeline"_s].isObject());
        QCOMPARE(rig.calls(u"intel.feed"_s), 1);
        QCOMPARE(rig.params(u"intel.feed"_s).first(), u"{\"limit\":300}"_s);
        QCOMPARE(page.page()[u"count"_s].toString(), u"2 条 · 共记 12 条消息"_s);
        // 挂着时窗口回到前台:看过了
        store.onEngineEvent(u"intel"_s, obj(kMention));
        QCOMPARE(store.unread(), 1);
        page.windowFocused();
        QCOMPARE(store.unread(), 0);
        // 关键字只在界面里筛,不问引擎;切走清掉
        page.setQuery(u"NVDA"_s);
        QCOMPARE(page.page()[u"count"_s].toString(), u"1 条 · 共记 12 条消息"_s);
        QCOMPARE(page.page()[u"query"_s].toString(), u"NVDA"_s);
        QTest::qWait(100);
        QCOMPARE(rig.calls(u"intel.feed"_s), 1);
        page.setVisible(false);
        QCOMPARE(page.page()[u"query"_s].toString(), QString());
    }

    void kindsAndHeldOnlyGoToTheEngine() {
        Rig rig;
        shell::IntelStore store(&rig.bridge, &rig.alerter, QString());
        shell::IntelController page(&store, &rig.status);
        page.setVisible(true);
        QTRY_COMPARE(rig.calls(u"intel.feed"_s), 1);
        QTRY_VERIFY(!page.page()[u"loading"_s].toBool());
        page.setKind(u"signal"_s);
        QTRY_COMPARE(rig.calls(u"intel.feed"_s), 2);
        QCOMPARE(rig.params(u"intel.feed"_s).last(), u"{\"kinds\":[\"signal\"],\"limit\":300}"_s);
        QTRY_COMPARE(page.page()[u"kind"_s].toString(), u"signal"_s);
        QTRY_VERIFY(!page.page()[u"loading"_s].toBool());
        page.setKind(u"all"_s);
        QTRY_COMPARE(rig.calls(u"intel.feed"_s), 3);
        QCOMPARE(rig.params(u"intel.feed"_s).last(), u"{\"limit\":300}"_s);
        QTRY_VERIFY(!page.page()[u"loading"_s].toBool());
        page.setHeldOnly(true);
        QTRY_COMPARE(rig.calls(u"intel.feed"_s), 4);
        QCOMPARE(rig.params(u"intel.feed"_s).last(), u"{\"held_only\":true,\"limit\":300}"_s);
        QTRY_VERIFY(page.page()[u"heldOnly"_s].toBool());
        QTRY_VERIFY(!page.page()[u"loading"_s].toBool());
        page.reload();
        QTRY_COMPARE(rig.calls(u"intel.feed"_s), 5);
    }

    void notConnectedNotice() {
        Rig rig(false);
        shell::IntelStore store(&rig.bridge, &rig.alerter, QString());
        shell::IntelController page(&store, &rig.status);
        rig.status.refresh();
        QTRY_COMPARE(page.page()[u"notices"_s].toArray().size(), 1);
        QCOMPARE(page.page()[u"notices"_s][0][u"title"_s].toString(), u"没连券商"_s);
    }

    void dossierAndLookup() {
        Rig rig;
        shell::IntelStore store(&rig.bridge, &rig.alerter, QString());
        shell::IntelController page(&store, &rig.status);
        page.setVisible(true);
        QTRY_VERIFY(page.page()[u"timeline"_s].isObject());
        QVERIFY(page.dossier().isEmpty());
        page.setLookupOpen(true);
        QVERIFY(page.lookupOpen());
        const QJsonObject lk = page.lookup(u" $nvda"_s);
        QCOMPARE(lk[u"symbol"_s].toString(), u"NVDA"_s);
        QCOMPARE(lk[u"held"_s].toArray(), (QJsonArray{u"SPX"_s, u"NVDA"_s}));
        page.openDossier(u"nvda"_s);
        QVERIFY(!page.lookupOpen());  // 打开档案顺手关掉查标的
        QCOMPARE(page.dossier()[u"symbol"_s].toString(), u"NVDA"_s);
        QTRY_VERIFY(page.dossier()[u"ready"_s].toBool());
        QCOMPARE(page.dossier()[u"head"_s][u"price"_s].toString(), u"219.74"_s);
        QCOMPARE(page.lookup(QString())[u"recent"_s].toArray(), QJsonArray{u"NVDA"_s});
        page.refreshDossier();
        QTRY_COMPARE(rig.calls(u"intel.dossier"_s), 2);
        page.closeDossier();
        QVERIFY(page.dossier().isEmpty());
    }
};

QTEST_GUILESS_MAIN(TestIntelController)
#include "tst_intel_controller.moc"
