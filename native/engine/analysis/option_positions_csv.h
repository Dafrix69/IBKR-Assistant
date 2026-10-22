// optionPositionsCsv.ts:期权仓位导入——Flex 导出按行权价配好的仓位表(option_positions.csv,一行 = 一个仓位的完整生命周期)
// → option_positions 的行(OJson,键序同 OptionPosition)。表头是中文,照原样认。纯函数。期望值:tests/fixtures/gen_csv_imports.mjs
#pragma once

#include "util/error.h"
#include "util/ordered_json.h"

#include <QList>
#include <QPair>
#include <QString>

namespace ibkr::analysis::option_positions_csv {

/// 必需的列:(键, 表头原文),次序同 POSITION_COLUMNS
const QList<QPair<QString, QString>>& positionColumns();

class OptionPositionsCsvError : public util::JsError {
public:
    using JsError::JsError;
};

/// {rows, skipped, first, last};缺列抛 OptionPositionsCsvError
util::OJson parseOptionPositionsCsv(const QString& text, const QString& accountId, const QString& source);

}  // namespace ibkr::analysis::option_positions_csv
