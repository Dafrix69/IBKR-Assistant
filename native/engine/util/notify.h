// 用户通知(engine-ts/src/notify.ts):先进历史与各个 sink(界面的通知流),再看要不要弹系统通知。
// 系统通知只在 macOS 上用 osascript 弹;别的平台写一行到 stderr(stdout 只跑 RPC)。os: false = 只进通知流(价位、异动提醒由桌面端的置顶小窗弹)。
#pragma once

#include <QString>

#include <functional>
#include <tuple>
#include <vector>

namespace ibkr::util {

class Notifier {
public:
    using Sink = std::function<void(const QString& title, const QString& subtitle, const QString& body)>;
    explicit Notifier(bool enabled = true, std::vector<Sink> extraSinks = {});

    bool enabled;
    std::vector<Sink> sinks;
    std::vector<std::tuple<QString, QString, QString>> history;  // (title, subtitle, body)
    /// 系统通知怎么弹(测试换掉;默认 macOS 的 osascript)
    std::function<void(const QString& script)> runOsascript;

    void notify(const QString& title, const QString& body, const QString& subtitle = {}, bool os = true);
    void rejection(const QString& code, const QString& message);
    void warning(const QString& message);
    void fill(const QString& symbol, const QString& action, double qty, double price, const QString& account);
    void breaker(const QString& reason);
};

/// AppleScript 字符串转义,防脚本注入
QString appleScriptQuote(const QString& text);

}  // namespace ibkr::util
