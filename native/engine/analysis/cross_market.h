// crossMarket.ts:跨市场跟跌套利(P0)——美股大动,而美股市场上的韩股 / A 股 ETF 没同步动时,判要不要报、报成一条什么事件。纯计算。
// 报价表是 JS 对象(代码 → {symbol, last, change_pct});change_pct 只认有限的数(Number.isFinite 不转换),last 原样带进事件。
#pragma once

#include "util/ordered_json.h"

#include <QList>
#include <QString>
#include <QStringList>

#include <optional>
#include <vector>

namespace ibkr::analysis::cross_market {

struct Market {
    QString key, name, offset, open, measure;
    QStringList instruments;
};
const std::vector<Market>& crossMarkets();
/// CROSS_MARKETS 原样(对拍用)
util::OJson crossMarketsJson();
const QStringList& crossSymbols();
inline constexpr double kCrossLingerMin = 60;

double nextOpen(double now, const QString& offset, const QString& open, double graceMs = 0);
double usSessionStart(double lastOpen);

struct Window {
    struct Open {
        QString key, name;
        double at = 0;
    };
    QList<Open> opens;
    double first = 0, last = 0, start = 0;
    util::OJson toJson() const;
};
std::optional<Window> crossWindow(double now);

struct Cfg {
    double pct = 0, lag_pct = 0;
};
/// 不报是 null
util::OJson evaluateCrossMarket(std::optional<double> usPct, const util::OJson& quotes, double now, const Cfg& cfg);

}  // namespace ibkr::analysis::cross_market
