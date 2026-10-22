// Python 兼容的数值格式化与舍入(engine-ts/src/py.ts 逐句搬)。
// 对拍的地基:Python 的 round() 是十进制正确舍入(平分取偶),str(float) 对整数值带 ".0","%g" 是 6 位有效数字——
// 黄金基线里的每一条 message / readout 都靠它们逐字节一致。TS 版是用 JS 的 toFixed / toExponential 拼出来的,
// 这里照着同一条路走(util/jsformat 是那几个 JS 函数的精确实现),不改用 C 的 printf。期望值:tests/fixtures/gen_py.mjs。
#pragma once

#include <QJsonValue>
#include <QString>

#include <optional>

namespace ibkr::util {

/// Python round(x, nd),nd ≥ 0:十进制正确舍入,正好一半时取偶
double pyRound(double x, int nd = 0);
/// "%.Nf"(平分取偶;负数舍成 0 时带负号)
QString fmtF(double x, int nd);
/// "%+.Nf"
QString fmtSF(double x, int nd);
/// "%g":6 位有效数字,去尾零,指数 < -4 或 ≥ 6 时写成科学计数
QString pyG(double v);
/// Python str(float):整数值带 ".0",指数至少两位
QString pyFloat(double v);
/// Python repr():字符串单引号(含单引号不含双引号时用双引号)、None / True / False、数按 pyFloat(整数值写成整数)
QString pyRepr(const QJsonValue& v);
/// "%d":向零取整
QString fmtD(double x);
/// Python 的真假:0 / "" / [] / null / false 是假,NaN 是真
bool truthy(const QJsonValue& v);
/// 有限的数;null、布尔、读不出、无穷都回空
std::optional<double> finiteOrNull(const QJsonValue& v);

}  // namespace ibkr::util
