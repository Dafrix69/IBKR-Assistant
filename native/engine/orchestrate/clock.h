// engine/clock.ts 逐句搬:引擎这一层共用的时刻工具。
//   · localIsoSeconds:本机时区的此刻,到秒、带偏移。TS 版读 `new Date()`;这里读 util::dateNow()(测试能拨钟),
//     另给一个带时区的重载供对拍。util/killswitch 里的那份读的是真钟,不听 dateNow 的钩子——两份同形,这份是 engine 层用的。
//   · nowIsoSecondsEt:TS 的注释说"美东时刻串",实际是 etNowFromEpoch(Date.now()).epochMs 的 UTC 时刻写成 `…+00:00`(不是美东);照搬。
#pragma once

#include <QString>
#include <QTimeZone>

namespace ibkr::orchestrate {

QString localIsoSeconds();
QString localIsoSeconds(double epochMs, const QTimeZone& zone);
QString nowIsoSecondsEt();

}  // namespace ibkr::orchestrate
