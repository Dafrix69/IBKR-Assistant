// 三路"引擎报出来、不看当前在哪一页"的提醒(React 版 store/playbook.ts、store/quality.ts、store/intel.ts)。
//   · PlaybookStore:SPX 日内剧本。引擎报出事件(进入 / 失效 / 穿过加速档)时当场推过来;面板看得见时五秒读一次整份。
//   · QualityStore:优质股追踪的列表、阈值、心跳,以及异动提醒的落地(提示音 + 弹窗 + 通知流 + 侧栏未读数)。检测全在引擎里。
//   · IntelStore:信息链路的时间线(60 秒一拉,引擎推来新东西 2 秒后再拉)、标的档案(开着时 15 秒一刷)、
//     信任的人提到持仓的票时的提醒。
// 声音与弹窗跟 Alerter 的两个开关走;"人就在这一页、窗口也在前台"由 seeing 回答(壳给)。
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QObject>
#include <QStringList>
#include <QTimer>

#include <functional>

namespace ibkr::shell {

class Alerter;
class Bridge;
class StatusStore;

class PlaybookStore : public QObject {
    Q_OBJECT
    /// 引擎的 options.playbook 那一份;还没读到是 null
    Q_PROPERTY(QJsonValue snap READ snap NOTIFY changed)
    Q_PROPERTY(QString failure READ failure NOTIFY changed)
    /// 过线时提醒。偏好记在本机(React 版 localStorage 的 dafri-playbook-alert),默认开
    Q_PROPERTY(bool alertOn READ alertOn WRITE setAlert NOTIFY changed)

public:
    static constexpr double kRefreshMs = 5'000;

    PlaybookStore(Bridge* bridge, Alerter* alerter, QString settingsPath, QObject* parent = nullptr);
    QJsonValue snap() const { return snap_; }
    QString failure() const { return failure_; }
    bool alertOn() const { return alertOn_; }
    void start();
    void tick();
    Q_INVOKABLE void load();
    /// 面板挂上 / 卸下时调:看得见才轮询
    Q_INVOKABLE void setVisible(bool on);
    void setAlert(bool on);
    /// 开关引擎里的那个循环;结果走 enabledDone(没改成的原因,改成了是空)
    Q_INVOKABLE void setEnabled(bool on);
    void onEngineEvent(const QString& event, const QJsonValue& data);

    std::function<double()> now;

signals:
    void changed();
    void enabledDone(const QString& problem);

private:
    void announce(const QString& symbol, const QJsonObject& event);

    Bridge* bridge_;
    Alerter* alerter_;
    QString settingsPath_;
    QTimer timer_;
    QJsonValue snap_ = QJsonValue::Null;
    QString failure_;
    bool alertOn_ = true;
    bool inFlight_ = false;
    double last_ = 0;
    bool visible_ = false;
    bool started_ = false;
};

class QualityStore : public QObject {
    Q_OBJECT
    /// { stocks, config, monitor, feed, unread, loaded, max, error, loadedAt }
    Q_PROPERTY(QJsonObject snap READ snap NOTIFY changed)
    Q_PROPERTY(int unread READ unread NOTIFY changed)

public:
    static constexpr int kMax = 30;
    static constexpr int kFeedMax = 50;

    QualityStore(Bridge* bridge, StatusStore* status, Alerter* alerter, QObject* parent = nullptr);
    QJsonObject snap() const;
    int unread() const { return unread_; }
    void start();

    /// 拉一次列表。在飞的那一次没回来就合流,不叠加;then 在这一次(合流的那一次)读完后调
    void load(std::function<void()> then = {});
    Q_INVOKABLE void reload() { load(); }
    /// 结果走 added(ok)
    Q_INVOKABLE void add(const QString& symbol, const QString& note = QString());
    Q_INVOKABLE void remove(const QString& id, const QString& symbol);
    /// 先改本地(开关立刻跟手),回执回来再以它为准;失败就拨回去
    Q_INVOKABLE void toggle(const QString& id, bool enabled) { toggle(id, enabled, {}); }
    /// 同上;done 在回执回来之后调(成不成都调)
    void toggle(const QString& id, bool enabled, std::function<void()> done);
    /// 和当前那份合并成完整的一份交给引擎;结果走 configSaved(ok)
    Q_INVOKABLE void saveConfig(const QJsonObject& partial);
    Q_INVOKABLE void markSeen();
    void onEngineEvent(const QString& event, const QJsonValue& data);

