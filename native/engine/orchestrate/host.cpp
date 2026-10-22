#include "orchestrate/host.h"

using namespace Qt::StringLiterals;

namespace ibkr::orchestrate {

namespace {

struct GatewayNames {
    QString gateway, panel;
};

//: 生效券商 → (本机网关叫什么, 界面上哪个面板去连它)
GatewayNames namesFor(const domain::Settings& settings) {
    if (settings.broker.provider == u"futu") return {u"富途 OpenD"_s, u"「富途 OpenD」"_s};
    return {u"TWS / IB Gateway"_s, u"「TWS 连接」"_s};  // ibkr,以及不认识的
}

}  // namespace

QString gatewayName(const domain::Settings& settings) { return namesFor(settings).gateway; }
QString panelName(const domain::Settings& settings) { return namesFor(settings).panel; }

util::RpcError needConnection(const domain::Settings& settings, int code, const QString& what) {
    return util::RpcError(code, u"%1需要%2:请先在%3面板连接引擎。"_s.arg(what, gatewayName(settings), panelName(settings)));
}

}  // namespace ibkr::orchestrate
