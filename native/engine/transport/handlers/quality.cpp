#include "transport/handlers/quality.h"

#include "analysis/anomaly.h"
#include "orchestrate/services/anomaly_service.h"
#include "transport/handlers/handlers2_support.h"
#include "transport/params.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"

using namespace Qt::StringLiterals;

namespace ibkr::rpc {

using util::OJson;
namespace js = util::js;
using orchestrate::AnomalyService;

MethodTable QualityHandlers::methods() {
    return contractTable({
        {u"quality.list"_s, syncImpl([this](const OJson&) { return qualityList(); })},
        {u"quality.add"_s, syncImpl([this](const OJson& p) { return qualityAdd(p); })},
        {u"quality.update"_s, syncImpl([this](const OJson& p) { return qualityUpdate(p); })},
        {u"quality.remove"_s, syncImpl([this](const OJson& p) { return qualityRemove(p); })},
        {u"quality.set_config"_s, syncImpl([this](const OJson& p) { return qualitySetConfig(p); })},
    });
}

/// 库里的一行 + 内存里最近一轮的指标。
OJson QualityHandlers::qualityRowOut(const OJson& row) {
    const QString symbol = js::str(js::prop(&row, u"symbol"_s));
    const std::optional<OJson> hit = ports_.anomaly().metricsOf(symbol);
    OJson out = row;
    out.set(u"metrics"_s, hit ? js::copyOrNull(js::prop(&*hit, u"metrics"_s)) : js::Null());
    out.set(u"metrics_at"_s, hit ? js::copyOrNull(js::prop(&*hit, u"at"_s)) : js::Null());
    out.set(u"quote_error"_s, hit ? js::copyOrNull(js::prop(&*hit, u"error"_s)) : js::Null());
    // 同一只股身上的另一个开关算到哪一步了:界面要能显示「正在算价位…」
    const std::optional<QString> levels = ports_.alerts().levelsStatusOf(symbol);
    out.set(u"levels_status"_s, levels ? js::S(*levels) : js::Null());
    return out;
}

OJson QualityHandlers::qualityList() {
    ports_.pool().ensureMigrated();
    OJson stocks = js::array();
    for (const OJson& row : ports_.store().listQualityStocks()) stocks.items.append(qualityRowOut(row));
    const OJson config = ports_.anomaly().config().toJson();
    const OJson monitor = ports_.anomaly().monitor();
    return js::object({{u"stocks"_s, stocks}, {u"config"_s, config}, {u"monitor"_s, monitor}, {u"max"_s, js::N(AnomalyService::kMaxQuality)}});
}

OJson QualityHandlers::qualityAdd(const OJson& params) {
    ports_.pool().ensureMigrated();  // 排在 ensureInPool 前面:别让迁移替这只新股开开关(备注会丢)
    const QString symbol = symbolOrRaise(params);
    if (settings().indexConfig(symbol)) {
        // 指数不是可交易合约,量能流按正股去订一定订不上
        throw util::RpcError(-32602, u"%1 是指数,优质股追踪只支持个股 / ETF"_s.arg(symbol));
    }
    domain::TradeStore& store = ports_.store();
    for (const OJson& q : store.listQualityStocks())
        if (js::str(js::prop(&q, u"symbol"_s)) == symbol) throw util::RpcError(-32602, u"已经在追踪 %1 了"_s.arg(symbol));
    if (store.listQualityStocks().size() >= AnomalyService::kMaxQuality) {
        // 每只股一条常驻行情流,线路总共约 100 条,还要留给宏观带、盯盘、期权链
        throw util::RpcError(-32602, u"最多追踪 %1 只"_s.arg(AnomalyService::kMaxQuality));
    }
    // 成员身份由池子说了算:不在任何板块里就先并进「自选」,再开「盯异动」这一个开关
    ports_.pool().ensureInPool(symbol, js::strOr(js::prop(&params, u"company"_s), QString()));
    orchestrate::PoolWatchPatch patch;
    patch.anomaly = true;
    const OJson out = ports_.pool().setWatch(symbol, patch, js::strOr(js::prop(&params, u"note"_s), QString()));
    if (!js::truthy(js::prop(&out, u"anomaly_on"_s))) {
        // String(out["skipped"][0] ?? …):skipped 不是数组也不是空时 TS 会抛 TypeError(propStrict 抛同一句);真 PoolService 总是给数组
        const OJson* first = js::propStrict(js::prop(&out, u"skipped"_s), u"0"_s);
        throw util::RpcError(-32602, js::strOr(first, u"打不开 %1 的异动监控"_s.arg(symbol)));
    }
    std::optional<OJson> stock;
    for (const OJson& q : store.listQualityStocks())
        if (js::str(js::prop(&q, u"symbol"_s)) == symbol) {
            stock = q;
            break;
        }
    // 刚开成功的开关,行一定在;真不在就是库被别处动了,如实报而不是断言过去
    if (!stock) throw util::RpcError(-32000, u"%1 的异动监控开了,但库里读不回这一行"_s.arg(symbol));
    return js::object({{u"stock"_s, qualityRowOut(*stock)}});
}

OJson QualityHandlers::qualityUpdate(const OJson& params) {
    const QString stockId = util::jsTrim(js::strOr(js::prop(&params, u"id"_s), QString()));
    domain::TradeStore& store = ports_.store();
    const std::optional<OJson> stock = store.getQualityStock(stockId);
    if (!stock) throw util::RpcError(-32602, u"没有这只优质股:%1"_s.arg(stockId));
    OJson fields = js::object();
    if (!js::nullish(js::prop(&params, u"enabled"_s))) fields.set(u"enabled"_s, js::B(js::truthy(js::prop(&params, u"enabled"_s))));
    if (!js::nullish(js::prop(&params, u"note"_s))) fields.set(u"note"_s, js::S(js::str(js::prop(&params, u"note"_s))));
    if (!fields.fields.isEmpty()) {
        store.updateQualityStock(stockId, fields);
        const OJson detail = js::object({{u"id"_s, js::S(stockId)}, {u"symbol"_s, js::copyOrNull(js::prop(&*stock, u"symbol"_s))}, {u"fields"_s, js::strings(js::keys(&fields))}});
        store.audit(u"ui"_s, u"quality_update"_s, &detail);
    }
    const OJson* enabled = js::prop(&fields, u"enabled"_s);
    if (enabled && enabled->type == OJson::Bool && !enabled->b) {
        // 停用期间的样本到重新启用时早就过时了,留着只会把一段空档算成"窗口"
        ports_.anomaly().forget(js::str(js::prop(&*stock, u"symbol"_s)));
    }
    const std::optional<OJson> fresh = store.getQualityStock(stockId);
    return js::object({{u"stock"_s, qualityRowOut(fresh ? *fresh : *stock)}});
}

OJson QualityHandlers::qualityRemove(const OJson& params) {
    const QString stockId = util::jsTrim(js::strOr(js::prop(&params, u"id"_s), QString()));
    const std::optional<OJson> stock = ports_.store().getQualityStock(stockId);
    if (!stock) throw util::RpcError(-32602, u"没有这只优质股:%1"_s.arg(stockId));
    // 走同一段开关逻辑:删行 + 清掉内存里的样本 / 指标 + 留痕,一处改处处改
    orchestrate::PoolWatchPatch patch;
    patch.anomaly = false;
    ports_.pool().setWatch(js::str(js::prop(&*stock, u"symbol"_s)), patch, QString());
    return js::object({{u"deleted"_s, js::S(stockId)}});
}

OJson QualityHandlers::qualitySetConfig(const OJson& params) {
    // "config 得是个对象"由 schema 管;哪几项、各自的范围由 normalizeAnomalyConfig 管(给中文原因)
    analysis::anomaly::Config config;
    try {
        // 界面一次只改一两项:在当前生效的那份上合并,不是在默认值上
        config = analysis::anomaly::normalizeAnomalyConfig(js::prop(&params, u"config"_s), ports_.anomaly().config());
    } catch (const analysis::anomaly::AnomalyError& exc) {
        throw util::RpcError(-32602, exc.message());
    }
    const OJson json = config.toJson();
    ports_.store().setPref(AnomalyService::kQualityConfigPref, &json);
    const OJson detail = js::object({{u"config"_s, json}});
    ports_.store().audit(u"ui"_s, u"quality_config"_s, &detail);
    return js::object({{u"config"_s, json}});
}

}  // namespace ibkr::rpc
