// util/discord_gateway 的真 socket 那一面:QWebSocket。单独一个库(ibkr_discord_ws,链 Qt6::WebSockets),别的引擎库不沾它。
// 不走代理(TS 版 "不走代理:系统层面连不上 discord.com 时这里也连不上");只收文本帧(TS:`typeof ev.data === "string"` 才递)。
// 回调里网关可能把这条 socket 释放掉:这里在回调期间自己保活,出了信号再放。close() 之后留着对象直到握手收尾(3 秒还没收尾就掐断),
// 不在半路被销毁成一次突然的 TCP 断开。
#pragma once

#include "util/discord_gateway.h"

#include <QUrl>

namespace ibkr::util {

/// 允许连哪些主机。缺省:只许 Discord 自己的(discord.gg 与它的子域:gateway.discord.gg、续连用的 gateway-*.discord.gg);
/// 不在名单里的当场拒(抛 JsError),连 socket 都不开。测试递一个只认回环的
using AllowHost = std::function<bool(const QString& host)>;
bool discordHostsOnly(const QString& host);

/// GatewayOptions::open 的真实现。必须在有事件循环的线程里调用
std::function<std::shared_ptr<SocketLike>(const QString& url)> webSocketOpener(AllowHost allowHost = discordHostsOnly);

/// 兜底:每次真的要拨号之前先过这一道(在 WsSocket 里,开 socket 之后、open 之前)。只给测试装:
/// 装上之后任何一次拨号都先交给它,它发现不该连的主机就 qFatal——哪怕上面那道 allowHost 被人删了,测试也到不了真主机
void setWebSocketDialGuard(std::function<void(const QUrl& url)> guard);

}  // namespace ibkr::util
