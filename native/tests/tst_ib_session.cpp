// ib_session(ibSession.ts 的 createIbApiNextSession 跑在 @stoqey/ib 的 IBApiNext 上)的对拍。
// 期望值:tests/fixtures/gen_ib_session.mjs(原模块现跑,假 TWS 在 socket 层、假钟)。这里用同样的假钟、同样事件次序的假 socket,
// 把同样的脚本放一遍,逐步比:TWS 收到的每一条(按字段)、socket 层的动作、回调、结果、日志、到点的计时器。
// 全部离线:假 socket 不开任何端口;会话只连 "127.0.0.1:7497" 这个名字,真的 socket 从来不建。
#include "execution/ib_session.h"
#include "js_fixture.h"
#include "util/jsformat.h"
#include "util/jsvalue.h"

#include <QTcpServer>
#include <QTcpSocket>
#include <QtEndian>
#include <QTest>

#include <deque>
#include <list>
#include <map>

using namespace ibkr;
using namespace ibkr::execution;
using namespace Qt::StringLiterals;
using util::OJson;
namespace js = util::js;

namespace {

const OJson& fixture() {
    static const OJson f = jsfix::load(u"ib_session.json"_s);
    return f;
}
const OJson& at(const OJson& o, const QString& k) {
    static const OJson nothing;
    const OJson* v = o.get(k);
    return v ? *v : nothing;
}
bool isUndefMark(const OJson& v) { return v.type == OJson::String && v.s == u"__undefined__"; }
/// 夹具里的参数表:占位串换回值,"__undefined__" 当作空指针
struct Args {
    QList<OJson> vals;
    QList<bool> undef;
    explicit Args(const OJson& arr) {
        for (const OJson& x : arr.items) {
            undef.append(isUndefMark(x));
            vals.append(jsfix::dec(x));
        }
    }
    const OJson* operator[](int i) const { return i < vals.size() && !undef[i] ? &vals[i] : nullptr; }
};

std::optional<double> optNum(const OJson* v) {
    if (!v || v->type == OJson::Null) return std::nullopt;
    return jsfix::dec(*v).n;
}
std::optional<QString> optStr(const OJson* v) {
    if (!v || v->type != OJson::String) return std::nullopt;
    return v->s;
}

IbContract contractFrom(const OJson& raw) {
    const OJson c = jsfix::dec(raw);
    IbContract out;
    out.secType = js::strOr(c.get(u"secType"_s), QString());
    out.symbol = js::strOr(c.get(u"symbol"_s), QString());
    out.exchange = js::strOr(c.get(u"exchange"_s), QString());
    out.currency = js::strOr(c.get(u"currency"_s), QString());
    out.lastTradeDateOrContractMonth = optStr(c.get(u"lastTradeDateOrContractMonth"_s));
    out.strike = optNum(c.get(u"strike"_s));
    out.right = optStr(c.get(u"right"_s));
    out.multiplier = optStr(c.get(u"multiplier"_s));
    out.tradingClass = optStr(c.get(u"tradingClass"_s));
    if (const auto id = optNum(c.get(u"conId"_s))) out.conId = static_cast<int>(*id);
    if (const OJson* legs = c.get(u"comboLegs"_s); legs && legs->isArray()) {
        out.hasComboLegs = true;
        for (const OJson& l : legs->items)
            out.comboLegs.push_back({static_cast<int>(js::num(l.get(u"conId"_s))), js::num(l.get(u"ratio"_s)), js::str(l.get(u"action"_s)), js::str(l.get(u"exchange"_s))});
    }
    out.includeExpired = js::truthy(c.get(u"includeExpired"_s));
    return out;
}

OrderIntent intentFrom(const OJson& raw) {
    const OJson o = jsfix::dec(raw);
    OrderIntent i;
    i.orderType = js::str(o.get(u"orderType"_s));
    i.action = js::str(o.get(u"action"_s));
    i.totalQuantity = js::num(o.get(u"totalQuantity"_s));
    i.lmtPrice = optNum(o.get(u"lmtPrice"_s));
    i.auxPrice = optNum(o.get(u"auxPrice"_s));
    i.trailingPercent = optNum(o.get(u"trailingPercent"_s));
    i.tif = js::str(o.get(u"tif"_s));
    i.outsideRth = js::truthy(o.get(u"outsideRth"_s));
    i.account = js::str(o.get(u"account"_s));
    i.transmit = js::truthy(o.get(u"transmit"_s));
    i.orderRef = optStr(o.get(u"orderRef"_s));
    if (const OJson* c = o.get(u"conditions"_s); c && c->isArray())
        for (const OJson& x : c->items) i.conditions.push_back(x);
    if (const OJson* v = o.get(u"conditionsCancelOrder"_s); v && v->type == OJson::Bool) i.conditionsCancelOrder = v->b;
    i.ocaGroup = js::strOr(o.get(u"ocaGroup"_s), QString());
    if (const auto t = optNum(o.get(u"ocaType"_s))) i.ocaType = static_cast<int>(*t);
    i.trailStopPrice = optNum(o.get(u"trailStopPrice"_s));
    if (const auto id = optNum(o.get(u"orderId"_s))) i.orderId = static_cast<int>(*id);
    return i;
}

OJson optJ(const std::optional<double>& v) { return v ? OJson::number(*v) : OJson::null(); }

/// TickerData → 同 TS 对象的键序(emptyTicker 的次序)
OJson tickerJson(const TickerData& d) {
    OJson g = OJson::null();
    if (d.modelGreeks) g = js::object({{u"gamma"_s, optJ(d.modelGreeks->gamma)}, {u"impliedVol"_s, optJ(d.modelGreeks->impliedVol)}, {u"optPrice"_s, optJ(d.modelGreeks->optPrice)}});
    return js::object({
        {u"bid"_s, js::N(d.bid)}, {u"ask"_s, js::N(d.ask)}, {u"last"_s, optJ(d.last)}, {u"close"_s, optJ(d.close)}, {u"bidSize"_s, optJ(d.bidSize)},
        {u"askSize"_s, optJ(d.askSize)}, {u"marketPrice"_s, optJ(d.marketPrice)}, {u"callOpenInterest"_s, optJ(d.callOpenInterest)},
        {u"putOpenInterest"_s, optJ(d.putOpenInterest)}, {u"callVolume"_s, optJ(d.callVolume)}, {u"putVolume"_s, optJ(d.putVolume)}, {u"modelGreeks"_s, g},
        {u"error"_s, d.error ? js::S(*d.error) : OJson::null()}, {u"open"_s, optJ(d.open)}, {u"high"_s, optJ(d.high)}, {u"low"_s, optJ(d.low)},
        {u"volume"_s, optJ(d.volume)}, {u"avgVolume"_s, optJ(d.avgVolume)}, {u"histVol"_s, optJ(d.histVol)}, {u"vol3m"_s, optJ(d.vol3m)},
        {u"vol5m"_s, optJ(d.vol5m)}, {u"vol10m"_s, optJ(d.vol10m)}, {u"lastTradeAt"_s, optJ(d.lastTradeAt)}, {u"delayed"_s, js::B(d.delayed)},
        {u"requestedAt"_s, optJ(d.requestedAt)}, {u"quotedAt"_s, optJ(d.quotedAt)},
    });
}

TickerData tickerFrom(const OJson& raw) {
    const OJson o = jsfix::dec(raw);
    TickerData d;
    d.bid = js::num(o.get(u"bid"_s));
    d.ask = js::num(o.get(u"ask"_s));
    auto f = [&](const char* k) { return optNum(o.get(QString::fromLatin1(k))); };
    d.last = f("last");
    d.close = f("close");
    d.marketPrice = f("marketPrice");
    d.requestedAt = f("requestedAt");
    d.delayed = js::truthy(o.get(u"delayed"_s));
    if (const OJson* g = o.get(u"modelGreeks"_s); g && g->isObject()) d.modelGreeks = ModelGreeks{optNum(g->get(u"gamma"_s)), optNum(g->get(u"impliedVol"_s)), optNum(g->get(u"optPrice"_s))};
    return d;
}

OJson heldJson(const HeldPosition& h) {
    OJson o = js::object({{u"account"_s, js::S(h.account)}});
    if (h.contract) o.set(u"contract"_s, *h.contract);
    o.set(u"pos"_s, js::N(h.pos));
    o.set(u"avgCost"_s, js::N(h.avgCost));
    return o;
}

std::shared_ptr<ibnext::AccountPositions> accountsFrom(const OJson& entries) {
    auto m = std::make_shared<ibnext::AccountPositions>();
    for (const OJson& e : entries.items) {
        QList<OJson> list;
        for (const OJson& p : e.items[1].items) list.append(jsfix::dec(p));
        m->set(e.items[0].s, list);
    }
    return m;
}

std::shared_ptr<ibnext::MarketData> ticksFrom(const OJson* entries) {
    if (!entries) return nullptr;
    auto m = std::make_shared<ibnext::MarketData>();
    for (const OJson& e : entries->items) {
        ibnext::TickVal v;
        if (!isUndefMark(e.items[1])) v.value = jsfix::dec(e.items[1]).n;
        m->set(e.items[0].n, v);
    }
    return m;
}

OJson resolvedJson(const ResolvedContract& r) {
    return js::object({{u"conId"_s, js::N(r.conId)}, {u"exchange"_s, js::S(r.exchange)}, {u"tradingClass"_s, js::S(r.tradingClass)}});
}

/// 期望 {out} / {error} 与实际值比
bool expectOut(const OJson& c, const OJson& got, const QString& what) {
    if (c.get(u"error"_s)) {
        QTest::qFail(qPrintable(u"%1:TS 抛了 %2"_s.arg(what, c.get(u"error"_s)->s)), __FILE__, __LINE__);
        return false;
    }
    return jsfix::same(at(c, u"out"_s), got, what);
}

// ================================================================ 假钟、假 socket、放脚本

class FakeRuntime : public ibnext::Runtime {
public:
    explicit FakeRuntime(double t0) : t0_(t0) {}
    double now() override { return t0_ + clock; }
    quint64 setTimeout(double ms, std::function<void()> fn) override {
        Timer t{++seq_, ibnext::nodeDelay(ms), 0, std::move(fn), false};
        t.due = clock + t.ms;
        timers_.push_back(std::make_shared<Timer>(std::move(t)));
        return seq_;
    }
    void clearTimeout(quint64 id) override {
        for (auto& t : timers_)
            if (t->seq == id) t->cleared = true;
    }
    /// 时间往前走:到点的按 (到点时刻, 先后) 一个个跑,每个之后让 I/O 落地
    void advance(double ms, const std::function<void(double)>& fired, const std::function<void()>& settle) {
        const double target = clock + ms;
        for (;;) {
            std::erase_if(timers_, [](const auto& t) { return t->cleared; });
            std::shared_ptr<Timer> next;
            for (const auto& t : timers_)
                if (t->due <= target && (!next || t->due < next->due || (t->due == next->due && t->seq < next->seq))) next = t;
            if (!next) break;
            std::erase(timers_, next);
            clock = next->due;
            fired(next->ms);
            runMacrotask(next->fn);
            settle();
        }
        clock = target;
    }
    double clock = 0;

private:
    struct Timer {
        quint64 seq;
        double ms, due;
        std::function<void()> fn;
        bool cleared;
    };
    double t0_;
    quint64 seq_ = 0;
    std::vector<std::shared_ptr<Timer>> timers_;
};

class Harness;

class FakeSocket : public ibnext::NodeSocket {
public:
    FakeSocket(Harness* h, Handlers handlers, QString host, double port) : h_(h), handlers(std::move(handlers)), host(std::move(host)), port(port) {}
    void write(const QByteArray& bytes) override;
    void end() override;
    void destroy() override;
    void closeSoon();

