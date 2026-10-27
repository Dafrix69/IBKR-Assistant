#include "domain/config.h"

#include "util/jsformat.h"
#include "util/js_runtime.h"
#include "util/jsvalue.h"
#include "util/market_calendar.h"
#include "util/py.h"
#include "util/tz.h"
#include "util/v8json.h"
#include "util/whatwg_url.h"

#include <QCoreApplication>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QRegularExpression>
#include <QSet>

#include <cmath>
#include <deque>

#if defined(Q_OS_WIN)
#include <io.h>
#include <windows.h>
#else
#include <unistd.h>
#endif

using namespace Qt::StringLiterals;
using ibkr::util::JsError;
using ibkr::util::OJson;

namespace ibkr::domain {

// ================================================================ JS 取值的样子
// 配置是 JSON.parse 出来的、什么形状都可能(用户手改)。TS 版直接拿它当对象用:原始值上取属性得 undefined、
// null 上取属性抛 TypeError、`in` 用在原始值上抛 TypeError、Object.keys("ab") 是 ["0","1"]……这些都会落成校验的话或配置能不能读进来。
// 这里用一个"JS 值"的视图把这些逐条做出来(V::p 为空 = undefined),fromDict 照 TS 一句一句写。
namespace {

struct V {
    const OJson* p = nullptr;
    bool undef() const { return p == nullptr; }
    bool nullish() const { return !p || p->type == OJson::Null; }
    bool isStr() const { return p && p->type == OJson::String; }
    bool isNum() const { return p && p->type == OJson::Number; }
    bool isBool() const { return p && p->type == OJson::Bool; }
    bool isArr() const { return p && p->type == OJson::Array; }
    bool isObj() const { return p && p->type == OJson::Object; }
    /// typeof v === "object"(含 null 与数组)
    bool typeofObject() const { return p && (p->type == OJson::Object || p->type == OJson::Array || p->type == OJson::Null); }
};

/// 取属性时现造出来的值(字符串的下标);活到这一轮 fromDict 结束
std::deque<OJson>& arena() {
    thread_local std::deque<OJson> a;  // 每个线程一份:fromDict 不重入,但别的线程也可能读配置
    return a;
}
V made(const OJson& o) {
    arena().push_back(o);
    return V{&arena().back()};
}

QString str(V v);

/// Object.prototype 上的名字:`k in {}` 对它们是 true
const QSet<QString>& objectProtoNames() {
    static const QSet<QString> s{u"constructor"_s, u"__defineGetter__"_s, u"__defineSetter__"_s, u"hasOwnProperty"_s, u"__lookupGetter__"_s, u"__lookupSetter__"_s,
                                 u"isPrototypeOf"_s, u"propertyIsEnumerable"_s, u"toString"_s, u"valueOf"_s, u"__proto__"_s, u"toLocaleString"_s};
    return s;
}
const QSet<QString>& arrayProtoNames() {
    static const QSet<QString> s{u"length"_s, u"at"_s, u"concat"_s, u"copyWithin"_s, u"fill"_s, u"find"_s, u"findIndex"_s, u"findLast"_s, u"findLastIndex"_s,
                                 u"lastIndexOf"_s, u"pop"_s, u"push"_s, u"reverse"_s, u"shift"_s, u"unshift"_s, u"slice"_s, u"sort"_s, u"splice"_s, u"includes"_s,
                                 u"indexOf"_s, u"join"_s, u"keys"_s, u"entries"_s, u"values"_s, u"forEach"_s, u"filter"_s, u"flat"_s, u"flatMap"_s, u"map"_s,
                                 u"every"_s, u"some"_s, u"reduce"_s, u"reduceRight"_s, u"toReversed"_s, u"toSorted"_s, u"toSpliced"_s, u"with"_s};
    return s;
}

/// v[key](JS 的属性读取)
V get(V v, const QString& key) {
    if (v.nullish()) throw JsError(u"Cannot read properties of %1 (reading '%2')"_s.arg(v.undef() ? u"undefined"_s : u"null"_s, key));
    if (v.isObj()) {
        const OJson* f = v.p->get(key);
        return V{f};
    }
    if (v.isArr()) {
        if (const auto i = util::jsArrayIndex(key); i && *i < quint32(v.p->items.size())) return V{&v.p->items[qsizetype(*i)]};
        if (key == u"length") return made(OJson::number(double(v.p->items.size())));
        return {};
    }
    if (v.isStr()) {
        if (const auto i = util::jsArrayIndex(key); i && *i < quint32(v.p->s.size())) return made(OJson::string(QString(v.p->s[qsizetype(*i)])));
        if (key == u"length") return made(OJson::number(double(v.p->s.size())));
    }
    return {};
}
/// a ?? b
V orElse(V a, V b) { return a.nullish() ? b : a; }
V lit(const OJson& o) { return made(o); }
V emptyObject() {
    OJson o;
    o.type = OJson::Object;
    return made(o);
}
V emptyArray() {
    OJson o;
    o.type = OJson::Array;
    return made(o);
}

/// key in v
bool in(V v, const QString& key) {
    if (!v.isObj() && !v.isArr()) throw JsError(u"Cannot use 'in' operator to search for '%1' in %2"_s.arg(key, str(v)));
    if (v.isObj()) return v.p->get(key) || objectProtoNames().contains(key);
    if (const auto i = util::jsArrayIndex(key); i && *i < quint32(v.p->items.size())) return true;
    return arrayProtoNames().contains(key) || objectProtoNames().contains(key);
}

/// Object.keys(v)(v 不是 null / undefined)
QStringList keys(V v) {
    QStringList out;
    if (v.isObj()) {
        for (const auto& f : v.p->fields) out << f.first;
    } else if (v.isArr()) {
        for (qsizetype i = 0; i < v.p->items.size(); ++i) out << QString::number(i);
    } else if (v.isStr()) {
        for (qsizetype i = 0; i < v.p->s.size(); ++i) out << QString::number(i);
    }
    return out;
}

/// String(v)
QString str(V v) {
    if (v.undef()) return u"undefined"_s;
    switch (v.p->type) {
    case OJson::Null: return u"null"_s;
    case OJson::Bool: return v.p->b ? u"true"_s : u"false"_s;
    case OJson::Number: return util::jsNumberToString(v.p->n);
    case OJson::String: return v.p->s;
    case OJson::Array: {
        QStringList parts;
        for (const OJson& x : v.p->items) parts << (x.type == OJson::Null ? QString() : str(V{&x}));
        return parts.join(u',');
    }
    case OJson::Object: return u"[object Object]"_s;
    }
    return {};
}

/// Number(v)
double number(V v) {
    if (v.undef()) return std::nan("");
    switch (v.p->type) {
    case OJson::Null: return 0;
    case OJson::Bool: return v.p->b ? 1 : 0;
    case OJson::Number: return v.p->n;
    case OJson::String: return util::jsStringToNumber(v.p->s);
    case OJson::Array: return util::jsStringToNumber(str(v));
    case OJson::Object: return std::nan("");
    }
    return std::nan("");
}

/// JS 的真假(if (x))
bool jsTruthy(V v) {
    if (v.nullish()) return false;
    switch (v.p->type) {
    case OJson::Bool: return v.p->b;
    case OJson::Number: return v.p->n != 0 && !std::isnan(v.p->n);
    case OJson::String: return !v.p->s.isEmpty();
    default: return true;
    }
}

/// py.ts 的 truthy
bool pyTruthy(V v) {
    if (v.nullish()) return false;
    switch (v.p->type) {
    case OJson::Bool: return v.p->b;
    case OJson::Number: return v.p->n != 0;  // NaN 是真
    case OJson::String: return !v.p->s.isEmpty();
    case OJson::Array: return !v.p->items.isEmpty();
    default: return true;
    }
}

/// py.ts 的 pyRepr(数组与对象落到 String(v))
QString repr(V v) {
    if (v.nullish()) return u"None"_s;
    switch (v.p->type) {
    case OJson::Bool: return v.p->b ? u"True"_s : u"False"_s;
    case OJson::Number: return util::pyRepr(QJsonValue(v.p->n));
    case OJson::String: return util::pyRepr(QJsonValue(v.p->s));
    default: return str(v);
    }
}

/// String.prototype.toUpperCase / toLowerCase(Unicode 全量映射:ß → SS)
QString upper(const QString& s) { return s.toUpper(); }
QString lower(const QString& s) { return s.toLower(); }
QString trim(const QString& s) { return util::jsTrim(s); }

bool isAsciiDigits(QStringView s, qsizetype minLen = 1, qsizetype maxLen = -1) {
    if (s.size() < minLen || (maxLen >= 0 && s.size() > maxLen)) return false;
    for (QChar c : s)
        if (c < u'0' || c > u'9') return false;
    return true;
}

}  // namespace

// ================================================================ 时钟
EtNow etNowFromEpoch(double epochMs) {
    const util::WallParts p = util::wallParts(epochMs, QString::fromUtf16(util::kET));
    EtNow n;
    n.epochMs = epochMs;
    n.date = u"%1-%2-%3"_s.arg(util::jsNumberToString(p.year), util::pad2(p.month), util::pad2(p.day));
    n.minutes = p.hour * 60 + p.minute;
    n.seconds = p.hour * 3600 + p.minute * 60 + p.second;
    return n;
}

namespace {
std::optional<double>& clockSlot() {
    static std::optional<double> v;
    return v;
}
}  // namespace
void setClock(std::optional<double> epochMs) { clockSlot() = epochMs; }
std::optional<double> clockOverride() { return clockSlot(); }
double nowMs() { return clockSlot().value_or(util::dateNow()); }
EtNow nowEt() { return etNowFromEpoch(nowMs()); }

// ================================================================ 供应商与 base_url
const contract::OrderedMap<ProviderMeta>& providerMeta() {
    static const contract::OrderedMap<ProviderMeta> m = [] {
        contract::OrderedMap<ProviderMeta> x;
        x.insert(u"anthropic"_s, {false, u"claude-opus-5"_s});
        x.insert(u"openai_compatible"_s, {true, QString()});
        return x;
    }();
    return m;
}

QString validateBaseUrl(const QString& raw) {
    QString url = trim(raw);
    while (url.endsWith(u'/')) url.chop(1);
    if (url.isEmpty()) throw LLMError(u"OpenAI 兼容端点必须填 base_url"_s);
    // 解析走 util::whatwg(WHATWG 的 `new URL`):校验与实际连接(parsing/sdk_http、embeddings)读的是同一个解析器,不会读出两个主机
    const auto parsed = util::whatwg::parse(url);
    if (!parsed || !parsed->isHttp()) throw LLMError(u"base_url 必须以 http(s):// 开头"_s);
    QString host = parsed->hostname.toLower();
    if (host.startsWith(u'[')) host.remove(0, 1);
    if (host.endsWith(u']')) host.chop(1);
    if (parsed->scheme == u"http" && host != u"127.0.0.1" && host != u"localhost" && host != u"::1")
        throw LLMError(u"非本机地址必须用 https(§9.4 强制 TLS),收到:"_s + url);
    return url;
}

// ================================================================ 提示词目录与默认路径
std::optional<QString> latestPromptVersion(const QString& promptDir) {
    QDir d(promptDir);
    if (promptDir.isEmpty() || !d.exists()) return std::nullopt;
    static const QRegularExpression re(u"^system_(v([0-9]+)\\.([0-9]+)\\.([0-9]+))\\.md\\z"_s);
    std::optional<QString> best;
    double bestRank = 0;
    for (const QString& name : d.entryList(QDir::AllEntries | QDir::NoDotAndDotDot | QDir::Hidden | QDir::System, QDir::Unsorted)) {
        const auto m = re.match(name);
        if (!m.hasMatch()) continue;
        const double rank = util::jsStringToNumber(m.captured(2)) * 1e12 + util::jsStringToNumber(m.captured(3)) * 1e6 + util::jsStringToNumber(m.captured(4));
        if (!best || rank > bestRank) {
            best = m.captured(1);
            bestRank = rank;
        }
    }
    return best;
}

namespace {
/// 从可执行文件所在目录往上找带某个标记文件的目录(TS 从模块所在目录找;src/ 与 dist/src/ 两种布局都落到仓库根)
std::optional<QString> findUp(const QStringList& marker, int depth = 6) {
    QString dir = QCoreApplication::instance() ? QCoreApplication::applicationDirPath() : QDir::currentPath();
    for (int i = 0; i < depth; ++i) {
        if (QFileInfo::exists(dir + u'/' + marker.join(u'/'))) return dir;
        dir = QFileInfo(dir).absolutePath();
    }
    return std::nullopt;
}
}  // namespace

QString defaultPromptDir() {
    static const QString dir = [] {
        const QString explicitDir = qEnvironmentVariable("DAFRI_PROMPT_DIR");
        if (!explicitDir.isEmpty() && QFileInfo::exists(explicitDir)) return explicitDir;
        const auto root = findUp({u"prompts"_s, u"system_v1.0.0.md"_s});
        return root ? *root + u"/prompts"_s : QDir::cleanPath(QDir::currentPath() + u"/prompts"_s);
    }();
    return dir;
}

QString defaultConfigPath() {
    const QString env = qEnvironmentVariable("DAFRI_CONFIG");
    if (qEnvironmentVariableIsSet("DAFRI_CONFIG")) return env;
    const auto root = findUp({u"config"_s, u"settings.example.json"_s});
    return root.value_or(QDir::currentPath()) + u"/config/settings.json"_s;
}

namespace {
/// Node 的 path.posix.join(home, rest) 之后 normalize:去掉 . 与空段、消掉 ..,保留结尾的 /
QString joinNormalize(const QString& a, const QString& b) {
    const QString joined = b.isEmpty() ? a : a + u'/' + b;
    if (joined.isEmpty()) return u"."_s;
    const bool absolute = joined.startsWith(u'/');
    const bool trailing = joined.endsWith(u'/');
    QStringList out;
    for (const QString& seg : joined.split(u'/')) {
        if (seg.isEmpty() || seg == u".") continue;
        if (seg == u"..") {
            if (!out.isEmpty() && out.last() != u"..") out.removeLast();
            else if (!absolute) out << seg;
            continue;
        }
        out << seg;
    }
    QString s = out.join(u'/');
    if (absolute) s.prepend(u'/');
    if (s.isEmpty()) s = absolute ? u"/"_s : u"."_s;
    if (trailing && !s.endsWith(u'/')) s += u'/';
    return s;
}
}  // namespace

QString expandHome(const QString& p) {
    const QString home = QDir::homePath();
    if (p == u"~") return home;
    if (p.startsWith(u"~/"_s) || p.startsWith(u"~\\"_s)) return joinNormalize(home, p.mid(2));
    return p;
}

// ================================================================ 交易时段
std::vector<std::pair<double, double>> parseTradingHours(const QString& spec) {
    std::vector<std::pair<double, double>> out;
    const auto toNaive = [](const QString& day, const QString& hhmm) -> std::optional<double> {
        if (!isAsciiDigits(day, 8, 8) || !isAsciiDigits(hhmm, 4, 4)) return std::nullopt;
        const double y = day.left(4).toDouble(), mo = day.mid(4, 2).toDouble(), d = day.mid(6, 2).toDouble();
        const double h = hhmm.left(2).toDouble(), mi = hhmm.mid(2, 2).toDouble();
        if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return std::nullopt;
        return std::floor(util::dateUtc(y, mo - 1, d, h, mi) / 60000);
    };
    for (const QString& raw : spec.split(u';')) {
        const QString chunk = trim(raw);
        if (chunk.isEmpty() || chunk.endsWith(u":CLOSED"_s)) continue;
        const qsizetype dash = chunk.indexOf(u'-');
        if (dash < 0) continue;
        const QString startRaw = trim(chunk.left(dash)), endRaw = trim(chunk.mid(dash + 1));
        const QStringList s = startRaw.split(u':');
        const QString sDay = s.value(0), sTime = s.value(1);
        if (sDay.isEmpty() || sTime.isEmpty()) continue;
        const auto start = toNaive(sDay, sTime);
        std::optional<double> end;
        if (endRaw.contains(u':')) {
            const QStringList e = endRaw.split(u':');
            end = toNaive(e.value(0), e.value(1));
        } else {
            end = toNaive(sDay, endRaw);  // 少数交易所只给结束时刻,当作同一天
        }
        if (!start || !end || *end <= *start) continue;
        out.emplace_back(*start, *end);
    }
    return out;
}

QString hoursStatus(const QString& spec, const QString& tzId, double epochMs, const QString& liquid) {
    if (spec.isEmpty() || tzId.isEmpty()) return {};
    double local;
    try {
        const util::WallParts w = util::wallParts(epochMs, tzId);
        local = std::floor(util::dateUtc(w.year, w.month - 1, w.day, w.hour, w.minute) / 60000);
    } catch (const JsError&) {
        return {};  // 认不出的时区不猜,退回正股表
    }
    const auto inside = [local](const std::vector<std::pair<double, double>>& ws) {
        for (const auto& [a, b] : ws)
            if (local >= a && local < b) return true;
        return false;
    };
    const auto windows = parseTradingHours(spec);
    if (windows.empty() || !inside(windows)) return kStatusClosed;
    const auto liquidWindows = parseTradingHours(liquid);
    if (!liquidWindows.empty() && !inside(liquidWindows)) return kStatusOutside;
    return kStatusOpen;
}

double defaultBrokerPort(const QString& broker) { return broker == u"futu" ? 11111 : 7497; }

// ================================================================ Settings 的方法
Settings::Settings() : prompt_dir(defaultPromptDir()), db_path(QDir::homePath() + u"/Library/Application Support/dafri/trades.db"_s) {}

contract::Limits Settings::limitsFor(const QString& alias) const {
    contract::Limits out = limits;
    if (const contract::AccountLimits* own = limits.by_account.find(alias)) {
        const auto take = [](const QJsonValue& v, double& slot) {
            if (!v.isNull() && !v.isUndefined()) slot = v.toDouble();
        };
        take(own->max_order_notional, out.max_order_notional);
        take(own->max_option_contracts, out.max_option_contracts);
        take(own->max_mkt_shares, out.max_mkt_shares);
        take(own->max_open_risk_usd, out.max_open_risk_usd);
        take(own->max_underlying_contracts, out.max_underlying_contracts);
    }
    return out;
}

const contract::AccountConfig* Settings::accountByAlias(const QString& alias) const {
    if (alias == u"DEFAULT") return defaultAccount();
    for (const auto& a : accounts)
        if (a.alias == alias) return &a;
    return nullptr;
}

const contract::AccountConfig* Settings::defaultAccount() const {
    for (const auto& a : accounts)
        if (a.isDefault) return &a;
    return accounts.empty() ? nullptr : &accounts.front();
}

QStringList Settings::aliasList() const {
    QStringList out;
    for (const auto& a : accounts) out << a.alias;
    return out;
}

contract::OrderedMap<contract::ConnectionConfig> Settings::connectionsFor(const QString& provider) const {
    const QString target = provider.isEmpty() ? broker.provider : provider;
    contract::OrderedMap<contract::ConnectionConfig> out;
    for (const QString& n : connections.keys())
        if (connections.find(n)->broker == target) out.insert(n, *connections.find(n));
    return out;
}

QString Settings::accountBroker(const contract::AccountConfig& account) const {
    if (const auto* c = connections.find(account.connection)) return c->broker;
    // Object.prototype 上的名字(constructor、toString…):TS 取到的是个函数,它的 broker 是 undefined
    if (objectProtoNames().contains(account.connection)) return QString();
    return u"ibkr"_s;
}

QString Settings::promptAccountTable() const {
    QStringList parts;
    for (const auto& a : accounts) parts << u"%1=%2%3"_s.arg(a.alias, a.is_paper ? u"纸面测试账户"_s : u"实盘账户"_s, a.isDefault ? u"(默认)"_s : QString());
    return parts.isEmpty() ? u"(未配置账户,只允许 DEFAULT)"_s : parts.join(u';');
}

QString Settings::promptSymbolTable() const {
    if (symbol_aliases.isEmpty()) return u"(未配置中文别名,所有中文公司名一律拒绝)"_s;
    QStringList parts;
    for (const QString& k : symbol_aliases.keys()) parts << k + u'=' + symbol_aliases.value(k);
    return parts.join(u';');
}

bool Settings::isTradingDay(const QString& dateStr) const {
    if (util::weekdayOfDate(dateStr) >= 5) return false;
    return !market_holidays.contains(dateStr);
}

QString Settings::marketStatus(const EtNow& now) const {
    if (!isTradingDay(now.date)) return u"休市"_s;
    const double closeMin = early_close_days.contains(now.date) ? 13 * 60 : 16 * 60;
    const double t = now.seconds;
    if (t < 4 * 3600) return u"休市"_s;
    if (t < 9 * 3600 + 30 * 60) return u"盘前"_s;
    if (t < closeMin * 60) return u"盘中"_s;
    if (t < 20 * 3600) return u"盘后"_s;
    return u"休市"_s;
}

const contract::IndexConfig* Settings::indexConfig(const QString& symbol) const { return index_symbols.find(upper(symbol)); }

// ================================================================ 构建与校验(每句话逐字进黄金基线)
namespace {

const QStringList kEffortLevels{u"low"_s, u"medium"_s, u"high"_s, u"xhigh"_s, u"max"_s};
const QStringList kClosedMarketPolicies{u"allow"_s, u"reject_market_orders"_s, u"reject_all"_s};
const QStringList kFutuMarkets{u"US"_s, u"HK"_s, u"CN"_s};
const QStringList kFutuFirms{u"FUTUSECURITIES"_s, u"FUTUINC"_s, u"FUTUSG"_s, u"FUTUAU"_s, u"FUTUCA"_s, u"FUTUJP"_s, u"FUTUMY"_s};

QStringList sortedCopy(QStringList l) {
    std::sort(l.begin(), l.end());  // JS 默认排序:按 UTF-16 码元
    return l;
}

/// [...allowed].includes(value):只认同样内容的字符串
bool includesStr(const QStringList& allowed, V value) { return value.isStr() && allowed.contains(value.p->s); }

void rejectUnknown(const QStringList& known, V raw, const QString& label) {
    QStringList unknown;
    for (const QString& k : keys(raw))
        if (!known.contains(k)) unknown << k;
    if (!unknown.isEmpty()) throw JsError(u"%1 里有未知配置项:%2"_s.arg(label, sortedCopy(unknown).join(u", "_s)));
}

struct NumOpts {
    std::optional<double> min;
    QString minStr;
    std::optional<double> max;
    QString maxStr;
};

std::optional<double> num(V raw, const QString& key, bool isInt, std::optional<double> dflt, const QString& label, const NumOpts& opts = {}) {
    if (!in(raw, key)) return dflt;
    const V value = get(raw, key);
    if (value.isBool() || (!value.isNum() && !value.isStr())) throw JsError(u"%1.%2 必须是数字,收到 %3"_s.arg(label, key, repr(value)));
    double out;
    if (value.isStr()) {
        const QString t = trim(value.p->s);
        static const QRegularExpression intRe(u"^[+-]?[0-9]+\\z"_s);
        static const QRegularExpression floatRe(u"^[+-]?([0-9]+\\.?[0-9]*|\\.[0-9]+)([eE][+-]?[0-9]+)?\\z"_s);
        if (!(isInt ? intRe : floatRe).match(t).hasMatch()) throw JsError(u"%1.%2 必须是数字,收到 %3"_s.arg(label, key, repr(value)));
        out = util::jsStringToNumber(t);
    } else {
        out = isInt ? std::trunc(value.p->n) : value.p->n;
    }
    const auto show = [isInt](double v) { return isInt ? util::jsNumberToString(v) : util::pyFloat(v); };
    if (opts.min && out < *opts.min)
        throw JsError(u"%1.%2 不能小于 %3(收到 %4)"_s.arg(label, key, opts.minStr.isEmpty() ? util::jsNumberToString(*opts.min) : opts.minStr, show(out)));
    if (opts.max && out > *opts.max)
        throw JsError(u"%1.%2 不能大于 %3(收到 %4)"_s.arg(label, key, opts.maxStr.isEmpty() ? util::jsNumberToString(*opts.max) : opts.maxStr, show(out)));
    return out;
}
double numReq(V raw, const QString& key, bool isInt, double dflt, const QString& label, const NumOpts& opts = {}) {
    return num(raw, key, isInt, dflt, label, opts).value_or(dflt);
}

bool flag(V raw, const QString& key, bool dflt, const QString& label) {
    if (!in(raw, key)) return dflt;
    const V value = get(raw, key);
    // 故意不接受 "true"/"1":这几个开关误判会直接下单
    if (!value.isBool()) throw JsError(u"%1.%2 必须是 true/false,收到 %3"_s.arg(label, key, repr(value)));
    return value.p->b;
}

QString choice(V raw, const QString& key, const QStringList& allowed, const QString& dflt, const QString& label) {
    if (!in(raw, key)) return dflt;
    const V value = get(raw, key);
    if (!includesStr(allowed, value)) throw JsError(u"%1.%2 只能是 %3,收到 %4"_s.arg(label, key, allowed.join(u"、"_s), repr(value)));
    return value.p->s;
}

const NumOpts kMin1{1.0, u"1"_s, std::nullopt, {}};
const NumOpts kMin0f{0.0, u"0.0"_s, std::nullopt, {}};

contract::ProtectionsConfig buildProtections(V raw) {
    rejectUnknown({u"stoploss_guard"_s, u"max_drawdown"_s, u"cooldown"_s, u"daily_loss"_s}, raw, u"protections"_s);
    const V guard = orElse(get(raw, u"stoploss_guard"_s), emptyObject());
    const V dd = orElse(get(raw, u"max_drawdown"_s), emptyObject());
    const V cool = orElse(get(raw, u"cooldown"_s), emptyObject());
    const V daily = orElse(get(raw, u"daily_loss"_s), emptyObject());
    rejectUnknown({u"enabled"_s, u"lookback_minutes"_s, u"trigger_count"_s, u"pause_minutes"_s}, guard, u"protections.stoploss_guard"_s);
    rejectUnknown({u"enabled"_s, u"lookback_minutes"_s, u"max_drawdown_usd"_s, u"pause_minutes"_s}, dd, u"protections.max_drawdown"_s);
    rejectUnknown({u"enabled"_s, u"minutes"_s, u"scope"_s}, cool, u"protections.cooldown"_s);
    rejectUnknown({u"enabled"_s, u"max_loss_usd"_s, u"basis"_s}, daily, u"protections.daily_loss"_s);
    contract::ProtectionsConfig c;
    const QString g = u"protections.stoploss_guard"_s, m = u"protections.max_drawdown"_s, co = u"protections.cooldown"_s, dl = u"protections.daily_loss"_s;
    c.stoploss_guard.enabled = flag(guard, u"enabled"_s, false, g);
    c.stoploss_guard.lookback_minutes = numReq(guard, u"lookback_minutes"_s, true, 120, g, kMin1);
    c.stoploss_guard.trigger_count = numReq(guard, u"trigger_count"_s, true, 3, g, kMin1);
    c.stoploss_guard.pause_minutes = numReq(guard, u"pause_minutes"_s, true, 60, g, kMin1);
    c.max_drawdown.enabled = flag(dd, u"enabled"_s, false, m);
    c.max_drawdown.lookback_minutes = numReq(dd, u"lookback_minutes"_s, true, 1440, m, kMin1);
    c.max_drawdown.max_drawdown_usd = numReq(dd, u"max_drawdown_usd"_s, false, 500.0, m, kMin0f);
    c.max_drawdown.pause_minutes = numReq(dd, u"pause_minutes"_s, true, 120, m, kMin1);
    c.cooldown.enabled = flag(cool, u"enabled"_s, false, co);
    c.cooldown.minutes = numReq(cool, u"minutes"_s, true, 30, co, kMin1);
    c.cooldown.scope = choice(cool, u"scope"_s, {u"symbol"_s, u"position"_s}, u"symbol"_s, co);
    c.daily_loss.enabled = flag(daily, u"enabled"_s, false, dl);
    c.daily_loss.max_loss_usd = numReq(daily, u"max_loss_usd"_s, false, 500.0, dl, kMin0f);
    c.daily_loss.basis = choice(daily, u"basis"_s, {u"realized"_s, u"account"_s}, u"realized"_s, dl);
    return c;
}

contract::RiskBudgetConfig buildRiskBudget(V raw) {
    rejectUnknown({u"enabled"_s, u"equity_usd"_s, u"max_risk_pct"_s, u"max_position_pct"_s}, raw, u"risk_budget"_s);
    const V equityRaw = orElse(get(raw, u"equity_usd"_s), emptyObject());
    if (equityRaw.nullish() || !equityRaw.typeofObject() || equityRaw.isArr())
        throw JsError(u"risk_budget.equity_usd 必须是 {账户别名: 金额},收到 %1"_s.arg(repr(equityRaw)));
    contract::RiskBudgetConfig c;
    for (const QString& alias : keys(equityRaw)) c.equity_usd.insert(alias, numReq(equityRaw, alias, false, 0, u"risk_budget.equity_usd"_s, kMin0f));
    c.enabled = flag(raw, u"enabled"_s, false, u"risk_budget"_s);
    c.max_risk_pct = numReq(raw, u"max_risk_pct"_s, false, 2.0, u"risk_budget"_s, {0.1, u"0.1"_s, 100.0, u"100"_s});
    c.max_position_pct = numReq(raw, u"max_position_pct"_s, false, 25.0, u"risk_budget"_s, {0.1, u"0.1"_s, 1000.0, u"1000"_s});
    return c;
}

QString discordId(V value, const QString& label) {
    if (!value.isStr() || !isAsciiDigits(trim(value.p->s), 15, 21))
        throw JsError(u"%1 必须是带引号的 Discord ID(15–21 位数字),收到 %2"_s.arg(label, repr(value)));
    return trim(value.p->s);
}

bool noLineBreak(const QString& s) { return !s.contains(u'\r') && !s.contains(u'\n'); }

/// LOCAL_AUTHOR:`local:` 加 1–80 个 UTF-16 码元、不含换行
bool isLocalAuthor(const QString& s) {
    if (!s.startsWith(u"local:"_s)) return false;
    const QString rest = s.mid(6);
    return !rest.isEmpty() && rest.size() <= 80 && noLineBreak(rest);
}

QString localChannel(V value) {
    if (!value.isStr() || !noLineBreak(value.p->s) || trim(value.p->s).size() > 100)
        throw JsError(u"follow.local_channel 必须是不超过 100 字、不含换行的频道名,收到 %1"_s.arg(repr(value)));
    return trim(value.p->s);
}

QString followExitAt(V value) {
    const std::optional<QString> text = value.isStr() ? std::optional<QString>(trim(value.p->s)) : std::nullopt;
    if (text && text->isEmpty()) return {};
    bool ok = false;
    if (text) {
        const qsizetype colon = text->indexOf(u':');
        if (colon >= 1 && colon <= 2) {
            const QString h = text->left(colon), m = text->mid(colon + 1);
            ok = isAsciiDigits(h) && isAsciiDigits(m, 2, 2) && h.toInt() <= 23 && m.toInt() <= 59;
        }
    }
    if (!ok) throw JsError(u"follow.track_exit_at 必须是美东时间的 HH:MM(如 \"15:45\"),或者空着,收到 %1"_s.arg(repr(value)));
    return *text;
}

QString followAuthor(V value, const QString& label) {
    if (value.isStr() && isLocalAuthor(trim(value.p->s))) return trim(value.p->s);
    return discordId(value, label);
}

V stringList(V raw, const QString& key, const QString& label) {
    const V value = orElse(get(raw, key), emptyArray());
    if (!value.isArr()) throw JsError(u"%1.%2 必须是数组,收到 %3"_s.arg(label, key, repr(value)));
    return value;
}

QStringList uniq(const QStringList& l) {
    QStringList out;
    for (const QString& s : l)
        if (!out.contains(s)) out << s;
    return out;
}

contract::FollowConfig buildFollow(V raw) {
    rejectUnknown({u"enabled"_s, u"channel_id"_s, u"author_ids"_s, u"accounts"_s, u"max_age_seconds"_s, u"max_orders_per_day"_s, u"max_risk_usd"_s, u"local_inbox"_s,
                   u"local_channel"_s, u"track_fly"_s, u"track_exit_at"_s},
                  raw, u"follow"_s);
    const V channel = orElse(get(raw, u"channel_id"_s), lit(OJson::string(QString())));
    QStringList authors, accounts;
    const V authorList = stringList(raw, u"author_ids"_s, u"follow"_s);
    for (qsizetype i = 0; i < authorList.p->items.size(); ++i) authors << followAuthor(V{&authorList.p->items[i]}, u"follow.author_ids[%1]"_s.arg(i));
    const V accountList = stringList(raw, u"accounts"_s, u"follow"_s);
    for (qsizetype i = 0; i < accountList.p->items.size(); ++i) {
        const V v{&accountList.p->items[i]};
        if (!v.isStr() || trim(v.p->s).isEmpty()) throw JsError(u"follow.accounts[%1] 必须是账户别名,收到 %2"_s.arg(i).arg(repr(v)));
        accounts << trim(v.p->s);
    }
    contract::FollowConfig c;
    c.enabled = flag(raw, u"enabled"_s, false, u"follow"_s);
    c.channel_id = channel.isStr() && channel.p->s.isEmpty() ? QString() : discordId(channel, u"follow.channel_id"_s);
    c.author_ids = uniq(authors);
    c.accounts = uniq(accounts);
    c.max_age_seconds = numReq(raw, u"max_age_seconds"_s, true, 30, u"follow"_s, {1.0, {}, 600.0, {}});
    c.max_orders_per_day = numReq(raw, u"max_orders_per_day"_s, true, 3, u"follow"_s, {1.0, {}, 100.0, {}});
    c.max_risk_usd = numReq(raw, u"max_risk_usd"_s, false, 300.0, u"follow"_s, {1.0, u"1.0"_s, std::nullopt, {}});
    c.local_inbox = flag(raw, u"local_inbox"_s, false, u"follow"_s);
    c.local_channel = localChannel(orElse(get(raw, u"local_channel"_s), lit(OJson::string(QString()))));
    c.track_fly = flag(raw, u"track_fly"_s, false, u"follow"_s);
    c.track_exit_at = followExitAt(orElse(get(raw, u"track_exit_at"_s), lit(OJson::string(QString()))));
    return c;
}

struct AccountLimitKey {
    QString key;
    bool isInt;
    double min;
    QString minStr;
    QJsonValue contract::AccountLimits::* slot;
};
const std::vector<AccountLimitKey>& accountLimitKeys() {
    static const std::vector<AccountLimitKey> k{
        {u"max_order_notional"_s, false, 0.01, u"0.01"_s, &contract::AccountLimits::max_order_notional},
        {u"max_option_contracts"_s, true, 1, u"1"_s, &contract::AccountLimits::max_option_contracts},
        {u"max_mkt_shares"_s, true, 1, u"1"_s, &contract::AccountLimits::max_mkt_shares},
        {u"max_open_risk_usd"_s, false, 0.0, u"0.0"_s, &contract::AccountLimits::max_open_risk_usd},
        {u"max_underlying_contracts"_s, true, 0, u"0"_s, &contract::AccountLimits::max_underlying_contracts},
    };
    return k;
}

contract::OrderedMap<contract::AccountLimits> buildAccountLimits(V raw) {
    contract::OrderedMap<contract::AccountLimits> out;
    if (raw.nullish()) return out;
    if (!raw.typeofObject() || raw.isArr()) throw JsError(u"limits.by_account 必须是 {账户别名: {限额项: 数值}},收到 %1"_s.arg(repr(raw)));
    QStringList known;
    for (const auto& k : accountLimitKeys()) known << k.key;
    for (const QString& alias : keys(raw)) {
        const V value = get(raw, alias);
        if (value.nullish()) continue;
        if (!value.typeofObject() || value.isArr()) throw JsError(u"limits.by_account.%1 必须是 {限额项: 数值},收到 %2"_s.arg(alias, repr(value)));
        const QString label = u"limits.by_account."_s + alias;
        rejectUnknown(known, value, label);
        contract::AccountLimits one;
        bool any = false;
        for (const auto& k : accountLimitKeys()) {
            if (get(value, k.key).nullish()) continue;
            one.*(k.slot) = *num(value, k.key, k.isInt, std::nullopt, label, {k.min, k.minStr, std::nullopt, {}});
            any = true;
        }
        if (any) out.insert(alias, one);
    }
    return out;
}

contract::Limits buildLimits(V raw) {
    rejectUnknown({u"max_order_notional"_s, u"max_option_contracts"_s, u"max_mkt_shares"_s, u"min_confidence"_s, u"max_spread_slippage"_s, u"max_orders_per_input"_s,
                   u"duplicate_window_minutes"_s, u"duplicate_qty_tolerance"_s, u"max_open_risk_usd"_s, u"max_underlying_contracts"_s, u"auto_mid_spread_share"_s, u"by_account"_s},
                  raw, u"limits"_s);
    const QString L = u"limits"_s;
    contract::Limits l;
    l.max_order_notional = numReq(raw, u"max_order_notional"_s, false, 5000.0, L, {0.01, u"0.01"_s, std::nullopt, {}});
    l.max_option_contracts = numReq(raw, u"max_option_contracts"_s, true, 5, L, kMin1);
    l.max_mkt_shares = numReq(raw, u"max_mkt_shares"_s, true, 200, L, kMin1);
    l.min_confidence = numReq(raw, u"min_confidence"_s, false, 0.9, L, {0.0, u"0.0"_s, 1.0, u"1.0"_s});
    l.max_spread_slippage = numReq(raw, u"max_spread_slippage"_s, false, 0.10, L, kMin0f);
    l.max_orders_per_input = numReq(raw, u"max_orders_per_input"_s, true, 5, L, kMin1);
    l.duplicate_window_minutes = numReq(raw, u"duplicate_window_minutes"_s, true, 10, L, {0.0, u"0"_s, std::nullopt, {}});
    l.duplicate_qty_tolerance = numReq(raw, u"duplicate_qty_tolerance"_s, false, 0.2, L, kMin0f);
    l.max_open_risk_usd = numReq(raw, u"max_open_risk_usd"_s, false, 0.0, L, kMin0f);
    l.max_underlying_contracts = numReq(raw, u"max_underlying_contracts"_s, true, 0, L, {0.0, u"0"_s, std::nullopt, {}});
    l.auto_mid_spread_share = numReq(raw, u"auto_mid_spread_share"_s, false, 0.0, L, {0.0, u"0.0"_s, 1.0, u"1.0"_s});
    l.by_account = buildAccountLimits(get(raw, u"by_account"_s));
    return l;
}

contract::Policies buildPolicies(V raw) {
    // allow_combo_live、auto_execute、allow_live_trading、consecutive_failure_breaker:已撤掉的开关,老配置里还写着,认下、不用
    rejectUnknown({u"auto_execute"_s, u"allow_live_trading"_s, u"auto_outside_rth"_s, u"require_trigger_price_verification"_s, u"trigger_min_gap_bps"_s,
                   u"closed_market_policy"_s, u"consecutive_failure_breaker"_s, u"review_feature_enabled"_s, u"allow_combo_live"_s},
                  raw, u"policies"_s);
    const V policy = orElse(get(raw, u"closed_market_policy"_s), lit(OJson::string(u"reject_market_orders"_s)));
    if (!includesStr(kClosedMarketPolicies, policy)) throw JsError(u"policies.closed_market_policy 只能是 "_s + sortedCopy(kClosedMarketPolicies).join(u"、"_s));
    const QString P = u"policies"_s;
    contract::Policies p;
    p.auto_outside_rth = flag(raw, u"auto_outside_rth"_s, true, P);
    p.require_trigger_price_verification = flag(raw, u"require_trigger_price_verification"_s, true, P);
    p.trigger_min_gap_bps = numReq(raw, u"trigger_min_gap_bps"_s, false, 5.0, P, kMin0f);
    p.closed_market_policy = policy.p->s;
    p.review_feature_enabled = flag(raw, u"review_feature_enabled"_s, false, P);
    return p;
}

contract::LLMConfig buildLlm(V raw) {
    rejectUnknown({u"provider"_s, u"model"_s, u"effort"_s, u"temperature"_s, u"base_url"_s, u"max_tokens"_s, u"timeout_s"_s, u"keychain_service"_s, u"keychain_account"_s}, raw,
                  u"llm"_s);
    const V effort = orElse(get(raw, u"effort"_s), lit(OJson::string(u"high"_s)));
    if (!includesStr(kEffortLevels, effort)) throw JsError(u"llm.effort 只能是 "_s + sortedCopy(kEffortLevels).join(u"、"_s));
    QJsonValue temperature = QJsonValue::Null;
    if (!get(raw, u"temperature"_s).nullish()) temperature = *num(raw, u"temperature"_s, false, std::nullopt, u"llm"_s, {0.0, u"0.0"_s, 2.0, u"2.0"_s});
    const QString provider = str(orElse(get(raw, u"provider"_s), lit(OJson::string(u"anthropic"_s))));
    // provider in PROVIDER_META:Object.prototype 上的名字也算在内,它们的 needs_base_url / default_model 是 undefined
    const ProviderMeta* meta = providerMeta().find(provider);
    if (!meta && !objectProtoNames().contains(provider)) throw JsError(u"llm.provider 只能是 "_s + sortedCopy(providerMeta().keys()).join(u"、"_s));
    QString baseUrl = str(orElse(get(raw, u"base_url"_s), lit(OJson::string(QString()))));
    if (meta && meta->needs_base_url) {
        try {
            baseUrl = validateBaseUrl(baseUrl);
        } catch (const LLMError& e) {
            throw JsError(u"llm.base_url:"_s + e.message());
        }
    }
    QString model = str(orElse(get(raw, u"model"_s), lit(OJson::string(QString()))));
    if (model.isEmpty() && meta) model = meta->default_model;
    if (model.isEmpty()) throw JsError(u"llm.model 不能为空:请在「大模型」面板里选择或填写模型标识"_s);
    contract::LLMConfig c;
    c.provider = provider;
    c.model = model;
    c.effort = effort.p->s;
    c.temperature = temperature;
    c.base_url = baseUrl;
    c.max_tokens = numReq(raw, u"max_tokens"_s, true, 8000, u"llm"_s, {1000.0, u"1000"_s, std::nullopt, {}});
    c.timeout_s = numReq(raw, u"timeout_s"_s, false, 60.0, u"llm"_s, {1.0, u"1.0"_s, std::nullopt, {}});
    c.keychain_service = str(orElse(get(raw, u"keychain_service"_s), lit(OJson::string(u"dafri-llm-api-key"_s))));
    c.keychain_account = str(orElse(get(raw, u"keychain_account"_s), lit(OJson::string(QString()))));
    if (c.keychain_account.isEmpty()) c.keychain_account = provider;
    return c;
}

contract::FutuConfig buildFutu(V raw) {
    rejectUnknown({u"trd_market"_s, u"security_firm"_s, u"keychain_service"_s, u"keychain_account"_s, u"symbol_map"_s}, raw, u"broker.futu"_s);
    const QString market = upper(str(orElse(get(raw, u"trd_market"_s), lit(OJson::string(u"US"_s)))));
    if (!kFutuMarkets.contains(market)) throw JsError(u"broker.futu.trd_market 只能是 "_s + sortedCopy(kFutuMarkets).join(u"、"_s));
    const QString firm = upper(str(orElse(get(raw, u"security_firm"_s), lit(OJson::string(u"FUTUSECURITIES"_s)))));
    if (!kFutuFirms.contains(firm)) throw JsError(u"broker.futu.security_firm 只能是 "_s + sortedCopy(kFutuFirms).join(u"、"_s));
    contract::FutuConfig c;
    const V map = orElse(get(raw, u"symbol_map"_s), emptyObject());
    for (const QString& key : keys(map)) {
        const QString code = trim(str(get(map, key)));
        if (code.isEmpty()) throw JsError(u"broker.futu.symbol_map 里 %1 的富途代码为空"_s.arg(key));
        c.symbol_map.insert(upper(trim(key)), code);
    }
    c.trd_market = market;
    c.security_firm = firm;
    c.keychain_service = str(orElse(get(raw, u"keychain_service"_s), lit(OJson::string(u"dafri-futu-unlock"_s))));
    c.keychain_account = str(orElse(get(raw, u"keychain_account"_s), lit(OJson::string(QString()))));
    if (c.keychain_account.isEmpty()) c.keychain_account = u"futu"_s;
    return c;
}

contract::BrokerConfig buildBroker(V raw) {
    rejectUnknown({u"provider"_s, u"futu"_s, u"auto_connect"_s}, raw, u"broker"_s);
    const QString provider = str(orElse(get(raw, u"provider"_s), lit(OJson::string(u"ibkr"_s))));
    if (!kBrokerProviders.contains(provider)) throw JsError(u"broker.provider 只能是 "_s + kBrokerProviders.join(u"、"_s));
    const V autoConnect = orElse(get(raw, u"auto_connect"_s), lit(OJson::boolean(true)));
    if (!autoConnect.isBool()) throw JsError(u"broker.auto_connect 只能是 true 或 false"_s);
    contract::BrokerConfig c;
    c.provider = provider;
    c.futu = buildFutu(orElse(get(raw, u"futu"_s), emptyObject()));
    c.auto_connect = autoConnect.p->b;
    return c;
}

contract::ConnectionConfig buildConnection(const QString& name, V raw) {
    const QString broker = str(orElse(get(raw, u"broker"_s), lit(OJson::string(u"ibkr"_s))));
    if (!kBrokerProviders.contains(broker))
        throw JsError(u"连接 %1 的 broker 只能是 %2(收到 %3)"_s.arg(name, kBrokerProviders.join(u"、"_s), util::pyRepr(QJsonValue(broker))));
    contract::ConnectionConfig c;
    c.name = name;
    c.host = str(orElse(get(raw, u"host"_s), lit(OJson::string(u"127.0.0.1"_s))));
    c.port = std::trunc(number(orElse(get(raw, u"port"_s), lit(OJson::number(defaultBrokerPort(broker))))));
    c.client_id = std::trunc(number(orElse(get(raw, u"client_id"_s), lit(OJson::number(11)))));
    c.readonly = pyTruthy(orElse(get(raw, u"readonly"_s), lit(OJson::boolean(false))));
    c.broker = broker;
    return c;
}

void assertUniqueAliases(const std::vector<contract::AccountConfig>& accounts) {
    QSet<QString> seen;
    int defaults = 0;
    for (const auto& a : accounts) {
        if (seen.contains(a.alias)) throw JsError(u"账户别名重复:"_s + a.alias);
        if (a.alias == u"DEFAULT") throw JsError(u"别名不得叫 DEFAULT(保留字)"_s);
        seen.insert(a.alias);
        defaults += a.isDefault ? 1 : 0;
    }
    if (!accounts.empty() && defaults != 1) throw JsError(u"必须且只能有一个账户标记 default=true(当前 %1 个)"_s.arg(defaults));
}

void assertAccountConnections(const Settings& s) {
    for (const auto& a : s.accounts)
        if (!s.connections.contains(a.connection) && !objectProtoNames().contains(a.connection))
            throw JsError(u"账户 %1 指向未定义的连接 %2"_s.arg(a.alias, a.connection));
    if (!s.connections.isEmpty() && s.connectionsFor().isEmpty()) {
        const QString p = s.broker.provider;
        throw JsError(u"broker.provider=%1,但 connections 里没有任何 broker=\"%1\" 的连接。请先在配置里加一条(富途 OpenD 默认端口 %2)。"_s.arg(
            p, util::jsNumberToString(defaultBrokerPort(p))));
    }
}

/// 账号长得像实盘、却标成纸面的:按实盘处理并留一条提醒(只管走 IBKR 的账户)
QStringList livePaperMismatches(Settings& s) {
    QStringList out;
    for (auto& a : s.accounts) {
        if (!a.is_paper || s.accountBroker(a) != u"ibkr") continue;
        if (a.account_id.startsWith(u'D') || a.account_id.startsWith(u'd')) continue;
        a.is_paper = false;
        out << u"账户 %1 标的是纸面账户,但账号不是 IBKR 模拟账号的样子(模拟账号以 D 开头),已按实盘账户处理。如果它确实是模拟账户,请核对账号有没有填错。"_s.arg(a.alias);
    }
    return out;
}

/// is_paper:没写 = 空(按实盘);字符串只认 true / false(不分大小写);别的报错
std::optional<bool> paperFlag(V a) {
    if (!in(a, u"is_paper"_s) || get(a, u"is_paper"_s).nullish()) return std::nullopt;
    const V value = get(a, u"is_paper"_s);
    if (value.isBool()) return value.p->b;
    const QString text = value.isStr() ? lower(trim(value.p->s)) : QString();
    if (text == u"true") return true;
    if (text == u"false") return false;
    throw JsError(u"账户 %1 的 is_paper 必须是 true/false,收到 %2"_s.arg(str(get(a, u"alias"_s)), repr(value)));
}

/// [...configured](字符串按码点拆开;不是数组、字符串、null 的抛 TypeError)。元素原样留着
QList<OJson> iterateCalendar(V v) {
    QList<OJson> out;
    if (v.nullish()) return out;
    if (v.isStr()) {
        const QString& s = v.p->s;
        for (qsizetype i = 0; i < s.size(); ++i) {
            if (s[i].isHighSurrogate() && i + 1 < s.size() && s[i + 1].isLowSurrogate()) {
                out << OJson::string(s.mid(i, 2));
                ++i;
            } else {
                out << OJson::string(QString(s[i]));
            }
        }
        return out;
    }
    if (!v.isArr()) throw JsError(u"configured is not iterable"_s);
    return v.p->items;
}

/// SameValueZero(Set 去重用):原始值按类型 + 值比;数组 / 对象各是各的(JSON.parse 出来的没有两个是同一个)
bool sameValueZero(const OJson& a, const OJson& b) {
    if (a.type != b.type) return false;
    switch (a.type) {
    case OJson::Null: return true;
    case OJson::Bool: return a.b == b.b;
    case OJson::Number: return a.n == b.n || (std::isnan(a.n) && std::isnan(b.n));
    case OJson::String: return a.s == b.s;
    default: return false;
    }
}

/// marketCalendar.ts 的 mergeCalendar:[...new Set([...configured, ...builtin])].sort()——去重同 Set,排序按 String(v)(稳定)
QList<OJson> mergeCalendarJs(const QList<OJson>& configured, const QStringList& builtin) {
    QList<OJson> all = configured;
    for (const QString& d : builtin) all << OJson::string(d);
    QList<OJson> uniq;
    for (const OJson& x : all) {
        bool seen = false;
        for (const OJson& y : uniq)
            if (sameValueZero(x, y)) {
                seen = true;
                break;
            }
        if (!seen) uniq << x;
    }
    std::stable_sort(uniq.begin(), uniq.end(), [](const OJson& a, const OJson& b) { return str(V{&a}) < str(V{&b}); });
    return uniq;
}

QStringList stringsOf(const QList<OJson>& l) {
    QStringList out;
    for (const OJson& x : l)
        if (x.type == OJson::String) out << x.s;
    return out;
}

}  // namespace

Settings fromDict(const OJson& rawJson, const std::optional<QString>& source) {
    arena().clear();
    const V raw{&rawJson};
    QStringList paperMissing;
    std::vector<contract::AccountConfig> accounts;
    const V accountList = orElse(get(raw, u"accounts"_s), emptyArray());
    if (!accountList.isArr()) throw JsError(u"(raw.accounts ?? []).map is not a function"_s);
    for (const OJson& item : accountList.p->items) {
        const V a{&item};
        const auto paper = paperFlag(a);
        if (!paper) paperMissing << str(get(a, u"alias"_s));
        contract::AccountConfig c;
        c.alias = str(get(a, u"alias"_s));
        c.account_id = str(get(a, u"account_id"_s));
        c.is_paper = paper.value_or(false);
        c.connection = str(orElse(get(a, u"connection"_s), lit(OJson::string(u"paper"_s))));
        c.isDefault = pyTruthy(orElse(get(a, u"default"_s), lit(OJson::boolean(false))));
        accounts.push_back(c);
    }
    assertUniqueAliases(accounts);

    contract::OrderedMap<contract::ConnectionConfig> connections;
    const V connRaw = orElse(get(raw, u"connections"_s), emptyObject());
    for (const QString& name : keys(connRaw)) connections.insert(name, buildConnection(name, get(connRaw, name)));
    for (const QString& name : connections.keys()) {
        const auto& c = *connections.find(name);
        // §9.2:API 端口只绑本机,绝不跨网段
        if (c.host != u"127.0.0.1" && c.host != u"localhost" && c.host != u"::1") throw JsError(u"连接 %1 的 host 必须是本机地址,当前为 %2"_s.arg(c.name, c.host));
    }

    contract::OrderedMap<contract::IndexConfig> indexes;
    const V idxRaw = orElse(get(raw, u"index_symbols"_s), emptyObject());
    for (const QString& sym : keys(idxRaw)) {
        const V c = get(idxRaw, sym);
        const QString up = upper(sym);
        const bool spx = up == u"SPX";  // 内置的期货映射只放真机核对过的:SPX → ES(CME)
        contract::IndexConfig x;
        x.symbol = up;
        x.exchange = str(orElse(get(c, u"exchange"_s), lit(OJson::string(u"CBOE"_s))));
        x.daily_trading_class = str(orElse(get(c, u"daily_trading_class"_s), lit(OJson::string(QString()))));
        x.monthly_trading_class = str(orElse(get(c, u"monthly_trading_class"_s), lit(OJson::string(QString()))));
        // 配置里显式写了(哪怕是空串)就听配置的;没写才用内置映射
        x.futures = str(orElse(get(c, u"futures"_s), lit(OJson::string(spx ? u"ES"_s : QString()))));
        x.futures_exchange = str(orElse(get(c, u"futures_exchange"_s), lit(OJson::string(u"CME"_s))));
        indexes.insert(up, x);
    }

    const V storage = orElse(get(raw, u"storage"_s), emptyObject());
    Settings s;
    const V promptDir = get(raw, u"prompt_dir"_s);
    s.prompt_dir = jsTruthy(promptDir) ? str(promptDir) : defaultPromptDir();
    s.prompt_version = str(orElse(get(raw, u"prompt_version"_s), lit(OJson::string(u"v1.0.0"_s))));
    // "latest":跟着软件带的最新一版提示词走;要钉住(回滚)就写具体的版本号
    if (s.prompt_version == u"latest") {
        const auto latest = latestPromptVersion(s.prompt_dir);
        if (!latest) throw JsError(u"prompt_version 写的是 latest,但提示词目录里一版都没有:"_s + s.prompt_dir);
        s.prompt_version = *latest;
        s.prompt_follows_latest = true;
    }
    // 与 Python 的 Settings(...) 参数求值顺序一致:llm → broker → limits → policies
    s.llm = buildLlm(orElse(get(raw, u"llm"_s), emptyObject()));
    s.broker = buildBroker(orElse(get(raw, u"broker"_s), emptyObject()));
    s.limits = buildLimits(orElse(get(raw, u"limits"_s), emptyObject()));
    s.policies = buildPolicies(orElse(get(raw, u"policies"_s), emptyObject()));
    s.protections = buildProtections(orElse(get(raw, u"protections"_s), emptyObject()));
    s.risk_budget = buildRiskBudget(orElse(get(raw, u"risk_budget"_s), emptyObject()));
    s.follow = buildFollow(orElse(get(raw, u"follow"_s), emptyObject()));
    s.accounts = accounts;
    s.connections = connections;
    const V aliasRaw = orElse(get(raw, u"symbol_aliases"_s), emptyObject());
    for (const QString& k : keys(aliasRaw)) s.symbol_aliases.insert(k, upper(str(get(aliasRaw, k))));
    s.index_symbols = indexes;
    // 休市日 / 提前收盘日 = 配置里写的 ∪ 内置日历;"market_calendar": "config_only" 退回只认配置里写的
    const QString calendarMode = str(orElse(get(raw, u"market_calendar"_s), lit(OJson::string(u"builtin"_s))));
    if (calendarMode != u"builtin" && calendarMode != u"config_only")
        throw JsError(u"market_calendar 只能是 builtin 或 config_only,收到 "_s + repr(get(raw, u"market_calendar"_s)));
    const util::BuiltinCalendar none;
    const util::BuiltinCalendar& builtin = calendarMode == u"builtin" ? util::builtinCalendar() : none;
    s.market_holidays_raw = mergeCalendarJs(iterateCalendar(get(raw, u"market_holidays"_s)), builtin.holidays);
    s.early_close_days_raw = mergeCalendarJs(iterateCalendar(get(raw, u"early_close_days"_s)), builtin.earlyCloses);
    s.market_holidays = stringsOf(s.market_holidays_raw);
    s.early_close_days = stringsOf(s.early_close_days_raw);
    if (const V dbPath = get(storage, u"db_path"_s); jsTruthy(dbPath)) s.db_path = expandHome(str(dbPath));
    s.source_path = source;
    s.paper_flag_missing = paperMissing;
    for (const QString& alias : paperMissing)
        s.config_warnings << u"账户 %1 没写 is_paper,已按实盘账户处理。请在 config/settings.json 里给它写明 \"is_paper\": true 或 false。"_s.arg(alias);
    assertAccountConnections(s);
    s.config_warnings << livePaperMismatches(s);
    arena().clear();
    return s;
}

// ================================================================ 读、写回
Settings loadSettings(const QString& settingsPath) {
    const QString p = settingsPath.isEmpty() ? defaultConfigPath() : settingsPath;
    if (!QFileInfo::exists(p))
        throw ConfigLoadError(u"missing"_s, p, u"找不到配置文件 %1。请复制 config/settings.example.json 为 config/settings.json 后修改。"_s.arg(p));
    QFile f(p);
    if (!f.open(QIODevice::ReadOnly)) throw JsError(u"EACCES: permission denied, open '%1'"_s.arg(p));
    const QString text = util::nodeUtf8(f.readAll());
    if (const auto why = util::v8JsonParseError(text)) throw ConfigLoadError(u"syntax"_s, p, u"配置文件不是合法的 JSON(多半是手改时少了逗号或引号):"_s + *why);
    const auto raw = util::parseOJson(text);
    if (!raw) throw ConfigLoadError(u"syntax"_s, p, u"配置文件嵌套得太深(超过 %1 层)"_s.arg(util::kMaxJsonDepth));
    if (!raw->isObject()) throw ConfigLoadError(u"syntax"_s, p, u"配置文件的最外层必须是一个 { } 对象"_s);
    try {
        return fromDict(*raw, p);
    } catch (const JsError& e) {
        throw ConfigLoadError(u"invalid"_s, p, e.message());
    }
}

QString configBackupPath(const QString& settingsPath) { return settingsPath + u".bak"_s; }

namespace {
[[noreturn]] void throwFs(const char* code, const QString& action, const QString& target) {
    throw JsError(u"%1, %2 '%3'"_s.arg(QString::fromLatin1(code), action, target));
}

/// writeFileAtomic(config.ts 逐句):`<目标>.tmp-<pid>` 用 0600 建、写完、fsync,再 rename 过去。
/// 临时文件那一步失败就抛,目标文件一个字节不动(磁盘满时不能把 settings.json 截成半截);
/// 只有 rename 失败(Windows 上目标正被别的进程打开)才退回直接写,写完删掉临时文件,目标还不在才抛 rename 的错
void writeFileAtomic(const QString& target, const QByteArray& text) {
    const QString tmp = u"%1.tmp-%2"_s.arg(target).arg(QCoreApplication::applicationPid());
    {
        QFile f(tmp);
        if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate, QFileDevice::ReadOwner | QFileDevice::WriteOwner))
            throwFs(QFileInfo::exists(QFileInfo(tmp).absolutePath()) ? "EACCES: permission denied" : "ENOENT: no such file or directory", u"open"_s, tmp);
        if (f.write(text) != text.size() || !f.flush()) {
            f.close();
            throwFs("ENOSPC: no space left on device", u"write"_s, tmp);
        }
#if defined(Q_OS_WIN)
        if (_commit(f.handle()) != 0) throwFs("EIO: i/o error", u"fsync"_s, tmp);
#else
        if (::fsync(f.handle()) != 0) throwFs("EIO: i/o error", u"fsync"_s, tmp);
#endif
    }
#if defined(Q_OS_WIN)
    const bool renamed = MoveFileExW(reinterpret_cast<LPCWSTR>(tmp.utf16()), reinterpret_cast<LPCWSTR>(target.utf16()), MOVEFILE_REPLACE_EXISTING) != 0;
#else
    const bool renamed = ::rename(QFile::encodeName(tmp).constData(), QFile::encodeName(target).constData()) == 0;
#endif
    if (renamed) return;
    {
        QFile direct(target);
        const bool ok = direct.open(QIODevice::WriteOnly | QIODevice::Truncate) && direct.write(text) == text.size();
        direct.close();
        QFile::remove(tmp);
        if (!ok) throwFs("EACCES: permission denied", u"open"_s, target);  // TS:writeFileSync 的错从 try 里冒出来
    }
    if (!QFileInfo::exists(target)) throwFs("EPERM: operation not permitted", u"rename"_s, tmp + u"' -> '"_s + target);
}
}  // namespace

