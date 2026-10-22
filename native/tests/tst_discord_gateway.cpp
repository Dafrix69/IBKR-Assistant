// engine/util/discord_gateway(discordGateway.ts)对着原模块现跑的答案(fixtures/gen_discord_gateway.mjs → discord-gateway.json):
//   · 61 个场景 × 一串动作(开 / 停 / 对方发来一帧 / 连接断了 / 拨时间 / open 抛错),每一步比"网关做了什么"与对外可见的状态;
//     socket 是假的、计时器是手拨的假时钟(和 TS 那一边同一套逻辑),随机数是给定的一串;
//   · snowflakeMs / parseMessage 的边角。
// 另有回环上的一条真 WebSocket(QWebSocketServer 在 127.0.0.1 演一个假网关:HELLO → IDENTIFY → READY → 消息 → 心跳 → 7 号重连 → RESUME → 关闭码):
//   证明真的 QWebSocket 那一面(util/discord_gateway_ws)接得上同一个核心。**绝不连 discord.com**:开 socket 的函数先核对主机是回环,不是就拒。
#include "js_fixture.h"
#include "util/discord_gateway.h"

#include <QElapsedTimer>
#include <QEventLoop>
#include <QTimer>
#include <QRegularExpression>
#include <QTcpServer>
#include <QTest>
#include <QUrl>

#ifdef IBKR_HAVE_DISCORD_WS
#include "util/discord_gateway_ws.h"

#include <QHostAddress>
#include <QWebSocket>
#include <QWebSocketServer>
#endif

#include <map>

using namespace Qt::StringLiterals;
using namespace ibkr::util;

namespace {

/// 手拨的时间线(和生成器里的那条同一个排法:先按到点的时刻、再按建的先后)
class FakeClock : public Scheduler {
public:
    TimerId setTimeout(double ms, std::function<void()> fn) override {
        const TimerId id = ++seq_;
        timers_[id] = {now_ + ms, id, std::move(fn), true};
        return id;
    }
    void clearTimeout(TimerId id) override {
        const auto it = timers_.find(id);
        if (it != timers_.end()) it->second.active = false;
    }
    void advance(double ms) {
        const double end = now_ + ms;
        for (;;) {
            T* due = nullptr;
            for (auto& [id, t] : timers_) {
                (void)id;
                if (!t.active) continue;
                if (!due || t.at < due->at || (t.at == due->at && t.seq < due->seq)) due = &t;
            }
            if (!due || due->at > end) break;
            due->active = false;
            now_ = std::max(now_, due->at);
            const auto fn = due->fn;
            fn();
        }
        now_ = end;
    }

private:
    struct T {
        double at = 0;
        TimerId seq = 0;
        std::function<void()> fn;
        bool active = false;
    };
    double now_ = 0;
    TimerId seq_ = 0;
    std::map<TimerId, T> timers_;
};

struct FakeSocket : SocketLike {
    FakeSocket(int index, std::vector<OJson>* log) : i(index), log_(log) {}
    int i;
    std::vector<OJson>* log_;
    void send(const QString& data) override { log_->push_back(js::object({{u"e"_s, js::S(u"send"_s)}, {u"i"_s, js::N(i)}, {u"data"_s, js::S(data)}})); }
    void close(std::optional<int> code) override {
        log_->push_back(js::object({{u"e"_s, js::S(u"close"_s)}, {u"i"_s, js::N(i)}, {u"code"_s, code ? js::N(*code) : OJson::null()}}));
    }
};

OJson messageJson(const DiscordMessage& m) {
    return js::object({{u"id"_s, js::S(m.id)},
                       {u"channel_id"_s, js::S(m.channel_id)},
                       {u"author_id"_s, js::S(m.author_id)},
                       {u"author_name"_s, js::S(m.author_name)},
                       {u"content"_s, js::S(m.content)},
                       {u"sentAtMs"_s, js::N(m.sentAtMs)}});
}

}  // namespace

