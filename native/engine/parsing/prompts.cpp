#include "parsing/prompts.h"

#include "util/jsformat.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/tz.h"

#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QRegularExpression>

#include <algorithm>
#include <cmath>

using namespace Qt::StringLiterals;
using ibkr::util::JVal;
using ibkr::util::OJson;
namespace js = ibkr::util::js;

namespace ibkr::parsing::prompts {

namespace {
/// path.join(dir, name)(dir 末尾带不带分隔符都一样)
QString joinPath(const QString& dir, const QString& name) { return QDir::cleanPath(dir + u'/' + name); }

/// fs.existsSync:目录也算存在
bool exists(const QString& p) { return QFileInfo::exists(p); }

/// fs.readFileSync(p, "utf-8"),读不了抛 Node 样子的错
QString readUtf8(const QString& p) {
    QFile f(p);
    if (QFileInfo(p).isDir()) throw util::CodedError(u"EISDIR: illegal operation on a directory, read"_s, u"EISDIR"_s);
    if (!f.open(QIODevice::ReadOnly)) throw util::CodedError(u"EACCES: permission denied, open '%1'"_s.arg(p), u"EACCES"_s);
    return util::nodeUtf8(f.readAll());
}

QString readFile(const QString& p) {
    if (!exists(p)) throw PromptError(u"提示词文件不存在:"_s + p);
    // Python 的 read_text 走 universal newlines(\r\n → \n)
    QString s = readUtf8(p);
    s.replace(u"\r\n"_s, u"\n"_s);
    s.replace(u'\r', u'\n');
    return s;
}

/// Python 的 _num:整数值去掉小数,其余 "%f" 去尾零
QString numStr(double value) {
    if (std::isfinite(value) && std::trunc(value) == value) return util::jsNumberToString(value);
    QString s = util::jsToFixed(value, 6);
    static const QRegularExpression zeros(u"0+\\z"_s), dot(u"\\.\\z"_s);
    s.replace(zeros, QString());
    s.replace(dot, QString());
    return s;
}
/// numStr 吃的是快照里的值:不是数时照 JS 抛
QString numStrOf(const OJson& v) {
    if (v.type == OJson::Number) return numStr(v.n);
    if (v.type == OJson::Null) throw util::JsError(u"Cannot read properties of null (reading 'toFixed')"_s);
    throw util::JsError(u"value.toFixed is not a function"_s);
}

QString substitute(const QString& tmpl, const std::vector<std::pair<QString, QString>>& values) {
    QString out = tmpl;
    for (const auto& [key, value] : values) out.replace(u"{{"_s + key + u"}}"_s, value);
    return out;
}

void assertComplete(const QString& text, const QString& which) {
    static const QRegularExpression placeholder(u"\\{\\{[A-Z_]+\\}\\}"_s);
    QStringList leftovers;
    auto it = placeholder.globalMatch(text);
    while (it.hasNext()) {
        const QString m = it.next().captured(0);
        if (!leftovers.contains(m)) leftovers << m;
    }
    std::sort(leftovers.begin(), leftovers.end());
    if (!leftovers.isEmpty()) throw PromptError(u"%1 提示词存在未替换的模板变量:%2"_s.arg(which, leftovers.join(u", "_s)));
}

void assertNoAccountIds(const QString& text, const domain::Settings& settings) {
    for (const auto& acct : settings.accounts)
        if (!acct.account_id.isEmpty() && text.contains(acct.account_id))
            throw PromptError(u"提示词中出现了真实账号(别名 %1),违反 S0 数据流向约束,已中止调用。"_s.arg(acct.alias));
}

QString strfMinute(double epochMs, const char16_t* tz) {
    const util::WallParts p = util::wallParts(epochMs, QString::fromUtf16(tz));
    return util::jsNumberToString(p.year) + u'-' + util::pad2(p.month) + u'-' + util::pad2(p.day) + u' ' + util::pad2(p.hour) + u':' + util::pad2(p.minute);
}

QString snapshotLine(const OJson* snapshot) {
    if (!snapshot || snapshot->type != OJson::Object || snapshot->fields.isEmpty()) return {};
    QStringList parts;
    for (const auto& [sym, price] : snapshot->fields) parts << sym.toUpper() + u" 现价 "_s + numStrOf(price);
    return u"\n相关行情快照:"_s + parts.join(u';') + u"\n"_s;
}

const JVal* entry(const JVal& obj, const QString& key) {
    for (const auto& [k, v] : obj.entries)
        if (k == key) return &v;  // .find:第一个
    return nullptr;
}
}  // namespace

QString fingerprint(const PromptBundle& bundle) {
    JVal arr;
    arr.kind = JVal::Arr;
    for (const FewShotPair& p : bundle.fewshot) arr.items.push_back(p.assistantJ);
    const QString payload = bundle.system_text + u"\n--\n"_s + util::pyDumpsSorted(arr);
    return QString::fromLatin1(QCryptographicHash::hash(util::toNodeUtf8(payload), QCryptographicHash::Sha256).toHex().left(16));
}

PromptBundle loadPromptBundle(const domain::Settings& settings) {
    const QString version = settings.prompt_version;
    const QString directory = settings.prompt_dir;
    const QString systemRaw = readFile(joinPath(directory, u"system_%1.md"_s.arg(version)));
    const QString userRaw = readFile(joinPath(directory, u"user_message_%1.md"_s.arg(version)));
    // 只改了系统提示词、少样本原样沿用的版本:指到内容相同的旧版本(与 Python prompts.py 同一张表)
    const QString fewshotVersion = version == u"v1.7.0" ? u"v1.6.0"_s : version;
    const QString fewshotPath = joinPath(directory, u"fewshot_%1.json"_s.arg(fewshotVersion));
    std::vector<FewShotPair> fewshot;
    if (exists(fewshotPath)) {
        const JVal data = util::parseJson(readUtf8(fewshotPath));
        if (data.kind == JVal::Obj) {
            const JVal* pairs = entry(data, u"pairs"_s);
            if (pairs && pairs->kind == JVal::Arr) {
                for (const JVal& pair : pairs->items) {
                    if (pair.kind != JVal::Obj) continue;
                    const JVal* nameJ = entry(pair, u"name"_s);
                    const JVal* userJ = entry(pair, u"user"_s);
                    const JVal* assistantJ = entry(pair, u"assistant"_s);
                    if (!userJ || userJ->kind != JVal::Str || !assistantJ) throw PromptError(u"少样本文件格式不对:"_s + fewshotPath);
                    fewshot.push_back({nameJ && nameJ->kind == JVal::Str ? nameJ->text : QString(), userJ->text, util::toPlainOJson(*assistantJ), *assistantJ});
                }
            }
        }
    }
    return {version, renderSystem(systemRaw, settings), userRaw, fewshot};
}

QString renderSystem(const QString& tmpl, const domain::Settings& settings) {
    const QString text = substitute(tmpl, {{u"MAX_ORDER_NOTIONAL"_s, numStr(settings.limits.max_order_notional)},
                                           {u"MAX_OPTION_CONTRACTS"_s, util::jsNumberToString(settings.limits.max_option_contracts)},
                                           {u"MAX_MKT_SHARES"_s, util::jsNumberToString(settings.limits.max_mkt_shares)},
                                           {u"SYMBOL_ALIAS_TABLE"_s, settings.promptSymbolTable()},
                                           {u"ACCOUNT_ALIAS_TABLE"_s, settings.promptAccountTable()}});
    assertComplete(text, u"system"_s);
    assertNoAccountIds(text, settings);
    return text;
}

QString renderUser(const PromptBundle& bundle, const domain::Settings& settings, const QString& instruction, const domain::EtNow& nowEt,
                   const QString& marketStatus, const OJson* snapshot) {
    const QString status = marketStatus.isEmpty() ? settings.marketStatus(nowEt) : marketStatus;
    const QString text = substitute(bundle.user_template, {{u"NOW_ET"_s, strfMinute(nowEt.epochMs, util::kET)},
                                                           {u"NOW_BJ"_s, strfMinute(nowEt.epochMs, util::kBJ)},
                                                           {u"MARKET_STATUS"_s, status},
                                                           {u"MAX_ORDER_NOTIONAL"_s, numStr(settings.limits.max_order_notional)},
                                                           {u"MAX_OPTION_CONTRACTS"_s, util::jsNumberToString(settings.limits.max_option_contracts)},
                                                           {u"MARKET_SNAPSHOT_LINE"_s, snapshotLine(snapshot)},
                                                           {u"USER_INSTRUCTION"_s, util::jsTrim(instruction)}});
    assertComplete(text, u"user"_s);
    assertNoAccountIds(text, settings);
    return text;
}

}  // namespace ibkr::parsing::prompts
