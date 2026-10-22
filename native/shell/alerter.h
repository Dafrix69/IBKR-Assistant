// 报一条提醒(React 版各 store 的 announce 那一段 + store/popup.ts + store/alerts.ts 的提示音 + main.js 的 notify 通道):
//   响一声(开着才响)→ 写进通知流(要的话)→ 交给置顶弹窗(开着才弹)→ 弹窗没收下的,补一条系统通知。
// 提醒可以样子难看,但不能没了:弹窗关着、一批太大超了上限,都退回系统通知。
// 两个开关(弹窗、声音)默认开,记在本机(React 版是 localStorage 的 dafri-alert-popup / dafri-alert-sound,这里是一个 ini)。
// 声音与系统通知由平台做(AlertOutputs:macOS 是 NSSound 与 UNUserNotificationCenter),测试换成假的。
#pragma once

#include <QJsonObject>
#include <QObject>
#include <QString>

#include <functional>

namespace ibkr::shell {

class PopupQueue;

class AlertOutputs {
public:
    virtual ~AlertOutputs() = default;
    virtual void playWav(const QByteArray& wav) = 0;
    /// 发不出去(系统不支持、没授权)返回 false
    virtual bool notify(const QString& title, const QString& body) = 0;
};

class Alerter : public QObject {
    Q_OBJECT
    Q_PROPERTY(bool popupOn READ popupOn WRITE setPopupEnabled NOTIFY prefsChanged)
    Q_PROPERTY(bool soundOn READ soundOn WRITE setSoundEnabled NOTIFY prefsChanged)
    /// 涨跌配色(green-up / red-up):弹窗里的涨跌色跟它
    Q_PROPERTY(QString updown READ updown WRITE setUpdown NOTIFY prefsChanged)

public:
    /// settingsPath:两个开关落在哪个 ini(空 = 不落盘,测试用)
    Alerter(PopupQueue* popup, AlertOutputs* outputs, QString settingsPath, QObject* parent = nullptr);

    bool popupOn() const { return popupOn_; }
    bool soundOn() const { return soundOn_; }
    QString updown() const { return updown_; }
    /// 打开时弹一条示例,确认窗口真的出得来
    void setPopupEnabled(bool on);
    /// 打开时响一声,确认真的能出声
    void setSoundEnabled(bool on);
    void setUpdown(const QString& updown);

    /// item = { id, kind, symbol, title, body, tone, at, page };direction = up / down / 空;toFeed:同时写进通知流
    Q_INVOKABLE void announce(const QJsonObject& item, const QString& direction, bool toFeed = true);
    /// 一批一起报(store/alerts.ts 的 announce 前半段):提示音一批只响一声(两条各响一遍会叠在一起削顶),弹窗一次交过去,不进通知流。
    /// 返回弹窗没收下的条数(弹窗关着 = 全部):这几条由调用方合成一条系统通知
    int announceBatch(const QJsonArray& items, const QString& direction);
    /// 只写进通知流(订单看板底下那一条;store/notify.ts 的 pushNotification)
    void pushFeed(const QString& title, const QString& body) { emit notified(title, body); }
    /// 一条弹窗;没收下就退回系统通知(剧本、关口、持仓被提到都是一次一条)
    void popupOrNotify(const QJsonObject& item, const QString& direction);
    Q_INVOKABLE void playTone(const QString& direction, bool force = false);
    /// 「试听」:降调、升调各一遍,不看开关
    Q_INVOKABLE void previewTone();
    /// 「试弹」:不看开关
    Q_INVOKABLE void testPopup();
    /// 系统通知(main.js 的 notifySystem):标题截 120、正文截 300
    Q_INVOKABLE bool systemNotify(const QString& title, const QString& body);

    std::function<double()> now;

signals:
    void prefsChanged();
    /// 写进通知流的一条
    void notified(const QString& title, const QString& body);

private:
    void save();

    PopupQueue* popup_;
    AlertOutputs* outputs_;
    QString settingsPath_;
    bool popupOn_ = true;
    bool soundOn_ = true;
    QString updown_ = QStringLiteral("green-up");
};

}  // namespace ibkr::shell
