#include "orchestrate/spot_stop.h"

#include "analysis/tracker_rules.h"
#include "util/jsobj.h"

#include <cmath>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;

namespace ibkr::orchestrate {

util::Task<std::optional<double>> stockSpot(SpotRouter& router, QString symbol) {
    try {
        if (!router.hasStreamQuotes()) {
            const std::optional<double> v = co_await router.indexPrice(symbol);
            co_return v && std::isfinite(*v) ? v : std::nullopt;
        }
        const OJson quotes = co_await router.streamQuotes(QStringList{symbol});
        const std::optional<double> last = js::finiteOrNull(js::path(&quotes, {symbol, u"last"_s}));
        co_return last && *last > 0 ? last : std::nullopt;
    } catch (...) {
        co_return std::nullopt;
    }
}

util::Task<UnderlyingSpot> underlyingSpot(SpotRouter& router, QString symbol, bool index) {
    if (!index) co_return UnderlyingSpot{co_await stockSpot(router, symbol), QString()};
    std::optional<double> spot;
    try {
        spot = co_await router.indexPrice(symbol);
    } catch (...) {
        spot = std::nullopt;
    }
    std::optional<OJson> info;
    if (router.hasSpotInfo()) info = router.spotInfo(symbol);
    if (info && js::str(js::prop(&*info, u"source"_s)) == u"index_stale") spot = std::nullopt;
    const OJson* note = info ? js::prop(&*info, u"note"_s) : nullptr;
    co_return UnderlyingSpot{spot && std::isfinite(*spot) ? spot : std::nullopt, js::strOr(note, QString())};
}

util::Task<std::optional<OJson>> spotStopFor(SpotRouter& router, QString symbol, OJson targets, std::optional<OJson> target, bool index) {
    if (!analysis::hasSpotStop(targets)) co_return std::nullopt;
    OJson spotValue = js::Null();
    const OJson* spot = &spotValue;
    QString note;
    if (target) {
        spot = js::prop(&*target, u"spot"_s);
        note = js::str(js::prop(&*target, u"spot_note"_s));
    } else {
        const UnderlyingSpot u = co_await underlyingSpot(router, symbol, index);
        spotValue = js::NOrNull(u.spot);
        note = u.note;
    }
    co_return analysis::spotStop(targets, symbol, spot, note);
}

}  // namespace ibkr::orchestrate
