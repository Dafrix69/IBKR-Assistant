// engine/accountGuard.ts 逐句搬:账户级的风控输入,都由引擎向券商现取——在手敞口(两条累计上限)、当日盈亏(日内亏损上限)、净值(单笔风险预算)。
// 规则本身是纯函数(validator、util/protections、analysis/open_risk);这里只管"数从哪来、拿不到怎么办"。三样都是**拿得到才用**:
// 券商没报、不是美元、连接断着,就退回各自原来的口径,并且不让一个缺的数挡住下单——只有一种例外:用户设了在手的累计上限而持仓读不到,
// 那一张**开仓**单拒;减仓的单拿最近一次读到的持仓认,照发。期望值:tests/fixtures/gen_engine_account.mjs(原模块现跑)。
#pragma once

#include "domain/config.h"
#include "execution/account_feeds.h"
#include "orchestrate/engine_ports.h"
#include "parsing/validator.h"
#include "util/protections.h"
#include "util/task.h"

#include <QHash>
#include <QList>
#include <QString>

#include <optional>

namespace ibkr::orchestrate {

/// router 的这一面:positions() 读不到时抛(调用方当 null)。富途不移植:broker() 恒为 "ibkr",写成方法是为了认 TS 的 `BROKER === "futu"` 分支
class AccountGuardRouter {
public:
    virtual ~AccountGuardRouter() = default;
    virtual util::Task<QList<util::OJson>> positions() = 0;
    virtual execution::SessionList sessions() = 0;
    virtual QString broker() const { return QStringLiteral("ibkr"); }
};

class AccountGuardHost {
public:
    virtual ~AccountGuardHost() = default;
    virtual const domain::Settings& settings() const = 0;
    virtual AccountGuardRouter* router() = 0;  // 空 = 没连券商
    virtual EngineStore& store() = 0;
};

/// 持仓算出来的敞口,加上今天发出去还没有终态的开仓单(挂着没成交的、排队中的条件单);在减已有持仓的在途单不加。
/// exposure 是 open_risk::openRisk 的 {riskUsd, contracts, notes};working 是 store.risk.workingOrders 的行
util::OJson withWorkingOrders(const util::OJson& exposure, const QList<util::OJson>& working, const QList<util::OJson>& rows);

class AccountGuard {
public:
    explicit AccountGuard(AccountGuardHost& host) : host_(host) {}

    /// 这一批订单的校验要的那几样。两条累计上限一条都没设时不读持仓;单笔风险预算没开时不问净值。nowMs 缺省 = Date.now()
    util::Task<parsing::validator::ValidatorExtras> validatorExtras(std::optional<double> nowMs = std::nullopt);
    /// 这张已经过了校验的单是不是只在减已有的持仓。读不到持仓 = 认不准 = 不是
    util::Task<bool> isReduceOnly(parsing::validator::ApprovedOrder approved);
    /// 券商报的各账户当日盈亏(美元)。日内亏损上限没开、不按账户算、一个账户都没报:空
    std::optional<contract::OrderedMap<double>> dailyPnl(double nowMs);
    /// 现算一遍保护状态:券商报的当日盈亏由这里现取,今天到过线的账户补回去
    util::ProtectionState protections(const contract::ProtectionsConfig& cfg, const std::vector<util::CloseEvent>& closes, const std::vector<util::PnlEvent>& pnl,
                                      double nowMs);
    /// 把"今天到过线"的账户补回去
    util::ProtectionState withLatch(const util::ProtectionState& state, double nowMs);

private:
    execution::SessionList sessions();
    std::vector<contract::AccountConfig> ibkrAccounts() const;
    util::Task<std::optional<QList<util::OJson>>> readRows();

    struct Tripped {
        double dayStart = 0;
        util::ProtectionPause pause;
    };
    AccountGuardHost& host_;
    contract::OrderedMap<Tripped> tripped_;
    double trippedLoaded_ = std::nan("");
    std::optional<QList<util::OJson>> lastRows_;
};

}  // namespace ibkr::orchestrate
