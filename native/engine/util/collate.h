// String.prototype.localeCompare(没给 locales):ICU 按进程的默认区域排。装好的应用由访达拉起、环境里没有 LANG,
// TS 引擎跑在 en-US(ICU 的 en_US_POSIX 落到 en 的规则)上;这里固定用 en-US 的 ICU 排序(Homebrew 的 Qt 是带 ICU 编的)。
// 汉字在 en 下按码位的隐含权重排,不按拼音——和 zh 区域不一样,所以不能跟着本机的区域走。
#pragma once

#include <QString>

namespace ibkr::util {

/// a.localeCompare(b) 的正负号
int localeCompare(const QString& a, const QString& b);

}  // namespace ibkr::util
