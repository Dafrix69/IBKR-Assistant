#include "parsing/shorthand.h"

#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/py.h"
#include "util/tz.h"

#include <QRegularExpression>

#include <cmath>
#include <limits>
#include <optional>
#include <vector>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace jm = ibkr::util::jsmath;

namespace ibkr::parsing::shorthand {

namespace {
// ---- JS 正则的几处语义,换成 PCRE 写法
// \s:JS 的那一组(PCRE 只认 ASCII);.:不含四个行终结符;$(不带 m):输入的末尾 → \z
QString S() { return util::jsSpaceClassBody(); }
QString sp() { return u"["_s + S() + u"]"_s; }
const QString kDot = u"[^\\n\\r\\x{2028}\\x{2029}]"_s;

QRegularExpression rx(const QString& pattern, bool ci = false) {
    return QRegularExpression(pattern, ci ? QRegularExpression::CaseInsensitiveOption : QRegularExpression::NoPatternOption);
}

QString maskSurrogates(const QString& s) { return util::jsMaskLoneSurrogates(s); }

const QRegularExpression& wingHint() {
    static const QRegularExpression r = rx(u"\\d"_s + sp() + u"*cm|翼宽"_s + sp() + u"*\\d|±"_s + sp() + u"*\\d+(?:\\.\\d+)?"_s + sp() + u"*点"_s, true);
    return r;
}
const QRegularExpression& spreadType() {
    static const QRegularExpression r =
        rx(u"(?<![A-Za-z])(bull"_s + sp() + u"*put|bear"_s + sp() + u"*call)(?:"_s + sp() + u"*spread)?(?![A-Za-z])"_s, true);
    return r;
}
const QRegularExpression& spreadShape() {
    static const QRegularExpression r = rx(u"(?<![\\d.])\\d{2,5}"_s + sp() + u"*["_s + S() + u"/-]"_s + sp() + u"*\\d{2,5}(?![\\d.])"_s + kDot +
                                           u"*(?<![\\d.])-"_s + sp() + u"*\\d"_s);
    return r;
}
bool test(const QRegularExpression& r, const QString& s) { return r.match(s).hasMatch(); }

QString fmt(double v) { return util::pyG(v); }

/// take:摘掉第一处匹配(换成一个空格),回匹配
std::optional<QRegularExpressionMatch> take(QString& work, const QRegularExpression& re) {
    const QRegularExpressionMatch m = re.match(work);
    if (!m.hasMatch()) return std::nullopt;
    work = work.left(m.capturedStart(0)) + u' ' + work.mid(m.capturedEnd(0));
    return m;
}

const QStringList& fillers() {
    static const QStringList f{
        u"帮我"_s,     u"给我"_s,     u"麻烦"_s,     u"谢谢"_s,       u"请"_s,           u"尝试一下"_s,       u"尝试下"_s,     u"尝试"_s,
        u"试一下"_s,   u"试试看"_s,   u"试下"_s,     u"试试"_s,       u"考虑下"_s,       u"考虑"_s,           u"看看"_s,       u"意思下"_s,
        u"一下"_s,     u"好贵"_s,     u"能不能挂进去"_s, u"能不能进去"_s, u"能不能接到"_s, u"能不能进"_s,       u"有没有机会接"_s, u"有没有机会进"_s,
        u"接不到拉倒"_s, u"进不去就拉倒"_s, u"不要追价哦"_s, u"不要追价"_s, u"不追价"_s,     u"便宜的"_s,         u"赌博小彩票"_s, u"小彩票"_s,
        u"赌博"_s,     u"彩票单"_s,   u"彩票"_s,     u"来一个"_s,     u"来一张"_s,       u"来个"_s,           u"来"_s,         u"买入"_s,
        u"买"_s,       u"开仓"_s,     u"开个"_s,     u"开"_s,         u"挂个"_s,         u"挂"_s,             u"今天的"_s,     u"当日到期"_s,
        u"当日"_s,     u"今日"_s,     u"今天"_s,     u"0dte"_s,
    };
    return f;
}
const QStringList& spreadFillers() {
    static const QStringList f{u"这个区间"_s, u"区间"_s, u"收租"_s, u"左右"_s, u"挂单下"_s, u"挂单"_s, u"可以"_s};
    return f;
}
std::optional<double> cnNum(const QString& c) {
    static const QHash<QString, double> m{{u"一"_s, 1}, {u"两"_s, 2}, {u"二"_s, 2}, {u"三"_s, 3}, {u"四"_s, 4}, {u"五"_s, 5},
                                          {u"六"_s, 6}, {u"七"_s, 7}, {u"八"_s, 8}, {u"九"_s, 9}, {u"十"_s, 10}};
    if (!m.contains(c)) return std::nullopt;
    return m.value(c);
}
double num(const QString& s) { return util::jsStringToNumber(s); }
QStringList allMatches(const QRegularExpression& re, const QString& s) {
    QStringList out;
    auto it = re.globalMatch(s);
    while (it.hasNext()) out << it.next().captured(0);
    return out;
}

/// snapshot[symbol]:没有这一键是 undefined;Number(x) 是有限数才算
std::optional<double> spotOf(const OJson& snapshot, const QString& symbol) {
    const OJson* raw = js::prop(&snapshot, symbol);
    if (!raw) return std::nullopt;
    const double v = js::num(raw);
    return std::isfinite(v) ? std::optional(v) : std::nullopt;
}

struct Common {
    QString tif;
    bool outsideRth = false;
    bool tomorrow = false;
};
/// 张数:「N张」或中文数量词;没有 → 1(加一句提示);越界 → 空
std::optional<double> takeQty(QString& work, QStringList& warnings) {
    static const QRegularExpression rq = rx(u"(?<![\\d.])(\\d{1,3})"_s + sp() + u"*张"_s);
    static const QRegularExpression rc = rx(u"([一两二三四五六七八九十])"_s + sp() + u"*张"_s);
    std::optional<double> qty;
    if (const auto m = take(work, rq)) qty = num(m->captured(1));
    if (!qty)
        if (const auto m = take(work, rc)) qty = cnNum(m->captured(1));
    if (!qty) {
        qty = 1;
        warnings << u"未写张数,已按默认 1 张处理"_s;
    }
    if (!(*qty >= 1 && *qty <= 999)) return std::nullopt;
    return qty;
}

/// 到期:默认当日;「明天」= 下一交易日(只跳周末)。周末默认当日的:回拒绝(rejection 放进 out)
struct Expiry {
    QString expiry, label;
};
std::optional<Expiry> expiryOf(bool tomorrow, const domain::EtNow& moment, QStringList& warnings, const QString& full, const QString& what, OJson& rejection) {
    if (tomorrow) {
        double ordinal = util::dateOrdinal(moment.date) + 1;
        while (util::weekdayOfDate(util::ordinalToDate(ordinal)) >= 5) ordinal += 1;
        const QString day = util::ordinalToDate(ordinal);
        warnings << u"「明天」按下一交易日 %1 处理"_s.arg(day);
        return Expiry{QString(day).remove(u'-'), day + u" 到期"_s};
    }
    if (util::weekdayOfDate(moment.date) >= 5) {
        const QString dayName = util::weekdayOfDate(moment.date) == 5 ? u"周六"_s : u"周日"_s;
        rejection = js::object({{u"orders"_s, js::array()},
                                {u"rejections"_s, js::array({js::object({{u"original_text"_s, js::S(full)},
                                                                         {u"code"_s, js::S(u"UNSUPPORTED"_s)},
                                                                         {u"message"_s, js::S(u"今天(%1)不是交易日,默认当日到期的%2无法下单;要下周一的写「明天」,或写明到期日。"_s.arg(dayName, what))}})})}});
        return std::nullopt;
    }
    warnings << u"未写到期日,已按默认当日到期处理"_s;
    return Expiry{QString(moment.date).remove(u'-'), moment.date + u" 当日到期"_s};
}

OJson legOf(const QString& action, double ratio, const QString& expiry, double strike, const QString& right, bool spx) {
    OJson out = js::object({{u"action"_s, js::S(action)},
                            {u"ratio"_s, js::N(ratio)},
                            {u"lastTradeDateOrContractMonth"_s, js::S(expiry)},
                            {u"strike"_s, js::N(strike)},
                            {u"right"_s, js::S(right)}});
    if (spx) out.set(u"tradingClass"_s, js::S(u"SPXW"_s));
    return out;
}

OJson payload(const QString& summary, const QString& symbol, const QString& strategy, const OJson& legs, const QString& action, double qty,
              const std::optional<double>& price, const QString& tif, bool outsideRth, const QString& reason, const QStringList& warnings) {
    return js::object({{u"orders"_s,
                        js::array({js::object({
                            {u"intent_summary"_s, js::S(summary)},
                            {u"contract"_s, js::object({{u"secType"_s, js::S(u"BAG"_s)},
                                                        {u"symbol"_s, js::S(symbol)},
                                                        {u"exchange"_s, js::S(u"SMART"_s)},
                                                        {u"currency"_s, js::S(u"USD"_s)},
                                                        {u"combo_strategy"_s, js::S(strategy)},
                                                        {u"legs"_s, legs}})},
                            {u"execution_type"_s, js::S(u"IMMEDIATE"_s)},
                            {u"trigger"_s, OJson::null()},
                            {u"account"_s, js::S(u"DEFAULT"_s)},
                            {u"order"_s, js::object({{u"action"_s, js::S(action)},
                                                     {u"orderType"_s, js::S(u"LMT"_s)},
                                                     {u"totalQuantity"_s, js::N(qty)},
                                                     {u"price_mode"_s, js::S(price ? u"EXPLICIT"_s : u"AUTO_MID"_s)},
                                                     {u"lmtPrice"_s, price ? js::N(*price) : OJson::null()},
                                                     {u"tif"_s, js::S(tif)},
                                                     {u"outsideRth"_s, js::B(outsideRth)}})},
                            {u"reason"_s, js::S(reason)},
                            {u"confidence"_s, js::N(1.0)},
                            {u"warnings"_s, js::strings(warnings)},
                        })})},
                       {u"rejections"_s, js::array()}});
}

Common takeCommon(QString& work) {
    static const QRegularExpression gtc = rx(u"GTC|一直有效"_s, true);
    static const QRegularExpression orth = rx(u"盘外|隔夜|夜盘|盘前|盘后"_s);
    static const QRegularExpression tom = rx(u"明天的|明天|明日"_s);
    Common c;
    c.tif = take(work, gtc) ? u"GTC"_s : u"DAY"_s;
    c.outsideRth = take(work, orth).has_value();
    c.tomorrow = take(work, tom).has_value();
    return c;
}

const QRegularExpression& digits() {
    static const QRegularExpression r = rx(u"\\d+(?:\\.\\d+)?"_s);
    return r;
}

OJson parseCreditSpread(const QString& full, const QString& text, const QString& reason, const OJson& snapshot, const domain::EtNow& moment) {
    static const QRegularExpression block = rx(
        u"[;;\\n]|时候|时,|涨到|跌到|突破|跌破|破了|站稳|卖|做空|平仓|取消|理由|止盈|止损|接货|加仓|撤单|上移|下移|日历|正股|海鸥|或者|如果|守不住|翻倍|蝴蝶"_s);
    if (test(block, text) || test(wingHint(), text)) return OJson::null();
    QString work = text;
    QStringList warnings;

    const auto mType = take(work, spreadType());
    if (!mType || test(spreadType(), work)) return OJson::null();  // 两个类型词:是两张单
    static const QRegularExpression bull = rx(u"bull"_s, true);
    const bool bullPut = test(bull, mType->captured(1));
    const Common c = takeCommon(work);

    static const QRegularExpression creditRe = rx(u"(?<![\\d.])-"_s + sp() + u"*(\\d+(?:\\.\\d+)?)(?:"_s + sp() + u"*(?:到|至|~|-)?"_s + sp() + u"*-"_s + sp() +
                                                  u"*(\\d+(?:\\.\\d+)?))?"_s);
    static const QRegularExpression negRe = rx(u"(?<![\\d.])-"_s + sp() + u"*\\d"_s);
    const auto mCredit = take(work, creditRe);
    if (test(negRe, work)) return OJson::null();  // 还有一个负数:说不清哪个是价格
    std::vector<double> quoted;
    if (mCredit) quoted.push_back(num(mCredit->captured(1)));
    if (mCredit && mCredit->capturedStart(2) >= 0) quoted.push_back(num(mCredit->captured(2)));
    std::optional<double> credit;
    if (!quoted.empty()) {
        double m = -std::numeric_limits<double>::infinity();
        for (double q : quoted) m = jm::max(m, q);
        credit = m;
    }

    for (const QString& f : spreadFillers()) work.replace(f, u" "_s);
    for (const QString& f : fillers()) work.replace(f, u" "_s);
    static const QRegularExpression dte = rx(u"0dte"_s, true);
    work.replace(dte, u" "_s);

    const auto qty = takeQty(work, warnings);
    if (!qty) return OJson::null();

    static const QRegularExpression symRe = rx(u"[A-Za-z]{2,5}"_s);
    static const QRegularExpression letter = rx(u"[A-Za-z]"_s);
    const auto mSym = take(work, symRe);
    const QString symbol = mSym ? mSym->captured(0).toUpper() : u"SPX"_s;
    if (!mSym) warnings << u"未写标的,默认按 SPX 处理"_s;
    if (test(letter, work)) return OJson::null();

    static const QRegularExpression noise = rx(u"[的吧哦呢啦呀嘛了个到至]|[,。、~!?():;/-]|"_s + sp() + u"+"_s);
    work.replace(noise, u" "_s);
    const QStringList tokens = allMatches(digits(), work);
    work.replace(digits(), u" "_s);
    if (!util::jsTrim(work).isEmpty() || tokens.size() != 2) return OJson::null();

    const std::optional<double> spot = spotOf(snapshot, symbol);
    static const QRegularExpression rel = rx(u"^\\d{1,2}\\z"_s);
    static const QRegularExpression abs = rx(u"^\\d{3,5}(?:\\.\\d+)?\\z"_s);
    const bool relative = test(rel, tokens[0]) && test(rel, tokens[1]);
    const bool absolute = test(abs, tokens[0]) && test(abs, tokens[1]);
    double lo, hi;
    if (relative) {
        if (!spot) return OJson::null();
        const double a = num(tokens[0]), b = num(tokens[1]);
        const double diff = std::fmod(b - a + 150, 100) - 50;
        if (diff == 0 || std::fabs(diff) == 50) return OJson::null();
        const double base = std::floor(*spot / 100.0) * 100.0;
        double first = std::nan(""), bestDist = std::numeric_limits<double>::infinity();
        for (double shift : {-100.0, 0.0, 100.0}) {
            const double candidate = base + shift + a;
            const double dist = std::fabs(candidate + diff / 2 - *spot);
            if (dist < bestDist) {
                bestDist = dist;
                first = candidate;
            }
        }
        if (!(bestDist < 50)) return OJson::null();
        lo = jm::min(first, first + diff);
        hi = jm::max(first, first + diff);
        warnings << u"「%1 %2」按 %3/%4 理解(离现价 %5 最近的一组)"_s.arg(tokens[0], tokens[1], fmt(first), fmt(first + diff), fmt(*spot));
    } else if (absolute) {
        lo = jm::min(num(tokens[0]), num(tokens[1]));
        hi = jm::max(num(tokens[0]), num(tokens[1]));
        if (spot && std::fabs((lo + hi) / 2 - *spot) / *spot > 0.2) return OJson::null();
    } else {
        return OJson::null();
    }
    const double width = hi - lo;
    if (!(width > 0 && width <= 500)) return OJson::null();
    if (credit && !(*credit > 0 && *credit < width)) return OJson::null();

    OJson rejection;
    const auto exp = expiryOf(c.tomorrow, moment, warnings, full, u"价差"_s, rejection);
    if (!exp) return rejection;

    if (quoted.size() == 2 && quoted[0] != quoted[1]) {
        const double qmin = jm::min(quoted[0], quoted[1]), qmax = jm::max(quoted[0], quoted[1]);
        warnings << u"权利金写的是区间 %1–%2,按收得多的一头 %3 挂单(可能成交不了,不会比写的差)"_s.arg(fmt(qmin), fmt(qmax), fmt(qmax));
    }
    if (!credit) warnings << u"未写收的权利金,将在下单时按盘口中间价定价(AUTO_MID);若对收多少敏感,请写成负数,如 '-2.5'"_s;
    warnings << u"本地速记解析(未经大模型),语法 "_s + kGrammarVersion;

    const QString right = bullPut ? u"P"_s : u"C"_s;
    const double sellStrike = bullPut ? hi : lo;
    const double buyStrike = bullPut ? lo : hi;
    const bool spx = symbol == u"SPX";
    const QString summary = u"卖出(贷方)"_s + util::jsNumberToString(*qty) + u" 张 "_s + exp->label + u"的 "_s + symbol + u" "_s + fmt(lo) + u"/"_s + fmt(hi) + u" "_s +
                            (bullPut ? u"看跌"_s : u"看涨"_s) + u"贷方价差"_s + u"(卖 "_s + fmt(sellStrike) + right + u"、买 "_s + fmt(buyStrike) + right + u",宽 "_s +
                            fmt(width) + u" 点),"_s + (credit ? u"净权利金不低于 "_s + fmt(*credit) : u"净权利金按下单时盘口中间价确定"_s);
    return payload(summary, symbol, u"VERTICAL"_s, js::array({legOf(u"BUY"_s, 1, exp->expiry, buyStrike, right, spx), legOf(u"SELL"_s, 1, exp->expiry, sellStrike, right, spx)}),
                   u"SELL"_s, *qty, credit, c.tif, c.outsideRth, reason, warnings);
}
}  // namespace

bool looksLikeShorthand(const QString& text) {
    const QString t = maskSurrogates(util::jsNormalizeNfkc(text));
    return t.contains(u"蝴蝶"_s) || test(wingHint(), t) || test(spreadType(), t);
}

bool looksLikeOrder(const QString& text) {
    const QString t = maskSurrogates(util::jsNormalizeNfkc(text));
    return test(wingHint(), t) || test(spreadType(), t) || test(spreadShape(), t);
}

bool spreadWithoutType(const QString& text) {
    const QString t = maskSurrogates(util::jsNormalizeNfkc(text));
    return test(spreadShape(), t) && !test(spreadType(), t) && !test(wingHint(), t);
}

QStringList shorthandSymbols(const QString& instruction) {
    const QString text = maskSurrogates(util::jsNormalizeNfkc(instruction));
    if (!looksLikeShorthand(text)) return {};
    // 价差的类型词不是标的:先摘掉(只摘第一处)再找字母 token
    QString work = text;
    const QRegularExpressionMatch t = spreadType().match(work);
    if (t.hasMatch()) work = work.left(t.capturedStart(0)) + u' ' + work.mid(t.capturedEnd(0));
    static const QRegularExpression tok = rx(u"(?!cm\\b|CM\\b)[A-Za-z]{2,5}"_s);
    const QRegularExpressionMatch m = tok.match(work);
    const QString token = m.hasMatch() ? m.captured(0).toUpper() : u"SPX"_s;
    static const QStringList junk{u"CM"_s, u"GTC"_s, u"CALL"_s, u"PUT"_s, u"DTE"_s};
    return junk.contains(token) ? QStringList{u"SPX"_s} : QStringList{token};
}

OJson tryParseShorthand(const QString& instruction, const OJson& snapshot, const domain::EtNow& moment, ShorthandMeta* meta) {
    // 全角统一成半角;原文(含落单的代理项)留着给 reason / original_text
    const QString fullRaw = util::jsTrim(util::jsNormalizeNfkc(instruction));
    const QString full = maskSurrogates(fullRaw);
    QString reason = u"本地速记解析"_s;
    QString text = full;
    static const QRegularExpression reasonRe = rx(u"[,,。;;"_s + S() + u"]*理由"_s + sp() + u"*:?"_s + sp() + u"*("_s + kDot + u"*)\\z"_s);
    if (const QRegularExpressionMatch m = reasonRe.match(full); m.hasMatch()) {
        const QString reasonText = util::jsTrim(fullRaw.mid(m.capturedStart(1), m.capturedLength(1)));
        if (reasonText.isEmpty()) return OJson::null();
        reason = reasonText;
        text = util::jsTrim(full.left(m.capturedStart(0)));
    }
    if (text.isEmpty() || text.size() > 80) return OJson::null();
    if (test(spreadType(), text)) {
        if (meta) {
            meta->relativeCenter = false;
            meta->set = true;
        }
        return parseCreditSpread(fullRaw, text, reason, snapshot, moment);
    }
    const bool hasButterflyWord = text.contains(u"蝴蝶"_s);
    if (!hasButterflyWord && !test(wingHint(), text)) return OJson::null();
    static const QRegularExpression block = rx(
        u"[;;\\n]|时候|时,|的时候|涨到|跌到|突破|跌破|卖|做空|平仓|取消|理由|止盈|止损|接货|加仓|撤单|日历|spread|正股|海鸥|或者|如果|守不住|翻倍"_s, true);
    if (test(block, text)) return OJson::null();

    QString work = text;
    QStringList warnings;
    const Common c = takeCommon(work);

    static const QRegularExpression rightRe = rx(u"看涨|看跌|call|put"_s, true);
    std::optional<QString> explicitRight;
    if (const auto m = take(work, rightRe)) {
        const QString token = m->captured(0).toLower();
        explicitRight = token == u"看涨" || token == u"call" ? u"C"_s : u"P"_s;
    }

    // 翼宽(必填)
    static const QRegularExpression w1 = rx(u"(\\d+(?:\\.\\d+)?)"_s + sp() + u"*cm"_s, true);
    static const QRegularExpression w2 = rx(u"翼宽"_s + sp() + u"*(\\d+(?:\\.\\d+)?)"_s + sp() + u"*点?"_s);
    static const QRegularExpression w3 = rx(u"±"_s + sp() + u"*(\\d+(?:\\.\\d+)?)"_s + sp() + u"*点"_s);
    auto mWing = take(work, w1);
    if (!mWing) mWing = take(work, w2);
    if (!mWing) mWing = take(work, w3);
    if (!mWing) return OJson::null();
    const double wing = num(mWing->captured(1));
    if (!(wing > 0 && wing <= 500)) return OJson::null();

    for (const QString& f : fillers()) work.replace(f, u" "_s);
    static const QRegularExpression dte = rx(u"0dte"_s, true);
    work.replace(dte, u" "_s);
    const auto qty = takeQty(work, warnings);
    if (!qty) return OJson::null();

    // 中心:三种显式写法,最多命中一种
    static const QRegularExpression c1 = rx(u"(?<![\\d.])(\\d{4,5}(?:\\.\\d+)?)"_s + sp() + u"*(?=蝴蝶)"_s);
    static const QRegularExpression c2 = rx(u"(?<![\\d.])(\\d{1,2})"_s + sp() + u"*(?=蝴蝶)"_s);
    static const QRegularExpression c3 = rx(u"(?<![\\d.])(\\d{3,5}(?:\\.\\d+)?)"_s + sp() + u"*的"_s);
    const auto mC1 = take(work, c1);
    const auto mC2 = take(work, c2);
    const auto mC3 = take(work, c3);
    std::vector<const QRegularExpressionMatch*> hits;
    for (const auto* m : {&mC1, &mC2, &mC3})
        if (*m) hits.push_back(&**m);
    if (hits.size() > 1) return OJson::null();
    const std::optional<double> centerTail = mC2 ? std::optional(num(mC2->captured(1))) : std::nullopt;
    std::optional<double> centerAbs = !mC2 && !hits.empty() ? std::optional(num(hits[0]->captured(1))) : std::nullopt;
    if (meta) {
        meta->relativeCenter = centerTail.has_value();
        meta->set = true;
    }

    static const QRegularExpression symRe = rx(u"[A-Za-z]{2,5}"_s);
    static const QRegularExpression letter = rx(u"[A-Za-z]"_s);
    const auto mSym = take(work, symRe);
    const QString symbol = mSym ? mSym->captured(0).toUpper() : u"SPX"_s;
    if (!mSym) warnings << u"未写标的,默认按 SPX 处理"_s;
    if (test(letter, work)) return OJson::null();

    static const QRegularExpression p1 = rx(u"权利金"_s + sp() + u"*(?:不超过|不高于|上限)?"_s + sp() + u"*(\\d+(?:\\.\\d+)?)"_s);
    static const QRegularExpression p2 = rx(u"(\\d+(?:\\.\\d+)?)"_s + sp() + u"*(?:块钱|块|刀|美元|美金)"_s);
    auto mPrem = take(work, p1);
    if (!mPrem) mPrem = take(work, p2);
    const std::optional<double> keywordPremium = mPrem ? std::optional(num(mPrem->captured(1))) : std::nullopt;

    static const QRegularExpression noise = rx(u"蝴蝶|[的吧哦呢啦呀嘛了个]|[,。、~!?():;]|"_s + sp() + u"+"_s);
    work.replace(noise, u" "_s);
    std::vector<double> numbers;
    for (const QString& t : allMatches(digits(), work)) numbers.push_back(num(t));
    work.replace(digits(), u" "_s);
    if (!util::jsTrim(work).isEmpty()) return OJson::null();
    std::optional<double> premium = keywordPremium;
    if (!centerAbs && !centerTail) {
        std::vector<double> bigs, smalls;
        for (double x : numbers) (x >= 1000 && x > 2 * wing ? bigs : smalls).push_back(x);
        if (bigs.size() != 1 || smalls.size() > 1) return OJson::null();
        centerAbs = bigs[0];
        if (!smalls.empty()) {
            if (premium) return OJson::null();
            premium = smalls[0];
        }
    } else {
        if (numbers.size() > 1) return OJson::null();
        if (!numbers.empty()) {
            if (premium) return OJson::null();
            premium = numbers[0];
        }
    }
    if (premium && !(*premium > 0 && *premium < wing)) return OJson::null();

    OJson rejection;
    const auto exp = expiryOf(c.tomorrow, moment, warnings, fullRaw, u"蝴蝶"_s, rejection);
    if (!exp) return rejection;

    const std::optional<double> spot = spotOf(snapshot, symbol);
    double center;
    if (centerTail) {
        if (!spot) return OJson::null();
        center = std::floor(*spot / 100.0) * 100.0 + *centerTail;
        warnings << u"「%1蝴蝶」按中心 %2(现价百位+%3)理解"_s.arg(util::jsNumberToString(*centerTail), fmt(center), util::jsNumberToString(*centerTail));
    } else {
        center = *centerAbs;
    }
    if (!(center > wing)) return OJson::null();
    if (spot && std::fabs(center - *spot) / *spot > 0.2) return OJson::null();

    QString right;
    if (explicitRight) {
        right = *explicitRight;
    } else {
        if (!spot) return OJson::null();
        if (center > *spot) {
            right = u"C"_s;
            warnings << u"中心 %1 高于现价 %2,推断为看涨蝴蝶"_s.arg(fmt(center), fmt(*spot));
        } else if (center < *spot) {
            right = u"P"_s;
            warnings << u"中心 %1 低于现价 %2,推断为看跌蝴蝶"_s.arg(fmt(center), fmt(*spot));
        } else {
            right = u"C"_s;
            warnings << u"中心 %1 等于现价,默认按看涨蝴蝶处理"_s.arg(fmt(center));
        }
    }
    if (!hasButterflyWord) warnings << u"未写「蝴蝶」,按 cm 行话默认为蝴蝶组合"_s;
    if (!premium) warnings << u"未指定净权利金上限,将在下单时按盘口中间价定价(AUTO_MID);若成交成本敏感,请写明如'权利金不超过 3'"_s;
    warnings << u"本地速记解析(未经大模型),语法 "_s + kGrammarVersion;

    const bool spx = symbol == u"SPX";
    const double strikes[] = {center - wing, center, center + wing};
    const QString side = right == u"C" ? u"看涨"_s : u"看跌"_s;
    const QString priceText = premium ? u"净权利金上限 "_s + fmt(*premium) : u"净权利金按下单时盘口中间价确定"_s;
    const QString summary = u"买入 "_s + util::jsNumberToString(*qty) + u" 张 "_s + exp->label + u"的 "_s + symbol + u" "_s + fmt(strikes[0]) + u"/"_s + fmt(strikes[1]) +
                            u"/"_s + fmt(strikes[2]) + u" "_s + side + u"蝴蝶"_s + u"(翼宽 "_s + fmt(wing) + u" 点),"_s + priceText;
    return payload(summary, symbol, u"BUTTERFLY"_s,
                   js::array({legOf(u"BUY"_s, 1, exp->expiry, strikes[0], right, spx), legOf(u"SELL"_s, 2, exp->expiry, strikes[1], right, spx),
                              legOf(u"BUY"_s, 1, exp->expiry, strikes[2], right, spx)}),
                   u"BUY"_s, *qty, premium, c.tif, c.outsideRth, reason, warnings);
}

}  // namespace ibkr::parsing::shorthand