OJson deepMerge(const OJson& base, const OJson& patch) {
    OJson out = base;
    for (const auto& [key, value] : patch.fields) {
        const OJson* cur = out.get(key);
        if (value.isObject() && cur && cur->isObject()) out.set(key, deepMerge(*cur, value));
        else out.set(key, value);
    }
    return out;
}

Settings patchConfigFile(const std::optional<QString>& settingsPath, const OJson& patch) {
    if (!settingsPath) throw JsError(u"当前设置不是从文件加载的,无法写回"_s);
    QFile f(*settingsPath);
    if (!f.open(QIODevice::ReadOnly)) throw JsError(u"ENOENT: no such file or directory, open '%1'"_s.arg(*settingsPath));
    const QByteArray before = f.readAll();
    f.close();
    const QString beforeText = util::nodeUtf8(before);
    if (const auto why = util::v8JsonParseError(beforeText)) throw JsError(*why);  // TS 的 JSON.parse 抛的 SyntaxError,原话
    const auto raw = util::parseOJson(beforeText);
    if (!raw) throw JsError(u"Maximum call stack size exceeded"_s);  // 超过 parseOJson 的嵌套深度上限
    const OJson merged = deepMerge(*raw, patch);
    Settings settings = fromDict(merged, *settingsPath);  // 验证:抛异常就不会走到写盘
    try {
        writeFileAtomic(configBackupPath(*settingsPath), before);
    } catch (const JsError&) {
        // 备份写不进去(目录只读?)不该挡住这一次保存:保存本身还会再试一次写盘,写不进去由它报
    }
    writeFileAtomic(*settingsPath, util::stringifyOJson(merged, 2).toUtf8());
    return settings;
}

}  // namespace ibkr::domain
