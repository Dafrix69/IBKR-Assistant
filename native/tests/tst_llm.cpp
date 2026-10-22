// engine/parsing/{providers,llm,embeddings,sdk_http}(providers.ts / llm.ts / embeddings.ts 与它们背后的两个官方 SDK)。
// 对拍(tests/fixtures/gen_llm.mjs,连着真的 @anthropic-ai/sdk 0.128.0 与 openai 7.23.0 现跑):
//   · 每个场景用同一份脚本起一个回环上的假端点(QTcpServer,127.0.0.1,端口随机),把同样的几次调用跑一遍,逐项比:
//     端点看到的每一个请求(方法、路径、要紧的头、正文逐字节)、SDK 退避睡了多久、每次请求的计时器设了多久、每次调用的结果或错
//     (类名、原话、状态码);
//   · 纯函数(代码围栏、采样参数、目录、schema 资产、给人看的错、本机地址、余弦)逐个比。
// 头里不比的:传输层自己加的(host、connection、content-length、accept-encoding、accept-language、sec-fetch-mode)
// 与 SDK 的平台头(x-stainless-lang / -os / -arch / -runtime / -runtime-version / -package-version,说的是 node,这边不说);
// 嵌入走的是 fetch,它的 accept / user-agent 也不比。别的头两边必须一个不多、一个不少、值一样。
// 只连本机:出网闸(sdk::Hooks::allowUrl)只放 127.0.0.1 / localhost / ::1,碰到别的当场抛;最后一条用例专门看它拦得住。
#include "js_fixture.h"
#include "parsing/embeddings.h"
#include "parsing/llm.h"
#include "parsing/providers.h"
#include "parsing/sdk_http.h"
#include "util/whatwg_url.h"
#include "domain/config.h"
#include "util/jsformat.h"
#include "util/pyjson.h"
#include "util/secrets.h"

#include <QElapsedTimer>
#include <QHostAddress>
#include <QPointer>
#include <QProcessEnvironment>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTest>
#include <QTimer>

#include <cmath>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using jsfix::enc;
using util::OJson;
namespace js = util::js;
namespace pv = parsing::providers;
namespace sdk = parsing::sdk;
namespace em = parsing::embeddings;

