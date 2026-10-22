#include "domain/imported_trades.h"

#include "util/js_runtime.h"
#include "util/jsobj.h"

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
using ibkr::util::sqlite::Bind;
namespace js = ibkr::util::js;

namespace ibkr::domain {

namespace {
const char16_t* kSchema = uR"(
-- 导入的期权交易(按结构整理的成交导出,一行 = 一个结构的一次动作)。没有行权价 / 到期日,拼不出合约,
-- 所以不进 broker_fills;只增不改,按 (account_id, id) 去重。有了 option_positions 的那段时间就不再用
CREATE TABLE IF NOT EXISTS imported_option_trades (
    account_id   TEXT NOT NULL,
    id           TEXT NOT NULL,
    time_et      TEXT NOT NULL,
    date_et      TEXT NOT NULL,
    symbol       TEXT NOT NULL,
    structure    TEXT NOT NULL,
    action       TEXT NOT NULL,
    direction    TEXT NOT NULL DEFAULT '',
    qty          REAL,
    net_price    REAL,
    realized_pnl REAL NOT NULL,
    commission   REAL NOT NULL DEFAULT 0,
    legs         TEXT NOT NULL DEFAULT '',
    note         TEXT NOT NULL DEFAULT '',
    source       TEXT NOT NULL DEFAULT '',
    imported_at  TEXT NOT NULL,
    PRIMARY KEY (account_id, id)
);

-- Flex 导出按行权价配好的期权仓位(开仓结构 + 了结方式 + 盈亏),只增不改
CREATE TABLE IF NOT EXISTS option_positions (
    account_id   TEXT NOT NULL,
    id           TEXT NOT NULL,
    open_et      TEXT NOT NULL,
    symbol       TEXT NOT NULL,
    structure    TEXT NOT NULL,
    direction    TEXT NOT NULL DEFAULT '',
    qty          REAL,
    expiry       TEXT NOT NULL DEFAULT '',
    dte          REAL,
    right        TEXT NOT NULL DEFAULT '',
    strikes      TEXT NOT NULL DEFAULT '',
    center       REAL,
    width        REAL,
    ratio        TEXT NOT NULL DEFAULT '',
    net_price    REAL,
    legs         TEXT NOT NULL DEFAULT '',
    exit         TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT '',
    closed_et    TEXT NOT NULL DEFAULT '',
    hold_min     REAL,
    realized_pnl REAL NOT NULL,
    commission   REAL NOT NULL DEFAULT 0,
    source       TEXT NOT NULL DEFAULT '',
    imported_at  TEXT NOT NULL,
    PRIMARY KEY (account_id, id)
);

-- 历史交易开仓那一刻的标的价(下单页「历史相似交易」比蝴蝶中心离现价几个翼宽用)。取一次就存下,
-- 历史不会变;取的时候标的在哪一分钟、从哪来(source)都留着
CREATE TABLE IF NOT EXISTS trade_entry_context (
    trade_id   TEXT PRIMARY KEY,
    symbol     TEXT NOT NULL,
    at         TEXT NOT NULL,
    underlying REAL NOT NULL,
    source     TEXT NOT NULL DEFAULT '',
    fetched_at TEXT NOT NULL
);
)";

util::sqlite::Binds pick(const OJson& r, std::initializer_list<const char16_t*> names) {
    util::sqlite::Binds out;
    for (const char16_t* n : names) out << Bind::of(js::prop(&r, QString::fromUtf16(n)));
    return out;
}
}  // namespace

ImportedTradesStore::ImportedTradesStore(util::sqlite::Database& db) : db_(db) { db.exec(QString::fromUtf16(kSchema)); }

double ImportedTradesStore::rememberOptionTrades(const QList<OJson>& rows) {
    auto stmt = db_.prepare(
        u"INSERT OR IGNORE INTO imported_option_trades (account_id, id, time_et, date_et, symbol, structure, action,"
        " direction, qty, net_price, realized_pnl, commission, legs, note, source, imported_at)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"_s);
    const QString at = util::nowIsoSeconds();
    double added = 0;
    for (const OJson& r : rows) {
        auto args = pick(r, {u"account_id", u"id", u"time_et", u"date_et", u"symbol", u"structure", u"action", u"direction", u"qty", u"net_price",
                             u"realized_pnl", u"commission", u"legs", u"note", u"source"});
        args << at;
        added += stmt.run(args).changes;
    }
    return added;
}

QList<OJson> ImportedTradesStore::listOptionTrades() {
    return db_.prepare(u"SELECT account_id, id, time_et, date_et, symbol, structure, action, direction, qty, net_price, realized_pnl,"
                       " commission, legs, note, source FROM imported_option_trades ORDER BY time_et ASC, id ASC"_s)
        .all();
}

double ImportedTradesStore::rememberOptionPositions(const QList<OJson>& rows) {
    auto stmt = db_.prepare(
        u"INSERT OR IGNORE INTO option_positions (account_id, id, open_et, symbol, structure, direction, qty, expiry, dte,"
        " right, strikes, center, width, ratio, net_price, legs, exit, status, closed_et, hold_min, realized_pnl, commission,"
        " source, imported_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"_s);
    const QString at = util::nowIsoSeconds();
    double added = 0;
    for (const OJson& r : rows) {
        auto args = pick(r, {u"account_id", u"id", u"open_et", u"symbol", u"structure", u"direction", u"qty", u"expiry", u"dte", u"right", u"strikes",
                             u"center", u"width", u"ratio", u"net_price", u"legs", u"exit", u"status", u"closed_et", u"hold_min", u"realized_pnl",
                             u"commission", u"source"});
        args << at;
        added += stmt.run(args).changes;
    }
    return added;
}

QList<OJson> ImportedTradesStore::listOptionPositions() {
    return db_.prepare(u"SELECT account_id, id, open_et, symbol, structure, direction, qty, expiry, dte, right, strikes, center, width,"
                       " ratio, net_price, legs, exit, status, closed_et, hold_min, realized_pnl, commission, source"
                       " FROM option_positions ORDER BY open_et ASC, id ASC"_s)
        .all();
}

QList<std::pair<QString, double>> ImportedTradesStore::entryUnderlyings(const QStringList& tradeIds) {
    QList<std::pair<QString, double>> out;
    auto stmt = db_.prepare(u"SELECT underlying FROM trade_entry_context WHERE trade_id=?"_s);
    for (const QString& id : tradeIds) {
        const auto row = stmt.get({id});
        if (!row) continue;
        const double v = js::num(row->get(u"underlying"_s));
        auto it = std::find_if(out.begin(), out.end(), [&](const auto& p) { return p.first == id; });
        if (it != out.end()) it->second = v;
        else out.append({id, v});
    }
    return out;
}

void ImportedTradesStore::rememberEntryUnderlying(const QString& tradeId, const QString& symbol, const QString& at, double underlying, const QString& source) {
    db_.prepare(u"INSERT OR IGNORE INTO trade_entry_context (trade_id, symbol, at, underlying, source, fetched_at) VALUES (?,?,?,?,?,?)"_s)
        .run({tradeId, symbol, at, underlying, source, util::nowIsoSeconds()});
}

}  // namespace ibkr::domain
