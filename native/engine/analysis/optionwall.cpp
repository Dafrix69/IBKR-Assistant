#include "analysis/optionwall.h"

#include "analysis/fly_model.h"
#include "util/js_runtime.h"
#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/py.h"
#include "util/tz.h"

#include <QDateTime>
#include <QHash>
#include <QTimeZone>
#include <QStringList>

#include <algorithm>
#include <cmath>
#include <cstring>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace jm = ibkr::util::jsmath;

namespace ibkr::analysis::optionwall {

namespace {
constexpr double kMinT = 1.0 / (365.0 * 24.0);  // 1 小时下限,否则 0DTE 的 gamma 会炸
constexpr double kFlipScanMax = 2000;

/// optFloat:null / undefined / NaN / 非正是空
std::optional<double> optFloat(const OJson* value) {
    const double v = js::num(value);
    if (js::nullish(value) || std::isnan(v)) return std::nullopt;
    return v > 0 ? std::optional(v) : std::nullopt;
}

struct Cell {
    double call_oi = 0, put_oi = 0, call_vol = 0, put_vol = 0;
    double field(int f) const { return f == 0 ? call_oi : f == 1 ? put_oi : f == 2 ? call_vol : put_vol; }
};
/// Map<number, Cell>:插入的先后
struct Grid {
    std::vector<std::pair<double, Cell>> cells;
    QHash<quint64, size_t> index;
    Cell& at(double strike) {
        quint64 bits;
        std::memcpy(&bits, &strike, 8);
        auto it = index.constFind(bits);
        if (it == index.constEnd()) {
            it = index.insert(bits, cells.size());
            cells.emplace_back(strike, Cell{});
        }
        return cells[*it].second;
    }
    const Cell* find(double strike) const {
        for (const auto& [k, c] : cells)
            if (k == strike) return &c;
        return nullptr;
    }
};

Grid byStrike(const std::vector<OptionRow>& rows) {
    Grid grid;
    for (const OptionRow& row : rows) {
        Cell& cell = grid.at(row.strike);
        if (row.right == u"C") {
            cell.call_oi += row.oi;
            cell.call_vol += row.volume;
        } else {
            cell.put_oi += row.oi;
            cell.put_vol += row.volume;
        }
    }
    return grid;
}

/// 某一侧最大的那一档(不含正好在现价上的;一样大的取离现价近的)
OJson wall(const Grid& grid, int field, double spot, bool above) {
    std::optional<std::pair<double, double>> best;
    for (const auto& [strike, cell] : grid.cells) {
        const double size = cell.field(field);
        if (!(above ? strike > spot : strike < spot) || !(size > 0)) continue;
        if (!best || size > best->second || (size == best->second && std::fabs(strike - spot) < std::fabs(best->first - spot))) best = std::pair(strike, size);
    }
    if (!best) return OJson::null();
    const auto [strike, size] = *best;
    return js::object({{u"strike"_s, js::N(strike)},
                       {u"size"_s, js::N(util::pyRound(size, 1))},
                       {u"distance_pct"_s, spot && !std::isnan(spot) ? js::N(util::pyRound((strike / spot - 1.0) * 100.0, 2)) : OJson::null()}});
}

OJson maxPain(const Grid& grid, double multiplier) {
    std::vector<double> strikes;
    for (const auto& [k, c] : grid.cells) strikes.push_back(k);
    std::stable_sort(strikes.begin(), strikes.end(), [](double a, double b) { return a - b < 0; });
    if (strikes.size() < size_t(kMinStrikes)) return OJson::null();
    std::optional<std::pair<double, double>> best;
    for (double target : strikes) {
        double pain = 0.0;
        for (const auto& [strike, cell] : grid.cells) {
            pain += cell.call_oi * jm::max(target - strike, 0.0);
            pain += cell.put_oi * jm::max(strike - target, 0.0);
        }
        pain *= multiplier;
        if (!best || pain < best->second) best = std::pair(target, pain);
    }
    return js::object({{u"strike"_s, js::N(best->first)}, {u"pain"_s, js::N(util::pyRound(best->second, 0))}});
}

template <class F>
Gex sumGex(const std::vector<OptionRow>& rows, double at, double multiplier, F&& gammaOf) {
    Gex g;
    for (const OptionRow& row : rows) {
        const std::optional<double> gamma = gammaOf(row);
        if (!gamma) continue;  // 既没 IV 也没可用的模型 gamma,不猜
        const double size = *gamma * row.oi * multiplier * at * at * 0.01;
        g.net += row.right == u"C" ? size : -size;
        g.gross += size;
        g.rows += 1;
    }
    return g;
}

/// BS 那条曲线上离现价最近的变号处
std::optional<double> curveFlip(const std::vector<OptionRow>& rows, const std::vector<double>& strikes, double spot, double t, double multiplier) {
    std::vector<OptionRow> usable;
    for (const OptionRow& r : rows)
        if (r.iv) usable.push_back(r);
    std::vector<double> ks;
    for (double k : strikes)
        if (std::find(ks.begin(), ks.end(), k) == ks.end() && !(std::isnan(k) && std::any_of(ks.begin(), ks.end(), [](double x) { return std::isnan(x); }))) ks.push_back(k);
    ks.erase(std::remove_if(ks.begin(), ks.end(), [](double k) { return !(k > 0); }), ks.end());
    std::stable_sort(ks.begin(), ks.end(), [](double a, double b) { return a - b < 0; });
    if (usable.size() < size_t(kMinStrikes) || ks.empty()) return std::nullopt;
    const double lo = ks.front(), hi = ks.back();
    if (!(hi > lo)) return std::nullopt;

    const auto netAt = [&](double x) { return bsGexAt(usable, x, t, multiplier).net; };
    double step = hi - lo;
    for (size_t i = 0; i + 1 < ks.size(); ++i) step = jm::min(step, ks[i + 1] - ks[i]);
    const double n = jm::min(std::ceil((hi - lo) / step), kFlipScanMax);
    std::vector<double> xs;
    for (double i = 0; i <= n; i += 1) xs.push_back(lo + ((hi - lo) * i) / n);
    if (spot > lo && spot < hi) xs.push_back(spot);
    std::stable_sort(xs.begin(), xs.end(), [](double a, double b) { return a - b < 0; });

    std::optional<double> best;
    std::optional<std::pair<double, double>> prev;  // 上一个净 GEX 不是 0 的点
    for (double x : xs) {
        const double g = netAt(x);
        if (g == 0) continue;
        if (prev && (g > 0) != (prev->second > 0)) {
            double a = prev->first, ga = prev->second, b = x;
            while (b - a > 1e-6) {
                const double mid = (a + b) / 2;
                const double gm = netAt(mid);
                if (gm == 0) {
                    a = mid;
                    b = mid;
                } else if ((gm > 0) == (ga > 0)) {
                    a = mid;
                    ga = gm;
                } else {
                    b = mid;
                }
            }
            const double root = (a + b) / 2;
            if (!best || std::fabs(root - spot) < std::fabs(*best - spot)) best = root;
        }
        prev = std::pair(x, g);
    }
    if (!best) return std::nullopt;
    return util::pyRound(*best, 2);
}

QString money(double value) {
    const QString sign = value < 0 ? u"-"_s : QString();
    const double v = std::fabs(value);
    if (v >= 1e9) return sign + util::fmtF(v / 1e9, 2) + u" B"_s;
    if (v >= 1e6) return sign + util::fmtF(v / 1e6, 1) + u" M"_s;
    if (v >= 1e3) return sign + util::fmtF(v / 1e3, 0) + u" K"_s;
    return sign + util::fmtF(v, 0);
}

double N(const OJson& o, const char16_t* k) { return o.get(QString::fromUtf16(k))->n; }
bool isNull(const OJson& o, const char16_t* k) { return o.get(QString::fromUtf16(k))->type == OJson::Null; }

QStringList makeWarnings(const OJson& r, bool hasGamma) {
    QStringList out{
        u"OI 是隔夜存量:OCC 每天开盘前公布一次,盘中看到的不含当天的流。"_s,
        u"GEX 的符号建立在「做市商多头 call、空头 put」这个假设上——真实持仓没人看得到,换个假设结论可能反过来。它适合判断波动会被压住还是放大,不适合判断方向。"_s,
    };
    if (N(r, u"days_to_expiry") <= 1.0) out << u"当日/次日到期:0DTE 合约绝大多数当天开当天平,**OI 墙基本没有参考价值**,请以成交量墙为准。"_s;
    const QString regime = r.get(u"regime"_s)->s;
    if (regime == u"unknown") {
        out << (hasGamma ? u"有 gamma,但没有未平仓量可称(全是 0 或没等到):净 GEX、正负 gamma、gamma 翻转位都算不出——是不知道,不是看涨看跌正好抵消。"_s
                         : u"没拿到隐含波动率,也没有券商的模型 gamma:净 GEX、正负 gamma、gamma 翻转位都算不出——是不知道,不是 0。"_s);
    } else if (!r.get(u"has_greeks"_s)->b) {
        out << u"没拿到隐含波动率:gamma 用的是券商给的模型值,gamma 翻转位算不出(标的挪到别处的 gamma 要靠它重算)。"_s;
    }
    if (!isNull(r, u"max_pain")) out << u"最大痛点只是个统计量;「到期会被拉到那儿」这个因果没有可靠证据。"_s;
    const double missing = N(r, u"oi_missing");
    if (missing > 0)
        out << u"有 %1 行没等到未平仓量(券商在等待的几秒里没推那一笔):墙、净 GEX、最大痛点只算了有数的那些,不是把它们当成 0 张。"_s.arg(util::jsNumberToString(missing));
    const double totalOi = N(r, u"total_call_oi") + N(r, u"total_put_oi");
    if (totalOi <= 0) out << u"整条链的持仓量都是 0——多半是没有行情权限,或这个到期日还没开始交易。"_s;
    return out;
}

QStringList makeReadout(const OJson& r) {
    const double spot = N(r, u"spot");
    const bool zeroDay = N(r, u"days_to_expiry") <= 1.0;
    const QString symbol = r.get(u"symbol"_s)->s, expiry = r.get(u"expiry"_s)->s;
    QStringList lines{u"%1 %2:现价 %3,链上 %4 个行权价,距到期 %5 天。"_s.arg(symbol.isEmpty() ? u"标的"_s : symbol, expiry.isEmpty() ? u"(未指定到期)"_s : expiry,
                                                                             util::pyFloat(spot), util::jsNumberToString(N(r, u"strike_count")),
                                                                             util::fmtF(N(r, u"days_to_expiry"), 2))};
    const auto describe = [&](const char16_t* key, const char16_t* label, QStringList& parts) {
        const OJson* w = r.get(QString::fromUtf16(key));
        if (w->type == OJson::Null) return;
        const OJson* d = w->get(u"distance_pct"_s);
        parts << u"%1 %2(%3 张,距现价 %4%)"_s.arg(QString::fromUtf16(label), util::pyFloat(N(*w, u"strike")), util::pyFloat(N(*w, u"size")),
                                                  util::fmtSF(d->type == OJson::Null ? 0 : d->n, 2));
    };
    QStringList oiParts, volParts;
    describe(u"call_wall", u"上方 Call 墙", oiParts);
    describe(u"put_wall", u"下方 Put 墙", oiParts);
    if (!oiParts.isEmpty()) lines << u"持仓量墙:%1。%2"_s.arg(oiParts.join(u';'), zeroDay ? u"(0DTE 下参考价值有限)"_s : QString());
    describe(u"call_vol_wall", u"上方成交墙", volParts);
    describe(u"put_vol_wall", u"下方成交墙", volParts);
    if (!volParts.isEmpty()) lines << u"成交量墙(今日真实流向):%1。"_s.arg(volParts.join(u';'));

    const QString regime = r.get(u"regime"_s)->s;
    if (regime == u"unknown" || isNull(r, u"net_gex")) {
        lines << u"净 GEX:算不出(缺隐含波动率与模型 gamma,或者没有未平仓量可称);现在是正 gamma 还是负 gamma 不知道。"_s;
    } else if (regime == u"neutral") {
        lines << u"净 GEX 0:看涨与看跌的 gamma 正好抵消。"_s;
    } else {
        const bool positive = regime == u"positive";
        const QString share = isNull(r, u"net_gex_ratio") ? QString() : u",净额占总 gamma 的 %1%"_s.arg(util::fmtF(std::fabs(N(r, u"net_gex_ratio")) * 100.0, 1));
        lines << u"净 GEX %1(%2%3):按「做市商多头 call、空头 put」的假设,做市商%4 gamma,倾向于%5。"_s.arg(
            money(N(r, u"net_gex")), positive ? u"正"_s : u"负"_s, share, positive ? u"多头"_s : u"空头"_s,
            positive ? u"涨了卖、跌了买,压住波动"_s : u"涨了追、跌了砍,放大波动"_s);
    }
    if (!isNull(r, u"gamma_flip")) {
        const double flip = N(r, u"gamma_flip");
        lines << u"Gamma 翻转位 %1(现价%2):越过它,压波动与放大波动的性质会掉个个儿。"_s.arg(util::pyFloat(flip), flip > spot ? u"上方"_s : u"下方"_s);
    }
    if (!isNull(r, u"max_pain")) {
        const double pain = N(*r.get(u"max_pain"_s), u"strike");
        lines << u"最大痛点 %1(距现价 %2%)——参考位,不是预言。"_s.arg(util::pyFloat(pain), util::fmtSF(spot && !std::isnan(spot) ? (pain / spot - 1.0) * 100.0 : 0.0, 2));
    }
    if (!isNull(r, u"pc_ratio_oi")) {
        const QString vol = isNull(r, u"pc_ratio_volume") ? QString() : u",成交 %1"_s.arg(util::fmtF(N(r, u"pc_ratio_volume"), 2));
        lines << u"Put/Call 比:持仓 %1%2。"_s.arg(util::fmtF(N(r, u"pc_ratio_oi"), 2), vol);
    }
    return lines;
}

OJson optN(const std::optional<double>& v) { return v ? js::N(*v) : OJson::null(); }
}  // namespace

OJson OptionRow::toJson() const {
    return js::object({{u"strike"_s, js::N(strike)}, {u"right"_s, js::S(right)}, {u"oi"_s, js::N(oi)}, {u"oiMissing"_s, js::B(oiMissing)}, {u"volume"_s, js::N(volume)},
                       {u"gamma"_s, optN(gamma)}, {u"iv"_s, optN(iv)}});
}

std::vector<OptionRow> toRows(const QList<OJson>& raw) {
    std::vector<OptionRow> out;
    for (const OJson& item : raw) {
        const QString right = js::strOr(js::propStrict(&item, u"right"_s), QString()).toUpper().left(1);
        if (right != u"C" && right != u"P") continue;
        const OJson* rawStrike = js::prop(&item, u"strike"_s);
        const double strike = js::num(rawStrike);
        if (!std::isfinite(strike) || js::nullish(rawStrike)) continue;
        if (strike <= 0) continue;
        const OJson* oiRaw = js::prop(&item, u"oi"_s);
        const bool oiMissing = js::nullish(oiRaw) || std::isnan(js::num(oiRaw));
        const auto orZero = [](double v) { return v && !std::isnan(v) ? v : 0.0; };  // Number(x) || 0
        const OJson* vol = js::prop(&item, u"volume"_s);
        OptionRow row;
        row.strike = strike;
        row.right = right;
        row.oi = oiMissing ? 0.0 : jm::max(orZero(js::num(oiRaw)), 0.0);
        row.oiMissing = oiMissing;
        row.volume = jm::max(orZero(js::nullish(vol) ? 0.0 : js::num(vol)), 0.0);
        row.gamma = optFloat(js::prop(&item, u"gamma"_s));
        row.iv = optFloat(js::prop(&item, u"iv"_s));
        out.push_back(row);
    }
    return out;
}

double bsGamma(double spot, double strike, double t, double sigma) {
    t = jm::max(t, kMinT);
    if (spot <= 0 || strike <= 0 || sigma <= 0) return 0.0;
    const double d1 = (jm::log(spot / strike) + 0.5 * sigma * sigma * t) / (sigma * std::sqrt(t));
    const double pdf = jm::exp(-0.5 * d1 * d1) / std::sqrt(2.0 * M_PI);
    return pdf / (spot * sigma * std::sqrt(t));
}

double yearsToExpiry(const QString& expiry, std::optional<double> nowEpochMs, const QString& symbol, const QString& tradingClass) {
    if (expiry.isEmpty() || expiry.size() != 8 || !std::all_of(expiry.begin(), expiry.end(), [](QChar c) { return c >= u'0' && c <= u'9'; })) return kMinT;
    const double year = util::jsStringToNumber(QStringView(expiry).mid(0, 4));
    const double month = util::jsStringToNumber(QStringView(expiry).mid(4, 2));
    const double day = util::jsStringToNumber(QStringView(expiry).mid(6, 2));
    // new Date(Date.UTC(…)) 换回来对不上(2 月 30 日、0050 年按 1950 算)就不认
    const QDate probe = QDateTime::fromMSecsSinceEpoch(qint64(util::dateUtc(year, month - 1, day)), QTimeZone::UTC).date();
    if (probe.year() != year || probe.month() != month || probe.day() != day) return kMinT;
    const double moment = nowEpochMs ? *nowEpochMs : util::dateNow();
    const std::optional<double> close = expiryEpochMs(symbol, expiry, tradingClass);
    const double closeMs = close ? *close : util::wallToEpoch({year, month, day, 16, 0, 0}, QString::fromUtf16(util::kET));
    return jm::max((closeMs - moment) / 1000.0 / (365.0 * 24 * 3600.0), kMinT);
}

Gex gexAt(const std::vector<OptionRow>& rows, double spot, double t, double multiplier) {
    return sumGex(rows, spot, multiplier, [&](const OptionRow& row) -> std::optional<double> {
        if (row.gamma) return row.gamma;
        if (row.iv) return bsGamma(spot, row.strike, t, *row.iv);
        return std::nullopt;
    });
}

Gex bsGexAt(const std::vector<OptionRow>& rows, double at, double t, double multiplier) {
    return sumGex(rows, at, multiplier, [&](const OptionRow& row) -> std::optional<double> {
        if (row.iv) return bsGamma(at, row.strike, t, *row.iv);
        return std::nullopt;
    });
}

bool gexSignConflict(const std::vector<OptionRow>& rows, double spot, double t, double multiplier) {
    const double here = gexAt(rows, spot, t, multiplier).net;
    const double model = bsGexAt(rows, spot, t, multiplier).net;
    return here != 0 && model != 0 && (here > 0) != (model > 0);
}

std::optional<double> gammaFlip(const std::vector<OptionRow>& rows, const std::vector<double>& strikes, double spot, double t, double multiplier) {
    return gexSignConflict(rows, spot, t, multiplier) ? std::nullopt : curveFlip(rows, strikes, spot, t, multiplier);
}

OJson gexWalls(const std::vector<OptionRow>& rows, double spot, double t, double multiplier) {
    // 每档:看涨 GEX、看跌 GEX(都记正);按行权价第一次出现的先后排
    std::vector<std::pair<double, std::pair<double, double>>> byK;
    for (const OptionRow& row : rows) {
        const Gex g = gexAt({row}, spot, t, multiplier);
        if (g.rows == 0) continue;
        auto it = std::find_if(byK.begin(), byK.end(), [&](const auto& e) { return e.first == row.strike; });
        if (it == byK.end()) it = byK.insert(byK.end(), {row.strike, {0.0, 0.0}});
        (row.right == u"C" ? it->second.first : it->second.second) += g.gross;
    }
    const auto pick = [&](auto&& sizeOf) -> OJson {
        std::optional<std::pair<double, double>> best;  // strike, 带号的值
        for (const auto& [strike, cp] : byK) {
            const double v = sizeOf(cp);
            if (!(std::fabs(v) > 0)) continue;
            if (!best || std::fabs(v) > std::fabs(best->second) ||
                (std::fabs(v) == std::fabs(best->second) && std::fabs(strike - spot) < std::fabs(best->first - spot)))
                best = std::pair(strike, v);
        }
        if (!best) return OJson::null();
        return js::object({{u"strike"_s, js::N(best->first)},
                           {u"gex"_s, js::N(util::pyRound(best->second, 0))},
                           {u"distance_pct"_s, spot && !std::isnan(spot) ? js::N(util::pyRound((best->first / spot - 1.0) * 100.0, 2)) : OJson::null()}});
    };
    return js::object({{u"call_gex_wall"_s, pick([](const auto& cp) { return cp.first; })},
                       {u"put_gex_wall"_s, pick([](const auto& cp) { return cp.second; })},
                       {u"max_gamma"_s, pick([](const auto& cp) { return cp.first - cp.second; })}});
}

OJson analyze(const QList<OJson>& raw, double spot, const QString& expiry, const QString& symbol, double multiplier, std::optional<double> nowEpochMs,
              const QString& tradingClass) {
    const std::vector<OptionRow> rows = toRows(raw);
    if (spot <= 0) throw OptionWallError(u"缺少标的现价,无法判断墙在现价上方还是下方。"_s);
    const Grid grid = byStrike(rows);
    if (grid.cells.size() < size_t(kMinStrikes))
        throw OptionWallError(u"只有 %1 个行权价的数据(至少需要 %2 个),画不出分布。可能是行权价范围取得太窄,或该到期日的链没有报价。"_s.arg(grid.cells.size()).arg(kMinStrikes));

    const double t = yearsToExpiry(expiry, nowEpochMs, symbol, tradingClass);
    std::vector<double> strikes;
    for (const auto& [k, c] : grid.cells) strikes.push_back(k);
    std::stable_sort(strikes.begin(), strikes.end(), [](double a, double b) { return a - b < 0; });

    OJson perStrike = js::array();
    for (double strike : strikes) {
        const Cell& cell = *grid.find(strike);
        std::vector<OptionRow> atStrike;
        for (const OptionRow& r : rows)
            if (r.strike == strike) atStrike.push_back(r);
        perStrike.items << js::object({{u"strike"_s, js::N(strike)},
                                       {u"call_oi"_s, js::N(util::pyRound(cell.call_oi, 1))},
                                       {u"put_oi"_s, js::N(util::pyRound(cell.put_oi, 1))},
                                       {u"call_vol"_s, js::N(util::pyRound(cell.call_vol, 1))},
                                       {u"put_vol"_s, js::N(util::pyRound(cell.put_vol, 1))},
                                       {u"net_gex"_s, js::N(util::pyRound(gexAt(atStrike, spot, t, multiplier).net, 0))}});
    }
    double totalCallOi = 0, totalPutOi = 0, totalCallVol = 0, totalPutVol = 0;
    for (const auto& [k, c] : grid.cells) {
        totalCallOi += c.call_oi;
        totalPutOi += c.put_oi;
        totalCallVol += c.call_vol;
        totalPutVol += c.put_vol;
    }
    const Gex gex = gexAt(rows, spot, t, multiplier);
    // 称出了分量才算知道
    const bool known = gex.gross > 0;
    const QString regime = !known ? u"unknown"_s : gex.net > 0 ? u"positive"_s : gex.net < 0 ? u"negative"_s : u"neutral"_s;
    const std::optional<double> flip = curveFlip(rows, strikes, spot, t, multiplier);
    const bool conflict = flip && gexSignConflict(rows, spot, t, multiplier);
    double missing = 0;
    bool hasGreeks = false;
    for (const OptionRow& r : rows) {
        if (r.oiMissing) missing += 1;
        if (r.iv) hasGreeks = true;
    }

    OJson result = js::object({
        {u"symbol"_s, js::S(symbol)},
        {u"expiry"_s, js::S(expiry)},
        {u"spot"_s, js::N(util::pyRound(spot, 4))},
        {u"multiplier"_s, js::N(multiplier)},
        {u"strike_count"_s, js::N(double(grid.cells.size()))},
        {u"days_to_expiry"_s, js::N(util::pyRound(t * 365.0, 3))},
        {u"strikes"_s, perStrike},
        {u"call_wall"_s, wall(grid, 0, spot, true)},
        {u"put_wall"_s, wall(grid, 1, spot, false)},
        {u"call_vol_wall"_s, wall(grid, 2, spot, true)},
        {u"put_vol_wall"_s, wall(grid, 3, spot, false)},
        {u"max_pain"_s, maxPain(grid, multiplier)},
        {u"net_gex"_s, known ? js::N(util::pyRound(gex.net, 0)) : OJson::null()},
        {u"gross_gex"_s, known ? js::N(util::pyRound(gex.gross, 0)) : OJson::null()},
        {u"net_gex_ratio"_s, known && gex.gross > 0 ? js::N(util::pyRound(gex.net / gex.gross, 4)) : OJson::null()},
        {u"gamma_flip"_s, conflict ? OJson::null() : optN(flip)},
        {u"regime"_s, js::S(regime)},
        {u"total_call_oi"_s, js::N(util::pyRound(totalCallOi, 1))},
        {u"total_put_oi"_s, js::N(util::pyRound(totalPutOi, 1))},
        {u"pc_ratio_oi"_s, totalCallOi && !std::isnan(totalCallOi) ? js::N(util::pyRound(totalPutOi / totalCallOi, 3)) : OJson::null()},
        {u"pc_ratio_volume"_s, totalCallVol && !std::isnan(totalCallVol) ? js::N(util::pyRound(totalPutVol / totalCallVol, 3)) : OJson::null()},
        {u"has_greeks"_s, js::B(hasGreeks)},
        {u"oi_missing"_s, js::N(missing)},
    });
    QStringList warnings = makeWarnings(result, gex.rows > 0);
    if (conflict)
        warnings << u"gamma 翻转位不给:标的挪到别处的 gamma 只能用 BS 重算,而它在现价处的正负和净 GEX(券商的模型 gamma)对不上——多半是净额本来就接近 0,翻转位就在现价附近。"_s;
    const QStringList readout = makeReadout(result);
    result.set(u"warnings"_s, js::strings(warnings));
    result.set(u"readout"_s, js::strings(readout));
    return result;
}

OJson levelsForPa(const OJson& result) {
    OJson out = js::array();
    const OJson* dte = result.get(u"days_to_expiry"_s);
    const bool zeroDay = (js::nullish(dte) ? 99.0 : js::num(dte)) <= 1.0;
    const auto add = [&](const char16_t* key, const char16_t* kind, const char16_t* note) {
        const OJson* w = result.get(QString::fromUtf16(key));
        if (!js::truthy(w)) return;
        OJson o = js::object();
        if (const OJson* p = js::prop(w, u"strike"_s)) o.set(u"price"_s, *p);
        o.set(u"kind"_s, js::S(QString::fromUtf16(kind)));
        o.set(u"note"_s, js::S(QString::fromUtf16(note)));
        if (const OJson* d = js::prop(w, u"distance_pct"_s)) o.set(u"distance_pct"_s, *d);
        out.items << o;
    };
    // 0DTE 下成交量墙才有意义,排在前面
    if (zeroDay) {
        add(u"call_vol_wall", u"resistance", u"今日成交最密的上方行权价");
        add(u"put_vol_wall", u"support", u"今日成交最密的下方行权价");
    }
    add(u"call_wall", u"resistance", u"持仓量最大的上方行权价");
    add(u"put_wall", u"support", u"持仓量最大的下方行权价");
    if (js::truthy(result.get(u"max_pain"_s))) {
        OJson o = js::object();
        if (const OJson* p = js::prop(result.get(u"max_pain"_s), u"strike"_s)) o.set(u"price"_s, *p);
        o.set(u"kind"_s, js::S(u"pivot"_s));
        o.set(u"note"_s, js::S(u"最大痛点(统计量,非预言)"_s));
        o.set(u"distance_pct"_s, OJson::null());
        out.items << o;
    }
    const OJson* flip = result.get(u"gamma_flip"_s);
    if (!js::nullish(flip))
        out.items << js::object({{u"price"_s, *flip}, {u"kind"_s, js::S(u"pivot"_s)}, {u"note"_s, js::S(u"Gamma 翻转位"_s)}, {u"distance_pct"_s, OJson::null()}});
    return out;
}

}  // namespace ibkr::analysis::optionwall
