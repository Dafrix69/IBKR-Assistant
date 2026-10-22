// 提醒弹窗(desktop/popup-window.js)里与窗口无关的那一半:内容清洗、摆在哪、列表怎么合并。
// 期望值由 node 跑原模块现算(tests/fixtures/gen_popup.mjs)。窗口本身在 app/ 里(Qt 里弹窗与主窗口同一进程,
// Electron 版那套"页面就绪 / 预加载出错"的看门狗没有对应物)。
//
// 内容来自行情与用户填的标的:只剩白名单字段、长度有上限的纯数据;控制字符换成空格,零宽与双向控制字符去掉
// (后者能把「下破」排成「破下」一类的视觉欺骗)。
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QObject>
#include <QRect>
#include <QRectF>

#include <functional>

namespace ibkr::shell {

namespace popup {
inline constexpr int kWidth = 360;
inline constexpr int kMargin = 12;
inline constexpr int kMinHeight = 96;
inline constexpr double kMaxHeightRatio = 0.7;
inline constexpr int kMaxItems = 30;
inline constexpr int kMaxIncoming = kMaxItems;
inline constexpr int kNotifyFallbackMax = 5;

struct Sanitized {
    QJsonArray items;
    QString updown;
    int dropped = 0;
};
/// id 只留字母数字与 _:.-|+,截到 100
QString cleanId(const QJsonValue& value);
/// now:at 不是有限数时用它
Sanitized sanitizePayload(const QJsonValue& payload, double now);
/// 工作区右上角,边距 12,宽 360;高度夹在 [96, 工作区高 × 0.7]
QRect bounds(const QRectF& workArea, double contentHeight);
}  // namespace popup

/// 弹窗里的那张列表:按 id 去重替换、按时间新的在前、最多 30 条。显示与收起由窗口那头看 items 是否为空。
class PopupQueue : public QObject {
    Q_OBJECT
    Q_PROPERTY(QJsonArray items READ items NOTIFY changed)
    Q_PROPERTY(QString updown READ updown NOTIFY changed)

public:
    struct Counts {
        int shown = 0;
        int dropped = 0;
    };
    explicit PopupQueue(QObject* parent = nullptr);
    QJsonArray items() const { return items_; }
    QString updown() const { return updown_; }

    /// 收下几条、丢了几条:调用方据此给没收下的补系统通知(这个数必须诚实)
    Counts push(const QJsonValue& payload);
    Q_INVOKABLE bool dismiss(const QString& id);
    Q_INVOKABLE void clear();
    /// 「查看」:叫主窗口到前台、跳到对应页(缺省 quality),再关掉这一条
    Q_INVOKABLE bool open(const QString& id);

    std::function<double()> now;

signals:
    void changed();
    /// 有新条目进来(窗口要露面 / 提到最上层、Dock 跳)
    void arrived();
    void navigateRequested(const QString& page, const QString& symbol);

private:
    QJsonArray items_;
    QString updown_ = QStringLiteral("green-up");
};

}  // namespace ibkr::shell