#ifdef IBKR_HAVE_DISCORD_WS
namespace {
/// 一个假 Discord 网关:每个连上来的客户端先收 HELLO,IDENTIFY / RESUME 之后给 READY 与一条消息,心跳回应答
struct FakeServer {
    QWebSocketServer server{u"fake-discord"_s, QWebSocketServer::NonSecureMode};
    QList<QWebSocket*> clients;
    QStringList received;  // 客户端发来的每一行
    int heartbeats = 0;
    int identifies = 0, resumes = 0;
    QList<int> closeCodes;  // 客户端关闭时的码
    bool sendMessage = true;
    ~FakeServer() {
        // 析构服务器会把还连着的客户端连接一并拆掉,拆的时候触发的 disconnected 不许再碰已经没了的成员
        QObject::disconnect(&server, nullptr, nullptr, nullptr);
        for (QWebSocket* c : std::as_const(clients)) QObject::disconnect(c, nullptr, nullptr, nullptr);
    }
    FakeServer() {
        QVERIFY(server.listen(QHostAddress::LocalHost, 0));
        QObject::connect(&server, &QWebSocketServer::newConnection, &server, [this] {
            QWebSocket* c = server.nextPendingConnection();
            clients << c;
            QObject::connect(c, &QWebSocket::textMessageReceived, c, [this, c](const QString& text) { onText(c, text); });
            QObject::connect(c, &QWebSocket::disconnected, c, [this, c] { closeCodes << int(c->closeCode()); });
            c->sendTextMessage(u"{\"op\":10,\"d\":{\"heartbeat_interval\":150}}"_s);
        });
    }
    QString url() const { return u"ws://127.0.0.1:%1/"_s.arg(server.serverPort()); }
    void onText(QWebSocket* c, const QString& text) {
        received << text;
        const auto frame = parseOJson(text);
        if (!frame) return;
        const double op = frame->get(u"op"_s)->n;
        if (op == 1) {
            ++heartbeats;
            c->sendTextMessage(u"{\"op\":11}"_s);
        } else if (op == 2) {
            ++identifies;
            c->sendTextMessage(u"{\"op\":0,\"t\":\"READY\",\"s\":1,\"d\":{\"session_id\":\"s-1\",\"resume_gateway_url\":\"%1\",\"user\":{\"username\":\"follow-bot\"}}}"_s.arg(url()));
            c->sendTextMessage(u"{\"op\":0,\"t\":\"GUILD_CREATE\",\"s\":2,\"d\":{\"channels\":[{\"id\":\"1100000000000000001\"}]}}"_s);
            if (sendMessage)
                c->sendTextMessage(u"{\"op\":0,\"t\":\"MESSAGE_CREATE\",\"s\":3,\"d\":{\"id\":\"1537831159726080007\",\"channel_id\":\"1100000000000000001\",\"type\":0,\"content\":\"hi\",\"author\":{\"id\":\"2\",\"username\":\"u\",\"global_name\":\"老王\"}}}"_s);
        } else if (op == 6) {
            ++resumes;
            c->sendTextMessage(u"{\"op\":0,\"t\":\"RESUMED\",\"s\":4,\"d\":{}}"_s);
        }
    }
};

struct Probe {
    QList<DiscordMessage> messages;
    QList<std::pair<GatewayPhase, std::optional<QString>>> phases;
    bool refused = false;
    GatewayHooks hooks() {
        GatewayHooks h;
        h.onMessage = [this](const DiscordMessage& m) { messages << m; };
        h.onPhase = [this](GatewayPhase p, const std::optional<QString>& e) { phases.append({p, e}); };
        return h;
    }
    /// 真 socket 的开法,但只许回环:许可名单是只认回环的那个谓词,连别的主机当场拒(测试永远不碰 discord.com)
    std::function<std::shared_ptr<SocketLike>(const QString&)> loopbackOnly() {
        return webSocketOpener([this](const QString& host) {
            const bool ok = QHostAddress(host).isLoopback();
            if (!ok) refused = true;
            return ok;
        });
    }
};

/// 兜底:任何一次真的拨号之前先过这里;不是回环就 qFatal(测试进程当场死,到不了任何真主机)
void installFatalDialGuard() {
    setWebSocketDialGuard([](const QUrl& url) {
        if (!QHostAddress(url.host()).isLoopback()) qFatal("测试要拨非回环的主机 %s:拒绝", qPrintable(url.host()));
    });
}

bool waitFor(const std::function<bool()>& cond, int ms = 6000) { return QTest::qWaitFor(cond, ms); }

}  // namespace
#endif

