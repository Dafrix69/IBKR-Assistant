#include "shell/store_guard.h"

#include "shell/config_guard.h"
#include "shell/jsvalue.h"

#include <QCoreApplication>
#include <QDateTime>
#include <QHash>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QRegularExpression>

#include <algorithm>

using namespace Qt::StringLiterals;

namespace ibkr::shell::store {

namespace {
const QRegularExpression& backupName() {
    static const QRegularExpression re(uR"(\A trades-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(daily|upgrade|manual)(?:-\d+)?\.db\z)"_s.remove(u' '));
    return re;
}
}  // namespace

QString backupDir(const QString& dbPath) { return QDir(QFileInfo(dbPath).path()).filePath(u"backups"_s); }

QList<Backup> listBackups(const QString& dbPath) {
    QList<Backup> out;
    const QDir dir(backupDir(dbPath));
    for (const QString& name : dir.entryList(QDir::Files | QDir::Hidden | QDir::System)) {
        const auto m = backupName().match(name);
        if (!m.hasMatch()) continue;
        const qint64 bytes = QFileInfo(dir.filePath(name)).size();
        if (bytes <= 0) continue;
        out.append({name, m.captured(7), u"%1-%2-%3T%4:%5:%6Z"_s.arg(m.captured(1), m.captured(2), m.captured(3), m.captured(4), m.captured(5), m.captured(6)), bytes});
    }
    // 新的在前;同一时刻的按名字倒排(-2 在前)
    std::sort(out.begin(), out.end(), [](const Backup& a, const Backup& b) { return a.at == b.at ? b.name < a.name : b.at < a.at; });
    return out;
}

QString describeBackup(const Backup& b, const QTimeZone& zone) {
    static const QHash<QString, QString> reasons{{u"daily"_s, u"每日自动"_s}, {u"upgrade"_s, u"升级前"_s}, {u"manual"_s, u"手动"_s}};
    const QString when = QDateTime::fromString(b.at, Qt::ISODate).toTimeZone(zone).toString(u"yyyy/MM/dd HH:mm"_s);
    const QString size = b.bytes >= 1024 * 1024 ? jsToFixed(double(b.bytes) / 1024 / 1024, 1) + u" MB"_s
                                                 : jsNumberToString(std::max(1.0, jsRound(double(b.bytes) / 1024))) + u" KB"_s;
    return u"%1 · %2 · %3"_s.arg(when, reasons.value(b.reason, b.reason), size);
}

std::optional<Restored> restoreBackup(const QString& dbPath, const QString& name, double nowMs, QString* error, const QString& aside, const QTimeZone& zone) {
    const auto fail = [error](const QString& why) {
        if (error) *error = why;
        return std::nullopt;
    };
    if (!backupName().match(name).hasMatch()) return fail(u"这不是一份备份的文件名"_s);
    const QString source = QDir(backupDir(dbPath)).filePath(name);
    const QFileInfo info(source);
    if (!info.isFile() || info.size() <= 0) return fail(u"找不到这份备份:"_s + name);
    // SQLite 文件开头 16 个字节是固定的:不是它就别往库的位置上放
    QFile src(source);
    if (!src.open(QIODevice::ReadOnly) || src.read(16) != QByteArray("SQLite format 3\0", 16)) return fail(u"这份备份不是一个数据库文件:"_s + name);
    src.close();

    Restored out{name, {}};
    if (QFile::exists(dbPath)) {
        out.kept = u"%1.%2-%3"_s.arg(dbPath, aside, config::stamp(nowMs, zone));
        if (!QFile::rename(dbPath, out.kept)) return fail(u"现在的库挪不开:"_s + dbPath);
    }
    for (const QString& suffix : {u"-wal"_s, u"-shm"_s}) {
        const QString side = dbPath + suffix;
        if (!QFile::exists(side)) continue;
        // 跟着主文件一起挪走;主文件不在时(只剩孤零零的 WAL)直接删
        if (!out.kept.isEmpty()) QFile::rename(side, out.kept + suffix);
        else QFile::remove(side);
    }
    // 先拷到旁边再换名:拷到一半断电,库的位置上不会出现半个文件
    const QString tmp = u"%1.restoring-%2"_s.arg(dbPath).arg(QCoreApplication::applicationPid());
    QFile::remove(tmp);
    if (!QFile::copy(source, tmp)) return fail(u"拷不出这份备份:"_s + name);
    QFile::setPermissions(tmp, QFileDevice::ReadOwner | QFileDevice::WriteOwner);
    if (!QFile::rename(tmp, dbPath)) return fail(u"换不上恢复出来的库:"_s + dbPath);
    return out;
}

}  // namespace ibkr::shell::store
