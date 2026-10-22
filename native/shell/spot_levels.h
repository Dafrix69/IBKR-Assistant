// 现价走到关口(25 的整数倍)了没有(desktop/renderer-react/src/lib/spotLevels.ts 逐条搬):现价上下最近的两个关口,
// 以及"这一笔相对上一笔穿过了哪个关口"。期望值由 node 跑原模块现算(tests/fixtures/gen_spot_levels.mjs)。
#pragma once

#include <QJsonObject>
#include <QString>

#include <optional>

namespace ibkr::shell::spot {

/// SPX 的蝶中心都落在 25 的整数倍上(7700 / 7725 / 7750)
inline constexpr double kLevelStep = 25;
/// 两笔可用的价隔了这么久(电脑睡过、断线重连),后一笔只登记、不和前一笔比:中间走过哪儿没人看见
inline constexpr double kGapMs = 30'000;

struct Sample {
    /// 没有价是空
    std::optional<double> price;
    /// quote / futures 是会动的现价;stale / none 不拿来判断
    QString source;
    /// 读到这个价的时刻(epoch 毫秒)
    double at = 0;
    /// 引擎的 options.spot 回包:{ price, source, at }
    static Sample fromQuote(const QJsonObject& quote);
};

struct WatchState {
    /// 上一笔可用的价;还没有是空
    std::optional<Sample> last;
    /// 刚报过的那个关口:价格离开它半个步长之前不再报
    std::optional<double> muted;
};

struct Hit {
    double level = 0;
    QString direction;
    /// 穿过去之后的那一笔价
    double price = 0;
    QString source;
    double at = 0;
    /// 这一步里在它之前还越过了几个关口(一笔跳过两个关口时只报最后一个)
    int skipped = 0;
};

struct Step {
    WatchState state;
    std::optional<Hit> hit;
};

/// 现价上下最近的两个关口。正好踩在关口上时,它算下面那个(距离 0)
std::pair<double, double> nearLevels(double price, double step = kLevelStep);
/// 喂一笔现价,看它相对上一笔穿过了关口没有(口径见 spotLevels.ts 的 stepLevelWatch)
Step stepLevelWatch(const WatchState& state, const Sample& sample, double step = kLevelStep);
QString levelHitTitle(const QString& symbol, const Hit& hit);
QString levelHitBody(const Hit& hit);

}  // namespace ibkr::shell::spot
