// events / intel / follow 三个 handler(handlers2 簇)对着 TS 原类现跑的答案:回执、每一次 service 替身调用的方法与参数、库里变了的表。
// 夹具:fixtures/h2_small.json(gen_h2_small.mjs);世界:h2_world.h / h2_world.mjs。
#include "h2_world.h"

using namespace Qt::StringLiterals;

namespace {

/// 只为造 handler 用(构造时不碰接口);谁调了就是 bug
class NullPorts : public ibkr::rpc::Handlers2Ports {
public:
    ibkr::domain::TradeStore& store() override { qFatal("NullPorts"); }
    std::shared_ptr<ibkr::rpc::HandlerRouter> router() override { qFatal("NullPorts"); }
    std::shared_ptr<ibkr::parsing::providers::Parser> parser(const ibkr::contract::LLMConfig&) override { qFatal("NullPorts"); }
    ibkr::rpc::PoolOps& pool() override { qFatal("NullPorts"); }
    ibkr::rpc::AlertsOps& alerts() override { qFatal("NullPorts"); }
    ibkr::rpc::AnomalyOps& anomaly() override { qFatal("NullPorts"); }
    ibkr::rpc::EventsOps& events() override { qFatal("NullPorts"); }
    ibkr::rpc::IntelOps& intel() override { qFatal("NullPorts"); }
    ibkr::rpc::FollowOps& follow() override { qFatal("NullPorts"); }
    ibkr::rpc::MarketOps& market() override { qFatal("NullPorts"); }
    ibkr::rpc::TradeHistoryOps& tradeHistory() override { qFatal("NullPorts"); }
    ibkr::rpc::SimilarContextOps& similarContext() override { qFatal("NullPorts"); }
    ibkr::rpc::StockTripsOps& stockTrips() override { qFatal("NullPorts"); }
    ibkr::rpc::FillSyncOps& fillSync() override { qFatal("NullPorts"); }
    ibkr::rpc::IdeaSemanticOps& ideaSemantic() override { qFatal("NullPorts"); }
    ibkr::rpc::FlyPlannerOps& flyPlanner() override { qFatal("NullPorts"); }
    ibkr::rpc::IvRecorderOps& ivRecorder() override { qFatal("NullPorts"); }
    ibkr::rpc::PlaybookOps& playbook() override { qFatal("NullPorts"); }
};

}  // namespace

class TstH2Small : public QObject {
    Q_OBJECT
private slots:
    /// makeHandlers2 登记的方法名与次序,和 TS 十一个域的 methods() 一模一样(少一个界面就多一个"未知方法")
    void methodTableMatchesTs() {
        const h2w::OJson fx = jsfix::load(u"h2_small.json"_s);
        QStringList want;
        for (const h2w::OJson& m : fx.get(u"methods"_s)->items) want << m.s;
        NullPorts ports;
        h2w::H2Context ctx(nullptr);
        QStringList got;
        for (const auto& h : ibkr::rpc::makeHandlers2(ctx, ports))
            for (const auto& entry : h->methods()) got << entry.first;
        QCOMPARE(got, want);
    }

    void scenarios() {
        const QStringList failures = h2w::replayFixture(u"h2_small.json"_s);
        QVERIFY2(failures.isEmpty(), qPrintable(failures.join(u"\n"_s)));
    }
};

QTEST_GUILESS_MAIN(TstH2Small)
#include "tst_h2_small.moc"
