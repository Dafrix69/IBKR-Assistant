// 两个诊断工具共用的输出:读到的持仓与报错写成 JSON,账号先遮掉(给人看、可能被贴进对话)。
#pragma once

#include "execution/tws/positions_snapshot.h"

#include <QJsonObject>

namespace ibkr::tools {

QJsonObject positionToJson(const tws::Position& position);
QJsonObject noticeToJson(const tws::ErrorMessage& error);
QJsonObject resultToJson(const tws::PositionsResult& result);

}  // namespace ibkr::tools
