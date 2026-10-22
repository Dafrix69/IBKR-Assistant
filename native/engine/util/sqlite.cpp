#include "util/sqlite.h"

#include "util/jsvalue.h"

#include <sqlite3.h>

#include <QDir>
#include <QFileInfo>
#include <QHash>

using namespace Qt::StringLiterals;

namespace ibkr::util::sqlite {

namespace {
// V8 的上限(better-sqlite3 的 database.cpp 把它们设成 sqlite3_limit):字符串最长 2^29 − 24 个码元
constexpr int kMaxStringSize = (1 << 29) - 24;

const QHash<int, QString>& codeNames() {
    static const QHash<int, QString> m = [] {
        QHash<int, QString> h;
        const struct {
            int code;
            const char* name;
        } table[] = {
            {SQLITE_OK, "SQLITE_OK"},
            {SQLITE_ERROR, "SQLITE_ERROR"},
            {SQLITE_INTERNAL, "SQLITE_INTERNAL"},
            {SQLITE_PERM, "SQLITE_PERM"},
            {SQLITE_ABORT, "SQLITE_ABORT"},
            {SQLITE_BUSY, "SQLITE_BUSY"},
            {SQLITE_LOCKED, "SQLITE_LOCKED"},
            {SQLITE_NOMEM, "SQLITE_NOMEM"},
            {SQLITE_READONLY, "SQLITE_READONLY"},
            {SQLITE_INTERRUPT, "SQLITE_INTERRUPT"},
            {SQLITE_IOERR, "SQLITE_IOERR"},
            {SQLITE_CORRUPT, "SQLITE_CORRUPT"},
            {SQLITE_NOTFOUND, "SQLITE_NOTFOUND"},
            {SQLITE_FULL, "SQLITE_FULL"},
            {SQLITE_CANTOPEN, "SQLITE_CANTOPEN"},
            {SQLITE_PROTOCOL, "SQLITE_PROTOCOL"},
            {SQLITE_EMPTY, "SQLITE_EMPTY"},
            {SQLITE_SCHEMA, "SQLITE_SCHEMA"},
            {SQLITE_TOOBIG, "SQLITE_TOOBIG"},
            {SQLITE_CONSTRAINT, "SQLITE_CONSTRAINT"},
            {SQLITE_MISMATCH, "SQLITE_MISMATCH"},
            {SQLITE_MISUSE, "SQLITE_MISUSE"},
            {SQLITE_NOLFS, "SQLITE_NOLFS"},
            {SQLITE_AUTH, "SQLITE_AUTH"},
            {SQLITE_FORMAT, "SQLITE_FORMAT"},
            {SQLITE_RANGE, "SQLITE_RANGE"},
            {SQLITE_NOTADB, "SQLITE_NOTADB"},
            {SQLITE_NOTICE, "SQLITE_NOTICE"},
            {SQLITE_WARNING, "SQLITE_WARNING"},
            {SQLITE_ROW, "SQLITE_ROW"},
            {SQLITE_DONE, "SQLITE_DONE"},
            {SQLITE_ERROR_MISSING_COLLSEQ, "SQLITE_ERROR_MISSING_COLLSEQ"},
            {SQLITE_ERROR_RETRY, "SQLITE_ERROR_RETRY"},
            {SQLITE_ERROR_SNAPSHOT, "SQLITE_ERROR_SNAPSHOT"},
            {SQLITE_IOERR_READ, "SQLITE_IOERR_READ"},
            {SQLITE_IOERR_SHORT_READ, "SQLITE_IOERR_SHORT_READ"},
            {SQLITE_IOERR_WRITE, "SQLITE_IOERR_WRITE"},
            {SQLITE_IOERR_FSYNC, "SQLITE_IOERR_FSYNC"},
            {SQLITE_IOERR_DIR_FSYNC, "SQLITE_IOERR_DIR_FSYNC"},
            {SQLITE_IOERR_TRUNCATE, "SQLITE_IOERR_TRUNCATE"},
            {SQLITE_IOERR_FSTAT, "SQLITE_IOERR_FSTAT"},
            {SQLITE_IOERR_UNLOCK, "SQLITE_IOERR_UNLOCK"},
            {SQLITE_IOERR_RDLOCK, "SQLITE_IOERR_RDLOCK"},
            {SQLITE_IOERR_DELETE, "SQLITE_IOERR_DELETE"},
            {SQLITE_IOERR_BLOCKED, "SQLITE_IOERR_BLOCKED"},
            {SQLITE_IOERR_NOMEM, "SQLITE_IOERR_NOMEM"},
            {SQLITE_IOERR_ACCESS, "SQLITE_IOERR_ACCESS"},
            {SQLITE_IOERR_CHECKRESERVEDLOCK, "SQLITE_IOERR_CHECKRESERVEDLOCK"},
            {SQLITE_IOERR_LOCK, "SQLITE_IOERR_LOCK"},
            {SQLITE_IOERR_CLOSE, "SQLITE_IOERR_CLOSE"},
            {SQLITE_IOERR_DIR_CLOSE, "SQLITE_IOERR_DIR_CLOSE"},
            {SQLITE_IOERR_SHMOPEN, "SQLITE_IOERR_SHMOPEN"},
            {SQLITE_IOERR_SHMSIZE, "SQLITE_IOERR_SHMSIZE"},
            {SQLITE_IOERR_SHMLOCK, "SQLITE_IOERR_SHMLOCK"},
            {SQLITE_IOERR_SHMMAP, "SQLITE_IOERR_SHMMAP"},
            {SQLITE_IOERR_SEEK, "SQLITE_IOERR_SEEK"},
            {SQLITE_IOERR_DELETE_NOENT, "SQLITE_IOERR_DELETE_NOENT"},
            {SQLITE_IOERR_MMAP, "SQLITE_IOERR_MMAP"},
            {SQLITE_IOERR_GETTEMPPATH, "SQLITE_IOERR_GETTEMPPATH"},
            {SQLITE_IOERR_CONVPATH, "SQLITE_IOERR_CONVPATH"},
            {SQLITE_IOERR_VNODE, "SQLITE_IOERR_VNODE"},
            {SQLITE_IOERR_AUTH, "SQLITE_IOERR_AUTH"},
            {SQLITE_IOERR_BEGIN_ATOMIC, "SQLITE_IOERR_BEGIN_ATOMIC"},
            {SQLITE_IOERR_COMMIT_ATOMIC, "SQLITE_IOERR_COMMIT_ATOMIC"},
            {SQLITE_IOERR_ROLLBACK_ATOMIC, "SQLITE_IOERR_ROLLBACK_ATOMIC"},
            {SQLITE_IOERR_DATA, "SQLITE_IOERR_DATA"},
            {SQLITE_IOERR_CORRUPTFS, "SQLITE_IOERR_CORRUPTFS"},
            {SQLITE_IOERR_IN_PAGE, "SQLITE_IOERR_IN_PAGE"},
            {SQLITE_LOCKED_SHAREDCACHE, "SQLITE_LOCKED_SHAREDCACHE"},
            {SQLITE_LOCKED_VTAB, "SQLITE_LOCKED_VTAB"},
            {SQLITE_BUSY_RECOVERY, "SQLITE_BUSY_RECOVERY"},
            {SQLITE_BUSY_SNAPSHOT, "SQLITE_BUSY_SNAPSHOT"},
            {SQLITE_CANTOPEN_NOTEMPDIR, "SQLITE_CANTOPEN_NOTEMPDIR"},
            {SQLITE_CANTOPEN_ISDIR, "SQLITE_CANTOPEN_ISDIR"},
            {SQLITE_CANTOPEN_FULLPATH, "SQLITE_CANTOPEN_FULLPATH"},
            {SQLITE_CANTOPEN_CONVPATH, "SQLITE_CANTOPEN_CONVPATH"},
            {SQLITE_CANTOPEN_DIRTYWAL, "SQLITE_CANTOPEN_DIRTYWAL"},
            {SQLITE_CANTOPEN_SYMLINK, "SQLITE_CANTOPEN_SYMLINK"},
            {SQLITE_CORRUPT_VTAB, "SQLITE_CORRUPT_VTAB"},
            {SQLITE_CORRUPT_SEQUENCE, "SQLITE_CORRUPT_SEQUENCE"},
            {SQLITE_CORRUPT_INDEX, "SQLITE_CORRUPT_INDEX"},
            {SQLITE_READONLY_RECOVERY, "SQLITE_READONLY_RECOVERY"},
            {SQLITE_READONLY_CANTLOCK, "SQLITE_READONLY_CANTLOCK"},
            {SQLITE_READONLY_ROLLBACK, "SQLITE_READONLY_ROLLBACK"},
            {SQLITE_READONLY_DBMOVED, "SQLITE_READONLY_DBMOVED"},
            {SQLITE_READONLY_CANTINIT, "SQLITE_READONLY_CANTINIT"},
            {SQLITE_READONLY_DIRECTORY, "SQLITE_READONLY_DIRECTORY"},
            {SQLITE_ABORT_ROLLBACK, "SQLITE_ABORT_ROLLBACK"},
            {SQLITE_CONSTRAINT_CHECK, "SQLITE_CONSTRAINT_CHECK"},
            {SQLITE_CONSTRAINT_COMMITHOOK, "SQLITE_CONSTRAINT_COMMITHOOK"},
            {SQLITE_CONSTRAINT_FOREIGNKEY, "SQLITE_CONSTRAINT_FOREIGNKEY"},
            {SQLITE_CONSTRAINT_FUNCTION, "SQLITE_CONSTRAINT_FUNCTION"},
            {SQLITE_CONSTRAINT_NOTNULL, "SQLITE_CONSTRAINT_NOTNULL"},
            {SQLITE_CONSTRAINT_PRIMARYKEY, "SQLITE_CONSTRAINT_PRIMARYKEY"},
            {SQLITE_CONSTRAINT_TRIGGER, "SQLITE_CONSTRAINT_TRIGGER"},
            {SQLITE_CONSTRAINT_UNIQUE, "SQLITE_CONSTRAINT_UNIQUE"},
            {SQLITE_CONSTRAINT_VTAB, "SQLITE_CONSTRAINT_VTAB"},
            {SQLITE_CONSTRAINT_ROWID, "SQLITE_CONSTRAINT_ROWID"},
            {SQLITE_CONSTRAINT_PINNED, "SQLITE_CONSTRAINT_PINNED"},
            {SQLITE_CONSTRAINT_DATATYPE, "SQLITE_CONSTRAINT_DATATYPE"},
            {SQLITE_NOTICE_RECOVER_WAL, "SQLITE_NOTICE_RECOVER_WAL"},
            {SQLITE_NOTICE_RECOVER_ROLLBACK, "SQLITE_NOTICE_RECOVER_ROLLBACK"},
            {SQLITE_NOTICE_RBU, "SQLITE_NOTICE_RBU"},
            {SQLITE_WARNING_AUTOINDEX, "SQLITE_WARNING_AUTOINDEX"},
            {SQLITE_AUTH_USER, "SQLITE_AUTH_USER"},
            {SQLITE_OK_LOAD_PERMANENTLY, "SQLITE_OK_LOAD_PERMANENTLY"},
            {SQLITE_OK_SYMLINK, "SQLITE_OK_SYMLINK"},
        };
        for (const auto& e : table) h.insert(e.code, QString::fromLatin1(e.name));
        return h;
    }();
    return m;
}

/// better-sqlite3 的 IS_SKIPPED:空白与分号
bool skipped(char c) { return c == ' ' || c == ';' || (c >= '\t' && c <= '\r'); }

[[noreturn]] void throwHandle(sqlite3* h) { throw SqliteError(QString::fromUtf8(sqlite3_errmsg(h)), codeName(sqlite3_extended_errcode(h))); }
}  // namespace

QString codeName(int code) { return codeNames().value(code, u"UNKNOWN_SQLITE_ERROR_%1"_s.arg(code)); }

Bind Bind::from(const OJson& j) {
    switch (j.type) {
    case OJson::Null: return Bind();
    case OJson::Number: return Bind(j.n);
    case OJson::String: return Bind(j.s);
    case OJson::Bool: return Bind::boolean();
    default: return Bind::boolean();  // 数组 / 对象:better-sqlite3 会当成一组参数或具名参数,这里不支持,当作不能绑定(见 brief)
    }
}

const Cell* Row::find(const QString& name) const {
    for (qsizetype i = names.size() - 1; i >= 0; --i)
        if (names[i] == name) return &cells[i];
    return nullptr;
}

OJson cellJson(const Cell& c) {
    if (std::holds_alternative<double>(c)) return OJson::number(std::get<double>(c));
    if (std::holds_alternative<QString>(c)) return OJson::string(std::get<QString>(c));
    if (std::holds_alternative<QByteArray>(c)) {
        // JSON.stringify(Buffer):{"type":"Buffer","data":[…]}
        OJson o;
        o.type = OJson::Object;
        o.set(u"type"_s, OJson::string(u"Buffer"_s));
        OJson data;
        data.type = OJson::Array;
        for (char b : std::get<QByteArray>(c)) data.items.append(OJson::number(double(static_cast<unsigned char>(b))));
        o.set(u"data"_s, data);
        return o;
    }
    return OJson::null();
}

OJson Row::object() const {
    OJson o;
    o.type = OJson::Object;
    for (qsizetype i = 0; i < names.size(); ++i) o.set(names[i], cellJson(cells[i]));
    return o;
}

// ---------------------------------------------------------------- Statement
Statement::~Statement() {
    if (h_) sqlite3_finalize(h_);
}

Statement::Statement(Statement&& o) noexcept : db_(o.db_), h_(o.h_), returnsData_(o.returnsData_) { o.h_ = nullptr; }

void Statement::throwDb() const { throwHandle(db_->handle()); }

void Statement::bind(const Binds& args) {
    const int count = sqlite3_bind_parameter_count(h_);
    if (args.size() < count) {
        sqlite3_clear_bindings(h_);
        throw JsError(u"Too few parameter values were provided"_s);
    }
    if (args.size() > count) {
        sqlite3_clear_bindings(h_);
        throw JsError(u"Too many parameter values were provided"_s);
    }
    for (int i = 0; i < count; ++i) {
        const Bind& b = args[i];
        if (b.isBool) {
            sqlite3_clear_bindings(h_);
            throw JsError(u"SQLite3 can only bind numbers, strings, bigints, buffers, and null"_s);
        }
        int rc;
        if (std::holds_alternative<double>(b.v)) {
            rc = sqlite3_bind_double(h_, i + 1, std::get<double>(b.v));
        } else if (std::holds_alternative<QString>(b.v)) {
            const QByteArray u = toNodeUtf8(std::get<QString>(b.v));  // 落单的代理项写成 U+FFFD,同 better-sqlite3
            rc = sqlite3_bind_text(h_, i + 1, u.constData(), int(u.size()), SQLITE_TRANSIENT);
        } else if (std::holds_alternative<QByteArray>(b.v)) {
            const QByteArray& d = std::get<QByteArray>(b.v);
            rc = sqlite3_bind_blob(h_, i + 1, d.isEmpty() ? "" : d.constData(), int(d.size()), SQLITE_TRANSIENT);
        } else {
            rc = sqlite3_bind_null(h_, i + 1);
        }
        if (rc == SQLITE_TOOBIG) {
            sqlite3_clear_bindings(h_);
            throw JsError(u"The bound string, buffer, or bigint is too big"_s);
        }
        if (rc != SQLITE_OK) {
            sqlite3_clear_bindings(h_);
            throw JsError(u"An unexpected error occured while trying to bind parameters"_s);
        }
    }
}

Row Statement::readRow() const {
    Row r;
    const int n = sqlite3_column_count(h_);
    for (int i = 0; i < n; ++i) {
        r.names << QString::fromUtf8(sqlite3_column_name(h_, i));
        switch (sqlite3_column_type(h_, i)) {
        case SQLITE_INTEGER:
        case SQLITE_FLOAT: r.cells << Cell(sqlite3_column_double(h_, i)); break;
        case SQLITE_TEXT: {
            const auto* t = reinterpret_cast<const char*>(sqlite3_column_text(h_, i));
            r.cells << Cell(QString::fromUtf8(t, sqlite3_column_bytes(h_, i)));
            break;
        }
        case SQLITE_BLOB: {
            const auto* d = static_cast<const char*>(sqlite3_column_blob(h_, i));
            r.cells << Cell(QByteArray(d ? d : "", sqlite3_column_bytes(h_, i)));
            break;
        }
        default: r.cells << Cell(); break;
        }
    }
    return r;
}

RunResult Statement::run(const Binds& args) {
    db_->requireOpen();
    bind(args);
    sqlite3* h = db_->handle();
    const int before = sqlite3_total_changes(h);
    sqlite3_step(h_);
    if (sqlite3_reset(h_) != SQLITE_OK) {
        sqlite3_clear_bindings(h_);
        throwDb();
    }
    RunResult r;
    r.changes = sqlite3_total_changes(h) == before ? 0 : sqlite3_changes(h);
    r.lastInsertRowid = double(sqlite3_last_insert_rowid(h));
    sqlite3_clear_bindings(h_);
    return r;
}

std::optional<Row> Statement::getRow(const Binds& args) {
    if (!returnsData_) throw JsError(u"This statement does not return data. Use run() instead"_s);
    db_->requireOpen();
    bind(args);
    const int rc = sqlite3_step(h_);
    if (rc == SQLITE_ROW) {
        Row r = readRow();
        sqlite3_reset(h_);
        sqlite3_clear_bindings(h_);
        return r;
    }
    if (rc == SQLITE_DONE) {
        sqlite3_reset(h_);
        sqlite3_clear_bindings(h_);
        return std::nullopt;
    }
    sqlite3_reset(h_);
    sqlite3_clear_bindings(h_);
    throwDb();
}

QList<Row> Statement::allRows(const Binds& args) {
    if (!returnsData_) throw JsError(u"This statement does not return data. Use run() instead"_s);
    db_->requireOpen();
    bind(args);
    QList<Row> rows;
    while (sqlite3_step(h_) == SQLITE_ROW) rows << readRow();
    if (sqlite3_reset(h_) != SQLITE_OK) {
        sqlite3_clear_bindings(h_);
        throwDb();
    }
    sqlite3_clear_bindings(h_);
    return rows;
}

std::optional<OJson> Statement::get(const Binds& args) {
    const auto r = getRow(args);
    if (!r) return std::nullopt;
    return r->object();
}

QList<OJson> Statement::all(const Binds& args) {
    QList<OJson> out;
    for (const Row& r : allRows(args)) out << r.object();
    return out;
}

// ---------------------------------------------------------------- Database
Database::Database(const QString& path, const OpenOptions& opts) : path_(path) {
    const bool anonymous = path.isEmpty() || path == u":memory:";
    // lib/database.js:目录不在先拒
    if (!anonymous && !QFileInfo(QFileInfo(path).absolutePath()).isDir()) throw JsError(u"Cannot open database because the directory does not exist"_s);
    const int mask = opts.readonly ? SQLITE_OPEN_READONLY : opts.fileMustExist ? SQLITE_OPEN_READWRITE : (SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE);
    const QByteArray name = anonymous ? QByteArray(path.isEmpty() ? "" : ":memory:") : path.toUtf8();
    if (sqlite3_open_v2(name.constData(), &h_, mask, nullptr) != SQLITE_OK) {
        const SqliteError e(QString::fromUtf8(sqlite3_errmsg(h_)), codeName(sqlite3_extended_errcode(h_)));
        sqlite3_close(h_);
        h_ = nullptr;
        throw e;
    }
    sqlite3_extended_result_codes(h_, 1);
    sqlite3_busy_timeout(h_, opts.timeoutMs);
    sqlite3_limit(h_, SQLITE_LIMIT_LENGTH, kMaxStringSize);
    sqlite3_limit(h_, SQLITE_LIMIT_SQL_LENGTH, kMaxStringSize);
    sqlite3_db_config(h_, SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION, 1, nullptr);
    sqlite3_db_config(h_, SQLITE_DBCONFIG_DEFENSIVE, 1, nullptr);
}

Database::~Database() {
    if (h_) sqlite3_close_v2(h_);
}

void Database::requireOpen() const {
    if (!h_) throw JsError(u"The database connection is not open"_s);
}

void Database::throwError() const { throwHandle(h_); }

bool Database::inTransaction() const { return h_ && sqlite3_get_autocommit(h_) == 0; }

Statement Database::prepareImpl(const QString& sql, bool pragmaMode) {
    requireOpen();
    const QByteArray utf8 = toNodeUtf8(sql);
    sqlite3_stmt* h = nullptr;
    const char* tail = nullptr;
    if (sqlite3_prepare_v3(h_, utf8.constData(), int(utf8.size()) + 1, SQLITE_PREPARE_PERSISTENT, &h, &tail) != SQLITE_OK) throwError();
    if (!h) throw JsError(u"The supplied SQL string contains no statements"_s);
    for (char c; (c = *tail);) {
        if (skipped(c)) {
            ++tail;
            continue;
        }
        if (c == '/' && tail[1] == '*') {
            tail += 2;
            for (char d; (d = *tail); ++tail)
                if (d == '*' && tail[1] == '/') {
                    tail += 2;
                    break;
                }
        } else if (c == '-' && tail[1] == '-') {
            tail += 2;
            for (char d; (d = *tail); ++tail)
                if (d == '\n') {
                    ++tail;
                    break;
                }
        } else {
            sqlite3_finalize(h);
            throw JsError(u"The supplied SQL string contains more than one statement"_s);
        }
    }
    return Statement(this, h, sqlite3_column_count(h) >= 1 || pragmaMode);
}

Statement Database::prepare(const QString& sql) { return prepareImpl(sql, false); }

void Database::exec(const QString& sql) {
    requireOpen();
    const QByteArray utf8 = toNodeUtf8(sql);
    const char* p = utf8.constData();
    int status = SQLITE_OK;
    for (;;) {
        while (skipped(*p)) ++p;
        sqlite3_stmt* h = nullptr;
        const char* tail = nullptr;
        status = sqlite3_prepare_v2(h_, p, -1, &h, &tail);
        p = tail;
        if (!h) break;
        do status = sqlite3_step(h);
        while (status == SQLITE_ROW);
        status = sqlite3_finalize(h);
        if (status != SQLITE_OK) break;
    }
    if (status != SQLITE_OK) throwError();
}

QList<OJson> Database::pragma(const QString& source) { return prepareImpl(u"PRAGMA "_s + source, true).all(); }

std::optional<OJson> Database::pragmaSimple(const QString& source) {
    Statement st = prepareImpl(u"PRAGMA "_s + source, true);
    const auto r = st.getRow();
    if (!r || r->cells.isEmpty()) return std::nullopt;
    return cellJson(r->cells.first());
}

void Database::transaction(const std::function<void()>& fn) {
    const bool nested = inTransaction();
    // better-sqlite3 的 transaction.js:嵌套的用同一个名字的 SAVEPOINT
    const QString sp = u"`\t_bs3.\t`"_s;
    prepare(nested ? u"SAVEPOINT "_s + sp : u"BEGIN"_s).run();
    try {
        fn();
        // COMMIT / RELEASE 也在 try 里:提交失败(SQLITE_BUSY)时照样回滚,不让事务一直开着
        // ——开着的话之后每一次写都落进这个永远不提交的事务,关库时一起丢掉
        prepare(nested ? u"RELEASE "_s + sp : u"COMMIT"_s).run();
    } catch (...) {
        if (inTransaction()) {
            prepare(nested ? u"ROLLBACK TO "_s + sp : u"ROLLBACK"_s).run();
            if (nested) prepare(u"RELEASE "_s + sp).run();
        }
        throw;
    }
}

void Database::close() {
    if (h_) {
        sqlite3_close_v2(h_);
        h_ = nullptr;
    }
}

}  // namespace ibkr::util::sqlite
