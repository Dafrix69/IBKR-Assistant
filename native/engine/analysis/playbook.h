// playbook.ts(SPX 日内剧本:预期波动区间、状态机、目标位、加速档)与 sessionEm.ts(从剧本底账取当天全天 1σ)。纯计算。
#pragma once

#include "util/ordered_json.h"

#include <QList>
#include <QString>

#include <optional>
#include <utility>
#include <vector>

namespace ibkr::analysis::playbook {

inline constexpr double kStrikeStep = 5;
inline constexpr double kQuietMs = 5 * 60'000;
inline constexpr double kAccelRearm = kStrikeStep / 2;
double emFactor();

/// PlaybookBand。键序是 makeBand 拼出来的那个(at, anchor, strike, expiry, call, put, source, em, lower, upper)
struct Band {
    double at = 0, anchor = 0, strike = 0;
    QString expiry;
    double call = 0, put = 0;
    QString source;  // live / backfill
    double em = 0, lower = 0, upper = 0;
    util::OJson toJson() const;
    /// 底账里读出来的(playbookLog 已经核过字段是数);缺键读成 NaN / 空串
    static Band fromJson(const util::OJson& o);
};
struct Anchor {
    double at = 0, price = 0;
    QString source;
};
struct Event {
    double at = 0;
    QString kind;   // enter / invalid / accel
    QString state;  // B2 / B3 / R / none
    double level = 0, price = 0;
    util::OJson toJson() const;
};
struct Accel {
    double strike = 0, netGex = 0;
};
struct WallStrike {
    double strike = 0, netGex = 0;
};

std::optional<double> legMid(std::optional<double> bid, std::optional<double> ask);
double atmStrike(double spot, double step = kStrikeStep);
double expectedMove(double call, double put);
struct BandSpec {
    double at = 0, anchor = 0, strike = 0;
    QString expiry;
    double call = 0, put = 0;
    QString source;
};
std::optional<Band> makeBand(const BandSpec& spec);
std::optional<Band> todayBand(const std::optional<Anchor>& anchor, const std::optional<Band>& current);
std::optional<double> wallSpan(double spot, const std::vector<std::optional<double>>& levels);

// ---- 状态机
struct MachineAccel {
    double strike = 0;
    QString side;  // above / below
    bool armed = false;
};
struct Machine {
    QString state = QStringLiteral("none");
    std::optional<double> trigger, since, lost;
    std::optional<MachineAccel> accel;
    std::vector<std::pair<QString, double>> fired;  // Record:新键加在后面
    util::OJson toJson() const;
};
struct MachineInput {
    double at = 0, price = 0;
    std::optional<double> b3, b2;
    bool frame = false;
    std::optional<double> accelStrike;
};
struct MachineMark {
    double at = 0;
    QString state;
    std::optional<double> trigger, since, lost;
};
struct Restored {
    QString state;
    std::optional<double> trigger, since, lost;
};
QString quietKey(const QString& kind, const QString& state, double level);
Restored restoreMachine(const std::optional<MachineMark>& mark, const std::vector<Event>& events);
std::pair<Machine, std::vector<Event>> stepMachine(const Machine& prev, const MachineInput& input);

// ---- 目标位与加速档
std::pair<std::optional<double>, std::optional<double>> targets(const QString& state, std::optional<double> trigger, const std::optional<Band>& open,
                                                                const std::vector<WallStrike>& strikes);
std::optional<Accel> accelerator(const std::vector<WallStrike>& strikes, const std::optional<Band>& band);

// ---- sessionEm.ts
std::optional<double> sessionSigmaOf(const Band& band, const std::vector<double>* weights = nullptr);
struct SessionEm {
    double em = 0;
    QString kind;  // open / frame
    QString at;    // 美东 HH:MM
};
/// records:一天的底账({kind, band?}…,band 可以缺)
std::optional<SessionEm> sessionEmOf(const QList<util::OJson>& records, bool earlyClose = false);

}  // namespace ibkr::analysis::playbook
