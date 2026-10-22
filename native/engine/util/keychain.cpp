#include "util/keychain.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QProcess>
#include <QSaveFile>
#include <QStandardPaths>

#include <cstdio>

#if defined(Q_OS_MACOS)
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#elif defined(Q_OS_WIN)
#include <windows.h>
#include <dpapi.h>
#include <wincred.h>
#endif

namespace ibkr::util {

using namespace Qt::StringLiterals;

namespace {

void logLine(const QString& s) { std::fprintf(stderr, "%s\n", qPrintable(s)); }

#if defined(Q_OS_MACOS)
/// CFString 的生与死
struct Cf {
    CFTypeRef ref = nullptr;
    explicit Cf(CFTypeRef r) : ref(r) {}
    ~Cf() {
        if (ref) CFRelease(ref);
    }
    Cf(const Cf&) = delete;
    Cf& operator=(const Cf&) = delete;
};
CFStringRef cfString(const QString& s) { return s.toCFString(); }

QString osStatusText(OSStatus status) {
    Cf msg(SecCopyErrorMessageString(status, nullptr));
    return msg.ref ? QString::fromCFString(static_cast<CFStringRef>(msg.ref)) : u"OSStatus %1"_s.arg(status);
}

/// 一条 generic password 的查询条件(登录钥匙串,service + account)
CFMutableDictionaryRef baseQuery(const QString& service, const QString& account) {
    CFMutableDictionaryRef q = CFDictionaryCreateMutable(nullptr, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    Cf svc(cfString(service)), acc(cfString(account));
    CFDictionarySetValue(q, kSecClass, kSecClassGenericPassword);
    CFDictionarySetValue(q, kSecAttrService, svc.ref);
    CFDictionarySetValue(q, kSecAttrAccount, acc.ref);
    return q;
}

std::optional<QString> nativeGet(const QString& service, const QString& account) {
    Cf q(baseQuery(service, account));
    CFDictionarySetValue((CFMutableDictionaryRef)q.ref, kSecReturnData, kCFBooleanTrue);
    CFDictionarySetValue((CFMutableDictionaryRef)q.ref, kSecMatchLimit, kSecMatchLimitOne);
    CFTypeRef out = nullptr;
    const OSStatus status = SecItemCopyMatching((CFDictionaryRef)q.ref, &out);
    if (status == errSecItemNotFound) return std::nullopt;
    if (status != errSecSuccess) throw std::runtime_error(osStatusText(status).toStdString());
    Cf data(out);
    const QByteArray bytes = QByteArray::fromRawCFData((CFDataRef)data.ref);
    const QString text = QString::fromUtf8(bytes);
    if (text.toUtf8() != bytes) throw std::runtime_error("Password data is not valid UTF-8");
    return text;
}

void nativeSet(const QString& service, const QString& account, const QString& secret) {
    const QByteArray bytes = secret.toUtf8();
    Cf data(CFDataCreate(nullptr, reinterpret_cast<const UInt8*>(bytes.constData()), bytes.size()));
    Cf q(baseQuery(service, account));
    CFMutableDictionaryRef attrs = CFDictionaryCreateMutable(nullptr, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    Cf attrsGuard(attrs);
    CFDictionarySetValue(attrs, kSecValueData, data.ref);
    OSStatus status = SecItemUpdate((CFDictionaryRef)q.ref, attrs);
    if (status == errSecItemNotFound) {
        CFDictionarySetValue((CFMutableDictionaryRef)q.ref, kSecValueData, data.ref);
        status = SecItemAdd((CFDictionaryRef)q.ref, nullptr);
    }
    if (status != errSecSuccess) throw std::runtime_error(osStatusText(status).toStdString());
}

bool nativeDelete(const QString& service, const QString& account) {
    Cf q(baseQuery(service, account));
    const OSStatus status = SecItemDelete((CFDictionaryRef)q.ref);
    if (status == errSecItemNotFound) return false;
    if (status != errSecSuccess) throw std::runtime_error(osStatusText(status).toStdString());
    return true;
}
#elif defined(Q_OS_WIN)
// keyring-rs 的 Windows 存法:TargetName = "account.service"、类型 GENERIC、UserName = account、密码按 UTF-16 存。
// **还没在 Windows 真机上核对过能不能读到 Electron 版存的那一份。**
std::wstring targetOf(const QString& service, const QString& account) { return (account + u'.' + service).toStdWString(); }
std::optional<QString> nativeGet(const QString& service, const QString& account) {
    PCREDENTIALW cred = nullptr;
    if (!CredReadW(targetOf(service, account).c_str(), CRED_TYPE_GENERIC, 0, &cred)) {
        if (GetLastError() == ERROR_NOT_FOUND) return std::nullopt;
        throw std::runtime_error("CredReadW failed: " + std::to_string(GetLastError()));
    }
    const QString text = QString::fromUtf16(reinterpret_cast<const char16_t*>(cred->CredentialBlob), cred->CredentialBlobSize / 2);
    CredFree(cred);
    return text;
}
void nativeSet(const QString& service, const QString& account, const QString& secret) {
    std::wstring target = targetOf(service, account), user = account.toStdWString();
    std::u16string blob = secret.toStdU16String();
    CREDENTIALW cred{};
    cred.Type = CRED_TYPE_GENERIC;
    cred.TargetName = target.data();
    cred.UserName = user.data();
    cred.CredentialBlobSize = DWORD(blob.size() * 2);
    cred.CredentialBlob = reinterpret_cast<LPBYTE>(blob.data());
    cred.Persist = CRED_PERSIST_ENTERPRISE;
    if (!CredWriteW(&cred, 0)) throw std::runtime_error("CredWriteW failed: " + std::to_string(GetLastError()));
}
bool nativeDelete(const QString& service, const QString& account) {
    if (CredDeleteW(targetOf(service, account).c_str(), CRED_TYPE_GENERIC, 0)) return true;
    if (GetLastError() == ERROR_NOT_FOUND) return false;
    throw std::runtime_error("CredDeleteW failed: " + std::to_string(GetLastError()));
}
#else
std::optional<QString> nativeGet(const QString&, const QString&) { return std::nullopt; }
void nativeSet(const QString&, const QString&, const QString&) {}
bool nativeDelete(const QString&, const QString&) { return false; }
#endif

// ---- 旧存储 ----
constexpr int kSecurityTimeoutMs = 20'000;

#if !defined(Q_OS_WIN)
/// macOS 旧路径:security 命令(同步、有上限:旧凭证的访问控制对不上时会弹窗,没人点就一直挂)
std::optional<QString> securityGet(const QString& service, const QString& account) {
    QProcess p;
    p.start(u"security"_s, {u"find-generic-password"_s, u"-s"_s, service, u"-a"_s, account, u"-w"_s});
    if (!p.waitForStarted() || !p.waitForFinished(kSecurityTimeoutMs)) {
        if (p.state() != QProcess::NotRunning) {
            p.kill();
            p.waitForFinished(1000);
        }
        logLine(u"[keychain] security 命令没有按时返回(%1/%2),按读不到处理:spawnSync security ETIMEDOUT"_s.arg(service, account));
        return std::nullopt;
    }
    if (p.exitStatus() != QProcess::NormalExit || p.exitCode() != 0) return std::nullopt;
    const QString out = QString::fromUtf8(p.readAllStandardOutput()).trimmed();
    return out.isEmpty() ? std::nullopt : std::optional<QString>(out);
}

bool securityDelete(const QString& service, const QString& account) {
    QProcess p;
    p.start(u"security"_s, {u"delete-generic-password"_s, u"-s"_s, service, u"-a"_s, account});
    return p.waitForFinished(kSecurityTimeoutMs) && p.exitStatus() == QProcess::NormalExit && p.exitCode() == 0;
}

#endif

// 旧版 Windows 的 DPAPI 文件:只在迁移时用到。密文文件、键名(service\0account)、附加熵(dafri\0service\0account)与旧版完全相同
#if defined(Q_OS_WIN)
QString dpapiStorePath() {
    const QString base = qEnvironmentVariable("LOCALAPPDATA", QDir::home().filePath(u"AppData/Local"_s));
    return QDir(base).filePath(u"dafri/credentials.dpapi.json"_s);
}
QString dpapiKey(const QString& service, const QString& account) { return service + QChar(0) + account; }

QJsonObject dpapiLoad() {
    QFile f(dpapiStorePath());
    if (!f.exists()) return {};
    if (!f.open(QIODevice::ReadOnly)) throw KeychainError(u"旧凭证文件损坏或不可读:%1(打不开)"_s.arg(dpapiStorePath()));
    QJsonParseError err;
    const QJsonDocument doc = QJsonDocument::fromJson(f.readAll(), &err);
    if (err.error != QJsonParseError::NoError) throw KeychainError(u"旧凭证文件损坏或不可读:%1(%2)"_s.arg(dpapiStorePath(), err.errorString()));
    return doc.object();
}

void dpapiSave(const QJsonObject& entries) {
    QDir().mkpath(QFileInfo(dpapiStorePath()).absolutePath());
    QSaveFile f(dpapiStorePath());
    if (!f.open(QIODevice::WriteOnly)) throw KeychainError(u"写不进旧凭证文件:%1"_s.arg(dpapiStorePath()));
    f.write(QJsonDocument(entries).toJson(QJsonDocument::Indented));
    f.commit();
}

std::optional<QString> dpapiGet(const QString& service, const QString& account) {
    const QString blob = dpapiLoad().value(dpapiKey(service, account)).toString();
    if (blob.isEmpty()) return std::nullopt;
    QByteArray data = QByteArray::fromBase64(blob.toLatin1());
    QByteArray entropy = (u"dafri"_s + QChar(0) + service + QChar(0) + account).toUtf8();
    DATA_BLOB in{DWORD(data.size()), reinterpret_cast<BYTE*>(data.data())}, ent{DWORD(entropy.size()), reinterpret_cast<BYTE*>(entropy.data())}, out{};
    if (!CryptUnprotectData(&in, nullptr, &ent, nullptr, nullptr, 0, &out)) throw KeychainError(u"DPAPI 解密失败:%1"_s.arg(GetLastError()));
    const QString text = QString::fromUtf8(reinterpret_cast<const char*>(out.pbData), int(out.cbData));
    LocalFree(out.pbData);
    return text.isEmpty() ? std::nullopt : std::optional<QString>(text);
}

#endif

bool dropLegacy(const QString& service, const QString& account) {
#if defined(Q_OS_WIN)
    QJsonObject entries = dpapiLoad();
    const QString key = dpapiKey(service, account);
    if (!entries.contains(key)) return false;
    entries.remove(key);
    dpapiSave(entries);
    return true;
#else
    return securityDelete(service, account);
#endif
}

std::optional<QString> migrateLegacy(const QString& service, const QString& account) {
    std::optional<QString> legacy;
    try {
#if defined(Q_OS_WIN)
        legacy = dpapiGet(service, account);
#else
        legacy = securityGet(service, account);
#endif
    } catch (const std::exception& e) {
        logLine(u"[keychain] 旧凭证读取失败(%1/%2):%3"_s.arg(service, account, QString::fromUtf8(e.what())));
        return std::nullopt;
    }
    if (!legacy) return std::nullopt;
    try {
        nativeSet(service, account, *legacy);
        logLine(u"[keychain] 已把旧版凭证迁入系统凭证库(%1/%2)"_s.arg(service, account));
    } catch (const std::exception& e) {
        logLine(u"[keychain] 旧凭证迁移失败,本次仍用旧存储:%1"_s.arg(QString::fromUtf8(e.what())));
    }
    return legacy;
}

}  // namespace

bool keychainSupported() {
#if defined(Q_OS_MACOS) || defined(Q_OS_WIN)
    return true;
#else
    return false;
#endif
}

void requireKeychainSupported() {
    if (!keychainSupported())
        throw KeychainError(u"当前平台既不是 macOS 也不是 Windows,没有可用的系统凭证存储。任何情况下都不要退化为明文配置或环境变量。"_s);
}

std::optional<QString> getSecret(const QString& service, const QString& account) {
    requireKeychainSupported();
    std::optional<QString> secret;
    try {
        secret = nativeGet(service, account);
    } catch (const std::exception& e) {
        throw KeychainError(u"读取系统凭证失败(service=%1, account=%2):%3"_s.arg(service, account, QString::fromUtf8(e.what())));
    }
    if (secret && !secret->isEmpty()) return secret;
    return migrateLegacy(service, account);
}

bool hasSecret(const QString& service, const QString& account) {
    requireKeychainSupported();
    return getSecret(service, account).has_value();
}

void setSecret(const QString& service, const QString& account, const QString& secret) {
    requireKeychainSupported();
    if (secret.isEmpty()) throw KeychainError(u"拒绝写入空密钥"_s);
    try {
        nativeSet(service, account, secret);
    } catch (const std::exception& e) {
        throw KeychainError(u"写入系统凭证失败:%1"_s.arg(QString::fromUtf8(e.what())));
    }
}

bool deleteSecret(const QString& service, const QString& account) {
    requireKeychainSupported();
    bool removed = false;
    try {
        removed = nativeDelete(service, account);
    } catch (const std::exception& e) {
        throw KeychainError(u"删除系统凭证失败:%1"_s.arg(QString::fromUtf8(e.what())));
    }
    return dropLegacy(service, account) || removed;
}

QJsonObject runKeychainRequest(const QJsonValue& raw) {
    const QJsonObject req = raw.toObject();
    if (!req.value(u"service").isString() || !req.value(u"account").isString()) return {{u"ok"_s, false}, {u"error"_s, u"凭证请求缺 service / account"_s}};
    const QString service = req.value(u"service").toString(), account = req.value(u"account").toString();
    const QJsonValue op = req.value(u"op");
    try {
        if (op == u"get"_s) {
            const std::optional<QString> v = getSecret(service, account);
            return {{u"ok"_s, true}, {u"value"_s, v ? QJsonValue(*v) : QJsonValue(QJsonValue::Null)}, {u"exists"_s, v.has_value()}};
        }
        if (op == u"has"_s) return {{u"ok"_s, true}, {u"value"_s, QJsonValue::Null}, {u"exists"_s, hasSecret(service, account)}};
        if (op == u"set"_s) {
            const QJsonValue s = req.value(u"secret");
            setSecret(service, account, s.isUndefined() || s.isNull() ? QString() : s.isString() ? s.toString() : QString::fromUtf8(QJsonDocument(QJsonArray{s}).toJson(QJsonDocument::Compact)).mid(1).chopped(1));
            return {{u"ok"_s, true}, {u"value"_s, QJsonValue::Null}, {u"exists"_s, true}};
        }
        return {{u"ok"_s, false}, {u"error"_s, u"不认识的凭证操作:%1"_s.arg(op.isString() ? op.toString() : op.isUndefined() ? u"undefined"_s : u"null"_s)}};
    } catch (const JsError& e) {
        return {{u"ok"_s, false}, {u"error"_s, e.message()}};
    } catch (const std::exception& e) {
        return {{u"ok"_s, false}, {u"error"_s, QString::fromUtf8(e.what())}};
    }
}

}  // namespace ibkr::util