namespace {

const QSet<QString> kIgnoredHeaders{
    u"host"_s, u"connection"_s, u"content-length"_s, u"accept-encoding"_s, u"accept-language"_s, u"sec-fetch-mode"_s,
    u"x-stainless-lang"_s, u"x-stainless-os"_s, u"x-stainless-arch"_s, u"x-stainless-runtime"_s, u"x-stainless-runtime-version"_s, u"x-stainless-package-version"_s,
};
const QSet<QString> kIgnoredFetchHeaders{u"accept"_s, u"user-agent"_s};

namespace wu = ibkr::util::whatwg;

/// QVERIFY_THROWS_EXCEPTION 不带说明:这里要带上是哪个地址
#define QVERIFY2_THROWS(expr, Exc, desc)                               \
    do {                                                                \
        bool threw_ = false;                                            \
        try {                                                           \
            (void)(expr);                                               \
        } catch (const Exc&) {                                          \
            threw_ = true;                                              \
        }                                                               \
        QVERIFY2(threw_, qPrintable(desc));                             \
    } while (false)

/// 设过的环境变量不管测试怎么收场(QVERIFY 失败直接 return 也算)都会撤掉
class EnvScope {
public:
    void set(const QString& name, const QString& value) {
        qputenv(name.toLatin1().constData(), value.toUtf8());
        names_ << name;
    }
    ~EnvScope() {
        for (const QString& n : names_) qunsetenv(n.toLatin1().constData());
    }

private:
    QStringList names_;
};
/// 改过的钩子(sdk::setHooks)同样一定还原
class HooksScope {
public:
    HooksScope() : saved_(sdk::hooks()) {}
    ~HooksScope() { sdk::setHooks(saved_); }

private:
    sdk::Hooks saved_;
};

bool loopbackHost(const QString& host) { return host == u"127.0.0.1" || host == u"localhost" || host == u"::1" || host == u"[::1]"; }

/// 回环上的假端点:按脚本一步一步回话,记下每一个请求(同 gen_llm.mjs 的 startServer)
class FakeEndpoint : public QObject {
public:
    explicit FakeEndpoint(QList<OJson> script) : script_(std::move(script)) {
        server_.listen(QHostAddress(u"127.0.0.1"_s), 0);
        connect(&server_, &QTcpServer::newConnection, this, [this] {
            while (QTcpSocket* s = server_.nextPendingConnection()) {
                s->setParent(this);
                buffers_[s] = {};
                connect(s, &QTcpSocket::readyRead, this, [this, s] { onRead(s); });
            }
        });
    }
    quint16 port() const { return server_.serverPort(); }
    const OJson& seen() const { return seen_; }
    void clearSeen() { seen_ = js::array(); }

private:
    void onRead(QTcpSocket* s) {
        QByteArray& buf = buffers_[s];
        buf += s->readAll();
        const qsizetype end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        const QList<QByteArray> lines = buf.left(end).split('\n');
        qsizetype contentLength = 0;
        QList<QPair<QString, QString>> headers;
        for (qsizetype i = 1; i < lines.size(); ++i) {
            const QByteArray line = lines[i].trimmed();
            const qsizetype colon = line.indexOf(':');
            if (colon < 0) continue;
            const QString k = QString::fromLatin1(line.left(colon)).trimmed().toLower();
            const QString v = QString::fromLatin1(line.mid(colon + 1)).trimmed();  // Node 的 rawHeaders 按 latin1 读
            headers.append({k, v});
            if (k == u"content-length") contentLength = v.toLongLong();
        }
        if (buf.size() < end + 4 + contentLength) return;
        const QList<QByteArray> first = lines[0].trimmed().split(' ');
        const QByteArray body = buf.mid(end + 4, contentLength);
        buf.clear();
        disconnect(s, &QTcpSocket::readyRead, this, nullptr);
        std::sort(headers.begin(), headers.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
        OJson hs = js::array();
        for (const auto& [k, v] : headers) hs.items.append(js::array({js::S(k), js::S(v)}));
        seen_.items.append(js::object({{u"method"_s, js::S(QString::fromLatin1(first.value(0)))},
                                       {u"path"_s, js::S(QString::fromLatin1(first.value(1)))},
                                       {u"headers"_s, hs},
                                       {u"body"_s, js::S(QString::fromUtf8(body))}}));
        OJson step = next_ < script_.size() ? script_[next_++] : js::object({{u"status"_s, js::N(599)}, {u"body"_s, js::object({{u"error"_s, js::S(u"script exhausted"_s)}})}});
        step = *js::parse(js::stringify(step).replace(u"{PORT}"_s, QString::number(server_.serverPort())));  // Location 之类里写 {PORT} = 本端点
        const double delay = js::num(js::prop(&step, u"delayMs"_s));
        QPointer<QTcpSocket> sp(s);
        const auto act = [this, sp, step] {
            if (sp) respond(sp, step);
        };
        if (delay > 0) QTimer::singleShot(int(delay), this, act);
        else act();
    }

    void respond(QTcpSocket* s, const OJson& step) {
        if (js::truthy(js::prop(&step, u"drop"_s))) {
            s->abort();
            return;
        }
        QList<QPair<QString, QString>> h{{u"connection"_s, u"close"_s}};
        const auto setHeader = [&h](const QString& k, const QString& v) {
            for (auto& p : h)
                if (p.first.toLower() == k.toLower()) {
                    p.second = v;
                    return;
                }
            h.append({k, v});
        };
        if (const OJson* hdrs = js::prop(&step, u"headers"_s); js::isObj(hdrs))
            for (const auto& [k, v] : hdrs->fields) setHeader(k, v.s);
        const OJson* rawBody = js::prop(&step, u"body"_s);
        QString body;
        if (js::isObjectLike(rawBody)) {
            body = js::stringify(*rawBody);
            bool hasType = false;
            for (const auto& p : h)
                if (p.first.toLower() == u"content-type") hasType = true;
            if (!hasType) h.append({u"content-type"_s, u"application/json"_s});
        } else if (js::isStr(rawBody)) {
            body = rawBody->s;
        }
        const int status = int(js::num(js::prop(&step, u"status"_s)));
        const auto head = [&](bool chunked) {
            QByteArray out = "HTTP/1.1 " + QByteArray::number(status) + " X\r\n";
            for (const auto& [k, v] : h) out += k.toLatin1() + ": " + v.toUtf8() + "\r\n";
            if (chunked) out += "Transfer-Encoding: chunked\r\n";
            return out + "\r\n";
        };
        const OJson* partial = js::prop(&step, u"partial"_s);
        if (partial) {
            // Node 的 res.writeHead + write:没给 content-length 就是分块编码
            bool hasLength = false;
            for (const auto& p : h)
                if (p.first.toLower() == u"content-length") hasLength = true;
            const auto chunk = [hasLength](const QByteArray& d) { return hasLength ? d : QByteArray::number(d.size(), 16) + "\r\n" + d + "\r\n"; };
            s->write(head(!hasLength) + chunk(partial->s.toUtf8()));
            const OJson* rest = js::prop(&step, u"rest"_s);
            const std::optional<QByteArray> restBytes = rest ? std::optional<QByteArray>(rest->s.toUtf8()) : std::nullopt;
            QPointer<QTcpSocket> sp(s);
            QTimer::singleShot(int(js::num(js::prop(&step, u"stallMs"_s))), this, [sp, restBytes, chunk, hasLength] {
                if (!sp) return;
                if (!restBytes) {
                    sp->abort();
                    return;
                }
                sp->write(chunk(*restBytes) + (hasLength ? QByteArray() : QByteArray("0\r\n\r\n")));
                sp->disconnectFromHost();
            });
            return;
        }
        const QByteArray bytes = body.toUtf8();
        setHeader(u"content-length"_s, QString::number(bytes.size()));
        s->write(head(false) + bytes);
        s->disconnectFromHost();
    }

    QTcpServer server_;
    QList<OJson> script_;
    qsizetype next_ = 0;
    QHash<QTcpSocket*, QByteArray> buffers_;
    OJson seen_ = js::array();
};

/// 只数连接的回环诱饵:不回话。任何一个连接到这里 = 带 Key 的请求连错了地方(v4 与 v6 回环各一个,端口相同;没有 IPv6 就只有 v4)
class ConnectionCounter : public QObject {
public:
    ConnectionCounter() {
        v4_.listen(QHostAddress(u"127.0.0.1"_s), 0);
        v6_.listen(QHostAddress(QHostAddress::LocalHostIPv6), v4_.serverPort());
        for (QTcpServer* s : {&v4_, &v6_}) connect(s, &QTcpServer::newConnection, this, [this, s] {
            while (QTcpSocket* c = s->nextPendingConnection()) {
                ++connections_;
                c->setParent(this);
                connect(c, &QTcpSocket::readyRead, this, [this, c] { bytes_ += c->readAll().size(); });
            }
        });
    }
    quint16 port() const { return v4_.serverPort(); }
    int connections() const { return connections_; }
    qint64 bytes() const { return bytes_; }

private:
    QTcpServer v4_, v6_;
    int connections_ = 0;
    qint64 bytes_ = 0;
};

/// 凭证库的假后端:读出来的是给定的值
class FakeSecrets : public util::SecretBackend {
public:
    explicit FakeSecrets(std::optional<QString> v) : v_(std::move(v)) {}
    util::Task<bool> exists(const QString&, const QString&) override { return util::Task<bool>::resolved(v_.has_value()); }
    util::Task<std::optional<QString>> read(const QString&, const QString&) override { return util::Task<std::optional<QString>>::resolved(v_); }
    util::Task<> write(const QString&, const QString&, const QString&) override { return util::Task<>::resolved(); }

private:
    std::optional<QString> v_;
};

template <class T>
bool waitFor(const util::Task<T>& t, int ms = 30'000) {
    QElapsedTimer clock;
    clock.start();
    while (!t.done() && clock.elapsed() < ms) QCoreApplication::processEvents(QEventLoop::AllEvents, 20);
    return t.done();
}

QString fill(QString s, const QString& base) { return s.replace(u"{BASE}"_s, base); }

contract::LLMConfig configOf(const OJson& raw, const QString& base) {
    contract::LLMConfig c;
    c.provider = js::str(raw.get(u"provider"_s));
    c.model = js::str(raw.get(u"model"_s));
    c.effort = js::str(raw.get(u"effort"_s));
    const OJson* t = raw.get(u"temperature"_s);
    c.temperature = js::nullish(t) ? QJsonValue(QJsonValue::Null) : QJsonValue(t->n);
    c.base_url = fill(js::str(raw.get(u"base_url"_s)), base);
    c.max_tokens = js::num(raw.get(u"max_tokens"_s));
    c.timeout_s = js::num(raw.get(u"timeout_s"_s));
    c.keychain_service = js::str(raw.get(u"keychain_service"_s));
    c.keychain_account = js::str(raw.get(u"keychain_account"_s));
    return c;
}

parsing::prompts::PromptBundle bundleOf(const OJson& b) {
    parsing::prompts::PromptBundle out;
    out.version = b.get(u"version"_s)->s;
    out.system_text = b.get(u"system_text"_s)->s;
    out.user_template = b.get(u"user_template"_s)->s;
    for (const OJson& p : b.get(u"fewshot"_s)->items) {
        parsing::prompts::FewShotPair pair;
        pair.name = p.get(u"name"_s)->s;
        pair.user = p.get(u"user"_s)->s;
        pair.assistantJ = util::parseJson(p.get(u"assistant_text"_s)->s);
        pair.assistant = util::toPlainOJson(pair.assistantJ);
        out.fewshot.push_back(pair);
    }
    return out;
}

OJson errorJson(const std::exception_ptr& e) {
    pv::ErrorView v;
    try {
        std::rethrow_exception(e);
    } catch (const em::EmbedError& x) {
        v = {u"EmbedError"_s, x.message(), std::nullopt};
    } catch (...) {
        v = pv::errorView(e);
    }
    OJson o = js::object({{u"name"_s, js::S(v.name)}, {u"message"_s, js::S(v.message)}});
    if (v.status) o.set(u"status"_s, js::N(*v.status));  // 没有状态码 = undefined:期望值那边按 JSON.stringify 去掉了这个键
    return o;
}

OJson responseJson(const pv::LLMResponse& r) {
    return js::object({{u"text"_s, js::S(r.text)}, {u"model"_s, r.model}, {u"prompt_version"_s, js::S(r.prompt_version)},
                       {u"prompt_fingerprint"_s, js::S(r.prompt_fingerprint)}, {u"usage"_s, r.usage}, {u"structured_mode"_s, js::S(r.structured_mode)}});
}

/// 跑一次调用 → {ok} / {error}(同 gen_llm.mjs 的 call)
template <class T, class F>
OJson settle(const util::Task<T>& t, F&& onOk) {
    if (!waitFor(t)) return js::object({{u"error"_s, js::S(u"C++ 等了 30 秒没结果"_s)}});
    if (t.error()) return js::object({{u"error"_s, errorJson(t.error())}});
    return js::object({{u"ok"_s, enc(onOk(t.result()))}});
}

OJson runCall(const OJson& c, const QString& base, const OJson& fx) {
    const QString op = c.get(u"op"_s)->s;
    if (op == u"embed") {
        try {
            const em::OllamaEmbedder e(fill(c.get(u"baseUrl"_s)->s, base), c.get(u"model"_s)->s, *c.get(u"keepAlive"_s));
            std::vector<QString> texts;
            for (const OJson& t : c.get(u"texts"_s)->items) texts.push_back(t.s);
            return settle(e.embed(texts, c.get(u"timeoutMs"_s)->n), [](const std::vector<OJson>& v) { return js::array(QList<OJson>(v.begin(), v.end())); });
        } catch (...) {
            return js::object({{u"error"_s, errorJson(std::current_exception())}});
        }
    }
    const QString provider = c.get(u"provider"_s) ? c.get(u"provider"_s)->s : u"openai_compatible"_s;
    OJson raw = *fx.get(u"base_config"_s)->get(provider);
    if (const OJson* over = c.get(u"config"_s))
        for (const auto& [k, v] : over->fields) raw.set(k, v);
    const contract::LLMConfig cfg = configOf(raw, base);
    std::optional<QString> apiKey = fx.get(u"key"_s)->s;
    if (const OJson* k = c.get(u"apiKey"_s)) apiKey = k->type == OJson::Null ? std::nullopt : std::optional<QString>(k->s);
    if (const OJson* s = c.get(u"secret"_s)) util::useSecretBackend(std::make_shared<FakeSecrets>(s->type == OJson::Null ? std::nullopt : std::optional<QString>(s->s)));
    struct Restore {
        bool on;
        ~Restore() {
            if (on) util::useSecretBackend(nullptr);
        }
    } restore{c.get(u"secret"_s) != nullptr};
    try {
        std::shared_ptr<pv::Parser> parser = pv::buildParser(cfg, apiKey);
        if (const OJson* accts = c.get(u"accounts"_s)) {
            std::vector<pv::AccountRef> list;
            for (const OJson& a : accts->items) list.push_back({a.get(u"alias"_s)->s, js::str(a.get(u"account_id"_s))});
            parser = pv::guardAccountIds(parser, [list] { return list; });
        }
        if (op == u"parse" || op == u"payload") {
            const auto bundle = bundleOf(*fx.get(u"bundles"_s)->get(c.get(u"bundle"_s)->s));
            return settle(parser->parse(bundle, c.get(u"user"_s)->s), [&](const pv::LLMResponse& r) {
                OJson o = responseJson(r);
                if (op == u"payload") {
                    try {
                        o.set(u"payload"_s, js::object({{u"ok"_s, enc(r.payload())}}));
                    } catch (...) {
                        o.set(u"payload"_s, js::object({{u"error"_s, errorJson(std::current_exception())}}));
                    }
                }
                return o;
            });
        }
        if (op == u"completeJson") return settle(parser->completeJson(c.get(u"system"_s)->s, c.get(u"user"_s)->s, *c.get(u"schema"_s)), [](const OJson& v) { return v; });
        if (op == u"test") {
            const OJson* tk = c.get(u"testKey"_s);
            return settle(parser->test(tk ? std::optional<QString>(tk->s) : std::nullopt), [](const pv::TestProbe& p) {
                return js::object({{u"ok"_s, js::B(p.ok)}, {u"model"_s, p.model}, {u"structured_mode"_s, js::S(p.structured_mode)},
                                   {u"usage"_s, p.usage}, {u"sample"_s, js::S(p.sample)}, {u"latency_is_number"_s, js::B(!std::isnan(p.latency_ms))}});
            });
        }
    } catch (...) {
        return js::object({{u"error"_s, errorJson(std::current_exception())}});
    }
    return js::object({{u"error"_s, js::S(u"unknown op"_s)}});
}

OJson filteredHeaders(const OJson& headers, bool fetch) {
    OJson out = js::array();
    for (const OJson& kv : headers.items) {
        const QString k = kv.items[0].s;
        if (kIgnoredHeaders.contains(k) || (fetch && kIgnoredFetchHeaders.contains(k))) continue;
        out.items.append(kv);
    }
    return out;
}

/// 继承来的 ANTHROPIC_* / OPENAI_*(地址、令牌、自定义头、组织、Key……SDK 自己读)一个都不要:每个场景之前清一遍,
/// 场景要的变量由场景自己设(都指向本机端点)。返回清掉了几个
int scrubEnv() {
    int n = 0;
    for (const QString& k : QProcessEnvironment::systemEnvironment().keys())
        if (k.startsWith(u"ANTHROPIC_"_s) || k.startsWith(u"OPENAI_"_s)) {
            qunsetenv(k.toLatin1().constData());
            ++n;
        }
    return n;
}

}  // namespace

class TestLlm : public QObject {
    Q_OBJECT

