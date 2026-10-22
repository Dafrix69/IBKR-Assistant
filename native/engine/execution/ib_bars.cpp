#include "execution/ib_bars.h"

#include "util/error.h"
#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsvalue.h"
#include "util/py.h"
#include "util/tz.h"

#include <QRegularExpression>
#include <QSet>

#include <algorithm>
#include <cmath>
#include <limits>

namespace ibkr::execution {

using namespace Qt::StringLiterals;
using util::Task;

namespace {

QString numStr(double n) { return util::jsNumberToString(n); }

bool allDigits(const QString& s, qsizetype from, qsizetype count) {
    if (s.size() < from + count) return false;
    for (qsizetype i = from; i < from + count; ++i) {
        const char16_t c = s[i].unicode();
        if (c < u'0' || c > u'9') return false;
    }
    return true;
}

/// text.replace(/-/g, "").replace(/:/g, "").split(/\s+/).filter(Boolean)
QStringList splitTokens(const QString& text) {
    QString t = text;
    t.remove(u'-');
    t.remove(u':');
    static const QRegularExpression ws(u"["_s + util::jsSpaceClassBody() + u"]+"_s);
    const QString masked = util::jsMaskLoneSurrogates(t);
    QStringList out;
    qsizetype pos = 0;
    auto it = ws.globalMatch(masked);
    while (it.hasNext()) {
        const auto m = it.next();
        const QString piece = t.mid(pos, m.capturedStart() - pos);
        if (!piece.isEmpty()) out.append(piece);
        pos = m.capturedEnd();
    }
    const QString tail = t.mid(pos);
    if (!tail.isEmpty()) out.append(tail);
    return out;
}

constexpr int kDay = 1440;
constexpr int kWeek = 7 * kDay;

/// 一周里的分钟数(美东墙钟,周一 00:00 = 0)
int at(int weekday, int h, int m) { return weekday * kDay + h * 60 + m; }

using Windows = std::vector<std::pair<int, int>>;

/// 每条线一周里开着的几段 [起, 止)(美东墙钟的分钟数)。跨过周日 → 周一零点的那一段拆成两截,止于 WEEK 的那截不算收盘。
const Windows& schedule(SessionLeg leg) {
    static const Windows day = [] {
        Windows w;
        for (int d = 0; d <= 4; ++d) w.push_back({at(d, 4, 0), at(d, 20, 0)});
        return w;
    }();
    static const Windows overnight = [] {
        Windows w;
        w.push_back({0, at(0, 4, 0)});
        for (int d = 0; d <= 3; ++d) w.push_back({at(d, 20, 0), at(d + 1, 4, 0)});
        w.push_back({at(6, 20, 0), kWeek});
        return w;
    }();
    static const Windows index = [] {
        Windows w;
        for (int d = 0; d <= 4; ++d) w.push_back({at(d, 9, 30), at(d, 16, 0)});
        return w;
    }();
    static const Windows proxy = [] {
        Windows w;
        w.push_back({0, at(0, 9, 30)});
        for (int d = 0; d <= 3; ++d) w.push_back({at(d, 16, 0), at(d + 1, 9, 30)});
        w.push_back({at(4, 16, 0), at(4, 17, 0)});
        w.push_back({at(6, 18, 0), kWeek});
        return w;
    }();
    switch (leg) {
    case SessionLeg::Day: return day;
    case SessionLeg::Overnight: return overnight;
    case SessionLeg::Index: return index;
    case SessionLeg::Proxy: return proxy;
    }
    return day;
}

QString legName(SessionLeg leg) {
    switch (leg) {
    case SessionLeg::Day: return u"day"_s;
    case SessionLeg::Overnight: return u"overnight"_s;
    case SessionLeg::Index: return u"index"_s;
    case SessionLeg::Proxy: return u"proxy"_s;
    }
    return {};
}

struct YMD {
    int year, month, day;
};
/// 自 1970-01-01 起的天数 → 公历(UTC 的 getUTCFullYear / Month / Date)
YMD civilFromDays(long long z) {
    z += 719468;
    const long long era = (z >= 0 ? z : z - 146096) / 146097;
    const unsigned doe = static_cast<unsigned>(z - era * 146097);
    const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    const long long y = static_cast<long long>(yoe) + era * 400;
    const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const unsigned mp = (5 * doy + 2) / 153;
    const unsigned d = doy - (153 * mp + 2) / 5 + 1;
    const unsigned m = mp < 10 ? mp + 3 : mp - 9;
    return {static_cast<int>(y + (m <= 2)), static_cast<int>(m), static_cast<int>(d)};
}

struct WeekMinute {
    int minute;
    YMD monday;
};
WeekMinute weekMinute(double epochMs) {
    const util::WallParts p = util::wallParts(epochMs, QString::fromUtf16(util::kET));
    const int weekday = static_cast<int>(util::weekdayOfDate(u"%1-%2-%3"_s.arg(numStr(p.year), util::pad2(p.month), util::pad2(p.day))));  // 周一 = 0 … 周日 = 6
    const double ms = util::dateUtc(p.year, p.month - 1, p.day) - weekday * 86'400'000.0;
    return {static_cast<int>(weekday * kDay + p.hour * 60 + p.minute), civilFromDays(static_cast<long long>(std::floor(ms / 86'400'000.0)))};
}

QString errorText(const std::exception_ptr& e) {
    try {
        std::rethrow_exception(e);
    } catch (const util::JsError& x) {
        return x.message();
    } catch (const std::exception& x) {
        return QString::fromStdString(x.what());
    } catch (...) {
        return {};
    }
}

bool lessTime(const SessionBar& a, const SessionBar& b) { return a.time < b.time; }

constexpr int kIdleMax = 64;  // 闲着的那条最多留多少份

std::optional<BarsFeed> feedOf(const std::optional<bool>& delayed) {
    return !delayed ? BarsFeed::Unknown : (*delayed ? BarsFeed::Delayed : BarsFeed::Live);
}

}  // namespace

QString barTimestamp(const QString& value) {
    const QString text = util::jsTrim(value);
    const QStringList digits = splitTokens(text);
    if (!digits.isEmpty() && digits[0].size() == 8 && allDigits(digits[0], 0, 8)) {
        const QString& d = digits[0];
        const QString day = d.mid(0, 4) + u'-' + d.mid(4, 2) + u'-' + d.mid(6, 2);
        if (digits.size() > 1 && digits[1].size() >= 4 && allDigits(digits[1].left(6), 0, 6)) {
            // IBKR 的 K 线时间是交易所时区(SPX 在 Cboe → 美中),带时区名时换成美东再落字符串
            const bool hasTz = digits.size() > 2 && digits[2].contains(u'/');
            if (hasTz) {
                try {
                    util::WallParts w;
                    w.year = d.mid(0, 4).toInt();
                    w.month = d.mid(4, 2).toInt();
                    w.day = d.mid(6, 2).toInt();
                    w.hour = digits[1].mid(0, 2).toInt();
                    w.minute = digits[1].mid(2, 2).toInt();
                    w.second = digits[1].mid(4, 2).toInt();
                    const double epoch = util::wallToEpoch(w, digits[2]);
                    const util::WallParts p = util::wallParts(epoch, QString::fromUtf16(util::kET));
                    return numStr(p.year) + u'-' + util::pad2(p.month) + u'-' + util::pad2(p.day) + u' ' + util::pad2(p.hour) + u':' + util::pad2(p.minute);
                } catch (...) {
                    // 时区名认不出就走下面的老路径,不编
                }
            }
            return day + u' ' + digits[1].mid(0, 2) + u':' + digits[1].mid(2, 2);
        }
        return day;
    }
    return text;
}

SessionBar toSessionBar(const RawBar& bar) {
    double volume = bar.volume ? *bar.volume : 0;  // Number(bar.volume ?? 0) || 0
    if (std::isnan(volume) || volume == 0) volume = 0;
    return {barTimestamp(bar.date), bar.open, bar.high, bar.low, bar.close, util::jsmath::max(volume, 0.0)};
}

bool legOpen(SessionLeg leg, double epochMs) {
    const int minute = weekMinute(epochMs).minute;
    for (const auto& [from, to] : schedule(leg)) {
        if (minute >= from && minute < to) return true;
    }
    return false;
}

std::optional<double> legClosedSince(SessionLeg leg, double epochMs) {
    if (legOpen(leg, epochMs)) return std::nullopt;
    const WeekMinute wm = weekMinute(epochMs);
    const Windows& windows = schedule(leg);
    const bool wraps = std::any_of(windows.begin(), windows.end(), [](const auto& w) { return w.first == 0; });
    double last = -std::numeric_limits<double>::infinity();
    for (const auto& w : windows) {
        const int to = w.second;
        if (to == kWeek && wraps) continue;  // 周日夜里那一截接着周一零点,不是收盘
        if (to <= wm.minute) last = util::jsmath::max(last, to);
        last = util::jsmath::max(last, to - kWeek);  // 上一周的
    }
    const double dayOffset = std::floor(last / kDay);
    const double inDay = last - dayOffset * kDay;
    const double ms = util::dateUtc(wm.monday.year, wm.monday.month - 1, wm.monday.day) + dayOffset * 86'400'000.0;
    const YMD d = civilFromDays(static_cast<long long>(std::floor(ms / 86'400'000.0)));
    util::WallParts w;
    w.year = d.year;
    w.month = d.month;
    w.day = d.day;
    w.hour = std::floor(inDay / 60);
    w.minute = std::fmod(inDay, 60);
    w.second = 0;
    return util::wallToEpoch(w, QString::fromUtf16(util::kET));
}

IbContract overnightContract(const IbContract& t) {
    IbContract c;
    c.secType = t.secType;
    c.symbol = t.symbol;
    c.exchange = kOvernightExchange;
    c.currency = t.currency;
    return c;
}

std::vector<SessionBar> mergeSessionBars(const std::vector<SessionBar>& day, const std::vector<SessionBar>& overnight) {
    if (overnight.empty()) return day;
    contract::OrderedMap<SessionBar> byTime;
    for (const SessionBar& bar : overnight) byTime.insert(bar.time, bar);
    for (const SessionBar& bar : day) byTime.insert(bar.time, bar);
    std::vector<SessionBar> out;
    for (const QString& key : byTime.keys()) out.push_back(*byTime.find(key));
    std::stable_sort(out.begin(), out.end(), lessTime);
    return out;
}

IndexProxyResult proxyIndexBars(const std::vector<SessionBar>& index, const std::vector<SessionBar>& futures) {
    contract::OrderedMap<SessionBar> futByTime;
    for (const SessionBar& b : futures) futByTime.insert(b.time, b);
    struct Sess {
        QString first;
        SessionBar last;
    };
    contract::OrderedMap<Sess> sessions;
    for (const SessionBar& bar : index) {
        const QString date = bar.time.left(10);
        if (Sess* s = sessions.find(date)) {
            if (bar.time < s->first) s->first = bar.time;
            if (bar.time > s->last.time) s->last = bar;
        } else {
            sessions.insert(date, {bar.time, bar});
        }
    }
    struct Close {
        QString first, last;
        std::optional<double> basis;
    };
    std::vector<Close> closes;
    for (const QString& key : sessions.keys()) {
        const Sess& s = *sessions.find(key);
        const SessionBar* fut = futByTime.find(s.last.time);
        std::optional<double> basis;
        if (fut && fut->close > 0 && s.last.close > 0) basis = util::pyRound(fut->close - s.last.close, 4);
        closes.push_back({s.first, s.last.time, basis});
    }
    std::stable_sort(closes.begin(), closes.end(), [](const Close& a, const Close& b) { return a.last < b.last; });

    std::vector<SessionBar> derived;
    std::optional<BasisPoint> latestBasis;
    std::vector<SessionBar> sortedFut = futures;
    std::stable_sort(sortedFut.begin(), sortedFut.end(), lessTime);
    for (const SessionBar& bar : sortedFut) {
        const Sess* own = sessions.find(bar.time.left(10));
        if (own && bar.time >= own->first && bar.time <= own->last.time) continue;
        const Close* before = nullptr;
        for (const Close& c : closes) {
            if (c.last < bar.time) before = &c;
            else break;
        }
        if (!before || !before->basis) continue;
        const double b = *before->basis;
        derived.push_back({bar.time, util::pyRound(bar.open - b, 2), util::pyRound(bar.high - b, 2), util::pyRound(bar.low - b, 2),
                           util::pyRound(bar.close - b, 2), 0});
        latestBasis = BasisPoint{b, before->last};
    }

    QSet<QString> isDerived;
    for (const SessionBar& b : derived) isDerived.insert(b.time);
    IndexProxyResult result;
    result.bars = mergeSessionBars(index, derived);
    for (size_t i = 0; i < result.bars.size(); ++i) {
        const SessionBar& bar = result.bars[i];
        if (!isDerived.contains(bar.time)) continue;
        if (!result.spans.empty() && i > 0 && result.bars[i - 1].time == result.spans.back().to) result.spans.back().to = bar.time;
        else result.spans.push_back({bar.time, bar.time});
    }
    result.derived = static_cast<double>(derived.size());
    result.newestDerived = !result.bars.empty() && isDerived.contains(result.bars.back().time);
    result.latestBasis = latestBasis;
    return result;
}

// ---------------------------------------------------------------- SessionBars

Task<TaggedBars> SessionBars::fetch(std::shared_ptr<IbSession> session, SessionBarsRequest req) {
    if (req.futures) co_return co_await fetchIndex(session, req, *req.futures);
    std::vector<SessionBar> bars;
    if (!req.overnight) {
        bars = co_await leg(session, req, SessionLeg::Day, req.target);
    } else {
        // 两条一起要,别让图多等一个来回;日盘那条失败整次失败,夜盘那条失败只少夜盘
        Task<std::vector<SessionBar>> dayTask = leg(session, req, SessionLeg::Day, req.target);
        Task<std::vector<SessionBar>> nightTask = optionalLeg(session, req, SessionLeg::Overnight, overnightContract(req.target), &overnightErrors);
        const std::vector<SessionBar> day = co_await dayTask;
        const std::vector<SessionBar> night = co_await nightTask;
        bars = mergeSessionBars(day, night);
    }
    TaggedBars out;
    out.bars = std::move(bars);
    if (session->has(Cap::QuoteDelayed)) out.feed = feedOf(session->quoteDelayed(req.target));  // 这组 K 线出自实时还是延迟档
    co_return out;
}

Task<TaggedBars> SessionBars::fetchIndex(std::shared_ptr<IbSession> session, SessionBarsRequest req, IbContract futures) {
    const QString symbol = req.target.symbol;
    const QString label = util::jsTrim(futures.symbol + u' ' + futures.lastTradeDateOrContractMonth.value_or(QString()));
    Task<std::vector<SessionBar>> indexTask = leg(session, req, SessionLeg::Index, req.target);
    Task<std::vector<SessionBar>> futTask = optionalLeg(session, req, SessionLeg::Proxy, futures, &proxyErrors);
    const std::vector<SessionBar> index = co_await indexTask;
    const std::vector<SessionBar> fut = co_await futTask;
    const IndexProxyResult result = proxyIndexBars(index, fut);
    const QString* error = proxyErrors.find(symbol);
    QString note;
    if (result.derived > 0 && result.latestBasis) {
        note = symbol + u" 只在常规时段计算;盘外的 K 线按 "_s + label + u" 减基差推算,不是指数本身。"_s +
               u"基差取每个常规时段最后一根 K 线与同一时刻的期货那根之差,最近一个 "_s + numStr(util::pyRound(result.latestBasis->basis, 2)) + u" 点("_s +
               result.latestBasis->time + u")"_s;
    } else if (error) {
        note = symbol + u" 只在常规时段计算;盘外本该按 "_s + label + u" 推算,这次没取到期货 K 线("_s + error->left(160) + u"),半小时后再试"_s;
    } else {
        note = symbol + u" 只在常规时段计算;盘外本该按 "_s + label + u" 推算,这次没有对得上的期货 K 线(常规时段的最后一刻找不到同一时刻的期货那根)"_s;
    }
    TaggedBars out;
    out.bars = result.bars;
    out.proxy = PaProxy{label, result.derived, note, result.spans};
    // 最后一根是推算的:它出自实时还是延迟档看期货那条行情流(引擎夜里推算现价时订着它)
    if (session->has(Cap::QuoteDelayed)) out.feed = feedOf(session->quoteDelayed(result.newestDerived ? futures : req.target));
    co_return out;
}

Task<std::vector<SessionBar>> SessionBars::optionalLeg(std::shared_ptr<IbSession> session, SessionBarsRequest req, SessionLeg kind,
                                                       IbContract contract, contract::OrderedMap<QString>* errors) {
    const QString symbol = req.target.symbol;
    const QString key = symbol + u'|' + legName(kind);
    if (const double* retryAt = retryAt_.find(key)) {
        if (req.nowMs < *retryAt) co_return std::vector<SessionBar>{};
    }
    std::exception_ptr failure;
    std::vector<SessionBar> bars;
    try {
        bars = co_await leg(session, req, kind, contract);
    } catch (...) {
        failure = std::current_exception();
    }
    if (failure) {
        retryAt_.insert(key, req.nowMs + kOvernightRetryMs);
        errors->insert(symbol, errorText(failure));
        co_return std::vector<SessionBar>{};
    }
    retryAt_.remove(key);
    errors->remove(symbol);
    co_return bars;
}

Task<std::vector<SessionBar>> SessionBars::leg(std::shared_ptr<IbSession> session, SessionBarsRequest req, SessionLeg kind, IbContract contract) {
    const IbContract& c = contract;
    const QString key = c.secType + u'|' + c.symbol + u'|' + c.exchange + u'|' + c.lastTradeDateOrContractMonth.value_or(QString()) + u'|' +
                        req.barSizeSetting + u'|' + req.durationStr + u'|' + req.endDateTime + u'|' + (req.useRTH ? u"true"_s : u"false"_s) + u'|' + legName(kind);
    const std::optional<double> closedSince = legClosedSince(kind, req.nowMs);
    if (const Idle* hit = idle_.find(key)) {
        if (closedSince && hit->fetchedAt >= *closedSince + kDelayedFeedMaxMs) co_return hit->bars;
    }
    HistoricalRequest opts;
    opts.endDateTime = req.endDateTime;
    opts.durationStr = req.durationStr;
    opts.barSizeSetting = req.barSizeSetting;
    opts.whatToShow = req.whatToShow;
    opts.useRTH = req.useRTH;
    const std::vector<RawBar> raw = co_await session->historicalData(contract, opts);
    std::vector<SessionBar> bars;
    for (const RawBar& r : raw) bars.push_back(toSessionBar(r));
    idle_.remove(key);
    if (closedSince) {
        idle_.insert(key, {bars, req.nowMs});
        while (idle_.size() > kIdleMax) {
            if (idle_.keys().isEmpty()) break;
            idle_.remove(idle_.keys().first());
        }
    }
    co_return bars;
}

// ---------------------------------------------------------------- barsError

QString barsError(const QString& symbol, const QString& label, const QString& message) {
    const QString lowered = message.toLower();
    if (message.contains(u"162") || message.contains(u"354") || lowered.contains(u"permission") || lowered.contains(u"subscri")) {
        return symbol + u" 没有 "_s + label +
               u" 的行情权限。IBKR 的历史数据同样要订阅,连延迟数据也要账户里"
               u"先开通对应交易所。去 IBKR 账户管理 → Settings → User Settings → "
               u"Market Data Subscriptions 里订阅该标的所属交易所(美股至少要一档 Level 1;"
               u"SPX / VIX / RUT 这类指数属于 Cboe,要单独订阅)。原始报错:" +
               message.left(200);
    }
    return u"获取 "_s + symbol + u" 的 "_s + label + u" K 线失败:"_s + message.left(300);
}

}  // namespace ibkr::execution
