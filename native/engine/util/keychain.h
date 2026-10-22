// 凭证读写(engine-ts/src/keychain.ts):macOS 走 Keychain(登录钥匙串里的 generic password,service + account,
// 同 @napi-rs/keyring 背后的 apple-native-keyring-store,读得到 Electron 版存的那一份)、Windows 走凭据管理器;
// 其余平台显式报错,不退化为明文。第一次读不到时把旧版的存法(macOS 的 security 命令、Windows 的 DPAPI 文件)搬进来,旧的不删。
//
// **引擎进程不直接调这里**:这些是同步调用,macOS 弹窗问人时一直等。引擎走 util/secrets(子进程、有时限);
// 这里只在凭证子进程(ibkr-engine --keychain-child)里跑。
#pragma once

#include "util/error.h"

#include <QJsonObject>
#include <QString>

#include <optional>

namespace ibkr::util {

class KeychainError : public JsError {
public:
    using JsError::JsError;
};

bool keychainSupported();
void requireKeychainSupported();
/// 没有是空;凭证库读不了抛 KeychainError
std::optional<QString> getSecret(const QString& service, const QString& account);
bool hasSecret(const QString& service, const QString& account);
void setSecret(const QString& service, const QString& account, const QString& secret);
bool deleteSecret(const QString& service, const QString& account);

/// 凭证子进程里做一次请求({ op: get / has / set, service, account, secret }):任何失败都折成 { ok: false, error },不抛
QJsonObject runKeychainRequest(const QJsonValue& raw);

}  // namespace ibkr::util