    Harness* h_;
    Handlers handlers;
    QString host;
    double port;
    bool destroyed = false, localDestroyed = false, remoteEnded = false, closeQueued = false, handshaken = false;
    QByteArray buf;
};

class Harness {
public:
    explicit Harness(const OJson& sc) : sc_(sc), rt_(std::make_shared<FakeRuntime>(at(fixture(), u"T0"_s).n)) {
        for (const OJson& h : at(sc, u"history"_s).items) history_.push_back(h);
    }

    OJson step;
    /// 在回调里销毁会话的探针(destroyOnNext):回调返回之后、这一拍宏任务收尾的时候,库那一层还得活着(被钉住)
    int apiNextBase = int(ibnext::LiveCounts::apiNext);
    bool destroyOnNext = false, probed = false, probeAlive = false;
    /// 下单 / 撤单失败时抛的是不是 LinkDownError 这个类型(托管 / 追价那几处按类型认,不按话)
    int linkDownTyped = 0, linkDownUntyped = 0;
    std::deque<std::function<void()>> io;
    QList<QStringList> frames;
    QString unmodelled;

    void rec(const QString& key, const OJson& v) {
        OJson* list = step.get(key);
        if (!list) {
            step.set(key, js::array());
            list = step.get(key);
        }
        list->items.append(v);
    }
    void settle() {
        while (!io.empty()) {
            auto f = std::move(io.front());
            io.pop_front();
            f();
        }
    }

    bool run(QString* failure, bool compare = true) {
        const OJson& steps = at(sc_, u"steps"_s);
        const OJson& trace = at(sc_, u"trace"_s);
        for (qsizetype i = 0; i < steps.items.size(); ++i) {
            step = js::object();
            doStep(steps.items[i]);
            settle();
            if (!unmodelled.isEmpty()) {
                *failure = u"走到了假 socket 没建模的路径:"_s + unmodelled;
                return false;
            }
            if (!compare) continue;
            const OJson& want = trace.items[i];
            QStringList keys;
            for (const auto& [k, v] : want.fields) keys.append(k);
            for (const auto& [k, v] : step.fields)
                if (!keys.contains(k)) keys.append(k);
            for (const QString& k : keys) {
                const OJson w = want.get(k) ? *want.get(k) : js::array();
                const OJson g = step.get(k) ? *step.get(k) : js::array();
                const QString ws = js::stringify(jsfix::stripUndefined(w)), gs = js::stringify(jsfix::enc(g));
                if (ws != gs) {
                    *failure = u"第 %1 步 %2 的「%3」不同\n  TS :%4\n  C++:%5"_s.arg(QString::number(i), js::stringify(steps.items[i]).left(300), k, ws.left(1500), gs.left(1500));
                    return false;
                }
            }
        }
        return true;
    }
    ~Harness() {
        io.clear();
        session_.reset();
    }

    /// 调用方放手(会话销毁)之后:不许有人还拿着它,也不许再有任何回调、请求、socket 动作从它那里出来。
    /// 放手之后先让时间走 120 秒(还在等 8 秒持仓、10 秒确认的协程帧到点才放手),再对所有 socket 补送各种事件、再走一段时间
    bool afterlife(QString* failure) {
        handles_.clear();  // 句柄拿着会话(强引用),放手前先清;撤单的闭包只拿弱引用,留着:放手之后再叫它,必须什么都不做
        std::weak_ptr<IbSession> weak = session_;
        session_.reset();
        rt_->advance(120000, [](double) {}, [this] { settle(); });
        settle();
        if (!weak.expired()) {
            *failure = u"调用方放手 120 秒之后,还有人拿着会话(订阅表 / 协程帧 / 回调里有一条强引用的环)"_s;
            return false;
        }
        step = js::object();
        for (auto& [id, list] : trades_)
            for (OpenTrade& t : list)
                if (t.cancel) t.cancel();  // 会话没了:空操作,不崩、不发撤单
        trades_.clear();
        QByteArray bytes;
        for (const OJson& m : {js::array({js::S(u"193"_s), js::S(u"20261020 10:00:00 Asia/Shanghai"_s)}), js::array({js::S(u"15"_s), js::S(u"1"_s), js::S(u"U1234567"_s)}),
                               js::array({js::S(u"9"_s), js::S(u"1"_s), js::S(u"5"_s)}),
                               js::array({js::S(u"4"_s), js::S(u"2"_s), js::S(u"-1"_s), js::S(u"1100"_s), js::S(u"lost"_s), js::S(QString())}),
                               js::array({js::S(u"4"_s), js::S(u"2"_s), js::S(u"7"_s), js::S(u"201"_s), js::S(u"rejected"_s), js::S(QString())})})
            bytes += frameBytes(m);
        for (const auto& sock : sockets_) {
            const auto& h = sock->handlers;
            if (h.connect) h.connect();
            if (h.data) h.data(bytes);
            if (h.end) h.end();
            if (h.error) h.error(u"read ECONNRESET"_s);
            if (h.close) h.close();
        }
        settle();
        rt_->advance(120000, [](double) {}, [this] { settle(); });
        settle();
        if (!step.fields.isEmpty()) {
            *failure = u"会话销毁之后还有东西出来:"_s + js::stringify(step).left(600);
            return false;
        }
        return true;
    }

