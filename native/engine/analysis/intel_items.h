// intelItems.ts:消息、信号、事件、单子、想法各自折成情报时间线上的一条(IntelItem),再合成一条线。纯函数。
// 入参都是 JS 对象(OJson):消息行就是 domain::MessageLogStore::recent() 给的那种行,信号是 signalLog 的行,事件是 econ_calendar 的事件,
// 单子是 store.getRecord 折好的 RecordFacts,想法是 ideas 表的行。字段按 TS 的读法取(缺了是 undefined,模板里写成 "undefined")。
// **约定:消息行的 symbols / guesses 是串数组、prices 是对象(没有时 TS 读 prices[first] 抛 TypeError,这里同样抛);想法的 symbols 是串数组。**
// 时刻按 Date.parse 读(util/intel_dateparse),不带时区的按 local 换;读不出是 0。
#pragma once

#include "util/ordered_json.h"

#include <QList>
#include <QSet>
#include <QString>
#include <QStringList>
#include <QTimeZone>

#include <optional>

namespace ibkr::analysis::intel_items {

/// OUTCOME_LABEL[outcome] / SIGNAL_LABEL[source];表里没有的是空(TS 是 undefined)
std::optional<QString> outcomeLabel(const QString& outcome);
std::optional<QString> signalLabel(const QString& source);

/// verdict:{outcome, detail, summary} 或空(null);now:代码 → 此刻的价(Map.get,缺的与 null 一样);instruction 空 = null
util::OJson messageItem(const util::OJson& row, const util::OJson* verdict, const QSet<QString>& held, const util::OJson& now,
                        const std::optional<QString>& instruction, const QTimeZone& local = QTimeZone::systemTimeZone());
util::OJson signalItem(const util::OJson& entry, const QSet<QString>& held, const QTimeZone& local = QTimeZone::systemTimeZone());
util::OJson eventItem(const util::OJson& event, const QStringList& symbols, const QSet<QString>& held, double nowMs);
util::OJson recordItem(const util::OJson& r, const QSet<QString>& held, const QTimeZone& local = QTimeZone::systemTimeZone());
util::OJson ideaItem(const util::OJson& idea, const QStringList& symbols, const QSet<QString>& held, const QTimeZone& local = QTimeZone::systemTimeZone());

struct FeedFilter {
    std::optional<QString> symbol;     // 空 / "" = 不筛
    std::optional<QStringList> kinds;  // 空 / [] = 不筛
    bool heldOnly = false;
    std::optional<double> since;
    double limit = 0;
};
QList<util::OJson> mergeItems(const QList<QList<util::OJson>>& groups, const FeedFilter& filter);

}  // namespace ibkr::analysis::intel_items
