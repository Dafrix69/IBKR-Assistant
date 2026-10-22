#include "orchestrate/heartbeat.h"

#include "orchestrate/engine_ports.h"
#include "orchestrate/engine_time.h"
#include "util/jsformat.h"
#include "util/jsvalue.h"
#include "util/tz.h"

#include <algorithm>
#include <cmath>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;

namespace ibkr::orchestrate {

OJson heartbeatOf(const OJson& s) {
    // const age = s["last_at"] ? Date.now() - Date.parse(String(s["last_at"])) : null;
    OJson age = js::Null();
    if (js::truthy(js::prop(&s, u"last_at"_s))) age = js::N(nowMs() - util::jsDateParse(js::str(js::prop(&s, u"last_at"_s))));
    const auto field = [&](const QString& k) { return js::copyOrNull(js::prop(&s, k)); };
    // 对象字面量里 undefined 的值 JSON.stringify 会丢掉键:这里 s 里缺的格子(running、interval_ms……)也就不出现
    OJson out = js::object();
    const auto put = [&](const QString& key, const QString& from) {
        if (const OJson* v = js::prop(&s, from)) out.set(key, *v);
    };
    put(u"running"_s, u"running"_s);
    put(u"interval_ms"_s, u"interval_ms"_s);
    put(u"ticks"_s, u"ticks"_s);
    put(u"slow_ticks"_s, u"slow_ticks"_s);
    put(u"last_ms"_s, u"last_ms"_s);
    put(u"max_ms"_s, u"max_ms"_s);
    out.set(u"age_ms"_s, age);
    put(u"last_error"_s, u"last_error"_s);
    out.set(u"event_loop_last_ms"_s, js::nullish(js::prop(&s, u"lag_last_ms"_s)) ? js::Null() : field(u"lag_last_ms"_s));
    out.set(u"event_loop_worst_ms"_s, js::nullish(js::prop(&s, u"lag_worst_ms"_s)) ? js::Null() : field(u"lag_worst_ms"_s));
    out.set(u"hold"_s, js::S(js::strOr(js::prop(&s, u"hold"_s), QString())));
    out.set(u"live_tracks"_s, js::N(jsx::numOr(js::prop(&s, u"live_tracks"_s), 0)));
    return out;
}

void LoopMeter::record(OJson& state, double t0, double slowMs) const {
    const double ms = nowMs() - t0;
    if (started_ && lagSource_) {
        const double max = lagSource_();
        const double lag = std::isfinite(max) ? util::jsRound(max / 1e6) : 0;
        state.set(u"lag_last_ms"_s, js::N(lag));
        state.set(u"lag_worst_ms"_s, js::N(jsx::max(jsx::numOr(js::prop(&state, u"lag_worst_ms"_s), 0), lag)));
    }
    state.set(u"ticks"_s, js::N(js::num(js::prop(&state, u"ticks"_s)) + 1));
    state.set(u"last_at"_s, js::S(util::isoString(nowMs())));
    state.set(u"last_ms"_s, js::N(ms));
    state.set(u"max_ms"_s, js::N(jsx::max(js::num(js::prop(&state, u"max_ms"_s)), ms)));
    if (ms > slowMs) state.set(u"slow_ticks"_s, js::N(js::num(js::prop(&state, u"slow_ticks"_s)) + 1));
}

}  // namespace ibkr::orchestrate
