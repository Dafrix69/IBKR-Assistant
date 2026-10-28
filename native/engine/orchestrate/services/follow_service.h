// services/follow.ts 逐句搬:Discord 跟单的服务层(docs/features/follow.md)——两个来源(Gateway 连接、本地收件文件 + 读窗口的程序)的起停、
// 每条消息从判定到发单的那一趟、处理完之后记一次盘口、跟进去的蝴蝶成交之后建追踪、给界面的状态。规则在 parsing/follow(纯函数),协议在 util/discord_gateway,
// 收件文件在 domain/follow_inbox,读窗口的程序在 domain/follow_reader。期望值:tests/fixtures/gen_svc_follow.mjs(原 TS 服务现跑,假宿主按脚本答、每一次调用都记下来)。
//
// **钱路径,一字不改的几条**(跟 TS 一样,也是这份对拍钉着的):
//   · 发单只走引擎的 handleInstruction(channel = "discord"),且这一趟**带 localOnly 标记**——引擎那一遍若走到大模型解析器必须抛 FollowLocalOnlyError;
//     Discord / 收件的文字永远到不了大模型。tryLocalShorthand 是本地速记,不碰大模型。
//   · 授权只有两道:配置里的 follow.enabled(自动跟单)与 track_fly;**没有任何额外的手动闸**,也没有被放松的。关掉任何一个,在等的追踪当场放弃(收回授权不比给出难)。
//   · 建追踪走装配时接进来的 addTrack(= tracker.add 的 handler),入参是 parsing::follow::flyTrackParams 逐键相同的那一份。
//
// 与 TS 的对应与不同:
//   · 来源三样(Gateway / 收件 / 读窗口程序)和凭证库都走 FollowSources 这条缝(TS 是 gatewayOptions / inboxOptions / readerOptions 加全局模块);缺省是真的那几个类。
//   · **与 TS 有意不同(用户 2026-10 决定,C++ 独有)**:发单之后的步骤不能把已发出的单改记成「被拒:发单过程出错」。TS 里 outcomeOf / conclude / finish /
//     登记追踪都和 handleInstruction 在同一个 try 里;C++ 的 try 只罩 handleInstruction。引擎返回后任何一步出错 → 记 stderr 与审计 follow_post_submit_error(step、
//     message 前 300 字,不含密钥),单子的下场照记(已跟单),日志行没落下的补写一次;进程内去重表在 onMessage 里已记。具体差别:
//       ① result.llm 缺键(TS 抛 TypeError → 被拒;C++ 警告 step=llm,照常继续);② outcomeOf 抛(C++ 退成「已发出」并带上 submitted 的记录号);
//       ③ finish 里 audit / emit 抛(C++ 日志行已落,警告后接着通知与登记追踪;TS 会再记一条重复的被拒);④ follow.add 抛(C++ 无日志行,有警告与审计;TS 抛两次)。
//     这几种场景在夹具里标 divergent,不与 TS 对拍,由 tst_svc_follow 的 postSubmit* 用例直接断言。
//   · TS 的 AsyncLocalStorage 认调用链(手动指令与跟单可以同时在跑);C++ 每个 handleInstruction 调用自己带 InstructionScope.localOnly(svc1_ports.h)。
//   · TS 里 `process.stderr.write(... err.stack ...)` 带着 JS 的调用栈;C++ 只写第一行 "<类名>: <话>"(没有栈)。
//   · JS 的 promise 链(`this.chain.then(...)`)在 start() 之后让一拍微任务才跑 syncOnce;C++ 的 Task 同步续跑,所以 start() 里先 armTrackTimer 再 sync——
//     两边的可观察次序(先设定时器、后连来源)一致。
//   · 协程是成员函数,参数一律传值:FollowService 必须活得比所有未完成的调用长(同 TS 闭包抓着 this)。
#pragma once

#include "domain/follow_inbox.h"
#include "domain/follow_reader.h"
#include "orchestrate/services/svc1_ports.h"
#include "parsing/follow.h"
#include "util/discord_gateway.h"

#include <QHash>
#include <QSet>

#include <deque>
#include <functional>
#include <memory>
#include <optional>