class TestDiscordGateway : public QObject {
    Q_OBJECT
    OJson fx_;

private slots:
    void initTestCase() {
        fx_ = jsfix::load(u"discord-gateway.json"_s);
#ifdef IBKR_HAVE_DISCORD_WS
        installFatalDialGuard();
#endif
    }

    void constants() {
        QCOMPARE(double(kGatewayIntents), fx_.get(u"intents"_s)->n);
        QCOMPARE(kGatewayUrl, fx_.get(u"url"_s)->s);
        QCOMPARE(kGatewayIntents, 1 + 512 + 32768);
    }

    void snowflakes() {
        for (const OJson& c : fx_.get(u"snowflake"_s)->items) {
            const QString id = c.get(u"id"_s)->s;
            JSFIX_SAME(*c.get(u"out"_s), js::NOrNull(snowflakeMs(id)), u"snowflakeMs "_s + id);
        }
    }

    void parseMessages() {
        for (const OJson& c : fx_.get(u"parse"_s)->items) {
            const OJson d = jsfix::dec(*c.get(u"d"_s));
            const bool undef = d.type == OJson::String && d.s == u"__undefined__";
            const auto m = parseMessage(undef ? nullptr : &d);
            JSFIX_SAME(*c.get(u"out"_s), m ? messageJson(*m) : OJson::null(), u"parseMessage "_s + js::stringify(*c.get(u"d"_s)).left(100));
        }
    }

    void scriptedScenarios() {
        for (const OJson& sc : fx_.get(u"scenarios"_s)->items) {
            const QString name = sc.get(u"name"_s)->s;
            std::vector<double> random;
            for (const OJson& r : sc.get(u"random"_s)->items) random.push_back(r.n);
            std::vector<OJson> cur;
            std::vector<std::shared_ptr<FakeSocket>> sockets;
            std::optional<QString> openThrows;
            size_t ri = 0;
            const auto clock = std::make_shared<FakeClock>();
            GatewayHooks hooks;
            hooks.onMessage = [&](const DiscordMessage& m) { cur.push_back(js::object({{u"e"_s, js::S(u"message"_s)}, {u"m"_s, messageJson(m)}})); };
            hooks.onPhase = [&](GatewayPhase p, const std::optional<QString>& err) {
                cur.push_back(js::object({{u"e"_s, js::S(u"phase"_s)}, {u"p"_s, js::S(phaseName(p))}, {u"err"_s, err ? js::S(*err) : OJson::null()}}));
            };
            GatewayOptions options;
            if (const OJson* url = sc.get(u"url"_s)) options.url = url->s;
            options.os = u"darwin"_s;
            options.scheduler = clock;
            options.random = [&] { return random[ri++ % random.size()]; };
            options.open = [&](const QString& url) -> std::shared_ptr<SocketLike> {
                if (openThrows) {
                    const QString m = *openThrows;
                    openThrows.reset();
                    cur.push_back(js::object({{u"e"_s, js::S(u"open-throws"_s)}, {u"url"_s, js::S(url)}}));
                    throw JsError(m);
                }
                auto s = std::make_shared<FakeSocket>(int(sockets.size()), &cur);
                sockets.push_back(s);
                cur.push_back(js::object({{u"e"_s, js::S(u"open"_s)}, {u"i"_s, js::N(s->i)}, {u"url"_s, js::S(url)}}));
                return s;
            };
            DiscordGateway gw(u"bot.token.value"_s, hooks, options);
            const OJson& steps = *sc.get(u"steps"_s);
            const OJson& expected = *sc.get(u"expected"_s);
            QVERIFY(steps.items.size() == expected.items.size());
            for (qsizetype n = 0; n < steps.items.size(); ++n) {
                const OJson& step = steps.items[n];
                cur.clear();
                const QString what = step.get(u"do"_s)->s;
                const auto sock = [&]() -> FakeSocket* {
                    const OJson* i = step.get(u"i"_s);
                    const size_t idx = i ? size_t(i->n) : sockets.empty() ? 0 : sockets.size() - 1;
                    return idx < sockets.size() ? sockets[idx].get() : nullptr;
                };
                if (what == u"start") gw.start();
                else if (what == u"stop") gw.stop();
                else if (what == u"raw") {
                    if (FakeSocket* s = sock(); s && s->onmessage) s->onmessage(step.get(u"text"_s)->s);
                } else if (what == u"drop") {
                    if (FakeSocket* s = sock(); s && s->onclose) s->onclose(int(step.get(u"code"_s)->n));
                } else if (what == u"advance") clock->advance(step.get(u"ms"_s)->n);
                else if (what == u"openThrows") openThrows = step.get(u"message"_s)->s;
                else QFAIL(qPrintable(u"没见过的动作 "_s + what));
                QStringList channels(gw.channels.begin(), gw.channels.end());
                std::sort(channels.begin(), channels.end());
                OJson events = js::array();
                for (const OJson& e : cur) events.items.append(e);
                const OJson got = js::object({{u"events"_s, events},
                                              {u"state"_s, js::object({{u"bot"_s, gw.bot ? js::S(*gw.bot) : OJson::null()},
                                                                       {u"guildsSeen"_s, js::B(gw.guildsSeen)},
                                                                       {u"channels"_s, js::strings(channels)}})}});
                JSFIX_SAME(expected.items[n], got, u"场景「"_s + name + u"」第 "_s + QString::number(n + 1) + u" 步 "_s + what);
            }
        }
    }


