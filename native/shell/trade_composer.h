// 交易指令页的编辑器状态与提交动作(desktop/renderer-react/src/store/trade.ts,逐步搬)。
//
// 为什么放在 store 而不是页面里:壳一次只挂载一页,切去看一眼别的页再回来,输入框与解析结果都得还在;提交也在这里跑,页面中途卸载不影响结果落地。
//
// submit 是钱路径(execute = 授权直接发单):先确认框(用途 instruction.submit,绑的是指令原文与账户——和下面发出去的入参同一份,
// 对不上桥不放行),再 instruction.submit { text, execute, accounts, __confirmed: true }。只解析不弹框、不要凭据(同 confirm-grants.js)。
// 步骤与每一步之后的状态由 tests/fixtures/gen_trade_page.mjs 跑原 store 记下来,tst_trade_composer 逐步对。
#pragma once

#include "shell/engine_client.h"

#include <QJsonArray>
#include <QJsonObject>
#include <QObject>
#include <QStringList>

#include <functional>
#include <optional>

namespace ibkr::shell {

class Bridge;
class StatusStore;

namespace trade {

/// 提交要用到的外面的东西(测试换成记录调用的假货)
struct ComposerDeps {
    /// 引擎的回执原样(ok 为假时 error 可能是空串:那就是一次没有原因的失败,界面上什么都不写,同 React 版)
    using Reply = std::function<void(const EngineReply& reply)>;
    /// 确认框(main.js 的 confirm 通道);done(点了确认没有)
    std::function<void(const QJsonObject& options, std::function<void(bool)>)> confirm;
    /// instruction.submit(preload.js 的 submit:text、execute、accounts)
    std::function<void(const QString& text, bool execute, const QStringList& accounts, Reply)> submit;
    /// 发完之后状态、交易记录、条件单一起重读(Promise.all),都读完再调 done
    std::function<void(std::function<void()> done)> reload;
    std::function<void(const QString& text, bool info)> banner;
    /// 券商简称(确认框那句话里的「发送到 IBKR / 富途」)
    std::function<QString()> brokerShortName;
    /// 毫秒,只用来量这一次等了多久(performance.now)
    std::function<double()> nowMs;
};

}  // namespace trade

class TradeComposer : public QObject {
    Q_OBJECT
    Q_PROPERTY(QString text READ text WRITE setText NOTIFY changed)
    /// 右栏摆的是哪一样:result / fly / playbook
    Q_PROPERTY(QString pane READ pane WRITE setPane NOTIFY changed)
    /// 正在跑的是哪一个按钮:parse / execute;空 = 空闲
    Q_PROPERTY(QString busy READ busy NOTIFY changed)
    Q_PROPERTY(QString working READ working NOTIFY changed)
    /// 引擎那份回执外加 __elapsedMs(界面这一侧量的墙钟耗时);没有是 null
    Q_PROPERTY(QJsonValue payload READ payload NOTIFY changed)
    Q_PROPERTY(QString failure READ failure NOTIFY changed)
    /// 勾选变了就变(页面据此重算 selectedAccounts)
    Q_PROPERTY(int pickRevision READ pickRevision NOTIFY pickedChanged)

public:
    /// settingsPath:qt-settings.ini(勾选记在 trade/accounts,同 React 版 localStorage 的 dafri-submit-accounts);空 = 不记
    TradeComposer(trade::ComposerDeps deps, QString settingsPath, QObject* parent = nullptr);
    /// 正式接线:确认框与提交走桥,发完重读状态(交易记录与条件单的重读经 submitted 信号交给它们的 store)
    TradeComposer(Bridge* bridge, StatusStore* status, QString settingsPath, QObject* parent = nullptr);

    QString text() const { return text_; }
    QString pane() const { return pane_; }
    QString busy() const { return busy_; }
    QString working() const { return working_; }
    QJsonValue payload() const { return payload_; }
    QString failure() const { return failure_; }
    int pickRevision() const { return pickRevision_; }

    void setText(const QString& text);
    void setPane(const QString& pane);
    /// 蝴蝶测算的「写进指令」:不覆盖用户已经写的
    Q_INVOKABLE void appendInstruction(const QString& line);
    Q_INVOKABLE void clearResult();
    /// 想法页「发到解析」:把文本直接写进输入框,结果清掉
    Q_INVOKABLE void setDraft(const QString& text);
    Q_INVOKABLE void submit(bool execute, const QStringList& accounts);

    /// 发完之后除了状态还要一起重读的(交易记录、条件单:Promise.all 那两样),读完再调 done;壳接
    std::function<void(std::function<void()> done)> reloadOthers;

    /// 本机存的勾选(nullopt = 没勾过,按默认账户来)
    std::optional<QStringList> savedPicked() const { return picked_; }
    Q_INVOKABLE void savePicked(const QStringList& aliases);
    /// 这一次发到哪几个账户(lib/accountPick.ts):usable = 当前券商通道下的账户
    Q_INVOKABLE QStringList selectedAccounts(const QJsonArray& usable) const;
    /// 此刻整份状态(测试与页面模型用):{ text, pane, busy, working, payload, failure }
    QJsonObject snapshot() const;

signals:
    void changed();
    void pickedChanged();
    /// 一次提交落地了(成没成都算):交易记录、条件单的 store 接这个重读
    void submitted();

private:
    static trade::ComposerDeps bridgeDeps(Bridge* bridge, StatusStore* status, TradeComposer* self);

    trade::ComposerDeps deps_;
    QString settingsPath_;
    QString text_;
    QString pane_ = QStringLiteral("result");
    QString busy_;
    QString working_;
    QJsonValue payload_;
    QString failure_;
    std::optional<QStringList> picked_;
    int pickRevision_ = 0;
};

}  // namespace ibkr::shell
