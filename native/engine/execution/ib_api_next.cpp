#include "execution/ib_api_next.h"

#include "execution/ib_exec_history.h"
#include "execution/tws/wire_in.h"
#include "execution/tws/wire_out.h"
#include "util/error.h"
#include "util/js_runtime.h"
#include "util/jsformat.h"
#include "util/jsnum.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"

#include <QObject>
#include <QPointer>
#include <QTcpSocket>
#include <QTimer>
#include <QtEndian>

#include <cstdio>
#include <map>

namespace ibkr::execution::ibnext {

using namespace Qt::StringLiterals;
namespace js = util::js;
namespace wire = tws::wire;

// ================================================================ 运行时

double nodeDelay(double ms) {
    if (!(ms >= 1 && ms <= 2147483647.0)) return 1;
    return std::trunc(ms);
}

void Runtime::queueMicrotask(std::function<void()> fn) {
    micro_.push_back(std::move(fn));
    if (depth_ == 0) drain();
}

Runtime::Scope::Scope(Runtime& rt) : rt_(rt) { ++rt_.depth_; }
Runtime::Scope::~Scope() {
    if (--rt_.depth_ == 0) rt_.drain();
}

void Runtime::runMacrotask(const std::function<void()>& fn) {
    Scope s(*this);
    fn();
}

void Runtime::drain() {
    if (draining_) return;
    draining_ = true;
    ++depth_;  // 微任务里再开的 Scope 不自己放(这里一直放到空)
    while (!micro_.empty()) {
        auto f = std::move(micro_.front());
        micro_.pop_front();
        f();
    }
    --depth_;
    draining_ = false;
}

namespace {

class QtRuntime : public Runtime {
public:
    double now() override { return util::dateNow(); }
    quint64 setTimeout(double ms, std::function<void()> fn) override {
        const quint64 id = ++seq_;
        auto* t = new QTimer(&owner_);
        t->setSingleShot(true);
        QObject::connect(t, &QTimer::timeout, &owner_, [this, id, fn = std::move(fn)] {
            auto it = timers_.find(id);
            if (it == timers_.end()) return;
            it->second->deleteLater();
            timers_.erase(it);
            runMacrotask(fn);
        });
        timers_[id] = t;
        t->start(static_cast<int>(nodeDelay(ms)));
        return id;
    }
    void clearTimeout(quint64 id) override {
        auto it = timers_.find(id);
        if (it == timers_.end()) return;
        it->second->stop();
        it->second->deleteLater();
        timers_.erase(it);
    }

private:
    QObject owner_;
    std::map<quint64, QTimer*> timers_;
    quint64 seq_ = 0;
};

class TcpNodeSocket : public NodeSocket {
public:
    TcpNodeSocket(const QString& host, quint16 port, Handlers h) : h_(std::move(h)), host_(host), port_(port) {
        QObject::connect(&socket_, &QTcpSocket::connected, &socket_, [this] {
            if (!destroyed_ && h_.connect) h_.connect();
        });
        QObject::connect(&socket_, &QTcpSocket::readyRead, &socket_, [this] {
            const QByteArray bytes = socket_.readAll();
            if (!destroyed_ && h_.data) h_.data(bytes);
        });
        QObject::connect(&socket_, &QTcpSocket::errorOccurred, &socket_, [this](QAbstractSocket::SocketError e) {
            if (destroyed_) return;
            if (e == QAbstractSocket::RemoteHostClosedError) {
                // 对端正常关:Node 是 end 然后 close
                destroyed_ = true;
                if (h_.end) h_.end();
                closeSoon();
                return;
            }
            destroyed_ = true;
            if (h_.error) h_.error(nodeSocketErrorMessage(e, host_, port_, socket_.peerAddress().toString(), socket_.errorString()));
            closeSoon();
        });
        QObject::connect(&socket_, &QTcpSocket::disconnected, &socket_, [this] {
            if (destroyed_) return;
            destroyed_ = true;
            if (h_.end) h_.end();
            closeSoon();
        });
        // 下一拍再连(Node 的 net.connect 也是下一拍才有事件)
        QTimer::singleShot(0, &socket_, [this] {
            if (!destroyed_) socket_.connectToHost(host_, port_);
        });
    }
    ~TcpNodeSocket() override {
        // QTcpSocket 析构时会自己 abort 并发 disconnected:那不是对端关了,不报
        destroyed_ = true;
        socket_.disconnect();
    }
    void write(const QByteArray& bytes) override {
        if (!destroyed_) socket_.write(bytes);
    }
    void end() override {
        if (!destroyed_) socket_.flush();
    }
    void destroy() override {
        if (closeQueued_) return;
        destroyed_ = true;
        socket_.abort();
        closeSoon();
    }

private:
    void closeSoon() {
        if (closeQueued_) return;
        closeQueued_ = true;
        QTimer::singleShot(0, &socket_, [this] {
            if (h_.close) h_.close();
        });
    }
    Handlers h_;
    QString host_;
    quint16 port_;
    QTcpSocket socket_;
    bool destroyed_ = false;
    bool closeQueued_ = false;
};

}  // namespace

std::shared_ptr<Runtime> makeQtRuntime() { return std::make_shared<QtRuntime>(); }

SocketFactory tcpSocketFactory() {
    return [](const QString& host, double port, NodeSocket::Handlers h) -> std::shared_ptr<NodeSocket> {
        return std::make_shared<TcpNodeSocket>(host, static_cast<quint16>(port), std::move(h));
    };
}

// ================================================================ 小工具

bool looseEq(const OJson* a, const OJson* b) {
    const bool an = js::nullish(a), bn = js::nullish(b);
    if (an || bn) return an && bn;
    if (a->type == OJson::Object || a->type == OJson::Array || b->type == OJson::Object || b->type == OJson::Array) return false;
    if (a->type == OJson::String && b->type == OJson::String) return a->s == b->s;
    return js::num(a) == js::num(b);
}

int Emitter::on(const QString& name, Fn fn) {
    const int id = next_++;
    map_[name].push_back({id, std::make_shared<Fn>(std::move(fn))});
    return id;
}

void Emitter::off(const QString& name, int id) {
    auto it = map_.find(name);
    if (it == map_.end()) return;
    auto& v = it.value();
    for (auto i = v.begin(); i != v.end(); ++i)
        if (i->id == id) {
            v.erase(i);
            break;
        }
    if (v.empty()) map_.erase(it);
}

void Emitter::fire(const QString& name, const OJson& args) {
    auto it = map_.find(name);
    if (it == map_.end()) return;
    const std::vector<L> snapshot = it.value();
    for (const L& l : snapshot) (*l.fn)(args);
}

int StateSubject::subscribe(std::function<void(int)> fn) {
    const int id = next_++;
    O o{id, std::make_shared<std::function<void(int)>>(std::move(fn)), std::make_shared<bool>(false)};
    observers_.push_back(o);
    (*o.fn)(value_);
    return id;
}

void StateSubject::unsubscribe(int id) {
    for (auto i = observers_.begin(); i != observers_.end(); ++i)
        if (i->id == id) {
            *i->closed = true;
            observers_.erase(i);
            return;
        }
}

void StateSubject::next(int v) {
    value_ = v;
    const std::vector<O> snapshot = observers_;
    for (const O& o : snapshot)
        if (!*o.closed) (*o.fn)(v);
}

// ================================================================ 订阅

struct Subscription::Sub {
    Observer o;
    int index = 0;
    bool stopped = false;
    bool tornDown = false;
    /// 收尾函数已经交回去了(订阅途中就结束的,要等交回去那一刻再收尾)
    bool active = false;
};

class Subscription::Handle : public SubHandle {
public:
    Handle(std::weak_ptr<Subscription> owner, std::shared_ptr<Sub> sub) : owner_(std::move(owner)), sub_(std::move(sub)) {}
    void unsubscribe() override {
        auto owner = owner_.lock();
        if (!owner || sub_->stopped) return;
        sub_->stopped = true;
        owner->teardown(sub_);
    }

private:
    std::weak_ptr<Subscription> owner_;
    std::shared_ptr<Sub> sub_;
};

Subscription::Subscription(std::weak_ptr<ApiNext> api, std::function<void()> request, std::function<void()> cancel, std::function<void()> cleanup,
                           QString instance)
    : instanceId(std::move(instance)), api_(std::move(api)), request_(std::move(request)), cancel_(std::move(cancel)), cleanup_(std::move(cleanup)) {
    if (auto owner = api_.lock()) reqId = owner->nextReqId();
}

void Subscription::next(const Upd& v) {
    lastAllValue = v.all;
    if (stopped_) return;
    buffer_ = v;
    const auto snapshot = observers_;
    for (const auto& s : snapshot) deliverNext(s, v);
}

void Subscription::complete() {
    if (stopped_) return;
    stopped_ = true;
    const auto snapshot = observers_;
    for (const auto& s : snapshot) deliverComplete(s);
}

void Subscription::error(const ApiError& e) {
    auto keep = shared_from_this();
    lastAllValue.reset();
    hasError_ = true;
    if (!stopped_) {
        stopped_ = true;
        thrown_ = e;
        const auto snapshot = observers_;
        for (const auto& s : snapshot) deliverError(s, e);
    }
    cancelTws();
}

std::shared_ptr<SubHandle> Subscription::subscribe(Observer observer) {
    auto keep = shared_from_this();
    if (hasError_) {
        // 出过错:换一个新的主题与请求号
        hasError_ = false;
        buffer_.reset();
        stopped_ = false;
        thrown_.reset();
        observers_.clear();
        if (auto api = api_.lock()) reqId = api->nextReqId();
    }
    auto s = std::make_shared<Sub>();
    s->o = std::move(observer);
    // ReplaySubject._subscribe:先挂上(已经结束的不挂),再回放,再报结束
    if (!stopped_) observers_.push_back(s);
    if (buffer_) deliverNext(s, *buffer_);
    if (thrown_) deliverError(s, *thrown_);
    else if (stopped_) deliverComplete(s);
    if (observersCount_++ == 0) requestTws();
    // 订阅途中就已经结束了的:收尾立刻跑(rxjs 把收尾函数加到已关闭的订阅上时当场执行)
    s->active = true;
    if (s->stopped) teardown(s);
    return std::make_shared<Handle>(weak_from_this(), s);
}

void Subscription::deliverNext(const std::shared_ptr<Sub>& s, const Upd& v) {
    if (s->stopped) return;
    if (s->index++ == 0) {
        Upd first;
        first.all = v.all;
        first.added = v.all;
        if (s->o.next) s->o.next(first);
    } else if (s->o.next) {
        s->o.next(v);
    }
}

void Subscription::deliverError(const std::shared_ptr<Sub>& s, const ApiError& e) {
    if (s->stopped) return;
    s->stopped = true;
    if (s->o.error) s->o.error(e);
    teardown(s);
}

void Subscription::deliverComplete(const std::shared_ptr<Sub>& s) {
    if (s->stopped) return;
    s->stopped = true;
    if (s->o.complete) s->o.complete();
    teardown(s);
}

void Subscription::teardown(const std::shared_ptr<Sub>& s) {
    if (s->tornDown || !s->active) return;
    auto keep = shared_from_this();
    s->tornDown = true;
    std::erase(observers_, s);
    if (--observersCount_ <= 0) {
        cancelTws();
        if (cleanup_) cleanup_();
    }
}

void Subscription::requestTws() {
    if (connSub_) return;
    auto api = api_.lock();
    if (!api) return;
    std::weak_ptr<Subscription> weak = weak_from_this();
    connSub_ = api->connectionState().subscribe([weak](int state) {
        auto self = weak.lock();
        if (!self || state != Connected) return;
        self->lastAllValue.reset();
        self->endEventReceived = false;
        if (self->request_) self->request_();
    });
}

void Subscription::cancelTws() {
    auto api = api_.lock();
    if (!api) {
        connSub_.reset();  // 拥有者已经没了:订阅表与连接状态都随它去了,没有什么可撤的
        return;
    }
    if (connSub_) {
        api->connectionState().unsubscribe(*connSub_);
        connSub_.reset();
    }
    if (api->isConnected() && cancel_) cancel_();
}

// ================================================================ IbApi

class DecoderBox {
public:
    explicit DecoderBox(int v) : d(v) {}
    wire::Decoder d;
};

IbApi::IbApi(std::shared_ptr<Runtime> rt, SocketFactory sockets, QString host, double port, double reconnectInterval)
    : rt_(std::move(rt)), sockets_(std::move(sockets)), host_(std::move(host)), port_(port), reconnectInterval_(reconnectInterval) {
    log = [](const QString& line) { std::fprintf(stderr, "%s\n", line.toUtf8().constData()); };
    // IBApiAutoConnection 的构造:connected / disconnected / error(502)
    events.on(u"connected"_s, [this](const OJson&) { onConnected(); });
    events.on(u"disconnected"_s, [this](const OJson&) { onDisconnected(); });
    events.on(u"error"_s, [this](const OJson& a) {
        const OJson* code = a.items.size() > 1 ? &a.items[1] : nullptr;
        if (js::isNum(code) && code->n == 502) onDisconnected();
    });
}

IbApi::~IbApi() {
    // 计时器不撤:库里那个对象还活着,到点照样跑(只是什么都不做);这里到点时见 alive_ 已失效就返回
    *alive_ = false;
}

// ---- controller

void IbApi::schedule(std::function<void()> command) {
    commands_.push_back(std::move(command));
    if (!processing_) processCommands();
}

void IbApi::resume() {
    paused_ = false;
    if (!processing_) processCommands();
}

void IbApi::processCommands() {
    while (!paused_) {
        processing_ = true;
        if (commands_.empty()) break;
        auto c = std::move(commands_.front());
        commands_.pop_front();
        try {
            c();
        } catch (const util::JsError& e) {
            // 库里这一条会冒出去、命令缓冲从此卡死;这里记下、丢掉这一条
            log(u"[ibkr] 发给 TWS 的一条请求编不出来,丢掉:"_s + e.message());
        }
    }
    processing_ = false;
}

void IbApi::emitEvent(const QString& name, const OJson& args) {
    events.fire(name, args);
    if (name == u"nextValidId") resume();
}

void IbApi::emitInfo(const QString& message, double code) { emitEvent(u"info"_s, js::array({js::S(message), js::N(code)})); }

void IbApi::emitError(const QString& message, double code, std::optional<double> reqId) {
    emitEvent(u"error"_s, js::array({js::S(message), js::N(code), js::N(reqId.value_or(-1)), OJson::null()}));
}

void IbApi::deliver(const wire::Encoded& e) {
    for (const wire::Emit& err : e.errors) emitEvent(err.name, err.args);
    if (e.tokens) sendMsg(*e.tokens);
}

void IbApi::sendMsg(const OJson& tokens) {
    if (rateCount_ <= 0) {
        rateFifo_.push_back(tokens);
        return;
    }
    rateCount_ -= 1;
    rateCallNext(tokens);
}

void IbApi::rateCallNext(std::optional<OJson> args) {
    std::weak_ptr<bool> alive = alive_;
    rt_->setTimeout(100, [this, alive] {
        if (alive.expired()) return;  // 限速的计时器只往 socket 写字节,不会走进会话的回调,不用钉住拥有者
        if (!rateFifo_.empty()) rateCallNext(std::nullopt);
        else rateCount_ += 1;
    });
    if (!rateFifo_.empty()) {
        OJson next = std::move(rateFifo_.front());
        rateFifo_.pop_front();
        socketSend(next);
        return;
    }
    if (args) socketSend(*args);
}

void IbApi::controllerConnect(double clientId) {
    if (status_ != kConnectedStatus) socketConnect(clientId);
    else emitInfo(u"Cannot connect if already connected."_s, 501);
}

void IbApi::controllerDisconnect() {
    if (status_ >= kConnectingStatus) socketDisconnect();
    else emitInfo(u"Cannot disconnect if already disconnected."_s, 504);
}

// ---- socket

void IbApi::socketConnect(std::optional<double> clientId) {
    if (status_ >= kConnectingStatus) return;
    status_ = kConnectingStatus;
    if (clientId) clientId_ = std::floor(*clientId);
    pause();
    dataFragment_.clear();
    neverReceived_ = true;
    buffer_.clear();
    std::weak_ptr<bool> alive = alive_;
    auto holder = std::make_shared<std::weak_ptr<NodeSocket>>();
    NodeSocket::Handlers h;
    auto guard = [this, alive](auto fn) {
        if (alive.expired()) return;
        auto keep = owner_.lock();  // 回调里哪怕把会话丢了,这一层也撑到这个回调跑完
        Runtime::Scope s(*rt_);
        fn();
    };
    h.connect = [guard, this] { guard([this] { onSocketConnect(); }); };
    h.data = [guard, this](const QByteArray& b) { guard([this, b] { onSocketData(b); }); };
    h.end = [guard, this] { guard([this] { onSocketEnd(); }); };
    h.error = [guard, this](const QString& m) { guard([this, m] { onSocketError(m); }); };
    h.close = [guard, this, holder] {
        guard([this, holder] {
            onSocketEnd();
            if (auto s = holder->lock()) std::erase(open_, s);
        });
    };
    client_ = sockets_(host_, port_, std::move(h));
    *holder = client_;
    open_.push_back(client_);
}

void IbApi::socketDisconnect() {
    status_ = kDisconnectingStatus;
    pause();
    if (client_) {
        auto c = client_;
        c->end();
        c->destroy();
    }
}

void IbApi::socketSend(const OJson& tokens) {
    if (client_) client_->write(wire::bytesOf(tokens));
}

void IbApi::onSocketConnect() {
    const QByteArray config = "v100..193";
    QByteArray hs = QByteArray("API", 3) + '\0';
    char len[4];
    qToBigEndian<quint32>(static_cast<quint32>(config.size()), len);
    hs += QByteArray(len, 4) + config;
    if (client_) client_->write(hs);
}

void IbApi::onSocketData(const QByteArray& data) {
    buffer_ += data;
    if (buffer_.size() > 0xffffff) {
        const qsizetype size = buffer_.size();
        buffer_.clear();
        onSocketError(u"Message of size %1 exceeded max message length %2"_s.arg(size).arg(0xffffff));
        socketDisconnect();
        return;
    }
    // Buffer.slice 的下标:负数从尾部算
    auto clampIdx = [](qint64 i, qint64 len) { return i < 0 ? std::max<qint64>(0, len + i) : std::min(i, len); };
    while (buffer_.size() > 4) {
        const qint32 msgSize = qFromBigEndian<qint32>(buffer_.constData());
        const qint64 len = buffer_.size();
        if (len >= 4 + static_cast<qint64>(msgSize)) {
            const qint64 a = clampIdx(4, len), b = clampIdx(4 + static_cast<qint64>(msgSize), len);
            const QByteArray segment = b > a ? buffer_.mid(a, b - a) : QByteArray();
            buffer_ = buffer_.mid(clampIdx(4 + static_cast<qint64>(msgSize), len));
            onMessage(util::nodeUtf8(segment));
        } else {
            return;
        }
    }
}

void IbApi::onMessage(const QString& data) {
    const QString withFragment = dataFragment_ + data;
    QStringList tokens = withFragment.split(QChar(u'\0'));
    if (tokens.last() != u"") dataFragment_ = tokens.last();
    else dataFragment_.clear();
    tokens.removeLast();
    if (neverReceived_) {
        neverReceived_ = false;
        onServerVersion(tokens);
        return;
    }
    if (!decoder_) return;
    decoder_->d.enqueueMessage(tokens);
    std::vector<wire::Emit> out;
    try {
        decoder_->d.process(out);
    } catch (const wire::WireError& e) {
        log(u"[ibkr] TWS 的一条消息读不出来(%1: %2),丢掉"_s.arg(e.name(), e.message()));
    }
    for (const wire::Emit& e : out)
        if (e.name != u"__unported__") emitEvent(e.name, e.args);
}

void IbApi::onServerVersion(const QStringList& tokens) {
    status_ = kConnectedStatus;
    serverVersion_ = tokens.isEmpty() ? std::nan("") : util::jsParseInt(tokens.at(0), 10);
    const int sv = std::isnan(serverVersion_) ? 0 : static_cast<int>(std::clamp(serverVersion_, -1e9, 1e9));
    decoder_ = std::make_unique<DecoderBox>(sv);
    if (serverVersion_ < 100 || serverVersion_ > 193) {
        socketDisconnect();
        emitError(u"Unsupported Version "_s + util::jsNumberToString(serverVersion_), 506);
        return;
    }
    if (serverVersion_ >= 3) {
        const wire::Encoded e = wire::startApi(sv, OJson::number(clientId_));
        if (e.tokens) socketSend(*e.tokens);
    }
    emitEvent(u"connected"_s, js::array());
    emitEvent(u"server"_s, js::array({js::N(serverVersion_), js::S(tokens.value(1))}));
}

void IbApi::onSocketEnd() {
    if (status_ != kDisconnectedStatus) {
        status_ = kDisconnectedStatus;
        emitEvent(u"disconnected"_s, js::array());
    }
    pause();
}

void IbApi::onSocketError(const QString& message) { emitError(message, 502); }

// ---- auto connection

void IbApi::connect(std::optional<double> clientId) {
    autoReconnectEnabled_ = true;
    fixedClientId_ = clientId;
    currentClientId_ = clientId.value_or(0);
    if (connectionState.value() == Disconnected) {
        connectionState.next(Connecting);
        controllerConnect(currentClientId_);
    }
}

void IbApi::disconnect() {
    autoReconnectEnabled_ = false;
    if (connectionState.value() != Disconnected) {
        connectionState.next(Disconnected);
        if (isConnected()) controllerDisconnect();
    }
}

void IbApi::onConnected() {
    if (connectionState.value() != Connected) {
        connectionState.next(Connected);
        stopReConnectTimer();
    }
}

void IbApi::reConnect() {
    if (connectionState.value() != Disconnected || !autoReconnectEnabled_) return;
    connectionState.next(Connecting);
    currentClientId_ = fixedClientId_ ? *fixedClientId_ : currentClientId_ + 1;
    controllerDisconnect();
    controllerConnect(currentClientId_);
}

void IbApi::runReConnectTimer() {
    if (!(reconnectInterval_ != 0 && !std::isnan(reconnectInterval_)) || !autoReconnectEnabled_) return;
    if (reconnectTimer_) rt_->clearTimeout(*reconnectTimer_);
    std::weak_ptr<bool> alive = alive_;
    reconnectTimer_ = rt_->setTimeout(reconnectInterval_, [this, alive] {
        if (alive.expired()) return;
        auto keep = owner_.lock();
        reConnect();
    });
}

void IbApi::stopReConnectTimer() {
    if (!reconnectTimer_) return;
    rt_->clearTimeout(*reconnectTimer_);
    reconnectTimer_.reset();
}

void IbApi::onDisconnected() {
    if (isConnected()) {
        disconnect();
        autoReconnectEnabled_ = true;
    }
    if (connectionState.value() != Disconnected) connectionState.next(Disconnected);
    runReConnectTimer();
}

// ---- 请求

namespace {
wire::Arg A(const OJson& v) { return v; }
wire::Arg Nn(double v) { return OJson::number(v); }
wire::Arg Sv(const QString& v) { return OJson::string(v); }
wire::Arg Bv(bool v) { return OJson::boolean(v); }
}  // namespace

#define IBNEXT_SV static_cast<int>(std::isnan(serverVersion_) ? 0 : serverVersion_)

void IbApi::reqManagedAccts() { schedule([this] { deliver(wire::reqManagedAccts(IBNEXT_SV)); }); }
void IbApi::reqContractDetails(double reqId, const OJson& contract) {
    schedule([this, reqId, contract] { deliver(wire::reqContractDetails(IBNEXT_SV, Nn(reqId), A(contract))); });
}
void IbApi::reqMarketDataType(double type) { schedule([this, type] { deliver(wire::reqMarketDataType(IBNEXT_SV, Nn(type))); }); }
void IbApi::reqMktData(double reqId, const OJson& contract, const QString& generic, bool snapshot, bool reg) {
    schedule([=, this] { deliver(wire::api::reqMktData(IBNEXT_SV, Nn(reqId), A(contract), Sv(generic), Bv(snapshot), Bv(reg))); });
}
void IbApi::cancelMktData(double reqId) { schedule([this, reqId] { deliver(wire::cancelMktData(IBNEXT_SV, Nn(reqId))); }); }
void IbApi::reqHistoricalData(double reqId, const OJson& contract, std::optional<QString> end, const QString& duration, const QString& barSize,
                              const QString& whatToShow, double useRTH, double formatDate, bool keepUpToDate) {
    schedule([=, this] {
        deliver(wire::api::reqHistoricalData(IBNEXT_SV, Nn(reqId), A(contract), end ? Sv(*end) : wire::Arg(), Sv(duration), Sv(barSize), Sv(whatToShow),
                                             Nn(useRTH), Nn(formatDate), Bv(keepUpToDate)));
    });
}
void IbApi::reqSecDefOptParams(double reqId, const QString& symbol, const QString& fut, const QString& secType, double conId) {
    schedule([=, this] { deliver(wire::reqSecDefOptParams(IBNEXT_SV, Nn(reqId), Sv(symbol), Sv(fut), Sv(secType), Nn(conId))); });
}
void IbApi::reqMktDepth(double reqId, const OJson& contract, double numRows, bool smart) {
    schedule([=, this] { deliver(wire::reqMktDepth(IBNEXT_SV, Nn(reqId), A(contract), Nn(numRows), Bv(smart), wire::Arg())); });
}
void IbApi::cancelMktDepth(double reqId, bool smart) { schedule([=, this] { deliver(wire::cancelMktDepth(IBNEXT_SV, Nn(reqId), Bv(smart))); }); }
void IbApi::placeOrder(double id, const OJson& contract, const OJson& order) {
    schedule([=, this] { deliver(wire::placeOrder(IBNEXT_SV, Nn(id), A(contract), A(order))); });
}
void IbApi::cancelOrder(double orderId) { schedule([=, this] { deliver(wire::api::cancelOrder(IBNEXT_SV, Nn(orderId), wire::Arg())); }); }
void IbApi::reqAllOpenOrders() { schedule([this] { deliver(wire::reqAllOpenOrders(IBNEXT_SV)); }); }
void IbApi::reqExecutions(double reqId, const OJson& filter) { schedule([=, this] { deliver(wire::reqExecutions(IBNEXT_SV, Nn(reqId), A(filter))); }); }
void IbApi::reqPositions() { schedule([this] { deliver(wire::reqPositions(IBNEXT_SV)); }); }
void IbApi::cancelPositions() { schedule([this] { deliver(wire::cancelPositions(IBNEXT_SV)); }); }
void IbApi::reqAccountSummary(double reqId, const QString& group, const QString& tags) {
    schedule([=, this] { deliver(wire::reqAccountSummary(IBNEXT_SV, Nn(reqId), Sv(group), Sv(tags))); });
}
void IbApi::cancelAccountSummary(double reqId) { schedule([=, this] { deliver(wire::cancelAccountSummary(IBNEXT_SV, Nn(reqId))); }); }
void IbApi::reqPnL(double reqId, const QString& account) { schedule([=, this] { deliver(wire::api::reqPnL(IBNEXT_SV, Nn(reqId), Sv(account), wire::Arg())); }); }
void IbApi::cancelPnL(double reqId) { schedule([=, this] { deliver(wire::cancelPnL(IBNEXT_SV, Nn(reqId))); }); }
void IbApi::reqIds() { schedule([this] { deliver(wire::api::reqIds(IBNEXT_SV, wire::Arg())); }); }

#undef IBNEXT_SV

// ================================================================ IBApiNext

namespace {
const OJson* arg(const OJson& a, int i) { return i < a.items.size() ? &a.items[i] : nullptr; }
/// 事件参数里的 null 就是库里的 undefined
const OJson* defined(const OJson* v) { return v && v->type != OJson::Null ? v : nullptr; }
double argNum(const OJson& a, int i) { return js::num(defined(arg(a, i))); }
template <class T>
std::shared_ptr<T> anyPtr(const std::any& a) {
    if (!a.has_value()) return nullptr;
    return std::any_cast<std::shared_ptr<T>>(a);
}
/// 对象字面量里放一个可能是 undefined 的值:undefined 就不放这个键(JSON 的样子)
void setIf(OJson& o, const QString& k, const OJson* v) {
    if (defined(v)) o.set(k, *v);
    else o.remove(k);
}
}  // namespace

std::shared_ptr<ApiNext> ApiNext::make(std::shared_ptr<Runtime> rt, SocketFactory sockets, QString host, double port, double reconnectInterval) {
    auto self = std::make_shared<ApiNext>(std::move(rt), std::move(sockets), std::move(host), port, reconnectInterval);
    self->api_.setOwner(self);
    return self;
}

ApiNext::ApiNext(std::shared_ptr<Runtime> rt, SocketFactory sockets, QString host, double port, double reconnectInterval)
    : rt_(rt), api_(rt, std::move(sockets), std::move(host), port, reconnectInterval) {
    // 构造里挂的两个:error → 派给订阅、再发给 errorSubject;info 里的 1100 / 2110 → 断开
    api_.events.on(u"error"_s, [this](const OJson& a) {
        ApiError e;
        e.message = js::str(arg(a, 0));
        e.code = js::num(arg(a, 1));
        e.reqId = defined(arg(a, 2)) ? js::num(arg(a, 2)) : -1;
        const bool nonFatal = (e.code >= 2100 && e.code < 3000) || e.message.contains(u"Warning:"_s) || e.code == 10090 || e.code == 10167 || e.code == 399 ||
                              e.code == 492;
        if (e.reqId != -1 && !nonFatal) dispatchError(e);
        const auto observers = errorObservers_;
        for (const auto& fn : observers) fn(e);
    });
    api_.events.on(u"info"_s, [this](const OJson& a) {
        const OJson* code = arg(a, 1);
        if (js::isNum(code) && (code->n == 1100 || code->n == 2110)) api_.onDisconnected();
    });
}

void ApiNext::forEachSub(Subs& subs, const std::function<void(const std::shared_ptr<Subscription>&)>& fn) {
    const auto snapshot = subs.items;
    for (const auto& [k, s] : snapshot) {
        const auto* now = subs.get(k);
        if (!now || *now != s) continue;
        fn(s);
    }
}

std::shared_ptr<Subscription> ApiNext::registerSub(std::function<void(double)> request, std::function<void(double)> cancel,
                                                   const std::vector<std::pair<QString, Handler>>& events, const QString& instanceId) {
    std::vector<std::shared_ptr<Entry>> mine;
    for (const auto& [name, handler] : events) {
        std::shared_ptr<Entry> entry;
        for (const auto& e : entries_)
            if (e->event == name) entry = e;
        if (!entry) {
            entry = std::make_shared<Entry>();
            entry->event = name;
            Handler h = handler;
            // 监听里只放弱引用:订阅表(entries_)拥有条目,条目拥有订阅,订阅的收尾回调也只放弱引用——没有环。
            // 跑的这一刻 lock 一份在手里:处理途中最后一个订阅走了、条目从表里摘掉,也不会把正在读的 subs 拆了
            std::weak_ptr<Entry> weakEntry = entry;
            entry->listener = api_.events.on(name, [weakEntry, h](const OJson& a) {
                if (auto e = weakEntry.lock()) h(e->subs, a);
            });
            entries_.push_back(entry);
        }
        mine.push_back(entry);
    }
    std::shared_ptr<Subscription> sub;
    if (!instanceId.isEmpty()) {
        for (const auto& e : mine) {
            for (const auto& [k, s] : e->subs.items)
                if (!sub && s->instanceId == instanceId) sub = s;
        }
    }
    if (!sub) {
        auto weak = std::make_shared<std::weak_ptr<Subscription>>();
        std::vector<std::weak_ptr<Entry>> weakMine(mine.begin(), mine.end());
        sub = std::make_shared<Subscription>(
            weak_from_this(), [weak, request] { if (auto s = weak->lock()) request(s->reqId); },
            [weak, cancel] {
                if (auto s = weak->lock(); s && cancel) cancel(s->reqId);
            },
            [self = weak_from_this(), weak, weakMine] {
                auto s = weak->lock();
                auto api = self.lock();
                if (!s || !api) return;
                for (const auto& we : weakMine) {
                    auto entry = we.lock();
                    if (!entry) continue;
                    entry->subs.erase(s->reqId);
                    if (entry->subs.empty()) {
                        api->api_.events.off(entry->event, entry->listener);
                        std::erase(api->entries_, entry);
                    }
                }
            },
            instanceId);
        *weak = sub;
        for (const auto& e : mine) e->subs.set(sub->reqId, sub);
    }
    return sub;
}

void ApiNext::dispatchError(const ApiError& e) {
    const auto snapshot = entries_;
    for (const auto& entry : snapshot) {
        if (auto* s = entry->subs.get(e.reqId)) {
            auto keep = *s;
            keep->error(e);
        }
    }
}

template <class R>
Task<R> ApiNext::lastValueFrom(const std::shared_ptr<Subscription>& sub, std::function<R(const std::any&)> map, R defaultValue) {
    util::Deferred<R> d;
    auto last = std::make_shared<std::optional<R>>();
    std::shared_ptr<Runtime> rt = rt_;
    Observer o;
    o.next = [last, map](const Upd& u) { *last = map(u.all); };
    o.error = [d, rt](const ApiError& e) { rejectLater(*rt, d, std::make_exception_ptr(util::JsError(e.message))); };
    o.complete = [d, rt, last, defaultValue] { resolveLater(*rt, d, *last ? **last : defaultValue); };
    sub->subscribe(std::move(o));
    return d.task();
}

namespace {
JsList listOf(const std::any& a) {
    auto p = anyPtr<JsList>(a);
    return p ? *p : JsList{};
}
}  // namespace

Task<QStringList> ApiNext::getManagedAccounts() {
    auto sub = registerSub([this](double) { api_.reqManagedAccts(); }, nullptr,
                           {{u"managedAccounts"_s, [this](Subs& s, const OJson& a) { onManagedAccts(s, a); }}}, u"getManagedAccounts"_s);
    return lastValueFrom<QStringList>(sub, [](const std::any& a) { return std::any_cast<QStringList>(a); }, QStringList{});
}

Task<JsList> ApiNext::getContractDetails(const OJson& contract) {
    auto sub = registerSub([this, contract](double reqId) { api_.reqContractDetails(reqId, contract); }, nullptr,
                           {{u"contractDetails"_s, [this](Subs& s, const OJson& a) { onContractDetails(s, a); }},
                            {u"bondContractDetails"_s, [this](Subs& s, const OJson& a) { onContractDetails(s, a); }},
                            {u"contractDetailsEnd"_s, [this](Subs& s, const OJson& a) { onContractDetailsEnd(s, a); }}},
                           QString());
    return lastValueFrom<JsList>(sub, listOf, JsList{});
}

std::shared_ptr<Subscription> ApiNext::getMarketData(const OJson& contract, const QString& generic, bool snapshot, bool reg) {
    auto tick = [this](Subs& s, const OJson& a) { onTick(s, a); };
    const QString id = u"getMarketData+%1:%2:%3:%4"_s.arg(js::stringify(contract), generic, snapshot ? u"true"_s : u"false"_s, reg ? u"true"_s : u"false"_s);
    return registerSub([this, contract, generic, snapshot, reg](double reqId) { api_.reqMktData(reqId, contract, generic, snapshot, reg); },
                       [this, snapshot, reg](double reqId) {
                           if (!snapshot && !reg) api_.cancelMktData(reqId);
                       },
                       {{u"tickPrice"_s, tick},
                        {u"tickSize"_s, tick},
                        {u"tickGeneric"_s, tick},
                        {u"tickString"_s, [this](Subs& s, const OJson& a) { onTickString(s, a); }},
                        {u"tickOptionComputation"_s, [this](Subs& s, const OJson& a) { onTickOptionComputation(s, a); }},
                        {u"tickSnapshotEnd"_s, [this](Subs& s, const OJson& a) { onTickSnapshotEnd(s, a); }}},
                       id);
}

Task<JsList> ApiNext::getHistoricalData(const OJson& contract, std::optional<QString> end, const QString& duration, const QString& barSize,
                                        const QString& whatToShow, double useRTH, double formatDate) {
    auto sub = registerSub(
        [=, this](double reqId) { api_.reqHistoricalData(reqId, contract, end, duration, barSize, whatToShow, useRTH, formatDate, false); }, nullptr,
        {{u"historicalData"_s, [this](Subs& s, const OJson& a) { onHistoricalData(s, a); }}}, QString());
    return lastValueFrom<JsList>(sub, listOf, JsList{});
}

Task<JsList> ApiNext::getSecDefOptParams(const QString& symbol, const QString& fut, const QString& secType, double conId) {
    auto sub = registerSub([=, this](double reqId) { api_.reqSecDefOptParams(reqId, symbol, fut, secType, conId); }, nullptr,
                           {{u"securityDefinitionOptionParameter"_s, [this](Subs& s, const OJson& a) { onSecDefOptParam(s, a); }},
                            {u"securityDefinitionOptionParameterEnd"_s, [this](Subs& s, const OJson& a) { onSecDefOptParamEnd(s, a); }}},
                           QString());
    return lastValueFrom<JsList>(sub, listOf, JsList{});
}

std::shared_ptr<Subscription> ApiNext::getMarketDepth(const OJson& contract, double numRows, bool smart) {
    const QString id = u"%1:%2:%3:undefined"_s.arg(js::stringify(contract), util::jsNumberToString(numRows), smart ? u"true"_s : u"false"_s);
    return registerSub([=, this](double reqId) { api_.reqMktDepth(reqId, contract, numRows, smart); },
                       [this, smart](double reqId) { api_.cancelMktDepth(reqId, smart); },
                       {{u"updateMktDepth"_s, [this](Subs& s, const OJson& a) { onUpdateMktDepth(s, a); }},
                        {u"updateMktDepthL2"_s, [this](Subs& s, const OJson& a) { onUpdateMktDepthL2(s, a); }}},
                       id);
}

Task<double> ApiNext::getNextValidOrderId() {
    auto sub = registerSub([this](double) { api_.reqIds(); }, nullptr, {{u"nextValidId"_s, [this](Subs& s, const OJson& a) { onNextValidId(s, a); }}}, QString());
    return lastValueFrom<double>(sub, [](const std::any& a) { return std::any_cast<double>(a); }, -1.0);
}

Task<double> ApiNext::placeNewOrder(OJson contract, OJson order) {
    // 等 nextValidId 的时候不拿着 this(等的那个结果在订阅表里,表随 ApiNext 一起走,协程帧留在那儿也不能指着已经没了的对象)
    auto weak = weak_from_this();
    const double orderId = co_await getNextValidOrderId();
    auto self = weak.lock();
    if (!self) throw util::JsError(u"会话已关闭"_s);
    self->api_.placeOrder(orderId, contract, order);
    co_return orderId;
}

Task<JsList> ApiNext::getAllOpenOrders() {
    auto sub = registerSub([this](double) { api_.reqAllOpenOrders(); }, nullptr,
                           {{u"openOrder"_s, [this](Subs& s, const OJson& a) { onOpenOrder(s, a); }},
                            {u"orderStatus"_s, [this](Subs& s, const OJson& a) { onOrderStatus(s, a); }},
                            {u"orderBound"_s, [](Subs&, const OJson&) { /* 库里只记一行警告 */ }},
                            {u"openOrderEnd"_s, [this](Subs& s, const OJson& a) { onOpenOrderComplete(s, a); }}},
                           u"getAllOpenOrders"_s);
    return lastValueFrom<JsList>(sub, listOf, JsList{});
}

Task<JsList> ApiNext::getExecutionDetails(const OJson& filter) {
    auto sub = registerSub([this, filter](double reqId) { api_.reqExecutions(reqId, filter); }, nullptr,
                           {{u"execDetails"_s, [this](Subs& s, const OJson& a) { onExecDetails(s, a); }},
                            {u"execDetailsEnd"_s, [this](Subs& s, const OJson& a) { onExecDetailsEnd(s, a); }}},
                           QString());
    return lastValueFrom<JsList>(sub, listOf, JsList{});
}

std::shared_ptr<Subscription> ApiNext::getPositions() {
    return registerSub([this](double) { api_.reqPositions(); }, [this](double) { api_.cancelPositions(); },
                       {{u"position"_s, [this](Subs& s, const OJson& a) { onPosition(s, a); }},
                        {u"positionEnd"_s, [this](Subs& s, const OJson& a) { onPositionEnd(s, a); }}},
                       u"getPositions"_s);
}

std::shared_ptr<Subscription> ApiNext::getAccountSummary(const QString& group, const QString& tags) {
    return registerSub([=, this](double reqId) { api_.reqAccountSummary(reqId, group, tags); }, [this](double reqId) { api_.cancelAccountSummary(reqId); },
                       {{u"accountSummary"_s, [this](Subs& s, const OJson& a) { onAccountSummary(s, a); }},
                        {u"accountSummaryEnd"_s, [this](Subs& s, const OJson& a) { onAccountSummaryEnd(s, a); }}},
                       u"getAccountSummary+%1:%2"_s.arg(group, tags));
}

std::shared_ptr<Subscription> ApiNext::getPnL(const QString& account) {
    return registerSub([=, this](double reqId) { api_.reqPnL(reqId, account); }, [this](double reqId) { api_.cancelPnL(reqId); },
                       {{u"pnl"_s, [this](Subs& s, const OJson& a) { onPnL(s, a); }}}, u"getPnl+%1:undefined"_s.arg(account));
}

// ---- 事件处理

void ApiNext::onManagedAccts(Subs& subs, const OJson& a) {
    const QStringList accounts = js::str(arg(a, 0)).split(u',');
    forEachSub(subs, [&](const std::shared_ptr<Subscription>& sub) {
        Upd u;
        u.all = accounts;
        sub->next(u);
        sub->complete();
    });
}

void ApiNext::onAccountSummary(Subs& subs, const OJson& a) {
    auto* p = subs.get(argNum(a, 0));
    if (!p) return;
    auto sub = *p;
    const QString account = js::str(arg(a, 1)), tag = js::str(arg(a, 2)), currency = js::str(arg(a, 4));
    auto cached = anyPtr<AccountSummaries>(sub->lastAllValue);
    if (!cached) cached = std::make_shared<AccountSummaries>();
    if (!cached->has(account)) cached->set(account, {});
    auto* tags = cached->get(account);
    if (!tags->has(tag)) tags->set(tag, {});
    auto* values = tags->get(tag);
    const bool hasChanged = values->has(currency);
    OJson updated = js::object();
    setIf(updated, u"value"_s, arg(a, 3));
    updated.set(u"ingressTm"_s, js::N(rt_->now()));
    values->set(currency, updated);
    auto delta = std::make_shared<AccountSummaries>();
    OrderedMap<QString, OrderedMap<QString, OJson>> t;
    OrderedMap<QString, OJson> v;
    v.set(currency, updated);
    t.set(tag, v);
    delta->set(account, t);
    if (!sub->endEventReceived) {
        sub->lastAllValue = cached;
    } else {
        Upd u;
        u.all = cached;
        if (hasChanged) u.changed = delta;
        else u.added = delta;
        sub->next(u);
    }
}

void ApiNext::onAccountSummaryEnd(Subs& subs, const OJson& a) {
    auto* p = subs.get(argNum(a, 0));
    if (!p) return;
    auto sub = *p;
    auto cached = anyPtr<AccountSummaries>(sub->lastAllValue);
    if (!cached) cached = std::make_shared<AccountSummaries>();
    sub->endEventReceived = true;
    Upd u;
    u.all = cached;
    sub->next(u);
}

void ApiNext::onPosition(Subs& subs, const OJson& a) {
    const QString account = js::str(arg(a, 0));
    const OJson* contract = defined(arg(a, 1));
    const OJson* pos = defined(arg(a, 2));
    OJson updated = js::object();
    updated.set(u"account"_s, js::S(account));
    setIf(updated, u"contract"_s, contract);
    setIf(updated, u"pos"_s, pos);
    setIf(updated, u"avgCost"_s, arg(a, 3));
    forEachSub(subs, [&](const std::shared_ptr<Subscription>& sub) {
        bool hasAdded = false, hasRemoved = false;
        auto cached = anyPtr<AccountPositions>(sub->lastAllValue);
        if (!cached) cached = std::make_shared<AccountPositions>();
        if (!cached->has(account)) cached->set(account, {});
        QList<OJson>& list = *cached->get(account);
        qsizetype idx = -1;
        for (qsizetype i = 0; i < list.size() && idx < 0; ++i)
            if (looseEq(js::prop(js::prop(&list[i], u"contract"_s), u"conId"_s), js::prop(contract, u"conId"_s))) idx = i;
        if (idx == -1) {
            list.append(updated);
            hasAdded = true;
        } else if (!js::truthy(pos)) {
            list.remove(idx, list.size() - idx);  // splice(i):第 i 条之后的全删(库原样)
            hasRemoved = true;
        } else {
            list[idx] = updated;
        }
        if (!sub->endEventReceived) {
            sub->lastAllValue = cached;
            return;
        }
        auto delta = std::make_shared<AccountPositions>();
        delta->set(account, {updated});
        Upd u;
        u.all = cached;
        if (hasAdded) u.added = delta;
        else if (hasRemoved) u.removed = delta;
        else u.changed = delta;
        sub->next(u);
    });
}

void ApiNext::onPositionEnd(Subs& subs, const OJson&) {
    forEachSub(subs, [](const std::shared_ptr<Subscription>& sub) {
        auto cached = anyPtr<AccountPositions>(sub->lastAllValue);
        if (!cached) cached = std::make_shared<AccountPositions>();
        sub->endEventReceived = true;
        Upd u;
        u.all = cached;
        sub->next(u);
    });
}

void ApiNext::onContractDetails(Subs& subs, const OJson& a) {
    auto* p = subs.get(argNum(a, 0));
    if (!p) return;
    auto sub = *p;
    auto cached = anyPtr<JsList>(sub->lastAllValue);
    if (!cached) cached = std::make_shared<JsList>();
    cached->append(js::copyOrNull(defined(arg(a, 1))));
    Upd u;
    u.all = cached;
    sub->next(u);
}

void ApiNext::onContractDetailsEnd(Subs& subs, const OJson& a) {
    if (auto* p = subs.get(argNum(a, 0))) {
        auto keep = *p;
        keep->complete();
    }
}

void ApiNext::onSecDefOptParam(Subs& subs, const OJson& a) {
    auto* p = subs.get(argNum(a, 0));
    if (!p) return;
    auto sub = *p;
    auto cached = anyPtr<JsList>(sub->lastAllValue);
    if (!cached) cached = std::make_shared<JsList>();
    OJson row = js::object();
    setIf(row, u"exchange"_s, arg(a, 1));
    setIf(row, u"underlyingConId"_s, arg(a, 2));
    setIf(row, u"tradingClass"_s, arg(a, 3));
    row.set(u"multiplier"_s, js::N(util::jsParseInt(js::str(defined(arg(a, 4))), 10)));
    setIf(row, u"expirations"_s, arg(a, 5));
    setIf(row, u"strikes"_s, arg(a, 6));
    cached->append(row);
    Upd u;
    u.all = cached;
    sub->next(u);
}

void ApiNext::onSecDefOptParamEnd(Subs& subs, const OJson& a) {
    if (auto* p = subs.get(argNum(a, 0))) {
        auto keep = *p;
        keep->complete();
    }
}

void ApiNext::onPnL(Subs& subs, const OJson& a) {
    auto* p = subs.get(argNum(a, 0));
    if (!p) return;
    OJson all = js::object();
    setIf(all, u"dailyPnL"_s, arg(a, 1));
    setIf(all, u"unrealizedPnL"_s, arg(a, 2));
    setIf(all, u"realizedPnL"_s, arg(a, 3));
    Upd u;
    u.all = all;
    auto keep = *p;
    keep->next(u);
}

void ApiNext::onTick(Subs& subs, const OJson& a) {
    const double tickType = argNum(a, 1);
    std::optional<double> value;
    if (const OJson* v = defined(arg(a, 2))) value = js::num(v);
    if (value && *value == -1 && (tickType == 1 || tickType == 66 || tickType == 2 || tickType == 67)) value.reset();
    auto* p = subs.get(argNum(a, 0));
    if (!p) return;
    auto sub = *p;
    auto cached = anyPtr<MarketData>(sub->lastAllValue);
    if (!cached) cached = std::make_shared<MarketData>();
    const bool hasChanged = cached->has(tickType);
    cached->set(tickType, TickVal{value});
    auto delta = std::make_shared<MarketData>();
    delta->set(tickType, TickVal{value});
    Upd u;
    u.all = cached;
    if (hasChanged) u.changed = delta;
    else u.added = delta;
    sub->next(u);
}

void ApiNext::onTickString(Subs& subs, const OJson& a) {
    auto* p = subs.get(argNum(a, 0));
    if (!p) return;
    auto sub = *p;
    const double tickType = argNum(a, 1);
    const QString value = js::str(arg(a, 2));
    std::optional<double> numeric;
    if (!util::jsTrim(value).isEmpty()) {
        const double n = util::jsStringToNumber(value);
        if (std::isfinite(n)) numeric = n;
    }
    auto cached = anyPtr<MarketData>(sub->lastAllValue);
    if (!cached) cached = std::make_shared<MarketData>();
    const bool hasChanged = cached->has(tickType);
    cached->set(tickType, TickVal{numeric});
    auto delta = std::make_shared<MarketData>();
    delta->set(tickType, TickVal{numeric});
    Upd u;
    u.all = cached;
    if (hasChanged) u.changed = delta;
    else u.added = delta;
    sub->next(u);
}

void ApiNext::onTickOptionComputation(Subs& subs, const OJson& a) {
    auto* p = subs.get(argNum(a, 0));
    if (!p) return;
    auto sub = *p;
    const double field = argNum(a, 1);
    auto val = [&](int i) -> std::optional<double> {
        if (const OJson* v = defined(arg(a, i))) return js::num(v);
        return std::nullopt;
    };
    // [impliedVol 3, delta 4, optPrice 5, pvDividend 6, gamma 7, vega 8, theta 9, undPrice 10]
    std::vector<std::pair<double, std::optional<double>>> ticks{{10002, val(10)}, {10001, val(6)}};
    double base = 0;
    if (field == 10) base = 10003;
    else if (field == 80) base = 10009;
    else if (field == 11) base = 10015;
    else if (field == 81) base = 10021;
    else if (field == 12) base = 10027;
    else if (field == 82) base = 10033;
    else if (field == 13) base = 10039;
    else if (field == 83) base = 10045;
    if (base != 0) {
        ticks.push_back({base, val(3)});      // IV
        ticks.push_back({base + 2, val(4)});  // DELTA
        ticks.push_back({base + 1, val(5)});  // PRICE
        ticks.push_back({base + 3, val(7)});  // GAMMA
        ticks.push_back({base + 4, val(8)});  // VEGA
        ticks.push_back({base + 5, val(9)});  // THETA
    }
    auto cached = anyPtr<MarketData>(sub->lastAllValue);
    if (!cached) cached = std::make_shared<MarketData>();
    auto added = std::make_shared<MarketData>(), changed = std::make_shared<MarketData>();
    for (const auto& [k, v] : ticks) {
        if (cached->has(k)) changed->set(k, TickVal{v});
        else added->set(k, TickVal{v});
        cached->set(k, TickVal{v});
    }
    if (cached->size()) {
        Upd u;
        u.all = cached;
        if (added->size()) u.added = added;
        if (changed->size()) u.changed = changed;
        sub->next(u);
    }
}

void ApiNext::onTickSnapshotEnd(Subs& subs, const OJson& a) {
    if (auto* p = subs.get(argNum(a, 0))) {
        auto keep = *p;
        keep->complete();
    }
}

void ApiNext::onHistoricalData(Subs& subs, const OJson& a) {
    auto* p = subs.get(argNum(a, 0));
    if (!p) return;
    auto sub = *p;
    const QString time = js::str(arg(a, 1));
    if (time.startsWith(u"finished"_s)) {
        sub->complete();
        return;
    }
    auto all = anyPtr<JsList>(sub->lastAllValue);
    if (!all) all = std::make_shared<JsList>();
    OJson bar = js::object({{u"time"_s, js::S(time)}});
    const char* keys[] = {"open", "high", "low", "close", "volume", "count", "WAP"};
    for (int i = 0; i < 7; ++i) {
        const OJson* v = arg(a, 2 + i);
        // !== -1:undefined 也算(键放进去、值是 undefined,JSON 里就是没有)
        if (!(js::isNum(v) && v->n == -1)) setIf(bar, QString::fromLatin1(keys[i]), v);
    }
    all->append(bar);
    Upd u;
    u.all = all;
    sub->next(u);
}

void ApiNext::onUpdateMktDepth(Subs& subs, const OJson& a) {
    const OJson f = OJson::boolean(false);
    depthL2(subs, argNum(a, 0), arg(a, 1), nullptr, arg(a, 2), arg(a, 3), arg(a, 4), arg(a, 5), &f);
}

void ApiNext::onUpdateMktDepthL2(Subs& subs, const OJson& a) {
    depthL2(subs, argNum(a, 0), arg(a, 1), arg(a, 2), arg(a, 3), arg(a, 4), arg(a, 5), arg(a, 6), arg(a, 7));
}

void ApiNext::depthL2(Subs& subs, double reqId, const OJson* position, const OJson* marketMaker, const OJson* operation, const OJson* side, const OJson* price,
                      const OJson* size, const OJson* isSmartDepth) {
    auto* p = subs.get(reqId);
    if (!p) return;
    auto sub = *p;
    auto cached = anyPtr<DepthBook>(sub->lastAllValue);
    if (!cached) cached = std::make_shared<DepthBook>();
    auto changed = std::make_shared<DepthBook>();
    OrderedMap<double, OJson>* cachedRows = nullptr;
    OrderedMap<double, OJson>* changedRows = nullptr;
    const double sideN = js::num(defined(side));
    if (sideN == 0) {
        cachedRows = &cached->asks;
        changedRows = &changed->asks;
    } else if (sideN == 1) {
        cachedRows = &cached->bids;
        changedRows = &changed->bids;
    }
    if (!cachedRows) return;  // 库里只记一行错误日志
    OJson row = js::object();
    setIf(row, u"marketMaker"_s, marketMaker);
    setIf(row, u"price"_s, price);
    setIf(row, u"size"_s, size);
    setIf(row, u"isSmartDepth"_s, isSmartDepth);
    const double pos = js::num(defined(position));
    const OJson* op = defined(operation);
    const double opN = js::isNum(op) ? op->n : std::nan("");  // switch 是严格相等
    // insertAtMapIndex:按下标插进条目表(splice 的下标规矩),再按 set 的规矩重建
    auto insertAt = [](double index, double key, const OJson& value, OrderedMap<double, OJson>& map) {
        auto arr = map.items;
        const double len = static_cast<double>(arr.size());
        double i = std::isnan(index) ? 0 : std::trunc(index);
        if (i < 0) i = std::max(0.0, len + i);
        else i = std::min(i, len);
        arr.insert(arr.begin() + static_cast<qsizetype>(i), {key, value});
        map.clear();
        for (const auto& [k, v] : arr) map.set(k, v);
    };
    Upd u;
    u.all = cached;
    if (opN == 0) {
        insertAt(pos, pos, row, *cachedRows);
        insertAt(pos, pos, row, *changedRows);
        u.added = changed;
        sub->next(u);
    } else if (opN == 1) {
        cachedRows->set(pos, row);
        changedRows->set(pos, row);
        u.changed = changed;
        sub->next(u);
    } else if (opN == 2) {
        if (const OJson* deleted = cachedRows->get(pos)) {
            const OJson keep = *deleted;
            cachedRows->erase(pos);
            changedRows->set(pos, keep);
            u.removed = changed;
            sub->next(u);
        }
    }
}

void ApiNext::onOpenOrder(Subs& subs, const OJson& a) {
    const OJson orderId = js::copyOrNull(arg(a, 0));
    const OJson* contract = defined(arg(a, 1));
    const OJson* order = defined(arg(a, 2));
    const OJson* orderState = defined(arg(a, 3));
    forEachSub(subs, [&](const std::shared_ptr<Subscription>& sub) {
        auto all = anyPtr<JsList>(sub->lastAllValue);
        if (!all) all = std::make_shared<JsList>();
        qsizetype idx = -1;
        for (qsizetype i = 0; i < all->size() && idx < 0; ++i)
            if (looseEq(js::path(&(*all)[i], {u"order"_s, u"permId"_s}), js::prop(order, u"permId"_s))) idx = i;
        if (idx == -1) {
            OJson added = js::object();
            setIf(added, u"orderId"_s, &orderId);
            setIf(added, u"contract"_s, contract);
            setIf(added, u"order"_s, order);
            setIf(added, u"orderState"_s, orderState);
            all->append(added);
            if (sub->endEventReceived) {
                Upd u;
                u.all = all;
                u.added = std::make_shared<JsList>(JsList{added});
                sub->next(u);
            } else {
                sub->lastAllValue = all;
            }
        } else {
            OJson& updated = (*all)[idx];
            setIf(updated, u"order"_s, order);
            setIf(updated, u"orderState"_s, orderState);
            if (OJson* st = updated.get(u"orderStatus"_s)) {
                setIf(*st, u"clientId"_s, js::prop(order, u"clientId"_s));
                setIf(*st, u"permId"_s, js::prop(order, u"permId"_s));
                setIf(*st, u"parentId"_s, js::prop(order, u"parentId"_s));
                setIf(*st, u"status"_s, js::prop(orderState, u"status"_s));
            }
            Upd u;
            u.all = all;
            u.changed = std::make_shared<JsList>(JsList{updated});
            sub->next(u);
        }
    });
}

void ApiNext::onOpenOrderComplete(Subs& subs, const OJson&) {
    forEachSub(subs, [](const std::shared_ptr<Subscription>& sub) {
        auto all = anyPtr<JsList>(sub->lastAllValue);
        if (!all) all = std::make_shared<JsList>();
        sub->endEventReceived = true;
        Upd u;
        u.all = all;
        sub->next(u);
        sub->complete();
    });
}

void ApiNext::onOrderStatus(Subs& subs, const OJson& a) {
    static const char* keys[] = {"status", "filled", "remaining", "avgFillPrice", "permId", "parentId", "lastFillPrice", "clientId", "whyHeld", "mktCapPrice"};
    OJson orderStatus = js::object();
    for (int i = 0; i < 10; ++i) setIf(orderStatus, QString::fromLatin1(keys[i]), arg(a, 1 + i));
    const OJson* permId = defined(arg(a, 5));
    const OJson* parentId = defined(arg(a, 6));
    const OJson* clientId = defined(arg(a, 8));
    forEachSub(subs, [&](const std::shared_ptr<Subscription>& sub) {
        auto all = anyPtr<JsList>(sub->lastAllValue);
        if (!all) all = std::make_shared<JsList>();
        qsizetype idx = -1;
        for (qsizetype i = 0; i < all->size() && idx < 0; ++i)
            if (looseEq(js::path(&(*all)[i], {u"order"_s, u"permId"_s}), permId)) idx = i;
        if (idx == -1) return;  // 库里记一行警告
        OJson& updated = (*all)[idx];
        updated.set(u"orderStatus"_s, orderStatus);
        if (OJson* st = updated.get(u"orderState"_s); st && st->isObject()) setIf(*st, u"status"_s, arg(a, 1));
        if (OJson* o = updated.get(u"order"_s); o && o->isObject()) {
            if (parentId) o->set(u"parentId"_s, *parentId);
            if (permId) o->set(u"permId"_s, *permId);
            if (clientId) o->set(u"clientId"_s, *clientId);
        }
        Upd u;
        u.all = all;
        u.changed = std::make_shared<JsList>(JsList{updated});
        sub->next(u);
    });
}

void ApiNext::onNextValidId(Subs& subs, const OJson& a) {
    if (subs.empty()) return;
    auto sub = subs.items.front().second;
    Upd u;
    u.all = argNum(a, 0);
    sub->next(u);
    sub->complete();
}

void ApiNext::onExecDetails(Subs& subs, const OJson& a) {
    forEachSub(subs, [&](const std::shared_ptr<Subscription>& sub) {
        auto all = anyPtr<JsList>(sub->lastAllValue);
        if (!all) all = std::make_shared<JsList>();
        OJson row = js::object();
        setIf(row, u"reqId"_s, arg(a, 0));
        setIf(row, u"contract"_s, arg(a, 1));
        setIf(row, u"execution"_s, arg(a, 2));
        all->append(row);
        Upd u;
        u.all = all;
        sub->next(u);
    });
}

void ApiNext::onExecDetailsEnd(Subs& subs, const OJson& a) {
    auto* p = subs.get(argNum(a, 0));
    if (!p) return;
    auto sub = *p;
    if (!sub->lastAllValue.has_value()) {
        Upd u;
        u.all = std::make_shared<JsList>();
        sub->next(u);
    }
    sub->complete();
}

}  // namespace ibkr::execution::ibnext
