// BrokerRouter:行情(腿报价、指数现价与夜盘推算、批量 / 常驻报价、量能流)、K 线、期权链、盘口。broker.ts 的中段。
#include "execution/broker.h"

#include "domain/positions.h"
#include "execution/broker_internal.h"
#include "execution/ib_contracts.h"
#include "util/jsformat.h"
#include "util/js_runtime.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/market_js.h"
#include "util/py.h"
#include "util/tz.h"

#include <QDateTime>
#include <QTimeZone>
#include <QJsonDocument>
#include <QDir>
#include <QFile>
#include <QFileInfo>

#include <algorithm>
#include <cmath>

namespace ibkr::execution {

using namespace Qt::StringLiterals;
using util::OJson;
using util::Task;
namespace js = util::js;
using detail::messageOf;
using detail::prop;

namespace {

/// 轮询用:last / close / marketPrice 里第一个非零的有效数(TS 的 readPriceFrom:`candidate && !Number.isNaN(candidate)`)
std::optional<double> readPriceFrom(const TickerData& t) {
    for (const std::optional<double>& c : {t.last, t.close, t.marketPrice}) {
        if (c && *c != 0 && !std::isnan(*c)) return *c;
    }
    return std::nullopt;
}

/// 轮询而不是死等:价格到了立刻返回,waitMs 只是上限。固定 settle(1000) 意味着哪怕 tick 在第 80ms 就到了也要陪满一秒。
Task<std::optional<double>> pollTicker(std::shared_ptr<IbSession> session, std::shared_ptr<TickerHandle> ticker, int waitMs) {
    int waited = 0;
    for (;;) {
        if (const auto price = readPriceFrom(ticker->read())) co_return price;
        if (waited >= waitMs) co_return std::nullopt;
        co_await session->settle(std::min(100, waitMs - waited));
        waited += 100;
    }
}

/// `error` 的真假(空串也是"没有错")
bool errTruthy(const TickerData& t) { return t.error && !t.error->isEmpty(); }

/// new Set(numbers) 的次序与去重(SameValueZero:NaN 与 NaN 相等,+0 与 −0 相等)
std::vector<double> uniqueNumbers(const std::vector<double>& in) {
    std::vector<double> out;
    for (const double v : in) {
        const bool seen = std::any_of(out.begin(), out.end(), [v](double o) { return o == v || (std::isnan(o) && std::isnan(v)); });
        if (!seen) out.push_back(v);
    }
    return out;
}

/// [...new Set(strings)].sort()
QStringList uniqueSortedStrings(const QStringList& in) {
    QStringList out;
    for (const QString& s : in) {
        if (!out.contains(s)) out.append(s);
    }
    std::sort(out.begin(), out.end());
    return out;
}

OJson stringsJson(const QStringList& l) { return js::strings(l); }
OJson numbersJson(const std::vector<double>& v) {
    OJson a = js::array();
    for (const double x : v) a.items.append(js::N(x));
    return a;
}

QString toUpperJs(const QString& s) { return s.toUpper(); }

}  // namespace

// ---- 行情 -----------------------------------------------------------

Task<std::vector<LegQuote>> BrokerRouter::legQuotes(OJson contract, contract::AccountConfig account) {
    const SessionPtr session = co_await forAccount(account);
    const OJson* legsP = prop(contract, u"legs"_s);
    const QList<OJson> legs = js::nullish(legsP) ? QList<OJson>() : legsP->items;
    if (legs.isEmpty()) co_return std::vector<LegQuote>{};
    const bool delayedOk = account.is_paper;
    const QString symbol = js::str(prop(contract, u"symbol"_s));
    const QString exchange = js::str(prop(contract, u"exchange"_s));
    const QString currency = js::str(prop(contract, u"currency"_s));
    std::vector<IbContract> opts;
    for (const OJson& leg : legs) {
        opts.push_back(optionContract(symbol, js::str(prop(leg, u"lastTradeDateOrContractMonth"_s)), js::num(prop(leg, u"strike"_s)),
                                      js::str(prop(leg, u"right"_s)), exchange, currency, js::str(prop(leg, u"multiplier"_s)),
                                      detail::strOr(prop(leg, u"tradingClass"_s))));
    }
    // 回调挂在会话上,协程帧先没了它就悬空:状态放 shared_ptr,回调拿一份
    const auto mdErrors = std::make_shared<std::vector<std::pair<double, QString>>>();
    const bool hasOnError = session->has(Cap::OnError);
    ListenerToken token = 0;
    if (hasOnError) {
        token = session->onError([mdErrors](int, int code, const QString& message) {
            if (kMdErrorCodes.contains(code)) mdErrors->emplace_back(code, message);
        });
    }
    size_t subscribed = 0;
    std::vector<LegQuote> quotes;
    std::exception_ptr failure;
    try {
        if (delayedOk) session->reqMarketDataType(3);
        co_await qualifyAllOrRaise(session, &opts);
        std::vector<std::shared_ptr<TickerHandle>> handles;
        for (const IbContract& opt : opts) {
            handles.push_back(session->subscribeTicker(opt));
            subscribed += 1;
        }
        // 轮询而不是固定等待:固定 sleep 会抢跑拿到 NaN,被守卫误判成"盘口不可用"。
        int waited = 0;
        const auto ready = [&handles]() {
            return std::all_of(handles.begin(), handles.end(), [](const std::shared_ptr<TickerHandle>& h) {
                const TickerData t = h->read();
                return finiteQuote(t.bid) > 0 && finiteQuote(t.ask) > 0;
            });
        };
        // 某条腿的订阅被拒(实盘会话同时在线时 10197 时不时来一下),当场重订那一条,而不是干等到超时报「盘口不可用」
        std::vector<bool> resubscribed(opts.size(), false);
        while (waited < kQuoteWaitMs) {
            co_await session->settle(250);
            waited += 250;
            if (ready()) break;
            for (size_t i = 0; i < handles.size(); ++i) {
                if (!resubscribed[i] && errTruthy(handles[i]->read())) {
                    resubscribed[i] = true;
                    try {
                        session->cancelTicker(opts[i]);
                    } catch (...) {
                        /* 撤不掉也要重订 */
                    }
                    handles[i] = session->subscribeTicker(opts[i]);
                }
            }
        }
        for (qsizetype i = 0; i < legs.size(); ++i) {
            const TickerData t = handles[size_t(i)]->read();
            quotes.push_back({js::str(prop(legs[i], u"action"_s)), js::num(prop(legs[i], u"ratio"_s)), finiteQuote(t.bid), finiteQuote(t.ask)});
        }
        // 订阅被拒的腿:把 TWS 原文带出去。只报"盘口不可用"没法排查——是没权限、线路配额漏光(101)还是实盘会话占着行情(10197)
        QStringList legErrors;
        for (size_t i = 0; i < handles.size(); ++i) {
            const TickerData t = handles[i]->read();
            if (!errTruthy(t)) continue;
            legErrors.append(js::str(prop(legs[qsizetype(i)], u"strike"_s)) + js::str(prop(legs[qsizetype(i)], u"right"_s)) + u": "_s + *handles[i]->read().error);
        }
        const bool anyMissing = std::any_of(quotes.begin(), quotes.end(), [](const LegQuote& q) { return !(q.bid > 0 && q.ask > 0); });
        if (!legErrors.isEmpty() && anyMissing) throw BrokerError(u"取不到 %1 组合盘口,TWS 拒了订阅:%2"_s.arg(symbol, legErrors.join(u";"_s)));
    } catch (...) {
        failure = std::current_exception();
    }
    // finally
    for (size_t i = 0; i < subscribed; ++i) {
        try {
            session->cancelTicker(opts[i]);  // 不撤会一直占着行情线路配额
        } catch (...) {
            /* 撤订阅失败不该盖住真正的错误 */
        }
    }
    if (delayedOk) session->reqMarketDataType(1);
    if (hasOnError) session->offError(token);
    if (failure) std::rethrow_exception(failure);
    const bool missing = std::any_of(quotes.begin(), quotes.end(), [](const LegQuote& q) { return !(q.bid > 0 && q.ask > 0); });
    if (missing && !mdErrors->empty()) throw BrokerError(quoteErrorMessage(symbol, *mdErrors));
    co_return quotes;
}

/// IBKR 什么都能报(订阅到位的话),恒回空。
std::optional<QString> BrokerRouter::quoteCapability(const QString&) const { return std::nullopt; }

std::optional<OJson> BrokerRouter::spotInfo(const QString& symbol) const {
    const auto it = spotInfos_.constFind(toUpperJs(symbol));
    if (it == spotInfos_.cend()) return std::nullopt;
    return it.value();
}

/**
 * 基差落盘:一个夜盘只需要算一次,重启不该再去取历史 K 线。读写失败都不影响取价,顶多退回重取。
 */
QString BrokerRouter::basisFile() const { return QFileInfo(settings.db_path).path() + u"/index_basis.json"_s; }

std::optional<OJson> BrokerRouter::loadBasis(const QString& key) {
    if (const auto hit = basisCache_.constFind(key); hit != basisCache_.cend()) return hit.value();
    QFile f(basisFile());
    if (!f.open(QIODevice::ReadOnly)) return std::nullopt;  // 没有文件或坏文件:当作没算过
    const auto all = js::parse(util::nodeUtf8(f.readAll()));
    if (!all || all->type == OJson::Null) return std::nullopt;
    const OJson* row = prop(*all, key);
    if (row && js::truthy(row) && std::isfinite(js::num(prop(row, u"basis"_s)))) {
        basisCache_.insert(key, *row);
        return *row;
    }
    return std::nullopt;
}

void BrokerRouter::saveBasis(const QString& key, const OJson& row) {
    basisCache_.insert(key, row);
    try {
        OJson all = js::object();
        if (QFile f(basisFile()); f.open(QIODevice::ReadOnly)) {
            if (const auto parsed = js::parse(util::nodeUtf8(f.readAll()))) all = *parsed;
        }
        // 文件内容是 null / 数 / 串 / 布尔时,TS 往上赋值要么抛要么在严格模式下抛:整段落进 catch,什么都不写
        if (all.type != OJson::Object && all.type != OJson::Array) return;
        // JS 的数组也能挂键:Object.keys 先给下标再给这把键
        OJson asObject = js::object();
        if (all.type == OJson::Array) {
            for (qsizetype i = 0; i < all.items.size(); ++i) asObject.set(QString::number(i), all.items[i]);
        } else {
            asObject = all;
        }
        asObject.set(key, row);
        QStringList keys = js::keys(&asObject);
        std::sort(keys.begin(), keys.end());  // 默认的 sort():按 UTF-16 码元
        const qsizetype from = std::max<qsizetype>(0, keys.size() - 20);  // 只留最近 20 条
        OJson trimmed = js::object();
        for (qsizetype i = from; i < keys.size(); ++i) trimmed.set(keys[i], *asObject.get(keys[i]));
        QDir().mkpath(QFileInfo(basisFile()).path());
        QFile out(basisFile());
        if (!out.open(QIODevice::WriteOnly | QIODevice::Truncate)) return;
        out.write(util::toNodeUtf8(util::stringifyOJson(trimmed, 1)));
    } catch (...) {
        /* 写不下去不影响这一次取价 */
    }
}

Task<BrokerRouter::SessionPtr> BrokerRouter::quoteSession() {
    const contract::AccountConfig* dflt = settings.defaultAccount();
    if (dflt) {
        const contract::AccountConfig account = *dflt;
        SessionPtr found;
        try {
            found = co_await forAccount(account);
        } catch (const BrokerError&) {
            /* 退到下面 */
        }
        if (found) co_return found;
    }
    const auto live = sessions();
    co_return live.empty() ? nullptr : live[0];
}

/**
 * 指数(或股票)现价。指数只在常规时段计算:夜盘里 SPX 报的是昨收、一动不动,SPXW 期权却照常在跳。配了期货代理的指数,
 * 常规时段之外改用「期货现价 − 基差」,见 futuresSpot();推不出来才退回官方指数,并在 spotInfo 里标明是旧价。
 */
Task<std::optional<double>> BrokerRouter::indexPrice(QString symbol) {
    const contract::IndexConfig* cfgP = settings.indexConfig(symbol);
    const std::optional<contract::IndexConfig> cfg = cfgP ? std::optional<contract::IndexConfig>(*cfgP) : std::nullopt;
    const SessionPtr session = co_await quoteSession();
    if (!session) co_return std::nullopt;
    const QString key = toUpperJs(symbol);

    if (cfg && !cfg->futures.isEmpty()) {
        const domain::EtNow now = domain::nowEt();
        if (settings.marketStatus(now) != u"盘中") {
            QString why = u"期货还没报价"_s;
            const auto futErr = [this]() { return lastFuturesError_.isEmpty() ? u"期货还没报价"_s : u"期货还没报价:%1"_s.arg(lastFuturesError_); };
            if (futuresBackoff_.value(key, 0) <= util::dateNow()) {
                std::optional<OJson> derived;
                std::optional<QString> brokerError;
                try {
                    derived = co_await futuresSpot(session, *cfg, now);
                } catch (const BrokerError& exc) {
                    brokerError = exc.message();
                    futuresBackoff_.insert(key, util::dateNow() + 60'000);  // 取不到基差:一分钟后再试
                }
                if (brokerError) {
                    why = *brokerError;
                } else {
                    if (derived) {
                        spotInfos_.insert(key, *derived);
                        co_return js::num(prop(*derived, u"price"_s));
                    }
                    why = futErr();
                }
            } else {
                why = u"上一次推算失败,稍后重试"_s;
            }
            // 推不出来:照旧取官方指数,但要让界面知道这是一个不会动的旧价
            const std::optional<double> stale = co_await officialPrice(session, symbol, cfg);
            spotInfos_.insert(key, js::object({{u"price"_s, detail::numOrNull(stale)},
                                               {u"source"_s, js::S(u"index_stale"_s)},
                                               {u"note"_s, js::S(u"%1 指数只在常规时段计算,这是上一个收盘价,不是现价(期货推算没成功:%2)"_s.arg(key, why))}}));
            co_return stale;
        }
    }
    const std::optional<double> price = co_await officialPrice(session, symbol, cfg);
    spotInfos_.insert(key, js::object({{u"price"_s, detail::numOrNull(price)}, {u"source"_s, js::S(u"index"_s)}, {u"note"_s, js::S(QString())}}));
    co_return price;
}

Task<std::optional<double>> BrokerRouter::officialPrice(SessionPtr session, QString symbol, std::optional<contract::IndexConfig> cfg) {
    IbContract target = cfg ? indexContract(symbol, cfg->exchange) : stockContract(symbol);
    bool known = true;
    try {
        co_await qualifyOrRaise(session, &target);
    } catch (const BrokerError&) {
        known = false;
    }
    if (!known) co_return std::nullopt;
    co_return co_await streamPrice(session, u"idx:%1"_s.arg(symbol), target);
}

/**
 * 常驻订阅取一个价:第一次要等首笔 tick,之后每次调用都是读缓存(百毫秒内)。
 * 快照是"输入到下单"链路的第一段,盯盘又是一秒一轮,不能每次都重新订阅再干等一秒。
 */
Task<std::optional<double>> BrokerRouter::streamPrice(SessionPtr session, QString streamKey, IbContract target) {
    if (const auto* existing = streams_.find(streamKey); existing && *existing) {
        const std::shared_ptr<TickerHandle> handle = *existing;
        const std::optional<double> cached = co_await pollTicker(session, handle, 250);
        if (cached) co_return cached;
        // 常驻流断了数据:丢掉重订(下面的冷启动路径)
        streams_.remove(streamKey);
    }
    const std::shared_ptr<TickerHandle> handle = session->subscribeTicker(target);
    std::optional<double> price = co_await pollTicker(session, handle, 1200);
    if (price) {
        streams_.insert(streamKey, handle);
        co_return price;
    }
    // 没有实时订阅时退到延迟行情。只撤自己订的那条(不带 generic ticks):不传第二个参数是"撤掉这个合约的所有变体",
    // 会把异动监控那条的量能流一起撤掉。
    session->cancelTicker(target, QString());
    std::exception_ptr failure;
    try {
        session->reqMarketDataType(3);
        const std::shared_ptr<TickerHandle> delayed = session->subscribeTicker(target);
        price = co_await pollTicker(session, delayed, 2000);
        if (price) streams_.insert(streamKey, delayed);
    } catch (...) {
        failure = std::current_exception();
    }
    session->reqMarketDataType(1);
    if (failure) std::rethrow_exception(failure);
    co_return price;
}

/** 期货现价:见 futStreams。按 reqMarketDataType(3) 订——有实时权限就是实时,没有才给延迟;实时类型下没权限的账户什么都拿不到。 */
Task<std::optional<double>> BrokerRouter::futuresPrice(SessionPtr session, QString key, IbContract fut) {
    std::shared_ptr<FutStream> stream;
    if (const auto it = futStreams_.constFind(key); it != futStreams_.cend()) stream = it.value();
    std::optional<double> price;
    // 实盘 TWS 同时登录时,IBKR 在两个会话之间仲裁行情,纸面会话的订阅时不时吃一个 10197。被拒的流不会自己活过来,
    // 所以同一次调用里当场重订,最多三次;只是没来 tick 就不重订,免得狂刷请求。
    for (int attempt = 0; attempt < 3; ++attempt) {
        if (stream && errTruthy(stream->handle->read())) {
            try {
                session->cancelTicker(stream->target);
            } catch (...) {
                /* 撤不掉也要重订 */
            }
            futStreams_.remove(key);
            stream.reset();
        }
        if (!stream) {
            // 类型 3 保持到首笔报价到手再切回去:连接刚建好时请求实际发出去会晚一拍
            std::exception_ptr failure;
            try {
                session->reqMarketDataType(3);
                stream = std::make_shared<FutStream>(FutStream{session->subscribeTicker(fut), fut, util::dateNow(), 0});
                futStreams_.insert(key, stream);
                price = co_await pollTicker(session, stream->handle, 1500);
            } catch (...) {
                failure = std::current_exception();
            }
            session->reqMarketDataType(1);
            if (failure) std::rethrow_exception(failure);
        } else {
            price = co_await pollTicker(session, stream->handle, 250);
        }
        if (price || !errTruthy(stream->handle->read())) break;
    }
    if (price) {
        stream->lastOk = util::dateNow();
        lastFuturesError_.clear();
        co_return price;
    }
    if (!stream) co_return std::nullopt;
    {
        const TickerData t = stream->handle->read();
        lastFuturesError_ = errTruthy(t) ? *t.error : u"订上了但一直没有 tick"_s;
    }
    if (util::dateNow() - std::max(stream->since, stream->lastOk) > 30'000) {
        // 半分钟一个价都没有:当它死了,下一次重订
        try {
            session->cancelTicker(stream->target);
        } catch (...) {
            /* 撤不掉也要丢掉缓存 */
        }
        futStreams_.remove(key);
    }
    co_return std::nullopt;
}

/**
 * 夜盘的指数现价 = 期货现价 − 基差。期货取到期日严格晚于今天的最近季月(frontQuarterly);基差用上一个常规时段最后同一分钟的两根 K 线相减
 * (contemporaneousBasis),不是两个收盘价相减;基差一个时段只算一次,缓存到下一个收盘。
 */
Task<std::optional<OJson>> BrokerRouter::futuresSpot(SessionPtr session, contract::IndexConfig cfg, domain::EtNow now) {
    const QString month = frontQuarterly(now.date);
    IbContract fut = indexFuturesContract(cfg, now.date);
    co_await qualifyOrRaise(session, &fut);

    const auto [sessionDate, closeMin] = lastRthSession(now, settings);
    const QString cacheKey = u"%1%2|%3"_s.arg(cfg.futures, month, sessionDate);
    std::optional<OJson> basis = loadBasis(cacheKey);
    if (!basis) {
        const double endEpoch = util::wallToEpoch(util::WallParts{sessionDate.mid(0, 4).toDouble(), sessionDate.mid(5, 2).toDouble(), sessionDate.mid(8, 2).toDouble(),
                                                                  double(closeMin / 60), double(closeMin % 60 + 5), 0},
                                                  QString::fromUtf16(util::kET));
        QString endUtc = util::isoString(endEpoch).left(19);
        endUtc.remove(u'-');
        const qsizetype t = endUtc.indexOf(u'T');
        if (t >= 0) endUtc.replace(t, 1, u'-');
        HistoricalRequest opts;
        opts.endDateTime = endUtc;
        opts.durationStr = u"1800 S"_s;
        opts.barSizeSetting = u"1 min"_s;
        opts.whatToShow = u"TRADES"_s;
        IbContract idx = indexContract(cfg.symbol, cfg.exchange);
        co_await qualifyOrRaise(session, &idx);
        std::vector<RawBar> idxBars, futBars;
        std::exception_ptr failure;
        try {
            HistoricalRequest idxOpts = opts;
            idxOpts.useRTH = true;
            idxBars = co_await session->historicalData(idx, idxOpts);
            HistoricalRequest futOpts = opts;
            futOpts.useRTH = false;
            futBars = co_await session->historicalData(fut, futOpts);
        } catch (...) {
            failure = std::current_exception();
        }
        if (failure) throw BrokerError(u"取 %1 / %2 收盘分钟线失败:%3"_s.arg(cfg.symbol, cfg.futures, messageOf(failure)));
        std::vector<TimedClose> idxClose, futClose;
        for (const RawBar& b : idxBars) idxClose.push_back({barTimestamp(b.date), b.close});
        for (const RawBar& b : futBars) futClose.push_back({barTimestamp(b.date), b.close});
        const auto matched = contemporaneousBasis(idxClose, futClose);
        if (!matched) {
            throw BrokerError(u"%1 收盘前找不到 %2 与 %3 同一分钟的 K 线,算不出基差"_s.arg(sessionDate, cfg.symbol, cfg.futures));
        }
        OJson row = js::object({{u"basis"_s, js::N(matched->basis)},
                                {u"time"_s, js::S(matched->time)},
                                {u"index_close"_s, js::N(matched->index_close)},
                                {u"futures_close"_s, js::N(matched->futures_close)},
                                {u"session"_s, js::S(sessionDate)}});
        basis = row;
        saveBasis(cacheKey, row);
    }

    const std::optional<double> futPrice = co_await futuresPrice(session, cfg.futures + month, fut);
    if (!futPrice) co_return std::nullopt;
    const double b = js::num(prop(*basis, u"basis"_s));
    const double price = util::pyRound(*futPrice - b, 2);
    const QString label = u"%1 %2"_s.arg(cfg.futures, month);
    OJson out = js::object({{u"price"_s, js::N(price)},
                            {u"source"_s, js::S(u"futures"_s)},
                            {u"futures"_s, js::S(label)},
                            {u"futures_price"_s, js::N(*futPrice)},
                            {u"basis"_s, js::N(b)}});
    if (const OJson* bt = prop(*basis, u"time"_s)) out.set(u"basis_time"_s, *bt);
    out.set(u"note"_s, js::S(u"%1 夜盘不计算,按 %2 %3 − 基差 %4 推算"_s.arg(cfg.symbol, label, util::jsNumberToString(util::pyRound(*futPrice, 2)),
                                                                   util::jsNumberToString(util::pyRound(b, 2))) +
                             u"(基差取 %1 同一分钟)"_s.arg(js::str(prop(*basis, u"time"_s)))));
    co_return out;
}

/// 批量拉股票/ETF 报价;绝不用于订单定价。
Task<OJson> BrokerRouter::earnings(QString symbol) {
    const auto live = sessions();
    if (live.empty()) throw util::JsError(u"IBKR 未连接"_s);
    auto session = live[0];
    IbContract contract = stockContract(symbol);
    co_await qualifyOrRaise(session, &contract);
    const auto today = QDateTime::currentDateTimeUtc().toTimeZone(QTimeZone("America/New_York")).date();
    const auto filter = js::object({{u"country"_s, js::S(u"All"_s)},
        {u"watchlist"_s, js::array({js::S(QString::number(contract.conId.value_or(0)))})}, {u"wshe_ed"_s, js::S(u"true"_s)}});
    const QString raw = co_await session->wshEvents(js::stringify(filter), today.addYears(-2).toString(u"yyyyMMdd"_s), today.addDays(120).toString(u"yyyyMMdd"_s));
    auto parsed = util::parseOJson(raw);
    if (!parsed) throw util::JsError(u"IBKR WSH 返回了无效 JSON"_s);
    co_return *parsed;
}

Task<OJson> BrokerRouter::stockQuotes(QStringList symbols) {
    const auto live = sessions();
    const SessionPtr session = live.empty() ? nullptr : live[0];
    if (!session) co_return js::object();
    OJson out = js::object();
    std::exception_ptr failure;
    try {
        session->reqMarketDataType(3);
        contract::OrderedMap<std::pair<IbContract, std::shared_ptr<TickerHandle>>> tickers;
        for (const QString& symbol : symbols) {
            IbContract target = stockContract(symbol);
            bool known = true;
            try {
                co_await qualifyOrRaise(session, &target);
            } catch (const BrokerError&) {
                known = false;
            }
            if (!known) {
                out.set(symbol, js::object({{u"last"_s, js::Null()}, {u"close"_s, js::Null()}, {u"change_pct"_s, js::Null()}}));
                continue;
            }
            tickers.insert(symbol, {target, session->subscribeTicker(target)});
        }
        co_await session->settle(2500);
        for (const QString& symbol : tickers.keys()) {
            const TickerData t = tickers.find(symbol)->second->read();
            std::optional<double> last = cleanPrice(t.last);
            if (!last) last = cleanPrice(t.marketPrice);
            const std::optional<double> close = cleanPrice(t.close);
            std::optional<double> change;
            if (last && close) change = util::pyRound(((*last - *close) / *close) * 100.0, 2);
            out.set(symbol, js::object({{u"last"_s, detail::numOrNull(last)}, {u"close"_s, detail::numOrNull(close)}, {u"change_pct"_s, detail::numOrNull(change)}}));
        }
    } catch (...) {
        failure = std::current_exception();
    }
    session->reqMarketDataType(1);
    if (failure) std::rethrow_exception(failure);
    co_return out;
}

/** 日线历史(回测、扫描、提醒共用),带当日成交量。ADJUSTED_LAST 前复权;指数用 TRADES,没有量,归零。 */
Task<QList<OJson>> BrokerRouter::historicalBars(QString symbol, QString start, QString end) {
    const auto live = sessions();
    const SessionPtr session = live.empty() ? nullptr : live[0];
    if (!session) throw BrokerError(u"引擎未连接 TWS,无法获取历史数据。请先在「TWS 连接」面板连接引擎。"_s);
    const contract::IndexConfig* cfg = settings.indexConfig(symbol);
    IbContract target = cfg ? indexContract(symbol, cfg->exchange) : stockContract(symbol);
    co_await qualifyOrRaise(session, &target);

    // IBKR 不接受 ADJUSTED_LAST 配非空 endDateTime(错误 321),所以结束日在过去时不能靠 endDateTime 截断,只能一路拉到今天再本地切片。
    // 今天用美东日期——引擎其它地方都是美东口径。
    const QString todayIso = domain::nowEt().date;
    const QString fetchEnd = end >= todayIso ? end : todayIso;
    const double startOrd = util::jsDateParse(start + u"T00:00:00Z"_s);
    const double days = util::jsRound((util::jsDateParse(fetchEnd + u"T00:00:00Z"_s) - startOrd) / 86'400'000.0);
    const QString duration = days <= 360 ? util::jsNumberToString(days + 5) + u" D"_s : util::jsNumberToString(std::trunc(days / 365) + 1) + u" Y"_s;

    std::vector<RawBar> raw;
    std::exception_ptr failure;
    try {
        HistoricalRequest req;
        req.endDateTime = QString();
        req.durationStr = duration;
        req.barSizeSetting = u"1 day"_s;
        req.whatToShow = cfg ? u"TRADES"_s : u"ADJUSTED_LAST"_s;
        req.useRTH = true;
        raw = co_await session->historicalData(target, req);
    } catch (...) {
        failure = std::current_exception();
    }
    if (failure) throw BrokerError(u"获取 %1 历史数据失败:%2"_s.arg(symbol, messageOf(failure)));
    QList<OJson> bars;
    for (const RawBar& bar : raw) {
        const QString day = barTimestamp(bar.date).left(10);
        if (start <= day && day <= end) {
            const double vol = bar.volume ? *bar.volume : 0;
            const double volume = util::jsmath::max(std::isnan(vol) || vol == 0 ? 0 : vol, 0.0);
            bars.append(js::object({{u"date"_s, js::S(day)}, {u"open"_s, js::N(bar.open)}, {u"high"_s, js::N(bar.high)},
                                    {u"low"_s, js::N(bar.low)}, {u"close"_s, js::N(bar.close)}, {u"volume"_s, js::N(volume)}}));
        }
    }
    if (bars.isEmpty()) {
        throw BrokerError(u"%1 在 %2 ~ %3 内没有历史数据(标的代码是否正确?区间是否全是休市日?)"_s.arg(symbol, start, end));
    }
    co_return bars;
}

/** 常驻流式报价:第一次调用建订阅,之后每次只读当前值(顶栏宏观带用)。 */
Task<OJson> BrokerRouter::streamQuotes(QStringList symbols) {
    const auto live = sessions();
    const SessionPtr session = live.empty() ? nullptr : live[0];
    if (!session) co_return js::object();

    bool fresh = false;
    for (const QString& symbol : symbols) {
        if (streams_.contains(symbol)) continue;
        IbContract target = streamContract(symbol);
        bool known = true;
        try {
            co_await qualifyOrRaise(session, &target);
        } catch (const BrokerError&) {
            known = false;
        }
        if (!known) {
            streams_.insert(symbol, nullptr);  // 记下来,不用每次都重试 qualify
            continue;
        }
        streams_.insert(symbol, session->subscribeTicker(target));
        fresh = true;
    }
    co_await session->settle(fresh ? 1500 : 150);

    OJson out = js::object();
    for (const QString& symbol : symbols) {
        const auto* entry = streams_.find(symbol);
        if (!entry || !*entry) continue;
        const TickerData t = (*entry)->read();
        std::optional<double> last = cleanPrice(t.last);
        if (!last) last = cleanPrice(t.marketPrice);
        const std::optional<double> close = cleanPrice(t.close);
        std::optional<double> change;
        if (last && *last != 0 && close && *close != 0) change = util::pyRound(((*last - *close) / *close) * 100.0, 2);
        if (!last) continue;  // 没订阅/没数据 → 交给公开源兜底
        out.set(symbol, js::object({{u"last"_s, detail::numOrNull(last)},
                                    {u"close"_s, detail::numOrNull(close)},
                                    {u"change_pct"_s, detail::numOrNull(change)},
                                    {u"last_trade_at"_s, detail::numOrNull(cleanPrice(t.lastTradeAt))}}));
    }
    co_return out;
}

// ---- 异动监控的常驻量能流 -------------------------------------------------

namespace {
OJson emptyVolumeSnapshot() {
    return js::object({{u"last"_s, js::Null()}, {u"close"_s, js::Null()}, {u"open"_s, js::Null()}, {u"high"_s, js::Null()}, {u"low"_s, js::Null()},
                       {u"volume"_s, js::Null()}, {u"avg_volume"_s, js::Null()}, {u"hist_vol"_s, js::Null()}, {u"vol_3m"_s, js::Null()},
                       {u"vol_5m"_s, js::Null()}, {u"vol_10m"_s, js::Null()}, {u"delayed"_s, js::B(false)}, {u"last_trade_at"_s, js::Null()}});
}
}  // namespace

/**
 * 异动监控的行情:当日量 / 90 日均量 / 30 日历史波动率 / 近几分钟量,全部取自同一条常驻流。第一次调用建订阅,之后每次只读当前值。
 * 只用于研究与提醒,绝不用于订单定价。
 */
Task<OJson> BrokerRouter::volumeQuotes(QStringList symbols) {
    const auto live = sessions();
    const SessionPtr session = live.empty() ? nullptr : live[0];
    if (!session) co_return js::object();
    const double now = util::dateNow();
    bool fresh = false;
    bool stalled = false;
    for (const QString& symbol : symbols) {
        const auto* existing = volumeStreams_.find(symbol);
        if (existing && !*existing) continue;  // null:认不出的标的,不再重试
        if (existing) {
            const VolumeStream entry = **existing;
            const bool error = errTruthy(entry.handle->read());
            const bool stale = entry.session != session || !entry.session->isConnected();
            if (!error && !stale) continue;
            // 被拒的流不会自己活过来,会话换了的句柄也不会再更新:摘掉重订(被拒的按退避来)
            try {
                entry.session->cancelTicker(entry.target, kVolumeTicks);
            } catch (...) {
                /* 撤不掉也要重订 */
            }
            volumeStreams_.remove(symbol);
            if (error) {
                volumeRetry_.insert(symbol, {now + kVolumeRetryMs, *entry.handle->read().error});
                continue;
            }
        }
        const auto* retry = volumeRetry_.find(symbol);
        if (retry && now < retry->first) continue;
        if (stalled) continue;  // 这一轮 TWS 已经不回合约确认了,别的也不用排队干等
        IbContract target = stockContract(symbol);
        std::optional<QString> reason;
        try {
            co_await qualifyOrRaise(session, &target);
        } catch (const BrokerError& exc) {
            reason = exc.message();
        }
        if (reason) {
            if (*reason == stalledMessage()) {
                // 超时 ≠ 认不出:TWS 卡住时记成"未知标的"就再也不会重试了
                stalled = true;
                volumeRetry_.insert(symbol, {now + kVolumeRetryMs, u"TWS 没有响应合约确认,稍后重试"_s});
            } else {
                volumeStreams_.insert(symbol, std::nullopt);
            }
            continue;
        }
        volumeStreams_.insert(symbol, VolumeStream{target, session->subscribeTicker(target, kVolumeTicks), session});
        volumeRetry_.remove(symbol);
        fresh = true;
    }
    co_await session->settle(fresh ? 1500 : 100);

    OJson out = js::object();
    for (const QString& symbol : symbols) {
        const auto* entry = volumeStreams_.find(symbol);
        if (entry && !*entry) {
            OJson snap = emptyVolumeSnapshot();
            snap.set(u"error"_s, js::S(u"未知标的"_s));
            out.set(symbol, snap);
            continue;
        }
        if (!entry) {
            if (const auto* retry = volumeRetry_.find(symbol)) {
                OJson snap = emptyVolumeSnapshot();
                snap.set(u"error"_s, js::S(retry->second));
                out.set(symbol, snap);
            }
            continue;
        }
        const TickerData t = (**entry).handle->read();
        std::optional<double> last = cleanPrice(t.last);
        if (!last) last = cleanPrice(t.marketPrice);
        OJson snap = js::object({{u"last"_s, detail::numOrNull(last)},
                                 {u"close"_s, detail::numOrNull(cleanPrice(t.close))},
                                 {u"open"_s, detail::numOrNull(cleanPrice(t.open))},
                                 {u"high"_s, detail::numOrNull(cleanPrice(t.high))},
                                 {u"low"_s, detail::numOrNull(cleanPrice(t.low))},
                                 // 量和价一样:非有限 / 非正一律 null(开盘前的 0 量不是"零成交",是还没有数)
                                 {u"volume"_s, detail::numOrNull(cleanPrice(t.volume))},
                                 {u"avg_volume"_s, detail::numOrNull(cleanPrice(t.avgVolume))},
                                 {u"hist_vol"_s, detail::numOrNull(cleanPrice(t.histVol))},
                                 {u"vol_3m"_s, detail::numOrNull(cleanPrice(t.vol3m))},
                                 {u"vol_5m"_s, detail::numOrNull(cleanPrice(t.vol5m))},
                                 {u"vol_10m"_s, detail::numOrNull(cleanPrice(t.vol10m))},
                                 {u"delayed"_s, js::B(t.delayed)},
                                 {u"last_trade_at"_s, detail::numOrNull(cleanPrice(t.lastTradeAt))}});
        if (errTruthy(t)) snap.set(u"error"_s, js::S(*t.error));
        out.set(symbol, snap);
    }
    co_return out;
}

/** 撤掉不在 keep 里的量能流,返回撤了几条。移出追踪 / 停用的股不能一直占着行情线路(约 100 条上限)。 */
int BrokerRouter::releaseVolumeStreams(const QStringList& keep) {
    const QSet<QString> keepSet(keep.begin(), keep.end());
    int released = 0;
    const QStringList symbols = volumeStreams_.keys();
    for (const QString& symbol : symbols) {
        if (keepSet.contains(symbol)) continue;
        const std::optional<VolumeStream> entry = *volumeStreams_.find(symbol);
        volumeStreams_.remove(symbol);
        if (!entry) continue;
        try {
            entry->session->cancelTicker(entry->target, kVolumeTicks);
        } catch (...) {
            /* 撤不掉也不该拦住别的 */
        }
        released += 1;
    }
    const QStringList retrySymbols = volumeRetry_.keys();
    for (const QString& symbol : retrySymbols) {
        if (!keepSet.contains(symbol)) volumeRetry_.remove(symbol);
    }
    return released;
}

/** 按周期拉 K 线(PA 分析用;给了 endDay = 取到那个美东日收盘为止;indexProxy = 指数的盘外按期货推算,只有「行情」页要)。历史数据同样要行情权限;先切延迟再切回实时。 */
Task<TaggedBars> BrokerRouter::intradayBars(QString symbol, QString timeframe, bool rth, std::optional<QString> endDay, bool indexProxy) {
    const OJson* spec = domain::timeframes().get(timeframe);
    if (!spec) {
        throw BrokerError(u"未知 K 线周期:%1(可选:%2)"_s.arg(timeframe, js::keys(&domain::timeframes()).join(u"、"_s)));
    }
    const auto live = sessions();
    const SessionPtr session = live.empty() ? nullptr : live[0];
    if (!session) throw BrokerError(u"引擎未连接 TWS,无法获取 K 线。请先在「TWS 连接」面板连接引擎。"_s);
    const contract::IndexConfig* cfg = settings.indexConfig(symbol);
    IbContract target = cfg ? indexContract(symbol, cfg->exchange) : stockContract(symbol);
    co_await qualifyOrRaise(session, &target);

    const QString barSize = js::str(prop(spec, u"bar_size"_s));
    const bool daily = barSize == u"1 day";
    const QString show = daily && !cfg ? u"ADJUSTED_LAST"_s : u"TRADES"_s;
    // 个股的夜盘是另一个交易所,另要一次拼上;指数没有盘外,要的时候按期货推算(ibBars.ts)。只看常规时段、日线都不要
    const bool overnight = !rth && !daily && !cfg;
    std::optional<IbContract> futures;
    if (cfg && !cfg->futures.isEmpty() && indexProxy && !rth && !daily) futures = indexFuturesContract(*cfg, domain::nowEt().date);
    const double nowMs = domain::nowEt().epochMs;
    const QString endDateTime = endDay && !endDay->isEmpty() ? util::ibEndUtc(*endDay) : QString();
    const auto pull = [&](const QString& duration) {
        SessionBarsRequest req;
        req.target = target;
        req.endDateTime = endDateTime;
        req.durationStr = duration;
        req.barSizeSetting = barSize;
        req.whatToShow = show;
        req.useRTH = rth;
        req.overnight = overnight;
        req.futures = futures;
        req.nowMs = nowMs;
        return sessionBars_.fetch(session, req);
    };

    TaggedBars bars;
    std::exception_ptr failure;
    try {
        session->reqMarketDataType(3);  // 没订阅退延迟;有订阅仍是实时
        bars = co_await pull(js::str(prop(spec, u"duration"_s)));
        // IBKR 的 durationStr 数的是交易日,全时段口径下刚翻篇时第一档只有十几根
        if (static_cast<int>(bars.bars.size()) <= domain::kMinBars && js::truthy(prop(spec, u"fallback"_s))) {
            bars = co_await pull(js::str(prop(spec, u"fallback"_s)));
        }
    } catch (...) {
        failure = std::current_exception();
    }
    session->reqMarketDataType(1);
    if (failure) throw BrokerError(barsError(symbol, js::str(prop(spec, u"label"_s)), messageOf(failure)));

    if (bars.bars.empty()) {
        throw BrokerError(u"%1 没有返回 %2 K 线(标的代码是否正确?是否刚好整段休市?)"_s.arg(symbol, js::str(prop(spec, u"label"_s))));
    }
    co_return bars;  // 出自实时还是延迟档、指数盘外怎么推算的,SessionBars 已经记在这组 K 线上
}

// ---- 期权链(只读,不进下单链路)---------------------------------------

Task<OJson> BrokerRouter::optionExpiries(QString symbol) {
    const SessionPtr session = marketSession();
    const contract::IndexConfig* cfg = settings.indexConfig(symbol);
    IbContract under = cfg ? indexContract(symbol, cfg->exchange) : stockContract(symbol);
    co_await qualifyOrRaise(session, &under);

    std::vector<OptChainParam> params;
    std::exception_ptr failure;
    try {
        params = co_await session->secDefOptParams(under.symbol, cfg ? u"IND"_s : u"STK"_s, under.conId.value_or(0));
    } catch (...) {
        failure = std::current_exception();
    }
    if (failure) throw BrokerError(u"获取 %1 的期权链定义失败:%2"_s.arg(symbol, messageOf(failure).left(200)));
    if (params.empty()) throw BrokerError(u"%1 没有可用的期权链(标的是否有期权?)"_s.arg(symbol));

    // SPX 的日到期是 SPXW、月到期是 SPX,挑错了拿到的是另一条链
    QStringList wanted;
    if (cfg) wanted = {cfg->daily_trading_class, cfg->monthly_trading_class};
    std::vector<OptChainParam> chosen;
    for (const OptChainParam& p : params) {
        if (wanted.contains(p.tradingClass)) chosen.push_back(p);
    }
    if (chosen.empty()) chosen = params;
    QStringList allExpiries;
    std::vector<double> allStrikes;
    for (const OptChainParam& p : chosen) {
        allExpiries.append(p.expirations);
        allStrikes.insert(allStrikes.end(), p.strikes.begin(), p.strikes.end());
    }
    const QStringList expiries = uniqueSortedStrings(allExpiries);
    std::vector<double> strikes = uniqueNumbers(allStrikes);
    util::market::sortNumbers(strikes);
    // 同一个标的会返回多条链,合并成一份会丢掉 "哪个到期日属于哪条链" 这个关键信息:按交易类分开留一份,让 optionChain 能按到期日挑对链(见 pickTradingClass)。
    struct Slot {
        QStringList expiries;
        std::vector<double> strikes;
    };
    QStringList classOrder;
    QHash<QString, Slot> slotMap;
    for (const OptChainParam& p : chosen) {
        const QString tc = p.tradingClass;
        if (!slotMap.contains(tc)) classOrder.append(tc);
        Slot& slot = slotMap[tc];
        slot.expiries.append(p.expirations);
        slot.strikes.insert(slot.strikes.end(), p.strikes.begin(), p.strikes.end());
    }
    OJson byClass = js::object();
    for (const QString& tc : classOrder) {
        Slot slot = slotMap.value(tc);
        slot.expiries = uniqueSortedStrings(slot.expiries);
        slot.strikes = uniqueNumbers(slot.strikes);
        util::market::sortNumbers(slot.strikes);
        byClass.set(tc, js::object({{u"expiries"_s, stringsJson(slot.expiries)}, {u"strikes"_s, numbersJson(slot.strikes)}}));
    }
    QStringList classes;
    for (const OptChainParam& p : chosen) classes.append(p.tradingClass);
    co_return js::object({{u"symbol"_s, js::S(symbol)},
                          {u"expiries"_s, stringsJson(expiries)},
                          {u"strikes"_s, numbersJson(strikes)},
                          {u"by_class"_s, byClass},
                          {u"trading_classes"_s, stringsJson(uniqueSortedStrings(classes))},
                          {u"exchange"_s, js::S(!chosen.empty() ? chosen[0].exchange : cfg ? cfg->exchange : u"SMART"_s)}});
}

Task<OJson> BrokerRouter::optionChain(QString symbol, std::optional<QString> expiry, double width, std::optional<double> span, QString preferClass) {
    width = util::jsmath::max(3, util::jsmath::min(std::trunc(width), double(kChainMaxWidth)));
    const OJson meta = co_await optionExpiries(symbol);
    const OJson* expiriesP = prop(meta, u"expiries"_s);
    if (expiriesP->items.isEmpty()) throw BrokerError(u"%1 没有可用的到期日"_s.arg(symbol));
    const QString targetExpiry = expiry ? *expiry : expiriesP->items[0].s;
    const auto hasExpiry = [&](const QString& e) {
        return std::any_of(expiriesP->items.begin(), expiriesP->items.end(), [&](const OJson& x) { return x.s == e; });
    };
    if (!hasExpiry(targetExpiry)) {
        QStringList first;
        for (qsizetype i = 0; i < expiriesP->items.size() && i < 5; ++i) first.append(expiriesP->items[i].s);
        throw BrokerError(u"%1 没有 %2 这个到期日。最近的几个:"_s.arg(symbol, targetExpiry) + first.join(u"、"_s));
    }
    const std::optional<double> spot = co_await indexPrice(symbol);
    if (!spot || *spot == 0 || std::isnan(*spot)) throw BrokerError(u"拿不到 %1 的现价,无法判断该取哪些行权价。"_s.arg(symbol));

    const contract::IndexConfig* cfg = settings.indexConfig(symbol);
    const OJson* byClassP = prop(meta, u"by_class"_s);
    const QString tradingClass = pickTradingClass(symbol, cfg, js::nullish(byClassP) ? js::object() : *byClassP, targetExpiry, preferClass);
    // 行权价也按挑中的那条链取:两条链的网格粒度不同(SPXW 比 SPX 密),用并集选出来的价位可能在这条链上根本不存在。
    const OJson* gridJson = js::path(&meta, {u"by_class"_s, tradingClass, u"strikes"_s});
    if (!gridJson) gridJson = prop(meta, u"strikes"_s);
    std::vector<double> grid;
    for (const OJson& k : gridJson->items) grid.push_back(js::num(&k));
    if (grid.empty()) throw BrokerError(u"%1 的行权价网格为空"_s.arg(symbol));
    // 订哪些档是纯函数(ibContracts.chainStrikes):给了 span 也不超过 2 × width + 1 档,行情线路不比不给时多
    const std::vector<double> band = chainStrikes(grid, *spot, width, span);

    const SessionPtr session = marketSession();
    const QString exchange = cfg ? cfg->exchange : u"SMART"_s;

    std::vector<IbContract> contracts;
    for (const double strike : band) {
        for (const QString& right : {u"C"_s, u"P"_s}) {
            contracts.push_back(optionContract(symbol, targetExpiry, strike, right, exchange, u"USD"_s, u"100"_s, tradingClass));
        }
    }

    QList<OJson> rows;
    std::vector<std::pair<IbContract, std::shared_ptr<TickerHandle>>> tickers;
    std::exception_ptr failure;
    try {
        session->reqMarketDataType(3);
        // 批量 qualify:逐个发会把超时预算乘以合约数
        std::exception_ptr qualifyFailure;
        try {
            std::vector<IbContract*> ptrs;
            for (IbContract& c : contracts) ptrs.push_back(&c);
            co_await session->qualifyContracts(ptrs, kQualifyTimeoutMs * 2);
        } catch (...) {
            qualifyFailure = std::current_exception();
        }
        if (qualifyFailure) throw BrokerError(stalledMessage());
        std::vector<const IbContract*> liveContracts;
        for (const IbContract& c : contracts) {
            if (c.conId && *c.conId != 0) liveContracts.push_back(&c);
        }
        if (liveContracts.empty()) throw BrokerError(u"%1 %2 这条链一个合约都确认不了(到期日或行权价可能不存在)"_s.arg(symbol, targetExpiry));
        // 100=成交量 101=持仓量 106=隐含波动率(带模型 greeks)
        for (const IbContract* c : liveContracts) tickers.emplace_back(*c, session->subscribeTicker(*c, u"100,101,106"_s));
        co_await session->settle(kChainWaitMs);
        for (const auto& [contract, handle] : tickers) {
            const TickerData t = handle->read();
            const bool isCall = contract.right && *contract.right == u"C";
            const std::optional<double>& oi = isCall ? t.callOpenInterest : t.putOpenInterest;
            const std::optional<double>& vol = isCall ? t.callVolume : t.putVolume;
            const std::optional<ModelGreeks>& greeks = t.modelGreeks;
            rows.append(js::object({{u"strike"_s, js::N(contract.strike.value_or(std::nan("")))},
                                    {u"right"_s, contract.right ? js::S(*contract.right) : js::Null()},
                                    // 没等到这一笔是不知道,不是 0 张
                                    {u"oi"_s, !oi ? js::Null() : js::N(cleanPrice(oi).value_or(0.0))},
                                    {u"volume"_s, js::N(cleanPrice(vol).value_or(0.0))},
                                    {u"gamma"_s, greeks ? detail::numOrNull(cleanPrice(greeks->gamma)) : js::Null()},
                                    {u"iv"_s, greeks ? detail::numOrNull(cleanPrice(greeks->impliedVol)) : js::Null()}}));
        }
    } catch (...) {
        failure = std::current_exception();
    }
    session->reqMarketDataType(1);
    for (const auto& [contract, handle] : tickers) {
        try {
            // 只撤期权链自己这条带 greeks 的流:缓存键带上 generic ticks 之后,同一条腿的普通流(持仓盯盘、追踪用的)是另一条,撤错了盯盘就没价了
            session->cancelTicker(contract, u"100,101,106"_s);  // 不撤会一直占着行情线路配额
        } catch (...) {
            /* ignore */
        }
    }
    if (failure) std::rethrow_exception(failure);
    OJson expiriesOut = js::array();
    for (qsizetype i = 0; i < expiriesP->items.size() && i < 20; ++i) expiriesOut.items.append(expiriesP->items[i]);
    OJson rowsJson = js::array(rows);
    double gridCount = 0;
    const double lo = band.empty() ? 0 : band.front(), hi = band.empty() ? 0 : band.back();
    for (const double k : grid) {
        if (k >= lo && k <= hi) gridCount += 1;
    }
    co_return js::object({{u"symbol"_s, js::S(symbol)},
                          {u"expiry"_s, js::S(targetExpiry)},
                          {u"spot"_s, js::N(*spot)},
                          {u"expiries"_s, expiriesOut},
                          {u"rows"_s, rowsJson},
                          {u"multiplier"_s, js::N(100.0)},
                          {u"strike_count"_s, js::N(double(band.size()))},
                          {u"trading_class"_s, js::S(tradingClass)},
                          {u"grid_count"_s, js::N(gridCount)}});
}

/// 一档盘口 + Level 2 深度(若账户有订阅)。只读展示。
Task<OJson> BrokerRouter::orderBook(QString symbol, int rows) {
    const auto live = sessions();
    const SessionPtr session = live.empty() ? nullptr : live[0];
    if (!session) throw BrokerError(u"引擎未连接 TWS,无法读取盘口。请先在「TWS 连接」面板连接引擎。"_s);
    if (settings.indexConfig(symbol)) throw BrokerError(u"指数本身没有订单簿(不是可交易合约),请查对应 ETF(如 SPY)或成分股。"_s);
    IbContract target = stockContract(symbol);
    co_await qualifyOrRaise(session, &target);

    // liquidity 在最后一行补上(它要算完深度才知道);中途这份就是"还没算流动性"的样子
    OJson out = js::object({{u"symbol"_s, js::S(symbol)}, {u"l1"_s, js::object()}, {u"bids"_s, js::array()}, {u"asks"_s, js::array()}, {u"note"_s, js::S(QString())}});
    std::exception_ptr failure;
    try {
        session->reqMarketDataType(3);
        const std::shared_ptr<TickerHandle> ticker = session->subscribeTicker(target);
        co_await session->settle(1500);
        const TickerData t = ticker->read();
        const std::optional<double> bid = cleanPrice(t.bid);
        const std::optional<double> ask = cleanPrice(t.ask);
        std::optional<double> last = cleanPrice(t.last);
        if (!last) last = cleanPrice(t.close);
        OJson l1 = js::object({{u"bid"_s, detail::numOrNull(bid)},
                               {u"ask"_s, detail::numOrNull(ask)},
                               {u"bid_size"_s, t.bidSize && !std::isnan(*t.bidSize) ? detail::numOrNull(cleanPrice(t.bidSize)) : js::Null()},
                               {u"ask_size"_s, t.askSize && !std::isnan(*t.askSize) ? detail::numOrNull(cleanPrice(t.askSize)) : js::Null()},
                               {u"last"_s, detail::numOrNull(last)}});
        if (bid && *bid != 0 && ask && *ask != 0 && *ask >= *bid) {
            const double mid = (*bid + *ask) / 2.0;
            l1.set(u"spread"_s, js::N(util::pyRound(*ask - *bid, 4)));
            l1.set(u"spread_bps"_s, mid != 0 ? js::N(util::pyRound(((*ask - *bid) / mid) * 10'000, 1)) : js::Null());
        }
        out.set(u"l1"_s, l1);
    } catch (...) {
        failure = std::current_exception();
    }
    session->reqMarketDataType(1);
    try {
        // 用完即撤,不撤会占行情线路配额。只撤自己订的那条(不带 generic ticks):不传会连同异动监控挂在同一只股上的量能流一起撤掉
        session->cancelTicker(target, QString());
    } catch (...) {
        /* ignore */
    }
    if (failure) std::rethrow_exception(failure);

    std::optional<QString> depthError;
    try {
        const Depth depth = co_await session->mktDepth(target, rows, 2000);
        const auto side = [](const std::vector<DepthRow>& v) {
            OJson a = js::array();
            for (const DepthRow& r : v) a.items.append(js::object({{u"price"_s, js::N(r.price)}, {u"size"_s, js::N(r.size)}}));
            return a;
        };
        out.set(u"bids"_s, side(depth.bids));
        out.set(u"asks"_s, side(depth.asks));
        if (depth.bids.empty() && depth.asks.empty()) {
            out.set(u"note"_s, js::S(u"未收到深度数据:Level 2 行情需要单独订阅(如 NASDAQ TotalView)。上方为一档盘口。"_s));
        }
    } catch (...) {
        depthError = messageOf(std::current_exception());
    }
    if (depthError) out.set(u"note"_s, js::S(u"深度不可用(Level 2 需订阅):%1"_s.arg(depthError->left(200))));
    out.set(u"liquidity"_s, bookLiquidity(out));
    co_return out;
}

/**
 * 一张组合(BAG)在某一天的分钟中间价——交易分析里的"蝶价走势"。IBKR 对组合合约支持历史数据(MIDPOINT),已到期的腿要带 includeExpired 才能 qualify;
 * 拿的是 endDateTime 往前一整天(含前一晚的全球时段),调用方自己裁。
 */
Task<QList<OJson>> BrokerRouter::comboBars(QString symbol, OJson legs, QString day, QString barSize) {
    const auto live = sessions();
    const SessionPtr session = live.empty() ? nullptr : live[0];
    if (!session) throw BrokerError(u"引擎未连接 TWS,无法获取蝶价分钟线。请先在「TWS 连接」面板连接引擎。"_s);
    IbContract bag;
    bag.hasComboLegs = true;
    for (const OJson& leg : legs.items) {
        IbContract opt;
        opt.secType = u"OPT"_s;
        opt.symbol = symbol;
        opt.exchange = u"SMART"_s;
        opt.currency = u"USD"_s;
        opt.lastTradeDateOrContractMonth = detail::strOr(prop(leg, u"lastTradeDateOrContractMonth"_s));
        opt.strike = js::nullish(prop(leg, u"strike"_s)) ? 0.0 : js::num(prop(leg, u"strike"_s));
        opt.right = detail::strOr(prop(leg, u"right"_s));
        opt.tradingClass = detail::strOr(prop(leg, u"tradingClass"_s));
        opt.multiplier = u"100"_s;
        opt.conId = 0;
        opt.includeExpired = true;
        co_await qualifyOrRaise(session, &opt);
        ComboLeg cl;
        cl.conId = opt.conId.value_or(0);
        const auto ratio = detail::truncOrNull(prop(leg, u"ratio"_s), 1);
        cl.ratio = ratio ? *ratio : 1;
        const OJson* a = prop(leg, u"action"_s);
        cl.action = js::nullish(a) ? u"BUY"_s : js::str(a);
        cl.exchange = u"SMART"_s;
        bag.comboLegs.push_back(cl);
    }
    bag.secType = u"BAG"_s;
    bag.symbol = symbol;
    bag.exchange = u"SMART"_s;
    bag.currency = u"USD"_s;
    bag.conId = 0;
    const QString endUtc = util::ibEndUtc(day);
    std::vector<RawBar> raw;
    std::exception_ptr failure;
    std::optional<QString> brokerMessage;
    try {
        session->reqMarketDataType(3);
        HistoricalRequest req;
        req.endDateTime = endUtc;
        req.durationStr = u"1 D"_s;
        req.barSizeSetting = barSize;
        req.whatToShow = u"MIDPOINT"_s;
        req.useRTH = false;
        raw = co_await session->historicalData(bag, req);
    } catch (...) {
        failure = std::current_exception();
        brokerMessage = messageOf(failure);
    }
    session->reqMarketDataType(1);
    if (failure) throw BrokerError(u"获取 %1 组合分钟线失败:%2"_s.arg(symbol, *brokerMessage));
    QList<OJson> out;
    for (const RawBar& b : raw) {
        out.append(js::object({{u"time"_s, js::S(barTimestamp(b.date))}, {u"open"_s, js::N(b.open)}, {u"high"_s, js::N(b.high)},
                               {u"low"_s, js::N(b.low)}, {u"close"_s, js::N(b.close)}}));
    }
    co_return out;
}

}  // namespace ibkr::execution
