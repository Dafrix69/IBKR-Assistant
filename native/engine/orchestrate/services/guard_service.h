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
// guard.enabled 关着时一轮什么都不做(不读文件、不读持仓)。
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
};

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
    void tell(const QString& title, const QString& body, const QString& symbol);

    GuardWiring wiring_;
    QHash<QString, Watch> watch_;
    QHash<QString, double> nagAt_;
    QSet<QString> told_;
    int timer_ = 0;
    int gen_ = 0;
    bool running_ = false;
    std::shared_ptr<bool> alive_ = std::make_shared<bool>(true);
};

}  // namespace ibkr::orchestrate