    OJson fx_;
    OJson sleeps_ = js::array(), timers_ = js::array();
    int blocked_ = 0;

    void installHooks() {
        sdk::Hooks h;
        h.random = [] { return 0.5; };
        h.sleep = [this](double ms) {
            sleeps_.items.append(js::N(ms));
            return util::sleepMs(0);
        };
        h.timerArmed = [this](double ms) { timers_.items.append(js::N(ms)); };
        h.allowUrl = [this](const wu::Url& u) {
            const bool ok = loopbackHost(u.hostname);
            if (!ok) ++blocked_;
            return ok;
        };
        sdk::setHooks(h);
    }

private slots:
    void initTestCase() {
        fx_ = jsfix::load(u"llm.json"_s);
        scrubEnv();
        pv::setSchemaAssetDir(QStringLiteral(IBKR_REPO_DIR) + u"/engine-ts/baseline/llm"_s);
        installHooks();
    }

    /// 每个测试函数(每一行数据)之后:环境、钩子、凭证后端都回到干净的样子——失败的用例直接 return 也不会把脏状态留给下一个
    void cleanup() {
        scrubEnv();
        installHooks();
        util::useSecretBackend(nullptr);
        blocked_ = 0;
    }

    void scenarios_data() {
        QTest::addColumn<int>("index");
        const OJson& list = *fx_.get(u"scenarios"_s);
        for (qsizetype i = 0; i < list.items.size(); ++i) QTest::newRow(qPrintable(list.items[i].get(u"name"_s)->s)) << int(i);
    }

    void scenarios() {
        QFETCH(int, index);
        const OJson& sc = fx_.get(u"scenarios"_s)->items[index];
        const QString name = sc.get(u"name"_s)->s;
        const OJson* script = sc.get(u"script"_s);
        FakeEndpoint server(script ? script->items : QList<OJson>{});
        std::unique_ptr<FakeEndpoint> decoy;  // 第二个端点:带 Key 的请求要是到了这里,就是连错了地方
        if (js::truthy(sc.get(u"decoy"_s))) decoy = std::make_unique<FakeEndpoint>(QList<OJson>{});
        std::optional<quint16> dead;
        if (js::truthy(sc.get(u"dead"_s))) {
            QTcpServer probe;
            QVERIFY(probe.listen(QHostAddress(u"127.0.0.1"_s), 0));
            dead = probe.serverPort();
            probe.close();
        }
        const QString host = u"127.0.0.1:"_s + QString::number(dead ? *dead : server.port());
        const QString dhost = decoy ? u"127.0.0.1:"_s + QString::number(decoy->port()) : QString();
        const auto sub = [&](QString x) { return x.replace(u"{HOST}"_s, host).replace(u"{DECOY}"_s, dhost); };
        const OJson* over = sc.get(u"baseOverride"_s);
        const QString base = sub(over ? over->s : u"http://{HOST}/v1"_s);
        QCOMPARE(scrubEnv(), 0);  // 上一个场景没收拾干净也会在这里露出来
        EnvScope envScope;
        QHash<QString, QString> env;
        if (const OJson* e = sc.get(u"env"_s))
            for (const auto& [k, v] : e->fields) env[k] = sub(v.s);
        if (!env.contains(u"ANTHROPIC_BASE_URL"_s)) env[u"ANTHROPIC_BASE_URL"_s] = u"http://"_s + host;
        for (auto it = env.cbegin(); it != env.cend(); ++it) envScope.set(it.key(), it.value());
        sleeps_ = js::array();
        timers_ = js::array();
        OJson results = js::array();
        for (const OJson& c : sc.get(u"calls"_s)->items) results.items.append(runCall(c, base, fx_));
        // 端点那边可能还有晚到的请求(重试在路上):多等一拍
        QTest::qWait(20);

        const auto mask = [&](const OJson& v) {
            QString s = js::stringify(v);
            const auto maskPort = [&s](quint16 p, const QString& tag) {
                s.replace(u"127.0.0.1:"_s + QString::number(p), u"127.0.0.1:{"_s + tag + u"}"_s);
                s.replace(u"127.0.0.1%3A"_s + QString::number(p), u"127.0.0.1%3A{"_s + tag + u"}"_s);
                s.replace(u"localhost:"_s + QString::number(p), u"localhost:{"_s + tag + u"}"_s);
            };
            maskPort(server.port(), u"PORT"_s);
            if (dead) maskPort(*dead, u"DEAD"_s);
            if (decoy) maskPort(decoy->port(), u"DECOY"_s);
            return *js::parse(s);
        };
        // 不管 TS 怎么样:带 Key 的请求一个都不许到 decoy
        if (decoy) QVERIFY2(decoy->seen().items.isEmpty(), qPrintable(name + u":请求到了不该到的端点"_s));
        if (const OJson* d = sc.get(u"divergent"_s)) {
            // 重定向:TS(undici fetch)跟,C++ 故意不跟(跟了就是把 Key 带去别的地址)。TS 那边的结果留在夹具里当文档,这里断言 C++ 的样子:
            // 只发了一次请求,调用以错收场,错里说清楚是没跟随
            QCOMPARE(d->s, u"redirect"_s);
            QCOMPARE(server.seen().items.size(), 1);
            const OJson& r = results.items[0];
            QVERIFY2(r.get(u"error"_s), qPrintable(name + u":重定向没有以错收场"_s));
            const QString msg = r.get(u"error"_s)->get(u"message"_s)->s;
            if (name.startsWith(u"e_"_s)) QVERIFY2(msg.contains(u"HTTP 30"_s), qPrintable(msg));  // 嵌入走的是自己的「报错」句式
            else QVERIFY2(msg.contains(u"不跟随"_s) || msg.contains(u"HTTP 30"_s), qPrintable(msg));
            QVERIFY(msg.contains(u"30"_s));
            return;
        }
        JSFIX_SAME(*sc.get(u"results"_s), mask(results), name + u" 的结果"_s);
        JSFIX_SAME(*sc.get(u"sleeps"_s), sleeps_, name + u" 的退避"_s);
        JSFIX_SAME(*sc.get(u"timers"_s), timers_, name + u" 的计时器"_s);

        const OJson& wantReqs = *sc.get(u"requests"_s);
        const OJson gotReqs = mask(server.seen());
        QCOMPARE(gotReqs.items.size(), wantReqs.items.size());
        const bool fetch = name.startsWith(u"e_"_s) || name.startsWith(u"ssrf_e_"_s);
        for (qsizetype i = 0; i < wantReqs.items.size(); ++i) {
            const OJson& w = wantReqs.items[i];
            const OJson& g = gotReqs.items[i];
            const QString what = name + u" 第 "_s + QString::number(i + 1) + u" 个请求"_s;
            QCOMPARE(g.get(u"method"_s)->s, w.get(u"method"_s)->s);
            QCOMPARE(g.get(u"path"_s)->s, w.get(u"path"_s)->s);
            JSFIX_SAME(filteredHeaders(*w.get(u"headers"_s), fetch), filteredHeaders(*g.get(u"headers"_s), fetch), what + u" 的头"_s);
            JSFIX_SAME(*w.get(u"body"_s), *g.get(u"body"_s), what + u" 的正文"_s);
        }
        QCOMPARE(blocked_, 0);
    }

    // ---------------------------------------------------------------- 纯函数
    void stripCodeFence() {
        for (const OJson& c : fx_.get(u"pure"_s)->get(u"stripCodeFence"_s)->items)
            JSFIX_EXPECT(c, [&] { return js::S(pv::stripCodeFence(c.get(u"in"_s)->s)); }, u"stripCodeFence("_s + c.get(u"in"_s)->s + u")"_s);
    }

    void supportsSampling() {
        for (const OJson& c : fx_.get(u"pure"_s)->get(u"supportsSampling"_s)->items)
            QCOMPARE(pv::supportsSamplingParams(c.get(u"in"_s)->s), c.get(u"out"_s)->b);
    }

    void catalogAndTables() {
        const OJson& p = *fx_.get(u"pure"_s);
        JSFIX_SAME(*p.get(u"catalog"_s), pv::providerCatalog(), u"providerCatalog"_s);
        JSFIX_SAME(*p.get(u"providers"_s), pv::providersTable(), u"PROVIDERS"_s);
        const OJson& ec = *p.get(u"embedConsts"_s);
        QCOMPARE(em::kDefaultEmbedModel, ec.get(u"model"_s)->s);
        QCOMPARE(em::kDefaultEmbedUrl, ec.get(u"url"_s)->s);
        QCOMPARE(em::kQueryInstruction, ec.get(u"query"_s)->s);
        // 目录里配置校验要的那一份(domain::providerMeta)与这里的一致
        for (const auto& [k, meta] : pv::providersTable().fields) {
            const domain::ProviderMeta* m = domain::providerMeta().find(k);
            QVERIFY(m);
            QCOMPARE(m->needs_base_url, meta.get(u"needs_base_url"_s)->b);
            QCOMPARE(m->default_model, meta.get(u"default_model"_s)->s);
        }
    }

