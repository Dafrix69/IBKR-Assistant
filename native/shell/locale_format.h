// 数字的千分位写法(JS 的 toLocaleString('en-US')),界面几处共用。
#pragma once

#include <QString>

namespace ibkr::shell {

/// n.toLocaleString('en-US', { maximumFractionDigits }):千分位、最多几位小数(从最短的十进制数字起四舍五入,中点远离零,同 ICU)
QString formatEnUs(double n, int maxFractionDigits);

}  // namespace ibkr::shell