    /// 不给 os / random / scheduler 的缺省:IDENTIFY 里的 os 是平台名;重连的等待落在 [一半, 全部] 里;QtScheduler 真的会到点
    void defaultsAreSane() {
        std::vector<OJson> cur;
        std::vector<std::shared_ptr<FakeSocket>> sockets;
        QStringList phases;
        GatewayHooks hooks;
        hooks.onMessage = [](const DiscordMessage&) {};
        hooks.onPhase = [&](GatewayPhase, const std::optional<QString>& e) { phases << e.value_or(QString()); };
        GatewayOptions options;
        options.open = [&](const QString&) -> std::shared_ptr<SocketLike> {
            sockets.push_back(std::make_shared<FakeSocket>(int(sockets.size()), &cur));
            return sockets.back();
        };
        DiscordGateway gw(u"t"_s, hooks, options);
        gw.start();
        sockets[0]->onmessage(u"{\"op\":10,\"d\":{\"heartbeat_interval\":600000}}"_s);
        const auto sent = parseOJson(cur.back().get(u"data"_s)->s);
        QVERIFY(sent);
#if defined(Q_OS_MACOS)
        QCOMPARE(js::path(&*sent, {u"d"_s, u"properties"_s, u"os"_s})->s, u"darwin"_s);
#elif defined(Q_OS_WIN)
        QCOMPARE(js::path(&*sent, {u"d"_s, u"properties"_s, u"os"_s})->s, u"win32"_s);
#else
        QCOMPARE(js::path(&*sent, {u"d"_s, u"properties"_s, u"os"_s})->s, u"linux"_s);
#endif
        sockets[0]->onclose(1006);
        QVERIFY(phases.last().contains(u"和 Discord 的连接断了(1006),"_s));
        QRegularExpression re(u"(1|2) 秒后重连$"_s);
        QVERIFY2(re.match(phases.last()).hasMatch(), qPrintable(phases.last()));
        // 真计时器:1–2 秒后重连(开出第二条 socket)
        QVERIFY(QTest::qWaitFor([&] { return sockets.size() == 2; }, 4000));
        gw.stop();
    }

