// JS 的 Number() / String() / 真假,作用在 JSON 值上(引擎与界面共用;界面那边的 shell/jsvalue.h 只是把这里的名字引过去)。
//
// 为什么要照抄 JS:确认凭据(confirm_grants)的每一条判断都是在 JS 里写的——Number("") 是 0、Number(undefined) 是 NaN、
// 读不出的数按"放松了"算……C++ 版换一种读法,同一份补丁就可能少问一次确认。期望值由 node 现算
// (tests/fixtures/gen_confirm_grants.mjs),不是凭记忆写的。
#pragma once

#include <QJsonValue>
#include <QString>
#include <QTimeZone>

#include "util/jsformat.h"

namespace ibkr::util {

/// Number(v)
double jsNumber(const QJsonValue& v);
/// String(v)
QString jsString(const QJsonValue& v);
/// Boolean(v):undefined / null / false / 0 / NaN / "" 是假,别的(含空对象、空数组)是真
bool jsTruthy(const QJsonValue& v);
/// JSON.stringify 一个字符串(带引号,转义规则同 JS)
QString jsonQuote(const QString& s);
/// String.prototype.normalize("NFKC"),对的是 Electron 41 的 ICU 77(Unicode 16)。Qt 6.12 的表是 Unicode 17:
/// 全部 111 万个码位里只有 U+A7F1、U+16126–U+16128 两边不一样(17 才有的分解),这几个照原样留着;落单的代理项两边都不动
QString jsNormalizeNfkc(const QString& s);
/// 落单的代理项换成 U+F8FF(长度不变)。JS 的正则按 UTF-16 单元走,落单的代理项就是一个普通的字;PCRE2 见到不合法的 UTF-16
/// 整串不匹配。匹配在换过的串上做、要原文的地方按下标回原串取——用到的正则都不认识私用区的字
QString jsMaskLoneSurrogates(const QString& s);
/// JS 正则里 `\s` 认的那一组字符,写成能放进 QRegularExpression 方括号里的样子(PCRE 的 \s 只认 ASCII)
const QString& jsSpaceClassBody();
/// String.prototype.trim():去掉两头 JS 认的空白与行终结符(比 QString::trimmed 少 U+0085、多 U+FEFF)
QString jsTrim(const QString& s);
/// fs.readFileSync(p, "utf-8"):开头的 BOM 留成 U+FEFF(QString::fromUtf8 会悄悄吞掉它,JSON.parse 见到它是要报错的)
QString nodeUtf8(const QByteArray& bytes);
/// Node 把 JS 字符串编成 UTF-8 的样子(Buffer.from(s)、better-sqlite3 绑定文本、writeFileSync):落单的代理项写成 U+FFFD。
/// QString::toUtf8 会把它悄悄丢掉
QByteArray toNodeUtf8(const QString& s);
/// Date.parse(s):V8 的完整读法(util/intel_dateparse 的 v8DateParse),ISO 之外的老写法、顺延的日子、越界偏移都与 V8 相同;
/// 认不出是 NaN。local 缺省 = 进程的本机时区
double jsDateParse(const QString& s, const QTimeZone& local);
double jsDateParse(const QString& s);

}  // namespace ibkr::util
