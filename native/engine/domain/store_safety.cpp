#include "domain/store_safety.h"

#include "util/collate.h"
#include "util/js_runtime.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/tz.h"

#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QHash>
#include <QRegularExpression>
#include <QSet>

#include <algorithm>
#include <cmath>
#include <cstdio>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;

namespace ibkr::domain {

void rethrowDescribedOpenFailure(std::exception_ptr exc, const QString& dbPath) {
    try {
        std::rethrow_exception(exc);
    } catch (const StoreOpenError&) {
        throw;
    } catch (const util::JsError& e) {
        const auto* coded = dynamic_cast<const util::CodedError*>(&e);
        const QString code = coded ? coded->code() : QString();
        const QString detail = e.message();
        if (code == u"SQLITE_NOTADB" || code.startsWith(u"SQLITE_CORRUPT"))
            throw StoreOpenError(u"corrupt"_s, dbPath, u"交易库文件已损坏,读不出来(%1)。可以从备份恢复。"_s.arg(detail));
        if (code.startsWith(u"SQLITE_BUSY") || code.startsWith(u"SQLITE_LOCKED"))
            throw StoreOpenError(u"locked"_s, dbPath, u"交易库正被另一个程序占用(多半是另一个 Datrix 还没退干净)。请先退出它再试。"_s);
        static const QStringList fsCodes{u"EACCES"_s, u"EPERM"_s, u"EROFS"_s, u"ENOSPC"_s, u"ENOTDIR"_s};
        if (code.startsWith(u"SQLITE_CANTOPEN") || code.startsWith(u"SQLITE_READONLY") || code.startsWith(u"SQLITE_IOERR") || code == u"SQLITE_FULL" ||
            fsCodes.contains(code))
            throw StoreOpenError(u"unwritable"_s, dbPath, u"交易库所在的位置写不进去(%1)。请检查文件夹权限与磁盘剩余空间。"_s.arg(detail));
        throw;
    }
}

// ---------------------------------------------------------------- 备份
namespace {

int keepOf(const QString& reason) { return reason == u"daily" ? 7 : reason == u"upgrade" ? 3 : 5; }
constexpr double kDailyGapMs = 20.0 * 3600 * 1000;

const QRegularExpression& nameRe() {
    static const QRegularExpression re(u"^trades-([0-9]{4})([0-9]{2})([0-9]{2})-([0-9]{2})([0-9]{2})([0-9]{2})-(daily|upgrade|manual)(?:-[0-9]+)?\\.db\\z"_s);
    return re;
}

/// 文件名里的时间用 UTC:同一份库换个时区打开,备份的先后次序不变
QString stampOf(double epochMs) {
    const QDateTime d = QDateTime::fromMSecsSinceEpoch(qint64(epochMs), QTimeZone::UTC);
    return d.toString(u"yyyyMMdd-HHmmss"_s);
}

void logStderr(const QString& text) {
    const QByteArray line = (u"[store] "_s + text + u'\n').toUtf8();
    std::fwrite(line.constData(), 1, size_t(line.size()), stderr);
    std::fflush(stderr);
}

}  // namespace

QString backupDir(const QString& dbPath) { return QFileInfo(dbPath).path() + u"/backups"_s; }

QList<OJson> listBackups(const QString& dbPath) {
    const QString dir = backupDir(dbPath);
    QDir d(dir);
    if (!d.exists()) return {};
    struct Item {
        QString name, reason, at;
        double bytes;
    };
    QList<Item> items;
    for (const QString& name : d.entryList(QDir::AllEntries | QDir::NoDotAndDotDot | QDir::Hidden | QDir::System, QDir::Unsorted)) {
        const auto m = nameRe().match(name);
        if (!m.hasMatch()) continue;
        const QFileInfo fi(dir + u'/' + name);
        if (!fi.exists()) continue;
        items.append({name, m.captured(7), u"%1-%2-%3T%4:%5:%6Z"_s.arg(m.captured(1), m.captured(2), m.captured(3), m.captured(4), m.captured(5), m.captured(6)),
                      double(fi.size())});
    }
    std::stable_sort(items.begin(), items.end(), [](const Item& a, const Item& b) {
        return (a.at == b.at ? util::localeCompare(b.name, a.name) : util::localeCompare(b.at, a.at)) < 0;
    });
    QList<OJson> out;
    for (const Item& i : items) out << js::object({{u"name"_s, js::S(i.name)}, {u"reason"_s, js::S(i.reason)}, {u"at"_s, js::S(i.at)}, {u"bytes"_s, js::N(i.bytes)}});
    return out;
}

QStringList pruneBackups(const QString& dbPath) {
    QStringList removed;
    QHash<QString, int> seen;
    for (const OJson& b : listBackups(dbPath)) {
        const QString reason = b.get(u"reason"_s)->s, name = b.get(u"name"_s)->s;
        seen[reason] += 1;
        if (seen[reason] <= keepOf(reason)) continue;
        const QString path = backupDir(dbPath) + u'/' + name;
        if (QFile::remove(path) || !QFileInfo::exists(path)) removed << name;  // 删不掉就留着,下次再试
    }
    return removed;
}

OJson createBackup(util::sqlite::Database& db, const QString& dbPath, const QString& reason, std::optional<double> nowMs) {
    const double now = nowMs.value_or(util::dateNow());
    const QString dir = backupDir(dbPath);
    if (!QDir().mkpath(dir)) throw util::CodedError(u"EACCES: permission denied, mkdir '%1'"_s.arg(dir), u"EACCES"_s);
    const QString base = u"trades-%1-%2"_s.arg(stampOf(now), reason);
    QString name = base + u".db"_s;
    for (int i = 2; QFileInfo::exists(dir + u'/' + name); ++i) name = u"%1-%2.db"_s.arg(base).arg(i);  // 同一秒里的第二份
    const QString target = dir + u'/' + name;
    db.prepare(u"VACUUM INTO ?"_s).run({target});
    QFile::setPermissions(target, QFileDevice::ReadOwner | QFileDevice::WriteOwner);  // Windows 上尽力而为
    pruneBackups(dbPath);
    for (const OJson& b : listBackups(dbPath))
        if (b.get(u"name"_s)->s == name) return b;
    throw util::JsError(u"备份写出来了却找不到:"_s + target);
}

// ---------------------------------------------------------------- 打开库时
namespace {
QSet<QString>& checkedThisProcess() {
    static QSet<QString> s;
    return s;
}
double userVersion(util::sqlite::Database& db) {
    const auto v = db.pragmaSimple(u"user_version"_s);
    const double n = js::num(v ? &*v : nullptr);
    return std::isnan(n) || n == 0 ? 0 : n;  // Number(...) || 0
}
}  // namespace

void guardOnOpen(util::sqlite::Database& db, const QString& dbPath, bool fresh, std::optional<double> nowMs) {
    const double now = nowMs.value_or(util::dateNow());
    const double version = userVersion(db);
    if (version > kSchemaVersion)
        throw StoreOpenError(u"newer"_s, dbPath,
                             u"交易库是更新版本的软件写的(库的结构版本 %1,这个版本的软件只认到 %2)。请升级到最新版本再打开;硬开可能把库写坏。"_s.arg(
                                 util::jsNumberToString(version), QString::number(kSchemaVersion)));
    if (fresh) return;
    if (!checkedThisProcess().contains(dbPath)) {
        QStringList verdict;
        for (const OJson& r : db.pragma(u"quick_check"_s)) {
            const QString first = r.fields.isEmpty() ? QString() : js::strOr(&r.fields.first().second, QString());
            if (first != u"ok") verdict << first;
        }
        if (!verdict.isEmpty())
            throw StoreOpenError(u"corrupt"_s, dbPath, u"交易库没有通过完整性检查(%1)。可以从备份恢复。"_s.arg(verdict.mid(0, 3).join(u';')));
        checkedThisProcess().insert(dbPath);
    }
    try {
        if (version < kSchemaVersion) {
            const OJson b = createBackup(db, dbPath, u"upgrade"_s, now);
            logStderr(u"升级前已备份:"_s + b.get(u"name"_s)->s);
            return;
        }
        std::optional<OJson> lastDaily;
        for (const OJson& b : listBackups(dbPath))
            if (b.get(u"reason"_s)->s == u"daily") {
                lastDaily = b;
                break;
            }
        if (!lastDaily || now - util::jsDateParse(lastDaily->get(u"at"_s)->s) >= kDailyGapMs) {
            const OJson b = createBackup(db, dbPath, u"daily"_s, now);
            logStderr(u"每日备份:"_s + b.get(u"name"_s)->s);
        }
    } catch (const util::JsError& e) {
        logStderr(u"备份没有成功(不影响使用):"_s + e.message());
    }
}

void stampVersion(util::sqlite::Database& db) {
    if (userVersion(db) != kSchemaVersion) db.pragma(u"user_version = %1"_s.arg(kSchemaVersion));
}

void resetIntegrityCache() { checkedThisProcess().clear(); }

}  // namespace ibkr::domain