    /// 单发:回调里把事件循环再转 50 毫秒(这一层的延迟删除不会处理),1 毫秒的计时器若不是单发会被连着触发
    void qtSchedulerTimerFiresExactlyOnce() {
        QtScheduler sched;
        int fired = 0, cancelledFired = 0;
        sched.setTimeout(1, [&] {
            ++fired;
            QEventLoop spin;  // QTest::qWait 会顺手处理延迟删除,这里要的是不处理的嵌套循环
            QTimer::singleShot(50, &spin, &QEventLoop::quit);
            spin.exec();
        });
        const auto id = sched.setTimeout(400, [&] { ++cancelledFired; });
        QVERIFY(QTest::qWaitFor([&] { return fired >= 1; }, 2000));
        sched.clearTimeout(id);
        QTest::qWait(500);
        QCOMPARE(fired, 1);
        QCOMPARE(cancelledFired, 0);
    }

    void qtSchedulerFiresInOrderAndClears() {
        QtScheduler sched;
        QStringList fired;
        sched.setTimeout(30, [&] { fired << u"b"_s; });
        sched.setTimeout(0.2, [&] { fired << u"a"_s; });  // 不到 1 毫秒的按 1 毫秒
        const auto cancelled = sched.setTimeout(10, [&] { fired << u"x"_s; });
        sched.clearTimeout(cancelled);
        sched.clearTimeout(987654);  // 没有的 id:无事
        QVERIFY(QTest::qWaitFor([&] { return fired.size() == 2; }, 2000));
        QTest::qWait(60);
        QCOMPARE(fired, (QStringList{u"a"_s, u"b"_s}));
        sched.setTimeout(1e18, [&] { fired << u"never"_s; });  // 超大的延迟不溢出,也不会触发
        QTest::qWait(20);
        QCOMPARE(fired.size(), 2);
    }

    /// 网关析构时不再碰回调:假 socket 在网关之后还活着,迟到的帧不会打到已经没了的对象上
    void destructionDetachesCallbacks() {
        std::vector<OJson> cur;
        std::shared_ptr<FakeSocket> sock;
        {
            GatewayHooks hooks;
            hooks.onMessage = [](const DiscordMessage&) {};
            hooks.onPhase = [](GatewayPhase, const std::optional<QString>&) {};
            GatewayOptions options;
            options.scheduler = std::make_shared<FakeClock>();
            options.random = [] { return 0.5; };
            options.open = [&](const QString&) -> std::shared_ptr<SocketLike> {
                sock = std::make_shared<FakeSocket>(0, &cur);
                return sock;
            };
            DiscordGateway gw(u"t"_s, hooks, options);
            gw.start();
            QVERIFY(sock && sock->onmessage && sock->onclose);
        }
        QVERIFY(!sock->onmessage && !sock->onclose);
        QCOMPARE(cur.size(), size_t(1));  // 析构时关了一次(1000)
        QCOMPARE(cur[0].get(u"code"_s)->n, 1000.0);
    }

#ifdef IBKR_HAVE_DISCORD_WS
    // ------------------------------------------------------------ 回环上的真 WebSocket
    void realWebSocketHandshakeHeartbeatAndMessage() {
        FakeServer srv;
        Probe probe;
        GatewayOptions options;
        options.url = srv.url();
        options.open = probe.loopbackOnly();
        options.random = [] { return 0.0; };
        options.os = u"darwin"_s;
        DiscordGateway gw(u"bot.token.value"_s, probe.hooks(), options);
        gw.start();
        QVERIFY(waitFor([&] { return probe.messages.size() == 1 && srv.heartbeats >= 2; }));
        QVERIFY(!probe.refused);
        QCOMPARE(srv.identifies, 1);
        QCOMPARE(srv.resumes, 0);
        // 第一行是 IDENTIFY,逐字
        QCOMPARE(srv.received.value(0),
                 u"{\"op\":2,\"d\":{\"token\":\"bot.token.value\",\"intents\":33281,\"properties\":{\"os\":\"darwin\",\"browser\":\"ibkr-assistant\",\"device\":\"ibkr-assistant\"}}}"_s);
        QCOMPARE(probe.messages[0].content, u"hi"_s);
        QCOMPARE(probe.messages[0].author_name, u"老王"_s);
        QCOMPARE(probe.messages[0].sentAtMs, 1786717920000.0);
        QCOMPARE(probe.phases.first().first, GatewayPhase::Connecting);
        QVERIFY(waitFor([&] { return probe.phases.size() >= 2; }));
        QCOMPARE(probe.phases[1].first, GatewayPhase::Ready);
        QCOMPARE(gw.bot.value_or(QString()), u"follow-bot"_s);
        QVERIFY(gw.guildsSeen);
        QVERIFY(gw.channels.contains(u"1100000000000000001"_s));
        // 心跳带着最近的序号(READY 1、GUILD_CREATE 2、消息 3)
        QVERIFY(waitFor([&] { return srv.received.contains(u"{\"op\":1,\"d\":3}"_s); }));
        // 停下来:对方收到的是正常关闭(1000),阶段变成 stopped
        gw.stop();
        QCOMPARE(probe.phases.last().first, GatewayPhase::Stopped);
        QVERIFY(waitFor([&] { return !srv.closeCodes.isEmpty(); }));
        QCOMPARE(srv.closeCodes.first(), 1000);
    }

