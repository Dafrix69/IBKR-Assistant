// 期权主动成交的记盘(P0,只记不画):连着 IBKR、在常规时段里,订一圈 SPX 下一个到期日的近平值期权,每来一次行情推送就看成交量有没有涨,
// 涨了就把这次的成交量增量、成交价、前后两口盘口原样记一行(domain/option_flow_log,option-flow/ 日文件)。分类是 analysis/option_flow 的事,不落盘。
// 只读行情,不碰交易。行情线路:自己那一批流带 generic "101"(持仓量),和盯盘(不带)、期权链("100,101,106")、测算("106")的流各是各的,
// 撤也只撤自己那一批;最多 kMaxContracts 条。为什么订下一个到期日而不是当日到期:当日到期的合约第二天就没了,拿不到次日持仓量对照。
// 每天开盘后(kOiAfterMinutes)还把前一天记过的那批合约(今天到期)短订一次,读它们的持仓量——那是前一天收盘后的数,对照用。
// 逐笔对照:离现价最近的 kTruthContracts 张另订逐笔(AllLast + BidAsk,一张两条),每笔原样记进 option-flow-tbt/,
// 用来量记盘分类的误差(analysis/option_flow 的 accuracy)。逐笔的并发数 IBKR 卡得很紧,被拒就记一行 tbt_err、不重试;
// 一张合约的两条要么都在、要么都撤(只剩成交没有盘口的那张会把真值全变成分不出)。每张先订盘口再订成交。
// 什么时候不记都说得出原因(status().idle_reason);出错吞掉、记进 last_error。设计与口径:docs/features/option-flow.md
#pragma once

#include "analysis/option_flow.h"
#include "domain/option_flow_log.h"
#include "execution/ib_types.h"
#include "orchestrate/services/svc_host.h"

#include <QList>

#include <functional>
#include <memory>
#include <optional>

namespace ibkr::orchestrate {

/// 一条流上次看到的样子:推送来了拿它和这一次比
struct FlowStreamState {
    QString expiry;
    double strike = 0;
    QString right;
    std::optional<double> volume, lastAt;
    analysis::optionflow::Quote quote;
    bool oiDone = false;
};
/// 一次读数 → 该落盘的行(第一次见到成交量记一笔 vol 作底;涨了记 print;往回跳记 vol 不记 print),并把 state 挪到这一次
QList<util::OJson> observeFlow(FlowStreamState& state, const execution::TickerData& t, double nowMs);

class FlowRecorderService : public SvcBase {
public:
    static inline const QString kPref = QStringLiteral("options.flow_recorder");
    static inline const QString kSymbol = QStringLiteral("SPX");
    static inline const QString kTicks = QStringLiteral("101");
    static constexpr int kTickMs = 1'000;
    static constexpr int kPollMs = 250;  // 会话不给推送回调时的退路
    static constexpr double kStrikeStep = 5;
    static constexpr double kHalfBand = 25;    // 开盘后第一笔现价取整 ± 25 点:11 档 × C/P = 22 条
    static constexpr double kRovePoints = 20;  // 现价离锚这么远就在新的平值附近 ± 10 点补档
    static constexpr double kRoveHalf = 10;
    static constexpr int kMaxContracts = 30;
    static constexpr double kVolEveryMs = 5 * 60'000;
    static constexpr double kRoveEveryMs = 60'000;
    static constexpr double kRetryMs = 60'000;
    static constexpr double kOiAfterMinutes = 9 * 60 + 35;  // 美东 09:35 之后读前一天那批的持仓量
    static constexpr int kQualifyTimeoutMs = 24'000;
    static constexpr int kOiSettleMs = 5'000;
    static constexpr int kTruthContracts = 3;
    static constexpr double kTruthKeepDays = 10;  // 逐笔的文件大小要等真机跑一天才知道,先留得短

    explicit FlowRecorderService(SvcHost& host);
    ~FlowRecorderService();

    bool enabled();
    util::OJson setEnabled(bool on);
    void start(int tickMs = kTickMs);
    void stop();
    util::Task<> tickOnce(std::optional<double> nowMs = std::nullopt);
    /// 读一遍自己那批流,有变化的进待写队列(推送回调与轮询都走这里)
    void onPush();
    util::OJson status();

private:
    struct Watch {
        execution::IbContract contract;
        std::shared_ptr<execution::TickerHandle> handle;
        FlowStreamState state;
    };
    domain::OptionFlowLog log() const;
    domain::OptionFlowLog tbtLog() const;
    void startTruth(double spot);
    util::Task<> tickInner(double nowMs);
    util::Task<> setup(const QString& date, double nowMs);
    util::Task<> rove(double nowMs);
    util::Task<int> subscribe(std::vector<double> strikes, double nowMs, double spot);
    util::Task<> snapshotYesterdayOi(const QString& date, double nowMs);
    void writeVolumes(double nowMs);
    void teardown(const QString& reason, double nowMs);
    void flush();
    void idle(const QString& reason) { idleReason_ = reason; }
    util::Task<> loop(int tickMs, int gen);

    int timer_ = 0, poll_ = 0, gen_ = 0;
    bool running_ = false, busy_ = false;
    std::shared_ptr<execution::IbSession> session_;
    std::function<void()> detach_;
    QString date_, expiry_, tradingClass_;
    double anchor_ = 0;
    QList<Watch> watches_;
    QList<util::OJson> pending_, pendingTbt_;
    QList<std::function<void()>> truthCancels_;
    util::OJson truthContracts_ = util::OJson::null();
    double truthTicks_ = 0, truthErrors_ = 0;
    QString tbtPrunedFor_;
    QString pendingDate_, prunedFor_;
    double lastVolAt_ = 0, lastRoveAt_ = 0, lastSetupAt_ = 0;
    QString oiDate_, oiTryDate_;
    int oiTries_ = 0;
    double lastOiTryAt_ = 0;
    double prints_ = 0;
    std::optional<double> lastPrintAt_;
    QString idleReason_, lastError_;
    std::shared_ptr<bool> alive_ = std::make_shared<bool>(true);
};

}  // namespace ibkr::orchestrate
