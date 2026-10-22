#include "transport/handlers/screener.h"

#include "analysis/leaders.h"
#include "analysis/screener.h"
#include "analysis/signal_outcomes.h"
#include "domain/config.h"
#include "orchestrate/services/svc_util.h"
#include "transport/handlers/handlers2_support.h"
#include "transport/params.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/rpc_error.h"

#include <QSet>

using namespace Qt::StringLiterals;

namespace ibkr::rpc {

using util::OJson;
namespace js = util::js;
namespace scr = analysis::screener;

const QStringList ScreenerHandlers::kScreenTimeframes = {u"1w"_s, u"1d"_s, u"1h"_s, u"30m"_s, u"15m"_s};

namespace {

OJson arrayOf(const QList<OJson>& items) { return js::array(items); }

QString isoNow(double epochMs) { return orchestrate::isoMsZ(epochMs); }

/// /^\d{4}-\d{2}-\d{2}$/.test(String(v)):v 不是串当作不匹配
bool isDayString(const OJson* v) {
    if (!js::isStr(v) || v->s.size() != 10) return false;
    for (int i = 0; i < 10; ++i) {
        const QChar c = v->s[i];
        if (i == 4 || i == 7) {
            if (c != u'-') return false;
        } else if (c < u'0' || c > u'9') {
            return false;
        }
    }
    return true;
}

}  // namespace

MethodTable ScreenerHandlers::methods() {
    return contractTable({
        {u"screener.rs"_s, [this](OJson p) { return screenerRs(std::move(p)); }},
        {u"screener.inflection"_s, [this](OJson p) { return screenerInflection(std::move(p)); }},
        {u"screener.deviation"_s, [this](OJson p) { return screenerDeviation(std::move(p)); }},
        {u"screener.leaders"_s, [this](OJson p) { return screenerLeaders(std::move(p)); }},
    });
}

// ---- 扫描器:RS 强度 / 拐点筛选 / 极值偏离(纯代码计算,只读)------------

/// 按板块 id 取成分股;"all" / 空 = 所有板块并集(同一只股以先出现的板块为准)。
ScreenerHandlers::Members ScreenerHandlers::screenMembers(const OJson& params) {
    const QString sectorId = util::jsTrim(js::strOr(js::prop(&params, u"sector"_s), QString()));
    QList<OJson> sectors = ports_.store().listSectors();
    if (!sectorId.isEmpty() && sectorId != u"all") {
        QList<OJson> kept;
        for (const OJson& s : sectors) {
            const OJson* id = js::prop(&s, u"id"_s);
            if (js::isStr(id) && id->s == sectorId) kept.append(s);
        }
        sectors = kept;
        if (sectors.isEmpty()) throw util::RpcError(-32602, u"板块不存在:%1"_s.arg(sectorId));
    }
    QSet<QString> seen;
    QList<OJson> members;
    for (const OJson& sector : sectors) {
        const OJson* stocks = js::prop(&sector, u"stocks"_s);
        if (!stocks) continue;
        for (const OJson& stock : stocks->items) {
            const QString symbol = js::strOr(js::prop(&stock, u"symbol"_s), QString()).toUpper();
            if (symbol.isEmpty() || seen.contains(symbol)) continue;
            seen.insert(symbol);
            const OJson* tag = js::prop(&stock, u"tag"_s);
            const OJson* company = js::prop(&stock, u"company"_s);
            members.append(js::object({{u"symbol"_s, js::S(symbol)},
                                       {u"tag"_s, js::truthy(tag) ? *tag : js::S(QString())},
                                       {u"company"_s, js::truthy(company) ? *company : js::S(QString())}}));
        }
    }
    if (members.isEmpty()) throw util::RpcError(-32602, u"股票池是空的:先在「板块」页加成分股"_s);
    const QString label = sectors.size() != 1 ? u"全部板块"_s : js::str(js::prop(&sectors[0], u"name"_s));
    return {label, members};
}

util::Task<OJson> ScreenerHandlers::screenBars(QString symbol, QString timeframe) {
    if (timeframe == u"1d") co_return arrayOf(co_await ports_.market().dailyHistory(symbol, orchestrate::MarketDataService::kHistSpanDays));
    if (timeframe == u"1w") {
        const OJson daily = arrayOf(co_await ports_.market().dailyHistory(symbol, orchestrate::MarketDataService::kHistSpanDays));
        co_return scr::resampleWeekly(&daily);
    }
    const orchestrate::PaBars pa = co_await ports_.market().paBars(symbol, timeframe, false, false, false);
    OJson bars = js::array();
    for (const execution::SessionBar& b : pa.bars.bars) {
        bars.items.append(js::object({{u"time"_s, js::S(b.time)},
                                      {u"open"_s, js::N(b.open)},
                                      {u"high"_s, js::N(b.high)},
                                      {u"low"_s, js::N(b.low)},
                                      {u"close"_s, js::N(b.close)},
                                      {u"volume"_s, js::N(b.volume)}}));
    }
    co_return bars;
}

util::Task<OJson> ScreenerHandlers::screenerRs(OJson params) {
    const QString benchmark = util::jsTrim(js::strOr(js::prop(&params, u"benchmark"_s), u"SPY"_s)).toUpper();
    if (!scr::rsBenchmarks().contains(benchmark)) {
        throw util::RpcError(-32602, u"基准只能是 %1"_s.arg(scr::rsBenchmarks().join(u" / "_s)));
    }
    Members m = screenMembers(params);
    if (!liveRouter(ports_)) throw needConnection(-32018, u"RS 强度扫描"_s);
    OJson bench;
    try {
        bench = arrayOf(co_await ports_.market().dailyHistory(benchmark, orchestrate::MarketDataService::kHistSpanDays));
    } catch (...) {
        throw util::RpcError(-32018, u"拿不到基准 %1 的日线:%2"_s.arg(benchmark, util::errText(std::current_exception())));
    }
    for (OJson& member : m.members) {
        try {
            const OJson bars = arrayOf(co_await ports_.market().dailyHistory(js::str(js::prop(&member, u"symbol"_s)), orchestrate::MarketDataService::kHistSpanDays));
            member.set(u"bars"_s, bars);
        } catch (...) {
            member.set(u"bars"_s, js::array());
            member.set(u"error"_s, js::S(util::errText(std::current_exception())));
        }
    }
    OJson out = scr::rsStrength(arrayOf(m.members), &bench, benchmark, scr::rsWindows());
    out.set(u"sector"_s, js::S(m.label));
    out.set(u"fetched_at"_s, js::S(isoNow(domain::nowEt().epochMs)));
    co_return out;
}

/// 强势股筛选:趋势模板 + VCP + RS 评级 + 大盘方向(leaders.ts)。日线与 RS 强度同一条 10 分钟缓存,先扫过 RS 就不再拉。
/// 只读行情;唯一的落库是把今天新进第二阶段的记进信号日志。
util::Task<OJson> ScreenerHandlers::screenerLeaders(OJson params) {
    const QString benchmark = util::jsTrim(js::strOr(js::prop(&params, u"benchmark"_s), u"SPY"_s)).toUpper();
    if (!scr::rsBenchmarks().contains(benchmark)) {
        throw util::RpcError(-32602, u"基准只能是 %1"_s.arg(scr::rsBenchmarks().join(u" / "_s)));
    }
    Members m = screenMembers(params);
    if (!liveRouter(ports_)) throw needConnection(-32018, u"强势股筛选"_s);
    OJson bench;
    try {
        bench = arrayOf(co_await ports_.market().dailyHistory(benchmark, orchestrate::MarketDataService::kHistSpanDays));
    } catch (...) {
        throw util::RpcError(-32018, u"拿不到基准 %1 的日线:%2"_s.arg(benchmark, util::errText(std::current_exception())));
    }
    QList<analysis::leaders::LeaderMember> scanned;
    for (const OJson& member : m.members) {
        analysis::leaders::LeaderMember lm;
        lm.symbol = js::str(js::prop(&member, u"symbol"_s));
        lm.tag = js::str(js::prop(&member, u"tag"_s));
        lm.company = js::str(js::prop(&member, u"company"_s));
        try {
            lm.bars = arrayOf(co_await ports_.market().dailyHistory(js::str(js::prop(&member, u"symbol"_s)), orchestrate::MarketDataService::kHistSpanDays));
        } catch (...) {
            lm.bars = js::array();
            lm.error = js::S(util::errText(std::current_exception()));
        }
        scanned.append(std::move(lm));
    }
    OJson result = analysis::leaders::screenLeaders(scanned, bench, benchmark);
    // 今天新进第二阶段的记一笔,之后按 1 / 5 / 20 天的走势打分(信号成绩单)。同一只在同一根日线上只记一次:
    // 一天里扫几遍、周末或下周一盘前(最新一根还是周五)再扫,都不重复
    const domain::EtNow moment = domain::nowEt();
    QList<OJson> rows;
    if (const OJson* r = js::prop(&result, u"rows"_s)) rows = r->items;
    const OJson fresh = analysis::leaders::newStage2(scanned, bench, benchmark, rows);
    const OJson* freshRows = js::prop(&fresh, u"rows"_s);
    const OJson* freshDay = js::prop(&fresh, u"day"_s);
    if (freshRows && !freshRows->items.isEmpty() && isDayString(freshDay)) {
        QList<OJson> entries;
        for (const OJson& row : freshRows->items) entries.append(analysis::signal_outcomes::signalFromLeader(row, moment.epochMs));
        ports_.store().signalLog().logOnce(entries, analysis::signal_outcomes::etDayStart(freshDay->s));
    }
    result.set(u"sector"_s, js::S(m.label));
    result.set(u"fetched_at"_s, js::S(isoNow(moment.epochMs)));
    co_return result;
}

util::Task<OJson> ScreenerHandlers::screenerInflection(OJson params) {
    const OJson* rawProp = js::prop(&params, u"timeframes"_s);
    const OJson rawTfs = js::truthy(rawProp) ? *rawProp : js::array({js::S(u"1d"_s), js::S(u"1w"_s)});
    if (rawTfs.type != OJson::Array || rawTfs.items.isEmpty()) throw util::RpcError(-32602, u"timeframes 要是非空数组"_s);
    QStringList timeframes;
    for (const OJson& raw : rawTfs.items) {
        const QString tf = js::str(&raw);
        if (!kScreenTimeframes.contains(tf)) {
            throw util::RpcError(-32602, u"未知周期:%1(可选:%2)"_s.arg(tf, kScreenTimeframes.join(u"、"_s)));
        }
        if (!timeframes.contains(tf)) timeframes << tf;
    }
    const std::optional<double> maPeriod = optInt(js::prop(&params, u"ma_period"_s));
    if (maPeriod && !(*maPeriod >= 2 && *maPeriod <= 250)) {
        throw util::RpcError(-32602, u"确认均线周期要在 2~250 之间"_s);
    }
    Members m = screenMembers(params);
    if (!liveRouter(ports_)) throw needConnection(-32018, u"拐点筛选"_s);

    QStringList intraday;
    for (const QString& tf : timeframes)
        if (tf != u"1d" && tf != u"1w") intraday << tf;
    int budget = kScreenIntradayCap;
    for (OJson& member : m.members) {
        member.set(u"frames"_s, js::object());
        member.set(u"errors"_s, js::object());
        const QString symbol = js::str(js::prop(&member, u"symbol"_s));
        for (const QString& tf : timeframes) {
            if (intraday.contains(tf)) {
                if (budget <= 0) {
                    js::propMut(&member, u"errors"_s)->set(tf, js::S(u"本次日内请求已达上限 %1,稍后再扫"_s.arg(kScreenIntradayCap)));
                    continue;
                }
                budget -= 1;
            }
            try {
                const OJson bars = co_await screenBars(symbol, tf);
                js::propMut(&member, u"frames"_s)->set(tf, bars);
            } catch (...) {
                js::propMut(&member, u"errors"_s)->set(tf, js::S(util::errText(std::current_exception())));
            }
        }
    }
    OJson out = scr::screenInflections(arrayOf(m.members), timeframes, maPeriod);
    out.set(u"sector"_s, js::S(m.label));
    out.set(u"fetched_at"_s, js::S(isoNow(domain::nowEt().epochMs)));
    co_return out;
}

util::Task<OJson> ScreenerHandlers::screenerDeviation(OJson params) {
    const QString symbol = symbolOrRaise(params);
    const QString timeframe = js::strOr(js::prop(&params, u"timeframe"_s), u"1d"_s);
    if (!kScreenTimeframes.contains(timeframe)) {
        throw util::RpcError(-32602, u"未知周期:%1(可选:%2)"_s.arg(timeframe, kScreenTimeframes.join(u"、"_s)));
    }
    const double period = optInt(js::prop(&params, u"period"_s)).value_or(scr::kDefaultDevPeriod);
    const double lookback = optInt(js::prop(&params, u"lookback"_s)).value_or(scr::kDefaultDevLookback);
    const double smooth = optInt(js::prop(&params, u"smooth"_s)).value_or(scr::kDefaultPressureSmooth);
    const std::optional<double> zRaw = optFloat(js::prop(&params, u"z_extreme"_s));
    const double zExtreme = zRaw && *zRaw != 0 ? *zRaw : scr::kDefaultZExtreme;  // optFloat(...) || DEFAULT(0 → 默认)
    if (!(period >= 2 && period <= 250) || !(lookback >= 10 && lookback <= 500) || !(smooth >= 1 && smooth <= 50)) {
        throw util::RpcError(-32602, u"参数越界:均线 2~250、历史 10~500、平滑 1~50"_s);
    }
    if (!(zExtreme >= 0.5 && zExtreme <= 5.0)) throw util::RpcError(-32602, u"极值阈值要在 0.5~5 个标准差之间"_s);
    if (!liveRouter(ports_)) throw needConnection(-32018, u"极值偏离"_s);
    OJson bars;
    try {
        bars = co_await screenBars(symbol, timeframe);
    } catch (...) {
        throw util::RpcError(-32018, u"拿不到 %1 的 %2 K 线:%3"_s.arg(symbol, timeframe, util::errText(std::current_exception())));
    }
    OJson out = scr::deviationReview(&bars, period, lookback, smooth, zExtreme);
    out.set(u"symbol"_s, js::S(symbol));
    out.set(u"timeframe"_s, js::S(timeframe));
    out.set(u"fetched_at"_s, js::S(isoNow(domain::nowEt().epochMs)));
    co_return out;
}

}  // namespace ibkr::rpc
