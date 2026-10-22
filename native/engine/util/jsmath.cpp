// fdlibm(Sun Microsystems,1993;"Permission to use, copy, modify, and distribute this software is freely granted,
// provided that this notice is preserved")经 FreeBSD msun 与 V8 的 ieee754.cc 传下来的那几个函数,逐行照搬,只改了取高低位的写法。
#include "util/jsmath.h"

#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>

namespace ibkr::util::jsmath {

namespace {

inline void extract(double d, int32_t& hi, uint32_t& lo) {
    uint64_t u;
    std::memcpy(&u, &d, 8);
    hi = int32_t(u >> 32);
    lo = uint32_t(u);
}
inline int32_t highWord(double d) {
    uint64_t u;
    std::memcpy(&u, &d, 8);
    return int32_t(u >> 32);
}
inline uint32_t lowWord(double d) {
    uint64_t u;
    std::memcpy(&u, &d, 8);
    return uint32_t(u);
}
inline double insert(int32_t hi, uint32_t lo) {
    const uint64_t u = (uint64_t(uint32_t(hi)) << 32) | lo;
    double d;
    std::memcpy(&d, &u, 8);
    return d;
}
inline double setHigh(double d, int32_t hi) { return insert(hi, lowWord(d)); }
inline double setLow(double d, uint32_t lo) { return insert(highWord(d), lo); }

// ---------------------------------------------------------------- e_log.c
constexpr double ln2_hi = 6.93147180369123816490e-01, ln2_lo = 1.90821492927058770002e-10, two54 = 1.80143985094819840000e+16,
                 Lg1 = 6.666666666666735130e-01, Lg2 = 3.999999999940941908e-01, Lg3 = 2.857142874366239149e-01, Lg4 = 2.222219843214978396e-01,
                 Lg5 = 1.818357216161805012e-01, Lg6 = 1.531383769920937332e-01, Lg7 = 1.479819860511658591e-01;

// ---------------------------------------------------------------- k_log.h(log2 / log10 用)
inline double k_log1p(double f) {
    const double s = f / (2.0 + f), z = s * s, w = z * z;
    const double t1 = w * (Lg2 + w * (Lg4 + w * Lg6)), t2 = z * (Lg1 + w * (Lg3 + w * (Lg5 + w * Lg7)));
    const double R = t2 + t1, hfsq = 0.5 * f * f;
    return s * (hfsq + R);
}

}  // namespace

double log(double x) {
    double hfsq, f, s, z, R, w, t1, t2, dk;
    int32_t k, hx, i, j;
    uint32_t lx;
    extract(x, hx, lx);
    k = 0;
    if (hx < 0x00100000) {                                   // x < 2**-1022
        if (((hx & 0x7fffffff) | int32_t(lx)) == 0) return -two54 / 0.0;  // log(+-0)=-inf
        if (hx < 0) return (x - x) / 0.0;                    // log(-#) = NaN
        k -= 54;
        x *= two54;  // subnormal number, scale up x
        hx = highWord(x);
    }
    if (hx >= 0x7ff00000) return x + x;
    k += (hx >> 20) - 1023;
    hx &= 0x000fffff;
    i = (hx + 0x95f64) & 0x100000;
    x = setHigh(x, hx | (i ^ 0x3ff00000));  // normalize x or x/2
    k += (i >> 20);
    f = x - 1.0;
    if ((0x000fffff & (2 + hx)) < 3) {  // -2**-20 <= f < 2**-20
        if (f == 0.0) {
            if (k == 0) return 0.0;
            dk = double(k);
            return dk * ln2_hi + dk * ln2_lo;
        }
        R = f * f * (0.5 - 0.33333333333333333 * f);
        if (k == 0) return f - R;
        dk = double(k);
        return dk * ln2_hi - ((R - dk * ln2_lo) - f);
    }
    s = f / (2.0 + f);
    dk = double(k);
    z = s * s;
    i = hx - 0x6147a;
    w = z * z;
    j = 0x6b851 - hx;
    t1 = w * (Lg2 + w * (Lg4 + w * Lg6));
    t2 = z * (Lg1 + w * (Lg3 + w * (Lg5 + w * Lg7)));
    i |= j;
    R = t2 + t1;
    if (i > 0) {
        hfsq = 0.5 * f * f;
        if (k == 0) return f - (hfsq - s * (hfsq + R));
        return dk * ln2_hi - ((hfsq - (s * (hfsq + R) + dk * ln2_lo)) - f);
    }
    if (k == 0) return f - s * (f - R);
    return dk * ln2_hi - ((s * (f - R) - dk * ln2_lo) - f);
}

// ---------------------------------------------------------------- e_exp.c
double exp(double x) {
    static const double one = 1.0, halF[2] = {0.5, -0.5}, o_threshold = 7.09782712893383973096e+02, u_threshold = -7.45133219101941108420e+02,
                        ln2HI[2] = {6.93147180369123816490e-01, -6.93147180369123816490e-01}, ln2LO[2] = {1.90821492927058770002e-10, -1.90821492927058770002e-10},
                        invln2 = 1.44269504088896338700e+00, P1 = 1.66666666666666019037e-01, P2 = -2.77777777770155933842e-03, P3 = 6.61375632143793436117e-05,
                        P4 = -1.65339022054652515390e-06, P5 = 4.13813679705723846039e-08, E = 2.718281828459045, huge = 1.0e+300, twom1000 = 9.33263618503218878990e-302,
                        two1023 = 8.988465674311579539e307;
    double y, hi = 0.0, lo = 0.0, c, t, twopk;
    int32_t k = 0, xsb;
    uint32_t hx;
    hx = uint32_t(highWord(x));
    xsb = int32_t((hx >> 31) & 1);  // sign bit of x
    hx &= 0x7fffffff;               // high word of |x|
    // filter out non-finite argument
    if (hx >= 0x40862E42) {  // if |x|>=709.78...
        if (hx >= 0x7ff00000) {
            const uint32_t lx = lowWord(x);
            if (((hx & 0xfffff) | lx) != 0) return x + x;  // NaN
            return (xsb == 0) ? x : 0.0;                    // exp(+-inf)={inf,0}
        }
        if (x > o_threshold) return huge * huge;          // overflow
        if (x < u_threshold) return twom1000 * twom1000;  // underflow
    }
    // argument reduction
    if (hx > 0x3fd62e42) {    // if  |x| > 0.5 ln2
        if (hx < 0x3FF0A2B2) {  // and |x| < 1.5 ln2
            if (x == 1.0) return E;
            hi = x - ln2HI[xsb];
            lo = ln2LO[xsb];
            k = 1 - xsb - xsb;
        } else {
            k = int32_t(invln2 * x + halF[xsb]);
            t = k;
            hi = x - t * ln2HI[0];  // t*ln2HI is exact here
            lo = t * ln2LO[0];
        }
        x = hi - lo;
    } else if (hx < 0x3e300000) {  // when |x|<2**-28
        if (huge + x > one) return one + x;  // trigger inexact
    } else {
        k = 0;
    }
    // x is now in primary range
    t = x * x;
    if (k >= -1021) twopk = insert(int32_t(0x3ff00000 + (k << 20)), 0);
    else twopk = insert(int32_t(0x3ff00000 + ((k + 1000) << 20)), 0);
    c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
    if (k == 0) return one - ((x * c) / (c - 2.0) - x);
    y = one - ((lo - (x * c) / (2.0 - c)) - hi);
    if (k >= -1021) {
        if (k == 1024) return y * 2.0 * two1023;
        return y * twopk;
    }
    return y * twopk * twom1000;
}

// ---------------------------------------------------------------- e_log10.c(fdlibm 原版,V8 用的这一份)
double log10(double x) {
    static const double two54_ = 1.80143985094819840000e+16, ivln10 = 4.34294481903251816668e-01, log10_2hi = 3.01029995663611771306e-01,
                        log10_2lo = 3.69423907715893078616e-13;
    double y, z;
    int32_t i, k, hx;
    uint32_t lx;
    extract(x, hx, lx);
    k = 0;
    if (hx < 0x00100000) {  // x < 2**-1022
        if (((hx & 0x7fffffff) | int32_t(lx)) == 0) return -two54_ / 0.0;  // log(+-0)=-inf
        if (hx < 0) return (x - x) / 0.0;                                     // log(-#) = NaN
        k -= 54;
        x *= two54_;  // subnormal number, scale up x
        hx = highWord(x);
    }
    if (hx >= 0x7ff00000) return x + x;
    k += (hx >> 20) - 1023;
    i = int32_t((uint32_t(k) & 0x80000000) >> 31);
    hx = (hx & 0x000fffff) | ((0x3ff - i) << 20);
    y = double(k + i);
    x = setHigh(x, hx);
    z = y * log10_2lo + ivln10 * log(x);
    return z + y * log10_2hi;
}

// ---------------------------------------------------------------- e_log2.c(FreeBSD 版)
double log2(double x) {
    static const double two54_ = 1.80143985094819840000e+16, ivln2hi = 1.44269504072144627571e+00, ivln2lo = 1.67517131648865118353e-10;
    double f, hfsq, hi, lo, r, val_hi, val_lo, w, y;
    int32_t i, k, hx;
    uint32_t lx;
    extract(x, hx, lx);
    k = 0;
    if (hx < 0x00100000) {  // x < 2**-1022
        if (((hx & 0x7fffffff) | int32_t(lx)) == 0) return -two54_ / 0.0;
        if (hx < 0) return (x - x) / 0.0;
        k -= 54;
        x *= two54_;
        hx = highWord(x);
    }
    if (hx >= 0x7ff00000) return x + x;
    if (hx == 0x3ff00000 && lx == 0) return 0;
    k += (hx >> 20) - 1023;
    hx &= 0x000fffff;
    i = (hx + 0x95f64) & 0x100000;
    x = setHigh(x, hx | (i ^ 0x3ff00000));
    k += (i >> 20);
    y = double(k);
    f = x - 1.0;
    hfsq = 0.5 * f * f;
    r = k_log1p(f);
    hi = f - hfsq;
    hi = setLow(hi, 0);
    lo = (f - hi) - hfsq + r;
    val_hi = hi * ivln2hi;
    val_lo = (lo + hi) * ivln2lo + lo * ivln2hi;
    w = y + val_hi;
    val_lo += (y - w) + val_hi;
    val_hi = w;
    return val_lo + val_hi;
}

// ---------------------------------------------------------------- s_atan.c
double atan(double x) {
    static const double atanhi[] = {4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00};
    static const double atanlo[] = {2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17};
    static const double aT[] = {3.33333333333329318027e-01,  -1.99999999998764832476e-01, 1.42857142725034663711e-01,  -1.11111104054623557880e-01,
                                9.09088713343650656196e-02,  -7.69187620504482999495e-02, 6.66107313738753120669e-02,  -5.83357013379057348645e-02,
                                4.97687799461593236017e-02,  -3.65315727442169155270e-02, 1.62858201153657823623e-02};
    static const double one = 1.0, huge = 1.0e300;
    double w, s1, s2, z;
    int32_t ix, hx, id;
    hx = highWord(x);
    ix = hx & 0x7fffffff;
    if (ix >= 0x44100000) {  // if |x| >= 2^66
        const uint32_t low = lowWord(x);
        if (ix > 0x7ff00000 || (ix == 0x7ff00000 && (low != 0))) return x + x;  // NaN
        if (hx > 0) return atanhi[3] + *(volatile const double*)&atanlo[3];
        return -atanhi[3] - *(volatile const double*)&atanlo[3];
    }
    if (ix < 0x3fdc0000) {    // |x| < 0.4375
        if (ix < 0x3e400000) {  // |x| < 2^-27
            if (huge + x > one) return x;  // raise inexact
        }
        id = -1;
    } else {
        x = std::fabs(x);
        if (ix < 0x3ff30000) {    // |x| < 1.1875
            if (ix < 0x3fe60000) {  // 7/16 <=|x|<11/16
                id = 0;
                x = (2.0 * x - one) / (2.0 + x);
            } else {  // 11/16<=|x|< 19/16
                id = 1;
                x = (x - one) / (x + one);
            }
        } else {
            if (ix < 0x40038000) {  // |x| < 2.4375
                id = 2;
                x = (x - 1.5) / (one + 1.5 * x);
            } else {  // 2.4375 <= |x| < 2^66
                id = 3;
                x = -1.0 / x;
            }
        }
    }
    // end of argument reduction
    z = x * x;
    w = z * z;
    // break sum from i=0 to 10 aT[i]z**(i+1) into odd and even poly
    s1 = z * (aT[0] + w * (aT[2] + w * (aT[4] + w * (aT[6] + w * (aT[8] + w * aT[10])))));
    s2 = w * (aT[1] + w * (aT[3] + w * (aT[5] + w * (aT[7] + w * aT[9]))));
    if (id < 0) return x - x * (s1 + s2);
    z = atanhi[id] - ((x * (s1 + s2) - atanlo[id]) - x);
    return (hx < 0) ? -z : z;
}

// ---------------------------------------------------------------- k_sin.c / k_cos.c / e_rem_pio2.c
namespace {
double kernelSin(double x, double y, int iy) {
    static const double half = 5.00000000000000000000e-01, S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03, S3 = -1.98412698298579493134e-04,
                        S4 = 2.75573137070700676789e-06, S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
    double z, r, v;
    int32_t ix = highWord(x) & 0x7fffffff;
    if (ix < 0x3e400000) {  // |x| < 2**-27
        if (int(x) == 0) return x;  // generate inexact
    }
    z = x * x;
    v = z * x;
    r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
    if (iy == 0) return x + v * (S1 + z * r);
    return x - ((z * (half * y - v * r) - y) - v * S1);
}

double kernelCos(double x, double y) {
    static const double one = 1.0, C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03, C3 = 2.48015872894767294178e-05,
                        C4 = -2.75573143513906633035e-07, C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;
    double a, iz, z, r, qx;
    int32_t ix = highWord(x) & 0x7fffffff;
    if (ix < 0x3e400000) {  // if x < 2**27
        if (int(x) == 0) return one;  // generate inexact
    }
    z = x * x;
    r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
    if (ix < 0x3FD33333) return one - (0.5 * z - (z * r - x * y));  // if |x| < 0.3
    if (ix > 0x3fe90000) qx = 0.28125;  // x > 0.78125
    else qx = insert(ix - 0x00200000, 0);  // x/4
    iz = 0.5 * z - qx;
    a = one - qx;
    return a - (iz - (z * r - x * y));
}

/// 只做到 |x| < 2^20·π/2 的那一段(引擎里 sin / cos 的参数都很小);更大的交给 libm 的(那里不保证和 V8 逐位一样)
int remPio2(double x, double* y) {
    static const double zero = 0.0, half = 0.5, two24 = 1.67772160000000000000e+07, invpio2 = 6.36619772367581382433e-01, pio2_1 = 1.57079632673412561417e+00,
                        pio2_1t = 6.07710050650619224932e-11, pio2_2 = 6.07710050630396597660e-11, pio2_2t = 2.02226624879595063154e-21,
                        pio2_3 = 2.02226624871116645580e-21, pio2_3t = 8.47842766036889956997e-32;
    double z = 0, w, t, r, fn;
    int32_t i, j, n, ix, hx;
    hx = highWord(x);
    ix = hx & 0x7fffffff;
    if (ix <= 0x3fe921fb) {  // |x| ~<= pi/4 , no need for reduction
        y[0] = x;
        y[1] = 0;
        return 0;
    }
    if (ix < 0x4002d97c) {  // |x| < 3pi/4, special case with n=+-1
        if (hx > 0) {
            z = x - pio2_1;
            if (ix != 0x3ff921fb) {  // 33+53 bit pi is good enough
                y[0] = z - pio2_1t;
                y[1] = (z - y[0]) - pio2_1t;
            } else {  // near pi/2, use 33+33+53 bit pi
                z -= pio2_2;
                y[0] = z - pio2_2t;
                y[1] = (z - y[0]) - pio2_2t;
            }
            return 1;
        }
        z = x + pio2_1;
        if (ix != 0x3ff921fb) {
            y[0] = z + pio2_1t;
            y[1] = (z - y[0]) + pio2_1t;
        } else {
            z += pio2_2;
            y[0] = z + pio2_2t;
            y[1] = (z - y[0]) + pio2_2t;
        }
        return -1;
    }
    if (ix <= 0x413921fb) {  // |x| ~<= 2^19*(pi/2), medium size
        t = std::fabs(x);
        n = int32_t(t * invpio2 + half);
        fn = double(n);
        r = t - fn * pio2_1;
        w = fn * pio2_1t;  // 1st round good to 85 bit
        j = ix >> 20;
        y[0] = r - w;
        i = j - ((highWord(y[0]) >> 20) & 0x7ff);
        if (i > 16) {  // 2nd iteration needed, good to 118
            t = r;
            w = fn * pio2_2;
            r = t - w;
            w = fn * pio2_2t - ((t - r) - w);
            y[0] = r - w;
            i = j - ((highWord(y[0]) >> 20) & 0x7ff);
            if (i > 49) {  // 3rd iteration need, 151 bits acc
                t = r;
                w = fn * pio2_3;
                r = t - w;
                w = fn * pio2_3t - ((t - r) - w);
                y[0] = r - w;
            }
        }
        y[1] = (r - y[0]) - w;
        if (hx < 0) {
            y[0] = -y[0];
            y[1] = -y[1];
            return -n;
        }
        return n;
    }
    (void)zero;
    (void)two24;
    return std::numeric_limits<int>::min();  // 大参数:调用方退回 libm
}
}  // namespace

double sin(double x) {
    double y[2], z = 0.0;
    const int32_t ix = highWord(x) & 0x7fffffff;
    if (ix <= 0x3fe921fb) return kernelSin(x, z, 0);  // |x| ~< pi/4
    if (ix >= 0x7ff00000) return x - x;              // sin(Inf or NaN) is NaN
    const int n = remPio2(x, y);
    if (n == std::numeric_limits<int>::min()) return std::sin(x);
    switch (n & 3) {
    case 0: return kernelSin(y[0], y[1], 1);
    case 1: return kernelCos(y[0], y[1]);
    case 2: return -kernelSin(y[0], y[1], 1);
    default: return -kernelCos(y[0], y[1]);
    }
}

double cos(double x) {
    double y[2], z = 0.0;
    const int32_t ix = highWord(x) & 0x7fffffff;
    if (ix <= 0x3fe921fb) return kernelCos(x, z);  // |x| ~< pi/4
    if (ix >= 0x7ff00000) return x - x;            // cos(Inf or NaN) is NaN
    const int n = remPio2(x, y);
    if (n == std::numeric_limits<int>::min()) return std::cos(x);
    switch (n & 3) {
    case 0: return kernelCos(y[0], y[1]);
    case 1: return -kernelSin(y[0], y[1], 1);
    case 2: return -kernelCos(y[0], y[1]);
    default: return kernelSin(y[0], y[1], 1);
    }
}

double pow(double x, double y) {
    // V8 src/numbers/ieee754.cc 的 math::pow(use_std_math_pow 一支):规范要的两种 NaN,再是优化编译器本来就不调 pow 的两种
    if (std::isnan(y)) return std::numeric_limits<double>::quiet_NaN();
    if (std::isinf(y) && (x == 1 || x == -1)) return std::numeric_limits<double>::quiet_NaN();
    if (std::isnan(x)) x = std::numeric_limits<double>::quiet_NaN();
    if (y == 2) return x * x;
    if (y == 0.5) {
        if (std::isinf(x)) return std::numeric_limits<double>::infinity();
        return std::sqrt(x + 0);  // +0:−0 的 0.5 次方是 +0
    }
    return std::pow(x, y);
}

}  // namespace ibkr::util::jsmath
