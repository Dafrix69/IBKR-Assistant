// 顶栏宏观行情带(React 版 store/macro.ts + shell/MacroStrip.tsx 的取值与格式化):公开数据 + TWS 流式,只读展示,不参与定价。
// 连了 TWS 才值得秒级:那时 7 格走常驻流式订阅,2 秒一读;没连时全走公开源,一分钟一读(那个端点本身不是秒级的,刷快了只会被限流)。
// 每格留本次开机以来最近 90 个不同读数,画迷你走势;只在内存里。界面要的每一格写什么在这里算好(rows),QML 只摆。
#pragma once

#include <QHash>
#include <QJsonArray>
#include <QObject>
#include <QTimer>

#include <functional>

namespace ibkr::shell {

class Bridge;
class StatusStore;

class MacroStore : public QObject {
    Q_OBJECT
    /// 每格:{ key, label, inst, stale, value, live, dir(up/down/flat/空), chg, tip, trail(数组,不到 3 个是空), tint(up/down/gray) }
    Q_PROPERTY(QJsonArray rows READ rows NOTIFY changed)
    /// 一个数都没有时整条收起
    Q_PROPERTY(bool hidden READ hidden NOTIFY changed)

public:
    static constexpr int kTrailMax = 90;
    MacroStore(Bridge* bridge, StatusStore* status, QObject* parent = nullptr);

    QJsonArray rows() const { return view_; }
    bool hidden() const { return hidden_; }
    void start();
    Q_INVOKABLE void load(bool force = false);
    /// 一拍(定时器在跑;测试直接调)
    void tick();

    /// 现在几点(毫秒);测试换掉它
    std::function<double()> now;
    /// 节拍(毫秒);测试改小
    int tickMs = 1000;

signals:
    void changed();

private:
    void apply(const QJsonArray& raw);

    Bridge* bridge_;
    StatusStore* status_;
    QTimer timer_;
    bool inFlight_ = false;
    double last_ = 0;
    QHash<QString, QList<double>> trails_;
    QJsonArray view_;
    bool hidden_ = true;
};

}  // namespace ibkr::shell
