// 「扫描」一页的接线(pages/Screener.tsx 的 useScan、lib/DeviationSection 的 useDeviation、lib/LeadersSection):
//   · 原版状态都在组件里(切走就卸载):setVisible(false) 清空,回来是新挂上的样子;选中的股票池记在本机(screener/sector);
//     进页重读板块(板块页刚加的股要立刻可选);
//   · 扫描:先 RS 后背离、不并发(两边要的是同一批日线,RS 拉完进了 10 分钟缓存);背离没回来之前表里先占住那几列;
//     出结果后顺手复盘榜首那只(人已经自己点过就不抢);两步同一个原因的报错只说一遍;
//   · 极值偏离:连着点几行时只认最后一次;失败把上一只的数清掉;
//   · 强势股:同一个股票池与基准。
// 不下单:这一页只碰 screener.* 与 sectors.list。模型在 shell/screener_rules
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QObject>
#include <QStringList>
#include <QTimeZone>

#include <functional>

namespace ibkr::shell {

class Bridge;
class ChartSource;
class KeyedListModel;
class SectorsStore;
class StatusStore;

class ScreenerController : public QObject {
    Q_OBJECT
    Q_PROPERTY(QJsonObject page READ page NOTIFY pageChanged)
    Q_PROPERTY(QObject* devChart READ devChart CONSTANT)
    Q_PROPERTY(QObject* pressureChart READ pressureChart CONSTANT)
    /// 表与强势股表的行:按代码原地更新(点一行、敲一个字不把整张表重建)
    Q_PROPERTY(QObject* rows READ rows CONSTANT)
    Q_PROPERTY(QObject* leaderRows READ leaderRows CONSTANT)

public:
    ScreenerController(Bridge* bridge, SectorsStore* sectors, StatusStore* status, QString settingsPath, QObject* parent = nullptr);

    QJsonObject page() const { return page_; }
    QObject* devChart() const;
    QObject* pressureChart() const;
    QObject* rows() const;
    QObject* leaderRows() const;

    Q_INVOKABLE void setVisible(bool on);
    Q_INVOKABLE void setSector(const QString& id);
    Q_INVOKABLE void setBenchmark(const QString& b);
    Q_INVOKABLE void toggleTimeframe(const QString& tf, bool on);
    Q_INVOKABLE void setMa(const QVariant& v);
    Q_INVOKABLE void run();
    /// 点表头:没排 → 降 → 升 → 没排(sortDirections: descend, ascend)
    Q_INVOKABLE void sortBy(const QString& key);
    // ---- 极值偏离
    Q_INVOKABLE void review(const QString& symbol);
    /// 点表里的一行(扫描表、强势股表):复盘它,再让页面滚到极值偏离那一节(原版 drill;复盘在表的下面,不滚过去的话点了像没反应)
    Q_INVOKABLE void drill(const QString& symbol);
    /// 「复盘」与输入框回车:手输的优先,没输就是当前那只
    Q_INVOKABLE void reviewCurrent();
    Q_INVOKABLE void step(int delta);
    Q_INVOKABLE void setFree(const QString& text);
    Q_INVOKABLE void setDevTimeframe(const QString& tf);
    Q_INVOKABLE void setPeriod(const QVariant& v);
    Q_INVOKABLE void setLookback(const QVariant& v);
    // ---- 强势股
    Q_INVOKABLE void runLeaders();
    Q_INVOKABLE void setLeadersFilter(const QString& f);

    std::function<double()> now;
    QTimeZone zone = QTimeZone::systemTimeZone();

signals:
    void pageChanged();
    /// 点了一行:页面把极值偏离那一段滚到眼前
    void revealDeviation();

private:
    void reset();
    void rebuild();
    void error(const QString& text);
    void reviewIfUntouched(const QString& symbol);

    Bridge* bridge_;
    SectorsStore* sectors_;
    StatusStore* status_;
    ChartSource* devChart_;
    ChartSource* pressureChart_;
    KeyedListModel* rows_;
    KeyedListModel* leaderRows_;
    QString settingsPath_;
    bool visible_ = false;
    int generation_ = 0;

    QString sector_ = QStringLiteral("all");
    QString sortKey_, sortOrder_;
    QString benchmark_ = QStringLiteral("SPY");
    QStringList timeframes_;
    QJsonValue ma_ = 20;
    bool busy_ = false;
    QString progress_;
    QJsonValue rs_, infl_;
    // 极值偏离
    QString devSymbol_, devFree_, devTf_ = QStringLiteral("1d");
    QJsonValue devPeriod_ = 20, devLookback_ = 120;
    bool devBusy_ = false;
    QJsonValue devResult_;
    QString devStatus_;
    int devSeq_ = 0;
    // 强势股
    QJsonValue leaders_;
    bool leadersBusy_ = false;
    QString leadersError_;
    QString leadersFilter_ = QStringLiteral("all");

    QJsonObject page_;
};

}  // namespace ibkr::shell
