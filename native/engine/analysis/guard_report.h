// 交易纪律守护的每日报告(第四步):纯函数。见 docs/features/guard.md「每日报告」。
// 成交、持仓、流水都由调用方读好、换成别名与美东日期再给进来:这里不碰券商、不碰库,也看不到账号。
#pragma once

#include <QHash>
#include <QList>
#include <QString>
#include <QStringList>

#include <optional>

namespace ibkr::analysis::guard_report {

/// 一笔成交(fillRow 换成别名、按美东日期标好之后)
struct Fill {
    QString alias, symbol, secType, expiry, right, side, permId, etDate, time;
    double strike = 0, shares = 0, price = 0;
};

/// 一张单(同一个 permId 的成交并成一组):组合单 = BAG 那一行的方向、数量、净价,腿从同组的期权行来
struct Order {
    QString kind;  // stock / combo / option
    QString alias, symbol, expiry, right, side, etDate, time;
    QList<double> strikes;     // 组合的行权价(去重、从小到大)
    QList<QString> legKeys;    // 每条腿的持仓键:alias|symbol|expiry|strike|right(正股:alias|symbol)
    QList<QString> legSides;   // 每条腿这一单的方向(BOT / SLD)
    double qty = 0, price = 0;
    /// 同一个"东西"的键:正股 alias|symbol;组合 alias|symbol|expiry|行权价;单腿期权 alias|symbol|expiry|strike|right
    QString instrument() const;
    /// 给人看的名字:BE、QQQ 660/670/680 call fly、SPY 755C
    QString label() const;
};

/// 按 permId 并成单,按时间排
QList<Order> groupOrders(const QList<Fill>& fills);

/// 这一单是不是开仓:有一条腿此刻还按这一单的方向持有(买的还多着、卖的还空着)。held = 持仓键 → 带符号的数量
bool isOpen(const Order& order, const QHash<QString, double>& held);

/// 一笔做完的交易(一周之内开了又平光了)
struct Trade {
    QString label, instrument;
    bool isLong = true;
    double entry = 0, exit = 0;  // 开仓方向的均价 / 平仓方向的均价(组合是净价)
    QString openDate, closeDate;
};
/// 周内的成交里,开了又平光、现在不持有的那些。开仓方向 = 这个东西在周内第一单的方向
QList<Trade> closedTrades(const QList<Order>& orders, const QString& weekStart, const QHash<QString, double>& held);

/// R 倍数:(平 − 开)÷(开 − 止损),空头反过来;止损给不了就是空
std::optional<double> rMultiple(const Trade& t, std::optional<double> stop);

struct Account {
    QString alias;
    std::optional<double> nav, changePct;
};
struct WeekTrade {
    QString label;
    std::optional<double> r;
    QString note;  // r 为空时说为什么(无止损、止损不明)
};
struct Input {
    QString date;  // 美东 YYYY-MM-DD
    bool friday = false;
    QList<Account> accounts;
    QStringList opened, fired, violations, expiring;  // 每一项一句,空 = 「无」
    bool connected = true;
    int disconnects = 0;
    int weekViolations = 0, weekStops = 0;
    QList<WeekTrade> weekTrades;
};

/// 拼报告正文(格式固定,见任务书)。多个账户时净值一行一个、前面带别名
QString build(const Input& in);

/// 美元整数、千分位:15165.4 → "$15,165"
QString dollars(double v);
/// 正负号、一位小数:-0.6 → "-0.6%",0.4 → "+0.4%"
QString pct(double v);

}  // namespace ibkr::analysis::guard_report
