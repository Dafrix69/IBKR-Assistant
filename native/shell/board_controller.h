// 「订单看板」的接线(pages/Board.tsx):进页即读条件单与交易记录、停在这一页时 15 秒一轮;「刷新」= 状态 + 记录 + 条件单。
// 模型在 shell/order_rules。通知流(store/notify.ts)也只有这一份:引擎的 notification 事件、连接 / 熔断的动作、提醒都往这里写,最多 60 条。
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QObject>
#include <QTimeZone>
#include <QTimer>

#include <functional>

namespace ibkr::shell {

class PendingStore;
class RecordsStore;
class StatusStore;

class BoardController : public QObject {
    Q_OBJECT
    Q_PROPERTY(QJsonObject model READ model NOTIFY modelChanged)

public:
    static constexpr int kRefreshMs = 15'000;

    BoardController(StatusStore* status, RecordsStore* records, PendingStore* pending, QObject* parent = nullptr);
    QJsonObject model() const { return model_; }
    Q_INVOKABLE void setVisible(bool on);
    Q_INVOKABLE void refresh();
    /// pushNotification(title, body):最新的在最前,最多留 60 条;钟点同 toLocaleTimeString('zh-CN', { hour12: false })
    Q_INVOKABLE void pushNotification(const QString& title, const QString& body = QString());
    QJsonArray feed() const { return feed_; }

    std::function<double()> now;
    QTimeZone localZone = QTimeZone::systemTimeZone();
    int refreshMs = kRefreshMs;

signals:
    void modelChanged();

private:
    void rebuild();
    StatusStore* status_;
    RecordsStore* records_;
    PendingStore* pending_;
    QJsonArray feed_;
    QJsonObject model_;
    QTimer timer_;
    bool visible_ = false;
};

}  // namespace ibkr::shell
