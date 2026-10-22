// 引擎状态:全站共用的一份快照,照 desktop/renderer-react/src/store/status.ts 搬。
//
// - 5 秒一轮,上一轮没回来绝不叠加(旧界面曾在管道里攒出 159 个待处理的 system.status)。
// - 引擎说熔断了 / 起来了 / 设置变了 / 排队单变了 / 券商连上断开了(breaker、ready、settings、pending、broker_link),当场再问一次。
// - 引擎报的错、引擎退出与它为什么退出,落到横幅上——只剩一个圆点变红没人知道发生了什么。
// - 轮询在这里,不挂在 QML 页面上:切走页面也照跑(同 CLAUDE.md 的"轮询循环只能在 store/ 里")。
//
// 横幅上的字过一遍 util::maskAccountLikeIds:引擎 stderr 的尾巴会进横幅,横幅会被截图发出去。
#pragma once

#include "shell/engine_client.h"

#include <QJsonObject>
#include <QObject>
#include <QTimer>

#include <functional>
#include <vector>

namespace ibkr::shell {

class StatusStore : public QObject {
    Q_OBJECT
    Q_PROPERTY(QJsonObject status READ status NOTIFY statusChanged)
    /// -1 还没问过,0 不答话 / 没在跑,1 正常
    Q_PROPERTY(int engineOk READ engineOk NOTIFY engineOkChanged)
    Q_PROPERTY(QString banner READ banner NOTIFY bannerChanged)
    /// 横幅是提示类(6 秒自己走)还是错误类(留着等人看),同 store/banner.ts 的 info
    Q_PROPERTY(bool bannerInfo READ bannerInfo NOTIFY bannerChanged)
    /// 顶栏每一格写什么(shell/topbar_state.h):状态或引擎状态一变就重算
    Q_PROPERTY(QJsonObject topbar READ topbar NOTIFY topbarChanged)

public:
    explicit StatusStore(EngineClient* engine, int pollMs = 5000, QObject* parent = nullptr);

    QJsonObject status() const { return status_; }
    int engineOk() const { return engineOk_; }
    QString banner() const { return banner_; }
    bool bannerInfo() const { return bannerInfo_; }
    QJsonObject topbar() const;

    void startPolling();
    /// 问一次;上一次还没回来时什么都不做(合流到那一次)
    Q_INVOKABLE void refresh() { refresh({}); }
    /// 同上,问完(成不成都算)再调 done;合流到上一次时等的就是那一次(同 store/status.ts 的 refreshStatus 回同一个 Promise)
    void refresh(std::function<void()> done);
    /// 正在问的那一次还没回来
    bool inFlight() const { return inFlight_; }

    /// 引擎退出了(supervisor 的 engineExited / fatal 接过来)。fatalKind:"config" / "store" / 空
    void engineExited(const QString& fatalKind, const QString& detail);
    /// 不是引擎说的、但要让人看见的一句(另一个版本正在跑、拉不起来之类)
    void showBanner(const QString& text);
    /// 人点了横幅上的关闭(同一条下一轮还会再来,同 store/banner.ts)
    Q_INVOKABLE void hideBanner();
    /// 提示类:6 秒后自己收起
    Q_INVOKABLE void showInfo(const QString& text);
    /// 错误类(界面上的操作失败)
    Q_INVOKABLE void showError(const QString& text) { showBanner(text); }

signals:
    void statusChanged();
    void engineOkChanged();
    void bannerChanged();
    void topbarChanged();

private:
    void onEvent(const QString& event, const QJsonValue& data);
    void announceBreaker(const QJsonObject& next);
    void setEngineOk(int value);
    void setBanner(const QString& text, bool info = false);

    EngineClient* engine_;
    QTimer poll_;
    QJsonObject status_;
    int engineOk_ = -1;
    QString banner_;
    bool bannerInfo_ = false;
    QTimer infoTimer_;
    bool inFlight_ = false;
    std::vector<std::function<void()>> waiters_;
    /// 上一轮的熔断状态:只在跳变时说话
    bool engaged_ = false;
};

}  // namespace ibkr::shell