    std::function<double()> now;
    /// 人就在这一页、窗口也在前台(React 版 getTab() === 'quality' && document.hasFocus())
    std::function<bool(const QString& page)> seeing;

signals:
    void changed();
    void added(bool ok);
    void configSaved(bool ok);

private:
    void onAnomaly(const QJsonValue& data);
    void showError(const QString& text);
    void showInfo(const QString& text);

    Bridge* bridge_;
    StatusStore* status_;
    Alerter* alerter_;
    QJsonArray stocks_;
    QJsonValue config_ = QJsonValue::Null;
    QJsonValue monitor_ = QJsonValue::Null;
    QJsonArray feed_;
    int unread_ = 0;
    bool loaded_ = false;
    int max_ = kMax;
    QString error_;
    double loadedAt_ = 0;
    bool started_ = false;
    bool seeded_ = false;
    bool inFlight_ = false;
    QList<std::function<void()>> waiting_;
    QString lastLoadError_;
    /// 增删改的代数:一次读列表在飞的途中若有人改过,它带回来的就是旧列表,不能拿去覆盖本地
    int generation_ = 0;
};

class IntelStore : public QObject {
    Q_OBJECT
    /// { feed, feedError, loading, kinds, heldOnly, unread, dossier, lookupOpen, recent }
    Q_PROPERTY(QJsonObject state READ state NOTIFY changed)
    Q_PROPERTY(int unread READ unread NOTIFY changed)

public:
    static constexpr int kFeedRefreshMs = 60'000;
    static constexpr int kDossierRefreshMs = 15'000;
    static constexpr int kUnconnectedRetryMs = 5'000;
    static constexpr int kUnconnectedRetries = 24;
    static constexpr int kRefetchDelayMs = 2'000;

    /// settingsPath:最近查过的标的落在哪个 ini(空 = 不落盘)
    IntelStore(Bridge* bridge, Alerter* alerter, QString settingsPath, QObject* parent = nullptr);
    QJsonObject state() const;
    int unread() const { return unread_; }
    void start();

    Q_INVOKABLE void loadFeed();
    Q_INVOKABLE void setKinds(const QStringList& kinds);
    Q_INVOKABLE void setHeldOnly(bool on);
    Q_INVOKABLE void markSeen();
    Q_INVOKABLE void openDossier(const QString& raw);
    Q_INVOKABLE void refreshDossier();
    Q_INVOKABLE void closeDossier();
    Q_INVOKABLE void setLookupOpen(bool open);
    void onEngineEvent(const QString& event, const QJsonValue& data);

    std::function<double()> now;
    std::function<bool(const QString& page)> seeing;
    int retryMs = kUnconnectedRetryMs;
    int refetchMs = kRefetchDelayMs;

signals:
    void changed();

private:
    void fetchDossier(const QString& symbol);
    void onHeldMention(const QJsonValue& data);
    void scheduleRefetch();

    Bridge* bridge_;
    Alerter* alerter_;
    QString settingsPath_;
    QTimer feedTimer_;
    QTimer dossierTimer_;
    QTimer refetch_;
    QJsonValue feed_ = QJsonValue::Null;
    QJsonValue feedError_ = QJsonValue::Null;
    bool loading_ = false;
    QStringList kinds_;
    bool heldOnly_ = false;
    int unread_ = 0;
    /// { symbol, data, error, loading };没开是 null
    QJsonValue dossier_ = QJsonValue::Null;
    bool lookupOpen_ = false;
    QStringList recent_;
    bool feedBusy_ = false;
    bool started_ = false;
    int unconnectedRetries_ = 0;
    int dossierSeq_ = 0;
};

}  // namespace ibkr::shell
