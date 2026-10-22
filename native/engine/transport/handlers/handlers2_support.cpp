#include "transport/handlers/handlers2_support.h"

#include "contract/registry.h"
#include "util/error.h"
#include "util/jsobj.h"

#include <QRegularExpression>

using namespace Qt::StringLiterals;

namespace ibkr::rpc {

using util::OJson;

MethodTable contractTable(ContractImpl impl) {
    MethodTable table;
    for (auto& [name, handler] : impl) {
        if (!contract::findMethod(name)) throw util::JsError(u"契约里没有这个方法:%1"_s.arg(name));
        table.push_back({name, [name = name, handler = std::move(handler)](const OJson& params) -> util::Task<OJson> {
                             try {
                                 return handler(parseContractParams(name, &params));
                             } catch (...) {
                                 util::Deferred<OJson> failed;
                                 failed.reject(std::current_exception());
                                 return failed.task();
                             }
                         }});
    }
    return table;
}

ContractAsyncHandler syncImpl(std::function<OJson(const OJson&)> fn) {
    return [fn = std::move(fn)](OJson params) -> util::Task<OJson> {
        try {
            return util::Task<OJson>::resolved(fn(params));
        } catch (...) {
            util::Deferred<OJson> failed;
            failed.reject(std::current_exception());
            return failed.task();
        }
    };
}

std::shared_ptr<HandlerRouter> liveRouter(Handlers2Ports& ports) {
    std::shared_ptr<HandlerRouter> router = ports.router();
    return router && router->hasSessions() ? router : nullptr;
}

qsizetype codePointCount(const QString& s) {
    qsizetype n = 0;
    for (qsizetype i = 0; i < s.size(); ++i) {
        ++n;
        if (s[i].isHighSurrogate() && i + 1 < s.size() && s[i + 1].isLowSurrogate()) ++i;
    }
    return n;
}

namespace {

/// too_small / too_big 在 zod 里带的 minimum / maximum / type / inclusive / exact:Issue 没存,但文案是 zod 固定的模板,从文案里还原
/// (数组 / 字符串 / 数的 min、max、gte、lte 几种;exact(.length)与别的类型不在内)
bool boundFields(const util::zod::Issue& issue, OJson& o) {
    static const QRegularExpression re(u"^(Array|String|Number) must (?:contain|be) (at least|at most|greater than or equal to|less than or equal to|greater than|less than) (-?[0-9.e+]+)(?: (?:element|character)\\(s\\))?$"_s);
    const QRegularExpressionMatch m = re.match(issue.message);
    if (!m.hasMatch() || (issue.code != u"too_small" && issue.code != u"too_big")) return false;
    const QString kind = m.captured(1), cmp = m.captured(2);
    const bool small = cmp == u"at least" || cmp.startsWith(u"greater");
    if (small != (issue.code == u"too_small")) return false;
    const bool inclusive = cmp == u"at least" || cmp == u"at most" || cmp.endsWith(u"or equal to");
    o.set(small ? u"minimum"_s : u"maximum"_s, util::js::N(m.captured(3).toDouble()));
    o.set(u"type"_s, util::js::S(kind.toLower()));
    o.set(u"inclusive"_s, util::js::B(inclusive));
    o.set(u"exact"_s, util::js::B(false));
    return true;
}

}  // namespace

QString zodErrorMessage(const std::vector<util::zod::Issue>& issues) {
    namespace js = util::js;
    OJson list = js::array();
    for (const util::zod::Issue& issue : issues) {
        OJson o = js::object({{u"code"_s, js::S(issue.code)}});
        bool messageFirst = false;  // zod 把 message 放在 issueData 里的 code(custom / 带自定义文案的 too_small…),makeIssue 展开时它的位置留在 path 前面
        if (issue.code == u"invalid_type") {
            o.set(u"expected"_s, js::S(issue.expected));
            o.set(u"received"_s, js::S(issue.received));
        } else if (issue.code == u"unrecognized_keys") {
            o.set(u"keys"_s, js::strings(issue.keys));
        } else if (issue.code == u"custom") {
            messageFirst = true;
        } else if (boundFields(issue, o)) {
            messageFirst = true;
        }
        if (messageFirst) o.set(u"message"_s, js::S(issue.message));
        OJson path = js::array();
        for (const QString& seg : issue.path) {
            bool numeric = !seg.isEmpty();
            for (const QChar c : seg) numeric = numeric && c >= u'0' && c <= u'9';
            path.items.append(numeric ? js::N(seg.toDouble()) : js::S(seg));
        }
        o.set(u"path"_s, path);
        o.set(u"message"_s, js::S(issue.message));  // 已经放过的 message 只改值,位置不动(同 JS 的对象展开)
        list.items.append(o);
    }
    return util::stringifyOJson(list, 2);
}

}  // namespace ibkr::rpc
