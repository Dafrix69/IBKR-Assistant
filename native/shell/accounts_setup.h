// 账户设置(desktop/accounts-setup.js 逐条搬):从界面加、改、删账户别名。这条路不经过引擎的 RPC(引擎的 settings.patch
// 明确拒绝 accounts / connections),由壳自己走:写之前弹原生确认框,框里的每一个字都是这里对着"将要写进去的内容"写的;
// IBKR 的账号不是模拟账号的样子(D 开头)就不许标成纸面——那是最危险的一种填错,实盘闸门对它失效;连接不能从界面改;
// 原子写,改动前那一份留成 .bak;写完重启引擎,由它把整份配置再验一遍。写回去保持原来的键次序。
// 期望值由 node 跑原模块现算(tests/fixtures/gen_accounts_setup.mjs)。
#pragma once

#include "shell/ordered_json.h"

#include <QJsonArray>
#include <QString>
#include <QStringList>

#include <optional>

namespace ibkr::shell::accounts {

inline constexpr int kAliasMax = 24;

struct Plan {
    OJson config;       // 改完之后的配置
    QString headline;   // 添加账户 / 修改账户 / 删除账户
    QStringList lines;  // 确认框上的话
    QByteArray before;  // 改动前的原文(planChange 才有)
};

/// 校验一次改动,算出改完之后的配置;不碰磁盘。不合规返回空,error 里是给人看的那句。
/// change:{ action: 'upsert', alias, account_id, is_paper, connection, make_default? } | { action: 'remove', alias }
std::optional<Plan> applyChange(const OJson& config, const OJson& change, QString* error);
/// 读配置 → 校验 → 算出新配置与确认框上的话;不写盘
std::optional<Plan> planChange(const QString& configPath, const OJson& change, QString* error);
/// 把新配置写下去:改动前那一份留成 .bak(写不进去不挡保存)
bool commitChange(const QString& configPath, const Plan& plan);

/// 配置里还是示例占位的那些账户(账号是全零的)
QStringList placeholderAliases(const OJson& config);
/// 配置里有哪些连接可选:[{ name, broker, port }]
QJsonArray connectionChoices(const OJson& config);

}  // namespace ibkr::shell::accounts
