// 本地收件的读窗口程序(engine-ts/src/followReader.ts 逐句搬):填了频道名,引擎就把它拉起来(带 --supervised:标准输出一行一个 JSON 状态,
// 标准输入一断它就退)、看着它、退了隔一会儿再起。退出码 77 = 没有辅助功能权限:5 秒后再看;别的退出 1 秒起步、翻倍、封顶一分钟,读上过就从头算。
// 标准输出里状态行之外的东西一律不认、不记(消息原文不进引擎日志)。子进程与定时器都能换成假的(测试照着 TS 的同一段脚本走)。
#pragma once

#include <QByteArray>
#include <QObject>
#include <QProcessEnvironment>
#include <QString>
#include <QStringList>

#include <functional>
#include <memory>
#include <optional>

namespace ibkr::domain {

inline const QString kReaderEnv = QStringLiteral("DAFRI_INBOX_READER");
inline constexpr int kExitUntrusted = 77;
inline constexpr int kChannelNameMax = 100;

struct ReaderStatus {
    QString state;  // starting / reading / waiting / no_list / no_discord / untrusted / failed
    std::optional<QString> title;
    std::optional<QString> error;
    bool operator==(const ReaderStatus&) const = default;
};

/// 这台机器上读窗口程序在哪;不能自动启动回空
std::optional<QString> readerProgram(const QProcessEnvironment& env = QProcessEnvironment::systemEnvironment(), const QString& platform = {});
QStringList readerArgs(const QString& channel, const QString& out, bool askPermission);
/// 一行标准输出 → {state, title};不是状态行回空
std::optional<std::pair<QString, std::optional<QString>>> parseReaderLine(const QString& line);

/// 子进程里用得到的那几样(真的是 QProcess,测试塞假的)
class ReaderChild {
public:
    virtual ~ReaderChild() = default;
    std::function<void(const QByteArray&)> onStdout, onStderr;
    std::function<void(std::optional<int>)> onExit;
    std::function<void(const QString&)> onError;
    virtual void kill() = 0;
};

class FollowReader {
public:
    using Spawn = std::function<std::shared_ptr<ReaderChild>(const QString& program, const QStringList& args)>;  // 起不来就抛 util::JsError
    using Schedule = std::function<std::function<void()>(int ms, std::function<void()> fn)>;                        // setTimeout:返回 clearTimeout

    FollowReader(QString program, QString channel, QString out, std::function<void(const ReaderStatus&)> onStatus, Spawn spawn = {}, Schedule schedule = {});
    ~FollowReader();
    ReaderStatus view() const { return status_; }
    void start();
    void stop();
    const QString program, channel, out;

private:
    void launch();
    void gone(const ReaderChild* child, std::optional<int> code, const std::optional<QString>& error);
    void retryIn(int ms);
    void set(const ReaderStatus& next);

    std::function<void(const ReaderStatus&)> onStatus_;
    Spawn spawn_;
    Schedule schedule_;
    std::shared_ptr<ReaderChild> child_;
    std::shared_ptr<bool> alive_ = std::make_shared<bool>(true);
    std::function<void()> cancelTimer_;  // clearTimeout(this.timer)
    bool running_ = false;
    bool asked_ = false;
    int delayMs_ = 1000;
    ReaderStatus status_{QStringLiteral("starting"), std::nullopt, std::nullopt};
};

/// 真的子进程:QProcess,标准输入留一根管道不写(引擎一没管道就断,它读到头自己退)
std::shared_ptr<ReaderChild> spawnReaderProcess(const QString& program, const QStringList& args);

}  // namespace ibkr::domain
