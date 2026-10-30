// 蝴蝶测算的 store(shell/fly_store)对着原 store/flyPlan.ts 真跑出来的步骤逐步比(tests/fixtures/gen_fly_plan.mjs 的 store / recorder / reset):
// 测算、表单没齐、自动刷新那一路(成功留结果、失败关自动)、忙着时再按、记录器的读与开关;自动刷新的计时只在看得见时跑。
#include "shell/fly_store.h"

#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QSignalSpy>
#include <QTest>

using namespace ibkr;
using namespace ibkr::shell;
using namespace Qt::StringLiterals;

namespace {

QJsonObject fixture() {
    static const QJsonObject j = [] {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/fly-plan.json"));
        if (!f.open(QIODevice::ReadOnly)) qFatal("fly-plan.json 打不开");
        return QJsonDocument::fromJson(f.readAll()).object();
    }();
    return j;
}

EngineReply replyOf(const QJsonValue& v) {
    EngineReply r;
    if (v.isString() && v.toString().startsWith(u"throw:"_s)) {
        r.error = v.toString().mid(6);
    } else {
        r.ok = true;
        r.result = v;
    }
    return r;
}

struct Fake {
    QJsonArray calls;
    QJsonValue result;
    QJsonValue recorder;
    QJsonValue setResult;
    /// 入场助手的回执;isUndefined = 没接这一路(老的步骤对拍就是这样跑的)
    QJsonValue assist = QJsonValue(QJsonValue::Undefined);
    bool hold = false;
    std::function<void()> release;
    fly::StoreDeps deps() {
        fly::StoreDeps d;
        d.plan = [this](const QJsonObject& params, fly::StoreDeps::Reply done) {
            calls.append(QJsonObject{{u"call"_s, u"flyPlan"_s}, {u"args"_s, QJsonArray{params}}});
            const EngineReply r = replyOf(result);
            if (hold) release = [done, r] { done(r); };
            else done(r);
        };
        d.recorder = [this](fly::StoreDeps::Reply done) {
            calls.append(QJsonObject{{u"call"_s, u"ivRecorder"_s}, {u"args"_s, QJsonArray{}}});
            done(replyOf(recorder));
        };
        d.setRecorder = [this](bool enabled, fly::StoreDeps::Reply done) {
            calls.append(QJsonObject{{u"call"_s, u"setIvRecorder"_s}, {u"args"_s, QJsonArray{enabled}}});
            done(replyOf(setResult));
        };
        d.nowMs = [] { return fixture()[u"now"].toDouble(); };
        if (!assist.isUndefined())
            d.assist = [this](fly::StoreDeps::Reply done) {
                calls.append(QJsonObject{{u"call"_s, u"entryAssist"_s}, {u"args"_s, QJsonArray{}}});
                done(replyOf(assist));
            };
        return d;
    }
};

}  // namespace

class TestFlyStore : public QObject {
    Q_OBJECT
private slots:
    void matchesTsStore_data() {
        QTest::addColumn<QJsonObject>("c");
        for (const QJsonValue& c : fixture()[u"store"].toArray()) QTest::newRow(qPrintable(c[u"name"].toString())) << c.toObject();
    }
    void matchesTsStore() {
        QFETCH(QJsonObject, c);
        Fake fake;
        FlyStore store(fake.deps());
        store.reset();
        store.patch(c[u"form"].toObject());
        if (!c[u"pre"].isNull()) {
            fake.result = c[u"pre"];
            store.run(false);
        }
        if (c[u"autoBefore"].toBool()) store.set({{u"auto"_s, true}});
        fake.result = c[u"result"];
        fake.calls = {};
        QCOMPARE(store.plan(), c[u"before"].toObject());
        QJsonArray states;
        QObject::connect(&store, &FlyStore::changed, [&] { states.append(store.plan()); });
        if (c[u"during"].isObject()) {
            fake.hold = true;
            store.run(false);
            QCOMPARE(store.plan(), c[u"during"].toObject());
            store.run(false);  // 忙着:第二下什么都不做
            fake.release();
        } else {
            store.run(c[u"quiet"].toBool());
        }
        QCOMPARE(fake.calls, c[u"calls"].toArray());
        QCOMPARE(states, c[u"states"].toArray());
        QCOMPARE(store.plan(), c[u"after"].toObject());
    }

    void recorder() {
        for (const QJsonValue& c : fixture()[u"recorder"].toArray()) {
            Fake fake;
            fake.recorder = c[u"read"];
            fake.setResult = c[u"set"];
            FlyStore store(fake.deps());
            QSignalSpy done(&store, &FlyStore::recorderDone);
            if (!c[u"read"].isNull()) store.loadRecorder();
            if (!c[u"set"].isNull()) {
                store.setRecorder(false);
                QCOMPARE(done.size(), 1);
                QCOMPARE(done.at(0).at(0).toString(), c[u"failed"].isNull() ? QString() : c[u"failed"].toString());
            }
            QCOMPARE(fake.calls, c[u"calls"].toArray());
            QCOMPARE(store.plan().value(u"recorder"_s), c[u"recorder"]);
        }
    }

    void resetMatches() {
        Fake fake;
        FlyStore store(fake.deps());
        store.patch({{u"center"_s, u"7750"_s}});
        store.reset();
        QJsonObject want = fixture()[u"reset"].toObject();
        QJsonObject got = store.plan();
        got.insert(u"recorder"_s, want.value(u"recorder"_s));  // 记录器那一份 reset 不碰
        QCOMPARE(got, want);
    }

