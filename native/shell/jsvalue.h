// JS 的 Number() / String() / 真假 / toFixed …… 的实现搬到了引擎的 util(engine/util/jsvalue.h、jsformat.h),引擎与界面共用一份;
// 这里只把名字引进 ibkr::shell,界面这边的老代码照旧写 jsNumber(…)。
#pragma once

#include "util/jsformat.h"
#include "util/jsvalue.h"

namespace ibkr::shell {
using util::jsDateParse;
using util::jsNumber;
using util::jsNumberToString;
using util::jsonQuote;
using util::jsRound;
using util::jsString;
using util::jsToFixed;
using util::jsTrim;
using util::jsTruthy;
}  // namespace ibkr::shell
