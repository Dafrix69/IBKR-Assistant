// 日内剧本(playbook)对拍用的假件的 C++ 一半:假 IB 会话、假盘口读取、按日期答日线收盘的 router、剧本专用的步(files / logwrite / chmod / restart 里
// 不需要服务的部分)。与 tests/fixtures/svc1_playbook_world.mjs 一句对一句——队列的键与日志的样子在那个文件的开头写着;改任何一边都要同时改另一边。
#pragma once

#include "execution/ib_types.h"
#include "execution/option_marks.h"
#include "svc1_world.h"
#include "util/jsformat.h"
#include "util/jsvalue.h"

#include <QDir>
#include <QFile>

#include <sys/stat.h>

#include <algorithm>

namespace sw {

/// broker_world.mjs 的 norm():只留有值的键,键序固定
inline OJson normContract(const ibkr::execution::IbContract& c) {
    OJson o = js::object();
    o.set(u"secType"_s, js::S(c.secType));
    o.set(u"symbol"_s, js::S(c.symbol));
    o.set(u"exchange"_s, js::S(c.exchange));
    o.set(u"currency"_s, js::S(c.currency));
    if (c.lastTradeDateOrContractMonth) o.set(u"lastTradeDateOrContractMonth"_s, js::S(*c.lastTradeDateOrContractMonth));
    if (c.strike) o.set(u"strike"_s, js::N(*c.strike));
    if (c.right) o.set(u"right"_s, js::S(*c.right));
    if (c.multiplier) o.set(u"multiplier"_s, js::S(*c.multiplier));
    if (c.tradingClass) o.set(u"tradingClass"_s, js::S(*c.tradingClass));
    if (c.conId) o.set(u"conId"_s, js::N(*c.conId));
    if (c.includeExpired) o.set(u"includeExpired"_s, js::B(true));
    return o;
}

/// makeSettings(svc1_world.h)的一份:库路径可以由脚本的 dbPath 指定(缺省 "/t.db"),为的是测 path.dirname 的各种写法
inline ibkr::domain::Settings makePbSettings(const OJson& base, const World& w, const OJson* patch = nullptr) {
    OJson raw = base;
    if (const OJson* s = w.script().get(u"settings"_s)) raw = ibkr::domain::deepMerge(raw, *s);
    if (patch) raw = ibkr::domain::deepMerge(raw, *patch);
    raw.set(u"storage"_s, js::object({{u"db_path"_s, js::S(w.dir.path() + str(w.script(), u"dbPath"_s, u"/t.db"_s))}}));
    return ibkr::domain::fromDict(raw);
}

/// 假 IB 会话(队列 session.managed / session.qualify / session.historicalData|<键>)
class PbSession : public ibkr::execution::IbSession {
public:
    explicit PbSession(World& w) : w_(w) {}

