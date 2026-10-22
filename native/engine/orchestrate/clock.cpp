#include "orchestrate/clock.h"

#include "domain/config.h"
#include "orchestrate/engine_time.h"
#include "util/tz.h"

#include <QDateTime>
#include <QRegularExpression>

#include <cmath>

namespace ibkr::orchestrate {

QString localIsoSeconds(double epochMs, const QTimeZone& zone) {
    const QDateTime d = QDateTime::fromMSecsSinceEpoch(static_cast<qint64>(std::floor(epochMs)), zone);
    const int off = d.offsetFromUtc() / 60;  // -d.getTimezoneOffset()
    const auto pad = [](int n) { return QString::number(std::abs(n)).rightJustified(2, u'0'); };
    return QStringLiteral("%1-%2-%3T%4:%5:%6%7%8:%9")
        .arg(d.date().year())
        .arg(pad(d.date().month()), pad(d.date().day()), pad(d.time().hour()), pad(d.time().minute()), pad(d.time().second()),
             off >= 0 ? QStringLiteral("+") : QStringLiteral("-"), pad(off / 60), pad(off % 60));
}

QString localIsoSeconds() { return localIsoSeconds(nowMs(), QTimeZone::systemTimeZone()); }

QString nowIsoSecondsEt() {
    // new Date(now.epochMs).toISOString().replace(/\.\d{3}Z$/, "+00:00")
    const domain::EtNow now = domain::etNowFromEpoch(nowMs());
    QString iso = util::isoString(now.epochMs);
    static const QRegularExpression re(QStringLiteral("\\.\\d{3}Z$"));
    iso.replace(re, QStringLiteral("+00:00"));
    return iso;
}

}  // namespace ibkr::orchestrate
