// econCalendar.ts:重要事件的日历——内置的官方发布日程、每周初请按规则生成、公开日历源(Forex Factory 本周 JSON)的解析与合并、
// 事件口径(events_config)的校验。纯计算。
// 事件是 JS 对象(OJson,键序同 TS 的对象字面量);mergeEvents / expiresAt 收的事件来自 builtinEvents / parseFeed 与自定义事件的库,
// **约定:at、stars、linger_min 是有限的数,id 是串**(不是的话 TS 的排序比较器前后不一致,V8 的 TimSort 排出来的先后没有定义)。
// 日历源上的时刻按 Date.parse 读(V8 的完整读法:util/intel_dateparse),不带时区的按 local 换。
#pragma once

#include "util/error.h"
#include "util/ordered_json.h"

#include <QList>
#include <QString>
#include <QStringList>
#include <QTimeZone>

#include <optional>
#include <vector>

namespace ibkr::analysis::econ_calendar {

const util::OJson& defaultEventsConfig();
/// LINGER_MIN / STARS / KIND_LABEL(JS 对象,键序同 TS)
const util::OJson& lingerMinTable();
const util::OJson& starsTable();
const util::OJson& kindLabelTable();
QString impactOfStars(double stars);

struct Release {
    QString kind, date, time, title;
    util::OJson toJson() const;
};
const std::vector<Release>& builtinReleases();

std::optional<double> etEpoch(const QString& date, const QString& time);
bool thursdayIsFederalHoliday(const QString& date);
std::vector<Release> claimsReleases(double from, double to);
QList<util::OJson> builtinEvents(double from, double to);

QString familyOf(const QString& title);
double starsFor(const QString& kind, const QString& title, double feedStars);
/// payload 是空指针 = undefined
QList<util::OJson> parseFeed(const util::OJson* payload, const QTimeZone& local = QTimeZone::systemTimeZone());
QList<util::OJson> mergeEvents(const QList<util::OJson>& builtin, const QList<util::OJson>& feed, const QList<util::OJson>& custom);
double expiresAt(const util::OJson& e);
/// 组里共用:new Date(t).toLocaleDateString("en-CA", { timeZone: ET }) 与 toLocaleTimeString("en-GB", { hour/minute 2-digit, hour12: false })
QString etDateOf(double epoch);
QString etTimeOf(double epoch);
QStringList builtinProblems();

class EventsConfigError : public util::JsError {
public:
    using util::JsError::JsError;
};
/// input 是空指针 = undefined
util::OJson normalizeEventsConfig(const util::OJson* input, const util::OJson& base = defaultEventsConfig());

}  // namespace ibkr::analysis::econ_calendar
