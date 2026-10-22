// services/playbook.ts 逐句搬:SPX 日内剧本的编排——什么时候取哪一条预期波动区间(昨日口径收盘后十分钟、盘初口径 09:35、当前口径每五分钟)、
// 锚、没赶上的从历史分钟线补、换了当前区间就换一份期权墙、把现价喂给状态机、事件落到日底账并推给界面、snapshot()、开关存在偏好表里。
// 纯规则在 analysis/playbook,日底账在 domain/day_logs(PlaybookLog,两边都是真的,写在 <db 所在目录>/playbook);这里管编排。
// 期望值:tests/fixtures/gen_svc_playbook.mjs(原 TS 服务现跑,假宿主按脚本答、每一次调用都记下来,最后把写出来的底账文件逐个比)。
//
// 与 TS 的对应与不同:
//   · 行情是 MarketDataPort(只用 wallFor),盘口是 MarksPort(OptionMarkStreams.read 的窄面),券商的四样(indexPrice / spotInfo / marketSession /
//     historicalBars)走 RouterPort(svc_host.h);router 每次从宿主现取。IB 会话是 execution::IbSession。
//   · TS 的 tickOnce 是 `chain.then(() => tickInner(...))`:链空着时 tickInner 也要晚一个微任务才开始;C++ 当场开始(Task 是立刻跑的)。
//     只在"一个 tickOnce 启动之后、到下一次让出之前,宿主上又同步改了东西"时才看得出——对拍脚本里每个 start 的调用后面紧跟 advance / await。
//     链上排队的第二个 tickOnce 等第一个落定:第一个的调用方先接着跑(循环里的 schedule(tickMs)),队里的下一个再开始——和 JS 里
//     run.catch(...) 多一跳微任务的次序一致(落定回调排在等待者之后)。
//   · TS 里 `this.day` 是对象引用,tickInner 的局部 `day` 在 await 之间一直指着那个对象,即使中途 snapshot()/dayFor 把 this.day 换成了别的日子;
//     C++ 用 shared_ptr<Day>,每个协程拿一份拷贝,同样"改的是旧的那一份"。
//   · 底账里读回来的区间 / 事件在 TS 里是原样的 JS 对象(多出来的键、键序都带进 snapshot);C++ 把原样的 OJson 跟着区间一起存(BandRec.raw / Day.events),
//     算用结构体,输出用原样。今日区间 = {...current, anchor, lower, upper, source}:从 current 的原样拷一份再改这四个键,键序同展开。
//     锚与状态机落盘的那一条是结构体(锚只有 at / price / source 三个键,不会被输出)。
//   · PlaybookWall 由期权墙的 11 个字段拼出来(键序同 TS);期权墙缺键在 TS 里是 undefined,这里当 null——脚本只给完整的期权墙(analyze 现算的)。
//     期权墙本身是 null(TS:Cannot read properties of null (reading 'expiry'))照抛同一句。strikes 里 strike / net_gex 按 JS 的 Number() 读。
//   · notes 是 Partial<Record<BandKind,string>>,snapshot().notes 是 Object.values:用 OJson 对象存(set 保位置、remove 删、再加排在最后)。
//   · timer.unref():没有对应。start 的 gen / running / schedule 照 TS;timer 句柄留着不清(同 TS:触发之后 clearTimeout 一个旧句柄是空操作)。
//   · Date.now() 本身没用到(只有 nowEt());(exc as Error).message.slice(0, n) → svc1::excMessage(...).left(n)。
//   · 协程是成员函数,参数一律传值:PlaybookService 必须活得比所有未完成的调用长(同 TS 闭包抓着 this)。
//   · TS 原样:emit("playbook", …) 里的 snapshot 是在 idleReason / lastError 清空**之前**拍的;snapshot() 自己会按**时钟**的日子(nowEt)换 this.day,
//     不是按 tick 传进来的 nowMs;09:35 之前 indexPrice / spotInfo 照样先调;capturePrior / liveBand 里的 marketSession() 不在 try 里
//     (抛了落到 tickInner 的 catch:last_error + 「上一轮出错了」),backfill* 里的在 try 里(写进 notes)。
#pragma once

#include "analysis/playbook.h"
#include "domain/day_logs.h"
#include "orchestrate/services/svc1_ports.h"

#include <QString>

#include <map>
#include <memory>
#include <optional>
#include <variant>
#include <vector>

namespace ibkr::orchestrate {

class PlaybookService : public Svc1Base {
public:
    PlaybookService(Svc1Host& host, MarksPort& marks, MarketDataPort& market) : Svc1Base(host), marks_(marks), market_(market) {}

