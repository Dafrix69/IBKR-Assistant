#include "analysis/market.h"

#include "util/error.h"
#include "util/jsobj.h"
#include "util/market_js.h"

#include <QSet>

#include <cmath>
#include <optional>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;

namespace ibkr::analysis::market {

namespace {
const QSet<QString>& stopwords() {
    static const QSet<QString> s{u"BUY"_s,  u"SELL"_s,   u"CALL"_s,   u"PUT"_s,  u"LMT"_s,    u"MKT"_s,  u"STP"_s,   u"GTC"_s,    u"DAY"_s,  u"USD"_s,
                                 u"AT"_s,   u"TO"_s,     u"THE"_s,    u"AND"_s,  u"OR"_s,     u"IF"_s,   u"ON"_s,    u"OF"_s,     u"IN"_s,   u"FOR"_s,
                                 u"WITH"_s, u"LIMIT"_s,  u"MARKET"_s, u"STOP"_s, u"SPREAD"_s, u"OPEN"_s, u"CLOSE"_s, u"DTE"_s,    u"ITM"_s,  u"OTM"_s,
                                 u"A"_s,    u"AN"_s,     u"IS"_s,     u"BE"_s,   u"PM"_s,     u"AM"_s,   u"ET"_s};
    return s;
}
// 即使紧贴中文/数字也绝不当 ticker 的记号:'25cm' 是本系统用户的翼宽行话
bool hardExclude(const QString& t) { return t == u"CM"; }

bool isLatin(QChar ch) { return (ch >= u'A' && ch <= u'Z') || (ch >= u'a' && ch <= u'z'); }
bool isDigit(QChar ch) { return ch >= u'0' && ch <= u'9'; }

bool cjkAdjacent(const QString& text, qsizetype start, qsizetype end) {
    const auto hit = [](std::optional<QChar> ch) { return ch && ((ch->unicode() >= 0x4e00 && ch->unicode() <= 0x9fff) || isDigit(*ch)); };
    const std::optional<QChar> before = start > 0 ? std::optional(text[start - 1]) : std::nullopt;
    const std::optional<QChar> after = end < text.size() ? std::optional(text[end]) : std::nullopt;
    return hit(before) || hit(after);
}

/// 字母紧跟 3 位以上数字('GB300'、'RTX5090'、'H200' 这类产品型号)
bool modelNumber(const QString& text, qsizetype end) {
    if (end + 3 > text.size()) return false;
    return isDigit(text[end]) && isDigit(text[end + 1]) && isDigit(text[end + 2]);
}
}  // namespace

QStringList extractSymbols(const QString& text, const domain::Settings& settings, const std::optional<QStringList>& extra, bool defaultIndex) {
    QStringList found;
    const auto add = [&](const QString& raw) {
        const QString symbol = raw.toUpper();
        if (!symbol.isEmpty() && !found.contains(symbol)) found << symbol;
    };

    QSet<QString> known;
    for (const QString& k : settings.symbol_aliases.keys()) known.insert(settings.symbol_aliases.value(k));
    // /[A-Za-z]{1,5}/g
    for (qsizetype i = 0; i < text.size();) {
        if (!isLatin(text[i])) {
            ++i;
            continue;
        }
        const qsizetype start = i;
        qsizetype end = i;
        while (end < text.size() && end - start < 5 && isLatin(text[end])) ++end;
        i = end;
        if ((start > 0 && isLatin(text[start - 1])) || (end < text.size() && isLatin(text[end]))) continue;  // 长英文单词的一部分
        const QString raw = text.mid(start, end - start);
        const QString token = raw.toUpper();
        const bool cjkCtx = cjkAdjacent(text, start, end);
        if (hardExclude(token)) continue;
        if (stopwords().contains(token) && !cjkCtx) continue;
        if (settings.index_symbols.contains(token) || known.contains(token)) {
            add(token);
        } else if (modelNumber(text, end)) {
            continue;  // 型号,不是 ticker
        } else if (token.size() >= 2 && (raw == raw.toUpper() || cjkCtx)) {
            add(token);
        }
    }

    for (const QString& name : settings.symbol_aliases.keys())
        if (!name.isEmpty() && text.contains(name)) add(settings.symbol_aliases.value(name));

    const QString upper = text.toUpper();
    for (const QString& symbol : settings.index_symbols.keys())
        if (upper.contains(symbol)) add(symbol);

    if (extra)
        for (const QString& symbol : *extra) add(symbol);

    // 兜底:什么标的都没抽到时补 SPX
    if (defaultIndex && found.isEmpty() && settings.index_symbols.contains(u"SPX"_s)) add(u"SPX"_s);
    return found;
}

OJson buildSnapshot(const QStringList& symbols, const std::function<std::optional<double>(const QString&)>& priceLookup, const OJson* cached) {
    OJson snapshot = js::object();
    // snapshot["__proto__"] = 数:改的是原型的 setter,数不是对象,什么也不发生
    const auto put = [&](const QString& k, double v) {
        if (k != u"__proto__") snapshot.set(k, js::N(v));
    };
    for (const QString& symbol : symbols) {
        // symbol in cached:自己的键,或 Object.prototype 上的名字(那些值是函数 / 原型对象,Number() 是 NaN)
        if (js::truthy(cached) && js::isObj(cached) && (cached->get(symbol) || util::market::onObjectPrototype(symbol))) {
            const OJson* own = cached->get(symbol);
            put(symbol, own ? js::num(own) : std::nan(""));
            continue;
        }
        std::optional<double> price;
        try {
            price = priceLookup(symbol);
        } catch (const util::JsError&) {
            price.reset();  // 行情失败不阻断解析
        }
        if (price && *price != 0 && !std::isnan(*price)) put(symbol, *price);
    }
    return snapshot;
}

}  // namespace ibkr::analysis::market
