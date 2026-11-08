// 下单时延模拟:从"指令进引擎"到"订单的字节落到 TWS 的 socket 上"(那一刻起 IBKR 就认得这张单)要多久,每一段各花多少。
//
// 上面是真的 TradingEngine(本地速记、校验、落库)+ BrokerRouter + IbApiNextSession + ApiNext(编码、限速、订阅表),
// 下面是 sim_tws.h 的会回话的假 TWS,按一份时延表回话(真钟、真 QTimer)。大模型换成一个按固定时长回话的替身。
//
// 几个"交易员"各有各的写法(personas),每人连下两单:第一单是当天头一回碰这个到期日(合约时段、合约号都没缓存),
// 第二单换了行权价(时段有缓存,合约号没有)——这是每天实际发生最多的两种。每个人一份新的引擎与连接,连接先连好、
// SPX 的常驻行情先订上(软件开着时本来就是这样)。
//
// 时延表(SimProfile)的量级:合约详情要到 IBKR 服务器往返,用户的 TWS 走代理(198.18.x),按 250 ms 一条算;
// 本机直连的按 80 ms 再跑一遍。期权订阅后第一笔买卖价 350 ms,下一个订单号 3 ms(TWS 本机答)。这些是设定不是实测,
// 结论只看"同一份设定下改之前、改之后差多少",以及哪一段占了大头;真机的数以主日志里的 `[order] 指令时延` 为准。
//
// 断言(预算)只卡结构性的东西:N 条腿的合约确认不能是 N 次串行往返、AUTO_MID 不能多等一个轮询周期……
// 预算按时延表算出来再留余量,不是拿某一次跑出来的数抄上去。SIM_REPORT=<文件> 时把每一单的分段写成 JSON。
#include "domain/config.h"
#include "domain/store.h"
#include "execution/broker.h"
#include "execution/ib_session.h"
#include "js_fixture.h"
#include "orchestrate/engine.h"
#include "orchestrate/engine_router.h"
#include "sim_tws.h"
#include "util/js_runtime.h"
#include "util/jsformat.h"
#include "util/notify.h"

#include <QElapsedTimer>
#include <QFile>
#include <QTemporaryDir>
#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using util::OJson;
using util::Task;
namespace js = util::js;
namespace orch = ibkr::orchestrate;

