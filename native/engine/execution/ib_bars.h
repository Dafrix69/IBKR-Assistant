// ibBars.ts 逐句搬:K 线从 IBKR 出来的那一段——日盘与夜盘两条线怎么取、怎么拼、闲着的那条留着不重取;指数的盘外按期货推算。
// 期望值:tests/fixtures/gen_ib_bars.mjs(原模块现跑,会话是脚本驱动的假会话,记下会话上的每一次调用)。
//
// 与 TS 的对应与不同:
//   · TS 的 tagFeed / tagProxy 把"出自哪一档行情""盘外怎么推算"记在数组旁边的 WeakMap 里(marketdata.ts,还没搬);
//     C++ 没有数组身份可挂,fetch 直接回 TaggedBars{bars, feed, proxy}。feed 空 = 没记(会话没有 quoteDelayed 方法)。
//   · DELAYED_FEED_MAX_MS 也在 marketdata.ts:这里先抄一份 kDelayedFeedMaxMs(20 分钟,券商的口径),搬 marketdata 的人并过去。
//   · PaProxy 是 contract/priceaction.ts 的接口,同样先放在这里。
//   · `raw ?? []`:会话接口回 vector,不会是 null。
//   · mergeSessionBars / proxyIndexBars 里 TS 的排序比较函数从不回 0(`a < b ? -1 : 1`),V8 的 TimSort 对相等元素等价于稳定排序,
//     这里用 stable_sort;同一时刻重复的期货 K 线不在夹具里(也不会出现:一根 K 线一个时刻)。
//   · barsError 里的 toLowerCase 用 QString::toLower(只比 "permission" / "subscri",两者在 ASCII 上一致)。
//   · `String(exc.message ?? exc)`:JsError 取 message,别的 std::exception 取 what()。
//   · fetch / 各 leg 是协程,成员函数:SessionBars 必须活得比所有未完成的 fetch 长(同 TS 里闭包抓着 this)。
#pragma once

#include "contract/ordered_map.h"
#include "execution/ib_types.h"
#include "util/task.h"

#include <QString>

#include <optional>
#include <vector>

namespace ibkr::execution {

/// day:个股的盘前 → 盘后;overnight:个股的夜盘;index:指数的常规时段;proxy:指数关着、期货开着的那一段
enum class SessionLeg { Day, Overnight, Index, Proxy };

/// IBKR 夜盘的交易所代码
inline const QString kOvernightExchange = QStringLiteral("OVERNIGHT");
/// 第二条线(夜盘 / 期货)要不到之后隔多久再试(毫秒)
inline constexpr double kOvernightRetryMs = 30 * 60'000;
/// 延迟行情最多晚多久(毫秒;marketdata.ts 的 DELAYED_FEED_MAX_MS)
inline constexpr double kDelayedFeedMaxMs = 20 * 60'000;

struct SessionBar {
    QString time;  // 'YYYY-MM-DD HH:MM'(日线 'YYYY-MM-DD'),美东墙钟
    double open = 0, high = 0, low = 0, close = 0, volume = 0;
};

/// IBKR 的 bar.date 归一化成 'YYYY-MM-DD HH:MM'(日线为 'YYYY-MM-DD')
QString barTimestamp(const QString& value);
/// 一根原始 K 线 → 引擎的样子;指数没有成交量(IBKR 回 −1),归零
SessionBar toSessionBar(const RawBar& bar);

/// 这条线此刻开着吗(epoch 毫秒)
bool legOpen(SessionLeg leg, double epochMs);
/// 这条线上一次收盘的时刻(epoch 毫秒);此刻开着是空
std::optional<double> legClosedSince(SessionLeg leg, double epochMs);

/// 夜盘那张合约:和日盘同一只股票,只换交易所,不带 conId
IbContract overnightContract(const IbContract& t);
/// 两条线按时间拼成一组。同一时刻两边都有时留日盘那根
std::vector<SessionBar> mergeSessionBars(const std::vector<SessionBar>& day, const std::vector<SessionBar>& overnight);

struct TimeSpan {
    QString from, to;
};
struct BasisPoint {
    double basis = 0;
    QString time;
};
struct IndexProxyResult {
    std::vector<SessionBar> bars;  // 指数自己的 K 线 + 推算出来的盘外 K 线,按时间排
    double derived = 0;            // 推算出来的有几根
    std::vector<TimeSpan> spans;   // 连着的推算 K 线的首尾时刻
    bool newestDerived = false;
    std::optional<BasisPoint> latestBasis;
};
/// 指数的盘外按期货推算(纯函数)
IndexProxyResult proxyIndexBars(const std::vector<SessionBar>& index, const std::vector<SessionBar>& futures);

/// contract/priceaction.ts 的 PaProxy
struct PaProxy {
    QString futures;  // 用的哪张期货,如「ES 202512」
    double derived = 0;
    QString note;
    std::vector<TimeSpan> spans;
};

enum class BarsFeed { Live, Delayed, Unknown };

/// fetch 的结果:K 线,加上 TS 里记在数组旁边的两笔(marketdata.feedOf / proxyOf)
struct TaggedBars {
    std::vector<SessionBar> bars;
    std::optional<BarsFeed> feed;
    std::optional<PaProxy> proxy;
};

struct SessionBarsRequest {
    IbContract target;  // 已确认的合约(SMART / 指数那张)
    QString endDateTime, durationStr, barSizeSetting, whatToShow;
    bool useRTH = false;
    bool overnight = false;                // 要不要夜盘那条(个股)
    std::optional<IbContract> futures;     // 指数的盘外按这张期货推算;空 = 不推算
    double nowMs = 0;                      // 此刻(epoch 毫秒):判各条线开没开着
};

class SessionBars {
public:
    /// 夜盘最近一次要不到的原因,按标的(要到了就清掉);指数推算用的期货最近一次要不到的原因,按指数代码
    contract::OrderedMap<QString> overnightErrors, proxyErrors;

    /// 取一组 K 线(日盘 / 夜盘 / 指数 + 期货推算)
    util::Task<TaggedBars> fetch(std::shared_ptr<IbSession> session, SessionBarsRequest req);

private:
    util::Task<TaggedBars> fetchIndex(std::shared_ptr<IbSession> session, SessionBarsRequest req, IbContract futures);
    util::Task<std::vector<SessionBar>> optionalLeg(std::shared_ptr<IbSession> session, SessionBarsRequest req, SessionLeg kind,
                                                 IbContract contract, contract::OrderedMap<QString>* errors);
    util::Task<std::vector<SessionBar>> leg(std::shared_ptr<IbSession> session, SessionBarsRequest req, SessionLeg kind, IbContract contract);

    struct Idle {
        std::vector<SessionBar> bars;
        double fetchedAt = 0;
    };
    contract::OrderedMap<Idle> idle_;
    contract::OrderedMap<double> retryAt_;  // (标的|线)→ 什么时候再试
};

/// 把 IBKR 的取数报错翻译成"下一步该做什么"
QString barsError(const QString& symbol, const QString& label, const QString& message);

}  // namespace ibkr::execution
