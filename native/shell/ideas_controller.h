// 「想法」一页的接线(pages/Ideas.tsx):
//   · 原版的状态都在组件里(切走就卸载):setVisible(false) 清空,回来是新挂上的样子(进行中、没有检索词、附带交易结果勾着);
//   · 进页即读,停留期间每分钟一轮;有检索词时走 ideas.search(回车才生效,命中方式跟着),否则 ideas.list;读完顺带读总结历史(失败不说);
//   · 记下:ideas.add,成了清空输入框、回到「进行中」再读;完成 / 归档 / 恢复:ideas.update 再读;
//   · AI 分析:ideas.analyze(那一张显示分析中),完了再读;总结知识:ideas.digest { scope: all, focus?: { q }, trades },完了读总结历史;
//   · 发到解析:把原文放进交易指令页的输入框(清掉上一次的结果),壳切过去。
// 不下单:这一页只碰 ideas.*。模型在 shell/ideas_rules
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QObject>
#include <QSet>
#include <QTimeZone>
#include <QTimer>

#include <functional>

namespace ibkr::shell {

class Bridge;
class StatusStore;
class TradeComposer;

class IdeasController : public QObject {
    Q_OBJECT
    Q_PROPERTY(QJsonObject page READ page NOTIFY pageChanged)

public:
    static constexpr int kRefreshMs = 60'000;

    IdeasController(Bridge* bridge, StatusStore* status, TradeComposer* composer, QObject* parent = nullptr);

    QJsonObject page() const { return page_; }

    Q_INVOKABLE void setVisible(bool on);
    Q_INVOKABLE void setFilter(const QString& filter);
    /// 检索框回车:去掉两头空白;空串回到列表
    Q_INVOKABLE void search(const QString& query);
    Q_INVOKABLE void setWithTrades(bool on);
    /// 记下一条(成了发 added,输入框清空)
    Q_INVOKABLE void add(const QString& text);
    Q_INVOKABLE void setStatus(const QString& id, const QString& status);
    Q_INVOKABLE void analyze(const QString& id);
    Q_INVOKABLE void digest();
    Q_INVOKABLE void sendToTrade(const QString& id);

    std::function<double()> now;
    QTimeZone zone = QTimeZone::systemTimeZone();
    int refreshMs = kRefreshMs;

signals:
    void pageChanged();
    void added();
    /// 壳切页(发到解析 → trade)
    void navigateRequested(const QString& page);

private:
    /// done:列表回来之后(成不成都算;卸下之后不调)
    void load(std::function<void()> done = {});
    void loadDigests();
    void reset();
    void rebuild();

    Bridge* bridge_;
    StatusStore* status_;
    TradeComposer* composer_;
    QTimer timer_;
    bool visible_ = false;
    int generation_ = 0;
    /// 每次读列表加一:慢的旧回包(换了筛选 / 检索词之前发出去的)不盖掉新的
    int loadSeq_ = 0;

    QString filter_ = QStringLiteral("active");
    QString query_;
    bool withTrades_ = true;
    QJsonArray ideas_;
    QJsonObject matched_;
    QString loadError_;
    QJsonArray digests_;
    bool digesting_ = false;
    QSet<QString> analyzing_;
    QJsonObject page_;
};

}  // namespace ibkr::shell