    std::shared_ptr<ibnext::NodeSocket> makeSocket(const QString& host, double port, ibnext::NodeSocket::Handlers h) {
        auto s = std::make_shared<FakeSocket>(this, std::move(h), host, port);
        sockets_.push_back(s);
        rec(u"io"_s, js::array({js::S(u"connect"_s), js::S(host), js::N(port)}));
        return s;
    }

private:
    QString resolveField(const OJson& x) {
        if (x.type != OJson::String) return js::str(&x);
        if (!x.s.startsWith(u"$f:"_s)) return x.s;
        const QStringList parts = x.s.split(u':');
        const QString msg = parts.value(1);
        const int idx = parts.value(2).toInt();
        const int k = parts.size() > 3 ? parts.value(3).toInt() : 0;
        QList<QStringList> hits;
        for (const QStringList& f : frames)
            if (f.value(0) == msg) hits.append(f);
        const qsizetype n = hits.size() - 1 - k;
        if (n < 0) {
            unmodelled = u"占位 "_s + x.s + u" 指向的请求还没发过"_s;
            return QString();
        }
        return hits[n].value(idx);
    }
    QByteArray frameBytes(const OJson& fields) {
        QString text;
        for (const OJson& f : fields.items) text += resolveField(f) + QChar(u'\0');
        const QByteArray payload = util::toNodeUtf8(text);
        char len[4];
        qToBigEndian<quint32>(static_cast<quint32>(payload.size()), len);
        return QByteArray(len, 4) + payload;
    }
    FakeSocket* live() { return sockets_.empty() ? nullptr : sockets_.back().get(); }

    void doStep(const OJson& st) {
        const QString op = js::str(st.get(u"op"_s));
        if (op == u"call") return call(st);
        if (op == u"advance") {
            rt_->advance(js::num(st.get(u"ms"_s)), [this](double ms) { rec(u"fired"_s, js::N(ms)); }, [this] { settle(); });
            return;
        }
        FakeSocket* s = live();
        if (!s) {
            unmodelled = u"没有 socket"_s;
            return;
        }
        if (op == u"accept") {
            if (!s->destroyed && s->handlers.connect) s->handlers.connect();
        } else if (op == u"refuse") {
            s->destroyed = true;
            s->handlers.error(u"connect ECONNREFUSED %1:%2"_s.arg(s->host, util::jsNumberToString(s->port)));
            s->closeSoon();
        } else if (op == u"send") {
            QByteArray bytes;
            for (const OJson& m : at(st, u"msgs"_s).items) bytes += frameBytes(m);
            if (!s->destroyed) s->handlers.data(bytes);
            for (const OJson& t : at(st, u"then"_s).items) call(t);
        } else if (op == u"sendFill") {
            QByteArray b(static_cast<qsizetype>(js::num(st.get(u"len"_s))), '\0');
            qToBigEndian<qint32>(0x7fffffff, b.data());
            if (!s->destroyed) s->handlers.data(b);
        } else if (op == u"multi") {
            for (const OJson& t : at(st, u"steps"_s).items) call(t);
        } else if (op == u"sendRaw") {
            if (!s->destroyed) s->handlers.data(QByteArray::fromHex(js::str(st.get(u"hex"_s)).toLatin1()));
        } else if (op == u"end") {
            if (s->destroyed) return;
            s->remoteEnded = true;
            s->destroyed = true;
            s->handlers.end();
            s->closeSoon();
        } else if (op == u"reset") {
            if (s->destroyed) return;
            s->destroyed = true;
            s->handlers.error(u"read ECONNRESET"_s);
            s->closeSoon();
        } else {
            unmodelled = u"不认识的步骤 "_s + op;
        }
    }

    void result(double id, const OJson& v) { rec(u"res"_s, js::array({js::N(id), js::S(u"ok"_s), v})); }
    void failed(double id, const QString& m) { rec(u"res"_s, js::array({js::N(id), js::S(u"err"_s), js::S(m)})); }
    template <class T>
    void later(double id, Task<T> t, std::function<OJson(const T&)> fmt) {
        t.onDone([this, id, t, fmt] {
            try {
                if constexpr (std::is_void_v<T>) {
                    t.result();
                    result(id, OJson::null());
                } else {
                    result(id, fmt(t.result()));
                }
            } catch (const LinkDownError& e) {
                ++linkDownTyped;
                failed(id, e.message());
            } catch (const util::JsError& e) {
                noteUntyped(e);
                failed(id, e.message());
            }
        });
    }
    void laterVoid(double id, Task<> t) {
        t.onDone([this, id, t] {
            try {
                t.result();
                result(id, OJson::null());
            } catch (const LinkDownError& e) {
                ++linkDownTyped;
                failed(id, e.message());
            } catch (const util::JsError& e) {
                noteUntyped(e);
                failed(id, e.message());
            }
        });
    }
    /// 话同 LinkDownError 却不是这个类型的(positions() 在 TS 里就抛普通 Error,同一句话)
    void noteUntyped(const util::JsError& e) {
        if (e.message() == LinkDownError().message()) ++linkDownUntyped;
    }

