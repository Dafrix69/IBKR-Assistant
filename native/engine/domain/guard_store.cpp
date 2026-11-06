#include "domain/guard_store.h"

#include "util/js_runtime.h"
#include "util/jsobj.h"

namespace ibkr::domain {

using namespace Qt::StringLiterals;
using util::OJson;
namespace js = util::js;

namespace {

constexpr char16_t kSchema[] = uR"SQL(
CREATE TABLE IF NOT EXISTS guard_intents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    account TEXT NOT NULL,
    symbol TEXT NOT NULL,
    kind TEXT NOT NULL,
    side TEXT,
    qty REAL,
    status TEXT NOT NULL DEFAULT 'open',
    seen_position INTEGER NOT NULL DEFAULT 0,
    closed_at TEXT,
    closed_reason TEXT,
    intent TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_guard_intents_open ON guard_intents(status, account, symbol);
)SQL";

constexpr char16_t kColumns[] = u"id, created_at, updated_at, account, symbol, kind, side, qty, status, seen_position, closed_at, closed_reason, intent";

/// 库里那一行 → {..列, intent: {...}}
OJson rowOf(const OJson& raw) {
    OJson out = raw;
    const auto parsed = js::parse(js::str(raw.get(u"intent"_s)));
    out.set(u"intent"_s, parsed ? *parsed : js::object());
    return out;
}

}  // namespace

// 表在第一次用到时才建:guard 关着的库一个字节都不变(交易库的结构基线、备份大小都按没有这张表定的)
GuardStore::GuardStore(util::sqlite::Database& db) : db_(db) {}

void GuardStore::ensure() {
    if (ready_) return;
    db_.exec(QString::fromUtf16(kSchema));
    ready_ = true;
}

OJson GuardStore::add(const OJson& intent) {
    ensure();
    const QString at = util::nowIsoSeconds();
    const auto r = db_.prepare(u"INSERT INTO guard_intents (created_at, updated_at, account, symbol, kind, side, qty, intent) VALUES (?,?,?,?,?,?,?,?)"_s)
                       .run({at, at, js::str(intent.get(u"account"_s)), js::str(intent.get(u"symbol"_s)), js::str(intent.get(u"kind"_s)),
                             util::sqlite::Bind::of(intent.get(u"side"_s)), util::sqlite::Bind::of(intent.get(u"qty"_s)), js::stringify(intent)});
    const auto row = db_.prepare(u"SELECT "_s + QString::fromUtf16(kColumns) + u" FROM guard_intents WHERE id=?"_s).get({r.lastInsertRowid});
    return row ? rowOf(*row) : js::object();
}

QList<OJson> GuardStore::listOpen() {
    ensure();
    QList<OJson> out;
    for (const OJson& r : db_.prepare(u"SELECT "_s + QString::fromUtf16(kColumns) + u" FROM guard_intents WHERE status='open' ORDER BY id ASC"_s).all())
        out.append(rowOf(r));
    return out;
}

std::optional<OJson> GuardStore::openStock(const QString& account, const QString& symbol) {
    ensure();
    const auto row = db_.prepare(u"SELECT "_s + QString::fromUtf16(kColumns) +
                                 u" FROM guard_intents WHERE status='open' AND kind='stock' AND account=? AND symbol=? ORDER BY id DESC LIMIT 1"_s)
                         .get({account, symbol});
    if (!row) return std::nullopt;
    return rowOf(*row);
}

double GuardStore::close(const QString& account, const QString& symbol, const QString& reason, const QString& kind) {
    ensure();
    const QString at = util::nowIsoSeconds();
    if (kind.isEmpty())
        return db_.prepare(u"UPDATE guard_intents SET status='closed', closed_at=?, closed_reason=?, updated_at=? WHERE status='open' AND account=? AND symbol=?"_s)
            .run({at, reason, at, account, symbol})
            .changes;
    return db_.prepare(u"UPDATE guard_intents SET status='closed', closed_at=?, closed_reason=?, updated_at=? WHERE status='open' AND account=? AND symbol=? AND kind=?"_s)
        .run({at, reason, at, account, symbol, kind})
        .changes;
}

void GuardStore::markSeen(double id) {
    ensure();
    db_.prepare(u"UPDATE guard_intents SET seen_position=1, updated_at=? WHERE id=? AND seen_position=0"_s).run({util::nowIsoSeconds(), id});
}

bool GuardStore::setIntentField(double id, const QString& key, const OJson& value) {
    ensure();
    const auto row = db_.prepare(u"SELECT intent FROM guard_intents WHERE id=?"_s).get({id});
    if (!row) return false;
    auto parsed = js::parse(js::str(row->get(u"intent"_s)));
    OJson intent = parsed && js::isObj(&*parsed) ? *parsed : js::object();
    intent.set(key, value);
    return db_.prepare(u"UPDATE guard_intents SET intent=?, updated_at=? WHERE id=?"_s).run({js::stringify(intent), util::nowIsoSeconds(), id}).changes > 0;
}

}  // namespace ibkr::domain
