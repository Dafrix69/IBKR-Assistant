// system.*:状态条每隔几秒问一次的那一份快照(同 engine-ts/src/rpc/handlers/system.ts)。
//
// 阶段 0 只求**形状**和契约(engine-ts/src/contract/system.ts 的 SystemStatus)一样:每个键都在,类型对。
// 值里只有 protocol 与 now_et 是真的;别的要等配置、熔断闸、保护规则、券商、提示词搬过来(阶段 2),
// 现在给的是契约里写明的"空"的样子(没连券商、没在盯盘、闸没合)。阶段 2 起和 TS 引擎逐字段对拍。
#pragma once

#include "transport/rpc_server.h"

#include <QJsonObject>

namespace ibkr::rpc {

/// ET 墙钟串 `YYYY-MM-DD HH:MM:SS`(不是 ISO:界面直接显示)。用 Qt 的时区库;
/// 时区库里没有 America/New_York(精简过的 Qt、没装时区数据的机器)时退到 nowEtByUsRule,并在 stderr 说一次
QString nowEt(qint64 epochMs);

/// 不靠时区库、按美国 2007 年起的夏令时规则算的 ET:三月第二个星期日 2:00 起、十一月第一个星期日 2:00 止。
/// 只对 2007 年以后的时刻对
QString nowEtByUsRule(qint64 epochMs);

QJsonObject systemStatus(qint64 epochMs);

void addSystemHandlers(RpcServer& server);

}  // namespace ibkr::rpc
