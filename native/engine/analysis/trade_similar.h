// tradeSimilar.ts:下单页「历史相似交易」——拿一张订单票据,在历史交易里按规则打分找相似的,按出场方式数胜负。纯函数、只读。
// 历史来自 trade_outcomes 的事实(OJson);票据是 IdeasSimilarTradesParams 的 OJson(RPC 入参,schema 校验过结构)。
// 期望值:tests/fixtures/gen_trade_similar.mjs
#pragma once

#include "util/ordered_json.h"

#include <QHash>
#include <QList>
#include <QSet>
#include <QString>

#include <optional>

namespace ibkr::analysis::trade_similar {

inline constexpr int kTopMatches = 8;
inline constexpr double kWidthTolerance = 0.2;
inline constexpr double kDebitRatioTolerance = 0.05;
inline constexpr double kCenterDistTolerance = 0.5;
inline constexpr double kRangeLookback = 20;

/// 一笔历史交易的可比要素(TS 的 HistoryEntry;拿不到的项是空,JSON 里没有那一键)
struct HistoryEntry {
    util::OJson fact;
    QString exit;
    QString structure;
    bool coarse = false;
    std::optional<QString> right;
    std::optional<double> width;
    std::optional<QString> dte;
    std::optional<QString> slot;
    std::optional<double> debitRatio;
    std::optional<double> centerDist;
    std::optional<QString> side;
    std::optional<double> rangePos;
    util::OJson toJson() const;
    static HistoryEntry fromJson(const util::OJson& o);
};

/// 上下文:标的现价(蝴蝶算中心离现价)、股票现价在近期区间的位置;null / undefined 都是空
struct SimilarContext {
    std::optional<double> spot;
    std::optional<double> rangePos;
};

QString rangeBucket(double pos);
std::optional<double> rangePosition(const QList<util::OJson>& bars, const QString& beforeDate, double price, double lookback = kRangeLookback);
std::optional<double> priceAt(const QList<util::OJson>& bars, double whenMs);
QString slotOf(double epochMs);
QString bucketOfDays(double days);
std::optional<QString> dteBucket(const QString& expiry, const QString& tradeDate);
QString positionExit(const util::OJson& p);

QList<HistoryEntry> butterflyEntries(const QList<util::OJson>& records, const QList<util::OJson>& facts, const QHash<QString, double>& entryUnderlying = {});
QList<HistoryEntry> positionEntries(const QList<util::OJson>& rows, const QList<util::OJson>& facts, const QHash<QString, double>& entryUnderlying = {});
QList<HistoryEntry> optionEntries(const QList<util::OJson>& rows, const QList<util::OJson>& facts);
QList<HistoryEntry> stockEntries(const QList<util::OJson>& facts, const QHash<QString, double>& rangePos = {});

/// butterfly / vertical / single / stock / other
QString ticketKind(const util::OJson& ticket);
/// IdeasSimilarTradesResult 去掉 lessons
util::OJson findSimilar(const util::OJson& ticket, const QList<HistoryEntry>& history, double nowMs, const QSet<QString>& peers = {}, const SimilarContext& ctx = {});

}  // namespace ibkr::analysis::trade_similar
