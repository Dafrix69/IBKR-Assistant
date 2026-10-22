#include "util/js_runtime.h"

#include "util/tz.h"

#include <QDateTime>
#include <QUuid>

#include <cmath>

namespace ibkr::util {

namespace {
std::function<double()>& nowHook() {
    static std::function<double()> f;
    return f;
}
std::function<QString()>& uuidHook() {
    static std::function<QString()> f;
    return f;
}
}  // namespace

double dateNow() { return nowHook() ? nowHook()() : double(QDateTime::currentMSecsSinceEpoch()); }

QString randomUUID() { return uuidHook() ? uuidHook()() : QUuid::createUuid().toString(QUuid::WithoutBraces).toLower(); }

void setDateNowForTests(std::function<double()> f) { nowHook() = std::move(f); }
void setRandomUUIDForTests(std::function<QString()> f) { uuidHook() = std::move(f); }

QString nowIsoSeconds() {
    const double now = dateNow();
    return utcIso(now - std::fmod(now, 1000.0));
}

}  // namespace ibkr::util
