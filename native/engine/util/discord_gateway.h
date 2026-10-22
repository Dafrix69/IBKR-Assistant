// discordGateway.ts:Discord Gateway 的最小客户端(docs/features/follow.md)——连上、保持住、把频道里的新消息递出来。只读,不往 Discord 发任何消息。
// 用的是官方的 bot 通道:bot token、Gateway v10、JSON 编码、不压缩;不用任何人的用户 token(那是自动化用户账号,条款禁止,会封号)。
//
// 断线之后的两种接法:手里有会话(session_id + resume_gateway_url)就续连(RESUME),Discord 会把断开期间漏掉的事件补发过来;
// 没有就重新认证(IDENTIFY)。重试没有意义的错(token 不对、没开 Message Content Intent)停下来报给上面,不反复去撞。
//
// 与 TS 的对应与差别:
//   · 核心只依赖 Qt Core。socket 与计时器都是递进来的(TS 里是 options.open 与全局 setTimeout):测试递假的,真的 QWebSocket 在
//     util/discord_gateway_ws(单独一个库,链 Qt6::WebSockets);`open` 必填——TS 缺省用的全局 WebSocket 在 C++ 里没有对应物;
//   · 计时器缺省是 QTimer(QtScheduler):延迟取整、至少 1 毫秒(Node 的 setTimeout 也是这样);必须在网关所在的线程里建、用;
//   · IDENTIFY 里的 os 是 process.platform:macOS "darwin"、Windows "win32"、Linux "linux"(可由 options.os 指定);
//   · snowflake 最多 21 位(超过 2^64):用 128 位整数算,结果在 2^53 之内,和 Number(BigInt) 一样精确;
//   · TS 的 try/catch 只接 std::exception(open / send 抛的)。
#pragma once

#include "util/ordered_json.h"

#include <QSet>
#include <QString>

#include <functional>
#include <memory>
#include <optional>

namespace ibkr::util {

inline const QString kGatewayUrl = QStringLiteral("wss://gateway.discord.gg/?v=10&encoding=json");
/// GUILDS(知道 bot 在哪些服务器、有哪些频道)| GUILD_MESSAGES | MESSAGE_CONTENT(特权 intent:要在 Developer Portal 里手动打开)
inline constexpr int kGatewayIntents = (1 << 0) | (1 << 9) | (1 << 15);

struct DiscordMessage {
    QString id, channel_id, author_id, author_name, content;
    /// Discord 给这条消息盖的时刻(从消息 ID 里解出来,不是本机收到的时刻),毫秒
    double sentAtMs = 0;
    bool operator==(const DiscordMessage&) const = default;
};

/// connecting = 正在连 / 等着重连;ready = 已认证;failed = 重试没用,停了;stopped = 被 stop() 停掉
enum class GatewayPhase { Connecting, Ready, Failed, Stopped };
QString phaseName(GatewayPhase p);

struct GatewayHooks {
    std::function<void(const DiscordMessage&)> onMessage;
    std::function<void(GatewayPhase, const std::optional<QString>&)> onPhase;
};

/// 这个客户端用到的 socket 那一面。onmessage / onclose 由网关在拿到 socket 之后设;close(空) = 不给码
class SocketLike {
public:
    virtual ~SocketLike() = default;
    std::function<void(const QString&)> onmessage;
    std::function<void(int)> onclose;
    virtual void send(const QString& data) = 0;
    virtual void close(std::optional<int> code = std::nullopt) = 0;
};

/// setTimeout / clearTimeout
class Scheduler {
public:
    using TimerId = quint64;
    virtual ~Scheduler() = default;
    virtual TimerId setTimeout(double delayMs, std::function<void()> fn) = 0;
    virtual void clearTimeout(TimerId id) = 0;
};

/// 缺省的计时器:QTimer 单发
class QtScheduler : public Scheduler {
public:
    QtScheduler();
    ~QtScheduler() override;
    TimerId setTimeout(double delayMs, std::function<void()> fn) override;
    void clearTimeout(TimerId id) override;

private:
    struct Impl;
    std::unique_ptr<Impl> d_;
};

struct GatewayOptions {
    std::optional<QString> url;
    /// 开一条 socket(必填)
    std::function<std::shared_ptr<SocketLike>(const QString& url)> open;
    /// [0, 1) 的随机数(心跳抖动、重连抖动;缺省 QRandomGenerator)
    std::function<double()> random;
    std::shared_ptr<Scheduler> scheduler;
    std::optional<QString> os;
};

/// 消息 ID(snowflake)里的时刻;不是合法 ID 回空
std::optional<double> snowflakeMs(const QString& id);
/// MESSAGE_CREATE 的 d → 一条消息。只认普通消息(type 0)与回复(type 19);系统消息、形状不对的回空
std::optional<DiscordMessage> parseMessage(const OJson* d);

class DiscordGateway {
public:
    DiscordGateway(QString token, GatewayHooks hooks, GatewayOptions options);
    ~DiscordGateway();
    DiscordGateway(const DiscordGateway&) = delete;
    DiscordGateway& operator=(const DiscordGateway&) = delete;

    void start();
    void stop();

    /// bot 的名字(认证之后才有)
    std::optional<QString> bot;
    /// bot 所在服务器里的全部频道 ID(连上后由 GUILD_CREATE 给)
    QSet<QString> channels;
    /// 至少收到过一个服务器的频道表
    bool guildsSeen = false;

private:
    void connect();
    void reconnect(bool keepSession, const QString& note);
    void onClose(int code);
    void scheduleRetry(const QString& note);
    void dropSession();
    void clearTimers();
    void sendPayload(const OJson& payload);
    void onFrame(const QString& data);
    void onHello(const OJson* d);
    void scheduleBeat(double delay, double interval);
    void beat();
    void onDispatch(const QString& type, const OJson* d);

    QString token_;
    GatewayHooks hooks_;
    QString url_;
    std::function<std::shared_ptr<SocketLike>(const QString&)> open_;
    std::function<double()> random_;
    std::shared_ptr<Scheduler> scheduler_;
    QString os_;
    std::shared_ptr<SocketLike> socket_;
    std::optional<double> seq_;
    std::optional<QString> sessionId_, resumeUrl_;
    std::optional<Scheduler::TimerId> heartbeat_, retry_;
    /// 上一次心跳有没有被应答:没应答就是僵尸连接,断开重连
    bool acked_ = true;
    double attempts_ = 0;
    bool stopped_ = true;
};

}  // namespace ibkr::util
