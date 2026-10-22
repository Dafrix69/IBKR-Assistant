#include "util/discord_gateway_ws.h"

#include "util/error.h"

#include <QNetworkProxy>
#include <QTimer>
#include <QUrl>
#include <QWebSocket>

#include <memory>

namespace ibkr::util {

namespace {

std::function<void(const QUrl&)>& dialGuard() {
    static std::function<void(const QUrl&)> g;
    return g;
}

class WsSocket : public SocketLike, public std::enable_shared_from_this<WsSocket> {
public:
    static std::shared_ptr<WsSocket> create(const QString& url) {
        auto s = std::shared_ptr<WsSocket>(new WsSocket);
        s->start(url);
        return s;
    }

    void send(const QString& data) override { ws_.sendTextMessage(data); }

    void close(std::optional<int> code) override {
        keep_ = shared_from_this();
        ws_.close(QWebSocketProtocol::CloseCode(code.value_or(1000)));
        std::weak_ptr<WsSocket> weak = shared_from_this();
        QTimer::singleShot(3000, &ws_, [weak] {
            if (const auto self = weak.lock()) self->ws_.abort();
        });
    }

private:
    WsSocket() { ws_.setProxy(QNetworkProxy::NoProxy); }

    void start(const QString& url) {
        QObject::connect(&ws_, &QWebSocket::textMessageReceived, &ws_, [this](const QString& message) {
            const auto self = shared_from_this();
            const auto cb = onmessage;
            if (cb) cb(message);
        });
        QObject::connect(&ws_, &QWebSocket::connected, &ws_, [this] { opened_ = true; });
        QObject::connect(&ws_, &QWebSocket::errorOccurred, &ws_, [this](QAbstractSocket::SocketError) { abnormal_ = true; });
        QObject::connect(&ws_, &QWebSocket::disconnected, &ws_, [this] {
            const auto self = shared_from_this();
            // 没有走完关闭握手就断了(连不上、对方直接掐了 TCP):Node 的 ws 给 1006
            const int code = abnormal_ || !opened_ ? 1006 : int(ws_.closeCode());
            const auto cb = onclose;
            if (cb) cb(code);
            // 出了这个信号再释放(此刻网关可能已经放手了)
            const auto drop = std::move(keep_);
            QTimer::singleShot(0, [self, drop] {});
        });
        // 出错之后一定跟着 disconnected(码是 1006),重连在那里做
        if (dialGuard()) dialGuard()(QUrl(url));
        ws_.open(QUrl(url));
    }

    QWebSocket ws_;
    std::shared_ptr<WsSocket> keep_;
    bool abnormal_ = false, opened_ = false;
};

}  // namespace

bool discordHostsOnly(const QString& host) {
    const QString h = host.toLower();
    return h == u"discord.gg" || h.endsWith(u".discord.gg");
}

void setWebSocketDialGuard(std::function<void(const QUrl& url)> guard) { dialGuard() = std::move(guard); }

std::function<std::shared_ptr<SocketLike>(const QString& url)> webSocketOpener(AllowHost allowHost) {
    return [allowHost = std::move(allowHost)](const QString& url) -> std::shared_ptr<SocketLike> {
        const QUrl u(url);
        if (!allowHost(u.host())) throw JsError(QStringLiteral("不在许可名单里的主机,不连:") + u.host());
        return WsSocket::create(url);
    };
}

}  // namespace ibkr::util
