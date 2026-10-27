#include "transport/handlers/system.h"

#include <QDateTime>
#include <QJsonArray>
#include <QTimeZone>

#include <cstdio>

namespace ibkr::rpc {

using namespace Qt::StringLiterals;

namespace {

const QString kEtFormat = u"yyyy-MM-dd HH:mm:ss"_s;

/// year 年 month 月第 nth 个星期日
QDate nthSunday(int year, int month, int nth) {
    const QDate first(year, month, 1);
    return first.addDays((7 - first.dayOfWeek()) % 7 + 7 * (nth - 1));
}

}  // namespace

QString nowEtByUsRule(qint64 epochMs) {
    const int year = QDateTime::fromMSecsSinceEpoch(epochMs, QTimeZone::UTC).date().year();
    // 起:当地标准时 2:00 = UTC 7:00;止:当地夏令时 2:00 = UTC 6:00
    const qint64 start = QDateTime(nthSunday(year, 3, 2), QTime(7, 0), QTimeZone::UTC).toMSecsSinceEpoch();
    const qint64 end = QDateTime(nthSunday(year, 11, 1), QTime(6, 0), QTimeZone::UTC).toMSecsSinceEpoch();
    const qint64 offsetMs = (epochMs >= start && epochMs < end ? -4 : -5) * 3'600'000LL;
    return QDateTime::fromMSecsSinceEpoch(epochMs + offsetMs, QTimeZone::UTC).toString(kEtFormat);
}

QString nowEt(qint64 epochMs) {
    static const QTimeZone et("America/New_York");
    if (et.isValid()) return QDateTime::fromMSecsSinceEpoch(epochMs, et).toString(kEtFormat);
    static const bool warned = [] {
        std::fprintf(stderr, "时区库里没有 America/New_York,ET 时间改按美国夏令时规则算\n");
        return true;
    }();
    Q_UNUSED(warned);
    return nowEtByUsRule(epochMs);
}

QJsonObject systemStatus(qint64 epochMs) {
    return QJsonObject{
        {u"protocol"_s, QLatin1StringView(kProtocolVersion)},
        {u"now_et"_s, nowEt(epochMs)},
        // 下面这些阶段 2 才有真值(见头文件)
        {u"market_status"_s, u""_s},
        {u"prompt_version"_s, u""_s},
        {u"prompt_fingerprint"_s, u""_s},
        {u"model"_s, u""_s},
        {u"breaker"_s, QJsonObject{{u"engaged"_s, false}, {u"reason"_s, u""_s}}},
        {u"protections"_s, QJsonObject{
             {u"paused"_s, false},
             {u"rule"_s, u""_s},
             {u"reason"_s, u""_s},
             {u"until_ms"_s, QJsonValue::Null},
             {u"cooldowns"_s, QJsonArray{}},
             {u"accounts"_s, QJsonArray{}},
         }},
        {u"broker_provider"_s, u""_s},
        {u"broker_connected"_s, false},
        // 没连券商时是 true:没连不等于上游坏了
        {u"broker_upstream_ok"_s, true},
        {u"pending_count"_s, 0},
        {u"index_spot"_s, QJsonObject{}},
        {u"tracker_loop"_s, QJsonValue::Null},
        {u"accounts"_s, QJsonArray{}},
        {u"limits"_s, QJsonObject{
             {u"max_order_notional"_s, 0},
             {u"max_option_contracts"_s, 0},
             {u"max_mkt_shares"_s, 0},
             {u"min_confidence"_s, 0},
             {u"max_spread_slippage"_s, 0},
             {u"duplicate_window_minutes"_s, 0},
         }},
    };
}

void addSystemHandlers(RpcServer& server) {
    // 不收参数;只读本地已有的东西,一个请求都不发
    server.add(u"system.status"_s, [](const QJsonValue&) { return systemStatus(QDateTime::currentMSecsSinceEpoch()); });
}

}  // namespace ibkr::rpc
