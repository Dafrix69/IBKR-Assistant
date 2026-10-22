#include "transport/handlers/alerts.h"

#include "analysis/alerts.h"
#include "analysis/ma_touch.h"
#include "orchestrate/services/alerts_service.h"
#include "orchestrate/services/svc_util.h"
#include "transport/handlers/handlers2_support.h"
#include "transport/params.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"

#include <cmath>

using namespace Qt::StringLiterals;

namespace ibkr::rpc {

using util::OJson;
namespace js = util::js;
using orchestrate::AlertsService;

MethodTable AlertsHandlers::methods() {
    return contractTable({
        {u"alerts.list"_s, [this](OJson) { return alertsList(); }},
        {u"alerts.create"_s, syncImpl([this](const OJson& p) { return alertsCreate(p); })},
        {u"alerts.delete"_s, syncImpl([this](const OJson& p) { return alertsDelete(p); })},
        {u"alerts.refresh"_s, [this](OJson p) { return ports_.alerts().refresh(std::move(p)); }},
        {u"alerts.poll"_s, [this](OJson) { return ports_.alerts().poll(); }},
        {u"alerts.set_touch_config"_s, syncImpl([this](const OJson& p) { return alertsSetTouchConfig(p); })},
    });
}

// ---- 警告 ------------------------------------------------------------
util::Task<OJson> AlertsHandlers::alertsList() {
    ports_.pool().ensureMigrated();
    OJson watches = js::array();
    for (const OJson& w : co_await ports_.alerts().listWatches()) watches.items.append(w);
    const OJson touch = ports_.alerts().touchConfig().toJson();
    const OJson confirm = js::S(ports_.alerts().crossConfirm());
    co_return js::object({{u"watches"_s, watches}, {u"touch_config"_s, touch}, {u"cross_confirm"_s, confirm}});
}

OJson AlertsHandlers::alertsCreate(const OJson& params) {
    const QString symbol = symbolOrRaise(params);
    OJson watch;
    try {
        // 不给步长(或给了个不成数的)= 自动:按现价分档。origin 只认 "tracker"(持仓追踪表单上建的),别的当用户建的
        const OJson* originRaw = js::prop(&params, u"origin"_s);
        const QString origin = originRaw && originRaw->type == OJson::String && originRaw->s == AlertsService::kOriginTracker ? AlertsService::kOriginTracker : QString();
        const OJson* stepRaw = js::prop(&params, u"step"_s);
        double step = js::nullish(stepRaw) ? analysis::alerts::kAutoStep : js::num(stepRaw);
        if (step == 0 || std::isnan(step)) step = analysis::alerts::kAutoStep;  // Number(step ?? AUTO_STEP) || AUTO_STEP
        watch = ports_.store().addWatch(symbol, step, origin);
    } catch (...) {
        throw util::RpcError(-32602, orchestrate::errMessage(std::current_exception()));
    }
    OJson detail = js::object({{u"symbol"_s, js::S(symbol)}});
    if (js::truthy(js::prop(&watch, u"origin"_s))) detail.set(u"origin"_s, js::copyOrNull(js::prop(&watch, u"origin"_s)));
    ports_.store().audit(u"ui"_s, u"alert_watch_add"_s, &detail);
    return js::object({{u"watch"_s, watch}});
}

OJson AlertsHandlers::alertsDelete(const OJson& params) {
    const QString watchId = util::jsTrim(js::strOr(js::prop(&params, u"id"_s), QString()));
    if (!ports_.store().deleteWatch(watchId)) throw util::RpcError(-32602, u"没有这个警告:%1"_s.arg(watchId));
    return js::object({{u"deleted"_s, js::S(watchId)}});
}

OJson AlertsHandlers::alertsSetTouchConfig(const OJson& params) {
    // "config 得是个对象"由 schema 管;哪几项、各自的范围由 normalizeTouchConfig 管(给中文原因)
    analysis::ma_touch::Config config;
    try {
        // 界面一次只改一两项:在当前生效的那份上合并,不是在默认值上
        config = analysis::ma_touch::normalizeTouchConfig(js::prop(&params, u"config"_s), ports_.alerts().touchConfig());
    } catch (const analysis::ma_touch::MaTouchError& exc) {
        throw util::RpcError(-32602, exc.message());
    }
    // 穿越的确认方式搭这一趟:不给就不动;认不出来的值在落任何东西之前拒掉
    const OJson* confirm = js::prop(&params, u"cross_confirm"_s);
    const bool known = confirm && confirm->type == OJson::String && (confirm->s == u"immediate" || confirm->s == u"bar_close");
    if (confirm && !known) {
        throw util::RpcError(-32602, u"穿越的确认方式只能是 immediate(跨过就报)或 bar_close(等 1 分钟收盘确认)"_s);
    }
    if (confirm && confirm->s != ports_.alerts().crossConfirm()) {
        ports_.store().setPref(AlertsService::kCrossConfirmPref, confirm);
        const OJson detail = js::object({{u"confirm"_s, *confirm}});
        ports_.store().audit(u"ui"_s, u"alert_cross_confirm"_s, &detail);
    }
    // 只改确认方式的那一趟(config 是空的)不碰碰均线的口径:不白记一条审计,也不清底账的退避
    if (!confirm || !js::keys(js::prop(&params, u"config"_s)).isEmpty()) {
        const OJson json = config.toJson();
        ports_.store().setPref(AlertsService::kTouchConfigPref, &json);
        const OJson detail = js::object({{u"config"_s, json}});
        ports_.store().audit(u"ui"_s, u"alert_touch_config"_s, &detail);
        ports_.alerts().touchConfigChanged();
    }
    return js::object({{u"config"_s, config.toJson()}});
}

}  // namespace ibkr::rpc
