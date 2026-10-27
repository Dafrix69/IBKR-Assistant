// 「开始追踪」(shell/track_form)对着原文件 TrackForm.tsx 的 start() 跑出来的 25 个场景逐步对:试算问了什么、确认框上的每一个字、
// 发出去的载荷(键的集合也比)、横幅、建好后重读与回调的先后。每份载荷在生成时已过引擎的 zod schema(.strict()),这里再查一遍记录。
#include "json_compare.h"
#include "shell/track_form.h"

#include <QFile>
#include <QJsonDocument>
#include <QTest>

using namespace ibkr;
using namespace ibkr::shell;
using namespace Qt::StringLiterals;

namespace {

track::FormState stateOf(const QJsonObject& c) {
    return track::FormState::fromJson(c[u"position"].toObject(), c[u"autoExecute"].toBool(), c[u"values"].toObject());
}

/// 按场景回话的假货,把每一步记成和生成器一样的形状
QJsonArray replay(const QJsonObject& c) {
    auto calls = std::make_shared<QJsonArray>();
    auto previews = std::make_shared<QJsonArray>(c[u"previews"].toArray());
    auto confirms = std::make_shared<QJsonArray>(c[u"confirms"].toArray());
    const QJsonValue addResult = c[u"addResult"];
    track::FormDeps deps;
    deps.preview = [calls, previews](const QString& key, double target, std::optional<double> chaseMax, auto done) {
        calls->append(QJsonObject{{u"call"_s, u"preview"_s}, {u"key"_s, key}, {u"target"_s, target}, {u"chaseMax"_s, chaseMax ? QJsonValue(*chaseMax) : QJsonValue()}});
        const QJsonValue r = previews->isEmpty() ? QJsonValue() : previews->takeAt(0);
        if (r.isString() && r.toString().startsWith(u"throw:"_s)) return done(QJsonValue(), r.toString().mid(6));
        done(r, QString());
    };
    deps.confirm = [calls, confirms](const QJsonObject& opts, auto done) {
        QJsonObject rec = opts;
        rec.insert(u"call"_s, u"confirm"_s);
        calls->append(rec);
        done(confirms->isEmpty() ? false : confirms->takeAt(0).toBool());
    };
    deps.add = [calls, addResult](const QJsonObject& spec, auto done) {
        calls->append(QJsonObject{{u"call"_s, u"add"_s}, {u"spec"_s, spec}});
        if (addResult.isString()) return done(QJsonValue(), addResult.toString().mid(6));
        done(addResult, QString());
    };
    deps.banner = [calls](const QString& text, bool info) { calls->append(QJsonObject{{u"call"_s, u"banner"_s}, {u"text"_s, text}, {u"info"_s, info}}); };
    deps.saving = [calls](bool on) { calls->append(QJsonObject{{u"call"_s, u"saving"_s}, {u"on"_s, on}}); };
    deps.reload = [calls](std::function<void()> done) {
        calls->append(QJsonObject{{u"call"_s, u"reload"_s}, {u"refresh"_s, true}});
        done();
    };
    deps.created = [calls](const QJsonValue& id) { calls->append(QJsonObject{{u"call"_s, u"created"_s}, {u"id"_s, id}}); };
    track::startTrack(stateOf(c), deps);
    return *calls;
}

QJsonArray cases() {
    QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/track-form.json"));
    if (!f.open(QIODevice::ReadOnly)) return {};
    return QJsonDocument::fromJson(f.readAll()).object().value(u"cases"_s).toArray();
}

}  // namespace

class TestTrackForm : public QObject {
    Q_OBJECT
private slots:
    void brokerSpotForm() {
        const QJsonObject position{{u"key"_s, u"paper|SPX|BAG"_s}, {u"symbol"_s, u"SPX"_s}, {u"sec_type"_s, u"BAG"_s},
            {u"quantity"_s, 2}, {u"account"_s, u"paper"_s}};
        QJsonObject values{{u"host"_s, true}, {u"brokerSpotStop"_s, true}, {u"autoPicked"_s, true}, {u"stopBelow"_s, 6000}, {u"spotStopLimit"_s, 1.25}};
        const auto state = track::FormState::fromJson(position, false, values);
        QVERIFY(state.hostOn()); // 只有止损也能托管组合,不必虚构一个止盈目标
        const auto spec = track::buildSpec(state);
        QVERIFY(spec[u"spot_stop_at_broker"].toBool());
        QCOMPARE(spec[u"spot_stop_limit"].toString(), u"1.25"_s);
        QJsonObject scenario{{u"position"_s, position}, {u"values"_s, values}};
        auto calls = replay(scenario);
        QCOMPARE(calls[0][u"call"].toString(), u"confirm"_s);
        QVERIFY(calls[0][u"detail"].toString().contains(u"IBKR"));
        QVERIFY(calls[0][u"detail"].toString().contains(u"1.25"));
        values.remove(u"spotStopLimit"_s);
        scenario[u"values"] = values;
        calls = replay(scenario);
        QCOMPARE(calls[0][u"call"].toString(), u"banner"_s);
        values[u"spotStopLimit"] = 1.25;
        values[u"exits"] = QJsonObject{{u"stopConfirm"_s, 5}};
        scenario[u"values"] = values;
        calls = replay(scenario);
        QCOMPARE(calls[0][u"call"].toString(), u"banner"_s);
        QVERIFY(calls[0][u"text"].toString().contains(u"确认"));
    }
    void matchesTsStart_data() {
        QTest::addColumn<QJsonObject>("scenario");
        const QJsonArray all = cases();
        QVERIFY(all.size() >= 25);
        for (const QJsonValue& c : all) QTest::newRow(qPrintable(c[u"name"].toString())) << c.toObject();
    }
    void matchesTsStart() {
        QFETCH(QJsonObject, scenario);
        const QJsonArray expected = scenario[u"calls"].toArray();
        const QJsonArray actual = replay(scenario);
        const QString diff = test::jsonDiff(expected, actual);
        QVERIFY2(diff.isEmpty(), qPrintable(diff));
    }

