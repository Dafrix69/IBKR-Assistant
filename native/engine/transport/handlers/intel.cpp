#include "transport/handlers/intel.h"

#include "transport/handlers/handlers2_support.h"

using namespace Qt::StringLiterals;

namespace ibkr::rpc {

using util::OJson;

MethodTable IntelHandlers::methods() {
    return contractTable({
        {u"intel.feed"_s, [this](OJson p) { return ports_.intel().feed(std::move(p)); }},
        {u"intel.dossier"_s, [this](OJson p) { return ports_.intel().dossier(std::move(p)); }},
    });
}

}  // namespace ibkr::rpc
