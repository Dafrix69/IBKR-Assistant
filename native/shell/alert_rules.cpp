#include "shell/alert_rules.h"

#include "shell/jsvalue.h"

#include <QSet>
#include <QStringList>

#include <algorithm>
#include <cmath>
#include <optional>

using namespace Qt::StringLiterals;

namespace ibkr::shell::alerts {

namespace {
std::optional<double> finite(const QJsonValue& v) {
    if (!v.isDouble() || !std::isfinite(v.toDouble())) return std::nullopt;
    return v.toDouble();
}
QString times(double v) { return jsNumberToString(jsRound(v * 10) / 10); }
int clampFloor(double v, double lo, double hi) { return int(std::min(hi, std::max(lo, std::floor(v)))); }
}  // namespace

QString toneDirection(const QJsonValue& events) {
    QSet<QString> dirs;
    for (const QJsonValue& v : events.toArray()) {
        if (!jsTruthy(v)) continue;
        const QJsonObject e = v.toObject();
        const QJsonValue kind = e.value("kind"_L1);
        if (kind.isString() && (kind.toString() == u"rvol" || kind.toString() == u"burst")) continue;
        if (e.value("trigger"_L1) == u"touch"_s) continue;
        const QString d = e.value("direction"_L1).toString();
        if (e.value("direction"_L1).isString() && (d == u"up" || d == u"down")) dirs.insert(d);
    }
    return dirs.size() == 1 ? *dirs.begin() : QString();
}

PopupCounts popupCounts(const QJsonValue& sent, const QJsonValue& res) {
    const int n = int(std::max(0.0, std::floor(finite(sent).value_or(0))));
    if (n == 0) return {};
    const QJsonObject r = res.toObject();
    const auto shown = finite(r.value("shown"_L1));
    const int accepted = shown ? clampFloor(*shown, 0, n) : n;
    const auto reported = finite(r.value("dropped"_L1));
    const int dropped = reported ? clampFloor(*reported, 0, n - accepted) : n - accepted;
    return {accepted, dropped};
}

QJsonObject burstVerdict(const QJsonValue& metrics, const QJsonValue& threshold) {
    const QJsonObject m = metrics.toObject();
    const auto v = finite(m.value("burst"_L1));
    if (!v) return {{u"level"_s, u"none"_s}, {u"note"_s, QString()}};
    const auto thr = finite(threshold);
    QStringList notes;
    if (m.value("basis_volume"_L1) == u"session_pace"_s) notes << u"这只没有日均量,按今天到目前的成交节奏估算常态。"_s;
    const auto share = finite(m.value("block_share"_L1));
    // block_share 只有样本窗口才有:没有就说明引擎这一轮判不出"是不是一笔大单",也就不会报
    if (!share) {
        notes << u"窗口还不是按样本差算的(刚加入追踪、或样本断过),判不出是不是一笔大单补报——这个数只作参考,这一轮不会报。"_s;
        return {{u"level"_s, u"reference"_s}, {u"note"_s, notes.join(QString())}};
    }
    const double sustained = *v * (1 - *share);
    const bool over = thr && *v >= *thr;
    const bool hot = over && sustained >= *thr;
    const qint64 pct = qint64(jsRound(*share * 100));
    if (*share >= kBlockShareHeavy || (over && !hot)) {
        const QString tail = over && !hot && thr ? u",不到 %1× 的阈值,不算放量"_s.arg(times(*thr)) : QString();
        notes << u"一笔大单占了窗口的 %1%,去掉它只有 %2×%3。"_s.arg(pct).arg(jsToFixed(sustained, 1), tail);
    }
    const QString note = notes.join(QString());
    if (hot) return {{u"level"_s, u"hot"_s}, {u"note"_s, note}};
    if (*share >= kBlockShareHeavy || over) return {{u"level"_s, u"muted"_s}, {u"note"_s, note}};
    return {{u"level"_s, u"plain"_s}, {u"note"_s, note}};
}

}  // namespace ibkr::shell::alerts
