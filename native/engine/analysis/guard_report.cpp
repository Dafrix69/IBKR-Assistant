#include "analysis/guard_report.h"

#include <QMap>
#include <QSet>

#include <algorithm>
#include <cmath>

namespace ibkr::analysis::guard_report {

using namespace Qt::StringLiterals;

namespace {

QString num(double v) {
    QString s = QString::number(v, 'f', 4);
    while (s.contains(u'.') && (s.endsWith(u'0') || s.endsWith(u'.'))) s.chop(1);
    return s;
}

QString legKey(const Fill& f) {
    if (f.secType == u"STK") return f.alias + u'|' + f.symbol;
    return f.alias + u'|' + f.symbol + u'|' + f.expiry.left(8) + u'|' + num(f.strike) + u'|' + f.right.left(1).toUpper();
}

QString shapeName(const QList<double>& strikes, int legs) {
    if (legs == 3 && strikes.size() == 3) return u"fly"_s;
    if (legs == 2 && strikes.size() == 2) return u"spread"_s;
    if (legs == 4) return u"condor"_s;
    return u"combo"_s;
}

}  // namespace

QString Order::instrument() const {
    if (kind == u"stock") return alias + u'|' + symbol;
    if (kind == u"option") return legKeys.value(0);
    QStringList ks;
    for (double k : strikes) ks << num(k);
    return alias + u'|' + symbol + u'|' + expiry + u'|' + ks.join(u'/') + u'|' + right;
}

QString Order::label() const {
    if (kind == u"stock") return symbol;
    QStringList ks;
    for (double k : strikes) ks << num(k);
    if (kind == u"option") return symbol + u' ' + ks.join(u'/') + right;
    const QString r = right == u"C" ? u"call "_s : right == u"P" ? u"put "_s : QString();
    return symbol + u' ' + ks.join(u'/') + u' ' + r + shapeName(strikes, int(legKeys.size()));
}

QList<Order> groupOrders(const QList<Fill>& fills) {
    QMap<QString, QList<Fill>> groups;  // permId(空的各自一组)
    int solo = 0;
    for (const Fill& f : fills) groups[f.permId.isEmpty() ? u"solo-%1"_s.arg(++solo) : f.permId].append(f);
    QList<Order> out;
    for (auto it = groups.cbegin(); it != groups.cend(); ++it) {
        const QList<Fill>& g = it.value();
        QList<Fill> sorted = g;
        std::sort(sorted.begin(), sorted.end(), [](const Fill& a, const Fill& b) { return a.time < b.time; });
        const Fill& first = sorted.first();
        const auto bag = std::find_if(sorted.cbegin(), sorted.cend(), [](const Fill& f) { return f.secType == u"BAG"; });
        QList<Fill> legs;
        for (const Fill& f : sorted)
            if (f.secType == u"OPT" || f.secType == u"FOP") legs.append(f);
        // 同一张单的期权腿只有一种合约:单腿期权;好几种却没有 BAG 行:当成各自一单
        QSet<QString> contracts;
        for (const Fill& f : legs) contracts.insert(legKey(f));
        if (bag == sorted.cend() && contracts.size() > 1) {
            for (const Fill& f : sorted) out.append(groupOrders({Fill{f.alias, f.symbol, f.secType, f.expiry, f.right, f.side, QString(), f.etDate, f.time, f.strike, f.shares, f.price}}));
            continue;
        }
        Order o;
        o.alias = first.alias;
        o.symbol = first.symbol;
        o.etDate = first.etDate;
        o.time = first.time;
        if (bag != sorted.cend()) {
            o.kind = u"combo"_s;
            o.side = bag->side;
            double qty = 0, value = 0;
            for (const Fill& f : sorted)
                if (f.secType == u"BAG") {
                    qty += f.shares;
                    value += f.shares * f.price;
                }
            o.qty = qty;
            o.price = qty > 0 ? value / qty : 0;
            QSet<QString> rights;
            QSet<QString> seen;
            for (const Fill& f : legs) {
                if (!o.strikes.contains(f.strike)) o.strikes.append(f.strike);
                if (o.expiry.isEmpty()) o.expiry = f.expiry.left(8);
                rights.insert(f.right.left(1).toUpper());
                const QString k = legKey(f);
                if (seen.contains(k)) continue;
                seen.insert(k);
                o.legKeys.append(k);
                o.legSides.append(f.side);
            }
            std::sort(o.strikes.begin(), o.strikes.end());
            if (rights.size() == 1) o.right = *rights.cbegin();
        } else {
            o.kind = first.secType == u"STK" ? u"stock"_s : u"option"_s;
            o.side = first.side;
            double qty = 0, value = 0;
            for (const Fill& f : sorted)
                if (f.side == o.side) {
                    qty += f.shares;
                    value += f.shares * f.price;
                }
            o.qty = qty;
            o.price = qty > 0 ? value / qty : 0;
            o.legKeys = {legKey(first)};
            o.legSides = {first.side};
            if (o.kind == u"option") {
                o.expiry = first.expiry.left(8);
                o.strikes = {first.strike};
                o.right = first.right.left(1).toUpper();
            }
        }
        out.append(o);
    }
    std::sort(out.begin(), out.end(), [](const Order& a, const Order& b) { return a.time < b.time; });
    return out;
}

bool isOpen(const Order& order, const QHash<QString, double>& held) {
    for (qsizetype i = 0; i < order.legKeys.size(); ++i) {
        const double q = held.value(order.legKeys[i], 0);
        const QString side = order.legSides.value(i);
        if ((side == u"BOT" && q > 0) || (side == u"SLD" && q < 0)) return true;
    }
    return false;
}

QList<Trade> closedTrades(const QList<Order>& orders, const QString& weekStart, const QHash<QString, double>& held) {
    QMap<QString, QList<Order>> by;
    for (const Order& o : orders)
        if (o.etDate >= weekStart) by[o.instrument()].append(o);
    QList<Trade> out;
    for (auto it = by.cbegin(); it != by.cend(); ++it) {
        const QList<Order>& list = it.value();
        bool stillHeld = false;
        for (const QString& k : list.first().legKeys)
            if (held.value(k, 0) != 0) stillHeld = true;
        if (stillHeld) continue;
        const QString openSide = list.first().side;
        double oq = 0, ov = 0, cq = 0, cv = 0;
        QString closeDate;
        for (const Order& o : list) {
            if (o.side == openSide) {
                oq += o.qty;
                ov += o.qty * o.price;
            } else {
                cq += o.qty;
                cv += o.qty * o.price;
                closeDate = o.etDate;
            }
        }
        if (oq <= 0 || cq <= 0 || cq < oq * 0.999) continue;
        Trade t;
        t.label = list.first().label();
        t.instrument = it.key();
        t.isLong = openSide == u"BOT";
        t.entry = ov / oq;
        t.exit = cv / cq;
        t.openDate = list.first().etDate;
        t.closeDate = closeDate;
        out.append(t);
    }
    std::sort(out.begin(), out.end(), [](const Trade& a, const Trade& b) { return a.closeDate < b.closeDate; });
    return out;
}

std::optional<double> rMultiple(const Trade& t, std::optional<double> stop) {
    if (!stop) return std::nullopt;
    const double risk = t.isLong ? t.entry - *stop : *stop - t.entry;
    if (!(risk > 0)) return std::nullopt;
    return (t.isLong ? t.exit - t.entry : t.entry - t.exit) / risk;
}

QString dollars(double v) {
    const qint64 n = qint64(std::llround(std::abs(v)));
    QString digits = QString::number(n);
    for (int i = int(digits.size()) - 3; i > 0; i -= 3) digits.insert(i, u',');
    return (v < 0 ? u"-$"_s : u"$"_s) + digits;
}

QString pct(double v) {
    const double r = std::round(v * 10.0) / 10.0;
    return (r > 0 ? u"+"_s : QString()) + QString::number(r == 0 ? 0.0 : r, 'f', 1) + u'%';
}

QString build(const Input& in) {
    const auto list = [](const QStringList& items) { return items.isEmpty() ? u"无"_s : items.join(u'；'); };
    QStringList lines;
    lines << u"datrix guard "_s + in.date;
    for (const Account& a : in.accounts) {
        QString line = u"净值 "_s;
        if (in.accounts.size() > 1) line += a.alias + u' ';
        if (!a.nav) {
            line += u"读不到"_s;
        } else {
            line += dollars(*a.nav);
            if (a.changePct) line += u"（"_s + pct(*a.changePct) + u"）"_s;
        }
        lines << line;
    }
    if (in.accounts.isEmpty()) lines << u"净值 读不到"_s;
    lines << u"开仓："_s + list(in.opened);
    lines << u"止损触发："_s + list(in.fired);
    lines << u"违规："_s + list(in.violations);
    lines << u"明日到期："_s + list(in.expiring);
    lines << u"心跳："_s + (in.connected ? u"正常"_s : u"断开中"_s) + u"，断线 %1 次"_s.arg(in.disconnects);
    if (in.friday) {
        lines << u"本周：违规 %1 次，止损触发 %2 次"_s.arg(in.weekViolations).arg(in.weekStops);
        QStringList trades;
        for (const WeekTrade& t : in.weekTrades) {
            if (t.r) {
                const double r = std::round(*t.r * 10.0) / 10.0;
                trades << t.label + u' ' + (r > 0 ? u"+"_s : QString()) + QString::number(r == 0 ? 0.0 : r, 'f', 1) + u'R';
            } else {
                trades << t.label + u" —（"_s + (t.note.isEmpty() ? u"无止损"_s : t.note) + u"）"_s;
            }
        }
        lines << u"本周 R 倍数："_s + list(trades);
    }
    return lines.join(u'\n');
}

}  // namespace ibkr::analysis::guard_report