    // 界面交上来读不成数的值:不当"没填",一个请求都不发
    void unreadableValueStopsEverything() {
        QJsonObject c = cases().at(0).toObject();
        QJsonObject v = c[u"values"].toObject();
        QJsonObject exits = v[u"exits"].toObject();
        exits[u"stopConfirm"] = u"十秒"_s;
        exits[u"tiers"] = QJsonArray{QJsonObject{{u"price"_s, u"7.5"_s}, {u"fraction"_s, u"x"_s}}};
        v[u"exits"] = exits;
        c[u"values"] = v;
        const QJsonArray calls = replay(c);
        QCOMPARE(calls.size(), 1);
        QCOMPARE(calls.at(0)[u"call"].toString(), u"banner"_s);
        QCOMPARE(calls.at(0)[u"text"].toString(), u"表单里有读不成数字的值(stopConfirm、tiers[0].fraction),没有发出任何请求。"_s);
        // 顶层的数同样:标的止损填了个读不成的值,不能当没填
        QJsonObject top = cases().at(0).toObject();
        QJsonObject tv = top[u"values"].toObject();
        tv[u"stopBelow"] = u"7680点"_s;
        tv[u"orderType"] = u"市价"_s;
        top[u"values"] = tv;
        const QJsonArray topCalls = replay(top);
        QCOMPARE(topCalls.size(), 1);
        QCOMPARE(topCalls.at(0)[u"text"].toString(), u"表单里有读不成数字的值(stopBelow、orderType),没有发出任何请求。"_s);
        // 只认十进制
        QVERIFY(!track::ExitFields::fromJson(QJsonObject{{u"stopConfirm"_s, u"0x10"_s}}).invalid.isEmpty());
        QVERIFY(!track::ExitFields::fromJson(QJsonObject{{u"peakConfirm"_s, u"true"_s}}).invalid.isEmpty());
        // 数字串照数读
        QCOMPARE(track::ExitFields::fromJson(QJsonObject{{u"stopConfirm"_s, u" 10 "_s}}).stopConfirm.value_or(-1), 10.0);
        QVERIFY(track::ExitFields::fromJson(QJsonObject{{u"stopConfirm"_s, u""_s}}).invalid.isEmpty());
    }

    // 表单的初值(一项都没改时)和原文件 useState(...) 现算的一样:组合的平仓方式默认限价、利润回撤门槛 10……
    void defaultsMatchUseState_data() {
        QTest::addColumn<QJsonObject>("d");
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/track-form.json"));
        QVERIFY(f.open(QIODevice::ReadOnly));
        const QJsonObject defaults = QJsonDocument::fromJson(f.readAll()).object().value(u"defaults"_s).toObject();
        QVERIFY(defaults.size() >= 4);
        for (auto it = defaults.begin(); it != defaults.end(); ++it) QTest::newRow(qPrintable(it.key())) << it.value().toObject();
    }
    void defaultsMatchUseState() {
        QFETCH(QJsonObject, d);
        const QJsonObject v = d[u"values"].toObject();
        const track::FormState fromDefaults = track::FormState::fromJson(d[u"position"].toObject(), false, v);
        const track::FormState untouched = track::FormState::fromJson(d[u"position"].toObject(), false, QJsonObject{});
        QVERIFY(untouched.invalid.isEmpty() && fromDefaults.invalid.isEmpty());
        // 一项都没改时拼出来的载荷,和把原版初值逐项填上时拼出来的一样
        QCOMPARE(test::jsonDiff(track::buildSpec(fromDefaults), track::buildSpec(untouched)), QString());
        QCOMPARE(untouched.orderTypeOrDefault(), v[u"orderType"].toString());
        QCOMPARE(untouched.ddArm.value_or(-1), v[u"ddArm"].toDouble(-1));
    }

    // 载荷本身:就算这一场没发出去,拼出来的也和原版一样,而且引擎的 schema 认
    void specMatchesAndPassesSchema_data() { matchesTsStart_data(); }
    void specMatchesAndPassesSchema() {
        QFETCH(QJsonObject, scenario);
        QVERIFY2(scenario[u"schemaOk"].toBool(), qPrintable(QString::fromUtf8(QJsonDocument(scenario[u"schemaIssues"].toArray()).toJson())));
        const QString diff = test::jsonDiff(scenario[u"spec"], track::buildSpec(stateOf(scenario)));
        QVERIFY2(diff.isEmpty(), qPrintable(diff));
    }
};

QTEST_GUILESS_MAIN(TestTrackForm)
#include "tst_track_form.moc"
