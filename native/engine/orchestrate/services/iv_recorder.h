// services/ivRecorder.ts 逐句搬:当日到期期权 IV 的记录——连着 IBKR、在常规时段里,每五分钟把一圈行权价的盘口与模型 IV 记一笔(analysis 之外的日文件 fly-iv/)。
// 只读行情,不碰交易;行权价一整天不换(开盘后第一笔的现价取整作锚,标的走远了再添一对跟着现价的平值);什么时候不记都说得出原因;出错吞掉、记进 last_error。
// 期望值:tests/fixtures/gen_svc_ivrecorder.mjs(原 IvRecorderService 对着脚本驱动的假 router 与假盘口读取、真的交易库与日文件、虚拟钟现跑),tests/tst_svc_ivrecorder.cpp。
//
// 与 TS 的对应与不同:
//   · marks 是 MarksPort(svc1_ports.h)。样本 / 状态是 JS 对象(OJson,键序同 TS 的对象字面量)。
//   · tickOnce 的串行(`chain.then(...)`):TS 的 nowMs 缺省值在轮到它的时候才取(nowEt().epochMs);这里同——排队的协程轮到时才读钟。
//   · 日文件目录:dirname(settings.db_path) + "/fly-iv"(QDir 的 / 分隔,Windows 也认)。
//   · 状态里的 last_at 是 new Date(ms).toISOString()(带毫秒、Z)。
#pragma once

#include "domain/day_logs.h"
#include "orchestrate/services/svc1_ports.h"
#include "orchestrate/services/svc_host.h"

#include <QHash>

#include <memory>
#include <optional>

namespace ibkr::orchestrate {

class IvRecorderService : public SvcBase {
public:
    static inline const QString kPref = QStringLiteral("fly.iv_recorder");
    static inline const QString kSymbol = QStringLiteral("SPX");
    static constexpr int kTickMs = 30'000;
    static constexpr double kIntervalMs = 5 * 60'000;
    static constexpr double kPlanGapMs = 60'000;
    static inline const QList<double> kOffsets{-75, -50, -25, -10, 0, 10, 25, 50, 75};
    static constexpr double kRovePoints = 20;
    static constexpr double kStrikeStep = 5;

    IvRecorderService(SvcHost& host, std::shared_ptr<MarksPort> marks);
    ~IvRecorderService();

    bool enabled();
    util::OJson setEnabled(bool on);
    void start(int tickMs = kTickMs);
    void stop();
    /// 看一眼该不该记,该记就记一笔。返回这一轮记下的那一笔;没记是 null(原因在 status().idle_reason)
    util::Task<util::OJson> tickOnce(std::optional<double> nowMs = std::nullopt);
    /// 测算那一路顺带记:只记当日到期的、现价不是手动给的;同一只蝶一分钟最多一笔
    bool recordPlan(const util::OJson& sample);
    util::OJson status();

private:
    domain::IvSampleStore store2();
    util::Task<util::OJson> tickInner(double nowMs);
    util::OJson idle(const QString& reason);
    void write(const util::OJson& sample);
    double anchorFor(const QString& date, double spot);
    struct Leg {
        double strike;
        QString right;
    };
    QList<Leg> legsFor(double anchor, double spot);
    util::Task<> loop(int tickMs, int gen);

    std::shared_ptr<MarksPort> marks_;
    int timer_ = 0;
    int gen_ = 0;
    bool running_ = false;
    util::Task<> chain_ = util::Task<>::resolved();
    struct Anchor {
        QString date;
        double strike = 0;
    };
    std::optional<Anchor> anchor_;
    double lastLoopAt_ = 0;
    std::optional<double> lastAt_;
    QString idleReason_, lastError_;
    QHash<QString, double> lastPlanAt_;
    struct Counted {
        double bytes = 0, samples = 0;
    };
    QHash<QString, Counted> counted_;
    std::shared_ptr<bool> alive_ = std::make_shared<bool>(true);
};

}  // namespace ibkr::orchestrate
