// engine/util/protections 对着原模块(engine-ts/src/protections.ts)现算的答案(tests/fixtures/gen_protections.mjs):
// 400 个随机场景外加 4 个正好亏到上限的(配置、平仓、已实现盈亏、券商报的账户当日盈亏)的状态、拦不拦每一张单(两个时刻)、给界面的摘要、查库起点;
// 美东零点(含 DST 那几天);止损类状态的认法。
#include "util/protections.h"

#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTest>

#include <cmath>
#include <limits>

using namespace ibkr;
using namespace ibkr::util;
using namespace Qt::StringLiterals;

namespace {
double dec(const QJsonValue& v) { return v.isString() ? std::numeric_limits<double>::quiet_NaN() : v.toDouble(); }

contract::ProtectionsConfig cfgOf(const QJsonObject& c) {
    contract::ProtectionsConfig cfg;
    const QJsonObject sg = c[u"stoploss_guard"_s].toObject(), dd = c[u"max_drawdown"_s].toObject(), cd = c[u"cooldown"_s].toObject(), dl = c[u"daily_loss"_s].toObject();
    cfg.stoploss_guard = {sg[u"enabled"_s].toBool(), sg[u"lookback_minutes"_s].toDouble(), sg[u"trigger_count"_s].toDouble(), sg[u"pause_minutes"_s].toDouble()};
    cfg.max_drawdown = {dd[u"enabled"_s].toBool(), dd[u"lookback_minutes"_s].toDouble(), dd[u"max_drawdown_usd"_s].toDouble(), dd[u"pause_minutes"_s].toDouble()};
    cfg.cooldown = {cd[u"enabled"_s].toBool(), cd[u"minutes"_s].toDouble(), cd[u"scope"_s].toString()};
    cfg.daily_loss = {dl[u"enabled"_s].toBool(), dl[u"max_loss_usd"_s].toDouble(), dl[u"basis"_s].toString()};
    return cfg;
}

QJsonValue pauseJson(const std::optional<ProtectionPause>& p) {
    if (!p) return QJsonValue::Null;
    return QJsonObject{{u"rule"_s, p->rule}, {u"reason"_s, p->reason}, {u"untilMs"_s, p->untilMs}};
}
QJsonArray mapJson(const contract::OrderedMap<ProtectionPause>& m) {
    QJsonArray out;
    for (const QString& k : m.keys()) out.append(QJsonArray{k, pauseJson(m.value(k))});
    return out;
}
}  // namespace

class TestProtections : public QObject {
    Q_OBJECT
private slots:
    void scenarios() {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/protections.json"));
        QVERIFY(f.open(QIODevice::ReadOnly));
        const QJsonObject j = QJsonDocument::fromJson(f.readAll()).object();
        int i = 0;
        for (const QJsonValue& v : j[u"scenarios"_s].toArray()) {
            const QJsonObject s = v.toObject();
            const contract::ProtectionsConfig cfg = cfgOf(s[u"cfg"_s].toObject());
            const double nowMs = s[u"nowMs"_s].toDouble();
            std::vector<CloseEvent> closes;
            for (const QJsonValue& c : s[u"closes"_s].toArray())
                closes.push_back({c[u"atMs"_s].toDouble(), c[u"symbol"_s].toString(), c[u"state"_s].toString(), c[u"leg"_s].toString()});
            std::vector<PnlEvent> pnl;
            for (const QJsonValue& p : s[u"pnl"_s].toArray()) pnl.push_back({p[u"atMs"_s].toDouble(), dec(p[u"pnl"_s])});
            std::optional<contract::OrderedMap<double>> daily;
            if (!s[u"accountDaily"_s].isNull()) {
                daily.emplace();
                for (const QJsonValue& e : s[u"accountDaily"_s].toArray()) daily->insert(e[0].toString(), dec(e[1]));
            }
            QStringList expected;
            for (const QJsonValue& e : s[u"expected"_s].toArray()) expected << e.toString();
            const ProtectionState state = evaluateProtections(cfg, closes, pnl, nowMs, daily, expected);
            const QString at = u"场景 %1"_s.arg(i++);
            QVERIFY2(pauseJson(state.pause) == s[u"state"_s][u"pause"_s], qPrintable(at + u" pause"_s));
            QVERIFY2(mapJson(state.cooldowns) == s[u"state"_s][u"cooldowns"_s].toArray(), qPrintable(at + u" cooldowns"_s));
            QVERIFY2(mapJson(state.accountPauses) == s[u"state"_s][u"accountPauses"_s].toArray(), qPrintable(at + u" accountPauses:"_s + QString::fromUtf8(QJsonDocument(mapJson(state.accountPauses)).toJson(QJsonDocument::Compact))));
            for (const QJsonValue& b : s[u"blocks"_s].toArray()) {
                const std::optional<QString> got = protectionBlock(state, b[u"sym"_s].toString(), nowMs + b[u"dt"_s].toDouble(), b[u"acc"_s].toString(), b[u"leg"_s].toString());
                const QJsonValue want = b[u"out"_s];
                QVERIFY2(want.isNull() ? !got : got && *got == want.toString(), qPrintable(at + u" block:"_s + got.value_or(u"<放行>"_s) + u" / "_s + want.toString()));
            }
            QVERIFY2(protectionsSummary(state, nowMs) == s[u"summary"_s].toObject(), qPrintable(at + u" summary"_s));
            QVERIFY2(protectionsSummary(state, nowMs + 45 * 60000) == s[u"summaryLater"_s].toObject(), qPrintable(at + u" summary later"_s));
            QCOMPARE(protectionsSince(cfg, nowMs), s[u"since"_s].toDouble());
            QCOMPARE(protectionsEnabled(cfg), s[u"enabled"_s].toBool());
            QCOMPARE(needsPnlEvents(cfg), s[u"needsPnl"_s].toBool());
        }
        for (const QJsonValue& v : j[u"dayStarts"_s].toArray()) QCOMPARE(etDayStart(v[u"nowMs"_s].toDouble(), v[u"off"_s].toInt()), v[u"out"_s].toDouble());
        for (const QJsonValue& v : j[u"stopLike"_s].toArray()) QCOMPARE(isStopLike(v[u"s"_s].toString()), v[u"out"_s].toBool());
    }
};

QTEST_GUILESS_MAIN(TestProtections)
#include "tst_protections.moc"
