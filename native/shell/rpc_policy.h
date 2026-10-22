// 界面能调哪些引擎方法、哪些是敏感的、哪些超时不等于没发生。三张表照 desktop/main.js 的
// ALLOWED_RPC / SENSITIVE_RPC / OUTCOME_UNKNOWN_RPC 抄(tests/tst_bridge.cpp 直接读 main.js 比对,少一个多一个都红)。
#pragma once

#include <QSet>
#include <QString>

namespace ibkr::shell {

/// 界面允许调用的引擎方法。不在表里的一律拒绝,新增方法必须显式登记
const QSet<QString>& allowedRpc();
/// 会真的动钱或动配置的通道:额外要求界面带着确认标记(__confirmed)
const QSet<QString>& sensitiveRpc();
/// 超时不等于没发生:引擎的交易道严格顺序、不能取消,120 秒没回话时这张单可能还排在后面、过一会儿照样发出去
const QSet<QString>& outcomeUnknownRpc();
/// 迟到的回执补报时说的是哪件事
QString outcomeLabel(const QString& method);

}  // namespace ibkr::shell
