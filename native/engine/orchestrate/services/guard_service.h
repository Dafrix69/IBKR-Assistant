// 交易纪律守护(guard)的后台一面:收意图、盯股票仓位。见 docs/features/guard.md。
//
//   · 收意图:每一轮把收件文件(guard.inbox_path,缺省 = 交易库同目录下的 guard/intents.jsonl)整个改名接走,一行一份 JSON:
//     股票意图、期权组合意图,或者 {"close": "BE", "reason": "..."} 关掉一份。验过的进库(store.guard()),每一行连同结果追加到
//     同目录的 intents.log.jsonl;拒了的发通知说原因。
//   · 盯仓位:读持仓,每只股票仓位(多空都看)——有在用的意图就不管(止损由 Step 2 管);已经有带止损、打开了自动平仓的持仓追踪也不管;
//     其余的第一次看见就记一笔违规、发通知,过了 grace_s 还没补录,就按默认规则算止损价、经 tracker.add 建一条托管到券商的追踪
//     (券商侧的 GTC STP)。默认止损价已经在现价那一侧挂不上的,不平仓,只每五分钟提醒一次。
//   · 意图对应的持仓出现过、后来没了:自动关掉那份意图(理由「持仓已平」)。那个账户的会话没连着时不下结论(持仓里没有它不等于平了)。
//
// guard.enabled 关着时一轮什么都不做(不读文件、不读持仓)。
#pragma once

#include "domain/config.h"
#include "orchestrate/services/svc_host.h"

#include <QHash>
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

private:
    struct Watch {
        double firstSeenMs = 0;
        bool stopPlaced = false;
        double lastNagMs = -1e18;
    };
    util::Task<> loop(int tickMs, int gen);
    util::Task<util::OJson> watchPositions(double nowMs, QString today);
    util::OJson handleLine(const QString& raw);
    void journal(const QString& action, const util::OJson& detail);
    void tell(const QString& title, const QString& body, const QString& symbol);

    GuardWiring wiring_;
    QHash<QString, Watch> watch_;
    int timer_ = 0;
    int gen_ = 0;
    bool running_ = false;
    std::shared_ptr<bool> alive_ = std::make_shared<bool>(true);
};

}  // namespace ibkr::orchestrate
