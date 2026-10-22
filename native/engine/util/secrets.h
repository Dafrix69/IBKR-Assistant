// 引擎进程里的凭证读写(engine-ts/src/secrets.ts 逐句搬):一律异步、有时限,一个系统弹窗只耽误要用这把钥匙的那一件事。
//   · 有没有存过(secretExists):macOS 用 /usr/bin/security find-generic-password 不带 -w,只读属性、不解密、不弹窗;
//     别的平台交给凭证子进程。答案记在进程里,自己写过、读过就更新。
//   · 真要用(readSecret)与写入(writeSecret):交给凭证子进程——就是引擎自己的可执行文件(ibkr-engine --keychain-child),
//     钥匙串认的程序身份不变。调用方最多等 timeoutMs,到点拿到一句说清楚怎么办的错;子进程留着(用户还能在弹窗里点「始终允许」),
//     同一条凭证同时只起一个读的子进程,CHILD_HARD_CAP_MS 之后才杀掉。
#pragma once

#include "util/error.h"
#include "util/keychain.h"
#include "util/task.h"

#include <QHash>
#include <QString>

#include <memory>
#include <optional>

namespace ibkr::util {

class KeychainTimeoutError : public KeychainError {
public:
    using KeychainError::KeychainError;
};

inline constexpr int kSecretTimeoutMs = 20'000;
inline constexpr int kExistsTimeoutMs = 8'000;
inline constexpr int kChildHardCapMs = 180'000;

/// 凭证库的三件事。真的是 childBackend();测试换成假的
class SecretBackend {
public:
    virtual ~SecretBackend() = default;
    virtual Task<bool> exists(const QString& service, const QString& account) = 0;
    virtual Task<std::optional<QString>> read(const QString& service, const QString& account) = 0;
    virtual Task<> write(const QString& service, const QString& account, const QString& secret) = 0;
};

struct SecretLimits {
    int timeoutMs = kSecretTimeoutMs;
    int existsTimeoutMs = kExistsTimeoutMs;
};

/// 换掉凭证后端(测试用;传空回到真的),时限可以一起改;记下的答案与在途的读一并清掉
void useSecretBackend(std::shared_ptr<SecretBackend> next, SecretLimits limits = {});
/// 有没有存过;查不出来(超时、出错)按没存过答,不记
Task<bool> secretExists(QString service, QString account);  // 协程的参数一律传值:挂起之后引用就悬空了
/// 取出明文(没有是空);到点抛 KeychainTimeoutError,在途的那次读不撤
Task<std::optional<QString>> readSecret(QString service, QString account);
/// 写入;空密钥当场拒;到点抛 KeychainTimeoutError(那次写不撤)
Task<> writeSecret(QString service, QString account, QString secret);

/// 真的后端:exists 在 macOS 上问 security,读写交给凭证子进程。program 默认是自己(QCoreApplication::applicationFilePath)
std::shared_ptr<SecretBackend> childBackend(const QString& program = {}, const QStringList& args = {QStringLiteral("--keychain-child")}, int hardCapMs = kChildHardCapMs);
/// 凭证子进程的入口(main.cpp 见到 --keychain-child 时调):读一行请求、在另一个线程里做、答一行、退出;stdin 断了就连同系统弹窗一起结束
int runKeychainChild();

}  // namespace ibkr::util
