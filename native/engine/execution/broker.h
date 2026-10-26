// broker.ts 逐句搬:IBKR 下单层——BrokerRouter(连接与路由、行情与腿报价、期权链、下单、券商托管的止盈止损、持仓 / 成交 / 回报的读取)
// 与它上面的纯函数(AUTO_MID 限价、BAG 带符号限价、订单意图、盘口流动性、成交行……)。钱路径:订单从这里发出去。
// 期望值:tests/fixtures/gen_broker_pure.mjs(纯函数)、gen_broker_router.mjs / gen_broker_fuzz.mjs(原 BrokerRouter 对着脚本驱动的假会话现跑,
// 记下会话上被调用的每一次:方法、参数、虚拟时刻、先后),tests/tst_broker.cpp 把同样的脚本放给这里,逐项精确比较。
//
// 文件分工:broker.cpp = 纯函数;broker_session.cpp = 连接 / 路由 / 合约确认;broker_quotes.cpp = 行情、腿报价、K 线、期权链、盘口;
// broker_positions.cpp = 持仓 / 持仓行情 / 成交 / 合约时段;broker_orders.cpp = 下单、托管单。LegQuote / legMid / comboMidPrice / 跳动对齐 / BrokerError
// 仍在 broker_pricing.{h,cpp}(execsupport 簇搬的,这一簇接手;留在原处是为了不改别人的 cmake 片段),这里直接用。
//
// 与 TS 的对应与不同(交付报告里有同样的一份):
//   · ContractSpec / OrderSpec / TriggerSpec / HostedOrderPlan / 持仓行 / 量价快照 / 盘口快照 / 期权链……都是 JS 对象:OJson(键序同 TS 的对象字面量,
//     验证输出的键序就是对拍的内容)。ApprovedOrder 是 parsing/validator.h 的。
//   · Promise → util::Task;协程是 BrokerRouter 的成员函数,**BrokerRouter 必须活得比所有未完成的调用长**(同 TS 里闭包抓着 this)。
//     唯一的例外是后台暖机(warmIndexFutures)与会话上挂的回调:它们拿一个存活标志,路由先没了就放手。
//   · 指向调用方局部变量的指针(qualifyOrRaise 的合约、qualifyAllOrRaise 的合约表、fillPositionPrices 的行):调用方在 co_await 它,
//     栈帧在整个等待期间活着;TS 里同一份对象被原地改写(conId、market_price),这里照样要原地改,所以不收拷贝。
//   · `try { … } finally { … }`:finally 里的语句可能抛(会话的 reqMarketDataType),抛了就盖住 try 里的错——所以不用析构函数,
//     用 catch(...) 存下异常、跑完收尾、再重抛(同 TS 的次序)。
//   · TS 里 `session.x?.()` 的可选方法按 Cap 判有没有(见 ib_types.h)。
//   · setTimeout(3000) 只有暖机那一处:走 sleepHook(缺省 util::sleepMs),测试换成假钟——没有行为差别。
//   · 默认会话工厂:TS 动态 import ibSession.js;这里直接调 createIbApiNextSession。
#pragma once

#include "contract/config_types.h"
#include "contract/ordered_map.h"
#include "domain/config.h"
#include "execution/broker_pricing.h"
#include "execution/held_streams.h"
#include "execution/ib_bars.h"
#include "execution/ib_link.h"
#include "execution/ib_types.h"
#include "parsing/validator.h"
#include "util/ordered_json.h"
#include "util/task.h"

#include <QHash>
#include <QList>
#include <QSet>
#include <QString>
#include <QStringList>

#include <array>
#include <functional>
#include <memory>
#include <optional>
#include <utility>
#include <vector>

