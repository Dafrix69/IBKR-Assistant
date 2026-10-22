// 「情报」一页与全站共用的档案抽屉、⌘K 查标的的接线(pages/Intel.tsx、shell/DossierHost.tsx、lib/SymbolDossier.tsx):
//   · 状态都在 IntelStore(store/intel.ts 的那一份:时间线、种类、只看持仓、档案、查标的、最近查过的);这里只把它摆成三份模型;
//   · 页面自己的只有关键字(切走清掉,同原版组件卸载);进页拉一次时间线、记成看过了,人在这一页时窗口回到前台也记成看过了;
//   · 券商连没连从状态里读(没连时页头一句「没连券商」)。
// 只读,不发单:「写进指令框」「写指令」只往指令框里写(壳接过去),发不发还是指令页那两个按钮和那个确认框的事。模型在 shell/intel_page_rules
#pragma once

#include <QJsonObject>
#include <QObject>
#include <QTimeZone>

#include <functional>

namespace ibkr::shell {

class IntelStore;
class StatusStore;

class IntelController : public QObject {
    Q_OBJECT
    /// 情报页(intel::pageModel)
    Q_PROPERTY(QJsonObject page READ page NOTIFY pageChanged)
    /// 档案抽屉(intel::dossierModel);没开是空对象
    Q_PROPERTY(QJsonObject dossier READ dossier NOTIFY dossierChanged)
    Q_PROPERTY(bool lookupOpen READ lookupOpen NOTIFY dossierChanged)
    /// store 每变一次加一:查标的里的持仓与最近查过的跟着它重算(lookup() 是函数,绑定看不见它读了 store)
    Q_PROPERTY(int lookupRevision READ lookupRevision NOTIFY dossierChanged)

public:
    IntelController(IntelStore* store, StatusStore* status, QObject* parent = nullptr);

    QJsonObject page() const { return page_; }
    QJsonObject dossier() const { return dossier_; }
    bool lookupOpen() const;
    int lookupRevision() const { return revision_; }

    Q_INVOKABLE void setVisible(bool on);
    Q_INVOKABLE void setQuery(const QString& query);
    /// 种类分段:all = 不筛
    Q_INVOKABLE void setKind(const QString& kind);
    Q_INVOKABLE void setHeldOnly(bool on);
    Q_INVOKABLE void reload();
    Q_INVOKABLE void openDossier(const QString& symbol);
    Q_INVOKABLE void closeDossier();
    Q_INVOKABLE void refreshDossier();
    Q_INVOKABLE void setLookupOpen(bool open);
    /// 查标的:敲的字 → 模型(intel::lookupModel)
    Q_INVOKABLE QJsonObject lookup(const QString& text) const;
    /// 窗口回到前台(壳接过来):人在这一页就记成看过了
    void windowFocused();

    std::function<double()> now;
    QTimeZone zone = QTimeZone::systemTimeZone();

signals:
    void pageChanged();
    void dossierChanged();

private:
    void rebuild();

    IntelStore* store_;
    StatusStore* status_;
    bool visible_ = false;
    int revision_ = 0;
    /// 上一次摆页面时券商连没连(页面没开着时,只有它变了才重摆)
    bool lastConnected_ = true;
    bool pageBuilt_ = false;
    QString query_;
    QJsonObject page_;
    QJsonObject dossier_;
};

}  // namespace ibkr::shell
