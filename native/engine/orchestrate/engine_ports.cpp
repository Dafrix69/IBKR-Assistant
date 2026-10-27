#include "orchestrate/engine_ports.h"

#include "domain/store.h"
#include "util/error.h"

#include <cmath>

namespace ibkr::orchestrate {

namespace {

class StorePort final : public EngineStore {
public:
    explicit StorePort(domain::TradeStore& s) : s_(s) {}
    QList<Rec> listTracks() override { return s_.listTracks(); }
    std::optional<Rec> getTrack(const QString& id) override { return s_.getTrack(id); }
    bool updateTrack(const QString& id, const Rec& fields) override { return s_.updateTrack(id, fields); }
    void audit(const QString& actor, const QString& action, const Rec* detail) override { s_.audit(actor, action, detail); }
    QString createRecord(Rec& record) override { return s_.createRecord(record); }
    void markSubmitIntent(const QString& id) override { s_.markSubmitIntent(id); }
    void appendEvent(const QString& id, const QString& kind, const Rec& payload) override { s_.appendEvent(id, kind, payload); }
    void setFinalStatus(const QString& id, const QString& status, const std::optional<QString>& detail) override { s_.setFinalStatus(id, status, detail); }
    std::optional<Rec> getRecord(const QString& id) override { return s_.getRecord(id); }
    QList<Rec> listWorkingRecords(double maxAgeDays, double nowMs) override { return s_.listWorkingRecords(maxAgeDays, nowMs); }
    QList<Rec> fillsByOrderRef(const QString& ref) override { return s_.fillsByOrderRef(ref); }
    double rememberFills(const QList<Rec>& rows) override { return s_.rememberFills(rows); }
    QList<Rec> workingOrders(double sinceMs, double nowMs) override { return s_.risk().workingOrders(sinceMs, nowMs); }
    QList<Rec> dailyLossTrips(double sinceMs, double nowMs) override { return s_.risk().dailyLossTrips(sinceMs, nowMs); }

private:
    domain::TradeStore& s_;
};

class BreakerAdapter final : public BreakerPort {
public:
    explicit BreakerAdapter(util::KillSwitch& k) : k_(k) {}
    util::BreakerState state() override { return k_.state(); }

private:
    util::KillSwitch& k_;
};

}  // namespace

std::unique_ptr<EngineStore> makeStorePort(domain::TradeStore& store) { return std::make_unique<StorePort>(store); }
std::unique_ptr<BreakerPort> makeBreakerPort(util::KillSwitch& killSwitch) { return std::make_unique<BreakerAdapter>(killSwitch); }

namespace jsx {

QString errorMessage(std::exception_ptr e) {
    try {
        std::rethrow_exception(std::move(e));
    } catch (const util::JsError& x) {
        return x.message();
    } catch (const std::exception& x) {
        return QString::fromStdString(x.what());
    } catch (...) {
        return QString();
    }
}

double trunc(double x) { return std::trunc(x); }
double max(double a, double b) {
    if (std::isnan(a) || std::isnan(b)) return std::nan("");
    if (a == 0 && b == 0) return std::signbit(a) ? b : a;  // Math.max(-0, 0) 是 +0
    return a < b ? b : a;
}
double min(double a, double b) {
    if (std::isnan(a) || std::isnan(b)) return std::nan("");
    if (a == 0 && b == 0) return std::signbit(a) ? a : b;  // Math.min(0, -0) 是 -0
    return b < a ? b : a;
}

std::optional<qint64> idOf(const util::OJson* v) {
    const double n = trunc(numOr(v, 0));
    if (std::isnan(n) || n == 0) return std::nullopt;
    return static_cast<qint64>(n);
}

void assign(util::OJson& target, const util::OJson& source) {
    for (const auto& [k, v] : source.fields) target.set(k, v);
}

}  // namespace jsx

}  // namespace ibkr::orchestrate
