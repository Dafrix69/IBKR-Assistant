// BrokerRouter(execution/broker.h)接到 engine/ 各块的 router 面上:HostedRouter、ReconcileRouter、SpotRouter、ShorthandRouter、HoursRouter、
// AccountGuardRouter、WakeRouter。TS 里这些是同一个 router 对象的不同侧面(鸭子类型),这里一个适配类全接上,engine.ts 的搬运者
// `BrokerRouterPorts ports(*router)` 之后把 &ports 交给各块即可。纯转发,没有逻辑——所以没有单独的夹具(BrokerRouter 本身有 broker 簇的对拍);
// 各块与假 router 的行为由 tst_engine_world / tst_engine_pure / tst_engine_guards 钉着。
//
// 生命周期:适配类按引用持有 BrokerRouter,BrokerRouter 要活得比适配类和所有未完成的调用长(同 broker.h 的规矩)。引擎重建 router 时(配置重载、重连)
// 重建适配类,不要存旧的。富途不移植:broker() 恒为 "ibkr"。
#pragma once

#include "execution/broker.h"
#include "orchestrate/account_guard.h"
#include "orchestrate/hosted.h"
#include "orchestrate/local_shorthand.h"
#include "orchestrate/reconcile.h"
#include "orchestrate/session_hours.h"
#include "orchestrate/spot_stop.h"
#include "orchestrate/wake_guard.h"

namespace ibkr::orchestrate {

class BrokerRouterPorts final : public HostedRouter,
                                public ReconcileRouter,
                                public SpotRouter,
                                public ShorthandRouter,
                                public HoursRouter,
                                public AccountGuardRouter,
                                public wake::WakeRouter {
public:
    explicit BrokerRouterPorts(execution::BrokerRouter& router) : r_(router) {}

    // ---- 共用
    util::Task<QList<Rec>> positions() override { return r_.positions(); }
    util::Task<std::optional<double>> indexPrice(const QString& symbol) override { return r_.indexPrice(symbol); }
    bool hasSpotInfo() const override { return true; }
    std::optional<util::OJson> spotInfo(const QString& symbol) override { return r_.spotInfo(symbol); }

    // ---- HostedRouter
    bool supportsHostedClose() const override { return execution::BrokerRouter::kSupportsHostedClose; }
    std::optional<QSet<QString>> coveredAccounts() override {
        const QStringList l = r_.coveredAccounts();
        return QSet<QString>(l.begin(), l.end());
    }
    bool hasListHostedOpen() const override { return true; }
    util::Task<QList<Rec>> listHostedOpen() override { return r_.listHostedOpen(); }
    util::Task<execution::HostedPlacement> placeHosted(contract::AccountConfig account, Rec contractSpec, Rec item, QString ocaGroup, QString orderRef) override {
        return r_.placeHosted(std::move(account), std::move(contractSpec), std::move(item), std::move(ocaGroup), std::move(orderRef));
    }
    util::Task<bool> modifyHosted(qint64 orderId, Rec item) override { return r_.modifyHosted(static_cast<int>(orderId), std::move(item)); }
    util::Task<bool> cancelHosted(qint64 orderId) override { return r_.cancelHosted(static_cast<int>(orderId)); }

    // ---- ReconcileRouter
    bool hasListOpenOrdersDetailed() const override { return true; }
    util::Task<QList<Rec>> listOpenOrdersDetailed() override { return r_.listOpenOrdersDetailed(); }
    std::optional<QSet<QString>> coveredAccountIds() override {
        const QStringList l = r_.coveredAccountIds();
        return QSet<QString>(l.begin(), l.end());
    }
    bool hasExecutions() const override { return true; }
    util::Task<QList<Rec>> executions() override { return r_.executions(); }

    // ---- SpotRouter
    bool hasStreamQuotes() const override { return true; }
    util::Task<util::OJson> streamQuotes(const QStringList& symbols) override { return r_.streamQuotes(symbols); }

    // ---- HoursRouter
    bool hasContractHours() const override { return true; }
    util::Task<std::optional<ContractHours>> contractHours(const util::OJson& row, const contract::AccountConfig& account) override {
        return r_.contractHours(row, account);
    }
    bool hasCachedContractHours() const override { return true; }
    std::optional<ContractHours> cachedContractHours(const QString& symbol, const QString& expiry) override { return r_.cachedContractHours(symbol, expiry); }

    // ---- AccountGuardRouter
    execution::SessionList sessions() override { return r_.sessions(); }
    QString broker() const override { return execution::BrokerRouter::kBroker; }

    // ---- wake::WakeRouter
    bool hasConnectedNames() const override { return true; }
    QStringList connectedNames() override { return r_.connectedNames(); }
    int sessionCount() override { return static_cast<int>(r_.sessions().size()); }

private:
    execution::BrokerRouter& r_;
};

}  // namespace ibkr::orchestrate