    void schemas() {
        const QString assets = QStringLiteral(IBKR_REPO_DIR) + u"/engine-ts/baseline/llm"_s;
        for (const OJson& c : fx_.get(u"pure"_s)->get(u"schemas"_s)->items) {
            OJson want = c;
            JSFIX_EXPECT(want, [&] {
                try {
                    return pv::structuredOutputSchema(c.get(u"in"_s)->s);
                } catch (const util::JsError& e) {
                    throw util::JsError(QString(e.message()).replace(assets, u"<ASSETS>"_s));
                }
            }, u"structuredOutputSchema("_s + c.get(u"in"_s)->s + u")"_s);
        }
        for (const OJson& c : fx_.get(u"pure"_s)->get(u"schemaForPrompt"_s)->items) {
            const OJson s = pv::parseSchemaForPrompt(c.get(u"in"_s)->s);
            const OJson* en = js::path(&s, {u"$defs"_s, u"Rejection"_s, u"properties"_s, u"code"_s, u"enum"_s});
            QVERIFY(en);
            JSFIX_SAME(*c.get(u"out"_s), *en, u"parseSchemaForPrompt("_s + c.get(u"in"_s)->s + u")"_s);
        }
        // 每次给的是拷贝:改了不影响下一次
        OJson a = pv::structuredOutputSchema();
        a.set(u"$defs"_s, js::Null());
        QVERIFY(pv::structuredOutputSchema().get(u"$defs"_s)->isObject());
    }

    void friendly() {
        for (const OJson& c : fx_.get(u"pure"_s)->get(u"friendly"_s)->items) {
            pv::ErrorView v{c.get(u"name"_s)->s, c.get(u"message"_s)->s, std::nullopt};
            const OJson st = dec(*c.get(u"status"_s));
            if (st.type == OJson::Number) v.status = st.n;
            QCOMPARE(pv::friendlyApiError(v, c.get(u"base"_s)->s), c.get(u"out"_s)->s);
        }
    }

    void loopback() {
        for (const OJson& c : fx_.get(u"pure"_s)->get(u"loopback"_s)->items) {
            const QString in = c.get(u"in"_s)->s;
            if (em::isLoopbackUrl(in) != c.get(u"out"_s)->b) QFAIL(qPrintable(u"isLoopbackUrl("_s + in + u")"_s));
        }
    }

    void cosine() {
        for (const OJson& c : fx_.get(u"pure"_s)->get(u"cosine"_s)->items) {
            const OJson got = js::N(em::cosine(em::toNumbers(dec(*c.get(u"a"_s))), em::toNumbers(dec(*c.get(u"b"_s)))));
            JSFIX_SAME(*c.get(u"out"_s), got, u"cosine"_s);
        }
        // 回包里的向量不验元素:null 当 0、数字串按 Number()、对象是 NaN(TS 的 a[i] ?? 0 再相乘)
        const auto v = em::toNumbers(*js::parse(u"[null, \"2\", {}, true]"_s));
        QCOMPARE(v.size(), size_t(4));
        QCOMPARE(v[0], 0.0);
        QCOMPARE(v[1], 2.0);
        QVERIFY(std::isnan(v[2]));
        QCOMPARE(v[3], 1.0);
    }

    // ---------------------------------------------------------------- 没对拍的(SDK 源码里读出来的)
    void nodeTimerSemantics() {
        // Node 的 setTimeout:不在 [1, 2^31−1] 里就当 1 毫秒(timeout_s 填得太大 = 每次一发出去就超时),小数往下取
        QCOMPARE(sdk::nodeTimerMs(0), 1);
        QCOMPARE(sdk::nodeTimerMs(0.5), 1);
        QCOMPARE(sdk::nodeTimerMs(1.9), 1);
        QCOMPARE(sdk::nodeTimerMs(437.5), 437);
        QCOMPARE(sdk::nodeTimerMs(2147483647.0), 2147483647);
        QCOMPARE(sdk::nodeTimerMs(2147483648.0), 1);
        QCOMPARE(sdk::nodeTimerMs(std::nan("")), 1);
        QCOMPARE(sdk::nodeTimerMs(-5), 1);
    }

    void makeMessageShapes() {
        // APIError.makeMessage:没有状态码时只给话;都没有是那句兜底
        QCOMPARE(sdk::makeMessage(std::nullopt, nullptr, u"Connection error."_s), u"Connection error."_s);
        QCOMPARE(sdk::makeMessage(std::nullopt, nullptr, std::nullopt), u"(no status code or body)"_s);
        const OJson zeroMsg = *js::parse(u"{\"message\":0,\"x\":1}"_s);
        QCOMPARE(sdk::makeMessage(500, &zeroMsg, std::nullopt), u"500 {\"message\":0,\"x\":1}"_s);
        QCOMPARE(sdk::statusErrorName(418), u"APIError"_s);
        QCOMPARE(sdk::statusErrorName(409), u"ConflictError"_s);
        QCOMPARE(sdk::statusErrorName(599), u"InternalServerError"_s);
        // *_CUSTOM_HEADERS:没冒号的行丢掉;名字与值两头去空白;同名后写的覆盖
        const auto h = sdk::parseCustomHeaders(u"A: 1\nnoline\n B :2 \nA: 3"_s);
        QCOMPARE(h.size(), 2);
        QCOMPARE(h[0].first, u"A"_s);
        QCOMPARE(h[0].second, u"3"_s);
        QCOMPARE(h[1].second, u"2"_s);
    }

    /// undici 等头的 300 秒(这里缩成 200 毫秒):两边都按超时重试;OpenAI 最后换成那句长话,Anthropic 还是 Request timed out.
    void undiciHeadersTimeout() {
        for (const bool anth : {true, false}) {
            QList<OJson> script;
            for (int i = 0; i < 3; ++i) script << js::object({{u"status"_s, js::N(200)}, {u"body"_s, js::object()}, {u"delayMs"_s, js::N(1500)}});
            FakeEndpoint server(script);
            const QString host = u"127.0.0.1:"_s + QString::number(server.port());
            EnvScope env;
            env.set(u"ANTHROPIC_BASE_URL"_s, u"http://"_s + host);
            HooksScope hooks;
            sdk::Hooks h = sdk::hooks();
            h.undiciHeadersTimeoutMs = 200;
            sdk::setHooks(h);
            OJson raw = *fx_.get(u"base_config"_s)->get(anth ? u"anthropic"_s : u"openai_compatible"_s);
            const auto parser = pv::buildParser(configOf(raw, u"http://"_s + host + u"/v1"_s), u"sk-test-x"_s);
            const auto t = parser->completeJson(u"s"_s, u"u"_s, js::object());
            QVERIFY(waitFor(t));
            QVERIFY(t.error());
            const QString msg = errorJson(t.error()).get(u"message"_s)->s;
            if (anth) QCOMPARE(msg, u"APIConnectionTimeoutError: Request timed out."_s);  // friendlyApiError 不认这个类名,原样带出
            else QVERIFY2(msg.startsWith(u"无法连接 http://"_s + host + u"/v1:Request timed out. Node.js fetch timed out waiting for response headers"_s), qPrintable(msg));
            QCOMPARE(server.seen().items.size(), 3);
        }
    }

    /// undici 正文两块之间的 300 秒(缩成 200 毫秒):Anthropic 正文读不完是 TypeError: terminated
    void undiciBodyTimeout() {
        QList<OJson> script{js::object({{u"status"_s, js::N(200)}, {u"headers"_s, js::object({{u"content-type"_s, js::S(u"application/json"_s)}})},
                                        {u"partial"_s, js::S(u"{\"a\":"_s)}, {u"stallMs"_s, js::N(1500)}, {u"rest"_s, js::S(u"1}"_s)}})};
        FakeEndpoint server(script);
        EnvScope env;
        env.set(u"ANTHROPIC_BASE_URL"_s, u"http://127.0.0.1:"_s + QString::number(server.port()));
        HooksScope hooks;
        sdk::Hooks h = sdk::hooks();
        h.undiciBodyTimeoutMs = 200;
        sdk::setHooks(h);
        OJson raw = *fx_.get(u"base_config"_s)->get(u"anthropic"_s);
        const auto parser = pv::buildParser(configOf(raw, {}), u"sk-test-x"_s);
        const auto t = parser->parse(bundleOf(*fx_.get(u"bundles"_s)->get(u"b0"_s)), u"x"_s);
        QVERIFY(waitFor(t));
        QVERIFY(t.error());
        QCOMPARE(errorJson(t.error()).get(u"message"_s)->s, u"调用 Anthropic 失败:TypeError: terminated"_s);
    }