    void call(const OJson& st) {
        const double id = js::num(st.get(u"id"_s));
        const QString m = js::str(st.get(u"m"_s));
        const OJson& a = at(st, u"a"_s);
        auto arg = [&](int i) -> const OJson& { return a.items[i]; };
        ibnext::Runtime::Scope scope(*rt_);
        if (m == u"create") {
            SessionConfig cfg;
            cfg.host = js::str(arg(0).get(u"host"_s));
            cfg.port = static_cast<int>(js::num(arg(0).get(u"port"_s)));
            cfg.clientId = static_cast<int>(js::num(arg(0).get(u"clientId"_s)));
            cfg.readonly = js::truthy(arg(0).get(u"readonly"_s));
            IbSessionDeps deps;
            deps.runtime = rt_;
            deps.sockets = [this](const QString& host, double port, ibnext::NodeSocket::Handlers h) { return makeSocket(host, port, std::move(h)); };
            deps.fetchHistory = [this](HistoryRequest r) { return fetchHistory(std::move(r)); };
            deps.log = [this](const QString& line) { rec(u"log"_s, js::S(line)); };
            Task<std::shared_ptr<IbSession>> t = createIbApiNextSession(cfg, deps);
            t.onDone([this, id, t] {
                try {
                    session_ = t.result();
                } catch (const util::JsError& e) {
                    failed(id, e.message());
                    return;
                }
                session_->onConnectivity([this](int c) {
                    rec(u"cb"_s, js::array({js::S(u"conn"_s), js::N(c)}));
                    if (!destroyOnNext) return;
                    destroyOnNext = false;
                    handles_.clear();
                    session_.reset();  // 调用方在回调里把最后一份引用丢了
                    rt_->queueMicrotask([this] {
                        probed = true;
                        probeAlive = int(ibnext::LiveCounts::apiNext) > apiNextBase;
                    });
                });
                session_->onLink([this](bool up) { rec(u"cb"_s, js::array({js::S(u"link"_s), js::B(up)})); });
                session_->onOrderStatus([this](const OJson& t) { rec(u"cb"_s, js::array({js::S(u"status"_s), t})); });
                session_->onFill([this](const OJson& t, const OJson& f) { rec(u"cb"_s, js::array({js::S(u"fill"_s), t, f})); });
                session_->onCommission([this](const OJson& t, const OJson& f, const OJson& r) { rec(u"cb"_s, js::array({js::S(u"comm"_s), t, f, r})); });
                tokens_[u"main"_s] = session_->onError([this](int r, int c, const QString& msg) { rec(u"cb"_s, js::array({js::S(u"err"_s), js::N(r), js::N(c), js::S(msg)})); });
                result(id, OJson::null());
            });
            return;
        }
        IbSession& s = *session_;
        if (m == u"destroyOnNext") {
            destroyOnNext = true;
        } else if (m == u"onSecond") {
            s.onConnectivity([this](int c) { rec(u"cb"_s, js::array({js::S(u"conn2"_s), js::N(c)})); });
            s.onLink([this](bool up) { rec(u"cb"_s, js::array({js::S(u"link2"_s), js::B(up)})); });
            s.onOrderStatus([this](const OJson& t) { rec(u"cb"_s, js::array({js::S(u"status2"_s), t})); });
            s.onFill([this](const OJson& t, const OJson& f) { rec(u"cb"_s, js::array({js::S(u"fill2"_s), t, f})); });
            s.onCommission([this](const OJson& t, const OJson& f, const OJson& r) { rec(u"cb"_s, js::array({js::S(u"comm2"_s), t, f, r})); });
        } else if (m == u"onError2") {
            tokens_[u"e2"_s] = s.onError([this](int r, int c, const QString& msg) { rec(u"cb"_s, js::array({js::S(u"err2"_s), js::N(r), js::N(c), js::S(msg)})); });
        } else if (m == u"offError") {
            s.offError(tokens_[arg(0).s]);
        } else if (m == u"read") {
            result(id, tickerJson(handles_.at(arg(0).n)->read()));
        } else if (m == u"cancelTrade") {
            trades_.at(arg(0).n).at(static_cast<std::size_t>(arg(1).n)).cancel();
        } else if (m == u"subscribeTicker") {
            handles_[id] = a.items.size() > 1 ? s.subscribeTicker(contractFrom(arg(0)), arg(1).s) : s.subscribeTicker(contractFrom(arg(0)));
            result(id, OJson::null());
        } else if (m == u"cancelTicker") {
            if (a.items.size() > 1) s.cancelTicker(contractFrom(arg(0)), arg(1).s);
            else s.cancelTicker(contractFrom(arg(0)));
            result(id, OJson::null());
        } else if (m == u"isConnected") {
            result(id, js::B(s.isConnected()));
        } else if (m == u"managedAccounts") {
            result(id, js::strings(s.managedAccounts()));
        } else if (m == u"quoteDelayed") {
            const auto v = s.quoteDelayed(contractFrom(arg(0)));
            result(id, v ? js::B(*v) : OJson::null());
        } else if (m == u"accountPnl") {
            const auto p = s.accountPnl(arg(0).s);
            result(id, p ? js::object({{u"daily"_s, optJ(p->daily)}, {u"unrealized"_s, optJ(p->unrealized)}, {u"realized"_s, optJ(p->realized)},
                                       {u"atMs"_s, js::N(p->atMs)}, {u"currency"_s, js::S(p->currency)}})
                         : OJson::null());
        } else if (m == u"netLiquidation") {
            const auto n = s.netLiquidation(arg(0).s);
            result(id, n ? js::object({{u"amount"_s, js::N(n->amount)}, {u"currency"_s, js::S(n->currency)}}) : OJson::null());
        } else if (m == u"reqMarketDataType") {
            s.reqMarketDataType(static_cast<int>(arg(0).n));
            result(id, OJson::null());
        } else if (m == u"setBaselineMarketDataType") {
            s.setBaselineMarketDataType(static_cast<int>(arg(0).n));
            result(id, OJson::null());
        } else if (m == u"positions") {
            later<std::vector<PositionItemLike>>(id, s.positions(), [](const std::vector<PositionItemLike>& list) {
                OJson out = js::array();
                for (const auto& p : list) out.items.append(js::object({{u"contract"_s, p.contract}, {u"position"_s, js::N(p.position)}, {u"avgCost"_s, js::N(p.avgCost)}}));
                return out;
            });
        } else if (m == u"qualifyContracts") {
            auto& list = qualified_.emplace_back();
            for (const OJson& c : arg(0).items) list.push_back(contractFrom(c));
            std::vector<IbContract*> ptrs;
            for (auto& c : list) ptrs.push_back(&c);
            std::vector<IbContract>* listPtr = &list;
            Task<> t = s.qualifyContracts(ptrs, static_cast<int>(arg(1).n));
            t.onDone([this, id, t, listPtr] {
                try {
                    t.result();
                } catch (const util::JsError& e) {
                    failed(id, e.message());
                    return;
                }
                OJson out = js::array();
                for (const auto& c : *listPtr)
                    out.items.append(js::object({{u"conId"_s, c.conId ? js::N(*c.conId) : OJson::null()},
                                                 {u"exchange"_s, js::S(c.exchange)},
                                                 {u"tradingClass"_s, c.tradingClass ? js::S(*c.tradingClass) : OJson::null()}}));
                result(id, out);
            });
        } else if (m == u"contractHours") {
            later<std::optional<std::array<QString, 3>>>(id, s.contractHours(contractFrom(arg(0)), static_cast<int>(arg(1).n)), [](const auto& v) {
                return v ? js::array({js::S((*v)[0]), js::S((*v)[1]), js::S((*v)[2])}) : OJson::null();
            });
        } else if (m == u"historicalData") {
            HistoricalRequest r;
            r.endDateTime = js::str(arg(1).get(u"endDateTime"_s));
            r.durationStr = js::str(arg(1).get(u"durationStr"_s));
            r.barSizeSetting = js::str(arg(1).get(u"barSizeSetting"_s));
            r.whatToShow = js::str(arg(1).get(u"whatToShow"_s));
            r.useRTH = js::truthy(arg(1).get(u"useRTH"_s));
            later<std::vector<RawBar>>(id, s.historicalData(contractFrom(arg(0)), r), [](const std::vector<RawBar>& bars) {
                OJson out = js::array();
                for (const auto& b : bars)
                    out.items.append(js::object({{u"date"_s, js::S(b.date)}, {u"open"_s, js::N(b.open)}, {u"high"_s, js::N(b.high)}, {u"low"_s, js::N(b.low)},
                                                 {u"close"_s, js::N(b.close)}, {u"volume"_s, optJ(b.volume)}}));
                return out;
            });
        } else if (m == u"secDefOptParams") {
            later<std::vector<OptChainParam>>(id, s.secDefOptParams(arg(0).s, arg(1).s, static_cast<int>(arg(2).n)), [](const std::vector<OptChainParam>& list) {
                OJson out = js::array();
                for (const auto& p : list) {
                    OJson strikes = js::array();
                    for (double k : p.strikes) strikes.items.append(js::N(k));
                    out.items.append(js::object({{u"exchange"_s, js::S(p.exchange)}, {u"tradingClass"_s, js::S(p.tradingClass)},
                                                 {u"expirations"_s, js::strings(p.expirations)}, {u"strikes"_s, strikes}}));
                }
                return out;
            });
        } else if (m == u"mktDepth") {
            later<Depth>(id, s.mktDepth(contractFrom(arg(0)), static_cast<int>(arg(1).n), static_cast<int>(arg(2).n)), [](const Depth& d) {
                auto side = [](const std::vector<DepthRow>& rows) {
                    OJson o = js::array();
                    for (const auto& r : rows) o.items.append(js::object({{u"price"_s, js::N(r.price)}, {u"size"_s, js::N(r.size)}}));
                    return o;
                };
                return js::object({{u"bids"_s, side(d.bids)}, {u"asks"_s, side(d.asks)}});
            });
        } else if (m == u"placeOrder") {
            later<TradeLike>(id, s.placeOrder(contractFrom(arg(0)), intentFrom(arg(1))), [](const TradeLike& t) {
                return js::object({{u"orderId"_s, t.orderId ? js::N(*t.orderId) : OJson::null()}, {u"permId"_s, t.permId ? js::N(*t.permId) : OJson::null()},
                                   {u"status"_s, js::S(t.status)}});
            });
        } else if (m == u"cancelOrder") {
            try {
                laterVoid(id, s.cancelOrder(static_cast<int>(arg(0).n)));
            } catch (const LinkDownError& e) {  // 同步抛(同 TS 的 cancelOrder)
                ++linkDownTyped;
                failed(id, e.message());
            } catch (const util::JsError& e) {
                noteUntyped(e);
                failed(id, e.message());
            }
        } else if (m == u"disconnect") {
            laterVoid(id, s.disconnect());
        } else if (m == u"openTrades") {
            Task<std::vector<OpenTrade>> t = s.openTrades();
            t.onDone([this, id, t] {
                try {
                    const auto list = t.result();
                    trades_[id] = list;
                    OJson out = js::array();
                    for (const auto& x : list) out.items.append(js::object({{u"orderId"_s, x.orderId ? js::N(*x.orderId) : OJson::null()}}));
                    result(id, out);
                } catch (const util::JsError& e) {
                    failed(id, e.message());
                }
            });
        } else if (m == u"openTradesDetailed") {
            later<std::vector<OpenTradeDetail>>(id, s.openTradesDetailed(), [](const std::vector<OpenTradeDetail>& list) {
                OJson out = js::array();
                for (const auto& d : list) {
                    const IbContract& c = d.contract;
                    OJson cj = js::object({{u"secType"_s, js::S(c.secType)}, {u"symbol"_s, js::S(c.symbol)}, {u"exchange"_s, js::S(c.exchange)},
                                           {u"currency"_s, js::S(c.currency)}, {u"conId"_s, js::N(c.conId.value_or(0))}});
                    if (c.lastTradeDateOrContractMonth) cj.set(u"lastTradeDateOrContractMonth"_s, js::S(*c.lastTradeDateOrContractMonth));
                    if (c.strike) cj.set(u"strike"_s, js::N(*c.strike));
                    if (c.right) cj.set(u"right"_s, js::S(*c.right));
                    if (c.multiplier) cj.set(u"multiplier"_s, js::S(*c.multiplier));
                    if (c.tradingClass) cj.set(u"tradingClass"_s, js::S(*c.tradingClass));
                    auto oi = [](const std::optional<int>& v) { return v ? js::N(*v) : OJson::null(); };
                    out.items.append(js::object({
                        {u"orderId"_s, oi(d.orderId)}, {u"permId"_s, oi(d.permId)}, {u"orderRef"_s, js::S(d.orderRef)}, {u"account"_s, js::S(d.account)},
                        {u"action"_s, js::S(d.action)}, {u"orderType"_s, js::S(d.orderType)}, {u"totalQuantity"_s, js::N(d.totalQuantity)},
                        {u"lmtPrice"_s, optJ(d.lmtPrice)}, {u"auxPrice"_s, optJ(d.auxPrice)}, {u"trailingPercent"_s, optJ(d.trailingPercent)},
                        {u"status"_s, js::S(d.status)}, {u"ocaGroup"_s, js::S(d.ocaGroup)}, {u"ocaType"_s, oi(d.ocaType)}, {u"tif"_s, js::S(d.tif)},
                        {u"outsideRth"_s, js::B(d.outsideRth)}, {u"contract"_s, cj},
                    }));
                }
                return out;
            });
        } else if (m == u"executions") {
            later<std::vector<ExecutionRow>>(id, s.executions(), [](const std::vector<ExecutionRow>& rows) {
                OJson out = js::array();
                for (const auto& r : rows) out.items.append(js::object({{u"contract"_s, r.contract}, {u"execution"_s, r.execution}}));
                return out;
            });
        } else if (m == u"executionHistory") {
            later<std::optional<std::vector<ExecutionRow>>>(id, s.executionHistory(static_cast<int>(arg(0).n)), [](const auto& rows) {
        } else if (m == u"wsh") {
            later<QString>(id,s.wshEvents(u"{}"_s,u"20250101"_s,u"20261023"_s),[](const QString& value){return js::S(value);});
                if (!rows) return OJson::null();
                OJson out = js::array();
                for (const auto& r : *rows) out.items.append(js::object({{u"contract"_s, r.contract}, {u"execution"_s, r.execution}}));
                return out;
            });
        } else {
            unmodelled = u"不认识的方法 "_s + m;
        }
    }

