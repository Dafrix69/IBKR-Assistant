// providers.ts 用的两个官方 SDK(@anthropic-ai/sdk 0.128.0、openai 7.23.0)从外面看得见的那一层,自己用 HTTP 说出来:
// 发出去的请求(方法、地址、要紧的头、正文逐字节)、重试(几次、退避多久、哪些状态码与断线重试、Retry-After 怎么读)、
// 超时(Anthropic 只管等到头;OpenAI 连正文一起管,正文超时也重试)、每一种失败到引擎手里是什么类名、什么原话。
// 对的是 SDK 的源码(node_modules/*/client.mjs、core/error.mjs、internal/parse.mjs)与现跑的对拍:tests/fixtures/gen_llm.mjs。
//
// 地址与连接:**连的主机与端口就是 WHATWG(`new URL` / fetch)解析出来的那一个**,由 parsing/whatwg_url 解析、Exchange 直接按它拨号,
// 不经 QUrl(QUrl 对反斜杠、userinfo 的读法不同,校验按 WHATWG 放行、连接按 QUrl 去连是个洞,见 whatwg_url.h)。
// 请求头照 fetch 的 Headers 清洗与校验(值两头的 \t \n \r 空格去掉、含 NUL / CR / LF 的值与非 token 的名字抛 TypeError、字符码 > 255 抛 ByteString 错),
// 注入不了第二个头;回话照 undici / llhttp 的严格程度读(Content-Length 只认纯数字且只许一个、不许与 Transfer-Encoding 并存、不认折行与坏头行、
// 分块每块后必须 CRLF、100 / 101 当连接错、103 跳过)。逐条与 TS 现跑的结果对拍(tests/fixtures/gen_llm.mjs 的 rawCases / urls / joins / b2_* / ssrf_* / m1_*)。
//
// **与 TS 故意不同的地方**(都是往更安全的方向,交付报告里同样列了):
//   · 不跟重定向。TS 的 fetch 会跟 301 / 302 / 303 / 307 / 308,并把头(含 Key)带去新地址;这里 3xx 以错收场,话里写明没跟随与 Location,
//     凭证绝不转给别的地址。要换地址就改 base_url;
//   · 明文 http 只许连回环(127.0.0.0/8、::1、localhost):在 Exchange 里按真正拨出去的主机判,连上之后再核对对端地址。OpenAI 兼容端点本来就由
//     validateBaseUrl 管着,这条闸管的是 ANTHROPIC_BASE_URL(TS 里没人拦:设成 http://远端 照样把 Key 发出去);https 不限;
//   · 自己给的 Content-Length / Transfer-Encoding / Connection 头不发(TS 里请求会卡到超时);自己给的 Host 照用(undici 同)。
//
// 不搬的:SDK 的平台头(X-Stainless-Lang / -OS / -Arch / -Runtime / -Runtime-Version / -Package-Version,说的是 node 与它的版本,
// 这边说不出真话,端点也不看它们);凭证链(profile、workload identity、x509——providers.ts 一律显式给 Key,用不到);中间件、流式。
// undici 自己的两道 300 秒(等头、正文两块之间)照搬了时限与错的样子,没有对拍(Electron 里改不了 undici 的这两个数)。
#pragma once

#include "util/whatwg_url.h"
#include "util/error.h"
#include "util/ordered_json.h"
#include "util/task.h"

#include <QByteArray>
#include <QHostAddress>
#include <QList>
#include <QObject>
#include <QPair>
#include <QPointer>
#include <QString>
#include <QTimer>

#include <functional>
#include <memory>
#include <optional>

class QTcpSocket;

