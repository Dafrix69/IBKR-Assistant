// 确认凭据:把"弹过确认框、用户点了确认"和"放行这一次调用"真的绑在一起。逐条照 desktop/confirm-grants.js 搬,
// 用例照 engine-ts/tests/desktop-confirm-grants.spec.ts,另有一份拿那个 JS 模块现算的对拍(tests/fixtures/confirm-grants.json)。
//
// 会发单 / 授权发单 / 打开闸门的调用,要一张**一次性凭据**才放行。凭据只有一个来源:界面进程自己弹的原生对话框
// (Bridge 弹,不是页面弹),用户点了确认那个按钮。对话框上最显眼的那一行(这是在确认什么)由这里按用途写,页面改不了;
// 凭据绑着用途和这一次调用的内容(指令原文、账户、追踪的参数……),内容对不上不放行;用一次作废,一分钟过期。
//
// 这里是纯逻辑:哪些调用要凭据、凭据怎么发、怎么核销。弹框与放行在 Bridge。
// 值一律当 JS 的值看(shell/jsvalue.h):读不出来的数按"放松了"算,宁可多问一次。
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QList>
#include <QString>
#include <QStringList>

#include <stdexcept>

namespace ibkr::shell {

inline constexpr qint64 kGrantTtlMs = 60'000;

struct GrantNeed {
    QString purpose;
    QJsonObject binding;
};

struct LoosenedLimit {
    QString key;
    QString label;
    double from = 0;
    double to = 0;
};

/// 发凭据时用途不在表里(页面不能自己起名字)
class GrantError : public std::runtime_error {
public:
    explicit GrantError(const QString& message) : std::runtime_error(message.toStdString()), message_(message) {}
    const QString& message() const { return message_; }

private:
    QString message_;
};

/// 用途 → 对话框上由这里写的那一行;不在表里是空串
QString purposeHeadline(const QString& purpose);
QStringList purposeNames();

/// 补丁里哪些限额比现在松(按键名排好序;按账户的键名是 by_account.<账户>.<项>)。patchLimits 是 null = 整段恢复默认
QList<LoosenedLimit> loosenedLimits(const QJsonValue& patchLimits, const QJsonValue& currentLimits);

/// Discord 跟单的凭据绑什么(形状固定、名单排好序)
QJsonObject followBinding(const QJsonValue& cfg);
/// 补丁落下去之后,跟单是不是比现在放得更开
bool followWidened(const QJsonValue& next, const QJsonValue& now);

struct FollowConfirmText {
    bool live = false;
    QString detail;
};
/// 「打开 Discord 自动跟单」确认框上的正文;accounts 是引擎报的账户表
FollowConfirmText followConfirmText(const QJsonObject& binding, const QJsonArray& accounts);

/// n.toLocaleString('en-US', { maximumFractionDigits }):千分位、最多几位小数(从最短的十进制数字起四舍五入,中点远离零,同 ICU)
QString formatEnUs(double n, int maxFractionDigits);

/// 键排好序的 JSON(同 JS 的 canonical):同一份内容不管键的先后,指纹一样
QString canonical(const QJsonValue& value);
/// sha256(purpose + "\n" + canonical(binding)),十六进制
QString grantDigest(const QString& purpose, const QJsonValue& binding);

/// 把"绑的是什么"整理成固定的形状:确认框那一头和放行那一头各整理一遍,同一件事才得出同一个指纹
QJsonObject normalizeBinding(const QString& purpose, const QJsonValue& binding);

/// 这一次调用要哪些凭据。params 是已经摘掉 __confirmed 的入参;current 是引擎此刻的设置(settings.get),
/// 只有 settings.patch 用得到,读不到时给 null / undefined
QList<GrantNeed> requiredGrants(const QString& method, const QJsonValue& params, const QJsonValue& current = QJsonValue(QJsonValue::Null));

class GrantBook {
public:
    explicit GrantBook(qint64 ttlMs = kGrantTtlMs) : ttlMs_(ttlMs) {}

    /// 用户在原生对话框里点了确认:发一张凭据。用途不在表里抛 GrantError
    void issue(const QString& purpose, const QJsonValue& binding, qint64 nowMs);
    /// 核销一张:有、没过期、内容对得上才是 true;用过就没了
    bool consume(const QString& purpose, const QJsonValue& binding, qint64 nowMs);
    /// 一次调用要的凭据要么全有、要么一张都不动。返回缺的那些用途的中文名;空 = 放行(已核销)
    QStringList consumeAll(const QList<GrantNeed>& needs, qint64 nowMs);

private:
    void sweep(qint64 nowMs);

    qint64 ttlMs_;
    /// 指纹 → 过期时刻
    QHash<QString, qint64> grants_;
};

}  // namespace ibkr::shell