namespace ibkr::orchestrate {

/// bot token 在系统凭证库里的位置
inline const QString kFollowKeychainService = QStringLiteral("dafri-discord-bot");
inline const QString kFollowKeychainAccount = QStringLiteral("token");

/// 跟单那一趟里有人想调大模型(引擎那一遍:InstructionScope.localOnly 为真时,解析器一被叫到就抛它)
class FollowLocalOnlyError : public util::JsError {
public:
    FollowLocalOnlyError() : JsError(QStringLiteral("跟单只认本地速记,这一条没有被完整接住,没有交给大模型")) {}
};

/// 装配时接进来的两样(TS 的 FollowWiring):建追踪只走 tracker.add 那一条路;行情流和蝴蝶测算共用同一批
struct FollowWiring {
    /// tracker.add 的 handler:入参 TrackerAddParams,回 {track};被拒抛 RpcError
    std::function<util::Task<util::OJson>(util::OJson params)> addTrack;
    MarksPort* marks = nullptr;
};

/// Gateway 那一面(util::DiscordGateway 的窄面)
class GatewayLike {
public:
    virtual ~GatewayLike() = default;
    virtual void start() = 0;
    virtual void stop() = 0;
    virtual std::optional<QString> bot() const = 0;
    virtual bool guildsSeen() const = 0;
    virtual bool hasChannel(const QString& id) const = 0;
};
/// 本地收件那一面(domain::FollowInbox 的窄面)
class InboxLike {
public:
    virtual ~InboxLike() = default;
    virtual QString path() const = 0;
    virtual bool watching() const = 0;
    virtual std::optional<QString> lastAt() const = 0;
    virtual double received() const = 0;
    virtual std::optional<QString> error() const = 0;
    virtual void start() = 0;
    virtual void stop() = 0;
    virtual void poll() = 0;
};
/// 读窗口的程序那一面(domain::FollowReader 的窄面)
class ReaderLike {
public:
    virtual ~ReaderLike() = default;
    virtual QString program() const = 0;
    virtual QString channel() const = 0;
    virtual QString out() const = 0;
    virtual domain::ReaderStatus view() const = 0;
    virtual void start() = 0;
    virtual void stop() = 0;
};

struct InboxHooks {
    std::function<void(const util::DiscordMessage&)> onMessage;
    std::function<void(const QString&)> onError;
};

/// 来源与凭证库的缝。每一项缺省是真的;测试整个换掉
struct FollowSources {
    std::function<std::unique_ptr<GatewayLike>(const QString& token, util::GatewayHooks hooks)> gateway;
    std::function<std::unique_ptr<InboxLike>(const QString& path, InboxHooks hooks)> inbox;
    std::function<std::unique_ptr<ReaderLike>(const QString& program, const QString& channel, const QString& out, std::function<void(const domain::ReaderStatus&)> onStatus)> reader;
    /// readerOptions.program:这台机器上读窗口的程序在哪;没有回空
    std::function<std::optional<QString>()> readerProgram;
    std::function<util::Task<bool>(QString service, QString account)> secretExists;
    std::function<util::Task<std::optional<QString>>(QString service, QString account)> readSecret;
    std::function<util::Task<>(QString service, QString account, QString secret)> writeSecret;
};

class FollowService : public Svc1Base {
public:
    explicit FollowService(Svc1Host& host);

    /// 怎么开 Gateway(缺省的 gateway 工厂用它;真跑时 open 由引擎装配成 QWebSocket 那个)
    util::GatewayOptions gatewayOptions;
    /// 本地收件多久读一次文件(毫秒;缺省的 inbox 工厂用它)
    int inboxIntervalMs = 1000;
    FollowSources sources;
    /// 频道里看到的每一条消息(信任与否都给)都递给它:信息链路落底账、认标的(装配时接上);空 = 不记
    std::function<void(const util::DiscordMessage&, bool trusted)> onSeen;

    /// 装配(调一次;测试注入假的)
    void attach(FollowWiring wiring) { wiring_ = std::move(wiring); }

    /// 引擎真正的入口里调一次;没调过它,sync 什么都不做
    void start();
    void stop();
    /// 让连接和配置对上。restart:丢掉现在的连接重来
    util::Task<> sync(bool restart = false);
    /// 现在就读一次收件文件。返回的 Task 在读到的消息都处理完之后落定
    util::Task<> pollInbox();
    /// 排着队的消息、以及它们之后在后台做的事(记盘口)都落定
    util::Task<> settled();

    util::Task<> setToken(QString token);
    /// 每一条消息从这里进。返回的 Task 在这条消息处理完之后落定
    util::Task<> onMessage(util::DiscordMessage message);
    /// FollowStatus(键序同 TS)
    util::Task<util::OJson> status();
    /// 核对一轮在等的蝴蝶。返回的 Task 在这一轮走完之后落定;出了错只落一行日志
    util::Task<> trackTick();

