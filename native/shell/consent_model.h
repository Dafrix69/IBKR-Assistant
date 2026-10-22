// 条款同意页背后的模型:读 docs/legal/ 三份文本、认文本里写的版本号、记同意。照 ConsentGate.tsx + store/consent.ts + lib/legalText.ts。
//
// 没同意现行这一版之前,界面被同意页整个挡住(风险揭示要在人开始依赖这个软件**之前**看到);钱路径另外由 Bridge 挡着。
// 同意的是文本里写的那一版:版本号和 ConsentStore 认的现行版本对不上就不作数(两头一样才能同意)。
#pragma once

#include "shell/consent.h"

#include <QObject>
#include <QVariantList>

namespace ibkr::shell {

struct LegalDoc {
    QString key;
    QString title;
    QString text;
};

/// 从 dir 读 risk-disclosure / terms / privacy 三份;读不到的文本是空串
QList<LegalDoc> loadLegalDocs(const QString& dir);
/// 三份开头都写着 `版本:YYYY-MM-DD`;不一致或读不出来是空串——那样的构建谁也同意不了,问题当场暴露
QString legalVersion(const QList<LegalDoc>& docs);

class ConsentModel : public QObject {
    Q_OBJECT
    Q_PROPERTY(bool accepted READ accepted NOTIFY changed)
    Q_PROPERTY(QString version READ version NOTIFY changed)
    Q_PROPERTY(QString acceptedAt READ acceptedAt NOTIFY changed)
    Q_PROPERTY(QVariantList docs READ docs CONSTANT)
    Q_PROPERTY(QString error READ error NOTIFY changed)
    /// 从「关于 → 查看条款」点开重看
    Q_PROPERTY(bool viewing READ viewing NOTIFY changed)

public:
    ConsentModel(ConsentStore* store, QString legalDir, QString appVersion, QObject* parent = nullptr);

    bool accepted() const { return state_.accepted; }
    QString version() const { return version_; }
    QString acceptedAt() const { return state_.acceptedAt; }
    QVariantList docs() const;
    QString error() const { return error_; }
    bool viewing() const { return viewing_; }

    Q_INVOKABLE void accept();
    Q_INVOKABLE void showTerms();
    Q_INVOKABLE void hideTerms();
    /// 不同意:退出应用
    Q_INVOKABLE void decline() { emit quitRequested(); }

signals:
    void changed();
    void quitRequested();

private:
    ConsentStore* store_;
    QList<LegalDoc> docs_;
    QString version_;
    QString appVersion_;
    ConsentState state_;
    QString error_;
    bool viewing_ = false;
};

}  // namespace ibkr::shell