    void realWebSocketServerAsksToReconnectThenResumes() {
        FakeServer srv;
        Probe probe;
        GatewayOptions options;
        options.url = srv.url();
        options.open = probe.loopbackOnly();
        options.random = [] { return 0.0; };
        DiscordGateway gw(u"bot.token.value"_s, probe.hooks(), options);
        gw.start();
        QVERIFY(waitFor([&] { return probe.messages.size() == 1; }));
        srv.sendMessage = false;
        srv.clients.first()->sendTextMessage(u"{\"op\":7}"_s);
        // 关闭码 4000(会话留着):重连之后发的是 RESUME,带着会话与序号
        QVERIFY(waitFor([&] { return srv.resumes == 1; }, 8000));
        QVERIFY(!probe.refused);
        QVERIFY(srv.closeCodes.contains(4000));
        QVERIFY(srv.received.contains(u"{\"op\":6,\"d\":{\"token\":\"bot.token.value\",\"session_id\":\"s-1\",\"seq\":3}}"_s));
        QVERIFY(waitFor([&] { return probe.phases.last().first == GatewayPhase::Ready; }));
        QCOMPARE(srv.identifies, 1);
        gw.stop();
    }

    void realWebSocketFatalCloseCodeStops() {
        FakeServer srv;
        Probe probe;
        GatewayOptions options;
        options.url = srv.url();
        options.open = probe.loopbackOnly();
        options.random = [] { return 0.0; };
        DiscordGateway gw(u"bot.token.value"_s, probe.hooks(), options);
        gw.start();
        QVERIFY(waitFor([&] { return !srv.clients.isEmpty() && srv.identifies == 1; }));
        srv.clients.first()->close(QWebSocketProtocol::CloseCode(4004));
        QVERIFY(waitFor([&] { return probe.phases.last().first == GatewayPhase::Failed; }));
        QVERIFY(probe.phases.last().second.value_or(QString()).contains(u"bot token"_s));
        // 停了就停了:不再重连
        QTest::qWait(1500);
        QCOMPARE(srv.identifies, 1);
        QCOMPARE(srv.clients.size(), 1);
    }

