// market 组(maTouch / alerts / macro / leaders / market / signalOutcomes / anomaly)共用的几样 JS 行为。
//   · jsSort:Array.prototype.sort(comparefn)。V8 是 TimSort;比较函数前后一致时任何稳定排序结果都一样,
//     不一致时(比较函数回 NaN:`a.price - b.price` 里有 NaN 的价,V8 当 0 用)结果看算法。这里不到 64 个的照 V8 那一套走
//     (不到 8 个只做 BinaryInsertionSort,8 个起 CountAndMakeRun + BinaryInsertionSort,third_party/v8/builtins/array-sort.tq),64 个起用 std::stable_sort
//     (只在比较函数前后一致时与 V8 相同);
//   · shown:maTouch.ts / anomaly.ts 报错里那段「收到 …」(JSON.stringify ?? String,超过 40 个码元截断加 …);
//   · encodeURIComponent;
//   · onObjectPrototype:`k in {}` / `obj[k]` 在 Object.prototype 上找得到的名字。
#pragma once

#include "util/ordered_json.h"

#include <QString>

#include <algorithm>
#include <functional>
#include <vector>

namespace ibkr::util::market {

/// V8 的 sortState.Compare:比较函数的结果是 NaN 时当 0
inline double sortOrder(double v) { return v != v ? 0 : v; }

/// arr.sort(cmp),cmp 回 JS 的数(负 = a 在前)
template <class T, class Cmp>
void jsSort(std::vector<T>& v, Cmp cmp) {
    const auto n = static_cast<long long>(v.size());
    if (n < 2) return;
    if (n >= 64) {
        std::stable_sort(v.begin(), v.end(), [&](const T& a, const T& b) { return sortOrder(cmp(a, b)) < 0; });
        return;
    }
    // V8 14.6 ArrayTimSort:不到 8 个直接 BinaryInsertionSort(0, 0, n),不找自然顺段(array-sort.tq 1423–1427);8 个起先 CountAndMakeRun
    long long run = n < 8 ? 1 : 2;
    if (n >= 8) {
        const bool descending = sortOrder(cmp(v[1], v[0])) < 0;
        for (long long i = 2; i < n; ++i) {
            const double order = sortOrder(cmp(v[size_t(i)], v[size_t(i - 1)]));
            if (descending ? order >= 0 : order < 0) break;
            ++run;
        }
        if (descending) std::reverse(v.begin(), v.begin() + run);
    }
    // BinaryInsertionSort(0, run, n)
    for (long long start = run; start < n; ++start) {
        long long left = 0, right = start;
        T pivot = v[size_t(start)];
        while (left < right) {
            const long long mid = left + ((right - left) >> 1);
            if (sortOrder(cmp(pivot, v[size_t(mid)])) < 0) right = mid;
            else left = mid + 1;
        }
        for (long long p = start; p > left; --p) v[size_t(p)] = v[size_t(p - 1)];
        v[size_t(left)] = pivot;
    }
}

/// 数组按数从小到大(`(a, b) => a - b`)
void sortNumbers(std::vector<double>& v);

/// maTouch.ts / anomaly.ts 的 shown(v):串原样,别的 JSON.stringify(NaN、±∞ 是 null);超过 40 个码元截到 40 再加 …
QString shown(const OJson& v);

/// encodeURIComponent(落单的代理项照 UTF-8 编码时的 U+FFFD 处理——JS 在那里抛 URIError,引擎的调用方只给固定清单里的代码)
QString encodeURIComponent(const QString& s);

/// Object.prototype 上的名字(`k in {}` 成立的那些,含 __proto__)
bool onObjectPrototype(const QString& k);


/// String(x.slice(a, b)) 的下标:JS 的 Array.prototype.slice / String.prototype.slice 把负数从尾巴往回数、超出的截掉
struct SliceRange {
    long long from = 0, to = 0;
};
SliceRange sliceRange(long long length, double start, double end);
inline SliceRange sliceRange(long long length, double start) { return sliceRange(length, start, double(length)); }

}  // namespace ibkr::util::market
