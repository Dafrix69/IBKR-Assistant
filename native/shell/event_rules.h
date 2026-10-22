// 重要事件的判定:照 desktop/renderer-react/src/lib/eventRules.ts 逐条搬(哪些事挂在顶上、过没过期、倒计时怎么说、
// 该不该提前提醒、板块是不是在集体走、盘前拉涨回没回吐、每天固定钟点的时段提醒、对冲指令怎么写)。期望值由 node 跑原模块现算(tests/fixtures/gen_event_rules.mjs)。
//
// 事件就用引擎回来的 JSON 对象(契约 EconEvent 同形),不另抄一份结构:字段一多一少都不会悄悄丢。时刻一律是 epoch 毫秒(double,同 JS)。
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QList>
#include <QMap>
#include <QSet>
#include <QString>

#include <optional>

namespace ibkr::shell::events {

inline constexpr double kSoonMin = 60;
inline constexpr double kLiveMin = 15;
inline constexpr double kPinAheadMs = 18.0 * 60 * 60'000;
inline constexpr int kPinMax = 3;
inline constexpr double kLeadWindowMs = 90'000;
inline constexpr double kSectorFreshMs = 3.0 * 60'000;

QString starText(const QJsonValue& stars);
double expiresAt(const QJsonObject& e);
/// upcoming / soon / live / after / expired
QString phaseOf(const QJsonObject& e, double now);
/// 美东的日历日 YYYY-MM-DD
QString etDateOf(double epochMs);

struct Pinned {
    QJsonArray events;
    int more = 0;
};
Pinned pinnedEvents(const QJsonArray& events, double now);

QString countdownText(const QJsonObject& e, double now);
/// 今天 20:30 / 明天 20:30 / 周五 20:30 / 10-28 20:30;tz 空串 = 本机时区
QString whenText(double at, double now, const QString& tz = {});

struct LeadDue {
    QString key;
    double lead = 0;
    QJsonObject event;
};
QList<LeadDue> leadsDue(const QJsonArray& events, double now, const QList<double>& leads, const QSet<QString>& fired);
QString leadTitle(const QJsonObject& e, double lead);
QString leadBody(const QJsonObject& e, double lead, double now, const QString& tz = {});

struct StockChange {
    QString symbol;
    QJsonValue changePct;
    QJsonValue at;
};
/// 每只股此刻的涨跌幅;旧的、没有时刻的是空
QMap<QString, std::optional<double>> freshChanges(const QList<StockChange>& stocks, double now, double maxAgeMs = kSectorFreshMs);

struct SectorRule {
    double minStocks = 3;
    double share = 0.6;
    double movePct = 2;
};
struct SectorInput {
    QString name;
    QStringList symbols;
};
/// 返回契约同形的 SectorMove 对象:{ sector, direction, count, total, median, movers: [{ symbol, pct }] }
QJsonArray sectorMoves(const QList<SectorInput>& sectors, const QMap<QString, std::optional<double>>& changes, const SectorRule& rule);
inline constexpr int kUsOpenMinute = 9 * 60 + 30;
/// 美东此刻是当天的第几分钟(09:30 = 570)
int etMinuteOf(double epochMs);
/// 美股常规时段开盘之前(异动循环 09:20 起算,板块联动在 09:20 ~ 09:30 看到的是盘前的涨跌)
bool isPremarket(double epochMs);

/// premarket:09:30 之前判出来的,标题写「盘前联动」,集体上涨换成"开盘后大概率回吐"的说法
QString sectorMoveTitle(const QJsonObject& m, bool premarket = false);
QString sectorMoveBody(const QJsonObject& m, double movePct, bool premarket = false);
/// 一个板块此刻的涨跌幅中位数(两位小数);有行情的不到 minStocks 只给空
std::optional<double> sectorMedian(const QStringList& symbols, const QMap<QString, std::optional<double>>& changes, double minStocks = 1);

/// 盘前拉涨的回吐检查:美东 10:00 ~ 10:30 之间看一次
inline constexpr int kFadeCheckFrom = 10 * 60;
inline constexpr int kFadeCheckUntil = 10 * 60 + 30;
/// faded(盘前中位的一半以上没了)/ held
QString fadeVerdict(double preMedian, double nowMedian);
QString fadeTitle(const QString& sector, const QString& verdict);
QString fadeBody(double preMedian, double nowMedian, const QString& verdict);

/// 时段提醒:钟点按各自交易所的当地时间写(欧美夏令时不在同一周切换);us = 美股的钟点,美股不开不报
struct SessionMark {
    QString id;
    QString tz;
    QString time;  // 当地 HH:MM
    QString title;
    QString body;
    bool us = false;
};
const QList<SessionMark>& sessionMarks();
/// 伦敦与纽约差几小时:平常 5,两边夏令时没同步的那几周是 4
int londonNyGap(double epochMs);
struct SessionMarkDue {
    QString key;
    SessionMark mark;
};
/// 当地周一到周五、到点后 kLeadWindowMs 之内,每个当地日期只报一次;usOpen = 此刻美股开不开(引擎的 market_status)
QList<SessionMarkDue> sessionMarksDue(double now, const QSet<QString>& fired, bool usOpen);
/// 正文:美东与北京的钟点 + 原话;欧美夏令时没同步的那一周点一句
QString sessionMarkBody(const SessionMark& mark, double now);

double strikeStep(const QString& symbol, double spot);
struct HedgeOut {
    QString text;
    QString legs;
    QString problem;  // 空 = 没问题
};
/// spec 同 TS 的 HedgeSpec:{ symbol, spot, kind, price?, outside?, width, qty, expiry, todayEt, reason }
HedgeOut hedgeInstruction(const QJsonObject& spec);
QString hedgeExpiryFor(const QJsonObject& e, const QString& todayEt);

}  // namespace ibkr::shell::events
