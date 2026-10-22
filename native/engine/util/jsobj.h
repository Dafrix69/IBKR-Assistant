// 把 OJson 当 JS 的值用(引擎里那些 `Record<string, any>`:交易记录、成交行、事件的 payload……TS 拿 JSON.parse 出来的东西直接读写)。
// 指针为空 = undefined。照 JS 的规矩:
//   · prop(v, k) 是 `v?.[k]`:v 是 null / undefined / 原始值时得 undefined(不抛);数组按下标、字符串按码元取;
//   · str(v) = String(v);num(v) = Number(v);truthy(v) = if (v);pyTruthy(v) = py.ts 的 truthy;
//   · stringify(v) = JSON.stringify(v)(紧凑);sortKeys(v) = store.ts 的 sortKeys(键排序之后,像下标的键照样排在最前,同 V8)。
// 原地改对象用 OJson::set(键序同 JS)。不造新值:要"缺省值"时调用方自己判 nullish。
#pragma once

#include "util/ordered_json.h"

#include <QString>
#include <QStringList>

#include <optional>

namespace ibkr::util::js {

inline bool undef(const OJson* v) { return v == nullptr; }
inline bool nullish(const OJson* v) { return v == nullptr || v->type == OJson::Null; }
inline bool isObj(const OJson* v) { return v && v->type == OJson::Object; }
inline bool isArr(const OJson* v) { return v && v->type == OJson::Array; }
inline bool isStr(const OJson* v) { return v && v->type == OJson::String; }
inline bool isNum(const OJson* v) { return v && v->type == OJson::Number; }
inline bool isBool(const OJson* v) { return v && v->type == OJson::Bool; }
/// typeof v === "object" && v !== null(数组也算)
inline bool isObjectLike(const OJson* v) { return v && (v->type == OJson::Object || v->type == OJson::Array); }

/// v?.[key](字符串下标取出来的单个码元没有地方放,这里不支持:字符串上一律 undefined,除了调用方自己判 length)
const OJson* prop(const OJson* v, const QString& key);
OJson* propMut(OJson* v, const QString& key);
/// v?.[a]?.[b]…
const OJson* path(const OJson* v, std::initializer_list<QString> keys);

QString str(const OJson* v);
double num(const OJson* v);
bool truthy(const OJson* v);
bool pyTruthy(const OJson* v);
/// a ?? fallback 之后 String():a 是 null / undefined 时用 fallback
QString strOr(const OJson* v, const QString& fallback);

/// py.ts 的 finiteOrNull:null / undefined / 布尔是空;数原样;别的走 Number()
std::optional<double> finiteOrNull(const OJson* v);
/// a === b(原始值按类型与值;对象 / 数组只有同一个才相等,这里一律不等)
bool strictEqual(const OJson* a, const OJson* b);
/// py.ts 的 pyG(v) 拿到的不是数时(TS 的类型挡不住运行时):Number.isFinite 不转换,于是落到 `v > 0 ? "inf" : "-inf"`
QString pyG(const OJson* v);
/// Object.keys(v)
QStringList keys(const OJson* v);

QString stringify(const OJson& v);
OJson sortKeys(const OJson& v);
/// JSON.parse;不合法回空
std::optional<OJson> parse(const QString& text);
/// JSON.parse;不合法就抛那句 V8 的 SyntaxError 原话(TS 里没有 try 的那些 JSON.parse)
OJson parseOrThrow(const QString& text);
/// v[key],v 是 null / undefined 时抛 TypeError 原话("Cannot read properties of null (reading 'k')");原始值上得 undefined
const OJson* propStrict(const OJson* v, const QString& key);
/// JS 的 a + b(有一边转成原始值之后是字符串就拼接,否则按数加)
OJson add(const OJson& a, const OJson& b);

/// 对象字面量:按给的先后 set(键序同 JS)
OJson object(std::initializer_list<std::pair<QString, OJson>> kv = {});
OJson array(const QList<OJson>& items = {});
OJson strings(const QStringList& l);
inline OJson S(const QString& s) { return OJson::string(s); }
inline OJson N(double v) { return OJson::number(v); }
inline OJson B(bool v) { return OJson::boolean(v); }
inline OJson Null() { return OJson::null(); }
/// 可选的数:空 = null
inline OJson NOrNull(const std::optional<double>& v) { return v ? OJson::number(*v) : OJson::null(); }
/// 指针指的值的拷贝;undefined 时给 null(放进对象字面量时 JSON.stringify 会把 undefined 的键丢掉——要那样就别 set)
inline OJson copyOrNull(const OJson* v) { return v ? *v : OJson::null(); }

}  // namespace ibkr::util::js