    /// HTTP/1.1 那一层的几种回话(对拍的假端点写不出来的):重复的头、读到关的正文、103 跳过、204 不带长度、坏的分块头、BOM
    void transport() {
        QCOMPARE(sdk::fetchText(QByteArray("\xEF\xBB\xBF{}")), u"{}"_s);  // fetch 的 text() 去掉 BOM
        sdk::Headers none;
        const auto head = [&](const QString& url) { return QString::fromLatin1(sdk::requestBytes("POST", *wu::parse(url), none, "x")).section(u"\r\n"_s, 1, 1); };
        QCOMPARE(head(u"http://h.test:80/p?q=1"_s), u"host: h.test"_s);
        QCOMPARE(head(u"https://h.test:443/"_s), u"host: h.test"_s);
        QCOMPARE(head(u"http://h.test:8080/"_s), u"host: h.test:8080"_s);
        QCOMPARE(head(u"http://[::1]:5/"_s), u"host: [::1]:5"_s);
        QVERIFY(sdk::requestBytes("POST", *wu::parse(u"http://h.test/a?b=1"_s), none, "xy").startsWith("POST /a?b=1 HTTP/1.1\r\n"));
        // 自己给的 host 用它;自己给的 content-length / transfer-encoding / connection 一律不发
        sdk::Headers custom;
        custom.set(u"Host"_s, u"vhost.test"_s);
        custom.set(u"Content-Length"_s, u"1"_s);
        custom.set(u"Transfer-Encoding"_s, u"chunked"_s);
        custom.set(u"Connection"_s, u"keep-alive"_s);
        const QString raw = QString::fromLatin1(sdk::requestBytes("POST", *wu::parse(u"http://h.test/"_s), custom, "xy"));
        QCOMPARE(raw.count(u"host:"_s), 1);
        QVERIFY(raw.contains(u"host: vhost.test\r\n"_s));
        QCOMPARE(raw.count(u"content-length:"_s), 1);
        QVERIFY(raw.contains(u"content-length: 2\r\n"_s));
        QVERIFY(!raw.contains(u"transfer-encoding"_s));
        QCOMPARE(raw.count(u"connection:"_s), 1);

        // 最后一道:头里要是还带着 CR LF NUL,Exchange 自己也不发(上游校验漏了的话,这里不让多出一个头)
        for (const QString& bad : {u"1\r\nX-Evil: 1"_s, u"1\nX-Evil: 1"_s, u"1\rX"_s, u"a"_s + QString(QChar(0)) + u"b"_s}) {
            FakeEndpoint witness({});
            sdk::Headers evil;
            evil.set(u"x-a"_s, bad);
            const auto ex = sdk::Exchange::start("POST", *wu::parse(u"http://127.0.0.1:%1/"_s.arg(witness.port())), evil, "x");
            const auto h = ex->headers();
            QVERIFY(waitFor(h, 2000));
            QCOMPARE(int(h.result()), int(sdk::Exchange::Fail::Network));
            QTest::qWait(30);
            QCOMPARE(witness.seen().items.size(), 0);
        }
        sdk::Headers evilName;
        evilName.set(u"x-a\r\nX-Evil"_s, u"1"_s);
        {
            FakeEndpoint witness({});
            const auto ex = sdk::Exchange::start("POST", *wu::parse(u"http://127.0.0.1:%1/"_s.arg(witness.port())), evilName, "x");
            const auto h = ex->headers();
            QVERIFY(waitFor(h, 2000));
            QCOMPARE(int(h.result()), int(sdk::Exchange::Fail::Network));
        }

        struct Case {
            QByteArray reply;
            bool close;
            int status;
            sdk::Exchange::Fail head;
            sdk::Exchange::Fail fail;
            QByteArray body;
        };
        using F = sdk::Exchange::Fail;
        const QList<Case> cases{
            {"HTTP/1.1 200 OK\r\nX-A: 1\r\nx-a: 2\r\ncontent-length: 2\r\n\r\nok", false, 200, F::None, F::None, "ok"},
            {"HTTP/1.1 200 OK\r\n\r\nhello", true, 200, F::None, F::None, "hello"},  // 读到关
            {"HTTP/1.1 103 Early Hints\r\n\r\nHTTP/1.1 201 Created\r\ncontent-length: 2\r\n\r\nok", false, 201, F::None, F::None, "ok"},
            {"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 201 Created\r\ncontent-length: 2\r\n\r\nok", false, 0, F::Network, F::Network, ""},  // undici 没要过 Expect:当连接错
            {"HTTP/1.1 204 No Content\r\n\r\n", false, 204, F::None, F::None, ""},  // 不带长度、不关:也是马上完
            {"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n2\r\nab\r\n1;x=y\r\nc\r\n0\r\nT: 1\r\n\r\n", false, 200, F::None, F::None, "abc"},
            {"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\nzz\r\n", false, 200, F::None, F::Truncated, ""},
            {"HTTP/1.1 304 Not Modified\r\n\r\n", false, 304, F::None, F::None, ""},  // 304 没有正文:不关连接也马上完
            // 保持连接不关的服务器 + 坏回话:要当场出错,不能等到超时(落单的 CR 一收到就是错;分块的一块之后不是 CRLF 当场是错)
            {"HTTP/1.1 200 OK\rX", false, 0, F::Network, F::Network, ""},
            {"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n7\r\n{\"a\":1}X", false, 200, F::None, F::Truncated, ""},
            {"HTTP/1.1 200 OK\r\ncontent-length: abc\r\n\r\n", false, 0, F::Network, F::Network, ""},
            {"HTTP/1.1 200 OK\nx: y\r\n\r\n", false, 0, F::Network, F::Network, ""},
        };
        for (const Case& c : cases) {
            QTcpServer server;
            QVERIFY(server.listen(QHostAddress(u"127.0.0.1"_s), 0));
            QObject::connect(&server, &QTcpServer::newConnection, &server, [&server, c] {
                QTcpSocket* s = server.nextPendingConnection();
                QObject::connect(s, &QTcpSocket::readyRead, s, [s, c] {
                    if (!s->readAll().contains("\r\n\r\n")) return;
                    s->write(c.reply);
                    if (c.close) s->disconnectFromHost();
                });
            });
            const auto ex = sdk::Exchange::start("POST", *wu::parse(u"http://127.0.0.1:%1/"_s.arg(server.serverPort())), none, "{}");
            ex->startDeadline(3000);
            const auto h = ex->headers();
            QVERIFY(waitFor(h, 5000));
            QCOMPARE(int(h.result()), int(c.head));  // Deadline = 该当场出错的出错晚了
            if (c.head != F::None) continue;
            QCOMPARE(ex->status(), c.status);
            const auto b = ex->body();
            QVERIFY(waitFor(b, 5000));
            QCOMPARE(int(b.result().first), int(c.fail));
            QCOMPARE(b.result().second, c.body);
            if (c.status == 200 && !c.close && c.body == "ok") QCOMPARE(ex->header(u"X-A"_s), u"1, 2"_s);
        }
    }

    /// Url 的几个取值:拨号的主机 / 端口、Host、请求目标、凭证
    void urlAccessors() {
        const auto u = [](const QString& s) { return *wu::parse(s); };
        QCOMPARE(u(u"http://h.test/"_s).dialPort(), 80);
        QCOMPARE(u(u"https://h.test/"_s).dialPort(), 443);
        QCOMPARE(u(u"http://h.test:8080/"_s).dialPort(), 8080);
        QCOMPARE(u(u"http://[::1]:5/"_s).dialHost(), u"::1"_s);
        QCOMPARE(u(u"http://[::1]:5/"_s).host(), u"[::1]:5"_s);
        QCOMPARE(u(u"http://h.test:80/"_s).host(), u"h.test"_s);
        QCOMPARE(u(u"http://h.test:81/a/b?c=1#d"_s).requestTarget(), u"/a/b?c=1"_s);
        QCOMPARE(u(u"http://h.test"_s).requestTarget(), u"/"_s);
        QVERIFY(!u(u"http://h.test/"_s).hasCredentials());
        QVERIFY(u(u"http://a@h.test/"_s).hasCredentials());
        QVERIFY(u(u"http://:b@h.test/"_s).hasCredentials());
        QVERIFY(!u(u"http://@h.test/"_s).hasCredentials());
        QCOMPARE(u(u"http://a:b@h.test:81/p?q#f"_s).href(), u"http://a:b@h.test:81/p?q#f"_s);
        QCOMPARE(u(u"http://a@h.test/"_s).href(), u"http://a@h.test/"_s);
        // IPv6 回环:真的拨 [::1](没有 IPv6 的机器跳过)
        QTcpServer v6;
        if (!v6.listen(QHostAddress(QHostAddress::LocalHostIPv6), 0)) QSKIP("本机没有 IPv6 回环");
        QObject::connect(&v6, &QTcpServer::newConnection, &v6, [&v6] {
            QTcpSocket* s = v6.nextPendingConnection();
            QObject::connect(s, &QTcpSocket::readyRead, s, [s] {
                if (!s->readAll().contains("\r\n\r\n")) return;
                s->write("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok");
                s->disconnectFromHost();
            });
        });
        sdk::Headers none;
        const auto ex = sdk::Exchange::start("POST", u(u"http://[::1]:%1/"_s.arg(v6.serverPort())), none, "x");
        ex->startDeadline(3000);
        const auto b = ex->body();
        QVERIFY(waitFor(b, 5000));
        QCOMPARE(b.result().second, QByteArray("ok"));
    }

