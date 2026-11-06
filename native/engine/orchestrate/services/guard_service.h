// 交易纪律守护(guard)的后台一面:收意图、盯股票仓位。见 docs/features/guard.md。
//
//   · 收意图:每一轮把收件文件(guard.inbox_path,缺省 = 交易库同目录下的 guard/intents.jsonl)整个改名接走,一行一份 JSON:
//     股票意图、期权组合意图,或者 {"close": "BE", "reason": "..."} 关掉一份。验过的进库(store.guard()),每一行连同结果追加到
//     同目录的 intents.log.jsonl;拒了的发通知说原因。
//   · 盯仓位:读持仓,每只股票仓位(多空都看)——
//       有在用的意图:按意图的止损价(打开跟踪时按 R 抬过的底线)经 tracker.add 建托管到券商的追踪(券商侧 GTC STP);已有追踪但止损比底线松、
//       停用了、关了自动平仓或托管:恢复(tracker.update,目标整套带回去,只动止损),记违规 stop_lowered。比底线紧的不动。
//       没有意图:已经有带止损、打开了自动平仓的持仓追踪就不管;其余的第一次看见就记一笔违规、发通知,过了 grace_s 还没补录,
//       就按默认规则算止损价同样建托管追踪。止损价已经在现价那一侧挂不上的,不平仓,只每五分钟提醒一次。
//   · 期权组合意图:在持仓的组合行里按账户、标的、到期日、行权价认出那一只,建一条引擎盯的追踪(止盈价 = 单位成本 × 止盈倍数、
//     止损价 = 单位成本 × 止损倍数、标的止损线),到期日当天再补上几点平。认不出的(比如两只交错的蝶被并成一个自定义组合)只提醒一次。
//   · 券商侧的托管止损单不是我们撤的(onExternalCancel,由 HostedOrders 回调):记违规 stop_cancelled;重挂是持仓追踪自己的事(退避 60 秒)。
//   · 意图对应的持仓出现过、后来没了:自动关掉那份意图(理由「持仓已平」)。那个账户的会话没连着时不下结论(持仓里没有它不等于平了)。
//
//   · 心跳与推送(第三步):每 heartbeat_s 写一次 guard/heartbeat.json;IBKR 断开超过 disconnect_alert_s、软件或引擎异常退出后被拉起、
//     止损 / 止盈触发、门槛拒单、任何违规,推到手机(Telegram 或 Pushover,guard.push)。发不出去的排队,下一轮再发,正文注明延迟了多久;
//     同一件事 10 分钟内只推一次,一小时最多 20 条。
//
//   · 每日报告(第四步):交易日收盘后 15 分钟(美东,提前收盘日 13:15)拼一份报告:净值、开仓、止损触发、违规、明日到期、心跳;
//     周五多一段本周违规与止损次数、每笔交易的 R 倍数。推到手机、写进 guard/reports/<日期>.txt、记一笔 guard_report。
//     那个钟点没开着就在当天(美东日期)之内补发;一天只发一份。
//
// guard.enabled 关着时一轮什么都不做(不读文件、不读持仓、不写心跳、不推送)。
#pragma once

#include "domain/config.h"
#include "orchestrate/services/svc_host.h"

#include <QHash>
#include <QSet>
#include <QString>

#include <functional>
#include <memory>
#include <optional>

namespace ibkr::orchestrate {

struct GuardWiring {
    /// tracker.add 的 handler:入参 TrackerAddParams,回 {track};被拒抛 RpcError
    std::function<util::Task<util::OJson>(util::OJson params)> addTrack;
    /// 账户别名 → 净值(美元);人在 risk_budget.equity_usd 里填了的优先,其余用券商报的
    std::function<std::optional<double>(const QString& alias)> navOf;
    /// 哪些账户别名此刻有会话管着(持仓读得到);空函数或回空 = 认不出,当全都管着
    std::function<std::optional<QStringList>()> coveredAccounts;
    /// tracker.update 的 handler:入参同 RPC(params 与 raw 给同一份);被拒抛 RpcError
    std::function<util::Task<util::OJson>(util::OJson params)> updateTrack;
    /// 推一条到手机(读凭证、拼请求、发出去);发不出去抛。空 = 不推
    std::function<util::Task<>(QString title, QString body)> push;
    /// 「上一次没正常退出」的标记目录(util::run_marker::dirFor(settings.json));空 = 不查
    QString runDir;
    /// 最近 7 天的成交(fillRow 的样子,带 account_id);读不到抛。每日报告用。空 = 没有成交可看
    std::function<util::Task<QList<util::OJson>>()> fillHistory;
    /// 美东此刻;空 = domain::nowEt()
    std::function<domain::EtNow()> clock;
};

/// EngineServer 用:各会话的 7 天成交(同 fillSync 的 history),每个会话最多等 30 秒
util::Task<QList<util::OJson>> guardFillHistory(std::shared_ptr<execution::BrokerRouter> router);

class GuardService : public SvcBase {
public:
    static constexpr double kNagMs = 5 * 60 * 1000;

