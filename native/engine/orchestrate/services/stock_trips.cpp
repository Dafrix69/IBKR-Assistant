#include "orchestrate/services/stock_trips.h"

#include "analysis/stockreview.h"
#include "execution/broker_pricing.h"
#include "util/jsobj.h"

#include <QHash>

#include <cmath>

namespace ibkr::orchestrate {

using namespace Qt::StringLiterals;
using execution::BrokerError;
using util::OJson;
using util::Task;
namespace js = util::js;

Task<QList<OJson>> StockTripsService::trips() {
    QList<OJson> accounts;
    QHash<QString, QString> idOf;
    for (const auto& a : settings().accounts) {
        accounts.append(js::object({{u"alias"_s, js::S(a.alias)}, {u"account_id"_s, js::S(a.account_id)}, {u"is_paper"_s, js::B(a.is_paper)}}));
        if (!idOf.contains(a.alias)) idOf.insert(a.alias, a.account_id);  // new Map(...) 后一个盖前一个
        else idOf.insert(a.alias, a.account_id);
    }
    const auto router = routerPort();
    if (router && router->hasSessions()) {
        const double now = rt().perfMs() / 1000;
        if (now - holdingsAt_ >= kHoldingsTtlS) {
            try {
                OJson holdings = js::object();
                const QList<OJson> rows = co_await router->positions();
                for (const OJson& row : rows) {
                    const OJson* st = js::prop(&row, u"sec_type"_s);
                    if ((js::nullish(st) ? QString() : js::str(st)) != u"STK") continue;
                    const OJson* acct = js::prop(&row, u"account"_s);
                    const auto it = idOf.constFind(js::nullish(acct) ? QString() : js::str(acct));
                    if (it == idOf.cend()) continue;
                    const OJson accountId = js::S(it.value());
                    const QString key = analysis::stockreview::holdingKey(&accountId, js::prop(&row, u"symbol"_s));
                    double prev = 0;
                    if (const OJson* p = holdings.get(key)) prev = p->n;
                    double q = js::num(js::prop(&row, u"quantity"_s));
                    if (std::isnan(q)) q = 0;  // Number(x) || 0
                    holdings.set(key, js::N(prev + q));
                }
                holdings_ = holdings;
            } catch (const BrokerError&) {
                holdings_.reset();  // 读不到 ≠ 空仓:宁可标"期初未核对",也不拿空表去反推
            }
            holdingsAt_ = now;
        }
    } else {
        holdings_.reset();
        holdingsAt_ = -std::numeric_limits<double>::infinity();
    }
    co_return analysis::stockreview::groupStockTrips(store().listFills(), accounts, holdings_ ? &*holdings_ : nullptr);
}

}  // namespace ibkr::orchestrate
