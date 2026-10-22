// 交易库的保险(engine-ts/src/storeSafety.ts 逐句搬):结构版本号(PRAGMA user_version)、完整性检查(quick_check,每个进程每个库一次)、
// VACUUM INTO 备份(daily 7 / upgrade 3 / manual 5 份)、打不开时的人话(StoreOpenError)。只有真应用开库时走这一套。
#pragma once

#include "util/error.h"
#include "util/ordered_json.h"
#include "util/sqlite.h"

#include <QString>

#include <exception>
#include <optional>

namespace ibkr::domain {

inline constexpr int kSchemaVersion = 1;
inline constexpr int kExitStore = 74;

/// 库打不开:kind = newer / corrupt / locked / unwritable;message 是给用户看的一句话
class StoreOpenError : public util::JsError {
public:
    StoreOpenError(QString kind, QString dbPath, const QString& message) : JsError(message), kind(std::move(kind)), dbPath(std::move(dbPath)) {}
    QString kind;
    QString dbPath;
};

/// 打开库时抛出来的东西认成 StoreOpenError;认不出来的(代码自己的错)原样再抛
[[noreturn]] void rethrowDescribedOpenFailure(std::exception_ptr exc, const QString& dbPath);

QString backupDir(const QString& dbPath);
/// 备份目录里认得出来的备份(BackupInfo:name / reason / at / bytes),新的在前
QList<util::OJson> listBackups(const QString& dbPath);
/// 每种原因只留最新的那几份;返回删掉的名字
QStringList pruneBackups(const QString& dbPath);
/// 出一份快照(VACUUM INTO);抛的是原始错误
util::OJson createBackup(util::sqlite::Database& db, const QString& dbPath, const QString& reason, std::optional<double> nowMs = std::nullopt);
/// 建表 / 迁移之前调:拒绝比软件新的库、查完整性、该备份的先备份
void guardOnOpen(util::sqlite::Database& db, const QString& dbPath, bool fresh, std::optional<double> nowMs = std::nullopt);
/// 建表 / 迁移之后调:盖上结构版本号
void stampVersion(util::sqlite::Database& db);
/// 测试用:忘掉"这个库这个进程里查过了"
void resetIntegrityCache();

}  // namespace ibkr::domain
