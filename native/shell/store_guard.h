// 交易库的恢复(desktop/store-guard.js 逐条搬)。备份是引擎出的(engine-ts/src/storeSafety.ts),恢复在壳里做——
// 换库文件的时候引擎必须是停着的,而能停引擎的只有壳。
//   · 只从库旁边的 backups/ 目录恢复,只认引擎起的那种文件名;界面递过来的只是一个文件名,不是路径;
//   · 现在这份库不删:改名留在旁边(.before-restore-时间戳 / 打不开的是 .corrupt-时间戳),连同 -wal / -shm 一起挪走——
//     留着它们,新库会被旧的 WAL"回放"成一锅粥;
//   · 恢复完不动备份本身:还能再恢复一次。
// 期望值由 node 跑原模块现算(tests/fixtures/gen_store_guard.mjs)。
#pragma once

#include <QList>
#include <QString>
#include <QTimeZone>

#include <optional>

namespace ibkr::shell::store {

inline constexpr int kExitStore = 74;

struct Backup {
    QString name;
    QString reason;  // daily / upgrade / manual
    QString at;      // ISO,UTC:2026-09-28T01:00:00Z
    qint64 bytes = 0;
};

QString backupDir(const QString& dbPath);
/// 备份目录里认得出来的备份,新的在前
QList<Backup> listBackups(const QString& dbPath);
/// 给人看的一行:2026/09/28 09:00 · 每日自动 · 1.2 MB(本机时区)
QString describeBackup(const Backup& b, const QTimeZone& zone = QTimeZone::systemTimeZone());

struct Restored {
    QString restored;
    QString kept;  // 现在这份库挪到了哪;空 = 原来没有库
};
/// 用一份备份换掉现在的库。**调用之前引擎必须已经停了。** aside:before-restore / corrupt
std::optional<Restored> restoreBackup(const QString& dbPath, const QString& name, double nowMs, QString* error,
                                      const QString& aside = QStringLiteral("before-restore"), const QTimeZone& zone = QTimeZone::systemTimeZone());

}  // namespace ibkr::shell::store