namespace {

/// 美东 2026-11-04 周三 10:30(冬令时)
constexpr double kRth = 1793806200000.0;

template <class T>
T wait(Task<T> t, int limitMs = 20000) {
    QElapsedTimer clock;
    clock.start();
    while (!t.done() && clock.elapsed() < limitMs) QCoreApplication::processEvents(QEventLoop::AllEvents, 1);
    if (!t.done()) qFatal("协程没跑完");
    return t.result();
}

/// 大模型替身:按固定时长回一张 SPX 单腿看涨(行权价从指令里认 6900 / 6910)
class SimLlm : public orch::EngineParser {
public:
    int delayMs = 2200;
    int calls = 0;
    Task<parsing::providers::LLMResponse> parse(parsing::prompts::PromptBundle bundle, QString) override {
        const double strike = calls++ == 0 ? 6900 : 6910;
        co_await util::sleepMs(delayMs);
        const OJson order = js::object(
            {{u"intent_summary"_s, js::S(u"买 1 张 SPX %1C 限价 3"_s.arg(strike))},
             {u"contract"_s, js::object({{u"secType"_s, js::S(u"OPT"_s)}, {u"symbol"_s, js::S(u"SPX"_s)}, {u"exchange"_s, js::S(u"SMART"_s)},
                                        {u"currency"_s, js::S(u"USD"_s)}, {u"lastTradeDateOrContractMonth"_s, js::S(u"20261104"_s)},
                                        {u"strike"_s, js::N(strike)}, {u"right"_s, js::S(u"C"_s)}, {u"multiplier"_s, js::S(u"100"_s)},
                                        {u"tradingClass"_s, js::S(u"SPXW"_s)}})},
             {u"execution_type"_s, js::S(u"IMMEDIATE"_s)},
             {u"trigger"_s, js::Null()},
             {u"account"_s, js::S(u"DEFAULT"_s)},
             {u"order"_s, js::object({{u"action"_s, js::S(u"BUY"_s)}, {u"orderType"_s, js::S(u"LMT"_s)}, {u"totalQuantity"_s, js::N(1)},
                                     {u"price_mode"_s, js::S(u"EXPLICIT"_s)}, {u"lmtPrice"_s, js::N(3)}, {u"tif"_s, js::S(u"DAY"_s)},
                                     {u"outsideRth"_s, js::B(false)}})},
             {u"reason"_s, js::S(u"模拟"_s)},
             {u"confidence"_s, js::N(0.99)},
             {u"warnings"_s, js::array()}});
        parsing::providers::LLMResponse r;
        r.text = util::stringifyOJson(js::object({{u"orders"_s, js::array({order})}, {u"rejections"_s, js::array()}}), 0);
        r.model = js::S(u"sim"_s);
        r.prompt_version = bundle.version;
        r.prompt_fingerprint = parsing::prompts::fingerprint(bundle);
        r.latency_ms = delayMs;
        r.usage = js::object();
        co_return r;
    }
};

QString fmt(double ms) { return util::jsNumberToString(util::jsRound(ms)); }

/// 一个交易员:名字、两条指令(第一单 / 第二单)
struct Persona {
    QString key, who;
    QString first, second;
};

const QList<Persona>& personas() {
    static const QList<Persona> list{
        {u"fly_px"_s, u"蝶式快手(写了价)"_s, u"1.8 挂15蝴蝶 15CM"_s, u"1.6 挂25蝴蝶 15CM"_s},
        {u"fly_mid"_s, u"蝶式(中间价)"_s, u"挂35蝴蝶 10CM"_s, u"挂45蝴蝶 10CM"_s},
        {u"credit"_s, u"卖价差"_s, u"6870 6875 bear call -2"_s, u"6880 6885 bear call -2"_s},
        {u"iron_mid"_s, u"铁蝶(中间价)"_s, u"6800铁蝶 25cm"_s, u"6810铁蝶 25cm"_s},
        {u"stock"_s, u"股票限价"_s, u"213买入be20股"_s, u"150买入intc20股"_s},
        {u"llm"_s, u"自然语言(大模型)"_s, u"买一张spx今天6900的call 限价3块"_s, u"买一张spx今天6910的call 限价3块"_s},
    };
    return list;
}

/// 一单的结果
struct Run {
    QString persona, which;
    double engineMs = 0;   // handleInstruction 整趟
    double toBrokerMs = -1;  // 进引擎 → placeOrder 的字节落到 socket
    QList<QPair<QString, double>> stages;
    QString parseKind;
    int contractDetails = 0, mktData = 0, reqIds = 0;
    int submitted = 0, rejected = 0;
    QStringList rejections;
};

class Rig {
public:
    explicit Rig(const sim::SimProfile& profile) {
        util::setDateNowForTests([] { return kRth; });
        domain::setClock(kRth);
        world.profile = profile;
        const OJson fx = jsfix::load(u"engine_core.json"_s);
        OJson base = jsfix::dec(*fx.get(u"base"_s));
        base.set(u"storage"_s, js::object({{u"db_path"_s, js::S(dir.path() + u"/sim.db"_s)}}));
        // 用户真实配置里的单笔限额(settings.json 的 limits)
        OJson limits = *base.get(u"limits"_s);
        limits.set(u"max_order_notional"_s, js::N(5000));
        limits.set(u"max_option_contracts"_s, js::N(5));
        base.set(u"limits"_s, limits);
        settings = domain::fromDict(base);
        broker = std::make_shared<execution::BrokerRouter>(settings, [this](execution::SessionConfig cfg) {
            execution::IbSessionDeps deps;
            deps.sockets = sim::simSockets(&world);
            deps.log = [](const QString&) {};
            return execution::createIbApiNextSession(std::move(cfg), std::move(deps));
        });
        orch::EngineArgs a;
        a.settings = settings;
        a.parser = llm;
        a.router = std::make_shared<orch::BrokerEngineRouter>(broker);
        parsing::prompts::PromptBundle bundle;
        bundle.version = u"sim"_s;
        bundle.system_text = u"system"_s;
        bundle.user_template = u"{instruction}"_s;
        a.bundle = bundle;
        a.notifier = std::make_shared<util::Notifier>(false, std::vector<util::Notifier::Sink>{});
        engine = std::make_unique<orch::TradingEngine>(std::move(a));
        engine->setTimerHook([](int ms, std::function<void()> fn) { QTimer::singleShot(ms, std::move(fn)); });
        // 软件开着时的样子:连接已经连上,SPX 的常驻行情已经订上
        wait(broker->indexPrice(u"SPX"_s));
    }
    ~Rig() {
        engine.reset();
        wait(broker->disconnectAll());
        broker.reset();
        util::setDateNowForTests({});
        domain::setClock(std::nullopt);
    }

    Run submit(const QString& persona, const QString& which, const QString& text) {
        world.reset();
        QElapsedTimer t;
        t.start();
        const orch::EngineResult r = wait(engine->handleInstruction(text, u"manual"_s, domain::etNowFromEpoch(kRth), std::nullopt, std::nullopt, false));
        Run run;
        run.persona = persona;
        run.which = which;
        run.engineMs = double(t.nsecsElapsed()) / 1e6;
        if (!world.placedAtMs.isEmpty()) run.toBrokerMs = world.placedAtMs.last();
        if (qEnvironmentVariableIsSet("SIM_TRACE"))
            for (const sim::SimRequest& q : world.requests)
                qInfo().noquote() << u"    %1 ms  "_s.arg(fmt(q.atMs), 5) + q.fields.mid(0, 9).join(u'|');
        run.stages = r.timing;
        run.parseKind = r.parseKind;
        run.contractDetails = world.count(sim::out::kReqContractData);
        run.mktData = world.count(sim::out::kReqMktData);
        run.reqIds = world.count(sim::out::kReqIds);
        run.submitted = int(r.submitted.size());
        run.rejected = int(r.rejections.size());
        for (const OJson& x : r.rejections) run.rejections << js::str(x.get(u"code"_s)) + u":"_s + js::str(x.get(u"message"_s));
        return run;
    }

