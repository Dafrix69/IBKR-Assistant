#include "shell/event_rules.h"

#include "shell/jsvalue.h"

#include <QDateTime>
#include <QRegularExpression>
#include <QTimeZone>

#include <algorithm>
#include <cmath>

using namespace Qt::StringLiterals;

namespace ibkr::shell::events {

namespace {

const QTimeZone& etZone() {
    static const QTimeZone zone("America/New_York");
    return zone;
}

QTimeZone zoneOf(const QString& tz) { return tz.isEmpty() ? QTimeZone::systemTimeZone() : QTimeZone(tz.toUtf8()); }

QDateTime at(double ms, const QTimeZone& zone) { return QDateTime::fromMSecsSinceEpoch(qint64(ms), zone); }

double num(const QJsonObject& o, QLatin1StringView key) { return o.value(key).toDouble(); }
QString str(const QJsonObject& o, QLatin1StringView key) { return o.value(key).toString(); }

QString pad2(qint64 n) { return QString::number(n).rightJustified(2, u'0'); }

/// Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100)
QString plain(double n) { return jsNumberToString(std::floor(n) == n && std::isfinite(n) ? n : jsRound(n * 100) / 100); }

/// e.items 里预期或前值有一样的那几条
QList<QJsonObject> facts(const QJsonObject& e) {
    QList<QJsonObject> out;
    for (const QJsonValue& v : e.value("items"_L1).toArray()) {
        const QJsonObject i = v.toObject();
        if (!str(i, "forecast"_L1).isEmpty() || !str(i, "previous"_L1).isEmpty()) out.append(i);
    }
    return out;
}

QString orDash(const QString& s) { return s.isEmpty() ? u"—"_s : s; }

HedgeOut shortStockInstruction(const QString& symbol, const QJsonObject& spec) {
    const double qty = num(spec, "qty"_L1);
    if (!(qty >= 1) || qty != jsRound(qty)) return {{}, {}, u"股数要是正整数"_s};
    const QJsonValue p = spec.value("price"_L1);
    const double price = p.isDouble() ? p.toDouble() : std::nan("");
    if (!p.isDouble() || !std::isfinite(price) || price <= 0) return {{}, {}, u"卖空要写限价:看一眼 TWS 里的盘口填进来"_s};
    const QString reasonText = jsTrim(str(spec, "reason"_L1));
    const QString reason = reasonText.isEmpty() ? QString() : u",理由:"_s + reasonText;
    const bool outside = spec.value("outside"_L1).toBool();
    return {
        u"%1限价 %2 卖出 %3 股 %4%5"_s.arg(outside ? u"盘外 "_s : QString(), plain(price), jsNumberToString(qty), symbol, reason),
        u"卖空 %1 股 %2 @ %3%4;亏损没有上限,3 倍 ETF 一天能走 10% 以上"_s.arg(jsNumberToString(qty), symbol, plain(price), outside ? u",盘外限价"_s : QString()),
        {},
    };
}

}  // namespace

QString starText(const QJsonValue& stars) {
    if (!stars.isDouble() || !(stars.toDouble() >= 1)) return {};
    return u"★"_s.repeated(qsizetype(std::min(5.0, jsRound(stars.toDouble()))));
}

double expiresAt(const QJsonObject& e) { return num(e, "at"_L1) + num(e, "linger_min"_L1) * 60'000; }

QString phaseOf(const QJsonObject& e, double now) {
    const double t = num(e, "at"_L1);
    if (now >= expiresAt(e)) return u"expired"_s;
    if (now >= t + kLiveMin * 60'000) return u"after"_s;
    if (now >= t) return u"live"_s;
    if (now >= t - kSoonMin * 60'000) return u"soon"_s;
    return u"upcoming"_s;
}

QString etDateOf(double epochMs) { return at(epochMs, etZone()).date().toString(u"yyyy-MM-dd"_s); }

Pinned pinnedEvents(const QJsonArray& events, double now) {
    const QString today = etDateOf(now);
    QList<QJsonObject> live;
    for (const QJsonValue& v : events) {
        const QJsonObject e = v.toObject();
        const QString phase = phaseOf(e, now);
        if (phase == u"expired") continue;
        // 跨市场跟跌(P0)从美股盘中就挂着,周五的要挂到周一开盘:不受"今天的"那条限制
        if (str(e, "kind"_L1) == u"cross") {
            live.append(e);
            continue;
        }
        if (!(str(e, "date_et"_L1) == today || num(e, "at"_L1) - now <= kPinAheadMs)) continue;
        if (str(e, "impact"_L1) == u"high" || phase != u"upcoming") live.append(e);
    }
    std::stable_sort(live.begin(), live.end(), [](const QJsonObject& a, const QJsonObject& b) { return num(a, "at"_L1) < num(b, "at"_L1); });
    Pinned out;
    for (qsizetype i = 0; i < live.size() && i < kPinMax; ++i) out.events.append(live.at(i));
    out.more = int(std::max<qsizetype>(0, live.size() - kPinMax));
    return out;
}

QString countdownText(const QJsonObject& e, double now) {
    const QString phase = phaseOf(e, now);
    const double t = num(e, "at"_L1);
    if (phase == u"expired") return u"已过去"_s;
    if (phase == u"live") return u"正在公布"_s;
    if (phase == u"after") return u"已公布 %1 分钟"_s.arg(jsNumberToString(std::floor((now - t) / 60'000)));
    const qint64 mins = qint64(std::ceil((t - now) / 60'000));
    if (mins < 60) return u"还有 %1 分钟"_s.arg(mins);
    const qint64 h = mins / 60;
    const qint64 m = mins % 60;
    if (h >= 24) return u"还有 %1 天 %2 小时"_s.arg(h / 24).arg(h % 24);
    return m ? u"还有 %1 小时 %2 分"_s.arg(h).arg(pad2(m)) : u"还有 %1 小时"_s.arg(h);
}

QString whenText(double atMs, double now, const QString& tz) {
    const QTimeZone zone = zoneOf(tz);
    const QDateTime target = at(atMs, zone);
    const QDate targetDay = target.date();
    const QDate today = at(now, zone).date();
    const QString clock = target.time().toString(u"HH:mm"_s);
    if (targetDay == today) return u"今天 "_s + clock;
    const qint64 diffDays = today.daysTo(targetDay);
    if (diffDays == 1) return u"明天 "_s + clock;
    if (diffDays == -1) return u"昨天 "_s + clock;
    if (diffDays > 1 && diffDays < 7) {
        static const char16_t* const names[] = {u"周日", u"周一", u"周二", u"周三", u"周四", u"周五", u"周六"};
        return QString::fromUtf16(names[targetDay.dayOfWeek() % 7]) + u' ' + clock;
    }
    return targetDay.toString(u"MM-dd"_s) + u' ' + clock;
}

QList<LeadDue> leadsDue(const QJsonArray& events, double now, const QList<double>& leads, const QSet<QString>& fired) {
    QList<double> steps{0};
    for (double l : leads)
        if (l > 0 && !steps.contains(l)) steps.append(l);
    QList<LeadDue> out;
    for (const QJsonValue& v : events) {
        const QJsonObject e = v.toObject();
        for (double lead : steps) {
            if (lead > 0 && str(e, "impact"_L1) != u"high") continue;
            const double due = num(e, "at"_L1) - lead * 60'000;
            if (now < due || now >= due + kLeadWindowMs) continue;
            const QString key = str(e, "id"_L1) + u':' + jsNumberToString(lead);
            if (fired.contains(key)) continue;
            out.append({key, lead, e});
        }
    }
    return out;
}

QString leadTitle(const QJsonObject& e, double lead) {
    return lead > 0 ? u"%1 分钟后公布 %2"_s.arg(jsNumberToString(lead), str(e, "title"_L1)) : u"正在公布 "_s + str(e, "title"_L1);
}

QString leadBody(const QJsonObject& e, double lead, double now, const QString& tz) {
    QStringList parts{u"%1(美东 %2)"_s.arg(whenText(num(e, "at"_L1), now, tz), str(e, "time_et"_L1))};
    const QList<QJsonObject> f = facts(e);
    for (qsizetype i = 0; i < f.size() && i < 2; ++i)
        parts.append(u"%1:预期 %2,前值 %3"_s.arg(str(f[i], "title"_L1), orDash(str(f[i], "forecast"_L1)), orDash(str(f[i], "previous"_L1))));
    parts.append(str(e, "note"_L1));
    parts.append(lead > 0 ? u"公布前后指数常有跳空:当日到期的蝶可能直接穿出翼,要对冲或减仓趁现在。"_s : u"盯住现价与持仓;追踪的止损照常。"_s);
    parts.removeAll(QString());
    return parts.join(u" · "_s);
}

QMap<QString, std::optional<double>> freshChanges(const QList<StockChange>& stocks, double now, double maxAgeMs) {
    QMap<QString, std::optional<double>> out;
    for (const StockChange& s : stocks) {
        // s.at ? Date.parse(s.at) : NaN —— 空串、null 都当没有
        const double t = s.at.isString() && !s.at.toString().isEmpty() ? jsDateParse(s.at.toString()) : std::nan("");
        const bool fresh = std::isfinite(t) && now - t <= maxAgeMs && t <= now + 60'000;
        const bool ok = fresh && s.changePct.isDouble() && std::isfinite(s.changePct.toDouble());
        out.insert(s.symbol, ok ? std::optional<double>(s.changePct.toDouble()) : std::nullopt);
    }
    return out;
}

QJsonArray sectorMoves(const QList<SectorInput>& sectors, const QMap<QString, std::optional<double>>& changes, const SectorRule& rule) {
    QJsonArray out;
    struct Quoted {
        QString symbol;
        double pct;
    };
    for (const SectorInput& sector : sectors) {
        QStringList seen;
        QList<Quoted> quoted;
        for (const QString& symbol : sector.symbols) {
            if (seen.contains(symbol)) continue;
            seen.append(symbol);
            const auto it = changes.constFind(symbol);
            if (it != changes.cend() && it->has_value() && std::isfinite(**it)) quoted.append({symbol, **it});
        }
        if (double(quoted.size()) < rule.minStocks) continue;
        const double need = std::max(rule.minStocks, std::ceil(double(quoted.size()) * rule.share));
        QList<Quoted> down, up;
        for (const Quoted& q : quoted) {
            if (q.pct <= -rule.movePct) down.append(q);
            if (q.pct >= rule.movePct) up.append(q);
        }
        QString direction;
        QList<Quoted> hit;
        if (double(down.size()) >= need && down.size() >= up.size()) {
            direction = u"down"_s;
            hit = down;
        } else if (double(up.size()) >= need) {
            direction = u"up"_s;
            hit = up;
        } else {
            continue;
        }
        QList<double> values;
        for (const Quoted& q : quoted) values.append(q.pct);
        std::sort(values.begin(), values.end());
        const qsizetype mid = values.size() / 2;
        const double median = values.size() % 2 ? values.at(mid) : (values.at(mid - 1) + values.at(mid)) / 2;
        std::stable_sort(hit.begin(), hit.end(), [](const Quoted& a, const Quoted& b) { return std::fabs(b.pct) < std::fabs(a.pct); });
        QJsonArray movers;
        for (qsizetype i = 0; i < hit.size() && i < 5; ++i) movers.append(QJsonObject{{u"symbol"_s, hit[i].symbol}, {u"pct"_s, hit[i].pct}});
        out.append(QJsonObject{
            {u"sector"_s, sector.name},
            {u"direction"_s, direction},
            {u"count"_s, hit.size()},
            {u"total"_s, quoted.size()},
            {u"median"_s, jsRound(median * 100) / 100},
            {u"movers"_s, movers},
        });
    }
    return out;
}

int etMinuteOf(double epochMs) {
    const QTime t = at(epochMs, etZone()).time();
    return t.hour() * 60 + t.minute();
}

bool isPremarket(double epochMs) { return etMinuteOf(epochMs) < kUsOpenMinute; }

namespace {
QString signPct(double p) { return (p > 0 ? u"+"_s : p < 0 ? u"−"_s : QString()) + jsToFixed(std::fabs(p), 1) + u'%'; }
}  // namespace

QString sectorMoveTitle(const QJsonObject& m, bool premarket) {
    return u"%1:%2 集体%3"_s.arg(premarket ? u"盘前联动"_s : u"板块联动"_s, str(m, "sector"_L1),
                                  str(m, "direction"_L1) == u"down" ? u"下跌"_s : u"上涨"_s);
}

QString sectorMoveBody(const QJsonObject& m, double movePct, bool premarket) {
    QStringList list;
    for (const QJsonValue& v : m.value("movers"_L1).toArray())
        list.append(v.toObject().value("symbol"_L1).toString() + u' ' + signPct(v.toObject().value("pct"_L1).toDouble()));
    const bool down = str(m, "direction"_L1) == u"down";
    const QString head = u"%1 只里 %2 只%3超 %4%,中位 %5:%6。"_s.arg(jsNumberToString(num(m, "total"_L1)), jsNumberToString(num(m, "count"_L1)),
                                                                     down ? u"跌"_s : u"涨"_s, jsNumberToString(movePct),
                                                                     signPct(num(m, "median"_L1)), list.join(u"、"_s));
    if (premarket && !down)
        return head + u"盘前靠消息面利好拉起来的,开盘后涨幅大概率回吐:别追高开,手里有的考虑趁开盘前后先减。10:00 再报一次守没守住。"_s;
    if (premarket) return head + u"盘前的集体下跌,开盘后先看半小时再动。"_s;
    return head + u"一只股的消息把整个板块带着走时,持仓里同板块的都要看。"_s;
}

std::optional<double> sectorMedian(const QStringList& symbols, const QMap<QString, std::optional<double>>& changes, double minStocks) {
    QStringList seen;
    QList<double> values;
    for (const QString& symbol : symbols) {
        if (seen.contains(symbol)) continue;
        seen.append(symbol);
        const auto it = changes.constFind(symbol);
        if (it != changes.cend() && it->has_value() && std::isfinite(**it)) values.append(**it);
    }
    if (double(values.size()) < std::max(1.0, minStocks)) return std::nullopt;
    std::sort(values.begin(), values.end());
    const qsizetype mid = values.size() / 2;
    const double median = values.size() % 2 ? values.at(mid) : (values.at(mid - 1) + values.at(mid)) / 2;
    return jsRound(median * 100) / 100;
}

QString fadeVerdict(double preMedian, double nowMedian) { return nowMedian <= preMedian / 2 ? u"faded"_s : u"held"_s; }

QString fadeTitle(const QString& sector, const QString& verdict) {
    return sector + (verdict == u"faded" ? u":盘前涨幅已回吐"_s : u":盘前涨幅守住了"_s);
}

QString fadeBody(double preMedian, double nowMedian, const QString& verdict) {
    const QString tail = verdict == u"faded" ? u"盘前的利好在开盘后被卖掉了,这回又应验;别在这里抄回去,等它自己站稳。"_s
                                             : u"这次没回吐,比平常的盘前利好强:别逆着它空。"_s;
    return u"开盘前中位 %1,现在 %2。"_s.arg(signPct(preMedian), signPct(nowMedian)) + tail;
}

const QList<SessionMark>& sessionMarks() {
    static const QList<SessionMark> marks{
        {u"eu_open"_s, u"Europe/London"_s, u"08:00"_s, u"欧盘开盘"_s,
         u"欧洲资金进场,流动性明显变厚:美股期货(ES / NQ)常在这时走出当天第一段方向,或把亚盘的走势掀翻。按夜盘价挂的单、用期货推算的 SPX 现价,这时最容易被打穿。"_s,
         false},
        {u"us_pre_open"_s, u"America/New_York"_s, u"09:25"_s, u"美股 5 分钟后开盘"_s,
         u"盘前靠消息面利好拉起来的,开盘后涨幅大概率回吐,别追高开。开盘头 15 分钟价差宽、方向反复:不用市价单,第一根 K 线别当方向。"_s, true},
        {u"eu_close"_s, u"Europe/London"_s, u"16:30"_s, u"欧盘收盘"_s,
         u"欧洲资金离场,流动性退潮:美股上午的趋势常在这附近停下或回头;接下来的午间是一天里最薄的时段,突破多是假的。"_s, true},
        {u"us_last_hour"_s, u"America/New_York"_s, u"15:00"_s, u"美股最后一小时"_s,
         u"当日到期的期权 gamma 放大:SPX 动几个点,蝶的盈亏变化比上午大得多。15:50 交易所公布收盘集合竞价的买卖失衡,尾盘常急拉急砸;要平的别拖到最后十分钟。"_s,
         true},
    };
    return marks;
}

int londonNyGap(double epochMs) {
    const QDateTime ny = at(epochMs, etZone());
    const QDateTime ld = at(epochMs, QTimeZone("Europe/London"));
    const int day = ny.date() == ld.date() ? 0 : 86'400;
    return int(jsRound(double(ny.time().secsTo(ld.time()) + day) / 3600));
}

QList<SessionMarkDue> sessionMarksDue(double now, const QSet<QString>& fired, bool usOpen) {
    QList<SessionMarkDue> out;
    for (const SessionMark& mark : sessionMarks()) {
        const QDateTime local = at(now, QTimeZone(mark.tz.toUtf8()));
        const int weekday = local.date().dayOfWeek();  // 1 = 周一 … 7 = 周日
        if (weekday > 5) continue;
        if (mark.us && !usOpen) continue;
        const QTime markTime = QTime::fromString(mark.time, u"HH:mm"_s);
        const QTime t = local.time();
        const double since = (double(t.msecsSinceStartOfDay() / 1000) - double(markTime.msecsSinceStartOfDay() / 1000)) * 1000;
        if (since < 0 || since >= kLeadWindowMs) continue;
        const QString key = u"session:%1:%2"_s.arg(mark.id, local.date().toString(u"yyyy-MM-dd"_s));
        if (fired.contains(key)) continue;
        out.append({key, mark});
    }
    return out;
}

QString sessionMarkBody(const SessionMark& mark, double now) {
    QStringList parts{u"美东 %1 · 北京 %2"_s.arg(at(now, etZone()).time().toString(u"HH:mm"_s),
                                                 at(now, QTimeZone("Asia/Shanghai")).time().toString(u"HH:mm"_s)),
                      mark.body};
    if (mark.tz == u"Europe/London" && londonNyGap(now) != 5) parts.append(u"这一周欧美夏令时没同步,欧盘和美股的时差比平常少一小时。"_s);
    return parts.join(u" · "_s);
}

double strikeStep(const QString& symbol, double spot) {
    static const QStringList index{u"SPX"_s, u"SPXW"_s, u"NDX"_s, u"RUT"_s, u"VIX"_s, u"DJX"_s};
    if (index.contains(symbol.toUpper())) return 5;
    if (spot >= 100) return 5;
    if (spot >= 25) return 1;
    return 0.5;
}

HedgeOut hedgeInstruction(const QJsonObject& spec) {
    const QString symbol = jsTrim(str(spec, "symbol"_L1)).toUpper();
    if (symbol.isEmpty()) return {{}, {}, u"先填标的"_s};
    const QString kind = str(spec, "kind"_L1);
    if (kind == u"short_stock") return shortStockInstruction(symbol, spec);
    const QJsonValue spotValue = spec.value("spot"_L1);
    const double spot = spotValue.toDouble();
    if (!spotValue.isDouble() || !std::isfinite(spot) || spot <= 0) return {{}, {}, u"没有现价:连上券商,或自己填一个"_s};
    const double width = num(spec, "width"_L1);
    const double qty = num(spec, "qty"_L1);
    if (!(width > 0)) return {{}, {}, u"宽度要大于 0"_s};
    if (!(qty >= 1) || qty != jsRound(qty)) return {{}, {}, u"张数要是正整数"_s};
    const QString expiry = str(spec, "expiry"_L1);
    const QString todayEt = str(spec, "todayEt"_L1);
    static const QRegularExpression dateRe(u"\\A\\d{4}-\\d{2}-\\d{2}\\z"_s);
    if (!dateRe.match(expiry).hasMatch()) return {{}, {}, u"到期日要写成 YYYY-MM-DD"_s};
    if (expiry < todayEt) return {{}, {}, u"到期日已经过了"_s};
    const double step = strikeStep(symbol, spot);
    const QString expiryPhrase = expiry == todayEt ? u"今天的"_s : expiry + u" 到期的"_s;
    const QString qtyPhrase = qty == 1 ? u"一张"_s : jsNumberToString(qty) + u" 张"_s;
    const QString reasonText = jsTrim(str(spec, "reason"_L1));
    const QString reason = reasonText.isEmpty() ? QString() : u",理由:"_s + reasonText;
    if (kind == u"put_spread") {
        const double longStrike = std::floor(spot / step) * step;
        const double shortStrike = longStrike - width;
        if (shortStrike <= 0) return {{}, {}, u"宽度比现价还大"_s};
        return {
            u"开%1 %2 %3 %4 %5 put spread%6"_s.arg(qtyPhrase, symbol, expiryPhrase, plain(shortStrike), plain(longStrike), reason),
            u"买 %1 put、卖 %2 put,%3 张;最大亏损 = 付出的权利金"_s.arg(plain(longStrike), plain(shortStrike), jsNumberToString(qty)),
            {},
        };
    }
    double shortStrike = std::ceil(spot / step) * step;
    if (shortStrike == spot) shortStrike += step;
    const double longStrike = shortStrike + width;
    // SPX 当日一张:本地速记认得(「7725 7750 bear call」),不经过大模型
    const bool local = symbol == u"SPX" && expiry == todayEt && qty == 1;
    return {
        local ? u"%1 %2 bear call"_s.arg(plain(shortStrike), plain(longStrike))
              : u"卖出%1 %2 %3 %4 %5 call spread%6"_s.arg(qtyPhrase, symbol, expiryPhrase, plain(shortStrike), plain(longStrike), reason),
        u"卖 %1 call、买 %2 call,%3 张;收权利金,最大亏损 = %4 点 − 权利金"_s.arg(plain(shortStrike), plain(longStrike), jsNumberToString(qty), plain(width)),
        {},
    };
}

QString hedgeExpiryFor(const QJsonObject& e, const QString& todayEt) {
    const QString d = str(e, "date_et"_L1);
    return d > todayEt ? d : todayEt;
}

}  // namespace ibkr::shell::events
