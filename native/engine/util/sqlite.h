// SQLite 的薄壳,照 better-sqlite3 13.0.3 看得见的行为写(TS 引擎就是拿它读写交易库的;src/objects/*.cpp、lib/methods/*.js 逐条对过):
//   · 打开:READWRITE|CREATE、extended result codes、busy_timeout 5000、DEFENSIVE、两项长度上限同 V8;目录不在先拒;
//   · 绑定:数一律 bind_double(整数也是;INTEGER 列的亲和性照样存成整数)、字符串、null、blob;布尔拒绝(同它的 TypeError 原话);
//     参数个数不对:Too few / Too many parameter values were provided;
//   · 读出:INTEGER 当 double(不开 safeIntegers)、TEXT、NULL、BLOB;行按结果列的先后成对象,重名的列后一个盖前一个、位置留在前面;
//   · run() 的 changes:这一步真改了东西才是 sqlite3_changes,否则 0;get / all 只给返回数据的语句(否则那句 TypeError);
//   · prepare 只认一条语句(尾巴上只许空白、分号与注释);exec 一条条跑;
//   · transaction:不在事务里 BEGIN / COMMIT,在事务里 SAVEPOINT / RELEASE;出错回滚再抛;
//   · 错:SqliteError,message = sqlite3_errmsg,code = 扩展结果码的名字(better-sqlite3 的 constants.cpp 那张表,不认识的 UNKNOWN_SQLITE_ERROR_<n>)。
#pragma once

#include "util/error.h"
#include "util/ordered_json.h"

#include <QByteArray>
#include <QString>
#include <QStringList>

#include <functional>
#include <memory>
#include <optional>
#include <variant>

struct sqlite3;
struct sqlite3_stmt;

namespace ibkr::util::sqlite {

/// better-sqlite3 的 SqliteError(code 是 "SQLITE_CONSTRAINT_UNIQUE" 这种名字)
class SqliteError : public CodedError {
public:
    using CodedError::CodedError;
};

/// 一格:NULL / 数 / 文本 / blob
using Cell = std::variant<std::monostate, double, QString, QByteArray>;

/// 绑定的一个值(JS 那边能传进来的几种)
struct Bind {
    Cell v;
    bool isBool = false;  // 传了布尔:绑定时报 TypeError(同 better-sqlite3)
    Bind() = default;
    Bind(std::nullptr_t) {}
    Bind(double d) : v(d) {}
    Bind(int i) : v(double(i)) {}
    Bind(qint64 i) : v(double(i)) {}
    Bind(const QString& s) : v(s) {}
    Bind(const char16_t* s) : v(QString::fromUtf16(s)) {}
    Bind(const QByteArray& b) : v(b) {}
    static Bind boolean() {
        Bind b;
        b.isBool = true;
        return b;
    }
    /// JSON 里的一个值(数、字符串、null;布尔与数组 / 对象见 brief 的已知差别)
    static Bind from(const OJson& j);
    /// 可选的数:空 = NULL
    static Bind orNull(const std::optional<double>& d) { return d ? Bind(*d) : Bind(); }
    /// JS 里拿一个属性去绑:undefined / null → NULL,其余同 from
    static Bind of(const OJson* j) { return j ? from(*j) : Bind(); }
};
using Binds = QList<Bind>;

struct Row {
    QStringList names;
    QList<Cell> cells;
    const Cell* find(const QString& name) const;  // 重名时取后一个(同 JS 对象)
    /// {...row}:JS 对象(blob 写成 JSON.stringify(Buffer) 的样子)
    OJson object() const;
};
OJson cellJson(const Cell& c);

struct RunResult {
    double changes = 0;
    double lastInsertRowid = 0;
};

class Database;

class Statement {
public:
    ~Statement();
    Statement(const Statement&) = delete;
    Statement& operator=(const Statement&) = delete;
    Statement(Statement&&) noexcept;

    bool reader() const { return returnsData_; }
    RunResult run(const Binds& args = {});
    std::optional<Row> getRow(const Binds& args = {});
    QList<Row> allRows(const Binds& args = {});
    /// get() / all():行是 JS 对象
    std::optional<OJson> get(const Binds& args = {});
    QList<OJson> all(const Binds& args = {});

private:
    friend class Database;
    Statement(Database* db, sqlite3_stmt* h, bool returnsData) : db_(db), h_(h), returnsData_(returnsData) {}
    void bind(const Binds& args);
    Row readRow() const;
    [[noreturn]] void throwDb() const;
    Database* db_ = nullptr;
    sqlite3_stmt* h_ = nullptr;
    bool returnsData_ = false;
};

struct OpenOptions {
    bool readonly = false;
    bool fileMustExist = false;
    int timeoutMs = 5000;
};

class Database {
public:
    explicit Database(const QString& path, const OpenOptions& opts = {});
    ~Database();
    Database(const Database&) = delete;
    Database& operator=(const Database&) = delete;

    const QString& name() const { return path_; }
    bool open() const { return h_ != nullptr; }
    bool inTransaction() const;
    Statement prepare(const QString& sql);
    void exec(const QString& sql);
    /// db.pragma(src):所有行
    QList<OJson> pragma(const QString& source);
    /// db.pragma(src, {simple: true}):第一行第一列;没有行是空
    std::optional<OJson> pragmaSimple(const QString& source);
    /// db.transaction(fn)()
    void transaction(const std::function<void()>& fn);
    void close();

    sqlite3* handle() const { return h_; }
    [[noreturn]] void throwError() const;

private:
    friend class Statement;
    Statement prepareImpl(const QString& sql, bool pragmaMode);
    void requireOpen() const;
    QString path_;
    sqlite3* h_ = nullptr;
};

/// 扩展结果码 → better-sqlite3 的名字
QString codeName(int code);

}  // namespace ibkr::util::sqlite
