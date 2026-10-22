#include "analysis/idea_retrieval.h"

#include "util/error.h"
#include "util/intel_dateparse.h"
#include "util/intel_text.h"
#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/tz.h"

#include <algorithm>
#include <cmath>
#include <vector>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace jm = ibkr::util::jsmath;
namespace tx = ibkr::util::intel_text;

namespace ibkr::analysis::idea_retrieval {

namespace {
const OJson* ideaOf(const OJson& c) { return c.get(u"idea"_s); }
QString idOf(const OJson* idea) { return js::str(js::prop(idea, u"id"_s)); }
double createdMs(const OJson* idea, const QTimeZone& local) {
    const double t = util::v8DateParse(js::strOr(js::prop(idea, u"created_at"_s), QString()), local);
    return std::isfinite(t) ? t : 0;
}
int idCmp(const QString& a, const QString& b) { return a < b ? -1 : a > b ? 1 : 0; }
bool flag(const OJson& c, const char16_t* k) { return js::truthy(c.get(QString::fromUtf16(k))); }
/// arr.slice(0, n):n 按 ToIntegerOrInfinity
qsizetype sliceEnd(double n, qsizetype size) {
    if (std::isnan(n)) return 0;
    n = std::trunc(n);
    if (n < 0) return std::max<qsizetype>(0, size + qsizetype(std::max(n, -double(size))));
    return n >= double(size) ? size : qsizetype(n);
}

/// 同分时新的在前,再按 id
int byScoreThenNewest(const OJson& a, const OJson& b, const QTimeZone& local) {
    const double s = scoreCandidate(b) - scoreCandidate(a);
    if (s != 0) return s < 0 ? -1 : 1;
    const double t = createdMs(ideaOf(b), local) - createdMs(ideaOf(a), local);
    if (t != 0) return t < 0 ? -1 : 1;
    return idCmp(idOf(ideaOf(a)), idOf(ideaOf(b)));
}

bool isSep(QChar c) { return tx::isSpace(c) || c == u',' || c == u'，' || c == u'、' || c == u';' || c == u'；'; }
/// String(x).split(/[\s,，、;；]+/u)
QStringList splitSeps(const QString& s) {
    QStringList out;
    QString cur;
    qsizetype i = 0;
    while (i < s.size()) {
        if (isSep(s[i])) {
            out << cur;
            cur.clear();
            while (i < s.size() && isSep(s[i])) ++i;
        } else {
            cur += s[i++];
        }
    }
    out << cur;
    return out;
}
QStringList uniqueNonEmpty(const QStringList& parts, bool upper) {
    QStringList out;
    for (const QString& p : parts) {
        QString t = util::jsTrim(p);
        if (upper) t = t.toUpper();
        if (!t.isEmpty() && !out.contains(t)) out << t;
    }
    return out;
}
}  // namespace

double scoreCandidate(const OJson& c) { return (flag(c, u"symbol_hit") ? 2 : 0) + (flag(c, u"text_hit") ? 1 : 0) + (flag(c, u"semantic_hit") ? 1 : 0); }

QStringList matchTags(const OJson& c) {
    QStringList out;
    if (flag(c, u"symbol_hit")) out << u"symbol"_s;
    if (flag(c, u"text_hit")) out << u"text"_s;
    if (flag(c, u"semantic_hit")) out << u"semantic"_s;
    return out;
}

QList<OJson> mergeSemantic(const QList<OJson>& candidates, const QList<OJson>& pool, const QSet<QString>& semantic, double limit, const QTimeZone& local) {
    QList<OJson> out;
    QSet<QString> have;
    for (const OJson& c : candidates) {
        const QString id = idOf(ideaOf(c));
        if (semantic.contains(id)) {
            OJson m = c;
            m.set(u"semantic_hit"_s, js::B(true));
            out << m;
        } else {
            out << c;
        }
        have.insert(id);
    }
    for (const OJson& idea : pool) {
        const QString id = idOf(&idea);
        if (semantic.contains(id) && !have.contains(id)) {
            out << js::object({{u"idea"_s, idea}, {u"symbol_hit"_s, js::B(false)}, {u"text_hit"_s, js::B(false)}, {u"semantic_hit"_s, js::B(true)}});
            have.insert(id);
        }
    }
    std::stable_sort(out.begin(), out.end(), [&](const OJson& a, const OJson& b) {
        const double t = createdMs(ideaOf(b), local) - createdMs(ideaOf(a), local);
        if (t != 0) return t < 0;
        return idCmp(idOf(ideaOf(a)), idOf(ideaOf(b))) < 0;
    });
    return out.mid(0, sliceEnd(limit, out.size()));
}

QList<OJson> stratify(const QList<OJson>& candidates, double budget, double buckets, const QTimeZone& local) {
    if (budget <= 0 || candidates.isEmpty()) return {};
    if (double(candidates.size()) <= budget) return candidates;
    const double n = jm::max(1, std::trunc(buckets));
    if (n > 4294967295.0) throw util::JsError(u"Invalid array length"_s);  // Array.from({ length: n })
    const qsizetype groupsN = std::isnan(n) ? 0 : qsizetype(n);  // NaN:一段也没有,什么都取不到
    std::vector<double> times;
    for (const OJson& c : candidates) times.push_back(createdMs(ideaOf(c), local));
    double lo = times[0], hi = times[0];
    for (double t : times) {
        lo = jm::min(lo, t);
        hi = jm::max(hi, t);
    }
    const double span = hi - lo;
    std::vector<QList<OJson>> groups(static_cast<size_t>(groupsN));
    for (qsizetype i = 0; i < candidates.size(); ++i) {
        const double idx = span > 0 ? jm::min(n - 1, std::floor(((times[size_t(i)] - lo) / span) * n)) : n - 1;
        if (idx >= 0 && idx < double(groupsN)) groups[size_t(idx)] << candidates[i];
    }
    for (QList<OJson>& g : groups) std::stable_sort(g.begin(), g.end(), [&](const OJson& a, const OJson& b) { return byScoreThenNewest(a, b, local) < 0; });

    std::vector<double> quota(groups.size(), 0);
    double left = budget;
    while (left > 0) {
        bool gave = false;
        for (qsizetype b = groupsN - 1; b >= 0 && left > 0; --b) {
            if (quota[size_t(b)] < double(groups[size_t(b)].size())) {
                quota[size_t(b)] += 1;
                left -= 1;
                gave = true;
            }
        }
        if (!gave) break;
    }
    QList<OJson> out;
    for (size_t b = 0; b < groups.size(); ++b) out << groups[b].mid(0, sliceEnd(quota[b], groups[b].size()));
    return out;
}

QList<OJson> pickForDigest(const QList<OJson>& matches, const QList<OJson>& recentPool, const PickOptions& opts, const QTimeZone& local) {
    QHash<QString, OJson> hitById;  // new Map(entries):同一个 id 后来的盖前面的
    for (const OJson& c : matches) hitById.insert(idOf(ideaOf(c)), c);
    std::vector<std::pair<QString, OJson>> chosen;  // Map 的先后
    const auto set = [&](const QString& id, const OJson& v) {
        for (auto& [k, x] : chosen)
            if (k == id) {
                x = v;
                return;
            }
        chosen.emplace_back(id, v);
    };
    const auto has = [&](const QString& id) { return std::any_of(chosen.begin(), chosen.end(), [&](const auto& p) { return p.first == id; }); };
    const QList<OJson> recent = recentPool.mid(0, sliceEnd(jm::max(0, jm::min(opts.recent, opts.total)), recentPool.size()));
    for (const OJson& idea : recent) {
        const QString id = idOf(&idea);
        const auto hit = hitById.constFind(id);
        QStringList tags = hit != hitById.constEnd() ? matchTags(*hit) : QStringList();
        tags << u"recent"_s;
        set(id, js::object({{u"idea"_s, idea}, {u"matched_by"_s, js::strings(tags)}}));
    }
    QList<OJson> rest;
    for (const OJson& c : matches)
        if (!has(idOf(ideaOf(c)))) rest << c;
    for (const OJson& c : stratify(rest, opts.total - double(chosen.size()), opts.buckets, local))
        set(idOf(ideaOf(c)), js::object({{u"idea"_s, js::copyOrNull(ideaOf(c))}, {u"matched_by"_s, js::strings(matchTags(c))}}));
    QList<OJson> out;
    for (const auto& [k, v] : chosen) out << v;
    std::stable_sort(out.begin(), out.end(), [&](const OJson& a, const OJson& b) {
        const double t = createdMs(ideaOf(a), local) - createdMs(ideaOf(b), local);
        if (t != 0) return t < 0;
        return idCmp(idOf(ideaOf(a)), idOf(ideaOf(b))) < 0;
    });
    return out;
}

QStringList splitTerms(const OJson* q) { return uniqueNonEmpty(splitSeps(js::strOr(q, QString())), false); }

QStringList parseSymbols(const OJson* raw) {
    QStringList parts;
    if (js::isArr(raw)) {
        for (const OJson& x : raw->items) parts << js::str(&x);
    } else {
        parts = splitSeps(js::strOr(raw, QString()));
    }
    return uniqueNonEmpty(parts, true);
}

OJson normalizeFocus(const OJson* raw) {
    if (!js::truthy(raw)) return OJson::null();
    const QString q = splitTerms(js::prop(raw, u"q"_s)).join(u' ');
    const QStringList symbols = parseSymbols(js::prop(raw, u"symbols"_s));
    if (q.isEmpty() && symbols.isEmpty()) return OJson::null();
    OJson out = js::object();
    if (!q.isEmpty()) out.set(u"q"_s, js::S(q));
    if (!symbols.isEmpty()) out.set(u"symbols"_s, js::strings(symbols));
    return out;
}

std::optional<QString> dayBound(const OJson* raw, const QString& name) {
    const QString s = util::jsTrim(js::strOr(raw, QString()));
    if (s.isEmpty()) return std::nullopt;
    // /^(\d{4})-(\d{2})-(\d{2})$/
    bool ok = s.size() == 10 && s[4] == u'-' && s[7] == u'-';
    for (int i : {0, 1, 2, 3, 5, 6, 8, 9}) ok = ok && tx::isDigit(s[i]);
    const double t = ok ? util::dateUtc(util::jsStringToNumber(QStringView(s).mid(0, 4)), util::jsStringToNumber(QStringView(s).mid(5, 2)) - 1,
                                        util::jsStringToNumber(QStringView(s).mid(8, 2)))
                        : std::nan("");
    if (!ok || !std::isfinite(t) || util::isoString(t).left(10) != s) throw util::JsError(u"%1 应为 YYYY-MM-DD 的日期,收到:%2"_s.arg(name, s));
    const double at = name == u"until" ? t + 86'400'000 : t;
    return util::isoString(at).left(19);
}

}  // namespace ibkr::analysis::idea_retrieval
