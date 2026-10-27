#include "shell/topbar_state.h"

#include <QJsonArray>

namespace ibkr::shell {

using namespace Qt::StringLiterals;

QString gatewayName(const QJsonObject& status) { return status.value(u"broker_provider").toString() == u"futu" ? u"OpenD"_s : u"TWS"_s; }

namespace {

QJsonObject chip(const QString& text, const QString& tone, const QString& tip = {}) {
    return {{u"text"_s, text}, {u"tone"_s, tone}, {u"tip"_s, tip}};
}

}  // namespace

QJsonObject topbarState(const QJsonObject& status, int engineOk) {
    const bool has = !status.isEmpty();
    const QString gateway = gatewayName(status);
    const bool connected = status.value(u"broker_connected").toBool();
    const bool upstreamDown = connected && status.contains(u"broker_upstream_ok") && !status.value(u"broker_upstream_ok").toBool(true);
    const QJsonObject breaker = status.value(u"breaker").toObject();
    const bool engaged = breaker.value(u"engaged").toBool();
    const QJsonObject protections = status.value(u"protections").toObject();
    // 保护规则的暂停:比熔断轻一档,到点自己解除
    const bool guarded = protections.value(u"paused").toBool();
    // 只停了某个账户的:别的账户照发,所以不占「保护暂停」那一格,只在悬停里说
    const QJsonArray accountPauses = protections.value(u"accounts").toArray();

    const bool stale = engineOk == 0;
    QString brokerText = stale ? gateway + u" 状态未知"_s : upstreamDown ? gateway + u" 上游中断"_s : connected ? gateway + u" 已连接"_s : gateway + u" 未连接"_s;
    const QString brokerTone = stale ? u"bad"_s : upstreamDown ? u"warn"_s : connected ? u"ok"_s : u"idle"_s;
    const QString brokerTip = stale ? u"交易引擎没有回应,券商连接的状态读不到。引擎恢复后这里会自己更新。"_s
        : upstreamDown ? u"%1 与券商服务器断连:本机连得上 %1,但行情无回应。等待自动重连或检查网络。"_s.arg(gateway)
        : connected ? u"引擎与券商网关的长连接正常"_s
                    : u"未连接券商:只能解析,不能下单,也拿不到行情"_s;

    // 模式
    QString modeText = u"直接发单"_s;
    QString modeTone = u"warn"_s;
    QString modeTip = u"解析、校验通过的订单直接发到券商,实盘账户也一样"_s;
    if (engaged) {
        modeText = u"已熔断"_s;
        modeTone = u"bad"_s;
        modeTip = u"熔断中:不再发出任何新单,解除后恢复"_s;
    } else if (guarded) {
        modeText = u"保护暂停"_s;
        modeTone = u"warn"_s;
        const QString reason = protections.value(u"reason").toString();
        modeTip = u"%1。平仓不受影响。"_s.arg(reason.isEmpty() ? u"保护规则已触发"_s : reason);
    }
    if (!engaged && !guarded && !accountPauses.isEmpty()) {
        QStringList names, reasons;
        for (const QJsonValue& p : accountPauses) {
            names.append(p.toObject().value(u"account").toString());
            reasons.append(p.toObject().value(u"reason").toString());
        }
        modeText += u" · %1 暂停"_s.arg(names.join(u"、"_s));
        modeTip += u"。%1。平仓不受影响。"_s.arg(reasons.join(u";"_s));
    }

    // 时间和市场时段合成一格,只留时分——秒在这里没有决策价值,却让这一格每秒都在跳
    const QString hhmm = status.value(u"now_et").toString().mid(11, 5);
    const QString market = status.value(u"market_status").toString();
    const QString marketText = has ? u"%1 %2 美东"_s.arg(market, hhmm) : u"—"_s;
    const QString marketTone = market == u"盘中" ? u"ok"_s : has ? u"warn"_s : u"idle"_s;
    QString model = status.value(u"model").toString();
    if (model.isEmpty()) model = u"—"_s;
    if (model.startsWith(u"claude-")) model.remove(0, 7);

    return {
        {u"broker"_s, chip(brokerText, brokerTone, brokerTip)},
        {u"mode"_s, chip(modeText, modeTone, modeTip)},
        {u"market"_s, chip(marketText, marketTone, has ? u"美东时间 %1"_s.arg(status.value(u"now_et").toString()) : QString())},
        {u"model"_s, chip(model, u"idle"_s, status.value(u"model").toString().isEmpty() ? QString() : u"解析用的模型:%1"_s.arg(status.value(u"model").toString()))},
        {u"engine"_s, chip(QString(), engineOk == -1 ? u"idle"_s : engineOk == 1 ? u"ok"_s : u"bad"_s,
                           engineOk == -1 ? u"引擎启动中"_s : engineOk == 1 ? u"交易引擎运行中"_s : u"交易引擎无响应"_s)},
        {u"connectLabel"_s, (connected ? u"断开 "_s : u"连接 "_s) + gateway},
        {u"breakerLabel"_s, engaged ? u"解除熔断"_s : u"暂停自动执行"_s},
        {u"breakerEngaged"_s, engaged},
    };
}

}  // namespace ibkr::shell
