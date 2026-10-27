// 「板块」一页的接线(pages/Sectors.tsx 与它的子组件):
//   · 进页即刷板块(读完再刷行情)、价位、异动,并把异动未读清掉;行情每 30 秒一轮(要已连券商),异动每 5 秒重读一次
//     (本地道,只读库和内存),窗口在前台才清未读;心跳那一行每秒重算一次(「已经多少秒没跳了」随时间变);
//   · 板块卡片上的选股着、行上拨着的开关、正在改的标签是页面自己的状态,卸下就清(原版组件卸载);
//   · 触发条件与碰均线:改完 600 毫秒防抖再存(逐字存会把 2.5 先存成 2),离开页面时还有没存的立刻存;
//     本地那份先跟手,引擎那份变了且没有待存的改动才跟上;
//   · 弹窗「查看」跳过来指认某一只:那一行滚到眼前、闪一下,2.2 秒后清掉。
// 模型在 shell/sectors_rules,板块的增删改在 shell/sectors_store
#pragma once

#include "shell/keyed_list_model.h"
#include "shell/level_strip.h"

#include <QJsonObject>
#include <QObject>
#include <QSet>
#include <QTimeZone>
#include <QTimer>

#include <functional>

namespace ibkr::shell {

class Alerter;
class AlertsStore;
class QualityStore;
class SectorsStore;
class StatusStore;

class SectorsController : public QObject {
    Q_OBJECT
    Q_PROPERTY(QJsonObject page READ page NOTIFY pageChanged)
    Q_PROPERTY(QJsonObject earnings READ earnings NOTIFY earningsChanged)
    Q_PROPERTY(QJsonObject discipline READ discipline CONSTANT)
    /// 板块卡片(按 id 原地更新:5 秒一轮的重读不把卡片里敲了一半的代码、滚到一半的列表清掉)
    Q_PROPERTY(QObject* cards READ cards CONSTANT)

public:
    static constexpr int kQuotesMs = 30'000;
    static constexpr int kPoolMs = 5'000;
    static constexpr int kSaveDelayMs = 600;

    SectorsController(SectorsStore* sectors, AlertsStore* alerts, QualityStore* quality, StatusStore* status, Alerter* alerter, QObject* parent = nullptr);

    QJsonObject page() const { return page_; }
    QJsonObject earnings() const;
    QJsonObject discipline() const;
    Q_INVOKABLE void refreshEarnings(const QString& symbol);
    QObject* cards() { return &cards_; }
    /// 某个板块的成分股行(按代码原地更新);没有这个板块是 null
    Q_INVOKABLE QObject* rowsModel(const QString& sectorId) const { return rows_.value(sectorId, nullptr); }

    Q_INVOKABLE void setVisible(bool on);
    /// 窗口回到前台:原版挂了 window 'focus' 的监听,人一回来就算看过异动(不等下一个 5 秒)
    void windowFocused();
    Q_INVOKABLE void refreshQuotes();
    /// 新建板块(成了发 sectorCreated,输入框清空)
    Q_INVOKABLE void createSector(const QString& name);
    Q_INVOKABLE void deleteSector(const QString& id, const QString& name);
    Q_INVOKABLE void pick(const QString& sectorId);
    /// 手动添加(去两头空白转大写;成了发 stockAdded(sectorId),那张卡片的两个输入框清空)
    Q_INVOKABLE void addStock(const QString& sectorId, const QString& symbol, const QString& tag);
    Q_INVOKABLE void removeStock(const QString& sectorId, const QString& symbol);
    /// 拨开关:which = price / anomaly
    Q_INVOKABLE void toggle(const QString& symbol, const QString& which, bool on);
    Q_INVOKABLE void editTag(const QString& sectorId, const QString& symbol);
    /// 回车 / 失焦提交(commit),Esc 不提交;一次编辑只收一次
    Q_INVOKABLE void finishTag(const QString& sectorId, const QString& symbol, const QString& draft, bool commit);
    Q_INVOKABLE void refreshWatch(const QString& id, const QString& expiry = QString(), const QVariant& step = QVariant());
    Q_INVOKABLE void setPopupEnabled(bool on);
    Q_INVOKABLE void setSoundEnabled(bool on);
    Q_INVOKABLE void testPopup();
    Q_INVOKABLE void previewTone();
    /// 触发条件改了一项(part 只带改的那几个键):先跟手,600 毫秒后存
    Q_INVOKABLE void patchConditions(const QJsonObject& part);
    /// 碰均线:now = 开关、选均线这种一下就定的,立刻存
    Q_INVOKABLE void patchTouch(const QJsonObject& part, bool now = false);
    Q_INVOKABLE void setCrossConfirm(bool barClose);
    /// 弹窗「查看」跳过来:指认那一只(滚到眼前、闪一下)
    Q_INVOKABLE void focus(const QString& symbol);
    /// 价位条在这个宽度下的样子(shell/level_strip;字宽由壳给的 measure 量)
    Q_INVOKABLE QJsonObject levelStrip(const QJsonArray& levels, const QVariant& spot, double width) const;

    std::function<double()> now;
    QTimeZone zone = QTimeZone::systemTimeZone();
    /// 窗口在前台(document.hasFocus()):在前台时每一轮清掉异动未读
    std::function<bool()> windowActive;
    int quotesMs = kQuotesMs, poolMs = kPoolMs, saveDelayMs = kSaveDelayMs, focusMs = 2200;
    levels::Measure measure = levels::measureFixed;

signals:
    void pageChanged();
    void earningsChanged();
    void sectorCreated();
    void stockAdded(const QString& sectorId);
    /// 把这一只的行滚到眼前
    void reveal(const QString& symbol);

private:
    /// 进页那一段(读板块→行情、价位、异动,清未读,节拍从头数);连上 / 断开时也跑这一段
    void mount();
    void rebuild();
    void flushConditions();
    void flushTouch();
    bool connected() const;

    SectorsStore* sectors_;
    AlertsStore* alerts_;
    QualityStore* quality_;
    StatusStore* status_;
    Alerter* alerter_;
    QTimer quotesTimer_, poolTimer_, tick_, condTimer_, touchTimer_, focusTimer_;
    bool visible_ = false;
    int generation_ = 0;

    QSet<QString> picking_;
    QJsonObject busy_;
    QString editingTag_, editingSector_;
    bool lastConnected_ = false;
    KeyedListModel cards_{QStringLiteral("id")};
    QHash<QString, KeyedListModel*> rows_;
    bool tagDone_ = false;
    QString focusSymbol_;
    /// 触发条件 / 碰均线:页面上那一份(跟手的草稿)与还没存的改动
    QJsonValue condDraft_ = QJsonValue::Null, touchDraft_ = QJsonValue::Null;
    QJsonObject condDirty_, touchDirty_;
    QJsonValue lastCondConfig_, lastTouchConfig_;

    QJsonObject page_;
};

}  // namespace ibkr::shell
