// services/flyPlanner.ts 逐句搬:蝴蝶测算的编排——定日程 → 取现价 → 取三条腿的盘口与 IV → 交给 analysis/fly_plan.planFly(纯计算)。只读,不下单。
// 能离线算:没连 IBKR、现价与 IV 都手动给了,就一条行情都不取;连着 IBKR 时三条腿的盘口照取(成本与买卖价要用)。
// 期望值:tests/fixtures/gen_svc_flyplanner.mjs(原 FlyPlannerService 对着脚本驱动的假 router 与假盘口读取、虚拟钟现跑),tests/tst_svc_flyplanner.cpp。
//
// 与 TS 的对应与不同:
//   · `readonly marks = new OptionMarkStreams()`:这里是 MarksPort(svc1_ports.h;OptionMarkStreams.read 的窄面)。缺省用 makeOptionMarksPort() 包一个真的
//     execution::OptionMarkStreams;测试换成脚本驱动的。
//   · onMarks(IV 记录接在这里)是 std::function<void(const OJson& sample)>,空 = TS 的 null。sample 是 IvSample 去掉 by。
//   · 入参 FlyPlanParams / 返回 FlyPlanResult / OptionsSpot 都是 JS 对象(OJson,键序同 TS 的对象字面量)。
//   · `RIGHTS[given]` 是对象查表:给 "constructor" 这类原型键时 TS 拿到一个函数(真值),之后的行为是未定义的;C++ 按「不认识」报错。几乎碰不到。
#pragma once

#include "orchestrate/services/svc1_ports.h"
#include "orchestrate/services/svc_host.h"

#include <functional>
#include <memory>

namespace ibkr::orchestrate {

/// 真的 execution::OptionMarkStreams 包成 MarksPort(周期清扫走 runtime 的 setInterval)
std::shared_ptr<MarksPort> makeOptionMarksPort(SvcRuntime& runtime);

class FlyPlannerService : public SvcBase {
public:
    explicit FlyPlannerService(SvcHost& host);
    /// 测算的腿订上之后留一分钟(见 optionMarks.ts);留在 service 上,重连换了会话它自己会摘掉旧的
    std::shared_ptr<MarksPort> marks;
    /// 读到行情时叫一声(IV 记录接在这里)。现价是手动给的那种不叫
    std::function<void(const util::OJson& sample)> onMarks;

    util::Task<util::OJson> planFor(util::OJson params);
    /// 面板顶上那一行实时现价;取不到不抛错,原因写在 note 里
    util::Task<util::OJson> spotFor(QString symbol);

private:
    struct Spot {
        double price = 0;
        QString source, note;
    };
    struct Asked {
        std::optional<double> price;
        std::optional<util::OJson> info;
    };
    bool connected();
    QString rightOf(const util::OJson& params, double spot, QStringList& warnings);
    util::Task<Asked> askSpot(QString symbol);
    util::Task<Spot> liveSpot(QString symbol);
    QString gatewayLabel() { return u' ' + gatewayName(settings()); }
    struct Given {
        bool iv = false, cost = false;
    };
    struct Fly {
        QString symbol, expiry, tradingClass, right;
        QList<double> strikes;
    };
    util::Task<util::OJson> liveMarks(Fly fly, Given given, QStringList* warnings);
};

}  // namespace ibkr::orchestrate
