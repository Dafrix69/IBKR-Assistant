// JavaScript 的 parseInt / parseFloat,逐个照它们的规矩来。
//
// 为什么要照抄 JS:TS 引擎读 TWS 报文里的数全靠这两个函数(@stoqey/ib 的 readInt / readDouble / readDecimal),
// 它们很宽松——" 12abc" 读成 12、"1,000" 读成 1、读不出来是 NaN 而不是报错。C++ 引擎要和 TS 引擎对拍,
// 同一格字节就得读出同一个数,所以这里不用 QString::toDouble 那种"整串都得是数"的读法。
// 对着的答案在 tests/fixtures/stoqey-v193.json 的 jsnum 一节(node 现算的),不是凭记忆写的。
#pragma once

#include <QStringView>

namespace ibkr::util {

/// parseInt(s, radix):跳过开头的空白,可选正负号,然后读尽量长的一串数字;一个数字都没有就是 NaN。
/// radix 只支持 10 与 16(16 时认 0x 前缀)。超过 2^53 的整数和 JS 一样会丢精度(结果是 double)。
double jsParseInt(QStringView s, int radix = 10);

/// parseFloat(s):跳过开头的空白,读尽量长的一段十进制数(含小数点、指数、Infinity);读不出是 NaN。
/// 溢出是 ±Infinity,下溢是 0,和 JS 一样。
double jsParseFloat(QStringView s);

/// JS 认的空白(StrWhiteSpaceChar):比 QChar::isSpace 少一个 U+0085,多一个 U+FEFF。
bool isJsWhitespace(QChar c);

}  // namespace ibkr::util
