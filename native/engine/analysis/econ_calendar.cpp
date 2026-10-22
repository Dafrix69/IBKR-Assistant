#include "analysis/econ_calendar.h"

#include "util/collate.h"
#include "util/intel_dateparse.h"
#include "util/intel_text.h"
#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/tz.h"

#include <QHash>
#include <QSet>

#include <algorithm>
#include <cmath>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace jm = ibkr::util::jsmath;
namespace tx = ibkr::util::intel_text;

namespace ibkr::analysis::econ_calendar {

namespace {
constexpr double kDayMs = 86'400'000;
const QString kEt = QString::fromUtf16(util::kET);

QString n2s(double v) { return util::jsNumberToString(v); }
OJson table(std::initializer_list<std::pair<const char*, OJson>> kv) {
    OJson o = js::object();
    for (const auto& [k, v] : kv) o.set(QString::fromLatin1(k), v);
    return o;
}
/// new Date(t).getUTCDay()
double utcDay(double t) {
    const double d = std::fmod(std::floor(t / kDayMs), 7.0);
    return std::fmod(d + 4 + 7, 7.0);
}
/// new Date(t).toISOString().slice(0, 10)
QString ymd(double t) { return util::isoString(t).left(10); }
/// 'YYYY-MM-DD' → [年, 月, 日] 各段 Number();缺的是 undefined(这里 NaN)
void splitNumbers(const QString& date, double& y, double& m, double& d) {
    const QStringList parts = date.split(u'-');
    y = util::jsStringToNumber(parts.value(0));
    m = parts.size() > 1 ? util::jsStringToNumber(parts[1]) : std::nan("");
    d = parts.size() > 2 ? util::jsStringToNumber(parts[2]) : std::nan("");
}
/// 正好 n 位数字
bool digitsAt(const QString& s, qsizetype from, qsizetype n) {
    for (qsizetype i = from; i < from + n; ++i)
        if (i >= s.size() || !tx::isDigit(s[i])) return false;
    return true;
}
double numAt(const QString& s, qsizetype from, qsizetype n) { return util::jsStringToNumber(QStringView(s).mid(from, n)); }

int sortCmp(const OJson& a, const OJson& b) {
    const double d = js::num(a.get(u"at"_s)) - js::num(b.get(u"at"_s));
    if (d != 0 && !std::isnan(d)) return d < 0 ? -1 : 1;  // `a.at - b.at || …`
    return util::localeCompare(js::str(a.get(u"id"_s)), js::str(b.get(u"id"_s)));
}
void sortEvents(QList<OJson>& out) {
    std::stable_sort(out.begin(), out.end(), [](const OJson& a, const OJson& b) { return sortCmp(a, b) < 0; });
}
}  // namespace

const OJson& defaultEventsConfig() {
    static const OJson c = table({{"enabled", js::B(true)}, {"feed", js::B(true)}, {"min_stars", js::N(4)}, {"lead_minutes", js::array({js::N(60), js::N(15)})},
                                  {"sector_min_stocks", js::N(3)}, {"sector_share", js::N(0.6)}, {"sector_move_pct", js::N(3)}, {"cross_market", js::B(true)},
                                  {"cross_market_pct", js::N(1.5)}, {"cross_lag_pct", js::N(1)}});
    return c;
}

const OJson& lingerMinTable() {
    static const OJson t = table({{"cpi", js::N(90)}, {"ppi", js::N(90)}, {"nfp", js::N(90)}, {"fomc", js::N(150)}, {"fomc_minutes", js::N(60)}, {"pce", js::N(90)},
                                  {"gdp", js::N(90)}, {"retail", js::N(90)}, {"claims", js::N(60)}, {"fed_speech", js::N(60)}, {"ism", js::N(60)}, {"jolts", js::N(60)},
                                  {"adp", js::N(60)}, {"other", js::N(60)}, {"custom", js::N(90)}, {"cross", js::N(60)}});
    return t;
}

const OJson& starsTable() {
    static const OJson t = table({{"cpi", js::N(5)}, {"nfp", js::N(5)}, {"fomc", js::N(5)}, {"ppi", js::N(4)}, {"pce", js::N(4)}, {"gdp", js::N(4)}, {"retail", js::N(4)},
                                  {"claims", js::N(4)}, {"ism", js::N(4)}, {"jolts", js::N(4)}, {"adp", js::N(4)}, {"fomc_minutes", js::N(4)}, {"fed_speech", js::Null()},
                                  {"other", js::Null()}, {"custom", js::N(4)}, {"cross", js::N(5)}});
    return t;
}

const OJson& kindLabelTable() {
    static const OJson t = [] {
        OJson o = js::object();
        const std::pair<const char*, const char16_t*> kv[] = {
            {"cpi", u"CPI"},         {"ppi", u"PPI"},          {"nfp", u"非农就业"},         {"fomc", u"FOMC 利率决议"}, {"fomc_minutes", u"FOMC 会议纪要"},
            {"pce", u"PCE 物价"},    {"gdp", u"GDP"},          {"retail", u"零售销售"},      {"claims", u"初请失业金"},  {"fed_speech", u"美联储讲话"},
            {"ism", u"ISM 指数"},    {"jolts", u"JOLTS 职位空缺"}, {"adp", u"ADP 就业"},     {"other", u""},             {"custom", u""},
            {"cross", u"跨市场"},
        };
        for (const auto& [k, v] : kv) o.set(QString::fromLatin1(k), js::S(QString::fromUtf16(v)));
        return o;
    }();
    return t;
}

QString impactOfStars(double stars) { return stars >= 4 ? u"high"_s : u"medium"_s; }

namespace {
QString label(const QString& kind) { return js::str(kindLabelTable().get(kind)); }
double linger(const QString& kind) { return js::num(lingerMinTable().get(kind)); }
/// 按月公布的数据:参考月 = 公布月的上一个月
void monthly(std::vector<Release>& out, const char* kind, std::initializer_list<const char*> dates, const QString& time = u"08:30"_s) {
    const QString k = QString::fromLatin1(kind);
    for (const char* d : dates) {
        const QString date = QString::fromLatin1(d);
        const double month = util::jsStringToNumber(QStringView(date).mid(5, 2));
        const double ref = month == 1 ? 12 : month - 1;
        out.push_back({k, date, time, label(k) + u'(' + n2s(ref) + u"月)"});
    }
}
}  // namespace

OJson Release::toJson() const {
    return js::object({{u"kind"_s, js::S(kind)}, {u"date"_s, js::S(date)}, {u"time"_s, js::S(time)}, {u"title"_s, js::S(title)}});
}

const std::vector<Release>& builtinReleases() {
    static const std::vector<Release> r = [] {
        std::vector<Release> out;
        monthly(out, "cpi", {"2026-10-14", "2026-11-10", "2026-12-10", "2027-01-13", "2027-02-11", "2027-03-10", "2027-04-13", "2027-05-12", "2027-06-10",
                             "2027-07-14", "2027-08-11", "2027-09-14", "2027-10-14", "2027-11-10", "2027-12-10"});
        monthly(out, "ppi", {"2026-10-15", "2026-11-13", "2026-12-15", "2027-01-14", "2027-02-12", "2027-03-12", "2027-04-14", "2027-05-13", "2027-06-11",
                             "2027-07-15", "2027-08-10", "2027-09-10", "2027-10-15", "2027-11-12", "2027-12-15"});
        monthly(out, "nfp", {"2026-11-06", "2026-12-04", "2027-01-08", "2027-02-05", "2027-03-05", "2027-04-02", "2027-05-07", "2027-06-04", "2027-07-02",
                             "2027-08-06", "2027-09-03", "2027-10-08", "2027-11-05", "2027-12-03"});
        monthly(out, "pce", {"2026-10-29", "2026-11-25", "2026-12-23", "2027-01-28", "2027-02-25", "2027-03-31", "2027-04-29", "2027-05-27", "2027-06-25",
                             "2027-07-29", "2027-08-25", "2027-09-30", "2027-10-28", "2027-11-24", "2027-12-22"});
        const auto add = [&](const char* kind, const char* date, const char* time, const char16_t* title) {
            out.push_back({QString::fromLatin1(kind), QString::fromLatin1(date), QString::fromLatin1(time), QString::fromUtf16(title)});
        };
        add("gdp", "2026-10-29", "08:30", u"GDP 初值(三季度)");
        add("gdp", "2027-01-28", "08:30", u"GDP 初值(四季度)");
        add("gdp", "2027-04-29", "08:30", u"GDP 初值(一季度)");
        add("gdp", "2027-07-29", "08:30", u"GDP 初值(二季度)");
        add("gdp", "2027-10-28", "08:30", u"GDP 初值(三季度)");
        add("fomc", "2026-10-28", "14:00", u"FOMC 利率决议");
        add("fomc", "2026-12-09", "14:00", u"FOMC 利率决议(含经济预测)");
        add("fomc", "2027-01-27", "14:00", u"FOMC 利率决议");
        add("fomc", "2027-03-17", "14:00", u"FOMC 利率决议(含经济预测)");
        add("fomc", "2027-04-28", "14:00", u"FOMC 利率决议");
        add("fomc", "2027-06-09", "14:00", u"FOMC 利率决议(含经济预测)");
        add("fomc", "2027-07-28", "14:00", u"FOMC 利率决议");
        add("fomc", "2027-09-15", "14:00", u"FOMC 利率决议(含经济预测)");
        add("fomc", "2027-10-27", "14:00", u"FOMC 利率决议");
        add("fomc", "2027-12-08", "14:00", u"FOMC 利率决议(含经济预测)");
        return out;
    }();
    return r;
}

std::optional<double> etEpoch(const QString& date, const QString& time) {
    // /^(\d{4})-(\d{2})-(\d{2})$/ 与 /^(\d{1,2}):(\d{2})$/
    const bool dOk = date.size() == 10 && digitsAt(date, 0, 4) && date[4] == u'-' && digitsAt(date, 5, 2) && date[7] == u'-' && digitsAt(date, 8, 2);
    const qsizetype colon = time.indexOf(u':');
    const bool tOk = (colon == 1 || colon == 2) && digitsAt(time, 0, colon) && time.size() == colon + 3 && digitsAt(time, colon + 1, 2);
    if (!dOk || !tOk) return std::nullopt;
    util::WallParts p;
    p.year = numAt(date, 0, 4);
    p.month = numAt(date, 5, 2);
    p.day = numAt(date, 8, 2);
    p.hour = numAt(time, 0, colon);
    p.minute = numAt(time, colon + 1, 2);
    if (p.month < 1 || p.month > 12 || p.day < 1 || p.day > 31 || p.hour > 23 || p.minute > 59) return std::nullopt;
    // 不存在的日期会被顺延:换回来对不上就是坏日期
    const double epoch = util::wallToEpoch(p, kEt);
    return etDateOf(epoch) == date ? std::optional(epoch) : std::nullopt;
}

namespace {
OJson builtinEvent(const Release& r) {
    const auto at = etEpoch(r.date, r.time);
    if (!at) throw util::JsError(u"内置日程里有坏日期:%1 %2 %3"_s.arg(r.kind, r.date, r.time));
    const OJson* fixed = starsTable().get(r.kind);
    const double stars = js::nullish(fixed) ? 4 : fixed->n;
    return js::object({{u"id"_s, js::S(u"builtin:"_s + r.kind + u':' + r.date)}, {u"kind"_s, js::S(r.kind)}, {u"title"_s, js::S(r.title)}, {u"at"_s, js::N(*at)},
                       {u"date_et"_s, js::S(r.date)}, {u"time_et"_s, js::S(r.time)}, {u"stars"_s, js::N(stars)}, {u"impact"_s, js::S(impactOfStars(stars))},
                       {u"source"_s, js::S(u"builtin"_s)}, {u"linger_min"_s, js::N(linger(r.kind))}});
}
}  // namespace

bool thursdayIsFederalHoliday(const QString& date) {
    double y, m, d;
    splitNumbers(date, y, m, d);
    if (m == 1 && d == 1) return true;
    if (m == 6 && d == 19 && y >= 2021) return true;
    if (m == 7 && d == 4) return true;
    if (m == 11 && d == 11) return true;
    if (m == 11 && d >= 22 && d <= 28) return true;  // 感恩节
    if (m == 12 && d == 25) return true;
    return false;
}

std::vector<Release> claimsReleases(double from, double to) {
    std::vector<Release> out;
    // 从 from 那天往前退到周四,一周一周往后走;多走一周
    double t = util::v8DateParse(ymd(from - 7 * kDayMs) + u"T12:00:00Z"_s);
    while (utcDay(t) != 4) t += kDayMs;
    for (; t <= to + 7 * kDayMs; t += 7 * kDayMs) {
        const QString thursday = ymd(t);
        const QString date = thursdayIsFederalHoliday(thursday) ? ymd(t - kDayMs) : thursday;
        const QString weekEnd = ymd(t - 5 * kDayMs).mid(5);
        out.push_back({u"claims"_s, date, u"08:30"_s, u"初请失业金(截至 %1 当周)"_s.arg(weekEnd)});
    }
    return out;
}

QList<OJson> builtinEvents(double from, double to) {
    QList<OJson> out;
    std::vector<Release> all = builtinReleases();
    for (const Release& r : claimsReleases(from, to)) all.push_back(r);
    for (const Release& r : all) {
        const OJson e = builtinEvent(r);
        const double at = e.get(u"at"_s)->n;
        if (at >= from && at <= to) out << e;
    }
    sortEvents(out);
    return out;
}

// ---------------------------------------------------------------- 日历源
QString familyOf(const QString& t) {
    if (tx::wordCaseless(t, u"CPI")) return u"cpi"_s;
    if (tx::wordCaseless(t, u"PPI")) return u"ppi"_s;
    if (tx::wordCaseless(t, u"ADP")) return u"adp"_s;  // ADP 的标题里也有 Non-Farm
    if (tx::containsCaseless(t, u"JOLTS") || tx::containsCaseless(t, u"Job Openings")) return u"jolts"_s;
    if (tx::containsCaseless(t, u"Non-Farm") || tx::containsCaseless(t, u"NonFarm") || tx::containsCaseless(t, u"Unemployment Rate") ||
        tx::containsCaseless(t, u"Average Hourly Earnings"))
        return u"nfp"_s;
    if (tx::containsCaseless(t, u"FOMC Meeting Minutes")) return u"fomc_minutes"_s;
    if (tx::containsCaseless(t, u"FOMC Statement") || tx::containsCaseless(t, u"Federal Funds Rate") || tx::containsCaseless(t, u"FOMC Press Conference") ||
        tx::containsCaseless(t, u"FOMC Economic Projections"))
        return u"fomc"_s;
    if (tx::containsCaseless(t, u"Core PCE") || tx::containsCaseless(t, u"Personal Income") || tx::containsCaseless(t, u"Personal Spending")) return u"pce"_s;
    if (tx::wordCaseless(t, u"GDP")) return u"gdp"_s;
    if (tx::containsCaseless(t, u"Retail Sales")) return u"retail"_s;
    if (tx::containsCaseless(t, u"Unemployment Claims")) return u"claims"_s;
    // Fed Chair|Fed Chairman|FOMC Member .* Speaks|Fed .* Speaks
    if (tx::containsCaseless(t, u"Fed Chair") || tx::spanCaseless(t, u"FOMC Member ", u" Speaks") || tx::spanCaseless(t, u"Fed ", u" Speaks")) return u"fed_speech"_s;
    if (tx::wordCaseless(t, u"ISM")) return u"ism"_s;
    return u"other"_s;
}

namespace {
/// /(?:Chair(?:man)?|Member|Governor)\s+([A-Z][\w'.-]+)\s+(?:Speaks|Testifies)/i 的第一组
QString speaker(const QString& t) {
    static const QStringView words[] = {u"Chairman", u"Chair", u"Member", u"Governor"};
    const auto nameChar = [](QChar c) { return tx::isWord(c) || c == u'\'' || c == u'.' || c == u'-'; };
    for (qsizetype i = 0; i < t.size(); ++i) {
        for (QStringView w : words) {
            if (!tx::litAt(t, i, w, true)) continue;
            qsizetype j = i + w.size();
            const qsizetype s1 = tx::skipSpaces(t, j);
            if (s1 == j || s1 >= t.size() || !tx::isLetter(t[s1])) continue;
            qsizetype e = s1 + 1;
            while (e < t.size() && nameChar(t[e])) ++e;
            if (e == s1 + 1) continue;
            const qsizetype s2 = tx::skipSpaces(t, e);
            if (s2 == e) continue;
            if (tx::litAt(t, s2, u"Speaks", true) || tx::litAt(t, s2, u"Testifies", true)) return t.mid(s1, e - s1);
        }
    }
    return {};
}

struct FeedRow {
    QString title, country, date, impact, forecast, previous;
};

QString feedTitle(const QString& kind, const QList<FeedRow>& rows) {
    const QString first = rows.isEmpty() ? QString() : rows[0].title;
    if (kind == u"fed_speech") {
        const QString who = speaker(first);
        return who.isEmpty() ? u"美联储讲话"_s : u"美联储讲话(%1)"_s.arg(who);
    }
    if (kind == u"other") return first;
    return label(kind);
}

std::optional<double> starsOfImpact(const QString& raw) {
    const QString s = util::jsTrim(raw).toLower();
    if (s == u"high") return 4;
    if (s == u"medium") return 3;
    if (s == u"low") return 2;
    return std::nullopt;
}

QString slug(const QString& title) {
    const QString lower = title.toLower();
    QString s;
    bool inRun = false;
    for (QChar c : lower) {
        if ((c >= u'a' && c <= u'z') || tx::isDigit(c)) {
            s += c;
            inRun = false;
        } else if (!inRun) {
            s += u'-';
            inRun = true;
        }
    }
    // /^-|-$/g:开头一个、结尾一个(只有一个 "-" 时只去一次)
    const bool lead = s.startsWith(u'-'), trail = s.size() > 1 && s.endsWith(u'-');
    if (trail) s.chop(1);
    if (lead) s.remove(0, 1);
    s = s.left(40);
    return s.isEmpty() ? u"event"_s : s;
}
}  // namespace

double starsFor(const QString& kind, const QString& title, double feedStars) {
    const OJson* fixed = starsTable().get(kind);
    if (fixed && fixed->type != OJson::Null) return fixed->n;  // 表外的家族是 undefined:!== null,按 undefined 返回(这里 NaN)
    if (!fixed) return std::nan("");
    if (kind == u"fed_speech" && tx::containsCaseless(title, u"Fed Chair")) return 5;
    return feedStars;
}

QList<OJson> parseFeed(const OJson* payload, const QTimeZone& local) {
    if (!js::isArr(payload)) return {};
    struct Group {
        QString kind;
        double at = 0, stars = 0;
        QList<FeedRow> rows;
    };
    std::vector<Group> groups;
    QHash<QString, size_t> index;
    for (const OJson& raw : payload->items) {
        if (!js::truthy(&raw) || !js::isObjectLike(&raw)) continue;
        if (js::strOr(js::prop(&raw, u"country"_s), QString()).toUpper() != u"USD") continue;
        const auto feedStars = starsOfImpact(js::strOr(js::prop(&raw, u"impact"_s), QString()));
        if (!feedStars) continue;
        const QString title = util::jsTrim(js::strOr(js::prop(&raw, u"title"_s), QString()));
        if (title.isEmpty()) continue;
        const double at = util::v8DateParse(js::strOr(js::prop(&raw, u"date"_s), QString()), local);
        if (!std::isfinite(at)) continue;
        const QString kind = familyOf(title);
        const double stars = starsFor(kind, title, *feedStars);
        const QString key = (kind == u"other" ? title : kind) + u'@' + n2s(at);
        const FeedRow clean{title,
                            u"USD"_s,
                            js::str(js::prop(&raw, u"date"_s)),
                            js::str(js::prop(&raw, u"impact"_s)),
                            util::jsTrim(js::strOr(js::prop(&raw, u"forecast"_s), QString())),
                            util::jsTrim(js::strOr(js::prop(&raw, u"previous"_s), QString()))};
        const auto it = index.constFind(key);
        if (it != index.constEnd()) {
            Group& g = groups[*it];
            g.rows << clean;
            g.stars = jm::max(g.stars, stars);  // 同一组里有一条星级高,整条就按它
        } else {
            index.insert(key, groups.size());
            groups.push_back({kind, at, stars, {clean}});
        }
    }
    QList<OJson> out;
    for (const Group& g : groups) {
        OJson items = js::array();
        for (const FeedRow& r : g.rows)
            items.items << js::object({{u"title"_s, js::S(r.title)}, {u"forecast"_s, js::S(r.forecast)}, {u"previous"_s, js::S(r.previous)}});
        const QString idPart = g.kind == u"other" ? slug(g.rows.isEmpty() ? QString() : g.rows[0].title) : g.kind;
        out << js::object({{u"id"_s, js::S(u"feed:"_s + idPart + u':' + n2s(g.at))}, {u"kind"_s, js::S(g.kind)}, {u"title"_s, js::S(feedTitle(g.kind, g.rows))},
                           {u"at"_s, js::N(g.at)}, {u"date_et"_s, js::S(etDateOf(g.at))}, {u"time_et"_s, js::S(etTimeOf(g.at))}, {u"stars"_s, js::N(g.stars)},
                           {u"impact"_s, js::S(impactOfStars(g.stars))}, {u"source"_s, js::S(u"feed"_s)}, {u"linger_min"_s, js::N(linger(g.kind))},
                           {u"items"_s, items}});
    }
    sortEvents(out);
    return out;
}

QList<OJson> mergeEvents(const QList<OJson>& builtin, const QList<OJson>& feed, const QList<OJson>& custom) {
    const auto keyOf = [](const OJson& e) { return js::str(e.get(u"kind"_s)) + u'@' + js::str(e.get(u"date_et"_s)); };
    QHash<QString, qsizetype> byKey;  // Map.set:同一个键后来的盖前面的
    for (qsizetype i = 0; i < builtin.size(); ++i) byKey.insert(keyOf(builtin[i]), i);
    QList<OJson> out;
    QSet<QString> replaced;
    for (const OJson& f : feed) {
        const QString key = keyOf(f);
        const OJson* kind = f.get(u"kind"_s);
        const bool other = kind && kind->type == OJson::String && kind->s == u"other";
        const auto it = other ? byKey.constEnd() : byKey.constFind(key);
        if (it != byKey.constEnd()) {
            const OJson& b = builtin[*it];
            replaced.insert(key);
            const double stars = jm::max(js::num(f.get(u"stars"_s)), js::num(b.get(u"stars"_s)));
            OJson m = f;
            const auto put = [&](const QString& k) {
                if (const OJson* v = b.get(k)) m.set(k, *v);
                else m.remove(k);  // 展开后写成 undefined:JSON 里没有
            };
            put(u"id"_s);
            put(u"title"_s);
            put(u"linger_min"_s);
            m.set(u"stars"_s, js::N(stars));
            m.set(u"impact"_s, js::S(impactOfStars(stars)));
            out << m;
        } else {
            out << f;
        }
    }
    for (const OJson& b : builtin)
        if (!replaced.contains(keyOf(b))) out << b;
    out << custom;
    sortEvents(out);
    return out;
}

/// toLocaleDateString("en-CA", { timeZone: ET }):公元前的年份 Intl 写成不带纪元的那个数(公元前 2 年 → "2");
/// util::wallParts 的年是 QDate 的记法(没有 0 年,公元前 2 年是 −2)
QString etDateOf(double epoch) {
    const util::WallParts p = util::wallParts(epoch, kEt);
    return n2s(p.year > 0 ? p.year : -p.year) + u'-' + util::pad2(p.month) + u'-' + util::pad2(p.day);
}
/// toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })
QString etTimeOf(double epoch) {
    const util::WallParts p = util::wallParts(epoch, kEt);
    return util::pad2(p.hour) + u':' + util::pad2(p.minute);
}

double expiresAt(const OJson& e) { return js::num(e.get(u"at"_s)) + js::num(e.get(u"linger_min"_s)) * 60'000; }

QStringList builtinProblems() {
    QSet<QString> seen;
    QStringList out;
    for (const Release& r : builtinReleases()) {
        const QString key = r.kind + u'@' + r.date;
        if (seen.contains(key)) out << u"重复:"_s + key;
        seen.insert(key);
        if (!etEpoch(r.date, r.time)) out << u"坏日期:%1 %2"_s.arg(key, r.time);
        const double dow = util::weekdayOfDate(r.date);
        if (dow == 0 || dow == 6) out << u"落在周末:"_s + key;  // TS 原样:weekdayOfDate 是周一 = 0,这里查的是周一与周日
    }
    return out;
}

// ---------------------------------------------------------------- 口径的校验
namespace {
double numberOf(const OJson* raw, const QString& name) {
    double v;
    if (raw && raw->type == OJson::String && !util::jsTrim(raw->s).isEmpty()) v = util::jsStringToNumber(raw->s);
    else if (raw && raw->type == OJson::Number) v = raw->n;
    else throw EventsConfigError(name + u"必须是数字"_s);
    if (!std::isfinite(v)) throw EventsConfigError(name + u"必须是数字"_s);
    return v;
}
bool isInt(double n) { return n == util::jsRound(n); }
}  // namespace

OJson normalizeEventsConfig(const OJson* input, const OJson& base) {
    static const OJson empty = js::object();
    const OJson* raw = js::truthy(input) && js::isObjectLike(input) ? input : &empty;
    const auto at = [&](const char* k) { return js::prop(raw, QString::fromLatin1(k)); };
    OJson out = base;
    out.set(u"lead_minutes"_s, js::copyOrNull(base.get(u"lead_minutes"_s)));
    for (const char* key : {"enabled", "feed", "cross_market"})
        if (at(key)) out.set(QString::fromLatin1(key), js::B(js::truthy(at(key))));
    // 老口径:「中等影响的也算」开着 = 三星起
    if (!at("min_stars") && js::isBool(at("medium")) && at("medium")->b) out.set(u"min_stars"_s, js::N(3));
    if (at("min_stars")) {
        const double n = numberOf(at("min_stars"), u"最低星级"_s);
        if (n < 1 || n > 5 || !isInt(n)) throw EventsConfigError(u"最低星级必须是 1 ~ 5 的整数"_s);
        out.set(u"min_stars"_s, js::N(n));
    }
    if (const OJson* list = at("lead_minutes")) {
        if (!js::isArr(list) || list->items.size() > 4) throw EventsConfigError(u"提前提醒最多 4 档"_s);
        std::vector<double> mins;
        for (const OJson& x : list->items) mins.push_back(numberOf(&x, u"提前提醒的分钟数"_s));
        for (double m : mins)
            if (m < 1 || m > 24 * 60 || !isInt(m)) throw EventsConfigError(u"提前提醒的分钟数必须是 1 ~ 1440 的整数"_s);
        std::vector<double> uniq;
        for (double m : mins)
            if (std::find(uniq.begin(), uniq.end(), m) == uniq.end()) uniq.push_back(m);
        std::stable_sort(uniq.begin(), uniq.end(), [](double a, double b) { return b - a < 0; });
        OJson arr = js::array();
        for (double m : uniq) arr.items << js::N(m);
        out.set(u"lead_minutes"_s, arr);
    }
    const auto ranged = [&](const char* key, const char16_t* name, double lo, double hi, bool integer, const char16_t* msg) {
        const OJson* v = at(key);
        if (!v) return;
        const double n = numberOf(v, QString::fromUtf16(name));
        if (n < lo || n > hi || (integer && !isInt(n))) throw EventsConfigError(QString::fromUtf16(msg));
        out.set(QString::fromLatin1(key), js::N(n));
    };
    ranged("sector_min_stocks", u"板块联动的最少只数", 2, 30, true, u"板块联动的最少只数必须是 2 ~ 30 的整数");
    ranged("sector_share", u"板块联动的比例", 0.3, 1, false, u"板块联动的比例必须在 0.3 ~ 1 之间");
    ranged("sector_move_pct", u"板块联动的涨跌幅", 0.5, 50, false, u"板块联动的涨跌幅必须在 0.5% ~ 50% 之间");
    ranged("cross_market_pct", u"跨市场的涨跌幅", 0.3, 10, false, u"跨市场的涨跌幅必须在 0.3% ~ 10% 之间");
    ranged("cross_lag_pct", u"跨市场的差距", 0.2, 10, false, u"跨市场的差距必须在 0.2 ~ 10 个点之间");
    return out;
}

}  // namespace ibkr::analysis::econ_calendar