    void realWebSocketAbruptDropIsAbnormalClosure() {
        FakeServer srv;
        Probe probe;
        GatewayOptions options;
        options.url = srv.url();
        options.open = probe.loopbackOnly();
        options.random = [] { return 0.0; };
        DiscordGateway gw(u"bot.token.value"_s, probe.hooks(), options);
        gw.start();
        QVERIFY(waitFor([&] { return probe.phases.size() >= 2 && probe.phases[1].first == GatewayPhase::Ready; }));
        srv.clients.first()->abort();  // 不发关闭帧,直接掐 TCP
        QVERIFY(waitFor([&] { return probe.phases.size() >= 3; }));
        QCOMPARE(probe.phases[2].first, GatewayPhase::Connecting);
        QCOMPARE(probe.phases[2].second.value_or(QString()), u"和 Discord 的连接断了(1006),1 秒后重连"_s);
        gw.stop();
    }

    void realWebSocketConnectionRefusedRetries() {
        quint16 port = 0;
        {
            QTcpServer probeServer;  // 借一个空闲端口再放掉:这时没人听
            QVERIFY(probeServer.listen(QHostAddress::LocalHost, 0));
            port = probeServer.serverPort();
        }
        Probe probe;
        GatewayOptions options;
        options.url = u"ws://127.0.0.1:%1/"_s.arg(port);
        options.open = probe.loopbackOnly();
        options.random = [] { return 0.0; };
        DiscordGateway gw(u"bot.token.value"_s, probe.hooks(), options);
        gw.start();
        QVERIFY(waitFor([&] { return probe.phases.size() >= 2; }));
        QCOMPARE(probe.phases[0].first, GatewayPhase::Connecting);
        QVERIFY(!probe.phases[0].second);
        QCOMPARE(probe.phases[1].first, GatewayPhase::Connecting);
        QCOMPARE(probe.phases[1].second.value_or(QString()), u"和 Discord 的连接断了(1006),1 秒后重连"_s);
        gw.stop();
        QCOMPARE(probe.phases.last().first, GatewayPhase::Stopped);
    }

    void realOpenerRefusesNonLoopbackInTests() {
        // 探针用解析不出来的主机(.invalid 按 RFC 6761 永远解析不了):就算这道谓词被删了,也到不了任何真主机
        Probe probe;
        const auto open = probe.loopbackOnly();
        QVERIFY_THROWS_EXCEPTION(JsError, open(u"wss://blocked.invalid/?v=10&encoding=json"_s));
        QVERIFY(probe.refused);
        QVERIFY_THROWS_EXCEPTION(JsError, open(u"wss://gateway.discord.gg.invalid/?v=10&encoding=json"_s));  // 像 Discord、其实解析不了
    }

    /// 许可名单被删(谓词一律放行)时,兜底的拨号闸还是拦得住:换一个会抛的记录闸代替 qFatal 的那个,记下这次拨号、不真拨
    void dialGuardStopsEvenIfAllowListIsGone() {
        QStringList attempts;
        setWebSocketDialGuard([&](const QUrl& url) {
            attempts << url.host();
            throw JsError(u"拨号被兜底闸拦下"_s);
        });
        const auto permissive = webSocketOpener([](const QString&) { return true; });
        QVERIFY_THROWS_EXCEPTION(JsError, permissive(u"wss://blocked.invalid/"_s));
        QCOMPARE(attempts, QStringList{u"blocked.invalid"_s});
        installFatalDialGuard();
    }

    void productionDefaultAllowsOnlyDiscordHosts() {
        QVERIFY(discordHostsOnly(u"gateway.discord.gg"_s));
        QVERIFY(discordHostsOnly(u"gateway-us-east1-b.discord.gg"_s));
        QVERIFY(discordHostsOnly(u"discord.gg"_s));
        QVERIFY(!discordHostsOnly(u"evil-discord.gg"_s));
        QVERIFY(!discordHostsOnly(u"discord.gg.evil.com"_s));
        QVERIFY(!discordHostsOnly(u"127.0.0.1"_s));
        // 缺省的开法拒掉非 Discord 的主机(不拨号:谓词先拦)
        QVERIFY_THROWS_EXCEPTION(JsError, webSocketOpener()(u"wss://example.invalid/"_s));
    }
#endif
};

QTEST_GUILESS_MAIN(TestDiscordGateway)
#include "tst_discord_gateway.moc"
