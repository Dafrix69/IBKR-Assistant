// optionMarks.ts 逐句搬:几条期权腿此刻的盘口与 IBKR 的模型 IV(只读)。蝴蝶测算与 IV 记录用。
// 最要紧的一条:不许碰盯盘的流。行情流按「合约 + generic ticks」缓存、没有引用计数,这里订的必须是自己那一条(带 generic "106"),
// 撤的也只能是自己那一条;订上之后留一分钟没人读才撤,最多留 24 条;换了会话、被拒、连着却太久没盘口的流读之前摘掉重订。
// 期望值:tests/fixtures/gen_option_marks.mjs
//
// 与 TS 的对应与不同:
//   · setInterval 的清扫(每 IDLE_MS / 2)走 Timers 缝:真跑用 QTimer,测试换成假钟;TS 没有这条缝(用的是全局 setInterval)。
//   · Date.now() → util::dateNow()。
//   · `read` 里 `tail.then(...)`:TS 永远多让一拍微任务,这里已完成的 tail 当场接着跑;排队的先后次序(第二次读等第一次读完)不变。
//   · 协程是成员函数:OptionMarkStreams 必须活得比所有未完成的 read 长(同 TS 闭包抓着 this)。
//   · 流的 `error` 真假按 JS:空串是"没有错"(但 OptionMark.error 原样带出去,空串也带)。
#pragma once

#include "contract/ordered_map.h"
#include "execution/ib_types.h"
#include "util/error.h"
#include "util/task.h"

#include <QHash>
#include <QSet>
#include <QString>

#include <functional>
#include <memory>
#include <optional>
#include <vector>

namespace ibkr::execution {

/// TS 的 `class OptionMarksError extends Error {}`
class OptionMarksError : public util::JsError {
public:
    using util::JsError::JsError;
};

struct OptionLegSpec {
    QString symbol;
    QString expiry;  // YYYYMMDD
    double strike = 0;
    QString right, exchange, tradingClass;
};

struct OptionMark {
    double strike = 0;
    QString right;
    /// 买价恰好为 0 = 没人出价,照实给 0
    std::optional<double> bid, ask;
    std::optional<double> iv;        // IBKR 的模型 IV(年化小数)
    std::optional<QString> error;    // 订阅被 TWS 拒掉时的原文(10197、354……)
};

/// 周期计时器的缝(TS 直接用全局 setInterval)。start 回一个句柄,stop 凭句柄停
struct IntervalTimers {
    std::function<quint64(int ms, std::function<void()> fn)> start;
    std::function<void(quint64)> stop;
};
/// 真跑用:QTimer
IntervalTimers qtIntervalTimers();

class OptionMarkStreams {
public:
    /// 106 = 期权隐含波动率。带上它只为了和不带 generic 的盯盘流、带 "100,101,106" 的期权链流分开
    static inline const QString kTicks = QStringLiteral("106");
    static constexpr double kIdleMs = 60'000;
    static constexpr int kMaxStreams = 24;
    static constexpr double kQuoteWaitMs = 4'000;
    /// 盘口齐了之后再等模型 IV 多久:它比盘口晚一拍,但休市时根本不来,不能一直等
    static constexpr double kIvWaitMs = 1'500;
    static constexpr int kQualifyTimeoutMs = 12'000;

    explicit OptionMarkStreams(IntervalTimers timers = qtIntervalTimers());
    ~OptionMarkStreams();
    OptionMarkStreams(const OptionMarkStreams&) = delete;
    OptionMarkStreams& operator=(const OptionMarkStreams&) = delete;

    /// 同一时刻只跑一次:两次读交错的话,一边在等的流可能被另一边的清理撤掉。
    /// silentLimitMs:连着却这么久没来一笔盘口的流当它死了、重订(0 = 不判)
    util::Task<std::vector<OptionMark>> read(std::shared_ptr<IbSession> session, std::vector<OptionLegSpec> legs, bool delayedOk, double silentLimitMs = 0);
    qsizetype size() const { return streams_.size(); }
    /// 撤掉所有还留着的流(引擎退出、券商断开重连时)
    void close();

private:
    struct Stream {
        std::shared_ptr<IbSession> session;
        IbContract contract;
        std::shared_ptr<TickerHandle> handle;
        double usedAt = 0;
    };

    static QString key(const OptionLegSpec& leg);
    void drop(const QString& key);
    void sweep(double now, const QSet<QString>& keep);
    void startSweeper();
    void stopSweeper();
    util::Task<> qualify(std::shared_ptr<IbSession> session, const std::vector<OptionLegSpec>& legs, std::vector<IbContract>& contracts);
    util::Task<std::vector<OptionMark>> readNow(std::shared_ptr<IbSession> session, std::vector<OptionLegSpec> legs, bool delayedOk, double silentLimitMs);
    util::Task<> waitFor(std::shared_ptr<IbSession> session, std::vector<QString> keys);

    IntervalTimers timers_;
    contract::OrderedMap<Stream> streams_;
    QHash<QString, int> conIds_;
    std::optional<quint64> sweeper_;
    util::Task<> tail_ = util::Task<>::resolved();
};

}  // namespace ibkr::execution
