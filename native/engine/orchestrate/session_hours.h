// engine/sessionHours.ts 逐句搬:一张单 / 一份持仓此刻面对的交易时段——合约自己的时段、盘外标志、时段预热。
// 正股日历(settings.marketStatus)是照美股正股写的,SPX 期权还有 20:15–次日 09:25 那一整段隔夜可交易时间;下单与平仓必须用同一张时段表,
// 否则会出现"能平不能开"或反过来。期望值:tests/fixtures/gen_engine_pure.mjs(原模块对着脚本驱动的假 router 现跑)。
//
// 订单(ParsedOrder)与持仓行(Rec)都是 JS 对象:OJson。TS 的 `String(x)` 在值缺了时得 "undefined",这里同(js::str)。
#pragma once

#include "contract/config_types.h"
#include "domain/config.h"
#include "util/ordered_json.h"
#include "util/task.h"

#include <QList>
#include <QString>

#include <array>
#include <optional>

namespace ibkr::orchestrate {

/// [交易时段, 流动时段, 时区]:reqContractDetails 回来的那三样
using ContractHours = std::array<QString, 3>;

/// 时段这一块要用到的 router 那一面(只有 IBKR 的 router 有这两个方法;has* 说有没有,同 TS 的 `typeof x === "function"`)
class HoursRouter {
public:
    virtual ~HoursRouter() = default;
    virtual bool hasContractHours() const { return false; }
    virtual util::Task<std::optional<ContractHours>> contractHours(const util::OJson& row, const contract::AccountConfig& account) {
        (void)row;
        (void)account;
        co_return std::nullopt;
    }
    virtual bool hasCachedContractHours() const { return false; }
    /// 只读已缓存的时段;可以抛(调用方当没有)
    virtual std::optional<ContractHours> cachedContractHours(const QString& symbol, const QString& expiry) {
        (void)symbol;
        (void)expiry;
        return std::nullopt;
    }
};

/// 每次用到都现取:配置会重载、券商会重连
class HoursHost {
public:
    virtual ~HoursHost() = default;
    virtual const domain::Settings& settings() const = 0;
    virtual HoursRouter* router() = 0;  // 空 = 没连券商
};

/// 合约此刻在盘外时段能交易时,自动给订单打上 outsideRth(市价单与用户显式写了的不动)
QList<util::OJson> autoOutsideRth(HoursHost& host, const QList<util::OJson>& orders, const domain::EtNow& at);
/// 把这批订单里期权 / 组合的合约时段问一遍,填进 router 的按日缓存;失败一律忽略
util::Task<> prewarmContractHours(HoursHost& host, QList<util::OJson> orders);
/// 一张**待下单**的期权 / 组合此刻面对的时段(拿不到回空,让校验退回正股表)。同步:只读已缓存的
std::optional<QString> orderMarketStatus(HoursHost& host, const util::OJson& order, const domain::EtNow& at);
/// 这条持仓此刻能不能交易。期权 / 组合优先用合约的真实时段,拿不到就退回正股表
util::Task<QString> marketStatusFor(HoursHost& host, util::OJson raw, domain::EtNow at);

}  // namespace ibkr::orchestrate
