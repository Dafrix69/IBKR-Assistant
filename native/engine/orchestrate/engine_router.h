// engine.ts 的 RouterLike 接口、解析器接口、库的端口、盯盘锁——TradingEngine 对外部世界要的全部东西。
// TS 里 router 是鸭子类型(BrokerRouter / FutuRouter / 测试替身),可选方法用 `typeof x === "function"` 判有没有;这里 EngineRouter 继承各子模块
// 要的那些 router 面(HostedRouter、ReconcileRouter、SpotRouter、ShorthandRouter、HoursRouter、AccountGuardRouter、WakeRouter),再补引擎自己要的,
// 可选的用 has* 说有没有。BrokerEngineRouter 把真的 execution::BrokerRouter 接上(纯转发,没有逻辑)。富途不移植:broker() 恒为 "ibkr",
// pollOrderUpdates 只有富途有(IBKR 的 router 没有 → 对账之外的拉取式回报同步空转)。
//
// 生命周期:BrokerEngineRouter 持有 shared_ptr<BrokerRouter>,引擎持有 shared_ptr<EngineRouter>,所以任何未完成的调用都不会让 BrokerRouter 先没。
#pragma once

#include "domain/store.h"
#include "execution/broker.h"
#include "orchestrate/account_guard.h"
#include "orchestrate/engine_ports.h"
#include "orchestrate/hosted.h"
#include "orchestrate/local_shorthand.h"
#include "orchestrate/reconcile.h"
#include "orchestrate/session_hours.h"
#include "orchestrate/spot_stop.h"
#include "orchestrate/wake_guard.h"
#include "parsing/providers.h"
#include "util/task.h"

#include <QList>
#include <QString>

#include <functional>
#include <memory>
#include <optional>
#include <vector>

namespace ibkr::orchestrate {

using SessionPtr = std::shared_ptr<execution::IbSession>;

/// pollOrderUpdates 的一项:[kind, trade, fill]
struct PollUpdate {
    QString kind;
    Rec trade, fill;
};

class EngineRouter : public HostedRouter,
                     public ReconcileRouter,
                     public SpotRouter,
                     public ShorthandRouter,
                     public HoursRouter,
                     public AccountGuardRouter,
                     public wake::WakeRouter {
public:
    // 几个面上同名同签名的方法:在这里统一覆盖一次,免得经 EngineRouter 调用时名字查找有歧义
    util::Task<QList<Rec>> positions() override = 0;
    util::Task<std::optional<double>> indexPrice(const QString& symbol) override = 0;
    bool hasSpotInfo() const override { return false; }
    std::optional<util::OJson> spotInfo(const QString& symbol) override {
        (void)symbol;
        return std::nullopt;
    }

    /// SUPPORTS_NATIVE_CONDITIONS ?? true
    virtual bool supportsNativeConditions() const { return true; }
    /// 能不能挂 sessionHook(TS 里 try { router.sessionHook = … } catch {}:测试替身可能不接受)
    virtual void setSessionHook(std::function<void(const SessionPtr&)> hook) { (void)hook; }

    virtual util::Task<std::vector<execution::LegQuote>> legQuotes(Rec contract, contract::AccountConfig account) = 0;
    virtual util::Task<execution::PlacementResult> place(QString recordId, parsing::validator::ApprovedOrder approved, std::optional<double> limitOverride) = 0;
    virtual util::Task<int> cancelAllOpen() = 0;

    /// typeof router.quoteCapability === "function"
    virtual bool hasQuoteCapability() const { return false; }
    /// 空 = 券商报得出价(TS 的 null)
    virtual std::optional<QString> quoteCapability(const QString& symbol) {
        (void)symbol;
        return std::nullopt;
    }
    virtual bool hasOptionQuotes() const { return false; }
    /// {持仓 key: {bid, ask}}
    virtual util::Task<Rec> optionQuotes(QList<Rec> rows) {
        (void)rows;
        co_return Rec::null();
    }
    /// typeof router.qualify === "function"(解析预热用)
    virtual bool hasQualify() const { return false; }
    virtual util::Task<> qualify(Rec contract, contract::AccountConfig account) {
        (void)contract;
        (void)account;
        co_return;
    }
    /// typeof router.modifyHosted === "function"
    virtual bool hasModifyHosted() const { return true; }
    /// refPrefix 空 = 没传参(券商侧默认 "trk:")
    virtual util::Task<QList<Rec>> listHostedOpenWith(std::optional<QString> refPrefix) = 0;
    util::Task<QList<Rec>> listHostedOpen() final { return listHostedOpenWith(std::nullopt); }

    virtual bool hasPollOrderUpdates() const { return false; }
    virtual util::Task<QList<PollUpdate>> pollOrderUpdates() { co_return QList<PollUpdate>{}; }
};

/// 真 router → EngineRouter。纯转发
class BrokerEngineRouter final : public EngineRouter {
public:
    explicit BrokerEngineRouter(std::shared_ptr<execution::BrokerRouter> router) : r_(std::move(router)) {}
    execution::BrokerRouter& broker_() { return *r_; }

