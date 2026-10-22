// engine/wakeGuard.ts 逐句搬:盯盘停过——认出来、醒来先别判断、一整段停完之后说一声。
//   · 相邻两轮开始的墙钟差超过 GAP_MS 算一次停摆;墙钟差减"醒着的时钟"差 = 其间睡着的时长,占一半以上算睡眠,否则是"引擎卡住了"。
//   · 睡着过的,醒来先不判断:券商连接(连着的连接名不变、不为空)连续稳住 SETTLE_MS 才恢复,最长等 SETTLE_MAX_MS。卡住的不等。
//   · 睡着以后系统每十几分钟维护唤醒一次,每一次都是一次停摆:连着跑满 QUIET_MS 没再停才算真醒了,这之间的停摆并成一段,结束时只报一次。
// 判断全在 WakeGuard 里,时钟与连接由调用方每一轮给,离线测试直接喂数。期望值:tests/fixtures/gen_engine_wake.mjs(原模块现跑)。
//
// 与 TS 的不同:awakeClockMs 在 TS 里要靠 os.cpus() 的时间片计数凑一个"醒着时才走的钟"(Node 没有现成的);C++ 有 util::awakeMicros(),
// 所以无参的 awakeClockMs() 直接取它(毫秒)。带 cpus / platform / fallback 的那一版把 TS 的函数体原样搬来,只给对拍用。
#pragma once

#include "orchestrate/engine_ports.h"
#include "util/notify.h"
#include "util/ordered_json.h"

#include <QList>
#include <QString>
#include <QStringList>

#include <functional>
#include <optional>
#include <vector>

namespace ibkr::orchestrate::wake {

/// 两轮开始之间超过这么久算停摆。正常是 1 秒
inline constexpr double kGapMs = 30'000;
/// 连着跑满这么久没再停,才算真醒了
inline constexpr double kQuietMs = 60'000;
/// 睡醒之后,券商连接连续稳住这么久才恢复判断
inline constexpr double kSettleMs = 20'000;
/// 醒后最多等这么久,之后连接稳不稳都照常判断
inline constexpr double kSettleMaxMs = 120'000;
/// 停得比这短的只留痕,不弹通知
inline constexpr double kNotifyMinMs = 60'000;

/// HOLD_REASON
QString holdReason();

/// os.cpus() 里每个核的 times
struct CpuTimes {
    double user = 0, nice = 0, sys = 0, idle = 0, irq = 0;
};
/// 只在电脑醒着时走的时钟(毫秒):TS 的函数体原样。fallback 是 performance.now()
double awakeClockMs(const std::vector<CpuTimes>& cpus, const QString& platform, const std::function<double()>& fallback);
/// 取 util::awakeMicros() / 1000
double awakeClockMs();

enum class GapKind { Sleep, Stall };
QString gapKindName(GapKind k);

/// 此刻在盯的追踪:启用着、还没触发的,加上平仓单正在追价的
struct LiveTracks {
    double total = 0;
    /// 其中托管到券商的:券商那边的单睡着也有效
    double hosted = 0;
    QStringList symbols;
};

struct WakeSample {
    double wall = 0;  // 这一轮开始时的墙钟(Date.now())
    double mono = 0;  // 同一刻只在醒着时走的时钟
    QString link;     // 此刻连着的连接名,排好序拼成一串;一条都没连是空串
    LiveTracks live;
};

struct WakeGap {
    GapKind kind = GapKind::Stall;
    double from = 0, to = 0, stopped_ms = 0, asleep_ms = 0;
};

/// 一整段停摆:一次合盖,加上其间每一次维护唤醒
struct WakeEpisode {
    GapKind kind = GapKind::Stall;
    double from = 0, to = 0, gaps = 0, stopped_ms = 0, asleep_ms = 0;
    /// 其间短暂醒着的总时长
    double awake_ms = 0;
    LiveTracks live;
};

struct Released {
    double waited_ms = 0;
    bool steady = false;
};

struct WakeStep {
    std::optional<WakeGap> gap;  // 这一轮刚结束一次停摆
    QString hold;                // 非空 = 这一轮不判断,原因给界面
    std::optional<Released> released;
    std::optional<WakeEpisode> episode;  // 一整段停摆到这一轮才算结束
};

class WakeGuard {
public:
    WakeStep step(const WakeSample& s);
    /// 节拍器是被有意停掉的(引擎重建、断开券商):下一次开始不算停摆。没结束的那一段与醒后的等待都留着
    void pause();

private:
    struct Settle {
        double since = 0;
        QString link;
        std::optional<double> linkSince;
    };
    std::optional<WakeGap> gapOf(const WakeSample& s) const;
    void extend(const WakeGap& gap, const LiveTracks& live);
    std::pair<QString, std::optional<Released>> holdAt(const WakeSample& s);

    std::optional<double> prevWall_, prevMono_;
    std::optional<WakeEpisode> open_;
    std::optional<Settle> settle_;
};

/// tracks 是追踪行;chasing(id) = 这条追踪的平仓单正在追价
LiveTracks liveTracksOf(const QList<util::OJson>& tracks, const std::function<bool(const QString&)>& chasing);

/// linkOf 要的 router 那一面:没有 connectedNames 的券商(测试里的假券商)按连着的会话数算
class WakeRouter {
public:
    virtual ~WakeRouter() = default;
    virtual bool hasConnectedNames() const = 0;
    virtual QStringList connectedNames() = 0;
    virtual int sessionCount() = 0;
};
/// router 为空(没连券商)= 空串
QString linkOf(WakeRouter* router);

// ---- 给人看的话
QString durationText(double ms);
QString spanText(double from, double to, bool seconds = false);
QString gapLogLine(const WakeGap& g);
QString releasedLogLine(const Released& r);
QString episodeLogLine(const WakeEpisode& ep);
util::OJson episodeAudit(const WakeEpisode& ep);
struct Notice {
    QString title, body;
};
/// 一整段停摆结束时要不要弹通知、说什么。没有在盯的追踪、停得很短的,只留痕
std::optional<Notice> episodeNotice(const WakeEpisode& ep);

/// 引擎每一轮调一次:日志(进 main.log)、留痕、通知。log 缺省 = execution::logStderr
void reportWake(const WakeStep& step, EngineStore& store, util::Notifier& notifier, const std::function<void(const QString&)>& log = {});

}  // namespace ibkr::orchestrate::wake
