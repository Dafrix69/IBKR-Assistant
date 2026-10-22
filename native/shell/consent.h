// 条款同意的记录。照 desktop/consent.js 搬:
//
// 这个软件会替人发真实订单。用户得明确看过并同意风险揭示、使用条款、隐私说明(正文在 docs/legal/),同意的是**某一版**:
// 条款改了版本号跟着改,老用户下次启动要重新看一遍。记在 userData/consent.json,只增不改(每同意一次追加一条)。
// 和 Electron 版是同一个文件:在哪一版里同意过,另一版也认。
//
// 没同意现行这一版之前,不放行任何会发单或授权发单的调用,也不许打开自动执行、实盘下单、Discord 跟单——
// 这里挡的是钱路径,界面被绕过也过不去(Bridge 在转给引擎之前问它)。
#pragma once

#include <QJsonValue>
#include <QString>

#include <optional>

namespace ibkr::shell {

/// 现行条款的版本号:同 desktop/consent.js 的 TERMS_VERSION 与 docs/legal/ 三份文档开头(tst_bridge 读那个文件比对)
inline constexpr auto kTermsVersion = "2026-10-15";

struct ConsentState {
    QString version;
    bool accepted = false;
    QString acceptedAt;
};

class ConsentStore {
public:
    explicit ConsentStore(QString userDataDir) : dir_(std::move(userDataDir)) {}

    QString path() const;
    ConsentState state() const;
    /// 记一次同意。version 必须是现行版本(界面上摆的要是旧文本,这一次不作数):对不上返回空、error 里写原因
    std::optional<ConsentState> accept(const QString& version, const QString& appVersion, qint64 nowMs, QString* error);

    /// 这一次调用在没同意条款时该不该挡:要挡给原因,不挡给空串
    static QString blockedWithoutConsent(const QString& method, const QJsonValue& params);

private:
    QString dir_;
};

}  // namespace ibkr::shell
