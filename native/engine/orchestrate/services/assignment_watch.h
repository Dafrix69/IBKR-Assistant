// services/assignmentWatch.ts 逐句搬:到期日空头腿的指派提醒——收盘前那一段,账户里今天到期、实物交割的空头期权腿在实值里就提醒一次。
// 只提醒,不发单。判断在 analysis/assignment_risk(纯函数);这里管节拍、去哪读持仓与现价、同一条腿一天只说一次。
// 期望值:tests/fixtures/gen_svc_assignment.mjs(原 AssignmentWatchService 对着脚本驱动的假 router、真的交易库、虚拟钟现跑),tests/tst_svc_assignment.cpp。
//
// 与 TS 的对应与不同:
//   · router 走 RouterPort(positions / streamQuotes 必有;TS 里 `typeof router.streamQuotes === "function"` 的富途分支不搬)。
//   · tickOnce 的 at 缺省 = domain::nowEt()(调用时的此刻)。循环同 fillSync:setTimeout 链,每轮 `.catch(() => undefined)`,服务先没了就放手。
//   · 通知发不出去(notify 抛)不影响下一条:catch(...)。
#pragma once

#include "domain/config.h"
#include "orchestrate/services/svc_host.h"

#include <QSet>

#include <memory>
#include <optional>

namespace ibkr::orchestrate {

class AssignmentWatchService : public SvcBase {
public:
    static constexpr int kTickMs = 60'000;
    /// 收盘前多少分钟开始看
    static constexpr int kLeadMinutes = 30;

    explicit AssignmentWatchService(SvcHost& host) : SvcBase(host) {}
    ~AssignmentWatchService();

    void start(int tickMs = kTickMs);
    void stop();
    /// 这一刻在不在"收盘前那一段"里(提前收盘日按 13:00 收)
    bool inWindow(const domain::EtNow& at) const;
    /// 一轮:返回这一轮发了几条提醒。不在时段里、没连券商、读不到持仓都是 0
    util::Task<double> tickOnce(std::optional<domain::EtNow> at = std::nullopt);

private:
    util::Task<> loop(int tickMs, int gen);

    int timer_ = 0;
    int gen_ = 0;
    bool running_ = false;
    QSet<QString> told_;
    QString toldDate_;
    std::shared_ptr<bool> alive_ = std::make_shared<bool>(true);
};

}  // namespace ibkr::orchestrate
