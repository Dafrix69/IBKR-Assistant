#include "orchestrate/services/svc_host.h"

namespace ibkr::orchestrate {

namespace {

class BrokerRouterPort : public RouterPort {
public:
    explicit BrokerRouterPort(std::shared_ptr<execution::BrokerRouter> r) : r_(std::move(r)) {}
    bool hasSessions() override { return !r_->sessions().empty(); }
    util::Task<QList<util::OJson>> positions() override { return r_->positions(); }
    util::Task<util::OJson> streamQuotes(QStringList symbols) override { return r_->streamQuotes(std::move(symbols)); }
    util::Task<util::OJson> stockQuotes(QStringList symbols) override { return r_->stockQuotes(std::move(symbols)); }
    util::Task<std::optional<double>> indexPrice(QString symbol) override { return r_->indexPrice(std::move(symbol)); }
    std::optional<util::OJson> spotInfo(const QString& symbol) override { return r_->spotInfo(symbol); }
    bool upstreamOk() override { return r_->upstreamOk(); }
    std::shared_ptr<execution::IbSession> marketSession() override { return r_->marketSession(); }
    util::Task<util::OJson> optionChain(QString symbol, std::optional<QString> expiry, double width, std::optional<double> span, QString preferClass) override {
        return r_->optionChain(std::move(symbol), std::move(expiry), width, span, std::move(preferClass));
    }
    util::Task<QList<util::OJson>> historicalBars(QString symbol, QString start, QString end) override {
        return r_->historicalBars(std::move(symbol), std::move(start), std::move(end));
    }
    util::Task<execution::TaggedBars> intradayBars(QString symbol, QString timeframe, bool rth, std::optional<QString> endDay, bool indexProxy) override {
        return r_->intradayBars(std::move(symbol), std::move(timeframe), rth, std::move(endDay), indexProxy);
    }

private:
    std::shared_ptr<execution::BrokerRouter> r_;
};

}  // namespace

std::shared_ptr<RouterPort> adaptBrokerRouter(std::shared_ptr<execution::BrokerRouter> router) {
    if (!router) return nullptr;
    return std::make_shared<BrokerRouterPort>(std::move(router));
}

}  // namespace ibkr::orchestrate