namespace ibkr::parsing::sdk {

enum class Flavor { Anthropic, OpenAI };

/// JS 里带类名的错(TypeError、SyntaxError、AnthropicError……):界面文案里有 `${exc.constructor.name}: ${message}`
class NamedError : public util::JsError {
public:
    NamedError(QString name, const QString& message) : JsError(message), name(std::move(name)) {}
    QString name;
};

/// SDK 的 APIError 一族:status 有值 = 端点回了状态码;error = SDK 的 err.error(Anthropic 是整个回包,OpenAI 是回包里的 error;没有 = 空)
class SdkError : public NamedError {
public:
    SdkError(QString name, const QString& message, std::optional<int> status = std::nullopt, std::optional<util::OJson> error = std::nullopt)
        : NamedError(std::move(name), message), status(status), error(std::move(error)) {}
    std::optional<int> status;
    std::optional<util::OJson> error;
};

/// SDK 的 buildHeaders:名字一律小写,同名后来的覆盖前面的(位置不动),先后照加入的次序。
/// 另记下每一次 set 的原名与原值(attempts):fetch 的 Headers 在 append 的当场校验名字与值,出错说的是**原值**与原名,
/// 而且先后次序要对(第一个坏的先报)——被后来的同名头盖掉的坏值也照样先报错
class Headers {
public:
    void set(const QString& name, const QString& value);
    void remove(const QString& name);
    std::optional<QString> get(const QString& name) const;
    const QList<QPair<QString, QString>>& items() const { return items_; }
    const QList<QPair<QString, QString>>& attempts() const { return attempts_; }

private:
    QList<QPair<QString, QString>> items_;
    QList<QPair<QString, QString>> attempts_;
};

/// 测试换掉的几样(都是 TS 里的全局:Math.random、setTimeout、Date.now)。空的那样用真的
struct Hooks {
    std::function<double()> random;                   ///< 退避的抖动
    std::function<util::Task<>(double ms)> sleep;     ///< 退避的那一觉
    std::function<double()> nowMs;                    ///< Retry-After 是日期时减的"现在"
    std::function<void(double ms)> timerArmed;        ///< 每次请求起的那只计时器设了多久(对拍记的就是它)
    std::function<bool(const util::whatwg::Url&)> allowUrl;  ///< 出网闸:返回 false 的地址不连(测试只放本机)
    /// 测试缝:Exchange 真要拨号之前(过了所有闸之后)报一声要拨的主机与端口——被闸拦下的从来不会走到这里
    std::function<void(const QString& host, int port)> dialObserver;
    /// 测试缝:连上之后核对对端地址之前,换掉套接字报出来的对端(用来在离线的回环上演"回环名字解析到了别处")
    std::function<QHostAddress(const QHostAddress& actualPeer)> peerAddressFilter;
    double undiciHeadersTimeoutMs = 300'000;          ///< undici 等头的上限
    double undiciBodyTimeoutMs = 300'000;             ///< undici 正文两块之间的上限
};
void setHooks(Hooks hooks);
const Hooks& hooks();

/// Node 的 setTimeout 怎么理解一个毫秒数:不在 [1, 2^31−1] 里就是 1;小数往下取
int nodeTimerMs(double ms);

// ---------------------------------------------------------------- 一次往返(fetch 的形状)
/// 先等到头(或者连不上),再读正文。每一步只交一次结果;计时器由调用方挂(deadline)。
/// 自己在 QTcpSocket / QSslSocket 上说 HTTP/1.1(不用 QNetworkAccessManager:它把 401 的回包攒到读完才交头——自己的认证流程——
/// SDK 的计时器在那之前就到点了;它还会自己加头、自己跟重定向)。每次一条新连接,发 connection: close;不压缩、不跟重定向
class Exchange : public QObject, public std::enable_shared_from_this<Exchange> {
public:
    enum class Fail { None, Network, Deadline, UndiciHeaders, UndiciBody, Truncated };

    /// url 是 util::whatwg::parse 解析出来的那一个:**只按它的 scheme / hostname / port 拨号,不经 QUrl**。
    /// 最后一道闸在这里:明文 http 只许连回环(127.0.0.0/8、::1、localhost),按**真正拨出去的主机**判(连上之后再核对一次对端地址);
    /// 不合格的当场按"连不上"收场,一个字节都不发
    /// 连上之后对端地址能不能接受:明文 http 的对端必须是回环;https 由 TLS 的证书与主机名校验管,不看这个
    static bool peerAllowed(bool plainHttp, const QHostAddress& peer);
    static std::shared_ptr<Exchange> start(const QByteArray& method, const util::whatwg::Url& url, const Headers& headers, const QByteArray& body);
    ~Exchange() override;

    /// 等到头:Fail::None = 到了;否则是怎么没到的
    util::Task<Fail> headers();
    /// 读完正文:first = 怎么没读完(None = 读完)
    util::Task<std::pair<Fail, QByteArray>> body();

    int status() const { return status_; }
    bool ok() const { return status_ >= 200 && status_ <= 299; }
    /// fetch 的 headers.get(同名的几行用 ", " 连起来);没有 = 空
    std::optional<QString> header(const QString& name) const;

    /// 到点:中止这次往返,headers() / body() 里还没交的结果交 Fail::Deadline
    void startDeadline(double ms);
    void stopDeadline();
    /// SDK 不要这个回包了(重试之前把正文撂下)
    void cancel();

private:
    Exchange() = default;
    void onConnected();
    void onReadyRead();
    void onDisconnected();
    void onSocketError();
    /// 把收到的字节往前推:状态行与头 → 正文(content-length / 分块 / 读到关)
    void pump();
    void failWith(Fail why);
    void settleHeaders(Fail why);
    void settleBody(Fail why);

