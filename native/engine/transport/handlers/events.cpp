#include "transport/handlers/events.h"

#include "analysis/econ_calendar.h"
#include "transport/handlers/handlers2_support.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"

using namespace Qt::StringLiterals;

namespace ibkr::rpc {

using util::OJson;
namespace js = util::js;

MethodTable EventsHandlers::methods() {
    return contractTable({
        {u"events.list"_s, [this](OJson p) { return ports_.events().list(js::truthy(js::prop(&p, u"force"_s))); }},
        {u"events.set_config"_s, syncImpl([this](const OJson& p) { return setConfig(p); })},
        {u"events.add"_s, syncImpl([this](const OJson& p) { return add(p); })},
        {u"events.remove"_s, syncImpl([this](const OJson& p) { return remove(p); })},
    });
}

OJson EventsHandlers::setConfig(const OJson& params) {
    try {
        return js::object({{u"config"_s, ports_.events().setConfig(js::copyOrNull(js::prop(&params, u"config"_s)))}});
    } catch (const analysis::econ_calendar::EventsConfigError& exc) {
        throw util::RpcError(-32602, exc.message());
    }
}

OJson EventsHandlers::add(const OJson& params) { return js::object({{u"event"_s, ports_.events().add(params)}}); }

OJson EventsHandlers::remove(const OJson& params) {
    const QString id = util::jsTrim(js::str(js::prop(&params, u"id"_s)));
    if (!ports_.events().remove(id)) throw util::RpcError(-32602, u"没有这条自定义事件"_s);
    return js::object({{u"deleted"_s, js::S(id)}});
}

}  // namespace ibkr::rpc
