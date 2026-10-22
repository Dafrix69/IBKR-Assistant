// 顶栏上每一格写什么、什么颜色、悬停说什么:从 system.status 算出来的纯函数。照 desktop/renderer-react/src/shell/Topbar.tsx。
//
// 几条规矩(和 Electron 版一样):
//  · 引擎不答话时,手上这份状态是它最后一次答话时的样子:不能再照着它写「已连接」(stale)
//  · 实盘闸门单独一格、常驻:自动执行关着、熔断着、保护暂停着的时候更是完全看不出来,而那几样一恢复实盘单就发得出去
//  · 颜色只落在圆点上;tone 是 ok / warn / bad / idle
#pragma once

#include <QJsonObject>
#include <QString>

namespace ibkr::shell {

/// engineOk:-1 还没问过、0 不答话、1 正常。状态读不到时给空对象
QJsonObject topbarState(const QJsonObject& status, int engineOk);

/// 引擎名:富途是 OpenD,别的是 TWS
QString gatewayName(const QJsonObject& status);

}  // namespace ibkr::shell
