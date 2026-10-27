// follow.ts:Discord 跟单的判定规则——一条频道消息跟还是不跟、为什么;成交后建追踪的入参与核对。纯函数。
// 红线同本地速记:绝不猜。跟单只认本地速记完整接住的写明价格的买入蝴蝶、写明方向与价格的贷方价差。
#pragma once

#include "contract/config_types.h"
#include "util/ordered_json.h"

#include <QString>
#include <QStringList>

#include <optional>
#include <vector>

namespace ibkr::parsing::follow {

inline constexpr double kRelativeCenterMaxPoints = 50;
inline constexpr double kPendingMissRounds = 5;
inline const QString kFollowTrackNote = QStringLiteral("Discord 跟单自动建立");

struct FollowMessage {
    QString channel_id, author_id, content;
    double sentAtMs = 0;
};
struct Triage {
    QString kind;  // other_channel / untrusted / chatter / stale / parse
    QString detail;
};

QString orderText(const QString& content);
std::optional<QString> whyUnparsed(const QString& text);
Triage triage(const contract::FollowConfig& cfg, const FollowMessage& message, double nowMs);

struct FollowGates {
    std::optional<QString> breaker;
    bool connected = false;
};
struct Decision {
    QString outcome;  // send / unparsed / rejected / capped / observed / blocked
    QString detail, summary;
    /// TS 那几处返回的字面量键序不一样:前三处(没接住 / 拒绝 / 结构不对)是 detail 在前,其余 summary 在前
    bool summaryFirst = true;
    util::OJson toJson() const;
};
/// payload:本地速记的产出(没接住是 null)
Decision decide(const contract::FollowConfig& cfg, const util::OJson& payload, const FollowGates& gates, double sentToday);

struct CenterProblem {
    QString detail, summary;
};
std::optional<CenterProblem> relativeCenterProblem(const util::OJson& payload, double spot);
double worstCaseUsd(double quantity, std::optional<double> premium, double wing);
double creditWorstCaseUsd(double quantity, double credit, double width);

/// InstructionSubmitResult 里这里读的四个桶(松的 JSON:submitted / queued 的 {account, record_id}、validated_only、rejections、warnings)
struct OutcomeResult {
    QString outcome, detail;
    QStringList record_ids;
};
OutcomeResult outcomeOf(const util::OJson& result);

struct LeaderPrice {
    QString side;  // debit / credit
    double price = 0;
};
std::optional<LeaderPrice> leaderPrice(const util::OJson& contract, const util::OJson& order);
/// FollowQuote 或 null
util::OJson followQuote(const LeaderPrice& leader, double signedMid, double signedNatural, double lagMs, bool paper);

/// TrackerAddParams(键序同 TS)
util::OJson flyTrackParams(const QString& key, const QString& exitAt);

struct PendingTrack {
    QString record_id, message_id, account, symbol, leg, summary;
    double at_ms = 0;
    std::optional<double> settled_fills;
    util::OJson toJson() const;
};
std::vector<PendingTrack> pendingTracksOf(const util::OJson* raw);
QString pendingLastDay(const QString& leg, double atMs);
struct PendingFacts {
    double nowMs = 0;
    bool filled = false, final_ = false;
    std::optional<bool> held;
    QString track;  // none / active / idle
    double misses = 0;
};
QString pendingVerdict(const QString& leg, double atMs, const PendingFacts& facts);
QString remainderVerdict(const QString& leg, double atMs, std::optional<double> settledFills, double nowMs, bool final_, double fills, const QString& track);
/// track:{targets, auto_close} 的那一行(松的 JSON)
QString trackExitsText(const util::OJson& track, double nowMs);

}  // namespace ibkr::parsing::follow
