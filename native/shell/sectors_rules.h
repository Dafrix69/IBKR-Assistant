// 「板块」一页(逐句搬):板块 = 股票池,一只股登记一次,「价位」「异动」是它身上的两个开关。
//   · pages/Sectors.tsx:新建板块、心跳一行、板块卡片(列头 + 每只一行 + 更新时间 + 手动添加)、最近异动、最近价位触发、提醒方式、
//     触发条件、价位穿越、反复碰均线;
//   · lib/PoolStock.tsx:一行(现价 / 涨跌 / 两列量比 / 两个开关 / 移除)与行下的价位条(步长、到期、墙的 gamma、最大痛点、P/C、碰均线攒了几次、重算墙);
//   · lib/MonitorLine.tsx:异动监控的心跳(停了、慢了、报错了、不在时段里都得在这一行看出来);
//   · lib/Conditions.tsx、TouchConfig.tsx、CrossConfirm.tsx、AlertMethods.tsx:设置那几块;
//   · lib/anomalyFormat.ts:价格、涨跌、事件时间的写法。
// 判断全在引擎;这里只摆。期望值:tests/fixtures/gen_sectors.mjs
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QSet>
#include <QStringList>
#include <QTimeZone>

#include <optional>

namespace ibkr::shell::sectors {

/// anomalyFormat.ts 的 fmtPrice:一块钱以上两位小数;仙股给到四位(0.0042 不显示成 0.00);千分位;空是「—」
QString fmtPrice(const QJsonValue& v);
/// fmtWhen:今天只写时分秒;不是今天的带上月-日;读不出 / ≤ 0 是「—」
QString fmtWhen(double ms, double nowMs, const QTimeZone& zone);
/// toMs:数字大于 1e12 当毫秒、否则当秒;字符串按 Date.parse;空是没有
std::optional<double> toMs(const QJsonValue& v, const QTimeZone& zone);

struct PageInput {
    /// store/sectors 的 sectors / quotes
    QJsonArray sectors;
    QJsonObject quotes;
    /// store/quality 的快照(stocks / config / monitor / feed / error / loadedAt)
    QJsonObject quality;
    /// store/alerts 的快照(watches / feed / busy / lastCheck / touchConfig / crossConfirm)
    QJsonObject alerts;
    QJsonObject status;
    bool popupOn = true;
    bool soundOn = true;
    /// 选股着的板块、拨着开关的那一行(symbol → price / anomaly)、正在改标签的那一只、弹窗「查看」指认的那一只
    QSet<QString> picking;
    QJsonObject busy;
    QString editingTag;
    /// 改的是哪个板块里的那一只(同一只股在两个板块里时只开一处);空 = 不分板块(对拍那边的种子)
    QString editingSector;
    QString focusSymbol;
    double nowMs = 0;
    QTimeZone zone = QTimeZone::systemTimeZone();
};

/// 整页的模型(字段见 sectors_rules.cpp 的 pageModel 开头)
QJsonObject pageModel(const PageInput& in);
/// SSR 抽出来的那一串字
QStringList pageTexts(const QJsonObject& page);

}  // namespace ibkr::shell::sectors
