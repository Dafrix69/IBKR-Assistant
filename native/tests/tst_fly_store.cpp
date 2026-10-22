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
};

QTEST_GUILESS_MAIN(TestFlyStore)
#include "tst_fly_store.moc"