    Task<HistoryResult> fetchHistory(HistoryRequest r) {
        rec(u"io"_s, js::array({js::S(u"history"_s), js::S(r.host), js::N(r.port), js::N(r.clientId), js::N(r.days)}));
        const OJson h = history_.empty() ? js::object({{u"error"_s, js::S(u"没有准备回话"_s)}}) : history_.front();
        if (!history_.empty()) history_.pop_front();
        if (const OJson* e = h.get(u"error"_s)) throw util::JsError(e->s);
        HistoryResult out;
        out.serverVersion = js::num(h.get(u"serverVersion"_s));
        out.supported = js::truthy(h.get(u"supported"_s));
        for (const OJson& d : at(h, u"details"_s).items) out.details.push_back({at(d, u"contract"_s), at(d, u"execution"_s)});
        co_return out;
    }

    const OJson& sc_;
    std::shared_ptr<FakeRuntime> rt_;
    std::deque<OJson> history_;
    std::vector<std::shared_ptr<FakeSocket>> sockets_;
    std::shared_ptr<IbSession> session_;
    std::map<double, std::shared_ptr<TickerHandle>> handles_;
    std::map<double, std::vector<OpenTrade>> trades_;
    std::map<QString, ListenerToken> tokens_;
    std::list<std::vector<IbContract>> qualified_;
};

void FakeSocket::write(const QByteArray& bytes) {
    if (remoteEnded && !localDestroyed) h_->unmodelled = u"write after remote end"_s;
    if (destroyed) return;
    buf += bytes;
    for (;;) {
        if (!handshaken) {
            if (buf.size() < 8) return;
            const quint32 n = qFromBigEndian<quint32>(buf.constData() + 4);
            if (buf.size() < 8 + static_cast<qsizetype>(n)) return;
            const QStringList f{u"HS"_s, QString::fromLatin1(buf.left(4)), util::nodeUtf8(buf.mid(8, n))};
            buf.remove(0, 8 + n);
            handshaken = true;
            h_->frames.append(f);
            h_->rec(u"sent"_s, js::strings(f));
            continue;
        }
        if (buf.size() < 4) return;
        const quint32 n = qFromBigEndian<quint32>(buf.constData());
        if (buf.size() < 4 + static_cast<qsizetype>(n)) return;
        QStringList fields = util::nodeUtf8(buf.mid(4, n)).split(QChar(u'\0'));
        if (fields.last().isEmpty()) fields.removeLast();
        else h_->unmodelled = u"frame without trailing NUL"_s;
        buf.remove(0, 4 + n);
        h_->frames.append(fields);
        h_->rec(u"sent"_s, js::strings(fields));
    }
}
void FakeSocket::end() { h_->rec(u"io"_s, js::array({js::S(u"end"_s)})); }
void FakeSocket::destroy() {
    h_->rec(u"io"_s, js::array({js::S(u"destroy"_s)}));
    destroyed = true;
    localDestroyed = true;
    closeSoon();
}
void FakeSocket::closeSoon() {
    if (closeQueued) return;
    closeQueued = true;
    auto close = handlers.close;
    h_->io.push_back([close] {
        if (close) close();
    });
}

}  // namespace

