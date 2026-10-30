// 「接入」一页的接线(pages/Access.tsx 与四节 lib/TwsPanel、AccountsPanel、LlmPanel、FollowPanel,共用的 lib/connectBits;富途那一节已删):
//   · 四节各自的状态照原版的 useState 存成一份 JSON(同名字段),模型由 shell/access_rules 摆;一次只挂一节,换子页签 = 旧的那节卸载(状态清掉)、
//     新的那节挂上(读一次);子页签记在本机(access/subtab);
//   · TWS:进来检测程序与端口、读当前券商;「检测连接」是一次只读握手;启动程序(tws.launch,带 __confirmed)成了发一条通知、
//     4 秒后重新检测;
//     「连接 / 断开交易引擎」借壳上的同一个动作(ShellActions),按钮自己记着读着;
//   · 账户:改动交给壳(main.js 的 accounts-change:校验、原生确认框、写配置、重启引擎),成了 2.5 秒后刷新状态与连接列表;
//   · 大模型:目录在 LlmStore;表单在目录或供应商真的变了时才重填(签名 = [供应商, 已存配置]);测试可以带一把还没存的 key;
//   · Discord 跟单:读状态(引擎报 follow 事件时重读,表单不动);关是当场生效的(settings.patch follow.enabled = false),
//     开与其它改动跟着「保存」走,打开着保存要先过确认框(purpose gate.follow,绑着要存的那一份);bot token 只往 follow.set_token 送。
// 这一页不发单:改的是连接、账户、模型与跟单的配置,凡是放宽的都过原生确认框(由 Bridge 核销凭据)。模型:shell/access_rules
#pragma once

#include <QJsonObject>
#include <QObject>
#include <QTimeZone>
#include <QVariant>

#include <functional>

namespace ibkr::shell {

class Bridge;
class LlmStore;
class ShellActions;
class StatusStore;

class AccessController : public QObject {
    Q_OBJECT
    Q_PROPERTY(QString sub READ sub NOTIFY changed)
    /// 当前那一节的模型(access_rules 的 twsModel / accountsModel / llmModel / followModel)
    Q_PROPERTY(QJsonObject model READ model NOTIFY changed)

public:
    AccessController(Bridge* bridge, StatusStore* status, LlmStore* llm, ShellActions* actions, QString settingsPath, QObject* parent = nullptr);

    QString sub() const { return sub_; }
    QJsonObject model() const { return model_; }

    Q_INVOKABLE void setVisible(bool on);
    Q_INVOKABLE void setSub(const QString& sub);
    // ---- TWS
    Q_INVOKABLE void rescan();
    Q_INVOKABLE void diagnose();
    Q_INVOKABLE void launch(const QString& key, const QString& name);
    Q_INVOKABLE void toggleConnection();
    // ---- 账户
    /// alias 空 = 新加
    Q_INVOKABLE void openDraft(const QString& alias);
    Q_INVOKABLE void setDraft(const QString& field, const QVariant& value);
    Q_INVOKABLE void cancelDraft();
    Q_INVOKABLE void saveDraft();
    Q_INVOKABLE void removeAccount(const QString& alias);
    // ---- 大模型
    Q_INVOKABLE void setLlm(const QString& field, const QVariant& value);
    Q_INVOKABLE void testLlm();
    Q_INVOKABLE void saveLlm();
    Q_INVOKABLE void saveLlmKey();
    // ---- Discord 跟单
    Q_INVOKABLE void setFollow(const QString& field, const QVariant& value);
    Q_INVOKABLE void setFollowToken(const QString& text);
    Q_INVOKABLE void setNewAuthor(const QString& text);
    Q_INVOKABLE void saveFollowToken();
    Q_INVOKABLE void reconnectFollow();
    /// id 空 = 加「手动添加」框里的那个
    Q_INVOKABLE void addAuthor(const QString& id);
    Q_INVOKABLE void removeAuthor(const QString& id);
    Q_INVOKABLE void toggleFollowAccount(const QString& alias, bool on);
    /// 开关:关是当场生效的,开只改表单
    Q_INVOKABLE void setFollowEnabled(bool on);
    Q_INVOKABLE void saveFollow();

    void onEngineEvent(const QString& event, const QJsonValue& data);

    /// 账户:壳给(SupportService):读可选的连接与占位账号;改动(校验、确认框、写配置、重启引擎),done(结果, 错误)
    std::function<QJsonObject()> accountsInfo;
    std::function<void(const QJsonObject& change, std::function<void(const QJsonObject& result, const QString& error)> done)> changeAccount;
    QTimeZone zone = QTimeZone::systemTimeZone();
    /// 两处「过一会儿再看」:启动程序后重新检测(4 秒)、改完账户后刷新(2.5 秒);测试调短
    int relaunchScanMs = 4000;
    int accountsRefreshMs = 2500;

signals:
    void changed();
    /// 给通知条(pushNotification)
    void notify(const QString& title, const QString& body);

private:
    void mount();
    void rebuild();
    void writeSub(const QString& sub) const;
    QJsonObject& panel();
    void loadTwsScan();
    void loadAccounts();
    void submitAccount(const QJsonObject& change);
    void reseedLlm();
    QJsonObject llmPatch() const;
    QString llmInvalid() const;
    void loadFollow(bool resetForm);

    Bridge* bridge_;
    StatusStore* status_;
    LlmStore* llm_;
    ShellActions* actions_;
    QString settingsPath_;
    bool visible_ = false;
    int generation_ = 0;
    QString sub_ = QStringLiteral("tws");
    /// 当前这一节的 useState(同名字段)与 connectBits 的两颗按钮({ launching, busy })
    QJsonObject state_;
    QJsonObject bits_;
    /// 大模型表单上一次按什么重填的(签名)
    QString llmSeeded_;
    QJsonObject model_;
};

}  // namespace ibkr::shell
