// JS 的 Math.log / exp / log10 / log2 / sin / cos / atan:V8 用的是自己带的 fdlibm(src/base/ieee754.cc,源自 Sun 的 fdlibm 与 FreeBSD msun),
// 和系统的 libm 不是同一份——macOS 的 libm 在 exp 上约一成输入差 1 ulp。定价与统计算出来的数再经 toFixed / pyRound 写成字,
// 1 ulp 也可能在半分位上翻一个数字,所以引擎里凡是 TS 用 Math.* 的地方都用这里的。对的是装好的应用里跑 TS 引擎的那个 V8
// (Electron 自带的,按 Chromium 的配置编、不合成 FMA):log / exp / log10 / log2 / atan 逐位一致;sin / cos 那边走另一套 libm,
// 这里差得出一个末位(tests/tst_jsmath)。这个文件和引擎别的代码一样 -ffp-contract=off。
// Math.pow 与 `**` 用这里的 pow:V8 14 走系统 libm 的 std::pow,但先挡掉几种情况(指数 2 就是 x*x、0.5 就是 sqrt……,见 src/numbers/ieee754.cc);
// macOS 的 libm 在 pow(x, 2) 上约千分之一的输入和 x*x 差一个末位。sqrt 是硬件指令,直接用 std。
// 另有 @stdlib/math-base-special-erf(flyexit 的正态分布)和它自带的 exp:不是 Math.exp,是 stdlib 自己的一份 fdlibm,也搬在这里。
#pragma once

#include <cmath>

namespace ibkr::util::jsmath {

double log(double x);
double exp(double x);
double log10(double x);
double log2(double x);
double sin(double x);
double cos(double x);
double atan(double x);

/// Math.pow(x, y) / x ** y(V8 14.6 的 math::pow,--use-std-math-pow 默认开着的那一支)
double pow(double x, double y);

/// @stdlib/math-base-special-erf 0.2.6(Apache-2.0)
double stdlibErf(double x);
/// @stdlib/math-base-special-exp(erf 里用的那个)
double stdlibExp(double x);

/// Math.max / Math.min(两个数):有 NaN 就是 NaN;+0 与 −0 里 max 取 +0、min 取 −0
inline double max(double a, double b) {
    if (std::isnan(a) || std::isnan(b)) return NAN;
    if (a == 0 && b == 0) return std::signbit(a) ? b : a;
    return a > b ? a : b;
}
inline double min(double a, double b) {
    if (std::isnan(a) || std::isnan(b)) return NAN;
    if (a == 0 && b == 0) return std::signbit(a) ? a : b;
    return a < b ? a : b;
}

}  // namespace ibkr::util::jsmath