class TestIbSession : public QObject {
    Q_OBJECT

private slots:
    void tickTypeTable() {
        // applyTicks 认的号与库里的两张枚举表一致(T1 ?? T2)
    void metadataDoesNotTriggerPriceListener() {
        const auto* all=fixture().get(u"scenarios"_s);
        for(bool price : {false,true}) {
            OJson steps=js::array();
            for(int i=0;i<5;++i)steps.items.append(all->items[0].get(u"steps"_s)->items[i]);
            steps.items.append(js::object({{u"op"_s,js::S(u"call"_s)},{u"id"_s,js::N(40)},{u"m"_s,js::S(u"optionListener"_s)},{u"a"_s,js::array()}}));
            const auto contract=js::object({{u"symbol"_s,js::S(u"SPX"_s)},{u"secType"_s,js::S(u"OPT"_s)},{u"exchange"_s,js::S(u"SMART"_s)},{u"currency"_s,js::S(u"USD"_s)}});
            steps.items.append(js::object({{u"op"_s,js::S(u"call"_s)},{u"id"_s,js::N(41)},{u"m"_s,js::S(u"subscribeTicker"_s)},{u"a"_s,js::array({contract})}}));
            auto send=[&](QStringList fields){steps.items.append(js::object({{u"op"_s,js::S(u"send"_s)},{u"msgs"_s,js::array({js::strings(fields)})}}));};
            send({u"58"_s,u"1"_s,u"$f:1:2"_s,u"1"_s});
            if(price)send({u"1"_s,u"6"_s,u"$f:1:2"_s,u"1"_s,u"2.5"_s,u"10"_s,u"0"_s});
            OJson scenario=js::object({{u"steps"_s,steps}});Harness h(scenario);QString error;
            QVERIFY2(h.run(&error,false),qPrintable(error));
            const auto* callbacks=h.step.get(u"cb"_s);
            if(price)QVERIFY(callbacks&&!callbacks->items.isEmpty()); else QVERIFY(!callbacks||callbacks->items.isEmpty());
            QVERIFY2(h.afterlife(&error),qPrintable(error));
        }
    }
    void wshLifecycle() {
        const auto* all=fixture().get(u"scenarios"_s);
        for(const QString& mode : {u"success"_s,u"timeout"_s,u"error"_s}) {
            OJson steps=js::array();
            for(int i=0;i<5;++i)steps.items.append(all->items[0].get(u"steps"_s)->items[i]);
            steps.items.append(js::object({{u"op"_s,js::S(u"call"_s)},{u"id"_s,js::N(50)},{u"m"_s,js::S(u"wsh"_s)},{u"a"_s,js::array()}}));
            auto send=[&](QStringList fields){steps.items.append(js::object({{u"op"_s,js::S(u"send"_s)},{u"msgs"_s,js::array({js::strings(fields)})}}));};
            if(mode==u"timeout") steps.items.append(js::object({{u"op"_s,js::S(u"advance"_s)},{u"ms"_s,js::N(12001)}}));
            else if(mode==u"error") send({u"4"_s,u"2"_s,u"$f:100:1"_s,u"10276"_s,u"WSH subscription unavailable"_s,QString()});
            else {
                send({u"104"_s,u"$f:100:1"_s,u"{}"_s});
                send({u"105"_s,u"$f:102:1"_s,u"[]"_s});
            }
            OJson scenario=js::object({{u"steps"_s,steps}});
            Harness h(scenario);QString error;QVERIFY2(h.run(&error,false),qPrintable(error));
            const auto* res=h.step.get(u"res"_s);QVERIFY(res);QCOMPARE(res->items.size(),1);
            QCOMPARE(res->items[0].items[1].s,mode==u"success"?u"ok"_s:u"err"_s);
            if(mode==u"success") QCOMPARE(res->items[0].items[2].s,u"[]"_s);
            QVERIFY2(h.afterlife(&error),qPrintable(error));
        }
    }
        for (const auto& [name, ids] : at(fixture(), u"tickTypes"_s).fields) {
            const OJson& t1 = ids.items[0];
            const OJson& t2 = ids.items[1];
            const std::optional<double> want = t1.type == OJson::Number ? std::optional<double>(t1.n) : t2.type == OJson::Number ? std::optional<double>(t2.n) : std::nullopt;
            if (name.startsWith(u"DELAYED_"_s) && !want) continue;
            const auto got = tickTypeId(name);
            if (name == u"modelGamma" || name == u"modelIV") {
                QVERIFY(!got);
                continue;
            }
            QVERIFY2(got == want, qPrintable(name));
        }
    }

    // 真跑用的 socket(QTcpSocket)的事件次序要同 Node(生成器在真的回环上量过,夹具的 socketCalibration)。
    // 只连这个测试自己在 127.0.0.1 上开的端口(端口号由系统给,不是 TWS 的端口)
    void tcpSocketMatchesNodeEvents() {
        const OJson& cal = at(fixture(), u"socketCalibration"_s);
        auto runCase = [&](const QString& name, const std::function<void(QTcpSocket*)>& serverAct,
                           const std::function<void(ibnext::NodeSocket&)>& clientAct, bool listen) -> QStringList {
            QTcpServer server;
            if (!server.listen(QHostAddress::LocalHost, 0)) return {u"listen failed"_s};
            const quint16 port = server.serverPort();
            QList<QTcpSocket*> peers;
            QObject::connect(&server, &QTcpServer::newConnection, &server, [&] {
                while (QTcpSocket* p = server.nextPendingConnection()) {
                    peers.append(p);
                    if (serverAct) QTimer::singleShot(20, p, [p, serverAct] { serverAct(p); });
                }
            });
            if (!listen) server.close();
            QStringList log;
            ibnext::NodeSocket::Handlers h;
            h.connect = [&] { log.append(u"connect"_s); };
            h.data = [&](const QByteArray&) { log.append(u"data"_s); };
            h.end = [&] { log.append(u"end"_s); };
            h.error = [&](const QString& m) { log.append(m.contains(u"ECONNREFUSED"_s) ? u"error:ECONNREFUSED"_s : u"error"_s); };
            h.close = [&] { log.append(u"close"_s); };
            auto sock = ibnext::tcpSocketFactory()(u"127.0.0.1"_s, port, h);
            QTest::qWait(150);
            if (clientAct) {
                clientAct(*sock);
                QTest::qWait(150);
            }
            sock.reset();
            (void)name;
            return log;
        };
        auto expect = [&](const QString& name, const QStringList& got) {
            QStringList want;
            for (const OJson& x : at(cal, name).items) want.append(x.s);
            QVERIFY2(got == want, qPrintable(u"%1:Node %2,QTcpSocket %3"_s.arg(name, want.join(u','), got.join(u','))));
        };
        expect(u"serverEnd"_s, runCase(u"serverEnd"_s, [](QTcpSocket* p) { p->disconnectFromHost(); }, nullptr, true));
        expect(u"serverData"_s, runCase(u"serverData"_s, [](QTcpSocket* p) { p->write("x"); }, nullptr, true));
        expect(u"clientEndDestroy"_s, runCase(u"clientEndDestroy"_s, nullptr, [](ibnext::NodeSocket& s) {
            s.end();
            s.destroy();
        }, true));
        expect(u"writeAfterDestroy"_s, runCase(u"writeAfterDestroy"_s, nullptr, [](ibnext::NodeSocket& s) {
            s.end();
            s.destroy();
            s.write("late");
        }, true));
        expect(u"refused"_s, runCase(u"refused"_s, nullptr, nullptr, false));
    }