    void setSessionHook(std::function<void(const SessionPtr&)> hook) override { r_->sessionHook = std::move(hook); }
    util::Task<std::vector<execution::LegQuote>> legQuotes(Rec contract, contract::AccountConfig account) override {
        return r_->legQuotes(std::move(contract), std::move(account));
    }
    util::Task<execution::PlacementResult> place(QString recordId, parsing::validator::ApprovedOrder approved, std::optional<double> limitOverride) override {
        return r_->place(std::move(recordId), std::move(approved), limitOverride);
    }
    util::Task<int> cancelAllOpen() override { return r_->cancelAllOpen(); }
    bool hasQuoteCapability() const override { return true; }
    std::optional<QString> quoteCapability(const QString& symbol) override { return r_->quoteCapability(symbol); }
    bool hasOptionQuotes() const override { return true; }
    util::Task<Rec> optionQuotes(QList<Rec> rows) override { return r_->optionQuotes(std::move(rows)); }
    bool hasQualify() const override { return true; }
    util::Task<> qualify(Rec contract, contract::AccountConfig account) override { return qualifyImpl(std::move(contract), std::move(account)); }
    util::Task<QList<Rec>> listHostedOpenWith(std::optional<QString> refPrefix) override {
        return refPrefix ? r_->listHostedOpen(*refPrefix) : r_->listHostedOpen();
    }

