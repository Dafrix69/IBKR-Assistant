// optionTradesCsv.ts:期权交易导入——按结构整理的成交导出(trades.csv,一行 = 一个结构的一次动作)→ imported_option_trades 的行
// (domain/imported_trades 收的就是这种 OJson 行,键序同 ImportedOptionTrade)。另有 RFC 4180 的最小 CSV 解析,
// option_positions_csv 共用。纯函数。期望值:tests/fixtures/gen_csv_imports.mjs
#pragma once

#include "util/error.h"
#include "util/ordered_json.h"

#include <QList>
#include <QString>
#include <QStringList>

namespace ibkr::analysis::option_trades_csv {

const QStringList& optionColumns();

class OptionTradesCsvError : public util::JsError {
public:
    using JsError::JsError;
};

/// 逗号分隔,双引号包裹的字段里可以有逗号、换行,"" 是一个引号;全空白的行去掉
QList<QStringList> parseCsv(const QString& text);
/// {rows, skipped, first, last};缺列抛 OptionTradesCsvError
util::OJson parseOptionTradesCsv(const QString& text, const QString& accountId, const QString& source);

}  // namespace ibkr::analysis::option_trades_csv
