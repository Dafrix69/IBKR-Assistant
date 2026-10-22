// services/ 第一批(svc1 簇:follow.ts / alerts.ts / anomaly.ts / playbook.ts)对宿主、引擎、router 的窄接口。
//
// TS 的 service 只认 ServiceHost 的四样;orchestrate/host.h 里 Router 与 TradingEngine 是不透明类型,svc_host.h(svc2 簇)又把其余 service
// 要的几面定成了窄接口(SvcHost / SvcEngine / RouterPort / NotifierPort / SvcRuntime)。这四个 service 还要几样那里没有的,都收在这一个头里,
// 搬引擎的人照着实现(报告里有清单):
//
//   Svc1Host       = SvcHost + stderrLine() + svc1Engine()。宿主的实现类同时实现它(TS 的 rpc/server.ts)。
//   Svc1Engine     TradingEngine 被这四个 service 用到的面:库(domain::TradeStore,具体类)、通知(多一个 os 开关)、熔断状态、
//                  本地速记 / handleInstruction / resolveFanoutAccounts / orderLegId(engine.ts 与 engine/*.ts,未搬)。
//   Svc1Router     RouterPort 之外的三样(异动的量能流、跟单的 coveredAccounts);RouterPort 的实现类同时实现它,
//                  取不到(dynamic_cast 失败)按"这个 router 没有这个方法"处理——TS 里是 `typeof router.x === "function"` / `SUPPORTS_VOLUME_QUOTES`。
//   MarketDataPort services/marketData.ts 的 MarketDataService 被价位提醒与剧本用到的四个方法(svc2 簇搬它;它的类同时继承这个接口即可)。
//   MarksPort      optionMarks.ts 的 OptionMarkStreams.read(execution::OptionMarkStreams 同签名;薄转发)。
//
// 约定同 svc_host.h:service 每次用到都现取 settings / router / engine,不存;时间用 util::dateNow() 与 domain::nowEt()(测试换钟),
// 计时器用 runtime().setTimeout(测试换虚拟钟)。
#pragma once

#include "domain/config.h"
#include "domain/store.h"
#include "execution/option_marks.h"
#include "orchestrate/services/svc_host.h"
#include "parsing/shorthand.h"
#include "util/ordered_json.h"
#include "util/task.h"

#include <QList>
#include <QString>
#include <QStringList>

#include <cstdio>
#include <map>
#include <memory>
#include <optional>
#include <vector>