    // ---------------------------------------------------------------- 地址:校验与连接出自同一个解析器
    /// `new URL(…)` 现跑的结果与这边的解析器逐项比:协议、用户名、密码、主机、端口、路径、查询、片段与 href
    void urlParsing() {
        int compared = 0;
        for (const OJson& c : fx_.get(u"urls"_s)->items) {
            const QString in = c.get(u"u"_s)->s;
            const OJson* href = c.get(u"href"_s);
            const auto got = wu::parse(in);
            const QString what = u"new URL("_s + js::stringify(js::S(in)) + u")"_s;
            if (href->type == OJson::Null) {
                // TS 解析不了:http(s) 绝不许这边解析得了(非特殊协议这边只认协议名,不校验,见头注释)
                if (got && got->isHttp()) QFAIL(qPrintable(what + u":TS 拒,这边收:"_s + got->href()));
                continue;
            }
            const OJson& f = *c.get(u"f"_s);
            const QString protocol = f.items[0].s;
            QVERIFY2(got, qPrintable(what + u":TS 收(" + href->s + u"),这边拒"_s));
            if (protocol != u"http:" && protocol != u"https:") {
                QVERIFY2(!got->isHttp() && got->scheme + u':' == protocol, qPrintable(what));
                continue;
            }
            ++compared;
            QVERIFY2(got->isHttp(), qPrintable(what));
            const QString gotFields = got->scheme + u":|"_s + got->username + u'|' + got->password + u'|' + got->hostname + u'|' + got->port + u'|' + got->path + u'|' +
                                      (got->query ? u'?' + *got->query : QString()) + u'|' + (got->fragment ? u'#' + *got->fragment : QString());
            QStringList want;
            for (const OJson& x : f.items) want << x.s;
            // JS 的 search / hash:空查询(`?`)的 search 是空串
            const QString wantFields = want[0] + u'|' + want[1] + u'|' + want[2] + u'|' + want[3] + u'|' + want[4] + u'|' + want[5] + u'|' + want[6] + u'|' + want[7];
            const QString g2 = got->scheme + u":|"_s + got->username + u'|' + got->password + u'|' + got->hostname + u'|' + got->port + u'|' + got->path + u'|' +
                               (got->query && !got->query->isEmpty() ? u'?' + *got->query : QString()) + u'|' + (got->fragment && !got->fragment->isEmpty() ? u'#' + *got->fragment : QString());
            Q_UNUSED(gotFields);
            if (g2 != wantFields) QFAIL(qPrintable(what + u"\n  TS :"_s + wantFields + u"\n  C++:"_s + g2));
            if (got->href() != href->s) QFAIL(qPrintable(what + u"\n  TS href :"_s + href->s + u"\n  C++ href:"_s + got->href()));
        }
        QVERIFY(compared > 1000);
    }

    /// 校验放行的地址(validateBaseUrl 与 isLoopbackUrl 都是按 WHATWG 判的)与实际拨号的主机必须是同一个:放行了的,
    /// 明文 http 的主机就必须是回环。语料里每一个写法都过一遍(含 `http://127.0.0.1:A\@localhost:B` 一类)
    void validationAndDialAgree() {
        int accepted = 0;
        for (const OJson& c : fx_.get(u"urls"_s)->items) {
            const QString in = c.get(u"u"_s)->s;
            const OJson& v = *c.get(u"validate"_s);
            // validateBaseUrl 的结论与 TS 一致(共享函数,这里只看它没有在这份语料上和 TS 分歧)
            QString validated;
            bool ok = true;
            QString err;
            try {
                validated = domain::validateBaseUrl(in);
            } catch (const util::JsError& e) {
                ok = false;
                err = e.message();
            }
            const bool tsOk = v.get(u"ok"_s) != nullptr;
            // validateBaseUrl 与 llm 的连接共用 util::whatwg,和 TS 逐条一致(放行与拒绝、放行后的串、拒绝的话)
            QVERIFY2(ok == tsOk, qPrintable(u"validateBaseUrl("_s + js::stringify(js::S(in)) + u") 与 TS 分歧"_s));
            if (ok) QCOMPARE(validated, v.get(u"ok"_s)->s);
            else QCOMPARE(err, v.get(u"error"_s)->s);
            if (!ok) continue;
            ++accepted;
            const auto parsed = wu::parse(validated);
            QVERIFY2(parsed && parsed->isHttp(), qPrintable(validated));
            if (parsed->scheme == u"http")
                QVERIFY2(wu::isLoopbackHostname(parsed->hostname), qPrintable(u"放行了 "_s + js::stringify(js::S(in)) + u",拨号主机却是 "_s + parsed->hostname));
            // 嵌入的本机地址规则(isLoopbackUrl)同样:放行 ⇒ 拨号主机是回环
            QCOMPARE(em::isLoopbackUrl(in), c.get(u"loop"_s)->b);
            if (c.get(u"loop"_s)->b) {
                const auto p = wu::parse(in);
                QVERIFY(p && wu::isLoopbackHostname(p->hostname));
            }
        }
        QVERIFY(accepted > 200);
    }

    /// 真的 SDK 的 buildURL(两个 SDK 各一份)与 joinUrl 逐条比;查询里带路径、点段、制表符、凭证、没有协议……
    void urlJoining() {
        for (const OJson& row : fx_.get(u"joins"_s)->items) {
            const QString base = row.get(u"base"_s)->s;
            for (const auto& [key, path] : {std::pair{u"openai"_s, u"/chat/completions"_s}, std::pair{u"anthropic"_s, u"/v1/messages"_s}}) {
                const OJson& want = *row.get(key);
                const QString what = key + u" joinUrl("_s + js::stringify(js::S(base)) + u")"_s;
                try {
                    const wu::Url got = sdk::joinUrl(base, path);
                    const OJson* ok = want.get(u"ok"_s);
                    if (!ok) QFAIL(qPrintable(what + u":TS 抛「"_s + want.get(u"error"_s)->s + u"」,这边收:"_s + got.href()));
                    // 非 http(s) 协议这边只认协议名
                    const QString scheme = ok->s.section(u':', 0, 0);
                    if (scheme.toLower() == u"http" || scheme.toLower() == u"https") QCOMPARE(got.href(), ok->s);
                    else QVERIFY(!got.isHttp());
                } catch (const sdk::NamedError& e) {
                    const OJson* err = want.get(u"error"_s);
                    if (!err) QFAIL(qPrintable(what + u":TS 收 "_s + want.get(u"ok"_s)->s + u",这边抛:"_s + e.message()));
                    QCOMPARE(e.name + u": "_s + e.message(), err->s);
                }
            }
        }
    }

    /// 回归:validateBaseUrl 与 WHATWG 都读成 127.0.0.1:A(路径 /@localhost:B)的地址,请求必须去 A,绝不去 B。
    /// 原来 QUrl 把它读成 localhost:B,带 Authorization 的请求发到了别的端口
    void regressionBackslashAt() {
        for (const QString& tmpl : {u"http://127.0.0.1:%1\\@localhost:%2"_s, u"http://127.0.0.1:%1\\@127.0.0.1:%2"_s, u"http://127.0.0.1:%1\\@localhost:%2/v1"_s}) {
            FakeEndpoint a({js::object({{u"status"_s, js::N(200)}, {u"body"_s, js::object({{u"embeddings"_s, js::array({js::array({js::N(1)})})}})}}),
                            js::object({{u"status"_s, js::N(200)}, {u"body"_s, js::object({{u"choices"_s, js::array({js::object({{u"message"_s, js::object({{u"content"_s, js::S(u"{}"_s)}})}})})}})}}),
                            js::object({{u"status"_s, js::N(200)}, {u"body"_s, js::object({{u"content"_s, js::array({js::object({{u"type"_s, js::S(u"text"_s)}, {u"text"_s, js::S(u"{}"_s)}})})}})}})});
            FakeEndpoint b({});
            const QString base = tmpl.arg(a.port()).arg(b.port());
            QVERIFY2(!base.isEmpty(), "");
            QString validated;
            try {
                validated = domain::validateBaseUrl(base);
            } catch (const util::JsError&) {
                QFAIL("validateBaseUrl 该放行这个地址(TS 就放行)");
            }
            // 嵌入
            const em::OllamaEmbedder e(base, u"m"_s);
            const auto et = e.embed({u"x"_s}, 3000);
            QVERIFY(waitFor(et));
            QVERIFY2(!et.error(), "嵌入应该成功地去了 A");
            // OpenAI 兼容
            OJson raw = *fx_.get(u"base_config"_s)->get(u"openai_compatible"_s);
            const auto po = pv::buildParser(configOf(raw, validated), u"sk-test-secret"_s);
            const auto ot = po->completeJson(u"s"_s, u"u"_s, js::object());
            QVERIFY(waitFor(ot));
            // Anthropic(环境变量里的地址)
            EnvScope env;
            env.set(u"ANTHROPIC_BASE_URL"_s, base);
            const auto pa = pv::buildParser(configOf(*fx_.get(u"base_config"_s)->get(u"anthropic"_s), {}), u"sk-test-secret"_s);
            const auto at = pa->completeJson(u"s"_s, u"u"_s, js::object());
            QVERIFY(waitFor(at));
            QCOMPARE(a.seen().items.size(), 3);
            for (const OJson& r : a.seen().items) QVERIFY(r.get(u"path"_s)->s.startsWith(u"/@"_s) || r.get(u"path"_s)->s.startsWith(u"//@"_s));
            QCOMPARE(b.seen().items.size(), 0);  // B 一个字节都没收到:Key 没有去别处
        }
    }

    /// 头注入:钥匙里藏换行,不管是尾巴上的(去掉就是正常的钥匙)还是中间的(整个请求不发),都不会让端点多看到一个头
    void headerInjection() {
        for (const bool anth : {true, false}) {
            struct Case {
                QString key;
                int requests;
                QString sent;
            };
            for (const Case& c : {Case{u"sk-a\n"_s, 1, u"sk-a"_s}, Case{u"sk-a\r\nX-Evil: 1"_s, 0, {}}, Case{u"sk-a\rX-Evil: 1"_s, 0, {}}, Case{u"sk-a\nX-Evil: 1"_s, 0, {}}, Case{u"sk-a"_s + QString(QChar(0)) + u"X-Evil: 1"_s, 0, {}}}) {
                FakeEndpoint server({anth ? js::object({{u"status"_s, js::N(200)}, {u"body"_s, js::object({{u"content"_s, js::array({js::object({{u"type"_s, js::S(u"text"_s)}, {u"text"_s, js::S(u"{}"_s)}})})}})}})
                                          : js::object({{u"status"_s, js::N(200)}, {u"body"_s, js::object({{u"choices"_s, js::array({js::object({{u"message"_s, js::object({{u"content"_s, js::S(u"{}"_s)}})}})})}})}})});
                EnvScope env;
                const QString host = u"127.0.0.1:"_s + QString::number(server.port());
                env.set(u"ANTHROPIC_BASE_URL"_s, u"http://"_s + host);
                OJson raw = *fx_.get(u"base_config"_s)->get(anth ? u"anthropic"_s : u"openai_compatible"_s);
                const auto parser = pv::buildParser(configOf(raw, u"http://"_s + host + u"/v1"_s), c.key);
                const auto t = parser->completeJson(u"s"_s, u"u"_s, js::object());
                QVERIFY(waitFor(t));
                QCOMPARE(int(server.seen().items.size()), c.requests);
                if (c.requests == 0) {
                    QVERIFY(t.error());
                    continue;
                }
                QVERIFY(!t.error());
                for (const OJson& kv : server.seen().items[0].get(u"headers"_s)->items) {
                    QVERIFY2(kv.items[0].s != u"x-evil", "多出来一个头");
                    if (kv.items[0].s == u"x-api-key" || kv.items[0].s == u"authorization") QVERIFY(kv.items[1].s.endsWith(c.sent));
                }
            }
        }
    }

