// JavaScript 的数与字符串之间的那几个转换,逐条照 ECMAScript 规范(Number.prototype.toFixed / toExponential、Number::toString、
// StringToNumber、Math.round)。
//
// 为什么要照抄:引擎里每一句给人看的话、每一个黄金基线里的数都是 TS 版用这几个函数写出来的(py.ts 的 Python 式舍入
// 还要靠 toFixed 展开到 55 位以上去认"正好一半")。C++ 自带的 printf / QString::number 在一半处的取舍、位数上限、
// 指数的写法都不一样,对拍就对不上。
//
// 做法:double 是一个有限的二进制小数 m × 2^e,它的十进制展开也是有限的(最多 ~1075 位小数),这里用一个小小的大整数把它
// 精确展开(m × 5^k / 10^k),再按规范在十进制上取舍——不经过任何会舍入的浮点运算。期望值由 node 现算(tests/fixtures/gen_jsformat.mjs)。
#pragma once

#include <QString>
#include <QStringView>

namespace ibkr::util {

/// 一个有限 double 的精确十进制展开:negative、整数部分(没有前导 0,0 写成 "0")、小数部分(没有尾随 0,可以是空)
struct ExactDecimal {
    bool negative = false;
    QString integer;
    QString fraction;
};
/// x 必须有限;-0 的 negative 是 true
ExactDecimal exactDecimal(double x);

/// Number.prototype.toString():最短的、读得回同一个数的写法(1e21 起、1e-7 以下用指数)
QString jsNumberToString(double x);
/// Number.prototype.toFixed(digits),digits 0–100:正好一半时取大的那个;|x| ≥ 1e21 时就是 String(x);x < 0 带负号(哪怕舍成 0)
QString jsToFixed(double x, int digits);
/// Number.prototype.toExponential(digits),digits 0–100:正好一半时取大的那个
QString jsToExponential(double x, int digits);
/// toExponential() 不给位数:最短的那串数字
QString jsToExponentialShortest(double x);
/// Math.round:正好一半往 +∞ 走;(-0.5, 0) 与 -0 得 -0
double jsRound(double x);
/// Number(string):整串都得是一个数(去掉两头的 JS 空白;"" 是 0;0x / 0o / 0b;Infinity);不然是 NaN
double jsStringToNumber(QStringView s);

}  // namespace ibkr::util