    static inline const QString kPref = QStringLiteral("playbook");
    static inline const QString kSymbol = QStringLiteral("SPX");
    /// 循环多久看一眼现价
    static constexpr int kTickMs = 5'000;
    /// 当前区间多久重取一次(分钟)
    static constexpr double kFrameMin = 5;
    /// 盘初口径的时刻(美东当日分钟数)
    static constexpr double kOpenMin = 9 * 60 + 35;
    /// 09:35:00 之后这么久之内读到的现价算「09:35 的价」:循环的两拍
    static constexpr double kLiveAnchorMs = 2.0 * kTickMs;
    /// 昨日口径:收盘后多少分钟取,以及这个窗口开多久
    static constexpr double kPriorDelayMin = 10;
    static constexpr double kPriorWindowMin = 5;
    /// 取盘口失败后隔多久再试;补历史价失败后隔多久再试
    static constexpr double kRetryMs = 30'000;
    static constexpr double kBackfillRetryMs = 10 * 60'000;
    /// 期权墙最多取现价上下各多少档
    static constexpr double kWallWidth = 15;
    static constexpr qsizetype kMaxEvents = 50;

    bool enabled();
    /// 回 PlaybookSnapshot(松的 JSON,键序同 TS)
    util::OJson setEnabled(bool on);

    void start(int tickMs = kTickMs);
    void stop();

    /// 看一眼:该取区间就取,有现价就喂状态机。返回这一轮报出来的事件(PlaybookEvent 的数组)。nowMs 空 = 此刻(nowEt().epochMs,轮到它的时候才取)
    util::Task<util::OJson> tickOnce(std::optional<double> nowMs = std::nullopt);

    util::OJson snapshot();

private:
    struct BandRec {
        analysis::playbook::Band b;
        util::OJson raw;
    };
    struct Day {
        QString date;
        std::optional<BandRec> prior;
        std::optional<analysis::playbook::Anchor> anchor;
        std::optional<BandRec> open, current;
        analysis::playbook::Machine machine;
        std::vector<util::OJson> events;
        std::optional<util::OJson> wall;
        std::optional<analysis::playbook::Accel> accel;
        /// 哪一样为什么还没有:键 = BandKind 名,值 = 原因;插入先后就是 Object.values 的次序
        util::OJson notes = util::OJson::null();
        std::optional<double> frameSlot;
        std::map<QString, double> triedAt;
    };
    using Broker = std::shared_ptr<RouterPort>;
    using BandOrReason = std::variant<analysis::playbook::Band, QString>;

    QString logDir() const;
    domain::PlaybookLog dayLog() const { return domain::PlaybookLog(logDir()); }
    util::OJson idle(const QString& reason);
    double closeMin(const QString& date) const;
    std::optional<QString> nextTradingDay(const QString& date) const;
    std::optional<QString> prevTradingDay(const QString& date) const;
    std::shared_ptr<Day> dayFor(const QString& date);
    std::optional<BandRec> todayRec(const Day& day) const;
    util::Task<util::OJson> runAfter(util::Task<> prev, std::optional<double> nowMs);
    util::Task<util::OJson> tickInner(double nowMs);
    void setAnchor(Day& day, const analysis::playbook::Anchor& anchor);
    static bool due(Day& day, const QString& kind, double nowMs, double gapMs);
    util::Task<BandOrReason> liveBand(Broker broker, QString expiry, double anchor, double nowMs, QString status);
    util::Task<> capturePrior(Broker broker, domain::EtNow et);
    util::Task<std::optional<double>> closeOf(Broker broker, QString date);
    util::Task<> backfillPrior(Broker broker, std::shared_ptr<Day> day, double nowMs);
    util::Task<> backfillAnchor(Broker broker, std::shared_ptr<Day> day, double nowMs);
    util::Task<> backfillOpen(Broker broker, std::shared_ptr<Day> day, double nowMs);
    util::Task<std::optional<analysis::playbook::Band>> historicBand(Broker broker, QString expiry, double anchor, QString date, double minute);
    util::Task<std::optional<double>> minuteOpen(std::shared_ptr<execution::IbSession> session, execution::IbContract contract, QString date, double minute,
                                                 QString whatToShow, bool useRTH);
    util::Task<> refreshWall(std::shared_ptr<Day> day, double nowMs, double spot);
    util::Task<> loop(int gen, int tickMs);
    void schedule(int gen, int tickMs, int delay);

    MarksPort& marks_;
    MarketDataPort& market_;
    int timer_ = 0;
    int gen_ = 0;
    bool running_ = false;
    util::Task<> chain_ = util::Task<>::resolved();
    std::shared_ptr<Day> day_;
    std::optional<double> price_, priceAt_;
    QString idleReason_;
    QString lastError_;
};

}  // namespace ibkr::orchestrate
