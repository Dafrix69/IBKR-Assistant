// fillsCsv.ts:历史成交导入——IBKR 账户成交导出(fills.csv)→ broker_fills 的行(broker.fillRow 的形状)。只收股票。纯函数。
// 文本按 JS 的串读法处理(UTF-16 码元、split、trim 的空白集)。期望值:tests/fixtures/gen_csv_imports.mjs
#pragma once

#include "util/error.h"
#include "util/ordered_json.h"

#include <QString>
#include <QStringList>

namespace ibkr::analysis::fills_csv {

/// fills.csv 必需的列(表头原文)
const QStringList& requiredColumns();

class FillsCsvError : public util::JsError {
public:
    using JsError::JsError;
};

/// {fills, skipped: {原因: 条数}, first, last};缺列抛 FillsCsvError
util::OJson parseFillsCsv(const QString& text, const QString& accountId);

}  // namespace ibkr::analysis::fills_csv
