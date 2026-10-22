#include "shell/spot_levels.h"

#include "shell/jsvalue.h"

#include <QStringList>

#include <cmath>

using namespace Qt::StringLiterals;

namespace ibkr::shell::spot {

Sample Sample::fromQuote(const QJsonObject& quote) {
    Sample s;
    if (quote.value("price"_L1).isDouble()) s.price = quote.value("price"_L1).toDouble();
    s.source = quote.value("source"_L1).toString();
    s.at = quote.value("at"_L1).toDouble();
    return s;
}

namespace {
bool usable(const Sample& s) {
    return s.price && std::isfinite(*s.price) && *s.price > 0 && (s.source == u"quote" || s.source == u"futures");
}
}  // namespace

std::pair<double, double> nearLevels(double price, double step) {
    const double below = std::floor(price / step) * step;
    return {below, below + step};
}

Step stepLevelWatch(const WatchState& state, const Sample& sample, double step) {
    if (!usable(sample)) return {state, std::nullopt};
    const double price = *sample.price;
    const std::optional<Sample>& prev = state.last;
    const std::optional<double> muted = state.muted && std::fabs(price - *state.muted) >= step / 2 ? std::nullopt : state.muted;
    const Step quiet{{sample, muted}, std::nullopt};
    if (!prev || prev->source != sample.source || sample.at < prev->at || sample.at - prev->at > kGapMs || price == *prev->price) return quiet;

    const bool up = price > *prev->price;
    // 这一步越过的关口里离这一笔最近的那个,以及一共越过了几个
    const double level = up ? std::floor(price / step) * step : std::ceil(price / step) * step;
    const double count = up ? std::floor(price / step) - std::floor(*prev->price / step) : std::ceil(*prev->price / step) - std::ceil(price / step);
    if (count <= 0 || (muted && level == *muted)) return quiet;
    return {{sample, level}, Hit{level, up ? u"up"_s : u"down"_s, price, sample.source, sample.at, int(count) - 1}};
}

QString levelHitTitle(const QString& symbol, const Hit& hit) {
    return u"%1 %2 %3"_s.arg(symbol, hit.direction == u"up" ? u"上穿"_s : u"下破"_s, jsNumberToString(hit.level));
}

QString levelHitBody(const Hit& hit) {
    QStringList parts{u"现价 "_s + jsToFixed(hit.price, 2) + (hit.source == u"futures" ? u"(按期货推算)"_s : QString())};
    if (hit.skipped > 0) parts << u"这一步越过了 %1 个关口"_s.arg(hit.skipped + 1);
    return parts.join(u" · "_s);
}

}  // namespace ibkr::shell::spot
