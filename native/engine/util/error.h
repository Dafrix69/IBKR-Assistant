// TS 引擎里 `throw new Error("…")` 的对应物。引擎照搬 TS 的控制流:一个函数在 TS 里抛,这里也抛,话一个字不改;
// RPC 那一层接住,和 TS 的 server.ts 一样把 message 交给界面。只在引擎里用,不跨 Qt 的事件循环(槽函数里自己接住)。
#pragma once

#include <QString>

#include <stdexcept>

namespace ibkr::util {

class JsError : public std::runtime_error {
public:
    explicit JsError(const QString& message) : std::runtime_error(message.toStdString()), message_(message) {}
    const QString& message() const { return message_; }

private:
    QString message_;
};

/// 带 code 的错(Node 的 fs 错误 `err.code === "EACCES"`、better-sqlite3 的 SqliteError `code === "SQLITE_BUSY"`):
/// TS 里有几处按 code 分流(交易库打不开时的人话、唯一约束冲突),这边也按它分
class CodedError : public JsError {
public:
    CodedError(const QString& message, QString code) : JsError(message), code_(std::move(code)) {}
    const QString& code() const { return code_; }

private:
    QString code_;
};

}  // namespace ibkr::util
