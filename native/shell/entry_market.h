#pragma once
#include <QJsonArray>
#include <QJsonObject>
namespace ibkr::shell::fly {
QJsonArray entryMarketChecks(const QJsonObject& plan, const QJsonObject& evidence, double now);
}
