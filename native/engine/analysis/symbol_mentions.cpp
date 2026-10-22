#include "analysis/symbol_mentions.h"

#include "util/error.h"
#include "util/jsformat.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"

#include <algorithm>
#include <utility>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;

namespace ibkr::analysis::symbol_mentions {

namespace {

// ---------------------------------------------------------------- 码元的分类(不带 u 的 JS 正则)
bool isLetter(QChar c) { return (c >= u'A' && c <= u'Z') || (c >= u'a' && c <= u'z'); }
bool isDigit(QChar c) { return c >= u'0' && c <= u'9'; }
bool isWord(QChar c) { return isLetter(c) || isDigit(c) || c == u'_'; }
/// JS 的 \s
bool isSpace(QChar c) {
    const char16_t u = c.unicode();
    return u == 0x09 || u == 0x0A || u == 0x0B || u == 0x0C || u == 0x0D || u == 0x20 || u == 0xA0 || u == 0x1680 || (u >= 0x2000 && u <= 0x200A) ||
           u == 0x2028 || u == 0x2029 || u == 0x202F || u == 0x205F || u == 0x3000 || u == 0xFEFF;
}
/// /i 下的比较:只有 ASCII 字母折大小写(非 ASCII 的字符不会折成 ASCII)
QChar fold(QChar c) { return c >= u'a' && c <= u'z' ? QChar(c.unicode() - 32) : c; }

/// s[i](越界当作不是任何字符)
QChar at(const QString& s, qsizetype i) { return i >= 0 && i < s.size() ? s[i] : QChar(0xFFFF); }
bool letterAt(const QString& s, qsizetype i) { return i >= 0 && i < s.size() && isLetter(s[i]); }
bool digitAt(const QString& s, qsizetype i) { return i >= 0 && i < s.size() && isDigit(s[i]); }
qsizetype skipSpaces(const QString& s, qsizetype i) {
    while (i < s.size() && isSpace(s[i])) ++i;
    return i;
}
qsizetype runOf(const QString& s, qsizetype i, bool (*pred)(QChar)) {
    qsizetype j = i;
    while (j < s.size() && pred(s[j])) ++j;
    return j - i;
}
/// 从 i 起是不是 lit(caseless:ASCII 字母不分大小写)
bool litAt(const QString& s, qsizetype i, QStringView lit, bool caseless) {
    if (i < 0 || i + lit.size() > s.size()) return false;
    for (qsizetype k = 0; k < lit.size(); ++k) {
        const QChar a = s[i + k], b = lit[k];
        if (caseless ? fold(a) != fold(b) : a != b) return false;
    }
    return true;
}

/// 全局替换:每个位置试 match(给出结尾或 -1),命中的一段换成 repl,接着从结尾往后找(同 String.prototype.replace 带 g)
template <class M, class R>
QString replaceAll(const QString& s, M&& match, R&& repl) {
    QString out;
    qsizetype i = 0;
    while (i < s.size()) {
        const qsizetype e = match(s, i);
        if (e >= 0) {
            out += repl(s.mid(i, e - i), i);
            i = e;
        } else {
            out += s[i];
            ++i;
        }
    }
    return out;
}

// ---------------------------------------------------------------- stripNoise 的四条
/// <a?:[A-Za-z0-9_]+:\d+>
qsizetype matchEmoji(const QString& s, qsizetype i) {
    if (at(s, i) != u'<') return -1;
    qsizetype j = i + 1;
    if (at(s, j) == u'a') ++j;  // 不带 a 的那一支此时要的是 ':',落空
    if (at(s, j) != u':') return -1;
    ++j;
    const qsizetype w = runOf(s, j, isWord);
    if (w == 0) return -1;
    j += w;
    if (at(s, j) != u':') return -1;
    ++j;
    const qsizetype d = runOf(s, j, isDigit);
    if (d == 0) return -1;
    j += d;
    return at(s, j) == u'>' ? j + 1 : -1;
}
/// <[@#][!&]?\d+>
qsizetype matchMention(const QString& s, qsizetype i) {
    if (at(s, i) != u'<') return -1;
    qsizetype j = i + 1;
    if (at(s, j) != u'@' && at(s, j) != u'#') return -1;
    ++j;
    if (at(s, j) == u'!' || at(s, j) == u'&') ++j;
    const qsizetype d = runOf(s, j, isDigit);
    if (d == 0) return -1;
    j += d;
    return at(s, j) == u'>' ? j + 1 : -1;
}
/// @(?:everyone|here)(?![A-Za-z]) /i
qsizetype matchEveryone(const QString& s, qsizetype i) {
    if (at(s, i) != u'@') return -1;
    for (QStringView w : {u"everyone", u"here"}) {
        if (litAt(s, i + 1, w, true) && !letterAt(s, i + 1 + w.size())) return i + 1 + w.size();
    }
    return -1;
}
/// https?:\/\/\S+ /i
qsizetype matchUrl(const QString& s, qsizetype i) {
    if (!litAt(s, i, u"http", true)) return -1;
    qsizetype j = i + 4;
    if (fold(at(s, j)) == u'S') ++j;
    if (!litAt(s, j, u"://", false)) return -1;
    j += 3;
    qsizetype k = j;
    while (k < s.size() && !isSpace(s[k])) ++k;
    return k > j ? k : -1;
}

QString stripNoise(const QString& text) {
    const auto space = [](const QString&, qsizetype) { return u" "_s; };
    QString t = replaceAll(text, matchEmoji, space);
    t = replaceAll(t, matchMention, space);
    t = replaceAll(t, matchEveryone, space);
    return replaceAll(t, matchUrl, space);
}

/// 前缀 + [A-Za-z]{1,max}(?:\.[A-Za-z])?(?![A-Za-z]) 的字母部分从 i 起;给出结尾或 -1
qsizetype matchTicker(const QString& s, qsizetype i, qsizetype maxLetters) {
    const qsizetype n = runOf(s, i, isLetter);
    if (n == 0 || n > maxLetters) return -1;  // 更短的那几种后面跟着字母,过不了 (?![A-Za-z])
    const qsizetype e = i + n;
    if (at(s, e) == u'.' && letterAt(s, e + 1) && !letterAt(s, e + 2)) return e + 2;
    return e;
}

const QSet<QString>& stoplist() {
    static const QSet<QString> s = [] {
        QSet<QString> out;
        for (const char* w :
             {"AM",    "PM",   "ET",   "EST",   "EDT",  "PT",    "CT",    "GTC",   "DAY",   "DTE",  "CM",   "CALL", "CALLS", "PUT",  "PUTS",   "BUY",
              "SELL",  "LONG", "SHORT", "BULL", "BEAR", "SPREAD", "ITM",  "OTM",   "ATM",   "IV",   "HV",   "RSI",  "MACD",  "VWAP", "EMA",    "SMA",
              "MA",    "ATR",  "ADR",  "HOD",   "LOD",  "PDH",   "PDL",   "ORB",   "EOD",   "BTD",  "FOMO", "YOLO", "LOL",   "LMAO", "OMG",    "OK",
              "OKAY",  "FYI",  "IMO",  "IMHO",  "TBH",  "BTW",   "ASAP",  "CPI",   "PPI",   "PCE",  "GDP",  "FOMC", "FED",   "NFP",  "ISM",    "PMI",
              "JOLTS", "CEO",  "CFO",  "CTO",   "IPO",  "ETF",   "AI",    "ML",    "USD",   "CNY",  "RMB",  "HKD",  "JPY",   "EUR",  "GBP",    "TV",
              "PC",    "NYSE", "NASDAQ", "CBOE", "CME", "NY",    "US",    "USA",   "UK",    "EU",   "CN",   "HK",   "CA",    "FY",   "YOY",    "QOQ",
              "MOM",   "EPS",  "PE",   "PEG",   "ROE",  "ROI",   "RTH",   "ETH",   "AH",    "BPS",  "BCS",  "IC",   "IB",    "TWS",  "API",    "APP",
              "LMT",   "MKT",  "STP",  "SL",    "TP",   "TL",    "BE",    "RR",    "RVOL",  "VOL",  "OI",   "DD",   "TA",    "FA",   "PA",     "BOS",
              "CHOCH", "FVG",  "OB",   "SMC",   "ICT",  "MAX",   "MIN",   "AVG",   "EM",    "STD",  "JAN",  "FEB",  "MAR",   "APR",  "MAY",    "JUN",
              "JUL",   "AUG",  "SEP",  "SEPT",  "OCT",  "NOV",   "DEC",   "MON",   "TUE",   "WED",  "THU",  "FRI",  "SAT",   "SUN",  "TODAY",  "NOW",
              "NEW",   "OLD",  "HIGH", "LOW",   "OPEN", "CLOSE", "GAP",   "UP",    "DOWN",  "AND",  "OR",   "THE",  "FOR",   "NOT",  "BUT",    "YES",
              "NO",    "ALL",  "ANY",  "GO",    "ON",   "OFF",   "IN",    "OUT",   "AT",    "TO",   "BY",   "IT",   "IS",    "AS",   "WE",     "ME",
              "MY",    "SO",   "DO",   "IF",    "GM",   "GN",    "LFG",   "ATH",   "ATL",   "DCA",  "HODL", "PNL",  "P/L",   "EV",   "NFA",    "DYOR",
              "JPOW",  "FEDS", "QE",   "QT",    "YTD",  "MTD",   "WTD"})
            out.insert(QString::fromLatin1(w));
        return out;
    }();
    return s;
}

const QSet<QString>& commonWords() {
    static const QSet<QString> s = [] {
        QSet<QString> out;
        for (const char* w : {"all",  "for",  "are",  "the",  "and", "but",  "not",  "you", "can",  "now", "out",   "put",  "call", "buy",  "sell",
                              "long", "short", "open", "close", "high", "low", "big",  "run", "gap",  "new", "old",   "one",  "two",  "day",  "week",
                              "hold", "stop", "loss", "win",  "gain", "see",  "add",  "cut", "key",  "pay", "net",   "max",  "min",  "top",  "bid",
                              "ask",  "mid",  "fly",  "wing", "leg",  "legs", "play", "trade", "size", "it", "is",    "in",   "on",   "at",   "to",
                              "by",   "me",   "my",   "so",   "do",   "if",   "go",   "no",  "or",   "as",  "an",    "be",   "up",   "ok"})
            out.insert(QString::fromLatin1(w));
        return out;
    }();
    return s;
}

int priority(const QString& how) {
    if (how == u"cashtag") return 0;
    if (how == u"known") return 1;
    if (how == u"alias") return 2;
    if (how == u"implied") return 3;
    return 4;
}

struct Candidate {
    Mention m;
    double index = 0;
};

/// Map<symbol, Candidate>:插入的先后
using Found = std::vector<Candidate>;

void pushBest(Found& out, const Candidate& c) {
    for (Candidate& prev : out) {
        if (prev.m.symbol != c.m.symbol) continue;
        if (priority(c.m.how) < priority(prev.m.how) || (priority(c.m.how) == priority(prev.m.how) && c.index < prev.index)) prev = c;
        return;
    }
    out.push_back(c);
}

/// symbol.toUpperCase():symbol 是叫法表里的原值
QString upperOf(const OJson& v) {
    if (v.type == OJson::String) return v.s.toUpper();
    if (v.type == OJson::Null) throw util::JsError(u"Cannot read properties of null (reading 'toUpperCase')"_s);
    throw util::JsError(u"symbol.toUpperCase is not a function"_s);
}

/// ^[A-Za-z][A-Za-z.&' -]*$
bool isLatinTerm(const QString& t) {
    if (t.isEmpty() || !isLetter(t[0])) return false;
    for (QChar c : t)
        if (!(isLetter(c) || c == u'.' || c == u'&' || c == u'\'' || c == u' ' || c == u'-')) return false;
    return true;
}

}  // namespace

OJson Mention::toJson() const { return js::object({{u"symbol"_s, js::S(symbol)}, {u"how"_s, js::S(how)}, {u"term"_s, js::S(term)}}); }

void Universe::add(const QString& s) {
    if (knownSet.contains(s)) return;
    knownSet.insert(s);
    known << s;
}

OJson Universe::toJson() const {
    return js::object({{u"known"_s, js::strings(known)}, {u"aliases"_s, aliases}, {u"implied"_s, implied ? js::S(*implied) : OJson::null()}});
}

const OJson& builtinAliases() {
    static const OJson a = [] {
        OJson o = js::object();
        const std::pair<const char16_t*, const char*> kv[] = {
            {u"苹果", "AAPL"},    {u"英伟达", "NVDA"},  {u"特斯拉", "TSLA"},  {u"微软", "MSFT"},        {u"谷歌", "GOOGL"},     {u"亚马逊", "AMZN"},
            {u"奈飞", "NFLX"},    {u"网飞", "NFLX"},    {u"台积电", "TSM"},   {u"阿里巴巴", "BABA"},    {u"拼多多", "PDD"},     {u"京东", "JD"},
            {u"百度", "BIDU"},    {u"蔚来", "NIO"},     {u"小鹏", "XPEV"},    {u"理想汽车", "LI"},      {u"博通", "AVGO"},      {u"英特尔", "INTC"},
            {u"美光", "MU"},      {u"甲骨文", "ORCL"},  {u"迪士尼", "DIS"},   {u"波音", "BA"},          {u"可口可乐", "KO"},    {u"麦当劳", "MCD"},
            {u"沃尔玛", "WMT"},   {u"开市客", "COST"},  {u"摩根大通", "JPM"}, {u"小摩", "JPM"},         {u"大摩", "MS"},        {u"高盛", "GS"},
            {u"微策略", "MSTR"},  {u"超威", "AMD"},     {u"超微", "SMCI"},    {u"标普", "SPX"},         {u"标普500", "SPX"},    {u"标普五百", "SPX"},
            {u"纳指", "NDX"},     {u"纳斯达克", "NDX"}, {u"恐慌指数", "VIX"}, {u"Nvidia", "NVDA"},      {u"Tesla", "TSLA"},     {u"Apple", "AAPL"},
            {u"Amazon", "AMZN"},  {u"Google", "GOOGL"}, {u"Alphabet", "GOOGL"}, {u"Microsoft", "MSFT"}, {u"Netflix", "NFLX"},   {u"Broadcom", "AVGO"},
            {u"Micron", "MU"},    {u"Palantir", "PLTR"}, {u"Coinbase", "COIN"}, {u"Meta", "META"},      {u"Oracle", "ORCL"},
        };
        for (const auto& [k, v] : kv) o.set(QString::fromUtf16(k), js::S(QString::fromLatin1(v)));
        return o;
    }();
    return a;
}

const QStringList& builtinKnown() {
    static const QStringList k{u"SPX"_s, u"SPY"_s, u"QQQ"_s, u"NDX"_s, u"VIX"_s, u"IWM"_s, u"DIA"_s, u"TLT"_s, u"GLD"_s, u"ES"_s, u"NQ"_s, u"RUT"_s};
    return k;
}

bool looksLikeOptionTalk(const QString& text) {
    if (text.contains(u"蝴蝶") || text.contains(u"铁鹰") || text.contains(u"价差")) return true;
    const qsizetype n = text.size();
    // /\d\s*cm(?![A-Za-z])|翼宽\s*\d|±\s*\d+(?:\.\d+)?\s*点/i
    for (qsizetype i = 0; i < n; ++i) {
        if (isDigit(text[i])) {
            const qsizetype j = skipSpaces(text, i + 1);
            if (litAt(text, j, u"cm", true) && !letterAt(text, j + 2)) return true;
        }
        if (litAt(text, i, u"翼宽", false) && digitAt(text, skipSpaces(text, i + 2))) return true;
        if (text[i] == u'±') {
            qsizetype j = skipSpaces(text, i + 1);
            const qsizetype d = runOf(text, j, isDigit);
            if (d > 0) {
                j += d;
                if (at(text, j) == u'.' && digitAt(text, j + 1)) j += 1 + runOf(text, j + 1, isDigit);  // 不带小数的那一支此时停在 '.' 上,落空
                if (at(text, skipSpaces(text, j)) == u'点') return true;
            }
        }
    }
    // /(?<![A-Za-z])(bull\s*put|bear\s*call|call\s*spread|put\s*spread)(?![A-Za-z])/i
    static const std::pair<QStringView, QStringView> pairs[] = {{u"bull", u"put"}, {u"bear", u"call"}, {u"call", u"spread"}, {u"put", u"spread"}};
    for (qsizetype i = 0; i < n; ++i) {
        if (letterAt(text, i - 1)) continue;
        for (const auto& [a, b] : pairs) {
            if (!litAt(text, i, a, true)) continue;
            const qsizetype j = skipSpaces(text, i + a.size());
            if (litAt(text, j, b, true) && !letterAt(text, j + b.size())) return true;
        }
    }
    const auto digitOrDot = [&](qsizetype i) { return digitAt(text, i) || at(text, i) == u'.'; };
    // /(?<![\d.])\d{4}\s+\d{4}(?![\d.])/
    for (qsizetype i = 0; i < n; ++i) {
        if (digitOrDot(i - 1) || runOf(text, i, isDigit) != 4) continue;  // 第 5 位是数字时 \s+ 落空
        const qsizetype j = skipSpaces(text, i + 4);
        if (j == i + 4) continue;
        if (runOf(text, j, isDigit) >= 4 && !digitOrDot(j + 4)) return true;
    }
    // /(?<![\d.])\d{3,4}\s*[CP](?![A-Za-z])/i
    for (qsizetype i = 0; i < n; ++i) {
        if (digitOrDot(i - 1)) continue;
        const qsizetype d = runOf(text, i, isDigit);
        for (qsizetype k = std::min<qsizetype>(d, 4); k >= 3; --k) {
            const qsizetype j = skipSpaces(text, i + k);
            const QChar c = fold(at(text, j));
            if ((c == u'C' || c == u'P') && !letterAt(text, j + 1)) return true;
        }
    }
    return false;
}

std::vector<Mention> extractMentions(const QString& rawText, const Universe& universe) {
    const QString text = stripNoise(util::jsNormalizeNfkc(rawText));
    Found found;

    // 1. cashtag:\$([A-Za-z]{1,5}(?:\.[A-Za-z])?)(?![A-Za-z])
    for (qsizetype i = 0; i < text.size();) {
        const qsizetype e = text[i] == u'$' ? matchTicker(text, i + 1, 5) : -1;
        if (e < 0) {
            ++i;
            continue;
        }
        pushBest(found, {{text.mid(i + 1, e - i - 1).toUpper(), u"cashtag"_s, text.mid(i, e - i)}, double(i)});
        i = e;
    }

    // 2. 叫法:长的先找(Object.entries 的先后,按键长稳定排)
    std::vector<std::pair<QString, OJson>> entries;
    if (universe.aliases.type == OJson::Object)
        for (const auto& [k, v] : universe.aliases.fields) entries.emplace_back(k, v);
    std::stable_sort(entries.begin(), entries.end(), [](const auto& a, const auto& b) { return b.first.size() < a.first.size(); });
    QString masked = text;
    for (const auto& [term, symbol] : entries) {
        if (term.isEmpty()) continue;
        const bool latin = isLatinTerm(term);
        const auto match = [&](const QString& s, qsizetype i) -> qsizetype {
            if (latin) {
                if (letterAt(s, i - 1) || !litAt(s, i, term, true) || letterAt(s, i + term.size())) return -1;
            } else if (!litAt(s, i, term, false)) {
                return -1;
            }
            return i + term.size();
        };
        masked = replaceAll(masked, match, [&](const QString& hit, qsizetype offset) {
            pushBest(found, {{upperOf(symbol), u"alias"_s, hit}, double(offset)});
            return QString(hit.size(), u' ');
        });
    }

    // 3. 名单里的代码与像代码的词:(?<![A-Za-z$])[A-Za-z][A-Za-z]{0,5}(?:\.[A-Za-z])?(?![A-Za-z])
    std::vector<std::pair<qsizetype, QString>> tokens;
    for (qsizetype i = 0; i < masked.size();) {
        const QChar prev = at(masked, i - 1);
        const qsizetype e = i > 0 && (isLetter(prev) || prev == u'$') ? -1 : matchTicker(masked, i, 6);
        if (e < 0) {
            ++i;
            continue;
        }
        tokens.emplace_back(i, masked.mid(i, e - i));
        i = e;
    }
    double letterTokens = 0, upperCount = 0;
    for (const auto& [i, w] : tokens) {
        if (w.size() < 2) continue;
        letterTokens += 1;
        if (w == w.toUpper()) upperCount += 1;
    }
    // 整句都在喊时大写不说明是代码
    const bool shouting = letterTokens > 4 && upperCount / letterTokens > 0.6;
    for (const auto& [index, word] : tokens) {
        const QString upper = word.toUpper();
        // 紧贴着数字的字母是单位或方向
        if (index > 0 && isDigit(masked[index - 1])) continue;
        const bool isUpper = word == upper;
        if (universe.knownSet.contains(upper)) {
            if (!isUpper && (word.size() < 3 || commonWords().contains(word.toLower()))) continue;
            pushBest(found, {{upper, u"known"_s, word}, double(index)});
            continue;
        }
        if (isUpper && word.size() >= 2 && word.size() <= 5 && !stoplist().contains(upper) && !shouting) pushBest(found, {{upper, u"guess"_s, word}, double(index)});
    }

    // 4. 没写标的的行话
    const bool confident = std::any_of(found.begin(), found.end(), [](const Candidate& c) { return c.m.how != u"guess"; });
    if (!confident && universe.implied && !universe.implied->isEmpty() && looksLikeOptionTalk(masked))
        pushBest(found, {{universe.implied->toUpper(), u"implied"_s, QString()}, 9007199254740991.0});

    std::stable_sort(found.begin(), found.end(), [](const Candidate& a, const Candidate& b) { return a.index < b.index; });
    std::vector<Mention> out;
    out.reserve(found.size());
    for (const Candidate& c : found) out.push_back(c.m);
    return out;
}

Universe makeUniverse(const QList<OJson>& known, const OJson& aliases, const std::optional<QString>& implied) {
    Universe u;
    for (const QString& s : builtinKnown()) u.add(s);
    for (const OJson& s : known) {
        const QString v = util::jsTrim(js::strOr(&s, QString())).toUpper();
        if (!v.isEmpty()) u.add(v);
    }
    if (aliases.type == OJson::Object)
        for (const auto& [k, v] : aliases.fields) u.add(js::str(&v).toUpper());
    for (const auto& [k, v] : builtinAliases().fields) u.add(v.s);
    u.aliases = builtinAliases();
    if (aliases.type == OJson::Object)
        for (const auto& [k, v] : aliases.fields) u.aliases.set(k, v);
    u.implied = implied;
    return u;
}

QStringList confidentSymbols(const std::vector<Mention>& mentions) {
    QStringList out;
    for (const Mention& m : mentions)
        if (m.how != u"guess" && !out.contains(m.symbol)) out << m.symbol;
    return out;
}

QStringList guessedSymbols(const std::vector<Mention>& mentions) {
    QStringList out;
    for (const Mention& m : mentions)
        if (m.how == u"guess" && !out.contains(m.symbol)) out << m.symbol;
    return out;
}

}  // namespace ibkr::analysis::symbol_mentions