    bool isConnected() override { return true; }
    Task<> disconnect() override { qFatal("playbook 不该断开会话"); }
    QStringList managedAccounts() override {
        w_.rec(u"session.managedAccounts"_s, js::array());
        const OJson e = w_.next(u"session.managed"_s, js::object({{u"ok"_s, js::strings({u"DU7654321"_s})}}));
        if (const OJson* err = e.get(u"err"_s)) std::rethrow_exception(makeError(*err));
        QStringList out;
        for (const OJson& x : jsfix::dec(*e.get(u"ok"_s)).items) out.append(js::str(&x));
        return out;
    }
    Task<> qualifyContracts(std::vector<ibkr::execution::IbContract*> contracts, int timeoutMs) override {
        QList<OJson> logged;
        for (const auto* c : contracts) logged << normContract(*c);
        w_.rec(u"session.qualifyContracts"_s, js::array({js::array(logged), js::N(timeoutMs)}));
        const OJson ok = co_await w_.answer<OJson>(w_.next(u"session.qualify"_s, js::object({{u"ok"_s, js::B(true)}})), [](const OJson& v) { return v; });
        for (auto* c : contracts) {
            if (ok.type == OJson::Bool && ok.b) {
                c->conId = c->secType == u"IND" ? 416904 : int(900000 + c->strike.value_or(0) * 2 + (c->right && *c->right == u"C" ? 1 : 0));
            } else if (ok.type == OJson::Number) {
                c->conId = int(ok.n);
            }
        }
    }
    void reqMarketDataType(int) override { qFatal("playbook 不该改行情类型"); }
    std::shared_ptr<ibkr::execution::TickerHandle> subscribeTicker(const ibkr::execution::IbContract&, const QString&) override { qFatal("playbook 不该订流"); }
    void cancelTicker(const ibkr::execution::IbContract&, const std::optional<QString>&) override { qFatal("playbook 不该撤流"); }
    Task<> settle(int) override { qFatal("playbook 不该等行情"); }
    Task<std::vector<ibkr::execution::RawBar>> historicalData(ibkr::execution::IbContract contract, ibkr::execution::HistoricalRequest opts) override {
        w_.rec(u"session.historicalData"_s,
               js::array({normContract(contract), js::object({{u"endDateTime"_s, js::S(opts.endDateTime)},
                                                               {u"durationStr"_s, js::S(opts.durationStr)},
                                                               {u"barSizeSetting"_s, js::S(opts.barSizeSetting)},
                                                               {u"whatToShow"_s, js::S(opts.whatToShow)},
                                                               {u"useRTH"_s, js::B(opts.useRTH)}})}));
        const QString key = contract.secType == u"IND"
                                ? contract.symbol
                                : u"%1 %2%3"_s.arg(contract.lastTradeDateOrContractMonth.value_or(QString()), ibkr::util::jsNumberToString(contract.strike.value_or(0)),
                                                   contract.right.value_or(QString()));
        const OJson entry = w_.has(u"session.historicalData|"_s + key) ? w_.next(u"session.historicalData|"_s + key, js::object({{u"ok"_s, js::array()}}))
                                                                        : w_.next(u"session.historicalData|*"_s, js::object({{u"ok"_s, js::array()}}));
        co_return co_await w_.answer<std::vector<ibkr::execution::RawBar>>(entry, [](const OJson& v) {
            std::vector<ibkr::execution::RawBar> out;
            for (const OJson& b : v.items) {
                ibkr::execution::RawBar bar;
                bar.date = js::strOr(js::prop(&b, u"date"_s), QString());
                bar.open = js::num(js::prop(&b, u"open"_s));
                bar.high = js::num(js::prop(&b, u"high"_s));
                bar.low = js::num(js::prop(&b, u"low"_s));
                bar.close = js::num(js::prop(&b, u"close"_s));
                out.push_back(bar);
            }
            return out;
        });
    }
    Task<std::vector<ibkr::execution::OptChainParam>> secDefOptParams(QString, QString, int) override { qFatal("playbook 不该问期权链参数"); }
    Task<ibkr::execution::Depth> mktDepth(ibkr::execution::IbContract, int, int) override { qFatal("playbook 不该问深度"); }
    Task<ibkr::execution::TradeLike> placeOrder(ibkr::execution::IbContract, ibkr::execution::OrderIntent) override { qFatal("playbook 不下单"); }
    Task<std::vector<ibkr::execution::OpenTrade>> openTrades() override { qFatal("playbook 不问挂单"); }
    Task<> cancelOrder(int) override { qFatal("playbook 不撤单"); }
    Task<std::vector<ibkr::execution::PortfolioItemLike>> portfolio() override { qFatal("playbook 不问组合"); }
    Task<std::vector<ibkr::execution::PositionItemLike>> positions() override { qFatal("playbook 不问持仓"); }
    void onConnectivity(std::function<void(int)>) override { qFatal("playbook 不听连接事件"); }

private:
    World& w_;
};

/// 假盘口读取(队列 marks.read)
class PbMarks : public orch::MarksPort {
public:
    explicit PbMarks(World& w) : w_(w) {}
    Task<std::vector<ibkr::execution::OptionMark>> read(std::shared_ptr<ibkr::execution::IbSession>, std::vector<ibkr::execution::OptionLegSpec> legs, bool delayedOk,
                                                         double silentLimitMs) override {
        QList<OJson> logged;
        for (const auto& l : legs) {
            logged << js::object({{u"symbol"_s, js::S(l.symbol)},
                                  {u"expiry"_s, js::S(l.expiry)},
                                  {u"strike"_s, js::N(l.strike)},
                                  {u"right"_s, js::S(l.right)},
                                  {u"exchange"_s, js::S(l.exchange)},
                                  {u"tradingClass"_s, js::S(l.tradingClass)}});
        }
        w_.rec(u"marks.read"_s, js::array({js::array(logged), js::B(delayedOk), js::N(silentLimitMs)}));
        return w_.answer<std::vector<ibkr::execution::OptionMark>>(w_.next(u"marks.read"_s, js::object({{u"ok"_s, js::array()}})), [](const OJson& v) {
            std::vector<ibkr::execution::OptionMark> out;
            for (const OJson& m : v.items) {
                ibkr::execution::OptionMark mark;
                mark.strike = js::num(js::prop(&m, u"strike"_s));
                mark.right = js::strOr(js::prop(&m, u"right"_s), QString());
                const auto optNum = [&](const QString& k) -> std::optional<double> {
                    const OJson* x = js::prop(&m, k);
                    return js::nullish(x) ? std::nullopt : std::optional<double>(js::num(x));
                };
                mark.bid = optNum(u"bid"_s);
                mark.ask = optNum(u"ask"_s);
                mark.iv = optNum(u"iv"_s);
                const OJson* err = js::prop(&m, u"error"_s);
                if (!js::nullish(err)) mark.error = js::str(err);
                out.push_back(mark);
            }
            return out;
        });
    }

private:
    World& w_;
};

/// 假 router:FakeRouter,只把 historicalBars 换成按 start 日期取队列的(router.historicalBars|<start>,没有就 |*)
class PbRouter : public FakeRouter {
public:
    PbRouter(World& w, OJson initial) : FakeRouter(w, std::move(initial)), pw_(w) {}
    Task<QList<OJson>> historicalBars(QString symbol, QString start, QString end) override {
        pw_.rec(u"router.historicalBars"_s, js::array({js::S(symbol), js::S(start), js::S(end)}));
        return pw_.answer<QList<OJson>>(pw_.nextFor(u"router.historicalBars"_s, start, js::object({{u"ok"_s, js::array()}})), [](const OJson& v) { return v.items; });
    }

private:
    World& pw_;
};

/// files / logwrite / chmod 三个步(restart 要服务,由 Runner 自己登记)
inline void registerPbOps(Ctx& c) {
    const auto dir = [&c] { return c.w.dir.path() + u"/playbook"_s; };
    c.extraOps[u"files"_s] = [dir](const OJson& step, OJson& rec) {
        QStringList names = QDir(dir()).entryList(QDir::Files, QDir::Name);
        std::sort(names.begin(), names.end());
        QList<OJson> out;
        for (const QString& name : names) {
            if (flag(step, u"namesOnly"_s)) {
                out << js::object({{u"name"_s, js::S(name)}});
                continue;
            }
            QFile f(dir() + u'/' + name);
            if (!f.open(QIODevice::ReadOnly)) qFatal("files 读不了 %s", qPrintable(f.fileName()));
            out << js::object({{u"name"_s, js::S(name)}, {u"text"_s, js::S(ibkr::util::nodeUtf8(f.readAll()))}});
        }
        rec.set(u"files"_s, js::array(out));
    };
    c.extraOps[u"logwrite"_s] = [dir](const OJson& step, OJson&) {
        QDir().mkpath(dir());
        QStringList dates;
        if (const OJson* ds = step.get(u"dates"_s)) {
            for (const OJson& d : ds->items) dates.append(js::str(&d));
        } else {
            dates.append(str(step, u"date"_s));
        }
        for (const QString& date : dates) {
            QFile f(dir() + u'/' + date + u".jsonl"_s);
            if (!f.open(QIODevice::WriteOnly | QIODevice::Append)) qFatal("logwrite 打不开 %s", qPrintable(f.fileName()));
            for (const OJson& line : step.get(u"lines"_s)->items) {
                const QString text = line.type == OJson::String ? line.s : js::stringify(line);
                f.write(ibkr::util::toNodeUtf8(text + u'\n'));
            }
        }
    };
    c.extraOps[u"chmod"_s] = [&c](const OJson& step, OJson&) {
        const QString path = c.w.dir.path() + u'/' + str(step, u"path"_s);
        if (::chmod(path.toUtf8().constData(), mode_t(num(step, u"mode"_s))) != 0) qFatal("chmod 失败 %s", qPrintable(path));
    };
}

}  // namespace sw
