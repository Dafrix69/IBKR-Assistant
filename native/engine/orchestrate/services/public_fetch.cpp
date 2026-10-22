#include "orchestrate/services/public_fetch.h"

#include "parsing/sdk_http.h"
#include "util/error.h"
#include "util/jsobj.h"
#include "util/whatwg_url.h"

#include <QRegularExpression>

namespace ibkr::orchestrate {

using namespace Qt::StringLiterals;
using util::OJson;
using util::Task;
namespace js = util::js;
namespace sdk = parsing::sdk;

Task<OJson> publicFetch(QString url, double timeoutMs, QString userAgent, QString failLabel) {
    using Fail = sdk::Exchange::Fail;
    const auto parsed = util::whatwg::parse(url);
    if (!parsed) throw util::JsError(u"Failed to parse URL from "_s + url);
    sdk::Headers headers;
    headers.set(u"user-agent"_s, userAgent);
    const std::shared_ptr<sdk::Exchange> ex = sdk::Exchange::start("GET", *parsed, headers, QByteArray());
    ex->startDeadline(timeoutMs);
    const Fail head = co_await ex->headers();
    if (head != Fail::None) {
        ex->cancel();
        throw util::JsError(head == Fail::Deadline ? u"This operation was aborted"_s : u"fetch failed"_s);
    }
    const auto [fail, bytes] = co_await ex->body();
    ex->stopDeadline();
    if (fail != Fail::None) throw util::JsError(fail == Fail::Deadline ? u"This operation was aborted"_s : u"fetch failed"_s);
    if (!ex->ok()) throw util::JsError(u"%1返回 HTTP %2"_s.arg(failLabel).arg(ex->status()));
    const QString text = sdk::fetchText(bytes);
    if (const auto value = js::parse(text)) co_return *value;
    static const QRegularExpression ws(u"\\s+"_s, QRegularExpression::UseUnicodePropertiesOption);
    QString head60 = text.left(60);
    head60.replace(ws, u" "_s);
    throw util::JsError(u"%1返回的不是 JSON(前 60 字:%2)"_s.arg(failLabel, head60));
}

}  // namespace ibkr::orchestrate
