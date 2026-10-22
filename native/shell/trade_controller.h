// 「交易指令」页的接线(pages/Trade.tsx 的那几个 effect 与按钮):
//   · 模型(shell/trade_rules 的 tradePageModel)在状态、大模型目录、输入 / 结果、勾选、历史相似交易任何一样变了时重算;
//   · 结果卡片里每张票据按内容取一次历史相似交易(ideas.similar_trades,只读);同一张票据留在新结果里就不重取;
//   · 占位账号(accounts-info)在状态里的账户变了时重问;
//   · ⌘⇧↩ 和「发送」按钮同一个口径:按钮灰着时快捷键也不发,横幅说为什么。
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QObject>
#include <QStringList>

#include <functional>

namespace ibkr::shell {

class Bridge;
class LlmStore;
class StatusStore;
class KeyedListModel;
class TradeComposer;

class TradeController : public QObject {
    Q_OBJECT
    Q_PROPERTY(QJsonObject model READ model NOTIFY modelChanged)
    // 页上几处列表单拎出来:模型每敲一个字都重算,整份 model 一换,拿 JS 数组当 model 的 Repeater 就把 delegate 全部销毁重建
    // (损益图重新三角化、悬停着的提示一闪)。这几样只在内容真的变了时才通知;结果卡片按键原地更新
    Q_PROPERTY(QObject* cards READ cards CONSTANT)
    Q_PROPERTY(QJsonArray steps READ steps NOTIFY listsChanged)
    Q_PROPERTY(QJsonArray accounts READ accounts NOTIFY listsChanged)
    Q_PROPERTY(QJsonArray chips READ chips NOTIFY listsChanged)
    Q_PROPERTY(QJsonArray primerItems READ primerItems NOTIFY listsChanged)

public:
    TradeController(Bridge* bridge, StatusStore* status, LlmStore* llm, TradeComposer* composer, QObject* parent = nullptr);

    QJsonObject model() const { return model_; }
    QObject* cards() const;
    QJsonArray steps() const { return steps_; }
    QJsonArray accounts() const { return accounts_; }
    QJsonArray chips() const { return chips_; }
    QJsonArray primerItems() const { return primerItems_; }
    /// accounts-info 的占位账号(主进程读配置文件才知道):壳给
    std::function<QStringList()> placeholders;

    /// 「解析并校验」/「发送」:发到此刻勾着的账户
    Q_INVOKABLE void submit(bool execute);
    /// ⌘↩ / ⌘⇧↩
    Q_INVOKABLE void hotkey(bool execute);
    Q_INVOKABLE void togglePick(const QString& alias, bool on);
    /// 点速记片段:返回 { text, caret }(输入框照着改、光标放过去)
    Q_INVOKABLE QJsonObject insertSnippet(int start, int end, const QString& snippet);
    /// 关口提醒的「查看」带着标的跳过来:右栏翻到蝴蝶测算
    Q_INVOKABLE void focus();
    Q_INVOKABLE void refreshPlaceholders();

signals:
    void modelChanged();
    void listsChanged();

private:
    void rebuild();
    void fetchSimilar();

    Bridge* bridge_;
    StatusStore* status_;
    LlmStore* llm_;
    TradeComposer* composer_;
    QStringList placeholders_;
    QString accountsSig_;
    QJsonObject similar_;
    QJsonValue lastPayload_;
    QJsonObject model_;
    KeyedListModel* cards_;
    QJsonArray steps_, accounts_, chips_, primerItems_;
};

}  // namespace ibkr::shell