    void pureTickerKey() {
        const OJson& cases = at(at(fixture(), u"pure"_s), u"tickerKey"_s);
        QVERIFY(cases.items.size() > 100);
        for (const OJson& c : cases.items) {
            const IbContract k = contractFrom(at(c, u"c"_s));
            const OJson& g = at(c, u"g"_s);
            const QString got = isUndefMark(g) ? tickerKey(k) : tickerKey(k, g.s);
            if (!expectOut(c, js::S(got), u"tickerKey "_s + js::stringify(at(c, u"c"_s)))) return;
        }
    }

    void pureRealNumber() {
        for (const OJson& c : at(at(fixture(), u"pure"_s), u"realNumber"_s).items) {
            const OJson& v = at(c, u"v"_s);
            const OJson dv = jsfix::dec(v);
            const auto got = realNumber(isUndefMark(v) ? nullptr : &dv);
            if (!expectOut(c, optJ(got), u"realNumber "_s + js::stringify(v))) return;
        }
    }

    void pureTradeFromOrderStatus() {
        for (const OJson& c : at(at(fixture(), u"pure"_s), u"tradeFromOrderStatus"_s).items) {
            const Args a(at(c, u"args"_s));
            const OJson got = tradeFromOrderStatus(a[0], a[1], a[2], a[3], a[4], a[5], a[6]);
            if (!expectOut(c, got, u"tradeFromOrderStatus "_s + js::stringify(at(c, u"args"_s)))) return;
        }
    }

    void pureFillFromExecDetails() {
        for (const OJson& c : at(at(fixture(), u"pure"_s), u"fillFromExecDetails"_s).items) {
            const Args a(at(c, u"args"_s));
            const auto [trade, fill] = fillFromExecDetails(a[0], a[1], a[2]);
            if (!expectOut(c, js::array({trade, fill}), u"fillFromExecDetails "_s + js::stringify(at(c, u"args"_s)))) return;
        }
    }

    void pureExecForwarder() {
        for (const OJson& c : at(at(fixture(), u"pure"_s), u"execForwarder"_s).items) {
            std::vector<FillCallback> fills;
            std::vector<CommissionCallback> comms;
            OJson calls = js::array();
            fills.push_back([&](const OJson& t, const OJson& f) { calls.items.append(js::array({js::S(u"fill"_s), t, f})); });
            comms.push_back([&](const OJson& t, const OJson& f, const OJson& r) { calls.items.append(js::array({js::S(u"comm"_s), t, f, r})); });
            fills.push_back([&](const OJson& t, const OJson& f) { calls.items.append(js::array({js::S(u"fill2"_s), t, f})); });
            comms.push_back([&](const OJson& t, const OJson& f, const OJson& r) { calls.items.append(js::array({js::S(u"comm2"_s), t, f, r})); });
            ExecForwarder fw(&fills, &comms);
            for (const OJson& ev : at(c, u"events"_s).items) {
                const Args a(ev);
                if (ev.items[0].s == u"exec") fw.onExecDetails(a[1], a[2], a[3]);
                else fw.onCommissionReport(a[1]);
            }
            JSFIX_SAME(at(c, u"calls"_s), calls, u"execForwarder "_s + js::stringify(at(c, u"events"_s)));
        }
    }

    void pureApplyPositionUpdate() {
        for (const OJson& c : at(at(fixture(), u"pure"_s), u"applyPositionUpdate"_s).items) {
            std::optional<PositionTable> table;
            const OJson& t = at(c, u"table"_s);
            if (t.type == OJson::Array) {
                table.emplace();
                for (const OJson& e : t.items) {
                    const OJson h = jsfix::dec(e.items[1]);
                    HeldPosition p;
                    p.account = js::str(h.get(u"account"_s));
                    p.contract = *h.get(u"contract"_s);
                    p.pos = js::num(h.get(u"pos"_s));
                    p.avgCost = js::num(h.get(u"avgCost"_s));
                    table->set(e.items[0].s, p);
                }
            }
            const OJson& u = at(c, u"update"_s);
            PositionsUpdate upd;
            if (u.get(u"all"_s)) upd.all = accountsFrom(*u.get(u"all"_s));
            if (u.get(u"added"_s)) upd.added = accountsFrom(*u.get(u"added"_s));
            if (u.get(u"changed"_s)) upd.changed = accountsFrom(*u.get(u"changed"_s));
            if (u.get(u"removed"_s)) upd.removed = accountsFrom(*u.get(u"removed"_s));
            applyPositionUpdate(table, upd);
            OJson out = js::array();
            for (const auto& [k, h] : table->items) out.items.append(js::array({js::S(k), heldJson(h)}));
            if (!expectOut(c, out, u"applyPositionUpdate "_s + js::stringify(c).left(400))) return;
        }
    }

    void pureApplyTicks() {
        const double t0 = at(fixture(), u"T0"_s).n;
        for (const OJson& c : at(at(fixture(), u"pure"_s), u"applyTicks"_s).items) {
            TickerData d = tickerFrom(at(c, u"data"_s));
            const OJson& u = at(c, u"update"_s);
            MarketDataUpdate m;
            m.all = ticksFrom(u.get(u"all"_s));
            m.added = ticksFrom(u.get(u"added"_s));
            m.changed = ticksFrom(u.get(u"changed"_s));
            applyTicks(d, m, t0);
            if (!expectOut(c, tickerJson(d), u"applyTicks "_s + js::stringify(c).left(600))) return;
        }
    }

    void pureCandidatesOf() {
        for (const OJson& c : at(at(fixture(), u"pure"_s), u"candidatesOf"_s).items) {
            const OJson& raw = at(c, u"details"_s);
            const OJson d = jsfix::dec(raw);
            OJson out = js::array();
            for (const auto& r : candidatesOf(isUndefMark(raw) ? nullptr : &d)) out.items.append(resolvedJson(r));
            if (!expectOut(c, out, u"candidatesOf "_s + js::stringify(raw))) return;
        }
    }

    void purePickContractDetail() {
        for (const OJson& c : at(at(fixture(), u"pure"_s), u"pickContractDetail"_s).items) {
            const OJson& raw = at(c, u"details"_s);
            const OJson d = jsfix::dec(raw);
            QStringList lines;
            const auto got = pickContractDetail(contractFrom(at(c, u"requested"_s)), isUndefMark(raw) ? nullptr : &d, [&](const QString& l) { lines.append(l); });
            const QString what = u"pickContractDetail "_s + js::stringify(c).left(500);
            if (!expectOut(c, got ? resolvedJson(*got) : OJson::null(), what)) return;
            JSFIX_SAME(at(c, u"log"_s), js::strings(lines), what);
        }
    }

    void pureToIbOrder() {
        for (const OJson& c : at(at(fixture(), u"pure"_s), u"toIbOrder"_s).items) {
            const OJson got = toIbOrder(intentFrom(at(c, u"intent"_s)));
            if (!expectOut(c, got, u"toIbOrder "_s + js::stringify(at(c, u"intent"_s)))) return;
        }
    }

