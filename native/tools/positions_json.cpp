#include "positions_json.h"

#include "util/redact.h"

#include <QJsonArray>

#include <cmath>

namespace ibkr::tools {

using namespace Qt::StringLiterals;

namespace {

QJsonValue number(const std::optional<double>& value) {
    if (!value || !std::isfinite(*value)) return QJsonValue::Null;
    return *value;
}

}  // namespace

QJsonObject positionToJson(const tws::Position& p) {
    return QJsonObject{
        {u"account"_s, util::maskAccount(p.account)},
        {u"contract"_s, tws::contractToJson(p.contract)},
        {u"pos"_s, number(p.pos)},
        {u"avgCost"_s, number(p.avgCost)},
    };
}

QJsonObject noticeToJson(const tws::ErrorMessage& e) {
    QJsonObject o{{u"code"_s, e.code}, {u"message"_s, util::maskAccountLikeIds(e.message)}, {u"info"_s, e.info}};
    if (e.reqId) o.insert(u"reqId"_s, *e.reqId);
    return o;
}

QJsonObject resultToJson(const tws::PositionsResult& r) {
    QJsonArray positions;
    for (const tws::Position& p : r.positions) positions.append(positionToJson(p));
    QJsonArray notices;
    for (const tws::ErrorMessage& e : r.notices) notices.append(noticeToJson(e));
    return QJsonObject{
        {u"server_version"_s, r.serverVersion},
        {u"connection_time"_s, r.connectionTime},
        {u"accounts"_s, util::maskAccountList(r.managedAccounts)},
        {u"positions"_s, positions},
        {u"notices"_s, notices},
    };
}

}  // namespace ibkr::tools
