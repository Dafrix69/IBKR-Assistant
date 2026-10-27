// 「持仓追踪」页的接线(React 版 pages/Tracker.tsx 的那几个 effect + TrackCard / TrackForm 的按钮):
//   · 模型(shell/tracker_page)在持仓追踪、价位警告、状态任何一样变了时重算;
//   · 停在这一页时持仓的现价跟着行情走:IBKR 每秒、富途每 5 秒读一次(进页先整读一遍);
//   · 卡片的三个按钮(shell/track_actions)、新建追踪(shell/track_form)都经 Bridge 发,会发单的走确认框与凭据;
//   · 价位条按真字体排版(量字宽由壳给)。
#pragma once

#include "shell/keyed_list_model.h"
#include "shell/level_strip.h"

#include <QJsonObject>
#include <QObject>
#include <QPointer>
#include <QTimer>

namespace ibkr::shell {

class AlertsStore;
class Bridge;
class StatusStore;
class TrackerStore;

class TrackerController : public QObject {
    Q_OBJECT
    /// shell/tracker_page 的整页模型
    Q_PROPERTY(QJsonObject model READ model NOTIFY modelChanged)
    /// 每张追踪卡片哪个按钮在转圈:{ 追踪 id: toggle / close / delete }
    Q_PROPERTY(QJsonObject busy READ busy NOTIFY busyChanged)
    /// 新建追踪正在提交的那几张持仓:{ key: true }(每张表单各转各的,同 React 版每个 TrackForm 自己的 saving)
    Q_PROPERTY(QJsonObject saving READ saving NOTIFY busyChanged)
    /// 持仓卡片与追踪卡片:按 key / id 原地更新的列表(持仓每秒刷新时卡片不重建,展开着的表单不回初值)
    Q_PROPERTY(QObject* positions READ positions CONSTANT)
    Q_PROPERTY(QObject* tracks READ tracks CONSTANT)
    /// 状态 / 价位警告每变一次加一:QML 里调 isPaper / levelPicker 的绑定靠它知道该重算
    Q_PROPERTY(int statusRev READ statusRev NOTIFY statusTick)
    Q_PROPERTY(int alertsRev READ alertsRev NOTIFY alertsTick)
    /// 刚建好、要闪一下的那张追踪卡片
    Q_PROPERTY(QString flashId READ flashId NOTIFY flashChanged)

public:
    TrackerController(Bridge* bridge, StatusStore* status, TrackerStore* tracker, AlertsStore* alerts, QObject* parent = nullptr);

    QJsonObject model() const { return model_; }
    QJsonObject busy() const { return busy_; }
    QJsonObject saving() const;
    QObject* positions() { return &positions_; }
    QObject* tracks() { return &tracks_; }
    int statusRev() const { return statusRev_; }
    int alertsRev() const { return alertsRev_; }
    QString flashId() const { return flashId_; }

    /// 页面看得见 / 看不见(进页先整读一遍,看得见时按券商的节拍刷持仓)
    Q_INVOKABLE void setVisible(bool on);
    Q_INVOKABLE void reload();
    /// 展开某一张持仓的表单(一次只展开一张;再点同一张收起)
    Q_INVOKABLE void toggleForm(const QString& key);
    Q_INVOKABLE void toggle(const QString& trackId);
    Q_INVOKABLE void closeNow(const QString& trackId);
    Q_INVOKABLE void remove(const QString& trackId);
    /// 价位那一块的两个按钮
    Q_INVOKABLE void createWatch(const QString& symbol);
    Q_INVOKABLE void refreshWatch(const QString& watchId);
    /// 按下「开始追踪」:position = 那一行持仓,values = 表单的值(键同 React 版各个 state)
    Q_INVOKABLE void startTrack(const QJsonObject& position, const QJsonObject& values);
    /// 填标的目标价时的试算(只读):结果走 previewed(seq, target, result, error),页面只认自己最后一次的 seq(同 React 版的 alive)
    Q_INVOKABLE int preview(const QString& key, double target, const QVariant& chaseMax);
    /// 价位弹窗的「查看」跳过来:滚到「正在追踪」,把这只标的的卡片闪一下(2.2 秒)
    Q_INVOKABLE void focusSymbol(const QString& symbol);
    /// 这个账户是不是纸面账户(当前券商通道下配了别名的那几个里找;认不出按实盘说——提示宁可偏严)
    Q_INVOKABLE bool isPaper(const QString& account) const;
    /// 表单顶上的关键价位(shell/track_form 的 levelPickerModel)
    Q_INVOKABLE QJsonValue levelPicker(const QJsonObject& position) const;
    /// 试算那一块要摆的字:outcome = previewOutcome(result, error)
    Q_INVOKABLE QJsonObject previewOutcome(const QJsonValue& result, const QString& error) const;
    Q_INVOKABLE QJsonArray previewLines(const QJsonObject& position, double target, const QJsonValue& priced, const QString& error) const;
    /// 某张组合的腿明细(按 key 原地更新的列表,同 positions);没有这张组合是 null
    Q_INVOKABLE QObject* legsModel(const QString& comboKey);
    /// 价位条的元素树(shell/level_strip),按真字体量字宽
    Q_INVOKABLE QJsonObject levelStrip(const QJsonArray& levels, const QVariant& spot, double width) const;

    levels::Measure measure;

signals:
    void modelChanged();
    void busyChanged();
    void flashChanged();
    void previewed(int seq, double target, const QJsonValue& result, const QString& error);
    void statusTick();
    void alertsTick();
    /// 把视线带到「正在追踪」(focusSymbol)
    void reveal();
    /// 建好了一条追踪:页面把视线带过去(滚到「正在追踪」)
    void created(const QString& trackId);

private:
    void rebuild();
    QJsonObject findTrack(const QString& id) const;
    void setBusy(const QString& id, const QString& what);
    void flash(const QString& id, int ms = 1'800);
    void applyFocus();

    Bridge* bridge_;
    StatusStore* status_;
    TrackerStore* tracker_;
    AlertsStore* alerts_;
    QTimer refresh_;
    QTimer flashTimer_;
    QJsonObject model_;
    QJsonObject busy_;
    QHash<QString, int> saving_;
    KeyedListModel positions_{QStringLiteral("key")};
    KeyedListModel tracks_{QStringLiteral("id")};
    QHash<QString, KeyedListModel*> legs_;
    /// 追踪列表(id 的次序)上一次的样子:只在它变了时重找「查看」带来的那张卡片(React 版的 effect 依赖 snap.tracks)
    QString tracksSig_;
    int statusRev_ = 0;
    int alertsRev_ = 0;
    int previewSeq_ = 0;
    /// 停在这一页时上一次的连接状态与券商:一变就整读一遍(React 版 useEffect([connected, refreshMs]))
    bool lastConnected_ = false;
    QString lastProvider_;
    /// 「查看」带过来的标的:找到那张卡片之前,追踪列表每变一次再找一遍
    QString focusSymbol_;
    bool focusHit_ = false;
    QTimer focusTimer_;
    QString openKey_;
    QString flashId_;
    bool visible_ = false;
};

}  // namespace ibkr::shell
