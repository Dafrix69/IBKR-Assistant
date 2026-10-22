#include "util/discord_gateway.h"

#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"

#include <QHash>
#include <QRandomGenerator>
#include <QRegularExpression>
#include <QTimer>

#include <algorithm>
#include <cmath>
#include <limits>

namespace ibkr::util {

using namespace Qt::StringLiterals;

namespace {

constexpr double kMaxBackoffMs = 60'000;
/// Discord 纪元(2015-01-01T00:00:00Z):消息 ID 的高位是距它的毫秒数
constexpr double kDiscordEpochMs = 1420070400000.0;

/// 重试没用的关闭码 → 给人看的话
std::optional<QString> fatalClose(int code) {
    switch (code) {
    case 4004: return u"Discord 不认这个 bot token。到 Developer Portal 的 Bot 页重置 token,再回来重新保存。"_s;
    case 4010: return u"Discord 拒绝了连接(分片参数无效,4010)。"_s;
    case 4011: return u"这个 bot 加入的服务器太多,需要分片(4011),这里不支持。"_s;
    case 4012: return u"Discord 拒绝了连接(Gateway 版本无效,4012),需要更新软件。"_s;
    case 4013: return u"Discord 拒绝了连接(intent 无效,4013),需要更新软件。"_s;
    case 4014: return u"bot 没有开 Message Content Intent。到 Developer Portal → Bot → Privileged Gateway Intents 打开它,再回来重新保存 token。"_s;
    default: return std::nullopt;
    }
}
/// 这些关闭码之后会话作废,只能重新认证
bool sessionGone(int code) { return code == 1000 || code == 1001 || code == 4007 || code == 4009; }

/// str(v):不是字符串就是 ""
QString strOf(const OJson* v) { return js::isStr(v) ? v->s : QString(); }

QString platformName() {
#if defined(Q_OS_WIN)
    return u"win32"_s;
#elif defined(Q_OS_MACOS)
    return u"darwin"_s;
#elif defined(Q_OS_LINUX)
    return u"linux"_s;
#else
    return u"unknown"_s;
#endif
}

}  // namespace

QString phaseName(GatewayPhase p) {
    switch (p) {
    case GatewayPhase::Connecting: return u"connecting"_s;
    case GatewayPhase::Ready: return u"ready"_s;
    case GatewayPhase::Failed: return u"failed"_s;
    case GatewayPhase::Stopped: return u"stopped"_s;
    }
    return {};
}

// ---------------------------------------------------------------- QtScheduler
struct QtScheduler::Impl {
    quint64 next = 0;
    QHash<quint64, QTimer*> timers;
};
QtScheduler::QtScheduler() : d_(std::make_unique<Impl>()) {}
QtScheduler::~QtScheduler() {
    for (QTimer* t : std::as_const(d_->timers)) delete t;
}
Scheduler::TimerId QtScheduler::setTimeout(double delayMs, std::function<void()> fn) {
    const quint64 id = ++d_->next;
    auto* timer = new QTimer;
    timer->setSingleShot(true);
    QObject::connect(timer, &QTimer::timeout, timer, [this, id, fn = std::move(fn)] {
        QTimer* t = d_->timers.take(id);
        if (t) t->deleteLater();
        fn();
    });
    // Node 的 setTimeout:不是 ≥ 1 的数当 1 毫秒,取整
    const double ms = delayMs >= 1 ? std::min(delayMs, double(std::numeric_limits<int>::max())) : 1;
    timer->start(int(ms));
    d_->timers.insert(id, timer);
    return id;
}
void QtScheduler::clearTimeout(TimerId id) {
    if (QTimer* t = d_->timers.take(id)) {
        t->stop();
        t->deleteLater();
    }
}

// ---------------------------------------------------------------- 消息
std::optional<double> snowflakeMs(const QString& id) {
    static const QRegularExpression re(u"^[0-9]{15,21}\\z"_s);
    if (!re.match(id).hasMatch()) return std::nullopt;
    unsigned __int128 v = 0;
    for (const QChar c : id) v = v * 10 + unsigned(c.unicode() - u'0');
    return double(v >> 22) + kDiscordEpochMs;
}

std::optional<DiscordMessage> parseMessage(const OJson* d) {
    if (!js::isObj(d)) return std::nullopt;
    const OJson* type = d->get(u"type"_s);
    // d["type"] ?? 0;只认 0 与 19(数)
    if (!js::nullish(type) && !(js::isNum(type) && (type->n == 0 || type->n == 19))) return std::nullopt;
    const OJson* author = d->get(u"author"_s);
    if (!js::isObj(author)) return std::nullopt;
    const QString id = strOf(d->get(u"id"_s));
    const std::optional<double> sentAtMs = snowflakeMs(id);
    const QString channel = strOf(d->get(u"channel_id"_s));
    const QString authorId = strOf(author->get(u"id"_s));
    if (!sentAtMs || channel.isEmpty() || authorId.isEmpty()) return std::nullopt;
    DiscordMessage m;
    m.id = id;
    m.channel_id = channel;
    m.author_id = authorId;
    const QString global = strOf(author->get(u"global_name"_s));
    m.author_name = !global.isEmpty() ? global : strOf(author->get(u"username"_s));
    m.content = strOf(d->get(u"content"_s));
    m.sentAtMs = *sentAtMs;
    return m;
}

// ---------------------------------------------------------------- 网关
DiscordGateway::DiscordGateway(QString token, GatewayHooks hooks, GatewayOptions options)
    : token_(std::move(token)),
      hooks_(std::move(hooks)),
      url_(options.url.value_or(kGatewayUrl)),
      open_(std::move(options.open)),
      random_(std::move(options.random)),
      scheduler_(std::move(options.scheduler)),
      os_(options.os.value_or(platformName())) {
    if (!random_) random_ = [] { return QRandomGenerator::global()->generateDouble(); };
    if (!scheduler_) scheduler_ = std::make_shared<QtScheduler>();
}

DiscordGateway::~DiscordGateway() {
    clearTimers();
    if (socket_) {
        socket_->onmessage = nullptr;
        socket_->onclose = nullptr;
        try {
            socket_->close(1000);
        } catch (const std::exception&) {
        }
    }
}

void DiscordGateway::start() {
    if (!stopped_) return;
    stopped_ = false;
    connect();
}

void DiscordGateway::stop() {
    if (stopped_) return;
    stopped_ = true;
    clearTimers();
    std::shared_ptr<SocketLike> socket = std::move(socket_);
    socket_.reset();
    if (socket) {
        try {
            socket->close(1000);
        } catch (const std::exception&) {
            // 已经关了
        }
    }
    hooks_.onPhase(GatewayPhase::Stopped, std::nullopt);
}

// ---- 连接
void DiscordGateway::connect() {
    if (stopped_) return;
    hooks_.onPhase(GatewayPhase::Connecting, std::nullopt);
    const bool resuming = sessionId_.has_value() && resumeUrl_.has_value();
    std::shared_ptr<SocketLike> socket;
    try {
        QString target = url_;
        if (resuming) {
            QString base = *resumeUrl_;
            while (base.endsWith(u'/')) base.chop(1);
            target = base + u"/?v=10&encoding=json"_s;
        }
        socket = open_(target);
    } catch (const std::exception& exc) {
        scheduleRetry(u"连不上 Discord:%1"_s.arg(QString::fromStdString(exc.what())));
        return;
    }
    socket_ = socket;
    acked_ = true;
    // 只听当前这条 socket:被换下来的那条迟到的帧与关闭不作数
    SocketLike* raw = socket.get();
    socket->onmessage = [this, raw](const QString& data) {
        if (socket_.get() == raw) onFrame(data);
    };
    socket->onclose = [this, raw](int code) {
        if (socket_.get() == raw) onClose(code);
    };
}

/// 主动断开当前连接再连;keepSession = 留着会话去续连
void DiscordGateway::reconnect(bool keepSession, const QString& note) {
    std::shared_ptr<SocketLike> socket = std::move(socket_);
    socket_.reset();
    clearTimers();
    if (!keepSession) dropSession();
    if (socket) {
        try {
            // 4000:不是 1000 / 1001,Discord 那头会话还留着,续得上
            socket->close(keepSession ? 4000 : 1000);
        } catch (const std::exception&) {
            // 已经关了
        }
    }
    scheduleRetry(note);
}

void DiscordGateway::onClose(int code) {
    socket_.reset();
    clearTimers();
    if (stopped_) return;
    if (const auto fatal = fatalClose(code)) {
        stopped_ = true;
        dropSession();
        hooks_.onPhase(GatewayPhase::Failed, *fatal);
        return;
    }
    if (sessionGone(code)) dropSession();
    scheduleRetry(u"和 Discord 的连接断了(%1)"_s.arg(code));
}

void DiscordGateway::scheduleRetry(const QString& note) {
    if (stopped_) return;
    attempts_ += 1;
    // 第一次 1–2 秒(会话失效之后 Discord 要求至少等 1 秒再认证),之后翻倍,封顶一分钟
    const double base = jsmath::min(kMaxBackoffMs, 1000 * std::ldexp(1.0, int(jsmath::min(attempts_, 6))));
    const double delay = jsRound(base * (0.5 + random_() / 2));
    hooks_.onPhase(GatewayPhase::Connecting, u"%1,%2 秒后重连"_s.arg(note, jsNumberToString(jsmath::max(1, jsRound(delay / 1000)))));
    retry_ = scheduler_->setTimeout(delay, [this] {
        retry_.reset();
        connect();
    });
}

void DiscordGateway::dropSession() {
    sessionId_.reset();
    resumeUrl_.reset();
    seq_.reset();
}

void DiscordGateway::clearTimers() {
    if (heartbeat_) scheduler_->clearTimeout(*heartbeat_);
    if (retry_) scheduler_->clearTimeout(*retry_);
    heartbeat_.reset();
    retry_.reset();
}

// ---- 协议
void DiscordGateway::sendPayload(const OJson& payload) {
    if (!socket_) return;
    try {
        socket_->send(js::stringify(payload));
    } catch (const std::exception&) {
        // socket 正在关:close 事件会带着重连来
    }
}

void DiscordGateway::onFrame(const QString& data) {
    const std::optional<OJson> frame = parseOJson(data);
    if (!frame) return;
    if (!js::isObj(&*frame)) return;
    const OJson* op = frame->get(u"op"_s);
    const OJson* d = frame->get(u"d"_s);
    if (const OJson* s = frame->get(u"s"_s); js::isNum(s)) seq_ = s->n;
    const auto is = [&](double n) { return js::isNum(op) && op->n == n; };
    if (is(10)) return onHello(d);
    if (is(11)) {
        acked_ = true;
        return;
    }
    if (is(1)) return beat();
    if (is(7)) return reconnect(true, u"Discord 要求重连"_s);
    if (is(9)) return reconnect(js::isBool(d) && d->b, u"Discord 的会话失效了"_s);
    if (is(0)) onDispatch(strOf(frame->get(u"t"_s)), d);
}

void DiscordGateway::onHello(const OJson* d) {
    const OJson* hb = js::isObj(d) ? d->get(u"heartbeat_interval"_s) : nullptr;
    const double interval = js::isNum(hb) ? hb->n : 41'250;
    // 第一拍按协议要求随机错开,之后按间隔
    scheduleBeat(interval * random_(), interval);
    if (sessionId_) {
        sendPayload(js::object({{u"op"_s, js::N(6)},
                                {u"d"_s, js::object({{u"token"_s, js::S(token_)}, {u"session_id"_s, js::S(*sessionId_)}, {u"seq"_s, js::NOrNull(seq_)}})}}));
    } else {
        sendPayload(js::object({{u"op"_s, js::N(2)},
                                {u"d"_s, js::object({{u"token"_s, js::S(token_)},
                                                     {u"intents"_s, js::N(kGatewayIntents)},
                                                     {u"properties"_s, js::object({{u"os"_s, js::S(os_)},
                                                                                    {u"browser"_s, js::S(u"ibkr-assistant"_s)},
                                                                                    {u"device"_s, js::S(u"ibkr-assistant"_s)}})}})}}));
    }
}

void DiscordGateway::scheduleBeat(double delay, double interval) {
    heartbeat_ = scheduler_->setTimeout(delay, [this, interval] {
        if (!acked_) {
            reconnect(true, u"Discord 没有应答心跳"_s);
            return;
        }
        acked_ = false;
        beat();
        scheduleBeat(interval, interval);
    });
}

void DiscordGateway::beat() { sendPayload(js::object({{u"op"_s, js::N(1)}, {u"d"_s, js::NOrNull(seq_)}})); }

void DiscordGateway::onDispatch(const QString& type, const OJson* d) {
    if (type == u"READY" && js::isObj(d)) {
        const QString session = strOf(d->get(u"session_id"_s)), resume = strOf(d->get(u"resume_gateway_url"_s));
        sessionId_ = session.isEmpty() ? std::nullopt : std::optional<QString>(session);
        resumeUrl_ = resume.isEmpty() ? std::nullopt : std::optional<QString>(resume);
        const OJson* user = d->get(u"user"_s);
        const QString name = js::isObj(user) ? strOf(user->get(u"username"_s)) : QString();
        bot = name.isEmpty() ? std::nullopt : std::optional<QString>(name);
        channels.clear();
        guildsSeen = false;
        attempts_ = 0;
        hooks_.onPhase(GatewayPhase::Ready, std::nullopt);
        return;
    }
    if (type == u"RESUMED") {
        attempts_ = 0;
        hooks_.onPhase(GatewayPhase::Ready, std::nullopt);
        return;
    }
    if (type == u"GUILD_CREATE" && js::isObj(d)) {
        guildsSeen = true;
        for (const QString& key : {u"channels"_s, u"threads"_s}) {
            const OJson* list = d->get(key);
            if (!js::isArr(list)) continue;
            for (const OJson& item : list->items)
                if (js::isObj(&item) && !strOf(item.get(u"id"_s)).isEmpty()) channels.insert(strOf(item.get(u"id"_s)));
        }
        return;
    }
    if ((type == u"CHANNEL_CREATE" || type == u"THREAD_CREATE") && js::isObj(d) && !strOf(d->get(u"id"_s)).isEmpty()) {
        channels.insert(strOf(d->get(u"id"_s)));
        return;
    }
    if (type == u"MESSAGE_CREATE") {
        const auto message = parseMessage(d);
        if (message) hooks_.onMessage(*message);
    }
}

}  // namespace ibkr::util
