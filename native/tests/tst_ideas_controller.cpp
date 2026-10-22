// 想法页的接线(shell/ideas_controller,照 pages/Ideas.tsx):对着假引擎。
//   · 挂上即读(ideas.list { status: active } + ideas.digests),停留期间按节拍再读,卸下就停、状态清空;
//   · 「全部」不带 status;检索走 ideas.search { q, status?, limit: 200 },命中方式跟着;
//   · 记下:去两头空白、空的不发;成了发 added 并回到「进行中」;失败一句横幅;
//   · 完成 / 归档:ideas.update 再读;AI 分析:那一张分析中,完了再读,失败横幅前缀只一次;
//   · 总结:ideas.digest { scope: all, trades, focus?: { q } },读完总结历史才撤掉「总结中…」;
//   · 发到解析:原文进交易指令页的输入框、清掉上一次的结果,壳切到 trade。
#include "shell/bridge.h"
#include "shell/consent.h"
#include "shell/engine_command.h"
#include "shell/ideas_controller.h"
#include "shell/status_store.h"
#include "shell/trade_composer.h"
#include "shell_harness.h"

#include <QJsonArray>
#include <QSignalSpy>
#include <QTemporaryDir>

using namespace ibkr;
using namespace ibkr::test;
using namespace Qt::StringLiterals;

namespace {

QJsonObject obj(const char* t) { return QJsonDocument::fromJson(t).object(); }

const char* kIdeas = R"({"ideas":[
  {"id":"i1","text":"AXTI 周五尾盘买入","status":"active","symbols":["AXTI"],"created_at":"2026-08-20T20:00:00Z"},
  {"id":"i2","text":"留意 SPY 770","status":"done","symbols":["SPY"],"created_at":"2026-08-19T14:00:00Z"}]})";

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
    QJsonObject results;

    explicit Rig(const QString& delays = {})
        : engine(fakeEngine({{u"FAKE_LOG_PARAMS"_s, u"1"_s}, {u"FAKE_RESULTS_FILE"_s, resultsPath}, {u"FAKE_DELAY_METHODS"_s, delays}}), 40) {
        QObject::connect(&engine, &shell::EngineClient::logLine, [this](const QString& l) { logs.append(l); });
        set(u"ideas.list"_s, obj(kIdeas));
        set(u"ideas.digests"_s, obj(R"({"digests":[]})"));
        set(u"ideas.search"_s, obj(R"({"hits":[{"idea":{"id":"i1","text":"AXTI","status":"active","symbols":["AXTI"],"created_at":"2026-08-20T20:00:00Z"},"matched_by":["symbol","semantic"]}]})"));
    }
    ~Rig() {
        shell::StopOptions o;
        o.drainMs = 0;
        stopSync(engine, o);
    }
    void set(const QString& method, const QJsonValue& result) {
        results.insert(method, result);
        QFile f(resultsPath);
        QVERIFY(f.open(QIODevice::WriteOnly));
        f.write(QJsonDocument(results).toJson());
    }
    int calls(const QString& method) const { return int(logs.filter(u"[fake] "_s + method + u' ').size()); }
    QStringList params(const QString& method) const {
        QStringList out;
        for (const QString& l : logs)
            if (l.startsWith(u"[fake] "_s + method + u' ')) out << l.mid(8 + method.size());
        return out;
    }
};

int cards(const shell::IdeasController& c) { return int(c.page()[u"cards"_s].toArray().size()); }

}  // namespace

class TestIdeasController : public QObject {
    Q_OBJECT
private slots:
    void loadsFilterSearchAndPoll() {
        Rig rig;
        shell::IdeasController page(&rig.bridge, &rig.status, nullptr);
        page.refreshMs = 150;
        QTest::qWait(60);
        QCOMPARE(rig.calls(u"ideas.list"_s), 0);
        page.setVisible(true);
        QTRY_COMPARE(cards(page), 2);
        QCOMPARE(rig.params(u"ideas.list"_s).first(), u"{\"status\":\"active\"}"_s);
        QVERIFY(rig.calls(u"ideas.digests"_s) >= 1);
        QTRY_VERIFY(rig.calls(u"ideas.list"_s) >= 3);
        page.setFilter(u"all"_s);
        QTRY_VERIFY(rig.params(u"ideas.list"_s).contains(u"{}"_s));
        page.search(u"  蝴蝶 "_s);
        QTRY_COMPARE(cards(page), 1);
        QCOMPARE(rig.params(u"ideas.search"_s).first(), u"{\"limit\":200,\"q\":\"蝴蝶\"}"_s);
        QCOMPARE(page.page()[u"cards"_s][0][u"meta"_s][1][u"text"_s].toString(), u"标的命中 · 语义相近"_s);
        QCOMPARE(page.page()[u"digestButton"_s].toString(), u"按检索总结"_s);
        // 卸下:不再读,状态回到新挂上的样子
        page.setVisible(false);
        const int n = rig.calls(u"ideas.list"_s) + rig.calls(u"ideas.search"_s);
        QTest::qWait(400);
        QCOMPARE(rig.calls(u"ideas.list"_s) + rig.calls(u"ideas.search"_s), n);
        QCOMPARE(page.page()[u"filter"_s].toString(), u"active"_s);
        QCOMPARE(page.page()[u"query"_s].toString(), QString());
        QCOMPARE(cards(page), 0);
    }

