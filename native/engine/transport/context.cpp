#include "transport/context.h"

#include "domain/store.h"
#include "util/jsobj.h"

using namespace Qt::StringLiterals;

namespace ibkr::rpc {

namespace js = util::js;
using util::OJson;

RpcServer::AsyncHandler syncHandler(RpcServer::OJsonHandler fn) {
    return [fn = std::move(fn)](const OJson& params) -> util::Task<OJson> {
        try {
            return util::Task<OJson>::resolved(fn(params));
        } catch (...) {
            util::Deferred<OJson> failed;
            failed.reject(std::current_exception());
            return failed.task();
        }
    };
}

OJson HandlerBase::accounts() const {
    OJson out = js::array();
    for (const contract::AccountConfig& a : settings().accounts) {
        out.items << js::object({
            {u"alias"_s, js::S(a.alias)},
            {u"account_masked"_s, js::S(domain::redactAccount(a.account_id))},
            {u"is_paper"_s, js::B(a.is_paper)},
            {u"connection"_s, js::S(a.connection)},
            {u"broker"_s, js::S(settings().accountBroker(a))},
            {u"default"_s, js::B(a.isDefault)},
        });
    }
    return out;
}

void installMethods(RpcServer& server, const std::vector<HandlerBase*>& domains) {
    for (HandlerBase* domain : domains)
        for (auto& [name, fn] : domain->methods()) server.addAsync(name, std::move(fn));  // 重复登记在 addAsync 里抛
}

}  // namespace ibkr::rpc
