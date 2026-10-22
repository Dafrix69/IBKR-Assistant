#include "domain/log_stores.h"

#include "util/js_runtime.h"
#include "util/jsobj.h"
#include "util/tz.h"

#include <QCryptographicHash>
#include <QRegularExpression>
#include <QSet>

#include <cmath>
#include <cstring>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
using ibkr::util::sqlite::Bind;
namespace js = ibkr::util::js;

namespace ibkr::domain {

namespace {
const OJson* col(const OJson& row, const char16_t* name) { return row.get(QString::fromUtf16(name)); }
const OJson* f(const OJson& o, const char16_t* name) { return js::prop(&o, QString::fromUtf16(name)); }
/// e.x.slice(0, n)(e.x 是字符串)
QString sliceOf(const OJson* v, int n) { return js::str(v).left(n); }
/// [...new Set(list)]
QStringList uniq(const QStringList& l) {
    QStringList out;
    for (const QString& s : l)
        if (!out.contains(s)) out << s;
    return out;
}
}  // namespace

// ================================================================ signalLog.ts
namespace {
const char16_t* kSignalSchema = uR"(
CREATE TABLE IF NOT EXISTS signal_log (
    seq     INTEGER PRIMARY KEY AUTOINCREMENT,
    at      TEXT NOT NULL,
    source  TEXT NOT NULL,
    symbol  TEXT NOT NULL,
    expect  TEXT,
    price   REAL,
    label   TEXT NOT NULL DEFAULT '',
    variant TEXT
);
CREATE INDEX IF NOT EXISTS signal_log_at ON signal_log(at);
CREATE TRIGGER IF NOT EXISTS signal_log_no_update
BEFORE UPDATE ON signal_log
BEGIN SELECT RAISE(ABORT, 'signal_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS signal_log_no_delete
BEFORE DELETE ON signal_log
BEGIN SELECT RAISE(ABORT, 'signal_log is append-only'); END;
)";
const QSet<QString> kSignalSources{u"cross"_s, u"touch"_s, u"spike"_s, u"day_move"_s, u"rvol"_s, u"burst"_s, u"leaders"_s, u"pa"_s};
const QString kSignalInsert = u"INSERT INTO signal_log (at, source, symbol, expect, price, label, variant) VALUES (?,?,?,?,?,?,?)"_s;
const QString kSignalColumns = u"at, source, symbol, expect, price, label, variant"_s;

util::sqlite::Binds signalValues(const OJson& e) {
    const OJson* price = f(e, u"price");
    const OJson* variant = f(e, u"variant");
    return {Bind::of(f(e, u"at")),
            Bind::of(f(e, u"source")),
            Bind(js::str(f(e, u"symbol")).toUpper()),
            Bind::of(f(e, u"expect")),
            !js::nullish(price) && js::isNum(price) && std::isfinite(price->n) ? Bind(price->n) : Bind(),
            Bind(sliceOf(f(e, u"label"), 200)),
            js::nullish(variant) ? Bind() : Bind::from(*variant)};
}
}  // namespace

SignalLogStore::SignalLogStore(util::sqlite::Database& db) : db_(db) {
    db.exec(QString::fromUtf16(kSignalSchema));
    // 小类这一列是后加的:老库补上,老行是 NULL
    bool has = false;
    for (const OJson& r : db.pragma(u"table_info(signal_log)"_s))
        if (js::str(r.get(u"name"_s)) == u"variant") has = true;
    if (!has) db.exec(u"ALTER TABLE signal_log ADD COLUMN variant TEXT"_s);
}

void SignalLogStore::log(const QList<OJson>& entries) {
    if (entries.isEmpty()) return;
    auto stmt = db_.prepare(kSignalInsert);
    db_.transaction([&] {
        for (const OJson& e : entries) stmt.run(signalValues(e));
    });
}

double SignalLogStore::logOnce(const QList<OJson>& entries, const QString& since) {
    if (entries.isEmpty()) return 0;
    auto seen = db_.prepare(u"SELECT 1 FROM signal_log WHERE at >= ? AND source = ? AND symbol = ? AND expect IS ? AND variant IS ? LIMIT 1"_s);
    auto stmt = db_.prepare(kSignalInsert);
    double written = 0;
    db_.transaction([&] {
        for (const OJson& e : entries) {
            const auto v = signalValues(e);
            if (seen.getRow({since, v[1], v[2], v[3], v[6]})) continue;
            stmt.run(v);
            written += 1;
        }
    });
    return written;
}

QList<OJson> SignalLogStore::listImpl(const std::optional<QString>& since, double limit, bool withSeq) {
    const QString cols = withSeq ? u"seq, "_s + kSignalColumns : kSignalColumns;
    QList<OJson> rows = since ? db_.prepare(u"SELECT %1 FROM signal_log WHERE at >= ? ORDER BY seq DESC LIMIT ?"_s.arg(cols)).all({*since, limit})
                              : db_.prepare(u"SELECT %1 FROM signal_log ORDER BY seq DESC LIMIT ?"_s.arg(cols)).all({limit});
    std::reverse(rows.begin(), rows.end());
    QList<OJson> out;
    for (const OJson& r : rows) {
        const QString source = js::str(col(r, u"source"));
        if (!js::isStr(col(r, u"source")) || !kSignalSources.contains(source)) continue;
        const QString expect = js::isStr(col(r, u"expect")) ? col(r, u"expect")->s : QString();
        OJson o = js::object();
        if (withSeq) o.set(u"seq"_s, js::copyOrNull(col(r, u"seq")));
        o.set(u"at"_s, js::copyOrNull(col(r, u"at")));
        o.set(u"source"_s, js::S(source));
        o.set(u"symbol"_s, js::copyOrNull(col(r, u"symbol")));
        o.set(u"expect"_s, expect == u"up" || expect == u"down" ? js::S(expect) : js::Null());
        o.set(u"price"_s, js::copyOrNull(col(r, u"price")));
        o.set(u"label"_s, js::copyOrNull(col(r, u"label")));
        o.set(u"variant"_s, js::copyOrNull(col(r, u"variant")));
        out << o;
    }
    return out;
}

QList<OJson> SignalLogStore::listWithSeq(const std::optional<QString>& since, double limit) { return listImpl(since, limit, true); }
QList<OJson> SignalLogStore::list(const std::optional<QString>& since, double limit) { return listImpl(since, limit, false); }

// ================================================================ followLog.ts
namespace {
const char16_t* kFollowSchema = uR"(
CREATE TABLE IF NOT EXISTS follow_log (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    at          TEXT NOT NULL,
    message_id  TEXT NOT NULL UNIQUE,
    author_id   TEXT NOT NULL,
    author_name TEXT NOT NULL DEFAULT '',
    text        TEXT NOT NULL,
    outcome     TEXT NOT NULL,
    detail      TEXT NOT NULL DEFAULT '',
    summary     TEXT NOT NULL DEFAULT '',
    record_ids  TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS follow_log_at ON follow_log(at);
CREATE TRIGGER IF NOT EXISTS follow_log_no_update
BEFORE UPDATE ON follow_log
BEGIN SELECT RAISE(ABORT, 'follow_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS follow_log_no_delete
BEFORE DELETE ON follow_log
BEGIN SELECT RAISE(ABORT, 'follow_log is append-only'); END;
CREATE TABLE IF NOT EXISTS follow_quotes (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    at          TEXT NOT NULL,
    message_id  TEXT NOT NULL UNIQUE,
    side        TEXT NOT NULL,
    leader      REAL NOT NULL,
    mid         REAL NOT NULL,
    natural     REAL NOT NULL,
    lag_s       REAL NOT NULL,
    paper       INTEGER NOT NULL DEFAULT 0
);
CREATE TRIGGER IF NOT EXISTS follow_quotes_no_update
BEFORE UPDATE ON follow_quotes
BEGIN SELECT RAISE(ABORT, 'follow_quotes is append-only'); END;
CREATE TRIGGER IF NOT EXISTS follow_quotes_no_delete
BEFORE DELETE ON follow_quotes
BEGIN SELECT RAISE(ABORT, 'follow_quotes is append-only'); END;
)";
const QSet<QString> kOutcomes{u"sent"_s, u"held"_s, u"observed"_s, u"stale"_s, u"unparsed"_s, u"capped"_s, u"blocked"_s, u"rejected"_s};

OJson recordIds(const OJson* raw) {
    const auto parsed = js::isStr(raw) ? js::parse(raw->s) : std::nullopt;
    OJson out = js::array();
    if (parsed && parsed->type == OJson::Array)
        for (const OJson& v : parsed->items)
            if (v.type == OJson::String) out.items << v;
    return out;
}
}  // namespace

FollowLogStore::FollowLogStore(util::sqlite::Database& db) : db_(db) { db.exec(QString::fromUtf16(kFollowSchema)); }

bool FollowLogStore::has(const QString& messageId) { return db_.prepare(u"SELECT 1 FROM follow_log WHERE message_id = ?"_s).getRow({messageId}).has_value(); }

bool FollowLogStore::add(const OJson& e) {
    const OJson* ids = f(e, u"record_ids");
    const auto info = db_.prepare(u"INSERT OR IGNORE INTO follow_log (at, message_id, author_id, author_name, text, outcome, detail, summary, record_ids)"
                                  " VALUES (?,?,?,?,?,?,?,?,?)"_s)
                          .run({Bind::of(f(e, u"at")), Bind::of(f(e, u"message_id")), Bind::of(f(e, u"author_id")), Bind(sliceOf(f(e, u"author_name"), 80)),
                                Bind(sliceOf(f(e, u"text"), kFollowTextMax)), Bind::of(f(e, u"outcome")), Bind(sliceOf(f(e, u"detail"), 400)),
                                Bind(sliceOf(f(e, u"summary"), 400)), ids ? Bind(js::stringify(*ids)) : Bind()});
    return info.changes > 0;
}

bool FollowLogStore::addQuote(const QString& messageId, const QString& at, const OJson& q) {
    for (const char16_t* k : {u"leader", u"mid", u"natural", u"lag_s"}) {
        const OJson* v = f(q, k);
        if (!js::isNum(v) || !std::isfinite(v->n)) return false;
    }
    const QString side = js::isStr(f(q, u"side")) ? f(q, u"side")->s : QString();
    if (side != u"debit" && side != u"credit") return false;
    if (!has(messageId)) return false;
    const auto info = db_.prepare(u"INSERT OR IGNORE INTO follow_quotes (at, message_id, side, leader, mid, natural, lag_s, paper) VALUES (?,?,?,?,?,?,?,?)"_s)
                          .run({at, messageId, side, f(q, u"leader")->n, f(q, u"mid")->n, f(q, u"natural")->n, f(q, u"lag_s")->n, js::truthy(f(q, u"paper")) ? 1 : 0});
    return info.changes > 0;
}

QList<std::pair<QString, OJson>> FollowLogStore::verdictsFor(const QStringList& messageIds) {
    QList<std::pair<QString, OJson>> out;
    QStringList ids;
    for (const QString& id : uniq(messageIds))
        if (!id.isEmpty()) ids << id;
    for (qsizetype i = 0; i < ids.size(); i += 500) {
        const QStringList batch = ids.mid(i, 500);
        QStringList marks;
        util::sqlite::Binds args;
        for (const QString& id : batch) {
            marks << u"?"_s;
            args << id;
        }
        const QList<OJson> rows =
            db_.prepare(u"SELECT message_id, outcome, detail, summary FROM follow_log WHERE message_id IN (%1)"_s.arg(marks.join(u','))).all(args);
        for (const OJson& r : rows) {
            if (!kOutcomes.contains(js::str(col(r, u"outcome")))) continue;
            const QString id = js::str(col(r, u"message_id"));
            const OJson v = js::object({{u"outcome"_s, *col(r, u"outcome")}, {u"detail"_s, *col(r, u"detail")}, {u"summary"_s, *col(r, u"summary")}});
            auto it = std::find_if(out.begin(), out.end(), [&](const auto& p) { return p.first == id; });
            if (it != out.end()) it->second = v;
            else out.append({id, v});
        }
    }
    return out;
}

double FollowLogStore::sentSince(const QString& since) {
    const auto row = db_.prepare(u"SELECT COUNT(*) AS n FROM follow_log WHERE outcome = 'sent' AND at >= ?"_s).get({since});
    const double n = js::num(row ? row->get(u"n"_s) : nullptr);
    return std::isnan(n) ? 0 : n;
}

QList<OJson> FollowLogStore::recent(double limit) {
    const QList<OJson> rows =
        db_.prepare(u"SELECT l.at, l.message_id, l.author_id, l.author_name, l.text, l.outcome, l.detail, l.summary, l.record_ids,"
                    " q.side AS q_side, q.leader AS q_leader, q.mid AS q_mid, q.natural AS q_natural, q.lag_s AS q_lag_s, q.paper AS q_paper"
                    " FROM follow_log l LEFT JOIN follow_quotes q ON q.message_id = l.message_id ORDER BY l.seq DESC LIMIT ?"_s)
            .all({limit});
    QList<OJson> out;
    for (const OJson& r : rows) {
        if (!kOutcomes.contains(js::str(col(r, u"outcome")))) continue;
        OJson e = js::object({{u"at"_s, *col(r, u"at")},
                              {u"message_id"_s, *col(r, u"message_id")},
                              {u"author_id"_s, *col(r, u"author_id")},
                              {u"author_name"_s, *col(r, u"author_name")},
                              {u"text"_s, *col(r, u"text")},
                              {u"outcome"_s, *col(r, u"outcome")},
                              {u"detail"_s, *col(r, u"detail")},
                              {u"summary"_s, *col(r, u"summary")},
                              {u"record_ids"_s, recordIds(col(r, u"record_ids"))}});
        // 没取到报价的那些条不带这个键:和加这张表之前读出来的一字不差
        const QString side = js::isStr(col(r, u"q_side")) ? col(r, u"q_side")->s : QString();
        const bool full = !js::nullish(col(r, u"q_leader")) && !js::nullish(col(r, u"q_mid")) && !js::nullish(col(r, u"q_natural")) && !js::nullish(col(r, u"q_lag_s"));
        if ((side == u"debit" || side == u"credit") && full) {
            const OJson* paper = col(r, u"q_paper");
            e.set(u"quote"_s, js::object({{u"side"_s, js::S(side)},
                                          {u"leader"_s, *col(r, u"q_leader")},
                                          {u"mid"_s, *col(r, u"q_mid")},
                                          {u"natural"_s, *col(r, u"q_natural")},
                                          {u"lag_s"_s, *col(r, u"q_lag_s")},
                                          {u"paper"_s, js::B(js::isNum(paper) && paper->n == 1)}}));
        }
        out << e;
    }
    return out;
}

// ================================================================ messageLog.ts
namespace {
const char16_t* kMessageSchema = uR"(
CREATE TABLE IF NOT EXISTS message_log (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    at          TEXT NOT NULL,
    source      TEXT NOT NULL,
    message_id  TEXT NOT NULL UNIQUE,
    author_id   TEXT NOT NULL,
    author_name TEXT NOT NULL DEFAULT '',
    text        TEXT NOT NULL,
    symbols     TEXT NOT NULL DEFAULT '[]',
    guesses     TEXT NOT NULL DEFAULT '[]',
    trusted     INTEGER NOT NULL DEFAULT 0,
    prices      TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS message_log_at ON message_log(at);
CREATE TRIGGER IF NOT EXISTS message_log_no_update
BEFORE UPDATE ON message_log
BEGIN SELECT RAISE(ABORT, 'message_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS message_log_no_delete
BEFORE DELETE ON message_log
BEGIN SELECT RAISE(ABORT, 'message_log is append-only'); END;
)";
const QString kMessageColumns = u"seq, at, source, message_id, author_id, author_name, text, symbols, guesses, trusted, prices"_s;

OJson stringsOf(const OJson* raw) { return recordIds(raw); }

OJson numbersOf(const OJson* raw) {
    const auto parsed = js::isStr(raw) ? js::parse(raw->s) : std::nullopt;
    OJson out = js::object();
    if (!parsed || parsed->type != OJson::Object) return out;
    for (const auto& [k, v] : parsed->fields)
        if (v.type == OJson::Number && std::isfinite(v.n)) out.set(k, v);
    return out;
}

OJson messageRow(const OJson& r) {
    const OJson* trusted = col(r, u"trusted");
    return js::object({{u"seq"_s, *col(r, u"seq")},
                       {u"at"_s, *col(r, u"at")},
                       {u"source"_s, js::S(js::str(col(r, u"source")) == u"local" && js::isStr(col(r, u"source")) ? u"local"_s : u"discord"_s)},
                       {u"message_id"_s, *col(r, u"message_id")},
                       {u"author_id"_s, *col(r, u"author_id")},
                       {u"author_name"_s, *col(r, u"author_name")},
                       {u"text"_s, *col(r, u"text")},
                       {u"symbols"_s, stringsOf(col(r, u"symbols"))},
                       {u"guesses"_s, stringsOf(col(r, u"guesses"))},
                       {u"trusted"_s, js::B(js::isNum(trusted) && trusted->n == 1)},
                       {u"prices"_s, numbersOf(col(r, u"prices"))}});
}

/// 按标的筛:symbols 列是 JSON 数组,代码带着引号整个出现,LIKE 不会把 NVDA 当成 NVDAX
QString symbolLike(const QString& symbol) {
    QString s = symbol.toUpper();
    static const QRegularExpression strip(u"[%_\"]"_s);
    s.remove(strip);
    return u"%\""_s + s + u"\"%"_s;
}
}  // namespace

MessageLogStore::MessageLogStore(util::sqlite::Database& db) : db_(db) { db.exec(QString::fromUtf16(kMessageSchema)); }

bool MessageLogStore::has(const QString& messageId) { return db_.prepare(u"SELECT 1 FROM message_log WHERE message_id = ?"_s).getRow({messageId}).has_value(); }

bool MessageLogStore::add(const OJson& e) {
    QStringList symbols, guesses;
    if (const OJson* s = f(e, u"symbols"); js::isArr(s))
        for (const OJson& x : s->items) symbols << js::str(&x).toUpper();
    symbols = uniq(symbols);
    if (const OJson* g = f(e, u"guesses"); js::isArr(g))
        for (const OJson& x : g->items) guesses << js::str(&x).toUpper();
    QStringList kept;
    for (const QString& g : uniq(guesses))
        if (!symbols.contains(g)) kept << g;
    const OJson* prices = f(e, u"prices");
    const auto info = db_.prepare(u"INSERT OR IGNORE INTO message_log (at, source, message_id, author_id, author_name, text, symbols, guesses, trusted, prices)"
                                  " VALUES (?,?,?,?,?,?,?,?,?,?)"_s)
                          .run({Bind::of(f(e, u"at")), Bind::of(f(e, u"source")), Bind::of(f(e, u"message_id")), Bind::of(f(e, u"author_id")),
                                Bind(sliceOf(f(e, u"author_name"), 80)), Bind(sliceOf(f(e, u"text"), kMessageTextMax)), Bind(js::stringify(js::strings(symbols))),
                                Bind(js::stringify(js::strings(kept))), js::truthy(f(e, u"trusted")) ? 1 : 0,
                                Bind(js::stringify(js::nullish(prices) ? js::object() : *prices))});
    return info.changes > 0;
}

QList<OJson> MessageLogStore::recent(const OJson& opts) {
    const OJson* lim = f(opts, u"limit");
    const double limit = std::max(1.0, std::min(5000.0, std::floor(js::nullish(lim) ? 200 : js::num(lim))));
    QStringList where;
    util::sqlite::Binds args;
    if (const OJson* sym = f(opts, u"symbol"); js::truthy(sym)) {
        where << u"symbols LIKE ?"_s;
        args << symbolLike(js::str(sym));
    }
    if (const OJson* since = f(opts, u"since"); js::truthy(since)) {
        where << u"at >= ?"_s;
        args << Bind::from(*since);
    }
    args << limit;
    const QString sql = u"SELECT %1 FROM message_log%2 ORDER BY seq DESC LIMIT ?"_s.arg(kMessageColumns, where.isEmpty() ? QString() : u" WHERE "_s + where.join(u" AND "_s));
    QList<OJson> out;
    for (const OJson& r : db_.prepare(sql).all(args)) out << messageRow(r);
    return out;
}

double MessageLogStore::count() {
    const auto row = db_.prepare(u"SELECT COUNT(*) AS n FROM message_log"_s).get();
    const double n = js::num(row ? row->get(u"n"_s) : nullptr);
    return std::isnan(n) ? 0 : n;
}

double MessageLogStore::countSince(const QString& since, const std::optional<QString>& symbol) {
    const auto row = symbol && !symbol->isEmpty()
                         ? db_.prepare(u"SELECT COUNT(*) AS n FROM message_log WHERE at >= ? AND symbols LIKE ?"_s).get({since, symbolLike(*symbol)})
                         : db_.prepare(u"SELECT COUNT(*) AS n FROM message_log WHERE at >= ?"_s).get({since});
    const double n = js::num(row ? row->get(u"n"_s) : nullptr);
    return std::isnan(n) ? 0 : n;
}

// ================================================================ ideaVectors.ts
QString textHash(const QString& text) { return QString::fromLatin1(QCryptographicHash::hash(text.toUtf8(), QCryptographicHash::Sha1).toHex().left(16)); }

IdeaVectorStore::IdeaVectorStore(util::sqlite::Database& db) : db_(db) {
    db.exec(uR"(
CREATE TABLE IF NOT EXISTS idea_vectors (
    idea_id    TEXT NOT NULL,
    model      TEXT NOT NULL,
    dim        INTEGER NOT NULL,
    text_hash  TEXT NOT NULL,
    vec        BLOB NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (idea_id, model)
);
)"_s);
}

QList<std::pair<QString, QVector<float>>> IdeaVectorStore::get(const QString& model, const QList<std::pair<QString, QString>>& ideas) {
    QList<std::pair<QString, QVector<float>>> out;
    auto stmt = db_.prepare(u"SELECT text_hash, vec FROM idea_vectors WHERE idea_id=? AND model=?"_s);
    for (const auto& [id, text] : ideas) {
        const auto row = stmt.getRow({id, model});
        if (!row) continue;
        const auto* hash = row->find(u"text_hash"_s);
        if (!hash || !std::holds_alternative<QString>(*hash) || std::get<QString>(*hash) != textHash(text)) continue;
        const auto* vec = row->find(u"vec"_s);
        QByteArray bytes = vec && std::holds_alternative<QByteArray>(*vec) ? std::get<QByteArray>(*vec) : QByteArray();
        QVector<float> v(bytes.size() / qsizetype(sizeof(float)));
        std::memcpy(v.data(), bytes.constData(), size_t(v.size()) * sizeof(float));
        auto it = std::find_if(out.begin(), out.end(), [&](const auto& p) { return p.first == id; });
        if (it != out.end()) it->second = v;
        else out.append({id, v});
    }
    return out;
}

void IdeaVectorStore::put(const QString& ideaId, const QString& text, const QString& model, const QVector<double>& vec) {
    QVector<float> f32(vec.size());
    for (qsizetype i = 0; i < vec.size(); ++i) f32[i] = float(vec[i]);
    const QByteArray bytes(reinterpret_cast<const char*>(f32.constData()), f32.size() * qsizetype(sizeof(float)));
    const double now = util::dateNow();
    db_.prepare(u"INSERT OR REPLACE INTO idea_vectors (idea_id, model, dim, text_hash, vec, created_at) VALUES (?,?,?,?,?,?)"_s)
        .run({ideaId, model, double(f32.size()), textHash(text), bytes, util::utcIso(now - std::fmod(now, 1000.0))});
}

double IdeaVectorStore::count(const QString& model) {
    const auto row = db_.prepare(u"SELECT COUNT(*) AS n FROM idea_vectors WHERE model=?"_s).get({model});
    return js::num(row ? row->get(u"n"_s) : nullptr);
}

}  // namespace ibkr::domain
