// 「行情」一页的接线(pages/Market.tsx + lib/PaPanel.tsx + lib/BookWall.tsx 的 useBooks):
//   · 原版这一页的状态都在组件里(切走就卸载):这里 setVisible(false) 时照样清掉,回来是新挂上的样子——
//     标的 / 周期 / 只看正常时段 / 关注表记在本机(React 版 localStorage 的 dafri-pa-* / dafri-book-symbols,这里是 Settings 的 market/*);
//   · K 线读盘:「分析」/ 换周期 / 拨开关 → pa.analyze(force);已连券商时 20 秒一轮(不 force,上一轮没回来就跳过,只用存下的参数、不读输入框);
//     换了标的或周期就丢掉上一次的 AI 解读;出错清掉结果;
//   · AI 解读:pa.comment,回来的 analysis 顶替图;
//   · 盘口:关注表最多 12 只,逐只取(正在看的那只排最前);已连券商时 20 秒一轮;正在看的那只不在关注里也跟着刷新;
//   · 盘口墙上点代码 / 标的档案的「K 线」跳过来:换成它来分析,并让页面滚回顶(scrollTop)。
// 模型在 shell/market_rules,图在 shell/pa_spec。
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QObject>
#include <QSet>
#include <QTimer>

namespace ibkr::shell {

class Bridge;
class ChartSource;
class StatusStore;

class MarketController : public QObject {
    Q_OBJECT
    Q_PROPERTY(QJsonObject page READ page NOTIFY pageChanged)
    /// K 线图(lib/PaPanel 的 PaChart):每次取回来换 spec,同一个标的 / 周期的刷新图会留住缩放
    Q_PROPERTY(QObject* chart READ chart CONSTANT)

public:
    static constexpr int kRefreshMs = 20'000;

    MarketController(Bridge* bridge, StatusStore* status, QString settingsPath, QObject* parent = nullptr);

    QJsonObject page() const { return page_; }
    QObject* chart() const;

    Q_INVOKABLE void setVisible(bool on);
    /// 标的输入框的字(还没「分析」之前不记)
    Q_INVOKABLE void setSymbolText(const QString& text);
    Q_INVOKABLE void analyze();
    Q_INVOKABLE void setTimeframe(const QString& key);
    Q_INVOKABLE void setRth(bool on);
    Q_INVOKABLE void comment();
    /// 盘口墙上点了代码、标的档案的「K 线」跳过来:换成它来分析
    Q_INVOKABLE void pick(const QString& symbol);
    // ---- 盘口
    Q_INVOKABLE void loadBook(const QString& symbol);
    Q_INVOKABLE void refreshAllBooks();
    /// 加进关注表:成了(或已经在里面)回 true,输入框就清掉
    Q_INVOKABLE bool addBook(const QString& raw);
    Q_INVOKABLE void removeBook(const QString& symbol);

    int refreshMs = kRefreshMs;

signals:
    void pageChanged();
    /// 换了标的(点了盘口墙的代码 / 跳过来的):页面滚回顶上看图
    void scrollTop();

private:
    struct Spec {
        QString symbol, timeframe;
        bool rth = false;
    };
    void run(std::optional<QString> symbol, std::optional<QString> timeframe, std::optional<bool> rth);
    void fetchPa(bool force);
    void focusBook(const QString& symbol);
    /// 全部刷新的队列:取完一只再取下一只
    void pumpBooks();
    void persistBooks();
    bool connected() const;
    void rebuild();
    void reset();

    Bridge* bridge_;
    StatusStore* status_;
    ChartSource* chart_;
    QString settingsPath_;
    QTimer paTimer_, bookTimer_;
    bool visible_ = false;
    /// 每次挂上 / 卸下加一:卸下之前发出去的请求回来了就扔掉(原版组件卸载后 setState 不生效)
    int generation_ = 0;

    QString symbol_, timeframe_ = QStringLiteral("5m");
    bool rth_ = false;
    QJsonArray timeframes_;
    Spec spec_;
    bool inFlight_ = false;
    QJsonValue data_ = QJsonValue::Null;
    QJsonValue comment_ = QJsonValue::Null;
    QString error_;
    bool loading_ = false, commenting_ = false;

    QStringList books_;
    QJsonObject bookData_;
    QSet<QString> bookLoading_;
    QString focused_;
    bool refreshing_ = false;
    QStringList refreshQueue_;

    QJsonObject page_;
};

}  // namespace ibkr::shell
