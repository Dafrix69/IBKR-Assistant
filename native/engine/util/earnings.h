#pragma once
#include <QJsonArray>
#include <QJsonObject>
#include <QDate>
namespace ibkr::util {
// WSH wshe_ed only; release date is not announce_datetime or fiscal quarter end.
QJsonObject earningsView(const QJsonValue& raw, const QJsonArray& bars, QDate today);
}