    // 自动刷新:只在看得见、开着时每 10 秒一轮;看不见就停;失败一次就关
    void autoRefreshOnlyWhenVisible() {
        Fake fake;
        fake.result = fixture()[u"store"].toArray().at(2)[u"result"];
        FlyStore store(fake.deps());
        store.autoRefreshMs = 150;
        store.patch(fixture()[u"form"].toArray().at(2)[u"form"].toObject());  // 「齐了」
        store.setAuto(true);  // 开的那一刻先算一次
        QCOMPARE(fake.calls.size(), 1);
        QCOMPARE(store.plan().value(u"auto"_s).toBool(), true);
        // 看不见:不刷
        QTest::qWait(400);
        QCOMPARE(fake.calls.size(), 1);
        store.setVisible(true);
        QTRY_COMPARE_WITH_TIMEOUT(fake.calls.size(), 2, 2'000);
        store.setVisible(false);
        const qsizetype stopped = fake.calls.size();
        QTest::qWait(400);
        QCOMPARE(fake.calls.size(), stopped);
        // 失败一次:自动关掉,不再刷
        fake.result = u"throw:引擎忙"_s;
        store.setVisible(true);
        QTRY_VERIFY_WITH_TIMEOUT(!store.plan().value(u"auto"_s).toBool(), 2'000);
        const qsizetype after = fake.calls.size();
        QTest::qWait(400);
        QCOMPARE(fake.calls.size(), after);
        QCOMPARE(FlyStore::kAutoRefreshMs, 10'000);  // 原版 AUTO_REFRESH_MS
    }
    /// 入场助手:只在看得见时问;建议翼宽是表单的默认值——没人改过翼宽、也没有结果时填进去,改过的不盖,reset 之后重新算
    void assistFillsDefaultWidth() {
        Fake fake;
        fake.assist = QJsonObject{{u"enabled"_s, true}, {u"width"_s, QJsonObject{{u"pick"_s, 30}, {u"text"_s, u"建议翼宽 30 点"_s}}}, {u"flags"_s, QJsonArray{}}};
        FlyStore store(fake.deps());
        store.assistRefreshMs = 60'000;
        QCOMPARE(fake.calls.size(), 0);  // 看不见不问
        store.setVisible(true);
        QCOMPARE(fake.calls.size(), 1);
        QCOMPARE(fake.calls.at(0)[u"call"].toString(), u"entryAssist"_s);
        QCOMPARE(store.plan()[u"form"][u"width"].toString(), u"30"_s);
        QCOMPARE(store.plan()[u"assist"][u"width"][u"pick"].toDouble(), 30.0);

        // 用户自己改了翼宽:再来的建议不盖
        store.patch({{u"width"_s, u"25"_s}});
        fake.assist = QJsonObject{{u"enabled"_s, true}, {u"width"_s, QJsonObject{{u"pick"_s, 50}}}, {u"flags"_s, QJsonArray{}}};
        store.loadAssist();
        QCOMPARE(store.plan()[u"form"][u"width"].toString(), u"25"_s);
        QCOMPARE(store.plan()[u"assist"][u"width"][u"pick"].toDouble(), 50.0);

        // 清空之后又是默认值:拿最近一次的建议
        store.reset();
        QCOMPARE(store.plan()[u"form"][u"width"].toString(), u"50"_s);

        // 屏幕上有结果时不动表单(动了会把结果标成"改之前的")
        store.patch({{u"center"_s, u"6700"_s}, {u"targetSpot"_s, u"6710"_s}, {u"targetTime"_s, u"14:30"_s}});
        fake.result = QJsonObject{{u"center"_s, 6700}};
        store.run(false);
        QVERIFY(store.plan()[u"result"].isObject());
        fake.assist = QJsonObject{{u"enabled"_s, true}, {u"width"_s, QJsonObject{{u"pick"_s, 20}}}, {u"flags"_s, QJsonArray{}}};
        store.loadAssist();
        QCOMPARE(store.plan()[u"form"][u"width"].toString(), u"50"_s);
        QCOMPARE(store.plan()[u"assist"][u"width"][u"pick"].toDouble(), 20.0);

        // 失败:留一句原因,表单不动;看不见了就停
        fake.assist = u"throw:引擎没起来"_s;
        store.loadAssist();
        QCOMPARE(store.plan()[u"assist"][u"error"].toString(), u"引擎没起来"_s);
        QCOMPARE(store.plan()[u"assist"][u"width"][u"pick"].toDouble(), 20.0);  // 上一份还在
        fake.assist = QJsonObject{{u"enabled"_s, true}, {u"width"_s, QJsonObject{{u"pick"_s, 20}}}, {u"flags"_s, QJsonArray{}}};
        store.loadAssist();
        QVERIFY(!store.plan()[u"assist"].toObject().contains(u"error"_s));
        const int before = fake.calls.size();
        store.setVisible(false);
        store.setVisible(true);
        QCOMPARE(fake.calls.size(), before + 1);
    }

    /// 没接这一路(老接线、测试替身):一条都不问,plan 里也没有 assist
    void assistAbsentIsNoop() {
        Fake fake;
        FlyStore store(fake.deps());
        store.setVisible(true);
        store.loadAssist();
        QCOMPARE(fake.calls.size(), 0);
        QVERIFY(!store.plan().contains(u"assist"_s));
    }
};

QTEST_GUILESS_MAIN(TestFlyStore)
#include "tst_fly_store.moc"