    /// URL.search = value:空串是没有查询;别的按特殊协议的查询集合编码
    void searchSetter() {
        auto u = *wu::parse(u"http://h.test/p?old=1"_s);
        wu::setSearch(u, QString());
        QVERIFY(!u.query.has_value());
        QCOMPARE(u.href(), u"http://h.test/p"_s);
        wu::setSearch(u, u"?a b'c\t#"_s);
        QCOMPARE(*u.query, u"a%20b%27c%23"_s);
        wu::setSearch(u, u"?"_s);
        QVERIFY(!u.query.has_value());
    }

    /// 闸要真的拦住:0.0.0.0 不在 127.0.0.0/8 里,但在本机上连得到(连到 127.0.0.1 上的假端点)——放掉闸这里就会收到请求
    void plainHttpGateBlocksReachableNonLoopback() {
        FakeEndpoint witness({});
        {
            QTcpSocket probe;
            probe.connectToHost(u"0.0.0.0"_s, witness.port());
            if (!probe.waitForConnected(1000)) QSKIP("这台机器上连 0.0.0.0 连不到本机(平台不同)");
            probe.abort();
            QTest::qWait(30);
            witness.clearSeen();
        }
        using F = sdk::Exchange::Fail;
        sdk::Headers none;
        const auto ex = sdk::Exchange::start("POST", *wu::parse(u"http://0.0.0.0:%1/"_s.arg(witness.port())), none, "x");
        const auto h = ex->headers();
        QVERIFY(waitFor(h, 2000));
        QCOMPARE(int(h.result()), int(F::Network));
        QTest::qWait(50);
        QCOMPARE(witness.seen().items.size(), 0);
    }

    /// 闸的覆盖:明文 http 到这些主机一律不拨——三种客户端(Anthropic 走 ANTHROPIC_BASE_URL,那条路上游没有 validateBaseUrl;OpenAI 兼容的 sdk::Client 直连;
    /// 嵌入的 Exchange)都一样。不靠"拨过去连得上与否"判:Hooks::dialObserver 记下 Exchange 真要拨的每一个主机,被拦下的永远走不到那一步;
    /// 回环诱饵(127.0.0.1 与 ::1,同一个端口)同时数连接,一个都不许有
    void gateRefusesNonLoopbackHosts() {
        ConnectionCounter decoy;
        QStringList dials;
        HooksScope hooks;
        sdk::Hooks h = sdk::hooks();
        h.dialObserver = [&dials](const QString& host, int) { dials << host; };
        sdk::setHooks(h);
        const QStringList bad{u"0.0.0.0"_s, u"0.1.2.3"_s, u"0.255.255.255"_s, u"[::ffff:127.0.0.1]"_s, u"[::ffff:7f00:1]"_s, u"[::]"_s, u"[::ffff:0.0.0.0]"_s,
                              u"128.0.0.1"_s, u"126.255.255.255"_s, u"10.0.0.1"_s, u"192.168.1.1"_s, u"localhost."_s, u"127.0.0.1.nip.io"_s, u"example.com"_s, u"[2001:db8::1]"_s,
                              u"2130706434"_s /* 127.0.0.2 的整数写法:解析器规整成 127.0.0.2,这条要放行,见下面的对照 */};
        // 最后那个其实是回环(WHATWG 把整数写法规整成 127.0.0.2):放到对照里,不放在拒绝的名单里
        QStringList refused = bad;
        refused.removeLast();
        for (const QString& host : refused) {
            const QString base = u"http://"_s + host + u':' + QString::number(decoy.port());
            const QString what = u"base = "_s + base;
            // (a) Anthropic:ANTHROPIC_BASE_URL(上游没有校验,这一道闸是唯一的拦截)
            {
                EnvScope env;
                env.set(u"ANTHROPIC_BASE_URL"_s, base);
                const auto parser = pv::buildParser(configOf(*fx_.get(u"base_config"_s)->get(u"anthropic"_s), {}), u"sk-test-secret"_s);
                const auto t = parser->completeJson(u"s"_s, u"u"_s, js::object());
                QVERIFY2(waitFor(t), qPrintable(what));
                QVERIFY2(t.error(), qPrintable(what));
            }
            // (b) OpenAI 兼容的 sdk::Client 直连(不经 validateBaseUrl)
            {
                sdk::ClientOptions o;
                o.flavor = sdk::Flavor::OpenAI;
                o.baseURL = base + u"/v1"_s;
                o.apiKey = u"sk-test-secret"_s;
                o.maxRetries = 0;
                o.timeoutMs = 1000;
                const sdk::Client client(o);
                const auto t = client.post(u"/chat/completions"_s, js::object());
                QVERIFY2(waitFor(t), qPrintable(what));
                QVERIFY2(t.error(), qPrintable(what));
            }
            // (c) 经 parser 的 OpenAI 兼容:构造时 validateBaseUrl 就拒;嵌入的构造函数也拒
            try {
                pv::buildParser(configOf(*fx_.get(u"base_config"_s)->get(u"openai_compatible"_s), base + u"/v1"_s), u"sk-test-secret"_s);
                QFAIL(qPrintable(what + u":validateBaseUrl 该拒"_s));
            } catch (const util::JsError&) {
            }
            QVERIFY2_THROWS(em::OllamaEmbedder(base, u"m"_s), em::EmbedError, what);
            // (d) 嵌入走的 Exchange 直接来(绕开构造函数的检查)
            {
                sdk::Headers none;
                const auto ex = sdk::Exchange::start("POST", *wu::parse(base + u"/api/embed"_s), none, "x");
                const auto head = ex->headers();
                QVERIFY2(waitFor(head, 2000), qPrintable(what));
                QCOMPARE(int(head.result()), int(sdk::Exchange::Fail::Network));
            }
        }
        QTest::qWait(80);
        QVERIFY2(dials.isEmpty(), qPrintable(u"拨过:"_s + dials.join(u','))); 
        QCOMPARE(decoy.connections(), 0);
        QCOMPARE(decoy.bytes(), qint64(0));

        // 对照:回环的各种写法都放行,而且拨的就是解析器给的那个主机
        const QList<QPair<QString, QString>> good{{u"127.0.0.1"_s, u"127.0.0.1"_s}, {u"127.0.0.2"_s, u"127.0.0.2"_s}, {u"127.255.255.254"_s, u"127.255.255.254"_s},
                                                  {u"localhost"_s, u"localhost"_s}, {u"LOCALHOST"_s, u"localhost"_s}, {u"[::1]"_s, u"::1"_s}, {u"[0:0:0:0:0:0:0:1]"_s, u"::1"_s},
                                                  {u"2130706434"_s, u"127.0.0.2"_s}, {u"0x7f.1"_s, u"127.0.0.1"_s}};
        for (const auto& [written, dialled] : good) {
            dials.clear();
            sdk::Headers none;
            const auto ex = sdk::Exchange::start("POST", *wu::parse(u"http://"_s + written + u':' + QString::number(decoy.port()) + u"/"_s), none, "x");
            ex->startDeadline(500);
            const auto head = ex->headers();
            QVERIFY(waitFor(head, 3000));
            QCOMPARE(dials, QStringList{dialled});
        }
    }

    /// 对端核对的判定本身:明文只认回环;https 不看(没有 TLS 对端可以在离线测试里连,所以判定单拎出来测)
    void peerAllowedRule() {
        const auto allowed = [](bool plain, const QString& a) { return sdk::Exchange::peerAllowed(plain, QHostAddress(a)); };
        for (const QString& loop : {u"127.0.0.1"_s, u"127.0.0.2"_s, u"127.255.255.254"_s, u"::1"_s}) {
            QVERIFY2(allowed(true, loop), qPrintable(loop));
            QVERIFY2(allowed(false, loop), qPrintable(loop));
        }
        for (const QString& other : {u"203.0.113.9"_s, u"10.0.0.1"_s, u"0.0.0.0"_s, u"128.0.0.1"_s, u"2001:db8::1"_s, u"::"_s}) {
            QVERIFY2(!allowed(true, other), qPrintable(other));
            QVERIFY2(allowed(false, other), qPrintable(other));  // https:对端不看
        }
    }