    void addUpdateAnalyzeDigest() {
        Rig rig(u"ideas.analyze=40,ideas.digests=100,ideas.list=300"_s);
        rig.set(u"ideas.add"_s, obj(R"({"idea":{}})"));
        rig.set(u"ideas.update"_s, QJsonObject{});
        rig.set(u"ideas.analyze"_s, QJsonObject{});
        rig.set(u"ideas.digest"_s, QJsonObject{});
        shell::IdeasController page(&rig.bridge, &rig.status, nullptr);
        page.setVisible(true);
        QTRY_COMPARE(cards(page), 2);
        QSignalSpy added(&page, &shell::IdeasController::added);
        page.add(u"   "_s);
        QTest::qWait(50);
        QCOMPARE(rig.calls(u"ideas.add"_s), 0);
        page.setFilter(u"all"_s);
        page.add(u"  新想法 RKLB "_s);
        QTRY_COMPARE(added.size(), 1);
        QCOMPARE(rig.params(u"ideas.add"_s).first(), u"{\"text\":\"新想法 RKLB\"}"_s);
        QCOMPARE(page.page()[u"filter"_s].toString(), u"active"_s);
        rig.set(u"ideas.add"_s, QJsonObject{{u"__error"_s, u"库忙"_s}});
        page.add(u"x"_s);
        QTRY_COMPARE(rig.status.banner(), u"记录想法失败:库忙"_s);
        QCOMPARE(added.size(), 1);

        const int lists = rig.calls(u"ideas.list"_s);
        page.setStatus(u"i1"_s, u"done"_s);
        QTRY_COMPARE(rig.calls(u"ideas.list"_s), lists + 1);
        QCOMPARE(rig.params(u"ideas.update"_s).first(), u"{\"id\":\"i1\",\"status\":\"done\"}"_s);

        page.analyze(u"i1"_s);
        QCOMPARE(page.page()[u"cards"_s][0][u"analyzeLabel"_s].toString(), u"分析中…"_s);
        // 「分析中…」等到列表重读回来才撤:分析 40 毫秒就回来了,列表要 300——中间那一刻按钮还得是「分析中…」,不能又能点
        QTest::qWait(200);
        QCOMPARE(page.page()[u"cards"_s][0][u"analyzing"_s].toBool(), true);
        QTRY_COMPARE(page.page()[u"cards"_s][0][u"analyzing"_s].toBool(), false);
        QCOMPARE(rig.params(u"ideas.analyze"_s).first(), u"{\"id\":\"i1\"}"_s);
        rig.set(u"ideas.analyze"_s, QJsonObject{{u"__error"_s, u"AI 分析失败:没有配模型"_s}});
        page.analyze(u"i1"_s);
        QTRY_COMPARE(rig.status.banner(), u"AI 分析失败:没有配模型"_s);

        page.setWithTrades(false);
        page.digest();
        QCOMPARE(page.page()[u"digestButton"_s].toString(), u"总结中…"_s);
        QTRY_COMPARE(page.page()[u"digestButton"_s].toString(), u"总结知识"_s);
        QCOMPARE(rig.params(u"ideas.digest"_s).first(), u"{\"scope\":\"all\",\"trades\":false}"_s);
        page.search(u"结算"_s);
        page.digest();
        QTRY_COMPARE(rig.calls(u"ideas.digest"_s), 2);
        QCOMPARE(rig.params(u"ideas.digest"_s).last(), u"{\"focus\":{\"q\":\"结算\"},\"scope\":\"all\",\"trades\":false}"_s);
    }

    // 离开之前发出去的读列表,回来之后才到:不算数(原版组件卸载后 setState 不生效)
    void staleReplyAfterLeaveIsDropped() {
        Rig rig(u"ideas.list=250"_s);
        shell::IdeasController page(&rig.bridge, &rig.status, nullptr);
        page.setVisible(true);
        QTest::qWait(30);
        page.setVisible(false);
        QTest::qWait(400);
        QCOMPARE(cards(page), 0);
        QCOMPARE(page.page()[u"empty"_s].toString(), u"还没有进行中的想法。"_s);
    }

    void sendToTrade() {
        Rig rig;
        // 交易指令页上一次解析失败了(留着一句「失败」):发到解析要把它连同上一次的结果一起清掉(setTradeDraft),不是只换字
        shell::trade::ComposerDeps deps;
        deps.submit = [](const QString&, bool, const QStringList&, shell::trade::ComposerDeps::Reply done) {
            shell::EngineReply r;
            r.error = u"解析失败:看不懂"_s;
            done(r);
        };
        deps.reload = [](std::function<void()> done) { done(); };
        deps.banner = [](const QString&, bool) {};
        deps.nowMs = [] { return 0.0; };
        deps.confirm = [](const QJsonObject&, std::function<void(bool)> done) { done(false); };
        deps.brokerShortName = [] { return u"IBKR"_s; };
        shell::TradeComposer composer(deps, rig.dir.filePath(u"qt-settings.ini"_s));
        composer.setText(u"旧的指令"_s);
        composer.submit(false, {u"模拟"_s});
        QCOMPARE(composer.failure(), u"解析失败:看不懂"_s);
        shell::IdeasController page(&rig.bridge, &rig.status, &composer);
        page.setVisible(true);
        QTRY_COMPARE(cards(page), 2);
        QSignalSpy nav(&page, &shell::IdeasController::navigateRequested);
        page.sendToTrade(u"i2"_s);
        QCOMPARE(composer.text(), u"留意 SPY 770"_s);
        QCOMPARE(composer.failure(), QString());
        QVERIFY(composer.payload().isUndefined() || composer.payload().isNull());
        QCOMPARE(nav.size(), 1);
        QCOMPARE(nav.first().first().toString(), u"trade"_s);
    }
};

QTEST_GUILESS_MAIN(TestIdeasController)
#include "tst_ideas_controller.moc"