    void destroyInsideCallback_data() {
        QTest::addColumn<QString>("steps");
        QTest::addColumn<bool>("probe");
        const QString head = QStringLiteral(R"({"steps":[
            {"op":"call","id":1,"m":"create","a":[{"host":"127.0.0.1","port":7497,"clientId":12,"readonly":false}]},
            {"op":"accept"},{"op":"send","msgs":[["193","20261020 10:00:00 Asia/Shanghai"]]},{"op":"send","msgs":[["15","1","U1234567"]]},{"op":"send","msgs":[["9","1","1"]]},)");
        const QString tail = QStringLiteral(R"(],"trace":[]})");
        // 在 socket 的数据回调里:同一块字节里后面还有三条消息
        QTest::newRow("socket data") << head + QStringLiteral(R"({"op":"call","id":2,"m":"destroyOnNext","a":[]},
            {"op":"send","msgs":[["4","2","-1","2104","a",""],["4","2","-1","2106","b",""],["4","2","-1","1100","c",""],["9","1","7"]]},
            {"op":"advance","ms":120000},{"op":"end"},{"op":"advance","ms":120000})") + tail << true;
        // 会话在第一条消息的回调里销毁之后,同一块字节里行情的推送与订阅的拒绝(10197)才到:订阅那一头的回调见会话与条目都没了,什么都不做
        QTest::newRow("ticker callbacks after destroy") << head + QStringLiteral(R"({"op":"call","id":3,"m":"subscribeTicker","a":[{"secType":"FUT","symbol":"ES","exchange":"CME","currency":"USD","lastTradeDateOrContractMonth":"202612"},""]},
            {"op":"call","id":2,"m":"destroyOnNext","a":[]},
            {"op":"send","msgs":[["4","2","-1","2104","a",""],["1","6","2","1","6750","1","0"],["4","2","2","10197","No market data",""],["1","6","2","2","6751","1","0"]]},
            {"op":"advance","ms":120000})") + tail << true;
        // 在重连计时器的回调里(重连先报 504 的通告,通告的回调里销毁)
        QTest::newRow("reconnect timer") << head + QStringLiteral(R"({"op":"end"},{"op":"call","id":2,"m":"destroyOnNext","a":[]},
            {"op":"advance","ms":5000},{"op":"accept"},{"op":"advance","ms":120000})") + tail << false;
    }
    /// 在会话自己的回调里把它销毁(调用方丢掉最后一份引用):同一块字节里后面的消息、同一拍里的收尾都得安全
    /// (socket 与计时器的回调钉住库那一层到跑完;会话层的监听 lock 一份在手里)。ASan 构建下这条会直接炸出来;
    /// 探针在普通构建下也能看出来(socket 的路径):收尾那一刻库那一层必须还活着
    void destroyInsideCallback() {
        QFETCH(QString, steps);
        QFETCH(bool, probe);
        const auto parsed = util::parseOJson(steps);
        QVERIFY(parsed.has_value());
        const int subs0 = ibnext::LiveCounts::subscriptions, entries0 = ibnext::LiveCounts::entries;
        QString failure;
        {
            Harness h(*parsed);
            QVERIFY2(h.run(&failure, false), qPrintable(failure));
            QVERIFY(h.probed);
            if (probe) QVERIFY2(h.probeAlive, "回调里销毁会话时,库那一层被拆在了回调跑完之前");
            QCOMPARE(int(ibnext::LiveCounts::apiNext), h.apiNextBase);
        }
        QCOMPARE(int(ibnext::LiveCounts::subscriptions), subs0);
        QCOMPARE(int(ibnext::LiveCounts::entries), entries0);
    }

    /// 等订阅表里的结果的协程醒来时会话已经没了:失败的 Task(会话已关闭)或空结果,不碰已经没了的对象
    void closedSessionPaths() {
        const auto closedError = [](const auto& task) {
            if (!task.done()) return false;
            try {
                task.result();
            } catch (const util::JsError& e) {
                return e.message() == u"会话已关闭"_s;
            }
            return false;
        };
        QVERIFY(closedError(ClosedSessionProbe::placeOrder(IbContract{}, OrderIntent{})));
        QVERIFY(closedError(ClosedSessionProbe::historicalData(IbContract{}, HistoricalRequest{})));
        QVERIFY(closedError(ClosedSessionProbe::secDefOptParams(u"SPX"_s, u"IND"_s, 416904)));
        QVERIFY(closedError(ClosedSessionProbe::openTrades()));
        QVERIFY(closedError(ClosedSessionProbe::openTradesDetailed()));
        QVERIFY(closedError(ClosedSessionProbe::executions()));
        IbContract c;
        c.conId = 77;
        c.exchange = u"SMART"_s;
        auto loop = ClosedSessionProbe::qualifyLoop({&c});
        QVERIFY(loop.done());
        loop.result();  // 不抛
        QCOMPARE(c.conId, std::optional<int>(77));  // 调用方的合约原样,没被写
        QCOMPARE(c.exchange, u"SMART"_s);
        auto hours = ClosedSessionProbe::hoursWork(IbContract{});
        QVERIFY(hours.done());
        QVERIFY(!hours.result().has_value());
    }

    /// LinkDownError 的身份:托管 / 追价 / 引擎那几处按类型(TS 里是 exc.name)认,不按话;话与 TS 一字不差
    void linkDownErrorIdentity() {
        QCOMPARE(LinkDownError::name(), u"LinkDownError"_s);
        QCOMPARE(LinkDownError().message(), u"与 TWS 的连接已断开,正在自动重连"_s);
        bool caught = false;
        try {
            throw LinkDownError();
        } catch (const util::JsError& e) {  // 是 JsError:只认 JsError 的调用方也接得住
            caught = dynamic_cast<const LinkDownError*>(&e) != nullptr;
        }
        QVERIFY(caught);
    }
    /// 会话断着时下单 / 改单 / 撤单抛的就是这个类型(不是话一样的普通错)
    void linkDownIsTypedFromSession() {
        const OJson& list = at(fixture(), u"scenarios"_s);
        const OJson* sc = nullptr;
        for (const OJson& s : list.items)
            if (at(s, u"name"_s).s == u"linkdown_orders_not_queued") sc = &s;
        QVERIFY(sc);
        QString failure;
        Harness h(*sc);
        QVERIFY2(h.run(&failure), qPrintable(failure));
        QCOMPARE(h.linkDownTyped, 7);  // 断着的 5 次 + 第二次断线的 2 次
        QCOMPARE(h.linkDownUntyped, 0);
    }

    void destroyedSessionLeavesNothing_data() {
        QTest::addColumn<int>("index");
        const OJson& list = at(fixture(), u"scenarios"_s);
        for (qsizetype i = 0; i < list.items.size(); ++i) QTest::newRow(qPrintable(at(list.items[i], u"name"_s).s)) << static_cast<int>(i);
    }
    /// 每个脚本跑完之后把会话放手:没有强引用的环(整个会话 + 订阅表 + 协程帧不能因为等一个永远不来的结果而留着),
    /// 也没有任何还活着的回调(计时器、socket 事件、订阅的推送)再跑出东西来
    void destroyedSessionLeavesNothing() {
        QFETCH(int, index);
        const OJson& sc = at(fixture(), u"scenarios"_s).items[index];
        QString failure;
        const int apiNext0 = ibnext::LiveCounts::apiNext, subs0 = ibnext::LiveCounts::subscriptions, entries0 = ibnext::LiveCounts::entries;
        {
            Harness h(sc);
            QVERIFY2(h.run(&failure), qPrintable(failure));
            QVERIFY2(h.afterlife(&failure), qPrintable(failure));
        }
        // 库这一层(ApiNext / 订阅 / 订阅表条目)也都放干净了:没有互相拉着的强引用
        QCOMPARE(int(ibnext::LiveCounts::apiNext), apiNext0);
        QCOMPARE(int(ibnext::LiveCounts::subscriptions), subs0);
        QCOMPARE(int(ibnext::LiveCounts::entries), entries0);
    }

    void scenarios_data() {
        QTest::addColumn<int>("index");
        const OJson& list = at(fixture(), u"scenarios"_s);
        for (qsizetype i = 0; i < list.items.size(); ++i) QTest::newRow(qPrintable(at(list.items[i], u"name"_s).s)) << static_cast<int>(i);
    }
    void scenarios() {
        QFETCH(int, index);
        const OJson& sc = at(fixture(), u"scenarios"_s).items[index];
        // 只连脚本里那个名字(假 socket),从来不建真的连接
        for (const OJson& st : at(sc, u"steps"_s).items)
            if (js::str(st.get(u"m"_s)) == u"create") QVERIFY(js::str(at(st, u"a"_s).items[0].get(u"host"_s)) == u"127.0.0.1");
        QString failure;
        Harness h(sc);
        const bool ok = h.run(&failure);
        QVERIFY2(ok, qPrintable(failure));
    }
};

QTEST_GUILESS_MAIN(TestIbSession)
#include "tst_ib_session.moc"
