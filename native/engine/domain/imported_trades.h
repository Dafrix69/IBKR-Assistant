// 从外部导出补进来的交易与它们的上下文(engine-ts/src/importedTrades.ts 逐句搬):imported_option_trades、option_positions、
// trade_entry_context 三张表,只增不改、按键去重;与 TradeStore 共用一个连接(store.imports)。行是 JS 对象(列就是接口的字段)。
#pragma once

#include "util/ordered_json.h"
#include "util/sqlite.h"

#include <QHash>
#include <QStringList>

namespace ibkr::domain {

class ImportedTradesStore {
public:
    explicit ImportedTradesStore(util::sqlite::Database& db);
    double rememberOptionTrades(const QList<util::OJson>& rows);
    QList<util::OJson> listOptionTrades();
    double rememberOptionPositions(const QList<util::OJson>& rows);
    QList<util::OJson> listOptionPositions();
    /// trade_id → 价(Map 的先后)
    QList<std::pair<QString, double>> entryUnderlyings(const QStringList& tradeIds);
    void rememberEntryUnderlying(const QString& tradeId, const QString& symbol, const QString& at, double underlying, const QString& source);

private:
    util::sqlite::Database& db_;
};

}  // namespace ibkr::domain