namespace ibkr::execution {

// ======================================================================
// 纯计算部分(黄金对拍钉死)
// ======================================================================

/// 组合的限价:贷方(SELL)取负。userLimit 空 = TS 的 null
std::optional<double> bagSignedLimit(const QString& action, std::optional<double> userLimit);
/// AUTO_MID 的限价:中间价 + 滑点,朝成交方向对齐到最小跳动;借方不超过结构宽度(strikeWidthValue 空 = null),贷方必须仍为负
double autoMidLimit(double netMid, const QString& action, double slippage, std::optional<double> strikeWidthValue = std::nullopt,
                    double tick = kDefaultComboTick);
/// 从盘口算流动性指标(book 是 Partial<BookSnapshot>:l1 / bids / asks)
util::OJson bookLiquidity(const util::OJson& book);
/// 报价字段清洗成可用数字:NaN / 非正 / 非数字都空。typed:行情流里的数;Js:`unknown` 的值(Number() 的规矩,空指针 = undefined)
std::optional<double> cleanPrice(std::optional<double> value);
std::optional<double> cleanPriceJs(const util::OJson* value);
/// 定价链路用:null / NaN / inf 一律 0
double finiteQuote(std::optional<double> value);
double finiteQuoteJs(const util::OJson* value);

/// 取盘口时值得告诉用户"为什么"的 IBKR 错误码
extern const QSet<int> kMdErrorCodes;
/// 把取盘口时 TWS 回的错误码翻成"下一步做什么"
QString quoteErrorMessage(const QString& symbol, const std::vector<std::pair<double, QString>>& errors);
/// AUTO_MID 借方限价的数学上限:垂直价差 = 行权价差;蝴蝶 = 翼宽;别的空
std::optional<double> strikeWidth(const util::OJson& contract);
/// trigger 描述成 PriceCondition 的参数:{symbol, secType, isMore, price}
/// 空指针 = TS 的 undefined(抛 TypeError 原话);JSON null 同样抛(null 的那句)
util::OJson priceConditionSpec(const util::OJson* trigger);
/// 按 orderType 构造订单意图;价格为空的限价单当场抛。spec 是 OrderSpec(OJson)
OrderIntent buildOrderIntent(const util::OJson& spec, const QString& accountId, std::optional<double> limitOverride = std::nullopt,
                             const std::optional<QString>& actionOverride = std::nullopt);

/// 方式 B:软件侧盯盘队列里的一条
struct PendingTrigger {
    QString record_id;
    parsing::validator::ApprovedOrder approved;
    util::OJson trigger;  // TriggerSpec
    QString created_at;
    bool fired = false;
};
bool shouldFire(const PendingTrigger& pending, double price);

/// 上一个已经收盘的常规时段:{日期, 收盘分钟}。往回两周都没有交易日抛 JsError(不是 BrokerError)
std::pair<QString, int> lastRthSession(const domain::EtNow& now, const domain::Settings& settings);
struct BasisMatch {
    double basis = 0;
    QString time;
    double index_close = 0, futures_close = 0;
};
struct TimedClose {
    QString time;
    double close = 0;
};
/// 指数与期货在同一分钟的收盘差,取两边都有的最后那一分钟;对不上回空
std::optional<BasisMatch> contemporaneousBasis(const std::vector<TimedClose>& indexBars, const std::vector<TimedClose>& futuresBars);
/// IBKR 成交时间字符串 → epoch 毫秒;解析不了回空。value 是 JS 的松散值(空指针 = undefined)
std::optional<double> parseIbTime(const util::OJson* value);
/// ib 的成交明细 → 成交行;没有 execId 回空。contract / execution 是 JS 对象(松散)
std::optional<util::OJson> fillRow(const util::OJson& contract, const util::OJson& execution);

// ======================================================================
// 连接与下单
// ======================================================================

struct PlacementResult {
    QString record_id;
    std::optional<int> order_id, perm_id;
    QString status;
    std::optional<double> limit_price;
    QString detailAccount;  // detail: {account}
};

struct HostedPlacement {
    std::optional<int> order_id, perm_id;
    QString status;
};

class BrokerRouter {
public:
    using SessionPtr = std::shared_ptr<IbSession>;

    /// 这个 router 说的是哪家券商的协议
    static inline const QString kBroker = QStringLiteral("ibkr");
    static constexpr bool kSupportsNativeConditions = true;
    static constexpr bool kSupportsVolumeQuotes = true;
    static constexpr bool kSupportsHostedClose = true;
    static constexpr int kQualifyTimeoutMs = 12'000;
    /// 组合各腿盘口最多等这么久——所有腿合计,不是每腿
    static constexpr int kQuoteWaitMs = 4'000;
    /// 异动监控订的 generic ticks
    static inline const QString kVolumeTicks = QStringLiteral("165,104,595");
    static constexpr double kVolumeRetryMs = 60'000;
    static constexpr int kChainMaxWidth = 15;
    static constexpr int kChainWaitMs = 4'000;

    /// settings 存一份拷贝(TS 里是同一个对象的引用;宿主换配置时重建 router,见 orchestrate/host.h)
    explicit BrokerRouter(domain::Settings settings, IbSessionFactory factory = {});
    ~BrokerRouter();
    BrokerRouter(const BrokerRouter&) = delete;
    BrokerRouter& operator=(const BrokerRouter&) = delete;

    domain::Settings settings;
    std::function<void(const SessionPtr&)> sessionHook;
    /// 某条连接断了(false)/ 自动重连回来了(true)
    std::function<void(const QString& connection, bool up)> linkHook;
    /// 暖机里隔三秒再试的那一等(缺省 util::sleepMs);测试换成假钟
    std::function<util::Task<>(int ms)> sleepHook;

