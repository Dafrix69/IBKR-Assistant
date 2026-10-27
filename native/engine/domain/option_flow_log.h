// 期权主动成交记盘的底账(option-flow/,交易库旁边):一天一个文件、一行一条 JSON,只追加,坏的行读的时候跳过。只有公开行情,没有账户。
// 四种行(kind):
//   sub   这一天订了哪些合约:{t, expiry, trading_class, anchor, spot, contracts:[[strike, right], ...]}
//   print 一次推送里看到的成交量增量与前后两口盘口:{t, expiry, k, r, dv, last, lt, plt, pb, pa, b, a, bs, as, mdt}
//   vol   某个时刻的当天累计成交量(订上时一笔、之后每五分钟一笔):{t, expiry, k, r, volume}
//   oi    持仓量(IBKR 盘前更新一次,是上一个交易日收盘后的数):{t, expiry, k, r, oi}
// 逐笔对照另放一个目录(option-flow-tbt/,同一种文件,行数多得多),两种行:
//   tbt     一笔逐笔:{t, expiry, k, r, type:"last", time, price, size, exch, cond, unrep?, plim?} 或 {…, type:"bidask", time, bid, ask, bs, as}
//   tbt_err 逐笔订阅被拒:{t, expiry, k, r, type, error}
// 分类不落盘:口径改了拿底账重算(analysis/option_flow)。
#pragma once

#include "domain/day_logs.h"

namespace ibkr::domain {

class OptionFlowLog : public JsonlDayFiles {
public:
    /// 一天几 MB;留四个月
    static constexpr double kKeepDays = 120;
    using JsonlDayFiles::JsonlDayFiles;
    /// 这一天形状对的行,照文件里的次序
    QList<util::OJson> read(const QString& date) const;
    double prune(double keep = kKeepDays) const { return JsonlDayFiles::prune(keep); }
};

}  // namespace ibkr::domain