    QPointer<QTcpSocket> socket_;
    QByteArray request_;
    util::Deferred<Fail> headersD_;
    util::Deferred<std::pair<Fail, QByteArray>> bodyD_;
    QTimer deadline_, undiciHeaders_, undiciBody_;
    Fail abortReason_ = Fail::None;
    bool headersDone_ = false;
    int status_ = 0;
    QList<QPair<QByteArray, QByteArray>> responseHeaders_;
    QByteArray in_;    ///< 收到还没消化的字节
    QByteArray body_;  ///< 解出来的正文
    enum class Framing { Length, Chunked, UntilClose, None } framing_ = Framing::None;
    qint64 remaining_ = 0;  ///< Length:还差多少;Chunked:这一块还差多少(-1 = 该读块头了)
    bool chunkTrailer_ = false;
    bool plainHttp_ = false;  ///< 明文 http:连上之后要核对对端是回环
    bool sawStatus_ = false;  ///< 这一份回话的状态行已经读到了
};

/// 发出去的整段字节(请求行、host、头、content-length、connection: close、正文);Host 用 URL.host(默认端口不写,IPv6 带方括号)。
/// 调用方自己给了 host 头就用它(undici 同);自己给的 content-length / transfer-encoding / connection 一律不发(TS 里会卡到超时,见头注释)
QByteArray requestBytes(const QByteArray& method, const util::whatwg::Url& url, const Headers& headers, const QByteArray& body);

/// SDK 的 URL 拼接(buildURL):baseURL + path(两边都带斜杠时去掉一个)→ `new URL(…)`;解析不了抛 TypeError「Invalid URL」;
/// 地址里已经带查询的(`?x=1`)整个查询按 URLSearchParams → Object.fromEntries → qs.stringify 重写一遍(路径跟着进了查询,同 TS)
util::whatwg::Url joinUrl(const QString& baseURL, const QString& path);

/// fetch 的 Headers 校验 + SDK 的 buildHeaders:按 attempts 的先后查名字与值,抛 TypeError(话同 undici / SDK 原话);
/// 返回清洗过的头(值去掉两头的 \t \n \r 空格)。Anthropic 另有 validateHeaders:x-api-key 与 authorization 都空时抛 Error
Headers finalizeHeaders(Flavor flavor, const Headers& headers);
/// 只做名字与值的校验(OpenAI 构造函数里对 *_CUSTOM_HEADERS 就这么查一遍)
void validateHeaderAttempts(Flavor flavor, const Headers& headers);

/// fetch 的 response.text():UTF-8 解码,开头的 BOM 去掉
QString fetchText(const QByteArray& bytes);

// ---------------------------------------------------------------- SDK 的客户端
struct ClientOptions {
    Flavor flavor = Flavor::OpenAI;
    QString baseURL;               ///< 已经按 SDK 定好的(Anthropic:构造参数 || ANTHROPIC_BASE_URL || 默认)
    QString apiKey;
    std::optional<QString> authToken;  ///< Anthropic:ANTHROPIC_AUTH_TOKEN
    double timeoutMs = 600'000;
    int maxRetries = 2;
    Headers defaultHeaders;        ///< 已经并上 *_CUSTOM_HEADERS
    std::optional<QString> organization, project;  ///< OpenAI:OPENAI_ORG_ID / OPENAI_PROJECT_ID
};

/// 照 SDK 构造函数读环境变量(readEnv:trim 之后空串 = 没有)
std::optional<QString> readEnv(const char* name);
/// *_CUSTOM_HEADERS 的写法:一行一个 "名字: 值",没有冒号的行丢掉
QList<QPair<QString, QString>> parseCustomHeaders(const QString& text);

/// 成功回包解析之后的东西:空 = undefined(OpenAI 的空正文、两边的 content-length: 0)
using Body = std::optional<util::OJson>;

class Client {
public:
    explicit Client(ClientOptions options);
    /// client.post(path, {body}) / messages.create 的 post(带 timeout)。失败抛 SdkError / NamedError
    util::Task<Body> post(QString path, util::OJson body, std::optional<double> requestTimeoutMs = std::nullopt) const;
    const ClientOptions& options() const { return *options_; }

private:
    std::shared_ptr<const ClientOptions> options_;
};

/// APIError.makeMessage
QString makeMessage(std::optional<int> status, const util::OJson* error, const std::optional<QString>& message);
/// APIError.generate 的类名
QString statusErrorName(int status);

}  // namespace ibkr::parsing::sdk