    explicit GuardService(SvcHost& host) : SvcBase(host) {}
    ~GuardService();

    void attach(GuardWiring wiring) { wiring_ = std::move(wiring); }
    void start();
    void stop();

    /// 收件文件的路径
    QString inboxPath() const;
    /// 把收件文件里的每一行验一遍、落库,回 {accepted, rejected, closed}
    util::OJson ingestInbox();
    /// 一轮:收意图 + 盯仓位。nowMs 缺省 = runtime 的单调钟;回这一轮做了什么(测试与日志用)
    util::Task<util::OJson> tickOnce(std::optional<double> nowMs = std::nullopt, std::optional<QString> todayEt = std::nullopt);
    /// 券商侧的托管单不是我们撤的:正股追踪的止损类(sl / trail / ptrail)记违规
    void onExternalCancel(const util::OJson& track, const QString& kind, const QString& reason);
    /// 持仓追踪触发了(引擎盯的那一路,tracker 节拍的 fired;或券商侧托管单成交):记流水、推送
    void onFired(const QString& account, const QString& symbol, const QString& state, const QString& how);
    /// 门槛拒了一张程序发的开仓单:推送(流水由引擎记)
    void onOrderRejected(const QString& account, const QString& symbol, const QString& reason);
    /// 排着没推出去的条数(心跳与测试用)
    qsizetype pendingPushes() const { return pushQueue_.size(); }
    /// 拼这一天的报告正文(测试与手动补发用);不推、不落盘
    util::Task<QString> composeReport(domain::EtNow at);

private:
    struct Watch {
        double firstSeenMs = 0;
        bool stopPlaced = false;
        double lastNagMs = -1e18;
    };
    util::Task<> loop(int tickMs, int gen);
    util::Task<util::OJson> watchPositions(double nowMs, QString today);
    util::Task<> protectStock(util::OJson row, util::OJson intent, QList<util::OJson> tracks, double nowMs, util::OJson* out);
    util::Task<> watchOptions(QList<util::OJson> rows, QList<util::OJson> tracks, QString today, double nowMs, std::optional<QStringList> covered,
                              util::OJson* out);
    /// 同一件事 kNagMs 里只说一次;回这一次该不该说
    bool nag(const QString& key, double nowMs);
    void bump(util::OJson* out, const QString& key);
    util::OJson handleLine(const QString& raw);
    void journal(const QString& action, const util::OJson& detail);
    /// 本机通知 + 界面事件;push = 同时推到手机
    void tell(const QString& title, const QString& body, const QString& symbol, bool push = false);
    void enqueuePush(const QString& title, const QString& body, bool priority = false);
    util::Task<> maybeReport();
    util::Task<> drainPushes(double nowMs);
    void watchLink(double nowMs);
    void writeHeartbeat(double nowMs);
    void checkRestarts();

    GuardWiring wiring_;
    QHash<QString, Watch> watch_;
    QHash<QString, double> nagAt_;
    QSet<QString> told_;

    struct PendingPush {
        QString title, body;
        double createdEpoch = 0;
        bool priority = false;  // 每日报告:不去重、不占每小时的额度
    };
    QList<PendingPush> pushQueue_;
    QHash<QString, double> pushSeen_;  // 正文 → 上一次排进队的时刻(单调钟)
    QList<double> pushSent_;           // 最近一小时推出去的时刻
    bool pushBusy_ = false;
    double pushRetryAt_ = -1e18;
    QString pushError_;
    double now_ = 0;  // 最近一轮的单调钟,轮外的回调(被撤、触发)用它去重

    std::optional<double> downSince_;  // IBKR 断开的起点(单调钟)
    QString downSinceIso_;
    QString downSinceLocal_;  // 本机时区的 HH:mm,写进推送正文(也让两次断开的话不一样,不被去重吞掉)
    bool downTold_ = false;
    double heartbeatAt_ = -1e18;
    std::optional<double> nPositions_, nStops_;
    QHash<QString, double> lastPrices_;
    QString lastPriceChangeIso_;
    bool restartsChecked_ = false;
    bool reportBusy_ = false;
    QString reportedDate_;
    int timer_ = 0;
    int gen_ = 0;
    bool running_ = false;
    std::shared_ptr<bool> alive_ = std::make_shared<bool>(true);
};

}  // namespace ibkr::orchestrate