namespace ibkr::orchestrate {

/// engine.killswitch.state() 里跟单读的两样:engaged 与 String(reason ?? "")
struct BreakerView {
    bool engaged = false;
    QString reason;
};

/// handleInstruction 的调用方说明。localOnly = 跟单那一趟(TS 的 followScope.run(true, …)):这一趟里**任何**对大模型解析器的调用必须当场抛
/// FollowLocalOnlyError(follow_service.h),引擎不把它算解析失败、不碰熔断,原样抛回。手动指令不带这个标记,不受影响——
/// TS 用 AsyncLocalStorage 认调用链而不是共享开关,所以两条路可以同时在跑;这里每个调用自己带标记,同样是"按调用"而不是"按进程"。
struct InstructionScope {
    bool localOnly = false;
};

/// 跟单读到的现价表 {代码: 现价}(TS 的 Record<string, number>,键序 = 写入的先后)
using PriceSnap = util::OJson;

/// TradingEngine 被这四个 service 用到的那几面
class Svc1Engine {
public:
    virtual ~Svc1Engine() = default;
    virtual domain::TradeStore& store() = 0;
    /// engine.notifier.notify(title, body, subtitle[, {os}]):os = false 只进通知流(价位与异动提醒由桌面端的置顶小窗弹)
    virtual void notify(const QString& title, const QString& body, const QString& subtitle, bool os) = 0;
    /// engine.killswitch.state()
    virtual BreakerView breaker() = 0;
    /// tryLocalShorthand(engine, text, snap, at, meta)(engine/localShorthand.ts):本地速记解析一遍,snap 是出参(取到的现价),
    /// meta.set / relativeCenter 是出参;没接住回 null(OJson::Null)。不碰大模型
    virtual util::Task<util::OJson> tryLocalShorthand(QString text, PriceSnap& snap, domain::EtNow at, parsing::shorthand::ShorthandMeta& meta) = 0;
    /// engine.handleInstruction(text, "discord", at, snap, accounts, false):校验、限额、重复单、保护规则、熔断、落库一样不少。
    /// 返回 InstructionSubmitResult(松的 JSON:submitted / queued / validated_only / rejections / warnings / llm)。
    /// 第 6 个参数 TS 里是字面量 false(dryRun),原样留在签名里
    virtual util::Task<util::OJson> handleInstruction(QString text, QString channel, domain::EtNow at, PriceSnap snap, QStringList accounts, bool dryRun,
                                                      InstructionScope scope) = 0;
    /// engine.ts 的 resolveFanoutAccounts(settings, names):名字 → 账户别名表;不合规抛 JsError(话原样进日志)
    virtual QStringList resolveFanoutAccounts(const domain::Settings& settings, const QStringList& names) = 0;
    /// engine/closing.ts 的 orderLegId({ contract }):这张单的腿身份(追踪的 leg 键)
    virtual QString orderLegId(const util::OJson& contract) = 0;
};

/// router 上 RouterPort(svc_host.h)没有的三样。RouterPort 的实现类同时实现它
class Svc1Router {
public:
    virtual ~Svc1Router() = default;
    /// router.SUPPORTS_VOLUME_QUOTES === true(IBKR 为真;富途不移植)
    virtual bool supportsVolumeQuotes() = 0;
    /// router.volumeQuotes(symbols):{代码: VolumeSnapshot & {error?}}
    virtual util::Task<util::OJson> volumeQuotes(QStringList symbols) = 0;
    /// router.releaseVolumeStreams(keep):撤掉不在 keep 里的量能流,回撤了几条
    virtual int releaseVolumeStreams(QStringList keep) = 0;
    /// router.coveredAccounts?.():哪些账户有会话管着;router 没有这个方法回空
    virtual std::optional<QStringList> coveredAccounts() = 0;
};

class Svc1Host : public SvcHost {
public:
    virtual Svc1Engine& svc1Engine() = 0;
    /// process.stderr.write(line + "\n")——观察得到的行为(异动的"只在变了的那一轮记一行"),测试接过来看。缺省写 stderr
    virtual void stderrLine(const QString& line) { std::fprintf(stderr, "%s\n", line.toUtf8().constData()); }
    /// router 的 Svc1Router 面;没连券商或这个 router 没有这一面是空
    std::shared_ptr<Svc1Router> svc1Router() const { return std::dynamic_pointer_cast<Svc1Router>(routerPort()); }
};

/// services/marketData.ts 的 SpotQuote
struct SpotQuote {
    double price = 0;
    /// 这个价是几点成交的(秒)
    std::optional<double> tradedAt;
    /// index / futures / index_stale / 空串(个股)
    QString source;
};

class MarketDataPort {
public:
    virtual ~MarketDataPort() = default;
    /// 一份期权墙(OptionWall,松的 JSON)。width 缺省 10;span / preferClass 只有剧本给。取不到抛 RpcError(-32017 …)
    virtual util::Task<util::OJson> wallFor(QString symbol, std::optional<QString> expiry, double width = 10, std::optional<double> span = std::nullopt,
                                            QString preferClass = {}) = 0;
    virtual util::Task<std::optional<double>> spotOf(QString symbol) = 0;
    /// 日线历史(券商的 K 线行)
    virtual util::Task<QList<util::OJson>> dailyHistory(QString symbol) = 0;
    /// 一轮的价一次取齐;每个代码都有一项(取不到是空)
    virtual util::Task<std::map<QString, std::optional<SpotQuote>>> quotesOf(QStringList symbols) = 0;
};

class MarksPort {
public:
    virtual ~MarksPort() = default;
    virtual util::Task<std::vector<execution::OptionMark>> read(std::shared_ptr<execution::IbSession> session, std::vector<execution::OptionLegSpec> legs,
                                                                 bool delayedOk, double silentLimitMs) = 0;
    /// OptionMarkStreams.close():撤掉订着的腿、停清扫。serve() 收尾时调;没有可关的(测试替身)就什么都不做
    virtual void close() {}
};

/// 四个 service 共用的基类:ServiceBase 的 settings() / emitEvent() 照旧,再摊出 engine() / router() / rt() / log()
class Svc1Base : public ServiceBase {
protected:
    explicit Svc1Base(Svc1Host& host) : ServiceBase(host), sh_(host) {}
    Svc1Host& sh_;
    Svc1Engine& eng() { return sh_.svc1Engine(); }
    domain::TradeStore& store() { return sh_.svc1Engine().store(); }
    std::shared_ptr<RouterPort> routerPort() const { return sh_.routerPort(); }
    SvcRuntime& rt() { return sh_.runtime(); }
    void log(const QString& line) { sh_.stderrLine(line); }
};

}  // namespace ibkr::orchestrate