    // ---- 连接
    contract::OrderedMap<contract::ConnectionConfig> connections() const;
    util::Task<SessionPtr> connect(QString connectionName);
    /// 常规时段之外,连上就在后台把期货推算暖起来;不等它、也不让它的失败冒出去
    void warmIndexFutures();
    bool upstreamOk() const;
    util::Task<> disconnectAll();
    /// 找到真正管理该账户的会话。路由永远以会话实况为准
    util::Task<SessionPtr> forAccount(contract::AccountConfig account);
    std::vector<SessionPtr> sessions();
    QStringList coveredAccounts();
    QStringList coveredAccountIds();
    QStringList connectedNames();
    SessionPtr marketSession();

    // ---- 合约
    /// contract 是 ContractSpec
    util::Task<IbContract> qualify(util::OJson contract, contract::AccountConfig account);
    /// contract 指向调用方的局部变量,原地写 conId(调用方在 co_await 它)
    util::Task<> qualifyOrRaise(SessionPtr session, IbContract* contract, bool wait = false);
    /// 常驻订阅合约的时段(只读缓存);没缓存回空
    std::optional<std::array<QString, 3>> cachedContractHours(const QString& symbol, const QString& expiry);
    /// row 是持仓行;拿不到回空
    util::Task<std::optional<std::array<QString, 3>>> contractHours(util::OJson row, contract::AccountConfig account);

    // ---- 行情
    util::Task<std::vector<LegQuote>> legQuotes(util::OJson contract, contract::AccountConfig account);
    std::optional<QString> quoteCapability(const QString& symbol) const;
    /// 最近一次 indexPrice 是怎么得来的;没有回空
    std::optional<util::OJson> spotInfo(const QString& symbol) const;
    util::Task<std::optional<double>> indexPrice(QString symbol);
    /// {symbol: {last, close, change_pct}}
    util::Task<util::OJson> earnings(QString symbol);
    util::Task<util::OJson> stockQuotes(QStringList symbols);
    /// 日线历史:每根 {date, open, high, low, close, volume}
    util::Task<QList<util::OJson>> historicalBars(QString symbol, QString start, QString end);
    /// {symbol: {last, close, change_pct, last_trade_at}}
    util::Task<util::OJson> streamQuotes(QStringList symbols);
    /// {symbol: 量价快照(+ error)}
    util::Task<util::OJson> volumeQuotes(QStringList symbols);
    int releaseVolumeStreams(const QStringList& keep);
    util::Task<TaggedBars> intradayBars(QString symbol, QString timeframe, bool rth = false, std::optional<QString> endDay = std::nullopt,
                                        bool indexProxy = false);
    util::Task<util::OJson> optionExpiries(QString symbol);
    util::Task<util::OJson> optionChain(QString symbol, std::optional<QString> expiry = std::nullopt, double width = 10,
                                        std::optional<double> span = std::nullopt, QString preferClass = {});
    util::Task<util::OJson> orderBook(QString symbol, int rows = 10);
    /// legs 是 JS 对象的数组;每根 {time, open, high, low, close}
    util::Task<QList<util::OJson>> comboBars(QString symbol, util::OJson legs, QString day, QString barSize = QStringLiteral("1 min"));

    // ---- 持仓与成交
    util::Task<QList<util::OJson>> positions();
    /// {持仓 key: {bid, ask}}
    util::Task<util::OJson> optionQuotes(QList<util::OJson> rows);
    /// 常驻行情流不是新订的那一轮让事件循环转几毫秒:生产 0(只转一圈)。对着 TS 夹具逐字比的券商场景换成 TS 版的 50;生产代码不调 set*ForTests
    static int heldStreamPumpMs();
    static void setHeldStreamPumpMsForTests(std::optional<int> ms);
    /// 同上,只读常驻订阅的缓存:不订、不等、同步回(推送回调里当场拼组合价,orchestrate/fast_exit)。没订过的腿给 null
    util::OJson optionQuotesNow(const QList<util::OJson>& rows);
    /// 期权行情来一笔推送就叫一下:各会话的 onOptionTick 并成一路(连上会话时接上)。回撤掉的函数
    std::function<void()> onOptionTick(std::function<void()> listener);
    util::Task<QList<util::OJson>> executions();

