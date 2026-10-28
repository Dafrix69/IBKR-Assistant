// 下单页上的 SPX / QQQ 期权墙(options.wall):看涨墙 / 看跌墙、成交量墙、Gamma 翻转、最大痛点、gamma 环境,各离现价多远。
//
// 只读不下单,也不拦单:摆在交易指令页右栏的最上面,解析结果、蝴蝶测算、日内剧本三面都看得见。
// **只在交易指令页挂着时刷新,60 秒一次**(引擎那边的期权墙缓存也是 60 秒,再快也是同一份):一条链要占几十条行情线路,
// 所以两个标的一个取完再取下一个,不同时订。到期日不指定 = 链上最近的那个(SPX 就是当天的 SPXW)。
// 一个标的失败不影响另一个:各自留上一次成功的结果和这一次的错。
#pragma once

#include "shell/engine_client.h"

#include <QJsonArray>
#include <QJsonObject>
#include <QObject>
#include <QStringList>
#include <QTimer>

#include <functional>

namespace ibkr::shell {

class Bridge;

namespace walls {
struct StoreDeps {
    using Reply = std::function<void(const EngineReply&)>;
    /// options.wall
    std::function<void(const QJsonObject& params, Reply)> wall;
    /// 本机时钟(毫秒):「取于」那一刻
    std::function<double()> nowMs;
};

/// 每条链每边取多少档行权价(SPX 5 点一档 = ±75 点;QQQ 1 元一档 = ±15 元)
inline constexpr int kWidth = 15;
const QStringList& symbols();

/// 一个标的的状态 → 给人看的一行 { symbol, expiry, spot, items: [{ text, tip, tone, muted }], note, failure }
/// state = { result, failure, at, busy }
QJsonObject rowModel(const QString& symbol, const QJsonObject& state);
/// 离现价多远的百分比(带正负号、两位小数);缺一个是空
QString distanceText(const QJsonValue& level, const QJsonValue& spot);
}  // namespace walls

class WallStore : public QObject {
    Q_OBJECT
    /// [rowModel(SPX), rowModel(QQQ)]
    Q_PROPERTY(QJsonArray rows READ rows NOTIFY changed)

public:
    static constexpr int kRefreshMs = 60'000;

    WallStore(walls::StoreDeps deps, QObject* parent = nullptr);
    explicit WallStore(Bridge* bridge, QObject* parent = nullptr);
    static walls::StoreDeps bridgeDeps(Bridge* bridge, QObject* context);

    QJsonArray rows() const;
    /// 原始状态(测试用):{ SPX: { result, failure, at, busy }, QQQ: … }
    QJsonObject state() const { return state_; }
    /// 页面挂上 / 卸下时调:挂上马上取一轮
    Q_INVOKABLE void setVisible(bool on);
    /// 取一轮(上一轮还没回来就不再发)
    Q_INVOKABLE void refresh();

    int refreshMs = kRefreshMs;

signals:
    void changed();

private:
    void fetch(qsizetype index);
    void put(const QString& symbol, const QJsonObject& part);

    walls::StoreDeps deps_;
    QJsonObject state_;
    bool visible_ = false;
    bool running_ = false;
    QTimer timer_;
};

}  // namespace ibkr::shell