    QTemporaryDir dir;
    sim::SimWorld world;
    domain::Settings settings;
    std::shared_ptr<SimLlm> llm = std::make_shared<SimLlm>();
    std::shared_ptr<execution::BrokerRouter> broker;
    std::unique_ptr<orch::TradingEngine> engine;
};

QString describe(const Run& r) {
    QStringList parts;
    for (const auto& [stage, ms] : r.stages) parts << stage + u' ' + fmt(ms);
    return u"%1 %2 | 到券商 %3 ms | 引擎 %4 ms | 合约详情 %5 行情 %6 订单号 %7 | %8"_s.arg(r.persona, -8)
        .arg(r.which, -2)
        .arg(fmt(r.toBrokerMs), 5)
        .arg(fmt(r.engineMs), 5)
        .arg(r.contractDetails)
        .arg(r.mktData)
        .arg(r.reqIds)
        .arg(parts.join(u" · "_s));
}

OJson toJson(const Run& r, const QString& profile) {
    OJson stages = js::array();
    for (const auto& [stage, ms] : r.stages) stages.items.append(js::object({{u"stage"_s, js::S(stage)}, {u"ms"_s, js::N(util::jsRound(ms))}}));
    return js::object({{u"profile"_s, js::S(profile)},
                       {u"persona"_s, js::S(r.persona)},
                       {u"which"_s, js::S(r.which)},
                       {u"to_broker_ms"_s, js::N(util::jsRound(r.toBrokerMs))},
                       {u"engine_ms"_s, js::N(util::jsRound(r.engineMs))},
                       {u"parse"_s, js::S(r.parseKind)},
                       {u"contract_details"_s, js::N(r.contractDetails)},
                       {u"mkt_data"_s, js::N(r.mktData)},
                       {u"req_ids"_s, js::N(r.reqIds)},
                       {u"stages"_s, stages}});
}

}  // namespace

class TstOrderLatency : public QObject {
    Q_OBJECT

    QList<QPair<QString, Run>> all_;

    QList<Run> runProfile(const sim::SimProfile& profile) {
        QList<Run> runs;
        for (const Persona& p : personas()) {
            Rig rig(profile);
            if (p.key == u"llm"_s) rig.llm->delayMs = 2200;
            for (const auto& [which, text] : {std::pair{u"首单"_s, p.first}, std::pair{u"次单"_s, p.second}}) {
                const Run r = rig.submit(p.key, which, text);
                qInfo().noquote() << u"[%1] "_s.arg(profile.name) + describe(r);
                if (!r.rejections.isEmpty()) qInfo().noquote() << u"    拒:"_s + r.rejections.join(u";"_s);
                runs << r;
                all_ << QPair<QString, Run>{profile.name, r};
            }
        }
        return runs;
    }

    static const Run& find(const QList<Run>& runs, const QString& persona, const QString& which) {
        for (const Run& r : runs)
            if (r.persona == persona && r.which == which) return r;
        qFatal("没有这一单");
    }

private slots:
    void proxyProfile() {
        sim::SimProfile p;  // 缺省:走代理
        const QList<Run> runs = runProfile(p);
        // 每一单都得真的发出去
        for (const Run& r : runs) {
            QVERIFY2(r.submitted == 1 && r.rejected == 0, qPrintable(r.persona + u" "_s + r.which + u":"_s + r.rejections.join(u";"_s)));
            QVERIFY2(r.toBrokerMs > 0, qPrintable(r.persona + u" 没有 placeOrder"_s));
        }
    }

    void localProfile() {
        if (qEnvironmentVariableIsEmpty("SIM_ALL")) QSKIP("本机直连那一份只在 SIM_ALL=1 时跑");
        sim::SimProfile p;
        p.name = u"local"_s;
        p.contractDetailsMs = 80;
        p.optionFirstTickMs = 200;
        p.indexFirstTickMs = 80;
        const QList<Run> runs = runProfile(p);
        for (const Run& r : runs) QVERIFY(r.submitted == 1);
    }

    void cleanupTestCase() {
        const QString path = qEnvironmentVariable("SIM_REPORT");
        if (path.isEmpty()) return;
        OJson out = js::array();
        for (const auto& [profile, r] : all_) out.items.append(toJson(r, profile));
        QFile f(path);
        if (f.open(QIODevice::WriteOnly | QIODevice::Truncate)) f.write(util::stringifyOJson(out, 1).toUtf8());
    }
};

QTEST_GUILESS_MAIN(TstOrderLatency)
#include "tst_order_latency.moc"
