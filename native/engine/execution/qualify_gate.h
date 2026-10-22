// qualifyGate.ts 逐句搬:TWS 不回合约确认时,只读的取数别每次各等满一个超时。
// 按会话记、不按合约记:不回话的是 TWS,不是某一张合约。一次超时之后 kQualifyRetryMs 内,这条会话上只读的确认当场答"没回应",
// 不发请求;到了间隔只放一路去试探;回了话就清掉,只有超时才记;下单路径(wait = true)不受闸。期望值:tests/fixtures/gen_qualify_gate.mjs
//
// 与 TS 的对应与不同:
//   · TS 的 WeakMap<IbSession, number> → 按 weak_ptr 记(会话没了表项随之可清)。模块级的计数器与 stalledUntil 与 TS 一样是全局的。
//   · `now` 缺省 Date.now → util::dateNow()(测试用 setDateNowForTests 换)。
//   · isTimeout 里的 `exc.name === "TimeoutError"`:C++ 的异常没有 name,用 TimeoutError 这个类表达(ib_session 的确认超时抛的是话为 "timeout" 的错,走话那一支)。
//   · 计数是 TS 的 number,这里 int(一次取走之间不会超出)。
#pragma once

#include "execution/ib_types.h"
#include "util/error.h"
#include "util/task.h"

#include <exception>
#include <functional>
#include <memory>
#include <vector>

namespace ibkr::execution {

/// TWS 没回合约确认(超时)之后,隔多久再去确认一次(毫秒)
inline constexpr double kQualifyRetryMs = 30'000;

/// TS 里 `Object.assign(new Error(msg), { name: "TimeoutError" })` 的对应
class TimeoutError : public util::JsError {
public:
    using util::JsError::JsError;
};

struct QualifyGateStats {
    int timeouts = 0;  // 确认等满了超时
    int skipped = 0;   // 刚超时过,当场答"没回应"、没发请求
    int probes = 0;    // 到了间隔放出去的那一路试探
    bool operator==(const QualifyGateStats&) const = default;
};

/// 上次取走以来的计数,取完清零
QualifyGateStats takeQualifyGateStats();

/// 话里带 "timeout"(不分大小写)、或者是 TimeoutError
bool isTimeout(const std::exception_ptr& exc);

enum class QualifyAnswer { Ok, Stalled };

/// 确认一批合约。Stalled = TWS 没在时限内回话,或者刚超时过、这一次没轮到去试探;别的错照抛。
/// wait:true = 刚超时过也照样去问(下单路径)。now 空 = util::dateNow
Task<QualifyAnswer> qualifyGated(std::shared_ptr<IbSession> session, std::vector<IbContract*> contracts, int timeoutMs, bool wait,
                                 std::function<double()> now = {});

}  // namespace ibkr::execution
