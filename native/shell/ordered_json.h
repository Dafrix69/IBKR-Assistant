// 保序的 JSON 搬到了引擎的 util(engine/util/ordered_json.h),引擎与界面共用一份;这里只把名字引进 ibkr::shell。
#pragma once

#include "util/ordered_json.h"

namespace ibkr::shell {
using util::OJson;
using util::parseOJson;
using util::stringifyOJson;
}  // namespace ibkr::shell