    /// 连上之后的对端核对:主机名是回环、实际对端却不是(名字解析被指到别处)——离线用 Hooks::peerAddressFilter 演:
    /// 套接字真的连上了本机的假端点,但报出来的对端换成一个非回环地址,Exchange 必须当场断开、一个请求字节都不发
    void peerRecheckAbortsNonLoopbackPeer() {
        using F = sdk::Exchange::Fail;
        const OJson okStep = js::object({{u"status"_s, js::N(200)}, {u"body"_s, js::object({{u"a"_s, js::N(1)}})}});
        HooksScope hooks;
        for (const QString& fake : {u"203.0.113.9"_s, u"10.1.2.3"_s, u"8.8.8.8"_s, u"2001:db8::1"_s, u"0.0.0.0"_s}) {
            FakeEndpoint ep({okStep});
            sdk::Hooks h = sdk::hooks();
            h.peerAddressFilter = [fake](const QHostAddress&) { return QHostAddress(fake); };
            sdk::setHooks(h);
            sdk::Headers none;
            const auto ex = sdk::Exchange::start("POST", *wu::parse(u"http://127.0.0.1:%1/"_s.arg(ep.port())), none, "x");
            ex->startDeadline(3000);
            const auto head = ex->headers();
            QVERIFY2(waitFor(head, 5000), qPrintable(fake));
            QCOMPARE(int(head.result()), int(F::Network));  // 超时(Deadline)说明核对没发生
            QTest::qWait(60);
            QCOMPARE(ep.seen().items.size(), 0);  // 连接是有的,请求一个字节都没发出去
        }
        // 对照:对端报的是回环(或不换),请求正常发出
        for (const bool replace : {false, true}) {
            FakeEndpoint ep({okStep});
            sdk::Hooks h = sdk::hooks();
            h.peerAddressFilter = replace ? std::function<QHostAddress(const QHostAddress&)>([](const QHostAddress&) { return QHostAddress(u"127.0.0.2"_s); }) : nullptr;
            sdk::setHooks(h);
            sdk::Headers none;
            const auto ex = sdk::Exchange::start("POST", *wu::parse(u"http://127.0.0.1:%1/"_s.arg(ep.port())), none, "x");
            ex->startDeadline(3000);
            const auto head = ex->headers();
            QVERIFY(waitFor(head, 5000));
            QCOMPARE(int(head.result()), int(F::None));
            QCOMPARE(ex->status(), 200);
        }
    }

    /// 最后一道闸:明文 http 只许连回环,按真正拨出去的主机判;不合格的一个字节不发、也不解析名字
    void plainHttpGate() {
        using F = sdk::Exchange::Fail;
        sdk::Headers none;
        for (const QString& u : {u"http://example.com/"_s, u"http://10.0.0.5:80/"_s, u"http://[2001:db8::1]/"_s, u"http://0.0.0.0/"_s, u"http://128.0.0.1/"_s, u"http://localhost./"_s,
                                 u"http://127.0.0.1.nip.io/"_s, u"http://user@127.0.0.1/x"_s.replace(u"127.0.0.1"_s, u"example.org"_s)}) {
            const auto ex = sdk::Exchange::start("POST", *wu::parse(u), none, "x");
            const auto h = ex->headers();
            QVERIFY2(waitFor(h, 2000), qPrintable(u));
            QCOMPARE(int(h.result()), int(F::Network));
        }
        // 回环的写法放行(127.0.0.0/8、::1、localhost)——这里只看没被闸拦(连得上与否另说:没人在听)
        for (const QString& u : {u"http://127.0.0.2:1/"_s, u"http://127.255.255.254:1/"_s, u"http://[::1]:1/"_s, u"http://localhost:1/"_s, u"http://2130706433:1/"_s, u"http://0x7f.1:1/"_s})
            QVERIFY2(wu::isLoopbackHostname(wu::parse(u)->hostname), qPrintable(u));
        QVERIFY(!wu::isLoopbackHostname(wu::parse(u"http://127.0.0.1.nip.io/"_s)->hostname));
        QVERIFY(!wu::isLoopbackHostname(u"128.0.0.1"_s) && !wu::isLoopbackHostname(u"127.0.0.256"_s) && !wu::isLoopbackHostname(u"127.0.0"_s) && !wu::isLoopbackHostname(u"127.00.0.1"_s));
    }

    /// 回话原始字节(undici / llhttp 的严格程度):两个 SDK、不重试,逐条与 TS 的结果比
    void rawResponses_data() {
        QTest::addColumn<int>("index");
        const OJson& list = *fx_.get(u"rawCases"_s);
        for (qsizetype i = 0; i < list.items.size(); ++i) QTest::newRow(qPrintable(list.items[i].get(u"flavor"_s)->s + u"/"_s + list.items[i].get(u"name"_s)->s)) << int(i);
    }
    void rawResponses() {
        QFETCH(int, index);
        const OJson& c = fx_.get(u"rawCases"_s)->items[index];
        const bool anth = c.get(u"flavor"_s)->s == u"anthropic";
        const QByteArray raw = QByteArray::fromHex(c.get(u"hex"_s)->s.toLatin1());
        QTcpServer server;
        QVERIFY(server.listen(QHostAddress(u"127.0.0.1"_s), 0));
        QObject::connect(&server, &QTcpServer::newConnection, &server, [&server, raw] {
            QTcpSocket* s = server.nextPendingConnection();
            auto sent = std::make_shared<bool>(false);
            QObject::connect(s, &QTcpSocket::readyRead, s, [s, raw, sent] {
                static thread_local QHash<QTcpSocket*, QByteArray> bufs;
                bufs[s] += s->readAll();
                if (*sent || !bufs[s].contains("\r\n\r\n")) return;
                *sent = true;
                s->write(raw);
                s->disconnectFromHost();
            });
        });
        sdk::ClientOptions o;
        o.flavor = anth ? sdk::Flavor::Anthropic : sdk::Flavor::OpenAI;
        o.baseURL = u"http://127.0.0.1:%1"_s.arg(server.serverPort());
        o.apiKey = fx_.get(u"key"_s)->s;
        o.maxRetries = 0;
        o.timeoutMs = 1500;
        const sdk::Client client(o);
        const auto t = client.post(u"/x"_s, js::object({{u"q"_s, js::N(1)}}), anth ? std::optional<double>(1500) : std::nullopt);
        QVERIFY(waitFor(t));
        OJson got;
        if (t.error()) {
            got = js::object({{u"error"_s, errorJson(t.error())}});
            // 夹具里 status 缺省 = undefined(errorJson 已按这个约定写)
        } else {
            const sdk::Body b = t.result();
            got = b ? js::object({{u"ok"_s, enc(*b)}}) : js::object();  // 回包是 undefined:夹具里这一项按 JSON.stringify 的约定去掉了
        }
        const OJson want = *c.get(u"res"_s);
        if (c.get(u"name"_s)->s == u"redirect_301") {
            // 重定向:TS 的 fetch 跟(这里的假端点只回一次,于是 TS 以连接错收场),C++ 故意不跟:一次请求、错里说清楚没跟随
            QVERIFY(t.error());
            const OJson* e = got.get(u"error"_s);
            QCOMPARE(e->get(u"status"_s)->n, 301.0);
            QVERIFY2(e->get(u"message"_s)->s.contains(u"不跟随"_s), qPrintable(e->get(u"message"_s)->s));
            return;
        }
        JSFIX_SAME(want, got, c.get(u"name"_s)->s);
    }

    /// 继承来的环境不会把任何东西(哪怕是假 Key)送去远端:变量被清掉;就算漏清,出网闸也在连接之前拦住
    void inheritedEnvCannotReachRemote() {
        const QStringList names{u"ANTHROPIC_BASE_URL"_s, u"ANTHROPIC_AUTH_TOKEN"_s, u"ANTHROPIC_API_KEY"_s, u"ANTHROPIC_CUSTOM_HEADERS"_s, u"OPENAI_BASE_URL"_s,
                                u"OPENAI_ORG_ID"_s, u"OPENAI_PROJECT_ID"_s, u"OPENAI_API_KEY"_s, u"OPENAI_ADMIN_KEY"_s, u"OPENAI_CUSTOM_HEADERS"_s};
        {
            EnvScope env;
            for (const QString& n : names) env.set(n, u"https://api.example.invalid/v1"_s);
            QCOMPARE(scrubEnv(), int(names.size()));
        }
        for (const QString& n : names) QVERIFY2(!qEnvironmentVariableIsSet(n.toLatin1().constData()), qPrintable(n));
        QCOMPARE(scrubEnv(), 0);
        // 漏清的情形:远端地址进了环境,闸在发出第一个字节之前拦下,并且一条请求也没到过本机的假端点
        FakeEndpoint witness({});
        EnvScope env;
        env.set(u"ANTHROPIC_BASE_URL"_s, u"https://api.example.invalid"_s);
        env.set(u"ANTHROPIC_AUTH_TOKEN"_s, u"tok-test-leak"_s);
        env.set(u"ANTHROPIC_CUSTOM_HEADERS"_s, u"X-Leak: 1"_s);
        const auto parser = pv::buildParser(configOf(*fx_.get(u"base_config"_s)->get(u"anthropic"_s), {}), u"sk-test-0000-fake"_s);
        const auto t = parser->completeJson(u"s"_s, u"u"_s, js::object());
        QVERIFY(waitFor(t));
        QVERIFY(t.error());
        QCOMPARE(blocked_, 1);
        QCOMPARE(witness.seen().items.size(), 0);
        QCOMPARE(scrubEnv(), 3);
    }

    /// 出网闸真的拦得住:没设 ANTHROPIC_BASE_URL 时 SDK 的默认地址是 api.anthropic.com,测试里一个字节都不许发出去
    void refusesNonLoopback() {
        OJson raw = *fx_.get(u"base_config"_s)->get(u"anthropic"_s);
        const auto parser = pv::buildParser(configOf(raw, {}), u"sk-test-x"_s);
        const auto t = parser->completeJson(u"s"_s, u"u"_s, js::object());
        QVERIFY(waitFor(t));
        QVERIFY(t.error());
        QCOMPARE(blocked_, 1);
        QVERIFY_THROWS_EXCEPTION(em::EmbedError, em::OllamaEmbedder(u"http://api.example.com"_s, u"m"_s));
    }
};

QTEST_GUILESS_MAIN(TestLlm)
#include "tst_llm.moc"
