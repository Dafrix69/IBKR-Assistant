// @stdlib/math-base-special-erf 0.2.6 与它用的 @stdlib/math-base-special-exp、ldexp(Apache-2.0,源自 FreeBSD msun 的 s_erf.c / e_exp.c)。
// 逐句照 lib/main.js 写:多项式按它生成的 evalpoly 的括号次序算,一步一舍(全局 -ffp-contract=off)。
#include "util/jsmath.h"

#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>

namespace ibkr::util::jsmath {

namespace {
constexpr double kPInf = std::numeric_limits<double>::infinity();

std::uint64_t bitsOf(double x) {
    std::uint64_t u;
    std::memcpy(&u, &x, 8);
    return u;
}
double fromBits(std::uint64_t u) {
    double x;
    std::memcpy(&x, &u, 8);
    return x;
}

// ---- @stdlib/math-base-special-ldexp
double ldexp(double frac, double e) {
    if (e == 0 || frac == 0.0 || std::isnan(frac) || std::isinf(frac)) return frac;
    // normalize:次正规数先放大 2^52
    double exp = e;
    if (std::fabs(frac) < 2.2250738585072014e-308) {
        frac *= 4503599627370496.0;
        exp += -52;
    }
    exp += double(int((bitsOf(frac) >> 52) & 0x7ff) - 1023);  // float64-base-exponent
    if (exp < -1074) return std::copysign(0.0, frac);
    if (exp > 1023) return frac < 0.0 ? -kPInf : kPInf;
    double m = 1.0;
    if (exp <= -1023) {
        exp += 52;
        m = 2.220446049250313e-16;
    }
    std::uint64_t u = bitsOf(frac);
    std::uint32_t high = std::uint32_t(u >> 32), low = std::uint32_t(u);
    high &= 0x800fffffu;
    high |= std::uint32_t(int(exp) + 1023) << 20;
    return m * fromBits((std::uint64_t(high) << 32) | low);
}

double polyvalP(double x) {
    if (x == 0.0) return 0.16666666666666602;
    return 0.16666666666666602 + (x * (-0.0027777777777015593 + (x * (0.00006613756321437934 + (x * (-0.0000016533902205465252 + (x * 4.1381367970572385e-8)))))));
}
double expmulti(double hi, double lo, double k) {
    const double r = hi - lo;
    const double t = r * r;
    const double c = r - (t * polyvalP(t));
    const double y = 1.0 - (lo - ((r * c) / (2.0 - c)) - hi);
    return ldexp(y, k);
}

double polyvalPP(double x) {
    if (x == 0.0) return -0.3250421072470015;
    return -0.3250421072470015 + (x * (-0.02848174957559851 + (x * (-0.005770270296489442 + (x * -0.000023763016656650163)))));
}
double polyvalQQ(double x) {
    if (x == 0.0) return 0.39791722395915535;
    return 0.39791722395915535 + (x * (0.0650222499887673 + (x * (0.005081306281875766 + (x * (0.00013249473800432164 + (x * -0.000003960228278775368)))))));
}
double polyvalPA(double x) {
    if (x == 0.0) return 0.41485611868374833;
    return 0.41485611868374833 + (x * (-0.3722078760357013 + (x * (0.31834661990116175 + (x * (-0.11089469428239668 + (x * (0.035478304325618236 + (x * -0.002166375594868791)))))))));
}
double polyvalQA(double x) {
    if (x == 0.0) return 0.10642088040084423;
    return 0.10642088040084423 + (x * (0.540397917702171 + (x * (0.07182865441419627 + (x * (0.12617121980876164 + (x * (0.01363708391202905 + (x * 0.011984499846799107)))))))));
}
double polyvalRA(double x) {
    if (x == 0.0) return -0.6938585727071818;
    return -0.6938585727071818 + (x * (-10.558626225323291 + (x * (-62.375332450326006 + (x * (-162.39666946257347 + (x * (-184.60509290671104 + (x * (-81.2874355063066 + (x * -9.814329344169145)))))))))));
}
double polyvalRB(double x) {
    if (x == 0.0) return -0.799283237680523;
    return -0.799283237680523 + (x * (-17.757954917754752 + (x * (-160.63638485582192 + (x * (-637.5664433683896 + (x * (-1025.0951316110772 + (x * -483.5191916086514)))))))));
}
double polyvalSA(double x) {
    if (x == 0.0) return 19.651271667439257;
    return 19.651271667439257 + (x * (137.65775414351904 + (x * (434.56587747522923 + (x * (645.3872717332679 + (x * (429.00814002756783 + (x * (108.63500554177944 + (x * (6.570249770319282 + (x * -0.0604244152148581)))))))))))));
}
double polyvalSB(double x) {
    if (x == 0.0) return 30.33806074348246;
    return 30.33806074348246 + (x * (325.7925129965739 + (x * (1536.729586084437 + (x * (3199.8582195085955 + (x * (2553.0504064331644 + (x * (474.52854120695537 + (x * -22.44095244658582)))))))))));
}
}  // namespace

double stdlibExp(double x) {
    constexpr double kLn2Hi = 6.93147180369123816490e-01, kLn2Lo = 1.90821492927058770002e-10, kLog2E = 1.44269504088896338700e+00;
    constexpr double kOverflow = 7.09782712893383973096e+02, kUnderflow = -7.45133219101941108420e+02;
    constexpr double kNearZero = 1.0 / double(1 << 28);
    if (std::isnan(x) || x == kPInf) return x;
    if (x == -kPInf) return 0.0;
    if (x > kOverflow) return kPInf;
    if (x < kUnderflow) return 0.0;
    if (x > -kNearZero && x < kNearZero) return 1.0 + x;
    const double k = x < 0.0 ? std::trunc((kLog2E * x) - 0.5) : std::trunc((kLog2E * x) + 0.5);
    const double hi = x - (k * kLn2Hi);
    const double lo = k * kLn2Lo;
    return expmulti(hi, lo, k);
}

double stdlibErf(double x) {
    constexpr double kTiny = 1.0e-300, kVeryTiny = 2.848094538889218e-306, kSmall = 3.725290298461914e-9;
    constexpr double kErx = 8.45062911510467529297e-1, kEfx = 1.28379167095512586316e-1, kEfx8 = 1.02703333676410069053;
    constexpr double kPpc = 1.28379167095512558561e-1, kQqc = 1.0, kPac = -2.36211856075265944077e-3, kQac = 1.0;
    constexpr double kRac = -9.86494403484714822705e-3, kSac = 1.0, kRbc = -9.86494292470009928597e-3, kSbc = 1.0;
    if (std::isnan(x)) return NAN;
    if (x == kPInf) return 1.0;
    if (x == -kPInf) return -1.0;
    if (x == 0.0) return x;
    const bool sign = x < 0.0;
    const double ax = sign ? -x : x;
    if (ax < 0.84375) {
        if (ax < kSmall) {
            if (ax < kVeryTiny) return 0.125 * ((8.0 * x) + (kEfx8 * x));
            return x + (kEfx * x);
        }
        const double z = x * x;
        const double r = kPpc + (z * polyvalPP(z));
        const double s = kQqc + (z * polyvalQQ(z));
        const double y = r / s;
        return x + (x * y);
    }
    if (ax < 1.25) {
        const double s = ax - 1.0;
        const double p = kPac + (s * polyvalPA(s));
        const double q = kQac + (s * polyvalQA(s));
        return sign ? -kErx - (p / q) : kErx + (p / q);
    }
    if (ax >= 6.0) return sign ? kTiny - 1.0 : 1.0 - kTiny;
    double s = 1.0 / (ax * ax);
    double r;
    if (ax < 2.857142857142857) {
        r = kRac + (s * polyvalRA(s));
        s = kSac + (s * polyvalSA(s));
    } else {
        r = kRbc + (s * polyvalRB(s));
        s = kSbc + (s * polyvalSB(s));
    }
    const double z = fromBits(bitsOf(ax) & 0xffffffff00000000ull);  // setLowWord(ax, 0)
    r = stdlibExp(-(z * z) - 0.5625) * stdlibExp(((z - ax) * (z + ax)) + (r / s));
    return sign ? (r / ax) - 1.0 : 1.0 - (r / ax);
}

}  // namespace ibkr::util::jsmath