    static constexpr int kSeenMax = 30;
    static constexpr int kHandledMax = 2000;
    static constexpr int kTrackPollMs = 3000;
    static constexpr int kTrackAddAttempts = 10;
    static inline const QString kPendingPref = QStringLiteral("follow.pending_tracks");

private:
    struct Signal {
        util::OJson contract;
        parsing::follow::LeaderPrice leader;
    };
    struct Result {
        QString outcome, detail, summary;
        QStringList recordIds;
        /// outcomeOf 的产出 {outcome, detail, record_ids} 再追加 summary 的写法(键序不同于 {outcome, detail, summary, record_ids})
        bool summaryLast = false;
        /// TS 里「拿不到现价」那一处的字面量是 {outcome, summary, record_ids, detail}
        bool detailLast = false;
    };
    struct OrderFacts {
        bool filled = false, final_ = false;
        double fills = 0;
    };
    struct LinkPatch {
        std::optional<QString> state;
        bool hasBot = false, hasError = false;
        std::optional<QString> bot, error;
    };
    struct Link {
        QString state = QStringLiteral("off");
        std::optional<QString> bot, error;
    };

    // ---- 连接的起停
    util::Task<> syncStep(util::Task<> prev, bool restart);
    util::Task<> syncOnce(bool restart);
    void dropGateway();
    void syncInbox();
    void dropInbox();
    void syncReader();
    void dropReader();
    std::optional<QString> readerProgramPath();
    util::OJson readerView();
    util::OJson inboxView();
    void onPhase(util::GatewayPhase phase, const std::optional<QString>& error);
    void setLink(const LinkPatch& patch);
    util::OJson linkView();

    // ---- 一条消息
    util::Task<> chainStep(util::Task<> prev, util::DiscordMessage message, std::optional<QString> stale);
    void remember(const util::DiscordMessage& message);
    util::Task<> process(util::DiscordMessage message, std::optional<QString> stale);
    void conclude(const util::DiscordMessage& message, Result result, const util::OJson& payload, const util::OJson& submitted, bool postSubmit = false);
    std::optional<util::OJson> finish(const util::DiscordMessage& message, const Result& result, bool postSubmit = false);
    void postSubmit(const util::DiscordMessage& message, const util::OJson& result, const util::OJson& payload, const QString& decisionSummary);
    void postWarn(const util::DiscordMessage& message, const QString& step, std::exception_ptr error);
    void notify(const QString& title, const QString& body, const QString& subtitle = {});
    double sentToday();

    // ---- 延迟的代价
    void later(util::Task<> task);
    util::Task<> laterRun(util::Task<> task, quint64 id);
    std::optional<Signal> signalFor(const QStringList& recordIds, const util::OJson& payload);
    util::Task<> recordQuote(util::DiscordMessage message, Signal signal);

    // ---- 跟进来的蝴蝶与贷方价差:成交之后建追踪
    std::vector<parsing::follow::PendingTrack> pendingList();
    void savePending(const std::vector<parsing::follow::PendingTrack>& items);
    struct TrackPlan {
        std::vector<parsing::follow::PendingTrack> items;
        QString note;
    };
    std::optional<TrackPlan> trackPlan(const util::DiscordMessage& message, const util::OJson& submitted, const parsing::follow::SpreadStop& stop);
    void armTrackTimer();
    int pendingCount();
    util::Task<> trackStep(util::Task<> prev);
    util::Task<> trackOnce();
    util::Task<std::optional<parsing::follow::PendingTrack>> settleOne(parsing::follow::PendingTrack item, OrderFacts order, QString exitAt, double nowMs,
                                                                         std::optional<QList<util::OJson>> rows, std::optional<QStringList> covered);
    util::Task<std::optional<QList<util::OJson>>> positionRows();
    util::Task<QString> createTrack(parsing::follow::PendingTrack item, QString key, QString exitAt, double nowMs, double held, double unitCredit);
    void auditDropped(const parsing::follow::PendingTrack& item, const QString& reason);

    /// 这条消息里价差的止损线(发单前落好,登记待建追踪时取走)
    QHash<QString, parsing::follow::SpreadStop> spreadStops_;
    FollowWiring wiring_;
    std::unique_ptr<GatewayLike> gateway_;
    quint64 gatewayId_ = 0, gatewayGen_ = 0;
    std::unique_ptr<InboxLike> inbox_;
    quint64 inboxId_ = 0, inboxGen_ = 0;
    std::unique_ptr<ReaderLike> reader_;
    quint64 readerId_ = 0, readerGen_ = 0;
    bool started_ = false;
    Link link_;
    QList<util::OJson> seen_;
    QSet<QString> handled_;
    std::deque<QString> handledOrder_;
    util::Task<> chain_ = util::Task<>::resolved();
    util::Task<> syncChain_ = util::Task<>::resolved();
    std::vector<std::pair<quint64, util::Task<>>> background_;
    quint64 backgroundSeq_ = 0;
    util::Task<> trackRun_ = util::Task<>::resolved();
    int trackTimer_ = 0;
    QHash<QString, int> trackMisses_, trackFailures_;
};

}  // namespace ibkr::orchestrate
