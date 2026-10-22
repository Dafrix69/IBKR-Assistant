// services/fillSync.ts 逐句搬:券商成交 → 本地成交表,引擎自己按节拍同步,不靠界面开着哪一页。
// 期望值:tests/fixtures/gen_svc_fillsync.mjs(原 FillSyncService 对着真的 BrokerRouter 与脚本驱动的假会话现跑,虚拟钟),
// tests/tst_svc_fillsync.cpp 把同样的脚本放给这里,逐项精确比较(会话上的每一次调用、各步结果、成交表与审计表的样子)。
//
// 钱路径:TWS 的 reqExecutions 只回它那个"当天"(按登录时选的时区翻篇,东八区就是北京午夜);同步必须在成交发生的几秒里落库,
// 软件没开着 / 断着线的时候成交的靠往回要 7 天(另开只读连接)补回;存库按 exec_id 去重(store.rememberFills),同一笔绝不记两次。
//
// 与 TS 的对应与不同:
//   · router:具体的 execution::BrokerRouter(SvcHost::broker())。TS 的 `typeof router.executions !== "function"`(富途没有)不搬——富途不移植。
//     会话的 positions / executionHistory 的"可选方法"分支:positions 是 IbSession 的必有方法,没有「会话不带 positions」那一支;
//     executionHistory 看 Cap::ExecutionHistory(缺了等于 TS 的 `typeof session.executionHistory !== "function"` → 跳过)。
//   · performance.now() → runtime().perfMs():醒着的时间(见 svc_runtime.h),睡眠里不走。
//   · withTimeout → raceTimeout(虚拟钟可换)。`.finally(clearTimeout)` 同。
//   · `inflight`:TS 在 .finally 里清;这里不清,看 Task::done()(协程同步完成时不会把已完成的当成在途)。同一时刻的两次 sync 拿同一个 Task。
//   · tickOnce 的 `.catch(() => undefined)` 在循环里:任何异常都吞,这一轮当没发生。
//   · 服务对象必须活得比它所有未完成的调用长;循环的协程在每个 co_await 之后查 alive_ 标志。
#pragma once

#include "orchestrate/services/svc_host.h"

#include <QList>
#include <QString>

#include <memory>
#include <optional>

namespace ibkr::orchestrate {

/// 持仓指纹:哪个账户、哪张合约、多少数量。只用来认"变没变",不拿去算账。数量为 0 的不算
QString holdingsFingerprint(const QList<execution::PositionItemLike>& items);

class FillSyncService : public SvcBase {
public:
    static constexpr int kTickMs = 5'000;
    /// 持仓没变也隔这么久要一次
    static constexpr double kEveryMs = 5 * 60'000;
    /// 两次向券商要成交至少隔这么久
    static constexpr double kMinGapMs = 15'000;
    static constexpr int kBrokerTimeoutMs = 10'000;
    /// 持仓变了之后要几次
    static constexpr int kAfterChange = 2;
    static constexpr int kHistoryDays = 7;
    static constexpr double kHistoryEveryMs = 60 * 60'000;

    explicit FillSyncService(SvcHost& host);
    ~FillSyncService();
    FillSyncService(const FillSyncService&) = delete;
    FillSyncService& operator=(const FillSyncService&) = delete;

    /// 券商连着,而且给得了成交
    bool available();

    void start(int tickMs = kTickMs);
    void stop();

    /// 循环的一轮:持仓变了、到点了、或者还欠着,就去要一次。返回这一轮新增了几笔;没去要是空。nowMs 缺省 = runtime().perfMs()
    util::Task<std::optional<double>> tickOnce(std::optional<double> nowMs = std::nullopt);
    /// 向券商要一次成交,存进成交表(只增,按 exec_id 去重)。没连 / 给不了 / 离上一次太近 / 券商没答上来都是空。
    /// 正在要的那一次还没回来就等它,不另发一次。deep:这一趟连前 7 天的一起要
    util::Task<std::optional<double>> sync(std::optional<double> nowMs = std::nullopt, bool deep = false);

private:
    std::shared_ptr<execution::BrokerRouter> source();
    util::Task<std::optional<double>> pull(std::shared_ptr<execution::BrokerRouter> source, double nowMs);
    util::Task<QList<util::OJson>> history(std::shared_ptr<execution::BrokerRouter> source, double nowMs);
    util::Task<std::optional<QString>> readHoldings(std::shared_ptr<execution::BrokerRouter> source);
    util::Task<> loop(int tickMs, int gen);
    void forget();

    int timer_ = 0;
    int gen_ = 0;
    bool running_ = false;
    double lastAt_ = -std::numeric_limits<double>::infinity();
    std::optional<util::Task<std::optional<double>>> inflight_;
    std::optional<QString> holdings_;
    int owed_ = 1;
    QString lastError_;
    int deepOwed_ = 1;
    double lastDeepAt_ = -std::numeric_limits<double>::infinity();
    bool historyOff_ = false;
    QString lastHistoryError_;
    std::shared_ptr<bool> alive_ = std::make_shared<bool>(true);
};

}  // namespace ibkr::orchestrate
