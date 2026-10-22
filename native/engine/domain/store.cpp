#include "domain/store.h"

#include "domain/store_safety.h"
#include "util/js_runtime.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QRegularExpression>

#include <cmath>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
using ibkr::util::sqlite::Bind;
using ibkr::util::sqlite::Binds;
namespace js = ibkr::util::js;

namespace ibkr::domain {

const char16_t* const kStoreSchema = uR"SQL(
CREATE TABLE IF NOT EXISTS trade_records (
    id           TEXT PRIMARY KEY,
    created_at   TEXT NOT NULL,
    signature    TEXT NOT NULL,
    quantity     REAL NOT NULL,
    symbol       TEXT NOT NULL,
    account_id   TEXT NOT NULL,
    prompt_version TEXT NOT NULL DEFAULT '',
    record_json  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_created ON trade_records(created_at);
CREATE INDEX IF NOT EXISTS idx_records_signature ON trade_records(signature, created_at);

CREATE TABLE IF NOT EXISTS record_events (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id  TEXT NOT NULL REFERENCES trade_records(id),
    at         TEXT NOT NULL,
    kind       TEXT NOT NULL,
    payload    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_record ON record_events(record_id, seq);

CREATE TABLE IF NOT EXISTS broker_fills (
    exec_id     TEXT PRIMARY KEY,
    account_id  TEXT NOT NULL,
    perm_id     TEXT NOT NULL DEFAULT '',
    time        TEXT NOT NULL,
    fill_json   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fills_time ON broker_fills(time);
CREATE TABLE IF NOT EXISTS audit_log (
    seq    INTEGER PRIMARY KEY AUTOINCREMENT,
    at     TEXT NOT NULL,
    actor  TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL
);

-- 自定义板块(名称 + AI 选出的成分股快照;展示用数据,不进下单链路)
CREATE TABLE IF NOT EXISTS sectors (
    id         TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    name       TEXT NOT NULL UNIQUE,
    stocks     TEXT NOT NULL DEFAULT '[]'
);

-- 想法备忘(不是交易记录,不受 append-only 审计约束;只允许改 status)
CREATE TABLE IF NOT EXISTS ideas (
    id         TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    text       TEXT NOT NULL,
    symbols    TEXT NOT NULL DEFAULT '[]',
    status     TEXT NOT NULL DEFAULT 'active',
    analysis   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ideas_created ON ideas(created_at);

-- 想法知识总结(对一批归档想法的 LLM 提炼;保留历史,复盘时能看到认知演化)
CREATE TABLE IF NOT EXISTS idea_digests (
    id         TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    scope      TEXT NOT NULL DEFAULT 'archived',
    idea_count INTEGER NOT NULL DEFAULT 0,
    idea_ids   TEXT NOT NULL DEFAULT '[]',
    digest     TEXT NOT NULL DEFAULT '{}',
    focus      TEXT NOT NULL DEFAULT '',
    trades     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_idea_digests_created ON idea_digests(created_at);

-- 价位警告(状态要跨重启保留)
CREATE TABLE IF NOT EXISTS alert_watches (
    id         TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    symbol     TEXT NOT NULL UNIQUE,
    step       REAL NOT NULL DEFAULT 5.0,
    enabled    INTEGER NOT NULL DEFAULT 1,
    expiry     TEXT NOT NULL DEFAULT '',
    levels     TEXT NOT NULL DEFAULT '[]',
    states     TEXT NOT NULL DEFAULT '{}',
    last_price REAL,
    wall       TEXT NOT NULL DEFAULT '',
    events     TEXT NOT NULL DEFAULT '[]'
);

-- 持仓追踪(peak / fired / enabled 必须跨重启保留)
CREATE TABLE IF NOT EXISTS position_tracks (
    id         TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    account    TEXT NOT NULL,
    symbol     TEXT NOT NULL,
    sec_type   TEXT NOT NULL DEFAULT 'STK',
    contract   TEXT NOT NULL DEFAULT '{}',
    targets    TEXT NOT NULL DEFAULT '{}',
    auto_close TEXT NOT NULL DEFAULT '{}',
    enabled    INTEGER NOT NULL DEFAULT 1,
    peak       REAL,
    fired_at   TEXT,
    fired_state TEXT NOT NULL DEFAULT '',
    fired_record TEXT NOT NULL DEFAULT '',
    note       TEXT NOT NULL DEFAULT '',
    leg        TEXT NOT NULL DEFAULT '',
    UNIQUE(account, symbol, sec_type, leg)
);

-- 优质股追踪(异动检测的档位 / 滞回状态要跨重启保留,否则重启就把今天报过的再报一遍)
CREATE TABLE IF NOT EXISTS quality_stocks (
    id         TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    symbol     TEXT NOT NULL UNIQUE,
    note       TEXT NOT NULL DEFAULT '',
    enabled    INTEGER NOT NULL DEFAULT 1,
    states     TEXT NOT NULL DEFAULT '{}',
    events     TEXT NOT NULL DEFAULT '[]'
);

-- 界面级偏好(小键值表,目前只存异动阈值)
CREATE TABLE IF NOT EXISTS app_prefs (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- append-only:任何修改历史的尝试都直接失败
CREATE TRIGGER IF NOT EXISTS trade_records_no_update
BEFORE UPDATE ON trade_records
BEGIN SELECT RAISE(ABORT, 'trade_records is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trade_records_no_delete
BEFORE DELETE ON trade_records
BEGIN SELECT RAISE(ABORT, 'trade_records is append-only'); END;
CREATE TRIGGER IF NOT EXISTS record_events_no_update
BEFORE UPDATE ON record_events
BEGIN SELECT RAISE(ABORT, 'record_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS record_events_no_delete
BEFORE DELETE ON record_events
BEGIN SELECT RAISE(ABORT, 'record_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
)SQL";

namespace {
const char16_t* const kTracksV2 = uR"SQL(CREATE TABLE position_tracks_v2 (
            id         TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            account    TEXT NOT NULL,
            symbol     TEXT NOT NULL,
            sec_type   TEXT NOT NULL DEFAULT 'STK',
            contract   TEXT NOT NULL DEFAULT '{}',
            targets    TEXT NOT NULL DEFAULT '{}',
            auto_close TEXT NOT NULL DEFAULT '{}',
            enabled    INTEGER NOT NULL DEFAULT 1,
            peak       REAL,
            fired_at   TEXT,
            fired_state TEXT NOT NULL DEFAULT '',
            fired_record TEXT NOT NULL DEFAULT '',
            note       TEXT NOT NULL DEFAULT '',
            leg        TEXT NOT NULL DEFAULT '',
            UNIQUE(account, symbol, sec_type, leg)
        );
        INSERT INTO position_tracks_v2
            (id, created_at, updated_at, account, symbol, sec_type, contract, targets,
             auto_close, enabled, peak, fired_at, fired_state, fired_record, note, leg)
        SELECT id, created_at, updated_at, account, symbol, sec_type, contract, targets,
               auto_close, enabled, peak, fired_at, fired_state, fired_record, note, ''
        FROM position_tracks;
        DROP TABLE position_tracks;
        ALTER TABLE position_tracks_v2 RENAME TO position_tracks;
      )SQL";
const char16_t* const kIdeasFts = uR"SQL(        BEGIN;
        CREATE VIRTUAL TABLE ideas_fts USING fts5(idea_id UNINDEXED, text, tokenize='trigram');
        CREATE TRIGGER ideas_fts_ai AFTER INSERT ON ideas BEGIN
          INSERT INTO ideas_fts (idea_id, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER ideas_fts_ad AFTER DELETE ON ideas BEGIN
          DELETE FROM ideas_fts WHERE idea_id = old.id;
        END;
        CREATE TRIGGER ideas_fts_au AFTER UPDATE OF text ON ideas BEGIN
          DELETE FROM ideas_fts WHERE idea_id = old.id;
          INSERT INTO ideas_fts (idea_id, text) VALUES (new.id, new.text);
        END;
        INSERT INTO ideas_fts (idea_id, text) SELECT id, text FROM ideas;
        COMMIT;
)SQL";
}  // namespace

const QSet<QString>& terminalStatuses() {
    static const QSet<QString> s{u"filled"_s, u"partially_filled"_s, u"cancelled"_s, u"expired_untriggered"_s, u"rejected_by_validator"_s,
                                 u"rejected_by_llm"_s, u"ibkr_error"_s, u"halted_by_breaker"_s};
    return s;
}

QString redactAccount(const QString& accountId) {
    if (accountId.isEmpty()) return {};
    if (accountId.size() <= 5) return QString(accountId[0]) + u"***"_s;
    return accountId.left(2) + u"***"_s + accountId.right(3);
}

namespace {

QString nowIso() { return util::nowIsoSeconds(); }

bool isUniqueViolation(const util::JsError& e) {
    const auto* c = dynamic_cast<const util::CodedError*>(&e);
    return c && c->code().startsWith(u"SQLITE_CONSTRAINT");
}

const OJson* col(const OJson& row, const char16_t* name) { return row.get(QString::fromUtf16(name)); }
const OJson* f(const OJson* o, const char16_t* name) { return js::prop(o, QString::fromUtf16(name)); }
/// a ?? fallback(拷贝)
OJson orElse(const OJson* v, const OJson& fallback) { return js::nullish(v) ? fallback : *v; }
/// JSON 列就地解开:raw ? JSON.parse(raw) : empty;读不出来也是 empty
OJson parseCol(const OJson* raw, const OJson& empty) {
    if (!js::truthy(raw)) return empty;
    const auto v = js::parse(js::str(raw));
    return v ? *v : empty;
}
/// {...row} 去掉几列
OJson without(const OJson& row, const QStringList& drop) {
    OJson out = js::object();
    for (const auto& [k, v] : row.fields)
        if (!drop.contains(k)) out.set(k, v);
    return out;
}

QStringList uniq(const QStringList& l) {
    QStringList out;
    for (const QString& s : l)
        if (!out.contains(s)) out << s;
    return out;
}

OJson watchRow(const OJson& row) {
    OJson w = row;
    const std::pair<const char16_t*, OJson> keys[] = {{u"levels", js::array()}, {u"states", js::object()}, {u"events", js::array()}, {u"wall", js::Null()}, {u"touch", js::Null()}};
    for (const auto& [k, empty] : keys) {
        const QString key = QString::fromUtf16(k);
        w.set(key, parseCol(w.get(key), empty));
    }
    w.set(u"enabled"_s, js::B(js::truthy(w.get(u"enabled"_s))));
    return w;
}

OJson trackRow(const OJson& row) {
    OJson out = row;
    for (const QString& key : {u"contract"_s, u"targets"_s, u"auto_close"_s}) {
        const OJson* raw = out.get(key);
        const auto v = js::parse(js::truthy(raw) ? js::str(raw) : u"{}"_s);
        out.set(key, v ? *v : js::object());
    }
    out.set(u"enabled"_s, js::B(js::truthy(out.get(u"enabled"_s))));
    return out;
}

OJson qualityRow(const OJson& row) {
    OJson out = row;
    {
        const OJson* raw = out.get(u"states"_s);
        const auto v = js::parse(js::truthy(raw) ? js::str(raw) : u"{}"_s);
        out.set(u"states"_s, v && v->type == OJson::Object ? *v : js::object());
    }
    {
        const OJson* raw = out.get(u"events"_s);
        const auto v = js::parse(js::truthy(raw) ? js::str(raw) : u"[]"_s);
        out.set(u"events"_s, v && v->type == OJson::Array ? *v : js::array());
    }
    out.set(u"enabled"_s, js::N(js::truthy(out.get(u"enabled"_s)) ? 1 : 0));
    return out;
}

/// 备注按字符截(码点,免得把一个表情截成半个);控制字符换成空格
QString clipNote(const OJson* note) {
    static const QRegularExpression ctrl(u"[\\x{0000}-\\x{001f}\\x{007f}]+"_s);
    QString text = js::strOr(note, QString());
    text.replace(ctrl, u" "_s);
    text = util::jsTrim(text);
    QString out;
    int n = 0;
    for (qsizetype i = 0; i < text.size() && n < TradeStore::kQualityNoteMax; ++i, ++n) {
        out += text[i];
        if (text[i].isHighSurrogate() && i + 1 < text.size() && text[i + 1].isLowSurrogate()) out += text[++i];
    }
    return out;
}

OJson sectorRow(const OJson& row) {
    OJson s = row;
    const OJson* raw = s.get(u"stocks"_s);
    const auto v = js::parse(js::truthy(raw) ? js::str(raw) : u"[]"_s);
    // 解析得出来但不是数组(`{}`、`"NVDA"`、`17`):也当空的
    s.set(u"stocks"_s, v && v->type == OJson::Array ? *v : js::array());
    return s;
}

OJson ideaRow(const OJson& row) {
    OJson idea = row;
    {
        const OJson* raw = idea.get(u"symbols"_s);
        const auto v = js::parse(js::truthy(raw) ? js::str(raw) : u"[]"_s);
        idea.set(u"symbols"_s, v ? *v : js::array());
    }
    {
        const OJson* raw = idea.get(u"analysis"_s);
        if (!js::truthy(raw)) idea.set(u"analysis"_s, js::Null());
        else {
            const auto v = js::parse(js::str(raw));
            idea.set(u"analysis"_s, v ? *v : js::Null());
        }
    }
    return idea;
}

/// 已折进来的成交 / 佣金行的 exec_id
QSet<QString> execIdSet(const OJson* rows) {
    QSet<QString> out;
    if (!js::isArr(rows)) return out;
    for (const OJson& r : rows->items) {
        const QString id = js::strOr(f(&r, u"exec_id"), QString());
        if (!id.isEmpty()) out.insert(id);
    }
    return out;
}

/// exec_id 头一回出现就记下并返回 true;没有 exec_id 的一律当新的
bool firstSeen(QSet<QString>& seen, const OJson* execId) {
    const QString key = js::strOr(execId, QString());
    if (key.isEmpty()) return true;
    if (seen.contains(key)) return false;
    seen.insert(key);
    return true;
}

/// {...payload, extraKey: value}
OJson spreadWith(const OJson& payload, const QString& key, const OJson& value) {
    OJson out = js::object();
    if (payload.type == OJson::Object)
        for (const auto& [k, v] : payload.fields) out.set(k, v);
    else if (payload.type == OJson::Array)
        for (qsizetype i = 0; i < payload.items.size(); ++i) out.set(QString::number(i), payload.items[i]);
    else if (payload.type == OJson::String)
        for (qsizetype i = 0; i < payload.s.size(); ++i) out.set(QString::number(i), OJson::string(QString(payload.s[i])));
    out.set(key, value);
    return out;
}

QStringList columnNames(util::sqlite::Database& db, const QString& table) {
    QStringList out;
    for (const OJson& r : db.pragma(u"table_info(%1)"_s.arg(table))) out << js::str(r.get(u"name"_s));
    return out;
}

[[noreturn]] void throwUnknownStatus(const QString& st) { throw util::JsError(u"未知想法状态:"_s + st); }

}  // namespace

// ================================================================ 开库
TradeStore::TradeStore(QString path, bool safety) : dbPath(std::move(path)) {
    bool fresh = false;
    try {
        const QString dir = QFileInfo(dbPath).path();
        if (!QDir().mkpath(dir)) throw util::CodedError(u"EACCES: permission denied, mkdir '%1'"_s.arg(dir), u"EACCES"_s);
        fresh = !QFileInfo::exists(dbPath);
        db_ = std::make_unique<util::sqlite::Database>(dbPath);
        db_->pragma(u"journal_mode = WAL"_s);
        db_->pragma(u"foreign_keys = ON"_s);
        if (safety) guardOnOpen(*db_, dbPath, fresh);
        db_->exec(QString::fromUtf16(kStoreSchema));
        imports_ = std::make_unique<ImportedTradesStore>(*db_);
        vectors_ = std::make_unique<IdeaVectorStore>(*db_);
        signals_ = std::make_unique<SignalLogStore>(*db_);
        follow_ = std::make_unique<FollowLogStore>(*db_);
        messages_ = std::make_unique<MessageLogStore>(*db_);
        risk_ = std::make_unique<RiskQueries>(*db_);
        migrate();
        if (safety) stampVersion(*db_);
    } catch (...) {
        if (safety) rethrowDescribedOpenFailure(std::current_exception(), dbPath);
        throw;
    }
    if (fresh) QFile::setPermissions(dbPath, QFileDevice::ReadOwner | QFileDevice::WriteOwner);  // Windows 上尽力而为
}

TradeStore::~TradeStore() = default;

void TradeStore::migrate() {
    // 向后兼容的轻量迁移:老库缺列时补上,不动已有数据
    const QStringList cols = columnNames(*db_, u"ideas"_s);
    if (!cols.isEmpty() && !cols.contains(u"analysis"_s)) db_->exec(u"ALTER TABLE ideas ADD COLUMN analysis TEXT NOT NULL DEFAULT ''"_s);
    const QStringList dcols = columnNames(*db_, u"idea_digests"_s);
    if (!dcols.isEmpty() && !dcols.contains(u"focus"_s)) db_->exec(u"ALTER TABLE idea_digests ADD COLUMN focus TEXT NOT NULL DEFAULT ''"_s);
    if (!dcols.isEmpty() && !dcols.contains(u"trades"_s)) db_->exec(u"ALTER TABLE idea_digests ADD COLUMN trades TEXT NOT NULL DEFAULT ''"_s);
    const QStringList wcols = columnNames(*db_, u"alert_watches"_s);
    if (!wcols.isEmpty() && !wcols.contains(u"touch"_s)) db_->exec(u"ALTER TABLE alert_watches ADD COLUMN touch TEXT NOT NULL DEFAULT ''"_s);
    if (!wcols.isEmpty() && !wcols.contains(u"levels_at"_s)) db_->exec(u"ALTER TABLE alert_watches ADD COLUMN levels_at TEXT NOT NULL DEFAULT ''"_s);
    if (!wcols.isEmpty() && !wcols.contains(u"origin"_s)) db_->exec(u"ALTER TABLE alert_watches ADD COLUMN origin TEXT NOT NULL DEFAULT ''"_s);
    ideasFts_ = ensureIdeasFts();
    // 追踪表加"腿身份"列并把唯一约束改成含腿:SQLite 改不了约束,只能整表重建,放进一个事务(半路出错整段回滚)
    const QStringList tcols = columnNames(*db_, u"position_tracks"_s);
    if (!tcols.isEmpty() && !tcols.contains(u"leg"_s)) db_->transaction([&] { db_->exec(QString::fromUtf16(kTracksV2)); });
}

void TradeStore::close() { db_->close(); }

OJson TradeStore::backupNow(const QString& reason) { return createBackup(*db_, dbPath, reason); }

// ================================================================ 写入
QString TradeStore::createRecord(OJson& record) {
    OJson recordId = js::truthy(record.get(u"id"_s)) ? *record.get(u"id"_s) : js::S(util::randomUUID());
    record.set(u"id"_s, recordId);
    if (!record.get(u"created_at"_s)) record.set(u"created_at"_s, js::S(nowIso()));
    const double qty = js::num(&static_cast<const OJson&>(orElse(js::path(&record, {u"order"_s, u"totalQuantity"_s}), js::N(0))));
    const auto strOrEmpty = [](const OJson* v) { return js::nullish(v) ? Bind(u""_s) : Bind::from(*v); };
    db_->prepare(u"INSERT INTO trade_records"
                 " (id, created_at, signature, quantity, symbol, account_id, prompt_version, record_json)"
                 " VALUES (?,?,?,?,?,?,?,?)"_s)
        .run({Bind::from(recordId), Bind::of(record.get(u"created_at"_s)), strOrEmpty(record.get(u"signature"_s)), std::isnan(qty) || qty == 0 ? 0.0 : qty,
              strOrEmpty(js::path(&record, {u"contract"_s, u"symbol"_s})), strOrEmpty(js::path(&record, {u"account"_s, u"account_id"_s})),
              strOrEmpty(js::path(&record, {u"llm"_s, u"prompt_version"_s})), js::stringify(js::sortKeys(record))});
    return js::str(&recordId);
}

void TradeStore::appendEvent(const QString& recordId, const QString& kind, const OJson& payload) {
    db_->prepare(u"INSERT INTO record_events (record_id, at, kind, payload) VALUES (?,?,?,?)"_s).run({recordId, nowIso(), kind, js::stringify(payload)});
}

void TradeStore::markSubmitIntent(const QString& recordId) { appendEvent(recordId, u"submit_intent"_s, js::object()); }

void TradeStore::setFinalStatus(const QString& recordId, const QString& status, const std::optional<QString>& errorDetail) {
    if (!terminalStatuses().contains(status)) throw util::JsError(u"未知终态:"_s + status);
    appendEvent(recordId, u"final"_s, js::object({{u"final_status"_s, js::S(status)}, {u"error_detail"_s, errorDetail ? js::S(*errorDetail) : js::Null()}}));
}

double TradeStore::rememberFills(const QList<OJson>& rows) {
    double added = 0;
    auto stmt = db_->prepare(u"INSERT OR IGNORE INTO broker_fills (exec_id, account_id, perm_id, time, fill_json) VALUES (?, ?, ?, ?, ?)"_s);
    for (const OJson& row : rows) {
        const QString execId = js::strOr(f(&row, u"exec_id"), QString());
        if (execId.isEmpty()) continue;
        const auto info = stmt.run({execId, js::strOr(f(&row, u"account_id"), QString()), js::strOr(f(&row, u"perm_id"), QString()),
                                    js::strOr(f(&row, u"time"), QString()), js::stringify(js::sortKeys(row))});
        added += info.changes;
    }
    return added;
}

QList<OJson> TradeStore::listFills() {
    QList<OJson> out;
    for (const OJson& r : db_->prepare(u"SELECT fill_json FROM broker_fills ORDER BY time ASC, exec_id ASC"_s).all()) out << js::parseOrThrow(js::str(col(r, u"fill_json")));
    return out;
}

double TradeStore::countFills() {
    const auto row = db_->prepare(u"SELECT COUNT(*) AS n FROM broker_fills"_s).get();
    const double n = js::num(&static_cast<const OJson&>(orElse(row ? row->get(u"n"_s) : nullptr, js::N(0))));
    return n;
}

QList<OJson> TradeStore::fillsByOrderRef(const QString& orderRef, double limit) {
    if (orderRef.isEmpty()) return {};
    QList<OJson> out;
    const QList<OJson> rows =
        db_->prepare(u"SELECT fill_json FROM broker_fills WHERE fill_json LIKE ? ORDER BY time ASC LIMIT ?"_s).all({u"%\"order_ref\":\""_s + orderRef + u"\"%"_s, limit});
    for (const OJson& r : rows) {
        OJson fill = js::parseOrThrow(js::str(col(r, u"fill_json")));
        if (js::strOr(f(&fill, u"order_ref"), QString()) == orderRef) out << fill;
    }
    return out;
}

void TradeStore::audit(const QString& actor, const QString& action, const OJson* detail) {
    db_->prepare(u"INSERT INTO audit_log (at, actor, action, detail) VALUES (?,?,?,?)"_s)
        .run({nowIso(), actor, action, js::stringify(js::nullish(detail) ? js::object() : *detail)});
}

// ================================================================ 价位警告
OJson TradeStore::addWatch(QString symbol, double step, const QString& origin) {
    symbol = util::jsTrim(symbol).toUpper();
    if (symbol.isEmpty()) throw util::JsError(u"标的代码为空"_s);
    if (!(step >= 0 && step <= 1000)) throw util::JsError(u"整数关口步长必须在 0~1000 之间"_s);
    const OJson watch = js::object({{u"id"_s, js::S(util::randomUUID())},
                                    {u"created_at"_s, js::S(nowIso())},
                                    {u"updated_at"_s, js::S(nowIso())},
                                    {u"symbol"_s, js::S(symbol)},
                                    {u"step"_s, js::N(step)},
                                    {u"enabled"_s, js::B(true)},
                                    {u"expiry"_s, js::S(QString())},
                                    {u"levels"_s, js::array()},
                                    {u"states"_s, js::object()},
                                    {u"last_price"_s, js::Null()},
                                    {u"wall"_s, js::Null()},
                                    {u"events"_s, js::array()},
                                    {u"touch"_s, js::Null()},
                                    {u"levels_at"_s, js::S(QString())},
                                    {u"origin"_s, js::S(origin)}});
    try {
        db_->prepare(u"INSERT INTO alert_watches (id, created_at, updated_at, symbol, step, origin) VALUES (?,?,?,?,?,?)"_s)
            .run({Bind::of(watch.get(u"id"_s)), Bind::of(watch.get(u"created_at"_s)), Bind::of(watch.get(u"updated_at"_s)), symbol, step, origin});
    } catch (const util::JsError& e) {
        if (isUniqueViolation(e)) throw util::JsError(u"已经在盯 %1 了"_s.arg(symbol));
        throw;
    }
    return watch;
}

QList<OJson> TradeStore::listWatches() {
    QList<OJson> out;
    for (const OJson& r : db_->prepare(u"SELECT * FROM alert_watches ORDER BY created_at"_s).all()) out << watchRow(r);
    return out;
}

std::optional<OJson> TradeStore::getWatch(const QString& watchId) {
    const auto row = db_->prepare(u"SELECT * FROM alert_watches WHERE id=?"_s).get({watchId});
    if (!row) return std::nullopt;
    return watchRow(*row);
}

bool TradeStore::updateWatch(const QString& watchId, const OJson& fields) {
    static const QStringList allowed{u"step"_s, u"enabled"_s, u"expiry"_s, u"levels"_s, u"states"_s, u"last_price"_s, u"wall"_s, u"events"_s, u"touch"_s, u"levels_at"_s, u"origin"_s};
    static const QStringList jsonCols{u"levels"_s, u"states"_s, u"wall"_s, u"events"_s, u"touch"_s};
    QStringList sets;
    Binds values;
    for (const auto& [key, raw] : fields.fields) {
        if (!allowed.contains(key)) throw util::JsError(u"不允许修改的字段:"_s + key);
        Bind value = Bind::from(raw);
        if (jsonCols.contains(key)) value = raw.type != OJson::Null ? Bind(js::stringify(raw)) : Bind(u""_s);
        if (key == u"enabled") value = js::truthy(&raw) ? 1 : 0;
        sets << key + u"=?"_s;
        values << value;
    }
    if (sets.isEmpty()) return false;
    sets << u"updated_at=?"_s;
    values << nowIso() << watchId;
    return db_->prepare(u"UPDATE alert_watches SET %1 WHERE id=?"_s.arg(sets.join(u", "_s))).run(values).changes > 0;
}

bool TradeStore::deleteWatch(const QString& watchId) { return db_->prepare(u"DELETE FROM alert_watches WHERE id=?"_s).run({watchId}).changes > 0; }

// ================================================================ 持仓追踪
OJson TradeStore::addTrack(const OJson& track) {
    OJson row = js::object({{u"id"_s, js::S(util::randomUUID())}, {u"created_at"_s, js::S(nowIso())}, {u"updated_at"_s, js::S(nowIso())}});
    // account / symbol 是 undefined 时 TS 的对象里那一键是 undefined(JSON 里没有它);这里就不放
    if (const OJson* a = f(&track, u"account")) row.set(u"account"_s, *a);
    if (const OJson* s = f(&track, u"symbol")) row.set(u"symbol"_s, *s);
    row.set(u"sec_type"_s, orElse(f(&track, u"sec_type"), js::S(u"STK"_s)));
    row.set(u"contract"_s, orElse(f(&track, u"contract"), js::object()));
    row.set(u"targets"_s, orElse(f(&track, u"targets"), js::object()));
    row.set(u"auto_close"_s, orElse(f(&track, u"auto_close"), js::object()));
    row.set(u"enabled"_s, js::B(true));
    row.set(u"peak"_s, orElse(f(&track, u"peak"), js::Null()));
    row.set(u"fired_at"_s, js::Null());
    row.set(u"fired_state"_s, js::S(QString()));
    row.set(u"fired_record"_s, js::S(QString()));
    row.set(u"note"_s, orElse(f(&track, u"note"), js::S(QString())));
    row.set(u"leg"_s, js::truthy(f(&track, u"leg")) ? *f(&track, u"leg") : js::S(QString()));
    try {
        db_->prepare(u"INSERT INTO position_tracks"
                     " (id, created_at, updated_at, account, symbol, sec_type, contract,"
                     "  targets, auto_close, peak, note, leg)"
                     " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"_s)
            .run({Bind::of(row.get(u"id"_s)), Bind::of(row.get(u"created_at"_s)), Bind::of(row.get(u"updated_at"_s)), Bind::of(row.get(u"account"_s)),
                  Bind::of(row.get(u"symbol"_s)), Bind::of(row.get(u"sec_type"_s)), js::stringify(*row.get(u"contract"_s)), js::stringify(*row.get(u"targets"_s)),
                  js::stringify(*row.get(u"auto_close"_s)), Bind::of(row.get(u"peak"_s)), Bind::of(row.get(u"note"_s)), Bind::of(row.get(u"leg"_s))});
    } catch (const util::JsError& e) {
        if (isUniqueViolation(e)) {
            const QString what = js::truthy(row.get(u"leg"_s)) ? js::str(row.get(u"symbol"_s)) + u' ' + js::str(row.get(u"leg"_s)) : js::str(row.get(u"symbol"_s));
            throw util::JsError(u"已经在追踪 %1 的 %2 了"_s.arg(js::str(row.get(u"account"_s)), what));
        }
        throw;
    }
    return row;
}

QList<OJson> TradeStore::listTracks() {
    QList<OJson> out;
    for (const OJson& r : db_->prepare(u"SELECT * FROM position_tracks ORDER BY created_at DESC"_s).all()) out << trackRow(r);
    return out;
}

std::optional<OJson> TradeStore::getTrack(const QString& trackId) {
    const auto row = db_->prepare(u"SELECT * FROM position_tracks WHERE id=?"_s).get({trackId});
    if (!row) return std::nullopt;
    return trackRow(*row);
}

bool TradeStore::updateTrack(const QString& trackId, const OJson& fields) {
    static const QStringList allowed{u"targets"_s, u"auto_close"_s, u"enabled"_s, u"peak"_s, u"fired_at"_s, u"fired_state"_s, u"fired_record"_s, u"note"_s};
    QStringList unknown;
    for (const auto& [k, v] : fields.fields)
        if (!allowed.contains(k)) unknown << k;
    std::sort(unknown.begin(), unknown.end());
    if (!unknown.isEmpty()) throw util::JsError(u"不允许修改的字段:"_s + unknown.join(u", "_s));
    if (fields.fields.isEmpty()) return false;
    QStringList sets{u"updated_at=?"_s};
    Binds values{nowIso()};
    for (const auto& [key, value] : fields.fields) {
        sets << key + u"=?"_s;
        if (key == u"targets" || key == u"auto_close") values << js::stringify(value.type == OJson::Null ? js::object() : value);
        else if (key == u"enabled") values << (js::truthy(&value) ? 1 : 0);
        else values << Bind::from(value);
    }
    values << trackId;
    return db_->prepare(u"UPDATE position_tracks SET %1 WHERE id=?"_s.arg(sets.join(u", "_s))).run(values).changes > 0;
}

bool TradeStore::deleteTrack(const QString& trackId) { return db_->prepare(u"DELETE FROM position_tracks WHERE id=?"_s).run({trackId}).changes > 0; }

// ================================================================ 优质股追踪
OJson TradeStore::addQualityStock(QString symbol, const OJson* note) {
    static const QRegularExpression ws(u"[\\t\\n\\x{000b}\\f\\r \\x{00a0}\\x{1680}\\x{2000}-\\x{200a}\\x{2028}\\x{2029}\\x{202f}\\x{205f}\\x{3000}\\x{feff}]+"_s);
    symbol.remove(ws);
    symbol = symbol.toUpper();
    if (symbol.isEmpty()) throw util::JsError(u"标的代码为空"_s);
    const QString clipped = clipNote(note ? note : nullptr);
    const OJson row = js::object({{u"id"_s, js::S(util::randomUUID())},
                                  {u"created_at"_s, js::S(nowIso())},
                                  {u"updated_at"_s, js::S(nowIso())},
                                  {u"symbol"_s, js::S(symbol)},
                                  {u"note"_s, js::S(clipped)},
                                  {u"enabled"_s, js::N(1)},
                                  {u"states"_s, js::object()},
                                  {u"events"_s, js::array()}});
    try {
        db_->prepare(u"INSERT INTO quality_stocks (id, created_at, updated_at, symbol, note) VALUES (?,?,?,?,?)"_s)
            .run({Bind::of(row.get(u"id"_s)), Bind::of(row.get(u"created_at"_s)), Bind::of(row.get(u"updated_at"_s)), symbol, clipped});
    } catch (const util::JsError& e) {
        if (isUniqueViolation(e)) throw util::JsError(u"已经在追踪 %1 了"_s.arg(symbol));
        throw;
    }
    return row;
}

QList<OJson> TradeStore::listQualityStocks() {
    QList<OJson> out;
    for (const OJson& r : db_->prepare(u"SELECT * FROM quality_stocks ORDER BY created_at, rowid"_s).all()) out << qualityRow(r);
    return out;
}

std::optional<OJson> TradeStore::getQualityStock(const QString& stockId) {
    const auto row = db_->prepare(u"SELECT * FROM quality_stocks WHERE id=?"_s).get({stockId});
    if (!row) return std::nullopt;
    return qualityRow(*row);
}

bool TradeStore::updateQualityStock(const QString& stockId, const OJson& fields) {
    static const QStringList allowed{u"note"_s, u"enabled"_s, u"states"_s, u"events"_s};
    QStringList unknown;
    for (const auto& [k, v] : fields.fields)
        if (!allowed.contains(k)) unknown << k;
    std::sort(unknown.begin(), unknown.end());
    if (!unknown.isEmpty()) throw util::JsError(u"不允许修改的字段:"_s + unknown.join(u", "_s));
    if (fields.fields.isEmpty()) return false;
    QStringList sets{u"updated_at=?"_s};
    Binds values{nowIso()};
    for (const auto& [key, value] : fields.fields) {
        sets << key + u"=?"_s;
        if (key == u"note") values << clipNote(&value);
        else if (key == u"enabled") values << (js::truthy(&value) ? 1 : 0);
        else if (key == u"states") values << js::stringify(value.type == OJson::Null ? js::object() : value);
        else {
            OJson events = value.type == OJson::Array ? value : js::array();
            if (events.items.size() > kQualityEventsKeep) events.items = events.items.mid(events.items.size() - kQualityEventsKeep);
            values << js::stringify(events);
        }
    }
    values << stockId;
    return db_->prepare(u"UPDATE quality_stocks SET %1 WHERE id=?"_s.arg(sets.join(u", "_s))).run(values).changes > 0;
}

bool TradeStore::deleteQualityStock(const QString& stockId) { return db_->prepare(u"DELETE FROM quality_stocks WHERE id=?"_s).run({stockId}).changes > 0; }

// ================================================================ 偏好
OJson TradeStore::getPref(const QString& key) {
    const auto row = db_->prepare(u"SELECT value FROM app_prefs WHERE key=?"_s).get({key});
    if (!row) return js::Null();
    const auto v = js::parse(js::str(row->get(u"value"_s)));
    return v ? *v : js::Null();
}

void TradeStore::setPref(const QString& key, const OJson* value) {
    db_->prepare(u"INSERT INTO app_prefs (key, value, updated_at) VALUES (?,?,?)"
                 " ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"_s)
        .run({key, js::stringify(js::nullish(value) ? js::Null() : *value), nowIso()});
}

// ================================================================ 自定义板块
OJson TradeStore::addSector(QString name) {
    name = util::jsTrim(name);
    if (name.isEmpty()) throw util::JsError(u"板块名称为空"_s);
    if (name.size() > 50) throw util::JsError(u"板块名称太长(超过 50 字)"_s);
    const OJson sector = js::object({{u"id"_s, js::S(util::randomUUID())},
                                     {u"created_at"_s, js::S(nowIso())},
                                     {u"updated_at"_s, js::S(nowIso())},
                                     {u"name"_s, js::S(name)},
                                     {u"stocks"_s, js::array()}});
    try {
        db_->prepare(u"INSERT INTO sectors (id, created_at, updated_at, name, stocks) VALUES (?,?,?,?,?)"_s)
            .run({Bind::of(sector.get(u"id"_s)), Bind::of(sector.get(u"created_at"_s)), Bind::of(sector.get(u"updated_at"_s)), name, u"[]"_s});
    } catch (const util::JsError& e) {
        if (isUniqueViolation(e)) throw util::JsError(u"板块已存在:"_s + name);
        throw;
    }
    return sector;
}

std::optional<OJson> TradeStore::getSector(const QString& sectorId) {
    const auto row = db_->prepare(u"SELECT * FROM sectors WHERE id=?"_s).get({sectorId});
    if (!row) return std::nullopt;
    return sectorRow(*row);
}

QList<OJson> TradeStore::listSectors() {
    QList<OJson> out;
    for (const OJson& r : db_->prepare(u"SELECT * FROM sectors ORDER BY created_at"_s).all()) out << sectorRow(r);
    return out;
}

QStringList TradeStore::symbolsInSectors() {
    QStringList out;
    for (const OJson& sector : listSectors()) {
        const OJson* stocks = sector.get(u"stocks"_s);
        if (!js::isArr(stocks)) continue;
        for (const OJson& stock : stocks->items) {
            const QString symbol = util::jsTrim(js::strOr(f(&stock, u"symbol"), QString())).toUpper();
            if (!symbol.isEmpty() && !out.contains(symbol)) out << symbol;
        }
    }
    return out;
}

bool TradeStore::setSectorStocks(const QString& sectorId, const OJson& stocks) {
    return db_->prepare(u"UPDATE sectors SET stocks=?, updated_at=? WHERE id=?"_s).run({js::stringify(stocks), nowIso(), sectorId}).changes > 0;
}

bool TradeStore::deleteSector(const QString& sectorId) { return db_->prepare(u"DELETE FROM sectors WHERE id=?"_s).run({sectorId}).changes > 0; }

// ================================================================ 想法
bool TradeStore::ensureIdeasFts() {
    if (db_->prepare(u"SELECT 1 FROM sqlite_master WHERE type='table' AND name='ideas_fts'"_s).getRow()) return true;
    try {
        db_->exec(QString::fromUtf16(kIdeasFts));
        return true;
    } catch (const util::JsError&) {
        if (db_->inTransaction()) db_->exec(u"ROLLBACK"_s);
        return false;
    }
}

OJson TradeStore::addIdea(QString text, const std::optional<QStringList>& symbols) {
    text = util::jsTrim(text);
    if (text.isEmpty()) throw util::JsError(u"想法内容为空"_s);
    const OJson idea = js::object({{u"id"_s, js::S(util::randomUUID())},
                                   {u"created_at"_s, js::S(nowIso())},
                                   {u"updated_at"_s, js::S(nowIso())},
                                   {u"text"_s, js::S(text)},
                                   {u"symbols"_s, js::strings(symbols.value_or(QStringList()))},
                                   {u"status"_s, js::S(u"active"_s)},
                                   {u"analysis"_s, js::Null()}});
    db_->prepare(u"INSERT INTO ideas (id, created_at, updated_at, text, symbols, status) VALUES (?,?,?,?,?,?)"_s)
        .run({Bind::of(idea.get(u"id"_s)), Bind::of(idea.get(u"created_at"_s)), Bind::of(idea.get(u"updated_at"_s)), text, js::stringify(*idea.get(u"symbols"_s)),
              u"active"_s});
    return idea;
}

QList<OJson> TradeStore::listIdeas(const std::optional<QString>& status, double limit) {
    if (status && !kIdeaStatuses.contains(*status)) throwUnknownStatus(*status);
    const QList<OJson> rows = status && !status->isEmpty()
                                  ? db_->prepare(u"SELECT * FROM ideas WHERE status=? ORDER BY created_at DESC LIMIT ?"_s).all({*status, limit})
                                  : db_->prepare(u"SELECT * FROM ideas ORDER BY created_at DESC LIMIT ?"_s).all({limit});
    QList<OJson> out;
    for (const OJson& r : rows) out << ideaRow(r);
    return out;
}

std::optional<OJson> TradeStore::getIdea(const QString& ideaId) {
    const auto row = db_->prepare(u"SELECT * FROM ideas WHERE id=?"_s).get({ideaId});
    if (!row) return std::nullopt;
    return ideaRow(*row);
}

bool TradeStore::setIdeaSymbols(const QString& ideaId, const QStringList& symbols) {
    return db_->prepare(u"UPDATE ideas SET symbols=?, updated_at=? WHERE id=?"_s).run({js::stringify(js::strings(symbols)), nowIso(), ideaId}).changes > 0;
}

bool TradeStore::setIdeaAnalysis(const QString& ideaId, const OJson& analysis) {
    return db_->prepare(u"UPDATE ideas SET analysis=?, updated_at=? WHERE id=?"_s).run({js::stringify(analysis), nowIso(), ideaId}).changes > 0;
}

bool TradeStore::setIdeaStatus(const QString& ideaId, const QString& status) {
    if (!kIdeaStatuses.contains(status)) throwUnknownStatus(status);
    return db_->prepare(u"UPDATE ideas SET status=?, updated_at=? WHERE id=?"_s).run({status, nowIso(), ideaId}).changes > 0;
}

QList<OJson> TradeStore::searchIdeas(const OJson& filter) {
    QStringList statuses;
    if (const OJson* st = f(&filter, u"statuses"); js::isArr(st))
        for (const OJson& x : st->items) statuses << js::str(&x);
    for (const QString& st : statuses)
        if (!kIdeaStatuses.contains(st)) throwUnknownStatus(st);
    QStringList symbols, terms;
    if (const OJson* s = f(&filter, u"symbols"); js::isArr(s))
        for (const OJson& x : s->items)
            if (const QString t = util::jsTrim(js::str(&x)).toUpper(); !t.isEmpty()) symbols << t;
    symbols = uniq(symbols);
    if (const OJson* t = f(&filter, u"terms"); js::isArr(t))
        for (const OJson& x : t->items)
            if (const QString v = util::jsTrim(js::str(&x)); !v.isEmpty()) terms << v;
    terms = uniq(terms);

    QStringList where;
    Binds args;
    if (!statuses.isEmpty()) {
        QStringList marks;
        for (const QString& s : statuses) {
            marks << u"?"_s;
            args << s;
        }
        where << u"status IN (%1)"_s.arg(marks.join(u','));
    }
    if (const OJson* since = f(&filter, u"since"); js::truthy(since)) {
        where << u"created_at >= ?"_s;
        args << Bind::from(*since);
    }
    if (const OJson* until = f(&filter, u"until"); js::truthy(until)) {
        where << u"created_at < ?"_s;
        args << Bind::from(*until);
    }
    QStringList symMarks;
    for (qsizetype i = 0; i < symbols.size(); ++i) symMarks << u"?"_s;
    const QString symExpr = symbols.isEmpty() ? u"0"_s : u"EXISTS (SELECT 1 FROM json_each(ideas.symbols) WHERE json_each.value IN (%1))"_s.arg(symMarks.join(u','));
    const QStringList textIds = terms.isEmpty() ? QStringList() : ideaIdsMatching(terms);
    const QString txtExpr = terms.isEmpty() ? u"0"_s : u"ideas.id IN (SELECT value FROM json_each(?))"_s;
    Binds selArgs;
    for (const QString& s : symbols) selArgs << s;
    if (!terms.isEmpty()) selArgs << js::stringify(js::strings(textIds));
    if (!symbols.isEmpty() || !terms.isEmpty()) {
        where << u"(%1 OR %2)"_s.arg(symExpr, txtExpr);
        args << selArgs;
    }
    const QString sql = u"SELECT ideas.*, (%1) AS _sym_hit, (%2) AS _txt_hit FROM ideas"_s.arg(symExpr, txtExpr) +
                        (where.isEmpty() ? QString() : u" WHERE "_s + where.join(u" AND "_s)) + u" ORDER BY created_at DESC LIMIT ?"_s;
    const OJson* lim = f(&filter, u"limit");
    Binds all = selArgs;
    all << args << std::max(1.0, std::trunc(js::nullish(lim) ? 500 : js::num(lim)));
    QList<OJson> out;
    for (const OJson& row : db_->prepare(sql).all(all)) {
        const OJson rest = without(row, {u"_sym_hit"_s, u"_txt_hit"_s});
        out << js::object({{u"idea"_s, ideaRow(rest)}, {u"symbol_hit"_s, js::B(js::truthy(row.get(u"_sym_hit"_s)))}, {u"text_hit"_s, js::B(js::truthy(row.get(u"_txt_hit"_s)))}});
    }
    return out;
}

QStringList TradeStore::ideaIdsMatching(const QStringList& terms) {
    QStringList out;
    std::optional<util::sqlite::Statement> fts;
    if (ideasFts_) fts.emplace(db_->prepare(u"SELECT idea_id FROM ideas_fts WHERE text MATCH ?"_s));
    auto sub = db_->prepare(u"SELECT id AS idea_id FROM ideas WHERE instr(lower(text), lower(?)) > 0"_s);
    for (const QString& term : terms) {
        qsizetype codePoints = 0;
        for (qsizetype i = 0; i < term.size(); ++i, ++codePoints)
            if (term[i].isHighSurrogate() && i + 1 < term.size() && term[i + 1].isLowSurrogate()) ++i;
        const QList<OJson> rows = fts && codePoints >= 3 ? fts->all({u"\""_s + QString(term).replace(u"\""_s, u"\"\""_s) + u"\""_s}) : sub.all({term});
        for (const OJson& r : rows) {
            const QString id = js::str(r.get(u"idea_id"_s));
            if (!out.contains(id)) out << id;
        }
    }
    return out;
}

OJson TradeStore::addIdeaDigest(const QString& scope, const QStringList& ideaIds, const OJson& digest, const OJson* focus, const OJson* trades) {
    OJson row = js::object({{u"id"_s, js::S(util::randomUUID())},
                            {u"created_at"_s, js::S(nowIso())},
                            {u"scope"_s, js::S(scope)},
                            {u"idea_count"_s, js::N(double(ideaIds.size()))},
                            {u"idea_ids"_s, js::strings(ideaIds)},
                            {u"digest"_s, digest}});
    if (focus) row.set(u"focus"_s, *focus);  // 只有检索出来的总结才有这个键
    if (trades) row.set(u"trades"_s, *trades);
    db_->prepare(u"INSERT INTO idea_digests (id, created_at, scope, idea_count, idea_ids, digest, focus, trades)"
                 " VALUES (?,?,?,?,?,?,?,?)"_s)
        .run({Bind::of(row.get(u"id"_s)), Bind::of(row.get(u"created_at"_s)), scope, double(ideaIds.size()), js::stringify(*row.get(u"idea_ids"_s)),
              js::stringify(digest), focus ? js::stringify(*focus) : QString(), trades ? js::stringify(*trades) : QString()});
    return row;
}

QList<OJson> TradeStore::listIdeaDigests(double limit) {
    QList<OJson> out;
    for (const OJson& raw : db_->prepare(u"SELECT * FROM idea_digests ORDER BY created_at DESC LIMIT ?"_s).all({limit})) {
        OJson digest = without(raw, {u"focus"_s, u"trades"_s});
        for (const auto& [key, empty] : {std::pair<QString, OJson>{u"idea_ids"_s, js::array()}, std::pair<QString, OJson>{u"digest"_s, js::object()}}) {
            const OJson* v = digest.get(key);
            const auto parsed = js::parse(js::truthy(v) ? js::str(v) : u"null"_s);
            digest.set(key, parsed && parsed->type != OJson::Null ? *parsed : empty);
        }
        // 没焦点(老口径、或那一列读不出来)就没有这个键
        if (const OJson* rf = raw.get(u"focus"_s); js::truthy(rf)) {
            const auto focus = js::parse(js::str(rf));
            if (focus && js::isObjectLike(&*focus)) digest.set(u"focus"_s, *focus);
        }
        if (const OJson* rt = raw.get(u"trades"_s); js::truthy(rt)) {
            const auto trades = js::parse(js::str(rt));
            if (trades && trades->type == OJson::Array) digest.set(u"trades"_s, *trades);
        }
        out << digest;
    }
    return out;
}

// ================================================================ 读取
std::optional<OJson> TradeStore::getRecord(const QString& recordId) {
    const auto row = db_->prepare(u"SELECT record_json FROM trade_records WHERE id=?"_s).get({recordId});
    if (!row) return std::nullopt;
    return foldEvents(recordId, js::parseOrThrow(js::str(row->get(u"record_json"_s))));
}

QList<OJson> TradeStore::listRecords(double limit) {
    QList<OJson> out;
    for (const OJson& r : db_->prepare(u"SELECT id FROM trade_records ORDER BY created_at DESC LIMIT ?"_s).all({limit}))
        if (auto rec = getRecord(js::str(r.get(u"id"_s)))) out << *rec;
    return out;
}

OJson TradeStore::foldEvents(const QString& recordId, OJson record) {
    js::propStrict(&record, u"ibkr"_s);  // record 是 null 时同 TS 抛 TypeError
    if (!js::truthy(record.get(u"ibkr"_s)) || !js::isObjectLike(record.get(u"ibkr"_s))) record.set(u"ibkr"_s, js::object());
    OJson ibkr = *record.get(u"ibkr"_s);
    if (!js::isArr(ibkr.get(u"status_timeline"_s))) ibkr.set(u"status_timeline"_s, js::array());
    if (!js::isArr(ibkr.get(u"fills"_s))) ibkr.set(u"fills"_s, js::array());

    // 同一 exec_id 只折一次(先到的那条为准);没有 exec_id 的认不出是不是同一笔,不去重
    QSet<QString> seenFills = execIdSet(ibkr.get(u"fills"_s));
    QSet<QString> seenCommissions = execIdSet(record.get(u"commissions"_s));

    const QList<OJson> rows = db_->prepare(u"SELECT at, kind, payload FROM record_events WHERE record_id=? ORDER BY seq"_s).all({recordId});
    for (const OJson& row : rows) {
        const OJson payload = js::parseOrThrow(js::str(col(row, u"payload")));
        const QString kind = js::str(col(row, u"kind"));
        const OJson at = js::copyOrNull(col(row, u"at"));
        if (kind == u"status") {
            ibkr.get(u"status_timeline"_s)->items << js::object({{u"status"_s, orElse(js::propStrict(&payload, u"status"_s), js::Null())}, {u"at"_s, at}});
            for (const QString& key : {u"order_id"_s, u"perm_id"_s})
                if (const OJson* v = js::prop(&payload, key); !js::nullish(v)) ibkr.set(key, *v);
        } else if (kind == u"fill") {
            if (firstSeen(seenFills, js::propStrict(&payload, u"exec_id"_s))) {
                const OJson* t = js::prop(&payload, u"time"_s);
                ibkr.get(u"fills"_s)->items << spreadWith(payload, u"time"_s, js::truthy(t) ? *t : at);
            }
        } else if (kind == u"commission") {
            if (!firstSeen(seenCommissions, js::propStrict(&payload, u"exec_id"_s))) continue;
            if (!js::isArr(record.get(u"commissions"_s))) record.set(u"commissions"_s, js::array());
            record.get(u"commissions"_s)->items << spreadWith(payload, u"at"_s, at);
        } else if (kind == u"trigger") {
            record.set(u"triggered_at"_s, at);
            record.set(u"trigger_snapshot"_s, payload);
        } else if (kind == u"final") {
            record.set(u"final_status"_s, orElse(js::propStrict(&payload, u"final_status"_s), js::Null()));
            record.set(u"error_detail"_s, orElse(js::prop(&payload, u"error_detail"_s), js::Null()));
        } else if (kind == u"warning") {
            if (!js::isArr(record.get(u"post_warnings"_s))) record.set(u"post_warnings"_s, js::array());
            record.get(u"post_warnings"_s)->items << spreadWith(payload, u"at"_s, at);
        }
    }

    // 均价:组合(BAG)单只取 BAG 行(腿留在 fills 里给界面看);老 fill 事件没有 sec_type 的按 exec_id 到 broker_fills 补查,认不出就不给均价
    const QList<OJson> fills = ibkr.get(u"fills"_s)->items;  // 拷一份:下面 ibkr.set 会让指进 ibkr 的引用失效
    bool combo = js::str(f(&static_cast<const OJson&>(orElse(record.get(u"contract"_s), js::object())), u"secType")) == u"BAG" &&
                 js::isStr(f(&static_cast<const OJson&>(orElse(record.get(u"contract"_s), js::object())), u"secType"));
    for (const OJson& fl : fills)
        if (const OJson* st = f(&fl, u"sec_type"); js::isStr(st) && st->s == u"BAG") combo = true;
    QList<OJson> priced = fills;
    if (combo) {
        QList<OJson> missing;
        for (const OJson& fl : fills)
            if (!js::truthy(f(&fl, u"sec_type"))) missing << js::copyOrNull(f(&fl, u"exec_id"));
        const auto known = execSecTypes(missing);
        priced.clear();
        for (const OJson& fl : fills) {
            const OJson* st = f(&fl, u"sec_type");
            QString kind;
            bool isString = false;
            if (js::truthy(st)) {
                isString = js::isStr(st);
                kind = js::str(st);
            } else {
                const QString id = js::strOr(f(&fl, u"exec_id"), QString());
                for (const auto& [k, v] : known)
                    if (k == id) {
                        kind = v;
                        isString = true;
                    }
            }
            if (isString && kind == u"BAG") priced << fl;
        }
    }
    const auto numOr0 = [](const OJson* v) {
        const double n = js::num(v);
        return std::isnan(n) || n == 0 ? 0.0 : n;
    };
    double totalQty = 0;
    for (const OJson& fl : priced) totalQty += numOr0(f(&fl, u"qty"));
    if (std::isnan(totalQty)) totalQty = 0;
    if (totalQty != 0) {
        double sum = 0;
        for (const OJson& fl : priced) sum += numOr0(f(&fl, u"price")) * numOr0(f(&fl, u"qty"));
        const double avg = sum / totalQty;
        ibkr.set(u"avg_fill_price"_s, js::N(combo ? std::abs(avg) : avg));
    }
    // 手续费:IBKR 只给腿的成交发佣金回报,按 exec_id 去重后直接相加
    const OJson* commissionsV = record.get(u"commissions"_s);
    if (!js::nullish(commissionsV) && !js::isArr(commissionsV)) {
        // 记录里的 commissions 不是数组(坏了的记录):TS 在 `[...fills, ...commissions]` 或 `commissions.map` 上抛 TypeError,照抛
        const bool hasLength = js::isStr(commissionsV) && !commissionsV->s.isEmpty();
        if ((!fills.isEmpty() || hasLength) && !js::isStr(commissionsV)) throw util::JsError(u"commissions is not iterable"_s);
        throw util::JsError(u"commissions.map is not a function"_s);
    }
    const QList<OJson> commissions = js::isArr(commissionsV) ? commissionsV->items : QList<OJson>();
    if (!fills.isEmpty() || !commissions.isEmpty()) {
        double total = 0;
        for (const OJson& x : fills) total += numOr0(f(&x, u"commission"));
        for (const OJson& x : commissions) total += numOr0(f(&x, u"commission"));
        ibkr.set(u"total_commission"_s, js::N(total));
    }
    QList<OJson> realized;
    for (const OJson& c : commissions)
        if (const OJson* v = f(&c, u"realized_pnl"); !js::nullish(v)) realized << *v;
    if (!realized.isEmpty()) {
        OJson acc = js::N(0);
        for (const OJson& v : realized) acc = js::add(acc, v);  // JS 的 +:数是加,字符串就拼起来(同 TS)
        ibkr.set(u"realized_pnl"_s, acc);
    }
    record.set(u"ibkr"_s, ibkr);
    return record;
}

QList<std::pair<QString, QString>> TradeStore::execSecTypes(const QList<OJson>& execIds) {
    QList<std::pair<QString, QString>> out;
    if (execIds.isEmpty()) return out;
    auto stmt = db_->prepare(u"SELECT fill_json FROM broker_fills WHERE exec_id=?"_s);
    for (const OJson& raw : execIds) {
        const QString execId = js::strOr(&raw, QString());
        if (execId.isEmpty()) continue;
        const auto row = stmt.get({execId});
        QString secType;
        if (row) {
            const OJson fill = js::parseOrThrow(js::str(row->get(u"fill_json"_s)));
            const OJson contract = orElse(js::propStrict(&fill, u"contract"_s), js::object());
            secType = js::strOr(js::prop(&contract, u"secType"_s), QString());
        }
        if (secType.isEmpty()) continue;
        auto it = std::find_if(out.begin(), out.end(), [&](const auto& p) { return p.first == execId; });
        if (it != out.end()) it->second = secType;
        else out.append({execId, secType});
    }
    return out;
}

QList<OJson> TradeStore::listWorkingRecords(double maxAgeDays, std::optional<double> nowMsOpt, double limit) {
    const double nowMs = nowMsOpt.value_or(util::dateNow());
    const double maxAgeMs = maxAgeDays * 86'400'000;
    const QList<OJson> rows = db_->prepare(
                                     u"SELECT t.id, t.symbol, t.account_id, t.quantity, t.created_at, t.signature,"
                                     " (SELECT e2.payload FROM record_events e2"
                                     "   WHERE e2.record_id = t.id AND e2.kind = 'status'"
                                     "   ORDER BY e2.seq DESC LIMIT 1) AS last_status,"
                                     " (SELECT e3.at FROM record_events e3"
                                     "   WHERE e3.record_id = t.id AND e3.kind = 'status'"
                                     "   ORDER BY e3.seq DESC LIMIT 1) AS last_status_at"
                                     " FROM trade_records t"
                                     " WHERE EXISTS ("
                                     "   SELECT 1 FROM record_events e"
                                     "   WHERE e.record_id = t.id AND (e.kind = 'submit_intent'"
                                     "     OR (e.kind = 'status' AND e.payload NOT LIKE '%ValidatedOnly%'))"
                                     " )"
                                     " AND NOT EXISTS ("
                                     "   SELECT 1 FROM record_events f WHERE f.record_id = t.id AND f.kind = 'final'"
                                     " )"
                                     " ORDER BY t.rowid DESC LIMIT 1000"_s)
                                  .all();
    QList<OJson> out;
    for (const OJson& row : rows) {
        const double created = util::jsDateParse(js::str(col(row, u"created_at")));
        if (std::isnan(created)) continue;
        if (nowMs - created > maxAgeMs) continue;
        QString status;
        {
            const OJson* ls = col(row, u"last_status");
            const auto p = js::parse(js::nullish(ls) ? u"{}"_s : js::str(ls));
            // payload 坏了(读不出、是 null)就当没有状态
            if (p && p->type != OJson::Null) status = js::strOr(js::prop(&*p, u"status"_s), QString());
        }
        const OJson* lsa = col(row, u"last_status_at");
        const double statusAt = js::nullish(lsa) ? std::nan("") : util::jsDateParse(js::str(lsa));
        const double qty = js::num(col(row, u"quantity"));
        out << js::object({{u"id"_s, js::copyOrNull(col(row, u"id"))},
                           {u"symbol"_s, js::copyOrNull(col(row, u"symbol"))},
                           {u"accountId"_s, js::copyOrNull(col(row, u"account_id"))},
                           {u"quantity"_s, js::N(std::isnan(qty) || qty == 0 ? 0 : qty)},
                           {u"createdAtMs"_s, js::N(created)},
                           {u"lastStatus"_s, js::S(status)},
                           {u"lastStatusAtMs"_s, std::isnan(statusAt) ? js::Null() : js::N(statusAt)},
                           {u"signature"_s, orElse(col(row, u"signature"), js::S(QString()))}});
        if (out.size() >= limit) break;
    }
    return out;
}

QList<OJson> TradeStore::closeTraces(double limit) {
    const QList<OJson> rows = db_->prepare(u"SELECT at, action, detail FROM audit_log WHERE actor='engine' AND action IN ('auto_close','hosted_sweep')"
                                           " ORDER BY seq DESC LIMIT ?"_s)
                                  .all({limit});
    QList<OJson> out;
    for (const OJson& row : rows) {
        const auto detail = js::parse(js::str(col(row, u"detail")));
        if (!detail) continue;
        const OJson* mark = js::propStrict(&*detail, u"mark"_s);
        const double m = js::num(mark);
        const OJson* rec = js::prop(&*detail, u"record"_s);
        const QString recordId = js::isStr(rec) ? rec->s : QString();
        std::optional<OJson> record;
        if (!recordId.isEmpty()) record = getRecord(recordId);
        out << js::object({{u"at"_s, js::copyOrNull(col(row, u"at"))},
                           {u"path"_s, js::S(js::str(col(row, u"action")) == u"hosted_sweep" ? u"hosted_sweep"_s : u"auto_close"_s)},
                           {u"symbol"_s, js::S(js::strOr(js::prop(&*detail, u"symbol"_s), QString()))},
                           {u"state"_s, js::S(js::strOr(js::prop(&*detail, u"state"_s), QString()))},
                           {u"mark"_s, js::nullish(mark) || !std::isfinite(m) ? js::Null() : js::N(m)},
                           {u"record"_s, record ? *record : js::Null()}});
    }
    return out;
}

QList<OJson> TradeStore::plannedStops() {
    const QList<OJson> rows = db_->prepare(u"SELECT at, detail FROM audit_log WHERE actor='ui' AND action='tracker_add' ORDER BY seq"_s).all();
    QList<OJson> out;
    for (const OJson& row : rows) {
        const auto detail = js::parse(js::str(col(row, u"detail")));
        if (!detail) continue;
        const OJson targets = orElse(js::propStrict(&*detail, u"targets"_s), js::object());
        const double stop = js::num(js::prop(&targets, u"stop_loss"_s));
        const QString symbol = js::strOr(js::prop(&*detail, u"symbol"_s), QString()).toUpper();
        if (symbol.isEmpty() || !std::isfinite(stop) || stop <= 0) continue;
        const OJson* account = js::prop(&*detail, u"account"_s);
        const OJson* secType = js::prop(&*detail, u"sec_type"_s);
        out << js::object({{u"at"_s, js::copyOrNull(col(row, u"at"))},
                           {u"symbol"_s, js::S(symbol)},
                           {u"stop"_s, js::N(stop)},
                           {u"account"_s, account ? js::S(js::str(account)) : js::Null()},
                           {u"sec_type"_s, secType ? js::S(js::str(secType)) : js::Null()}});
    }
    return out;
}

// ================================================================ 导出 / 删除
OJson TradeStore::exportAll() {
    return js::object({{u"exported_at"_s, js::S(nowIso())},
                       {u"records"_s, js::array(listRecords(1'000'000))},
                       {u"audit_log"_s, js::array(db_->prepare(u"SELECT * FROM audit_log ORDER BY seq"_s).all())}});
}

void TradeStore::purgeEverything(const QString& confirm) {
    if (confirm != u"DELETE ALL MY TRADING DATA") throw util::JsError(u"确认口令不正确,已中止。"_s);
    db_->close();
    QFile::remove(dbPath);
    for (const QString& suffix : {u"-wal"_s, u"-shm"_s}) QFile::remove(dbPath + suffix);
}

void TradeStore::rawExec(const QString& sql, const Binds& params) { db_->prepare(sql).run(params); }

}  // namespace ibkr::domain
