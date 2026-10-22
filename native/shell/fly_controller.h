// 交易指令页右栏两面的接线(lib/FlyPlanner.tsx 与 lib/PlaybookPanel.tsx 的 effect 与按钮):
//   · 模型(shell/fly_rules)在测算的表单 / 结果、SPX 现价、状态、重要事件、日内剧本任何一样变了时重算;
//   · 面板挂上 / 卸下告诉各个 store(自动刷新、现价、剧本都只在看得见时轮询);进面板先问一次 IV 记录器;
//   · 「写进指令」只是把这只蝶写成一句话接进左边的输入框(不发单),横幅提醒先解析再决定发不发。
#pragma once

#include <QJsonObject>
#include <QObject>
#include <QTimeZone>

namespace ibkr::shell {

class EventsStore;
class FlyStore;
class PlaybookStore;
class SpotStore;
class StatusStore;
class TradeComposer;

class FlyController : public QObject {
    Q_OBJECT
    Q_PROPERTY(QJsonObject planner READ planner NOTIFY plannerChanged)
    Q_PROPERTY(QJsonObject playbook READ playbook NOTIFY playbookChanged)

public:
    FlyController(FlyStore* fly, SpotStore* spot, StatusStore* status, EventsStore* events, PlaybookStore* playbook, TradeComposer* composer,
                  QObject* parent = nullptr);

    QJsonObject planner() const { return planner_; }
    QJsonObject playbook() const { return playbook_; }

    Q_INVOKABLE void setPlannerVisible(bool on);
    Q_INVOKABLE void setPlaybookVisible(bool on);
    Q_INVOKABLE void patch(const QJsonObject& part);
    /// 点关口 = 把它填进「中心行权价」
    Q_INVOKABLE void pickLevel(double level);
    /// 时刻快捷钮:填进到达时刻,日期清空(今天)
    Q_INVOKABLE void pickTime(const QString& hhmm);
    /// 第几个时刻快捷钮:按此刻现算(30 分钟后 / 1 小时后 / 2 小时后 / 15:45)
    Q_INVOKABLE void pickChip(int index);
    Q_INVOKABLE void writeInstruction();
    Q_INVOKABLE void toggleRecorder(bool on);
    /// 走到 25 的整数倍时提醒(偏好记在本机,同 SpotStore)
    Q_INVOKABLE void setSpotAlert(bool on);
    Q_INVOKABLE void setPlaybookAlert(bool on);
    Q_INVOKABLE void setPlaybookEnabled(bool on);

    std::function<double()> now;
    QTimeZone localZone = QTimeZone::systemTimeZone();

signals:
    void plannerChanged();
    void playbookChanged();

private:
    void rebuildPlanner();
    void rebuildPlaybook();

    FlyStore* fly_;
    SpotStore* spot_;
    StatusStore* status_;
    EventsStore* events_;
    PlaybookStore* playbookStore_;
    TradeComposer* composer_;
    QJsonObject planner_;
    QJsonObject playbook_;
};

}  // namespace ibkr::shell
