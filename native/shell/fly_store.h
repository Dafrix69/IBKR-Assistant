// 蝴蝶测算:表单、最近一次结果、自动刷新(store/flyPlan.ts,逐步搬)。
//
// 为什么放在 store:壳一次只挂载一页,去「持仓追踪」看一眼再回来,填好的一排数字不能没了。
// **自动刷新只在面板看得见的时候跑**(10 秒一次):IV 是实时在变的,但每刷一次引擎要读三条腿的行情,人不在这一页还刷是白占行情线路。
// 只算不下单:options.fly_plan 只读行情;入参照 flyPlanForm.ts 的 toParams(过引擎的 strict schema)。
// 每一步之后的状态由 tests/fixtures/gen_fly_plan.mjs 跑原 store 记下来,tst_fly_store 逐步对。
#pragma once

#include "shell/engine_client.h"

#include <QJsonObject>
#include <QObject>
#include <QTimer>

#include <functional>

namespace ibkr::shell {

class Bridge;

namespace fly {
struct StoreDeps {
    using Reply = std::function<void(const EngineReply&)>;
    /// options.fly_plan
    std::function<void(const QJsonObject& params, Reply)> plan;
    /// options.iv_recorder / options.iv_recorder_set
    std::function<void(Reply)> recorder;
    std::function<void(bool enabled, Reply)> setRecorder;
    /// 本机时钟(毫秒):「算于」那一刻
    std::function<double()> nowMs;
};
}  // namespace fly

class FlyStore : public QObject {
    Q_OBJECT
    /// { form, busy, result, failure, resultFor, auto, at, recorder }(同 store/flyPlan 的 plan)
    Q_PROPERTY(QJsonObject plan READ plan NOTIFY changed)

public:
    static constexpr int kAutoRefreshMs = 10'000;

    FlyStore(fly::StoreDeps deps, QObject* parent = nullptr);
    /// 正式接线:经桥调引擎(回包带这个 store 当 context:store 先没了就丢掉)
    explicit FlyStore(Bridge* bridge, QObject* parent = nullptr);
    static fly::StoreDeps bridgeDeps(Bridge* bridge, QObject* context);

    QJsonObject plan() const;
    Q_INVOKABLE void patch(const QJsonObject& part);
    Q_INVOKABLE void reset();
    /// quiet = 自动刷新那一路:不清掉屏幕上的结果,失败了把自动刷新关掉
    Q_INVOKABLE void run(bool quiet = false);
    Q_INVOKABLE void setAuto(bool on);
    /// 面板挂上 / 卸下时调
    Q_INVOKABLE void setVisible(bool on);
    Q_INVOKABLE void loadRecorder();
    /// 结果走 recorderDone(没改成的原因;改成了是空)
    Q_INVOKABLE void setRecorder(bool enabled);

    /// 自动刷新的间隔(测试改短)
    int autoRefreshMs = kAutoRefreshMs;
    /// 把几样合进状态里(同原版的 set;测试拿它摆出"已经开着自动刷新"之类的起点)
    void set(const QJsonObject& part);

signals:
    void changed();
    void recorderDone(const QString& problem);

private:
    void sync();

    fly::StoreDeps deps_;
    QJsonObject plan_;
    bool visible_ = false;
    QTimer timer_;
};

}  // namespace ibkr::shell
