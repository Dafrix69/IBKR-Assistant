#pragma once
#include <QJsonObject>
namespace ibkr::shell::fly {
// 人工证据与测算分开;只复核既有的同日 SPXW 买入等翼蝶,不授权交易。
QJsonObject entryReview(const QJsonObject& plan, const QJsonObject& evidence, double nowMs);
}
