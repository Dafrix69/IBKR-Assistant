#include "analysis/open_risk.h"

#include "domain/positions.h"
#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/py.h"

#include <QHash>
#include <QSet>

#include <cmath>
#include <limits>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace jm = ibkr::util::jsmath;

namespace ibkr::analysis::open_risk {

namespace {
constexpr double kInf = std::numeric_limits<double>::infinity();
const OJson kEmpty = js::object();

/// row["contract"] ?? {}
const OJson* contractOf(const OJson* row) {
    const OJson* c = js::prop(row, u"contract"_s);
    return js::nullish(c) ? &kEmpty : c;
}
/// finiteOrNull(v) ?? 0
double num(const OJson* v) { return js::finiteOrNull(v).value_or(0); }
bool isStr(const OJson* v, const char16_t* s) { return v && v->type == OJson::String && v->s == QStringView(s); }
bool isOption(const OJson* row) {
    const OJson* t = js::prop(row, u"sec_type"_s);
    return isStr(t, u"OPT") || isStr(t, u"FOP");
}
QString expiryOf(const OJson* row) { return js::strOr(js::prop(contractOf(row), u"lastTradeDateOrContractMonth"_s), QString()); }

/// 组合行里各腿的张数和组数对得上才按组数记:价差、铁鹰、铁蝶每条腿 1 倍;蝶 1 / 2 / 1
bool consistent(const OJson& row, const QHash<QString, OJson>& byKey) {
    const double units = std::fabs(num(row.get(u"quantity"_s)));
    const OJson* legsRaw = row.get(u"legs"_s);
    QList<const OJson*> legs;
    if (js::isArr(legsRaw))
        for (const OJson& k : legsRaw->items) {
            const auto it = k.type == OJson::String ? byKey.constFind(k.s) : byKey.constEnd();
            legs << (it == byKey.constEnd() ? nullptr : &*it);
        }
    if (!(units > 0) || legs.contains(nullptr)) return false;
    std::vector<double> per;
    for (const OJson* l : legs) per.push_back(std::fabs(num(l->get(u"quantity"_s))) / units);
    std::vector<double> want = isStr(row.get(u"kind"_s), u"butterfly") ? std::vector<double>{1, 2, 1} : std::vector<double>(per.size(), 1);
    if (per.size() != want.size()) return false;
    for (size_t i = 0; i < per.size(); ++i)
        if (!(std::fabs(per[i] - want[i]) < 1e-9)) return false;
    return true;
}
}  // namespace

QString contractsKey(const QString& account, const QString& symbol, const QString& expiry) { return account + u'|' + symbol.toUpper() + u'|' + expiry.left(8); }

Worst worstCaseAtExpiry(const std::vector<Leg>& legs) {
    double paid = 0;
    for (const Leg& l : legs) paid = paid + l.qty * l.cost;
    const auto pnlAt = [&](double s) {
        double sum = 0;
        for (const Leg& l : legs) sum = sum + l.qty * l.mult * jm::max(0, l.call ? s - l.strike : l.strike - s);
        return sum - paid;
    };
    double lowest = pnlAt(0);
    for (const Leg& l : legs) lowest = jm::min(lowest, pnlAt(l.strike));
    const double worst = jm::max(0, -lowest);
    // 最高行权价之上:每涨一点的盈亏 = Σ 看涨腿的数量 × 乘数;是负的就没有上限
    double slope = 0;
    for (const Leg& l : legs)
        if (l.call) slope = slope + l.qty * l.mult;
    if (slope >= 0) return {worst, 0};
    double top = -kInf;
    for (const Leg& l : legs) top = jm::max(top, l.strike);
    double calls = 0;
    for (const Leg& l : legs)
        if (l.call) calls = calls + l.qty;
    return {worst + -slope * top, -calls};
}

OJson openRisk(const QList<OJson>& rows) {
    OJson riskUsd = js::object(), contracts = js::object(), notes = js::array();

    // ---- 最坏亏损:按「账户 + 标的 + 到期」把腿放在一起算
    struct Bucket {
        QString account, symbol, expiry;
        std::vector<Leg> legs;
    };
    std::vector<Bucket> buckets;
    QHash<QString, size_t> index;
    for (const OJson& row : rows) {
        if (!isOption(&row)) continue;
        const OJson* c = contractOf(&row);
        const double qty = num(row.get(u"quantity"_s));
        const double strike = num(js::prop(c, u"strike"_s));
        const QString right = js::strOr(js::prop(c, u"right"_s), QString()).left(1).toUpper();
        if (!qty || !(strike > 0) || (right != u"C" && right != u"P")) continue;
        const QString account = js::str(row.get(u"account"_s)), symbol = js::str(row.get(u"symbol"_s));
        const QString expiry = expiryOf(&row).left(8);
        const QString key = contractsKey(account, symbol, expiry);
        auto it = index.constFind(key);
        if (it == index.constEnd()) {
            it = index.insert(key, buckets.size());
            buckets.push_back({account, symbol, expiry, {}});
        }
        const double mult = num(row.get(u"multiplier"_s));
        buckets[*it].legs.push_back({qty, mult ? mult : 100, strike, right == u"C", std::fabs(num(row.get(u"avg_cost"_s)))});
    }
    for (const Bucket& b : buckets) {
        const Worst w = worstCaseAtExpiry(b.legs);
        const OJson* prev = riskUsd.get(b.account);
        riskUsd.set(b.account, js::N(util::pyRound((prev ? prev->n : 0) + w.usd, 2)));
        if (w.unbounded > 0)
            notes.items << js::S(u"%1 的 %2 %3 到期有 %4 张净卖出的看涨往上没有对冲,亏损没有上限;在手风险里这一段按最高行权价 × 乘数 × 张数计。"_s.arg(
                b.account, b.symbol, b.expiry, util::jsNumberToString(util::pyRound(w.unbounded, 4))));
    }

    // ---- 张数:认得出的标准组合按组数,其余按腿的张数
    const QList<OJson> all = domain::withCombos(rows);
    QHash<QString, OJson> byKey;  // new Map(…):同一个键后来的盖前面的
    for (const OJson& r : all) byKey.insert(js::str(r.get(u"key"_s)), r);
    QSet<QString> inCombo;
    const auto count = [&](const QString& account, const QString& symbol, const QString& expiry, double n) {
        const QString key = contractsKey(account, symbol, expiry);
        const OJson* prev = contracts.get(key);
        contracts.set(key, js::N((prev ? prev->n : 0) + n));
    };
    static const QSet<QString> standard{u"vertical"_s, u"butterfly"_s, u"iron_condor"_s, u"iron_butterfly"_s};
    for (const OJson& row : all) {
        if (!isStr(row.get(u"sec_type"_s), u"BAG") || !standard.contains(js::strOr(row.get(u"kind"_s), QString())) || !consistent(row, byKey)) continue;
        const OJson* keys = row.get(u"legs"_s);
        QList<OJson> keyList = js::isArr(keys) ? keys->items : QList<OJson>();
        for (const OJson& k : keyList)
            if (k.type == OJson::String) inCombo.insert(k.s);  // Set 里放的是原值:只有串会被后面的 has(String(key)) 认出来
        // byKey.get(keys[0] ?? ""):不是串的键在 Map 里找不到
        const OJson* firstKey = keyList.isEmpty() ? nullptr : &keyList[0];
        const auto f = js::nullish(firstKey) ? byKey.constFind(QString()) : firstKey->type == OJson::String ? byKey.constFind(firstKey->s) : byKey.constEnd();
        const OJson first = f == byKey.constEnd() ? kEmpty : *f;
        count(js::str(row.get(u"account"_s)), js::str(row.get(u"symbol"_s)), expiryOf(&first), std::fabs(num(row.get(u"quantity"_s))));
    }
    for (const OJson& row : all) {
        if (!isOption(&row) || inCombo.contains(js::str(row.get(u"key"_s))) || !num(row.get(u"quantity"_s))) continue;
        count(js::str(row.get(u"account"_s)), js::str(row.get(u"symbol"_s)), expiryOf(&row), std::fabs(num(row.get(u"quantity"_s))));
    }
    return js::object({{u"riskUsd"_s, riskUsd}, {u"contracts"_s, contracts}, {u"notes"_s, notes}});
}

}  // namespace ibkr::analysis::open_risk