    // ---- 共用
    util::Task<QList<Rec>> positions() override { return r_->positions(); }
    util::Task<std::optional<double>> indexPrice(const QString& symbol) override { return r_->indexPrice(symbol); }
    bool hasSpotInfo() const override { return true; }
    std::optional<util::OJson> spotInfo(const QString& symbol) override { return r_->spotInfo(symbol); }
    // ---- HostedRouter
    bool supportsHostedClose() const override { return execution::BrokerRouter::kSupportsHostedClose; }
    std::optional<QSet<QString>> coveredAccounts() override {
        const QStringList l = r_->coveredAccounts();
        return QSet<QString>(l.begin(), l.end());
    }
    util::Task<execution::HostedPlacement> placeHosted(contract::AccountConfig account, Rec contractSpec, Rec item, QString ocaGroup, QString orderRef) override {
        return r_->placeHosted(std::move(account), std::move(contractSpec), std::move(item), std::move(ocaGroup), std::move(orderRef));
    }
    util::Task<bool> modifyHosted(qint64 orderId, Rec item) override { return r_->modifyHosted(static_cast<int>(orderId), std::move(item)); }
    util::Task<bool> cancelHosted(qint64 orderId) override { return r_->cancelHosted(static_cast<int>(orderId)); }
    // ---- ReconcileRouter
    bool hasListOpenOrdersDetailed() const override { return true; }
    util::Task<QList<Rec>> listOpenOrdersDetailed() override { return r_->listOpenOrdersDetailed(); }
    std::optional<QSet<QString>> coveredAccountIds() override {
        const QStringList l = r_->coveredAccountIds();
        return QSet<QString>(l.begin(), l.end());
    }
    bool hasExecutions() const override { return true; }
    util::Task<QList<Rec>> executions() override { return r_->executions(); }
    // ---- SpotRouter
    bool hasStreamQuotes() const override { return true; }
    util::Task<util::OJson> streamQuotes(const QStringList& symbols) override { return r_->streamQuotes(symbols); }
    // ---- HoursRouter
    bool hasContractHours() const override { return true; }
    util::Task<std::optional<ContractHours>> contractHours(const util::OJson& row, const contract::AccountConfig& account) override {
        return r_->contractHours(row, account);
    }
    bool hasCachedContractHours() const override { return true; }
    std::optional<ContractHours> cachedContractHours(const QString& symbol, const QString& expiry) override { return r_->cachedContractHours(symbol, expiry); }
    // ---- AccountGuardRouter
    execution::SessionList sessions() override { return r_->sessions(); }
    QString broker() const override { return execution::BrokerRouter::kBroker; }
    // ---- WakeRouter
    bool hasConnectedNames() const override { return true; }
    QStringList connectedNames() override { return r_->connectedNames(); }
    int sessionCount() override { return static_cast<int>(r_->sessions().size()); }

private:
    util::Task<> qualifyImpl(Rec contract, contract::AccountConfig account) {
        co_await r_->qualify(std::move(contract), std::move(account));
    }
    std::shared_ptr<execution::BrokerRouter> r_;
};

/// engine.ts 的 ParserLike(providers 的 Parser 即符合,见 adaptParser)
class EngineParser {
public:
    virtual ~EngineParser() = default;
    virtual util::Task<parsing::providers::LLMResponse> parse(parsing::prompts::PromptBundle bundle, QString userMessage) = 0;
};
std::shared_ptr<EngineParser> adaptParser(std::shared_ptr<parsing::providers::Parser> parser);

/// 引擎直接用到的交易库方法 = EngineStore(各子模块用的)+ 校验与保护规则从库里现算的三样(TS 的 store.risk.xxx / store.recentCloses / store.realizedPnlEvents)。
/// 接口隔一层是为了调用顺序能被记录(测试给它套一层记录器)
class CoreStore : public EngineStore {
public:
    virtual QList<Rec> recentOrderDetails(double windowMinutes, double nowMs) = 0;
    virtual QList<Rec> recentCloses(double sinceMs, double nowMs) = 0;
    virtual QList<Rec> realizedPnlEvents(double sinceMs, double nowMs) = 0;
};
std::unique_ptr<CoreStore> makeCoreStorePort(domain::TradeStore& store);

/// 追踪相关的一切改动(每一轮盯盘、建 / 改 / 删追踪、立即平仓)排成一队,绝不并发。
/// RPC 层建一把、交给每一个引擎实例(engine.sharedTrackerLock):引擎会随连接 / 改配置重建,锁必须跨实例同一把。
/// 与 TS 的差别:JS 的 `chain.then(fn)` 总让一拍才跑 fn;这里链空着时 fn 同步开始(util/task.h 的规矩)
class TrackerLock {
public:
    template <class T>
    util::Task<T> run(std::function<util::Task<T>()> fn) {
        util::Task<T> me = runAfter<T>(chain_, std::move(fn));
        // 队里的下一个在"调用方接着往下跑"之后才开始(JS:`run.then(…)` 比 `await run` 多一拍)——所以用完成回调(排在等它的协程之后)放行,不用另一个等它的协程
        util::Deferred<> next;
        me.onDone([next]() mutable { next.resolve(); });
        chain_ = next.task();
        return me;
    }

private:
    template <class T>
    static util::Task<T> runAfter(util::Task<> prev, std::function<util::Task<T>()> fn) {
        try {
            co_await prev;
        } catch (...) {
        }
        if constexpr (std::is_void_v<T>) co_await fn();
        else co_return co_await fn();
    }
    util::Task<> chain_ = util::Task<>::resolved();
};

}  // namespace ibkr::orchestrate
