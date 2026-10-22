// 「交易分析」一页的接线(pages/Review.tsx 的状态与取数,store/review.ts 的跨页入口):
//   · 原版状态都在组件里(切走就卸载):setVisible(false) 清空;选中的那一笔、周期、EM、类型记在本机(review/record、review/timeframe、
//     review/em-manual、review/kind),回来照读;
//   · 进页读候选(review.candidates,最多 200 笔;附带本地未成交的开关一变就重读);读回来的选中那一笔还在就留着,不在了退到第一笔;
//     新鲜度一行只在它还是「—」或上一次读候选写的那句时才换(分析之后写的那句不被冲掉);
//   · 筛了类型之后选中的那笔不在列表里:退到列表第一笔;
//   · 分析:没选就提示;记下选中、周期、EM;EM 空着不带(引擎取开仓那天剧本记的期权定价);失败清掉上一次的结果;
//   · 交易记录详情里点「分析这笔交易」(request):选中那一张,读候选;默认列表里没有它就打开「附带本地」再读,然后直接分析。
// 不下单:这一页只碰 review.candidates / review.analyze。模型在 shell/review_rules
#pragma once

#include "shell/review_rules.h"

#include <QObject>
#include <QVariant>

#include <functional>

namespace ibkr::shell {

class Bridge;
class ChartSource;
class StatusStore;

class ReviewController : public QObject {
    Q_OBJECT
    Q_PROPERTY(QJsonObject page READ page NOTIFY pageChanged)
    Q_PROPERTY(QObject* stockChart READ stockChart CONSTANT)
    Q_PROPERTY(QObject* underlyingChart READ underlyingChart CONSTANT)
    Q_PROPERTY(QObject* flyChart READ flyChart CONSTANT)

public:
    ReviewController(Bridge* bridge, StatusStore* status, QString settingsPath, QObject* parent = nullptr);

    QJsonObject page() const { return page_; }
    QObject* stockChart() const;
    QObject* underlyingChart() const;
    QObject* flyChart() const;

    Q_INVOKABLE void setVisible(bool on);
    Q_INVOKABLE void setKind(const QString& kind);
    Q_INVOKABLE void select(const QString& id);
    Q_INVOKABLE void setTimeframe(const QString& tf);
    Q_INVOKABLE void setEm(const QVariant& em);
    Q_INVOKABLE void setIncludeLocal(bool on);
    /// 「同步成交」:重读候选(引擎顺手向 TWS 要最近 7 天的成交)
    Q_INVOKABLE void sync();
    /// 「分析」
    Q_INVOKABLE void analyze();
    /// 交易记录详情里的「分析这笔交易」:页面挂上之后(或已经挂着时马上)选中它并分析
    Q_INVOKABLE void request(const QString& recordId);

    std::function<double()> now;
    QTimeZone zone = QTimeZone::systemTimeZone();

signals:
    void pageChanged();

private:
    void reset();
    void rebuild();
    void write(const QString& key, const QString& value) const;
    QString read(const QString& key) const;
    /// keep:要保住的那一张(从交易记录跳过来的);done 拿到读回来的列表(失败是空的)
    void loadCandidates(bool local, const QString& keep, std::function<void(const QJsonArray&)> done = {});
    void run(const QString& id);
    void handleRequest();
    void fallBackIfFiltered();

    Bridge* bridge_;
    StatusStore* status_;
    ChartSource* stockChart_;
    ChartSource* underlyingChart_;
    ChartSource* flyChart_;
    QString settingsPath_;
    bool visible_ = false;
    int generation_ = 0;
    QString pendingRequest_;

    review::PageInput in_;
    QJsonObject page_;
};

}  // namespace ibkr::shell
