// market.ts:行情快照的标的抽取(轻量正则预处理:显式代码 + 中文别名 + 常驻指数)与按标的拉现价。纯计算;配置层是 domain/config.h 的 Settings。
#pragma once

#include "domain/config.h"
#include "util/ordered_json.h"

#include <QString>
#include <QStringList>

#include <functional>
#include <optional>

namespace ibkr::analysis::market {

/// extra 空 = 没给(null / undefined)
QStringList extractSymbols(const QString& text, const domain::Settings& settings, const std::optional<QStringList>& extra = std::nullopt,
                           bool defaultIndex = true);

/// priceLookup 回空 = null / undefined;可以抛 util::JsError(只是少一行)。cached 是 {代码: 价}(任意 JSON;空指针 = 没给)
util::OJson buildSnapshot(const QStringList& symbols, const std::function<std::optional<double>(const QString&)>& priceLookup,
                          const util::OJson* cached = nullptr);

}  // namespace ibkr::analysis::market