    // ---- 下单
    util::Task<PlacementResult> place(QString recordId, parsing::validator::ApprovedOrder approved, std::optional<double> limitOverride = std::nullopt);
    util::Task<int> cancelAllOpen();
    /// contractSpec 是 ContractSpec,item 是 HostedOrderPlan
    util::Task<HostedPlacement> placeHosted(contract::AccountConfig account, util::OJson contractSpec, util::OJson item, QString ocaGroup,
                                            QString orderRef);
    util::Task<bool> modifyHosted(int orderId, util::OJson item);
    util::Task<bool> cancelHosted(int orderId);
    util::Task<QList<util::OJson>> listHostedOpen(QString refPrefix = QStringLiteral("trk:"));
    util::Task<QList<util::OJson>> listOpenOrdersDetailed();

private:
    struct HostedEntry {
        SessionPtr session;
        IbContract contract;
        OrderIntent order;
    };
    struct FutStream {
        std::shared_ptr<TickerHandle> handle;
        IbContract target;
        double since = 0, lastOk = 0;
    };
    struct VolumeStream {
        IbContract target;
        std::shared_ptr<TickerHandle> handle;
        SessionPtr session;
    };

    // broker_session.cpp
    void cancelStreams();
    util::Task<> qualifyAllOrRaise(SessionPtr session, std::vector<IbContract>* opts);
    util::Task<QualifyKnown> qualifies(SessionPtr session, IbContract* contract);
    util::Task<IbContract> buildBag(SessionPtr session, util::OJson contract);
    QString stalledMessage() const;
    QString streamStatus(const QString& symbol, const QString& expiry);
    /// connectionsMap 的活迭代(JS 的 Map.values():遍历中新进的会话也会走到、被删的不走):取下一个还没走过的
    SessionPtr nextUnvisited(QSet<QString>& visited, QString* nameOut = nullptr);
    util::Task<> warmLoop(QStringList symbols, std::weak_ptr<bool> alive);

    // broker_quotes.cpp
    util::Task<SessionPtr> quoteSession();
    util::Task<std::optional<double>> officialPrice(SessionPtr session, QString symbol, std::optional<contract::IndexConfig> cfg);
    util::Task<std::optional<double>> streamPrice(SessionPtr session, QString streamKey, IbContract target);
    util::Task<std::optional<double>> futuresPrice(SessionPtr session, QString key, IbContract fut);
    util::Task<std::optional<util::OJson>> futuresSpot(SessionPtr session, contract::IndexConfig cfg, domain::EtNow now);
    QString basisFile() const;
    std::optional<util::OJson> loadBasis(const QString& key);
    void saveBasis(const QString& key, const util::OJson& row);

    // broker_positions.cpp
    std::optional<util::OJson> positionRow(const util::OJson& contract, double quantity, const QHash<QString, QString>& aliasOf, const QString& accountHint);
    void releaseClosed(const QList<util::OJson>& rows);
    util::Task<> fillOptionPrices(QList<util::OJson>* rows);
    util::Task<> ensureOptionStreams(SessionPtr session, QList<util::OJson> legs);
    util::Task<> fillPositionPrices(QList<util::OJson>* rows);

    // broker_orders.cpp
    util::Task<util::OJson> priceCondition(SessionPtr session, std::optional<util::OJson> trigger);

    IbSessionFactory factory_;
    contract::OrderedMap<SessionPtr> connectionsMap_;
    QHash<QString, QString> accountRoute_;
    contract::OrderedMap<std::shared_ptr<TickerHandle>> streams_;  // 空指针 = TS 的 null(认不出的记号)
    UpstreamWatch upstream_;
    HeldStreams optionStreams_;
    /// onOptionTick 的回调表(shared_ptr:会话上挂的转发闭包拿着它,router 先没了也不悬空)
    std::shared_ptr<QHash<int, std::function<void()>>> tickListeners_ = std::make_shared<QHash<int, std::function<void()>>>();
    int nextTickListener_ = 0;
    HeldStreams stockStreams_{QString()};
    QHash<QString, int> conIdCache_;
    SessionBars sessionBars_;
    QHash<QString, std::array<QString, 4>> hoursCache_;  // [查询日, tradingHours, liquidHours, tzId]
    QHash<QString, util::OJson> spotInfos_;
    QHash<QString, util::OJson> basisCache_;
    QHash<QString, std::shared_ptr<FutStream>> futStreams_;
    QHash<QString, double> futuresBackoff_;
    QString lastFuturesError_;
    contract::OrderedMap<std::optional<VolumeStream>> volumeStreams_;  // nullopt = null(认不出的标的)
    contract::OrderedMap<std::pair<double, QString>> volumeRetry_;
    QSet<QString> unmappedAccounts_;
    QHash<int, HostedEntry> hostedTrades_;
    std::shared_ptr<bool> alive_ = std::make_shared<bool>(true);
};

}  // namespace ibkr::execution
