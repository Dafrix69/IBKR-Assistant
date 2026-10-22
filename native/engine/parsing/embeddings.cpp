#include "parsing/embeddings.h"

#include "parsing/sdk_http.h"
#include "util/whatwg_url.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"

#include <QRegularExpression>
#include <QUrl>

#include <cmath>

using namespace Qt::StringLiterals;

namespace ibkr::parsing::embeddings {

using util::OJson;
namespace js = util::js;

bool isLoopbackUrl(const QString& raw) {
    const auto url = util::whatwg::parse(raw);
    if (!url) return false;
    if (url->scheme != u"http" && url->scheme != u"https") return false;
    QString host = url->hostname;
    if (host.startsWith(u'[')) host.remove(0, 1);
    if (host.endsWith(u']')) host.chop(1);
    host = host.toLower();
    return host == u"127.0.0.1" || host == u"localhost" || host == u"::1";  // TS 原样:只这三个写法(127.0.0.2 不算;Exchange 的闸比这宽,见 sdk_http.h)
}

OllamaEmbedder::OllamaEmbedder(QString baseUrl, QString model, OJson keepAlive)
    : baseUrl_(std::move(baseUrl)), model_(std::move(model)), keepAlive_(std::move(keepAlive)) {
    if (!isLoopbackUrl(baseUrl_)) throw EmbedError(u"嵌入服务只许本机地址,收到:"_s + baseUrl_);
}

namespace {

util::Task<std::vector<OJson>> embedImpl(QString baseUrl, QString model, OJson keepAlive, std::vector<QString> texts, double timeoutMs) {
    using Fail = sdk::Exchange::Fail;
    if (texts.empty()) co_return std::vector<OJson>{};
    static const QRegularExpression trailingSlashes(u"/+$"_s);
    const QString full = QString(baseUrl).remove(trailingSlashes) + u"/api/embed"_s;
    // fetch(string):WHATWG 解析;**连的就是解析出来的那个主机与端口**(不经 QUrl,见 whatwg_url.h 头注释)
    const auto url = util::whatwg::parse(full);
    if (!url) throw EmbedError(u"连不上本机嵌入服务("_s + baseUrl + u"):Failed to parse URL from "_s + full);
    if (url->hasCredentials())
        throw EmbedError(u"连不上本机嵌入服务("_s + baseUrl + u"):Request cannot be constructed from a URL that includes credentials: "_s + full);  // fetch 的话里是传进去的原串,不是 href
    QStringList input;
    for (const QString& t : texts) input << t;
    const OJson body = js::object({{u"model"_s, js::S(model)}, {u"input"_s, js::strings(input)}, {u"keep_alive"_s, keepAlive}});
    sdk::Headers headers;
    headers.set(u"content-type"_s, u"application/json"_s);
    const auto& hooks = sdk::hooks();
    if (url->scheme == u"https" && hooks.allowUrl && !hooks.allowUrl(*url)) throw EmbedError(u"出网闸拒绝了 "_s + url->host());

    // fetch(url, {signal: AbortSignal.timeout(timeoutMs)}):这一个时限管到正文读完
    const std::shared_ptr<sdk::Exchange> ex = sdk::Exchange::start("POST", *url, headers, util::toNodeUtf8(js::stringify(body)));
    ex->startDeadline(timeoutMs);
    const Fail head = co_await ex->headers();
    if (head != Fail::None) {
        ex->cancel();
        const QString message = head == Fail::Deadline ? u"The operation was aborted due to timeout"_s : u"fetch failed"_s;
        throw EmbedError(u"连不上本机嵌入服务("_s + baseUrl + u"):"_s + message);
    }
    // res.json().catch(() => null):读不完、读坏了都是 null
    const auto [fail, bytes] = co_await ex->body();
    std::optional<OJson> parsed;
    if (fail == Fail::None) parsed = js::parse(sdk::fetchText(bytes));
    const bool isNull = !parsed || parsed->type == OJson::Null;
    const OJson* b = isNull ? nullptr : &*parsed;
    const OJson* embeddings = js::prop(b, u"embeddings"_s);
    if (!ex->ok() || isNull || !js::isArr(embeddings)) {
        const OJson* err = js::prop(b, u"error"_s);
        const QString detail = js::nullish(err) ? u"回包不对"_s : js::str(err);
        throw EmbedError(u"本机嵌入服务报错(HTTP "_s + QString::number(ex->status()) + u"):"_s + detail);
    }
    bool shapeOk = qsizetype(embeddings->items.size()) == qsizetype(texts.size());
    for (const OJson& v : embeddings->items)
        if (!(v.type == OJson::Array && !v.items.isEmpty())) shapeOk = false;
    if (!shapeOk) throw EmbedError(u"本机嵌入服务回的向量条数或形状不对"_s);
    co_return std::vector<OJson>(embeddings->items.begin(), embeddings->items.end());
}

}  // namespace

util::Task<std::vector<OJson>> OllamaEmbedder::embed(std::vector<QString> texts, double timeoutMs) const {
    return embedImpl(baseUrl_, model_, keepAlive_, std::move(texts), timeoutMs);
}

double cosine(const std::vector<double>& a, const std::vector<double>& b) {
    if (a.size() != b.size() || a.empty()) return 0;
    double dot = 0, na = 0, nb = 0;
    for (size_t i = 0; i < a.size(); ++i) {
        const double x = a[i], y = b[i];
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    const auto truthy = [](double v) { return v != 0 && !std::isnan(v); };
    return truthy(na) && truthy(nb) ? dot / std::sqrt(na * nb) : 0;
}

std::vector<double> toNumbers(const OJson& vector) {
    std::vector<double> out;
    for (const OJson& x : vector.items) out.push_back(x.type == OJson::Null ? 0.0 : js::num(&x));
    return out;
}

}  // namespace ibkr::parsing::embeddings
