#include "shell/track_rules.h"

#include "shell/confirm_grants.h"
#include "shell/jsvalue.h"

#include <QDateTime>
#include <QRegularExpression>
#include <QTimeZone>

#include <cmath>

using namespace Qt::StringLiterals;

namespace ibkr::shell::track {

namespace {

std::optional<double> optNum(const QJsonValue& v) {
    if (v.isDouble()) return v.toDouble();
    return std::nullopt;
}

/// String(v):null / undefined 是空串(界面的老规矩:'' = 不设)
QString str(const std::optional<double>& v) { return v ? jsNumberToString(*v) : QString(); }

/// 价位照人填的样子写:7700 不写成 7700.00,7790.5 不丢掉那半点
QString level(double v) { return jsNumberToString(jsToFixed(v, 2).toDouble()); }

QStringList lines(std::optional<double> below, std::optional<double> above) {
    QStringList out;
    if (below) out << u"跌到 "_s + level(*below);
    if (above) out << u"涨到 "_s + level(*above);
    return out;
}

bool clockOk(const QString& text) {
    static const QRegularExpression re(u"^([01]?\\d|2[0-3]):[0-5]\\d\\z"_s);
    return re.match(jsTrim(text)).hasMatch();
}

struct FilledTier {
    QString price;
    QString fraction;
};

/// 填了一半的那几档(只填了价或只填了比例)不算数;两样都填了的才进载荷
QList<FilledTier> filledTiers(const QList<TierField>& tiers) {
    QList<FilledTier> out;
    for (const TierField& t : tiers)
        if (t.price && t.fraction) out.append({str(t.price), str(t.fraction)});
    return out;
}

/// 卡片上的价:最多四位小数,不补零
QString price4(double v) { return jsNumberToString(jsToFixed(v, 4).toDouble()); }

bool nullish(const QJsonValue& v) { return v.isNull() || v.isUndefined(); }

}  // namespace

QString fmtNum(const QJsonValue& value, int digits) {
    const double n = jsNumber(value);
    return std::isfinite(n) ? jsToFixed(n, digits) : u"—"_s;
}

QString fmtMoney(const QJsonValue& value) {
    if (nullish(value) || std::isnan(jsNumber(value))) return u"—"_s;
    if (std::isinf(jsNumber(value))) return formatEnUs(jsNumber(value), 2);  // 「∞」不补小数
    // toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }):最多两位,再补齐到两位
    QString s = formatEnUs(jsNumber(value), 2);
    const qsizetype dot = s.indexOf(u'.');
    if (dot < 0) return s + u".00"_s;
    while (s.size() - dot - 1 < 2) s += u'0';
    return s;
}

std::optional<QString> fmtExpiry(const QJsonValue& value) {
    static const QRegularExpression compact(u"^\\d{8}\\z"_s);
    const QString t = jsTrim(nullish(value) ? QString() : jsString(value));
    if (compact.match(t).hasMatch()) return u"%1-%2-%3"_s.arg(t.left(4), t.mid(4, 2), t.mid(6));
    if (t.isEmpty()) return std::nullopt;
    return t;
}

QString spotStopSummary(std::optional<double> below, std::optional<double> above) {
    const QStringList set = lines(below, above);
    return set.isEmpty() ? QString() : u"标的止损 "_s + set.join(u" / "_s);
}

QString spotStopLine(const QString& symbol, const QJsonObject& row) {
    const auto spot = optNum(row.value("spot"_L1));
    if (!spot) {
        const QString reason = row.value("reason"_L1).toString();
        return reason.isEmpty() ? u"拿不到 %1 的现价,标的止损这一轮不判断"_s.arg(symbol) : reason;
    }
    const auto below = optNum(row.value("below"_L1));
    const auto above = optNum(row.value("above"_L1));
    QStringList parts;
    if (below) parts << u"跌到 %1 就平(还差 %2 点)"_s.arg(level(*below), jsToFixed(*spot - *below, 2));
    if (above) parts << u"涨到 %1 就平(还差 %2 点)"_s.arg(level(*above), jsToFixed(*above - *spot, 2));
    // 已经越线、在等确认:这是最要紧的一句,放在最前面
    const QJsonValue pending = row.value("pending"_L1);
    const QString waiting = jsTruthy(pending)
                                ? u"已%1止损线,持续 %2 秒,满 %3 秒才平 · "_s.arg(pending[u"side"] == u"below"_s ? u"跌破"_s : u"涨破"_s,
                                                                             jsString(pending[u"held_s"]), jsString(pending[u"need_s"]))
                                : QString();
    const QString note = row.value("spot_note"_L1).toString();
    return u"标的止损:%1%2 现价 %3,%4%5"_s.arg(waiting, symbol, jsToFixed(*spot, 2), parts.join(u","_s), note.isEmpty() ? QString() : u" · "_s + note);
}

QString spotStopConfirmLine(const QString& symbol, std::optional<double> below, std::optional<double> above) {
    const QStringList set = lines(below, above);
    if (set.isEmpty()) return {};
    return u"标的止损:%1 %2 就平,记作止损。只看标的现价,不看这份持仓值多少;软件开着时按秒盯。\n"_s.arg(symbol, set.join(u"、或"_s));
}

std::optional<double> formNumber(const QJsonValue& v, const QString& key, QStringList* invalid) {
    if (v.isNull() || v.isUndefined()) return std::nullopt;
    if (v.isDouble() && std::isfinite(v.toDouble())) return v.toDouble();
    if (v.isString() && jsTrim(v.toString()).isEmpty()) return std::nullopt;
    // 只认十进制(Number() 会把 "0x10" 读成 16,输入框里敲错的这种不能当数)
    static const QRegularExpression decimal(u"^[+-]?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?\\z"_s);
    if (v.isString() && decimal.match(jsTrim(v.toString())).hasMatch()) {
        const double n = jsNumber(v);
        if (std::isfinite(n)) return n;
    }
    if (invalid) invalid->append(key);
    return std::nullopt;
}

ExitFields ExitFields::fromJson(const QJsonObject& o) {
    ExitFields f;
    // 字串与开关也要是那个类型:类型不对的悄悄落回默认值,同样是"以为设上了"
    const auto text = [&f, &o](const char* key, const QString& fallback) {
        const QJsonValue v = o.value(QLatin1StringView(key));
        if (v.isString()) return v.toString();
        if (!v.isNull() && !v.isUndefined()) f.invalid << QString::fromLatin1(key);
        return fallback;
    };
    f.exitAt = text("exitAt", QString());
    f.stopConfirm = formNumber(o.value("stopConfirm"_L1), u"stopConfirm"_s, &f.invalid);
    f.stopBasis = text("stopBasis", u"mid"_s);
    f.chaseGrace = formNumber(o.value("chaseGrace"_L1), u"chaseGrace"_s, &f.invalid);
    f.chaseStep = formNumber(o.value("chaseStep"_L1), u"chaseStep"_s, &f.invalid);
    f.chaseMax = formNumber(o.value("chaseMax"_L1), u"chaseMax"_s, &f.invalid);
    const QJsonValue peak = o.value("peakConfirm"_L1);
    if (!peak.isBool() && !peak.isNull() && !peak.isUndefined()) f.invalid << u"peakConfirm"_s;
    f.peakConfirm = peak.toBool();
    int i = 0;
    for (const QJsonValue& t : o.value("tiers"_L1).toArray()) {
        f.tiers.append({formNumber(t[u"price"], u"tiers[%1].price"_s.arg(i), &f.invalid), formNumber(t[u"fraction"], u"tiers[%1].fraction"_s.arg(i), &f.invalid)});
        ++i;
    }
    return f;
}

QJsonObject exitSpec(const ExitFields& f, bool derivative) {
    const QList<FilledTier> tiers = filledTiers(f.tiers);
    QJsonArray tierJson;
    for (const FilledTier& t : tiers) tierJson.append(QJsonObject{{u"price"_s, t.price}, {u"fraction_pct"_s, t.fraction}});
    QJsonObject out{
        {u"exit_at"_s, jsTrim(f.exitAt)},
        {u"spot_stop_confirm_s"_s, str(f.stopConfirm)},
        {u"take_profit_tiers"_s, tiers.isEmpty() ? QJsonValue(QString()) : QJsonValue(tierJson)},
    };
    // 正股没有「可成交价」与追价(引擎会拒),所以不是期权 / 组合时这几项一律不带;原模块里是 undefined 的键不带
    if (!derivative) return out;
    out.insert(u"stop_basis"_s, f.stopBasis);
    if (!str(f.chaseGrace).isEmpty()) out.insert(u"stop_chase_grace"_s, str(f.chaseGrace));
    if (!str(f.chaseStep).isEmpty()) out.insert(u"stop_chase_step"_s, str(f.chaseStep));
    if (!str(f.chaseMax).isEmpty()) out.insert(u"stop_chase_max_pct"_s, str(f.chaseMax));
    if (f.peakConfirm) out.insert(u"peak_confirm"_s, true);
    return out;
}

QStringList exitProblems(const ExitFields& f, const ProblemOpts& opts) {
    QStringList out;
    if (!jsTrim(f.exitAt).isEmpty() && !clockOk(f.exitAt)) out << u"到点平仓的时刻要写成美东时间的 HH:MM,如 15:45。"_s;
    if (std::any_of(f.tiers.begin(), f.tiers.end(), [](const TierField& t) { return t.price.has_value() != t.fraction.has_value(); }))
        out << u"分批止盈的每一档要把价和比例都填上。"_s;
    if (!filledTiers(f.tiers).isEmpty() && opts.hosted) out << u"分批止盈只支持软件盯盘:托管到券商时不能设。"_s;
    if (f.stopConfirm && *f.stopConfirm > 0) {
        // 正股的标的就是它自己:确认秒数管它的止损价 / 跟踪止损;托管的止损券商触线即发,等多久都拦不住
        if (opts.stock) {
            if (!opts.hasStockStop) out << u"正股的止损确认要先填止损价或跟踪止损。"_s;
            else if (opts.hosted) out << u"托管到券商的止损由券商触线即发,确认秒数只在软件自己盯时有用:要用它就别托管。"_s;
        } else if (!opts.hasSpotStop) {
            out << u"确认秒数是给标的止损价用的:先填「标的跌到」或「标的涨到」。"_s;
        }
    }
    return out;
}

QString exitConfirmLines(const ExitFields& f, bool derivative) {
    QStringList out;
    const QString at = jsTrim(f.exitAt);
    if (!at.isEmpty()) out << u"到点平仓:下一次到美东 %1 时持仓还在就平(不算止损);软件开着时才盯。"_s.arg(at);
    const QList<FilledTier> tiers = filledTiers(f.tiers);
    if (!tiers.isEmpty()) {
        QStringList parts;
        for (qsizetype i = 0; i < tiers.size(); ++i) parts << u"第 %1 档到 %2 平 %3%"_s.arg(i + 1).arg(tiers[i].price, tiers[i].fraction);
        out << u"分批止盈:%1。每一档成交之后接着盯剩下的仓。"_s.arg(parts.join(u","_s));
    }
    if (f.stopConfirm && *f.stopConfirm > 0) {
        const QString s = jsNumberToString(*f.stopConfirm);
        out << (derivative ? u"标的止损要标的在线外连续待满 %1 秒才平。"_s.arg(s) : u"止损要现价在线外连续待满 %1 秒才平(一笔打穿又弹回的不算)。"_s.arg(s));
    }
    if (derivative && f.stopBasis == u"natural") out << u"止损、跟踪止损、利润回撤按「此刻立刻能成交的价」判(盘口变宽时会比按中间价判更早触发)。"_s;
    if (derivative && (f.chaseGrace || f.chaseStep || f.chaseMax)) {
        out << u"止损类触发后的追价:%1,之后每秒让 %2 跳%3。"_s.arg(f.chaseGrace ? u"先等 %1 秒"_s.arg(jsNumberToString(*f.chaseGrace)) : u"先等 2 秒"_s,
                                                       f.chaseStep ? jsNumberToString(*f.chaseStep) : u"1"_s,
                                                       f.chaseMax ? u",最多让到立刻成交价的 %1%"_s.arg(jsNumberToString(*f.chaseMax)) : QString());
    }
    if (derivative && f.peakConfirm) out << u"峰值要连续两秒都见到才往上推:跟踪止损与利润回撤的峰值晚一秒,只出现一秒的高点不算。"_s;
    return out.isEmpty() ? QString() : out.join(u'\n') + u'\n';
}

QString tierLabel(const QJsonObject& tier, int index) {
    const QString state = jsTruthy(tier.value("done"_L1)) ? u"已成交"_s : jsTruthy(tier.value("pending"_L1)) ? u"平仓单已发,等成交"_s : u"未到"_s;
    return u"第 %1 档 %2 平 %3%(%4)"_s.arg(index + 1).arg(price4(jsNumber(tier.value("price"_L1))), price4(jsNumber(tier.value("fraction_pct"_L1))), state);
}

QString exitMoment(double ms) {
    static const QTimeZone et("America/New_York");
    return QDateTime::fromMSecsSinceEpoch(qint64(ms), et).toString(u"MM-dd HH:mm"_s);
}

QStringList exitSummary(const QJsonObject& targets, const QJsonObject& autoClose, bool stock) {
    QStringList out;
    if (jsTruthy(targets.value("exit_at"_L1))) {
        // 时刻被清掉了 = 到点那天没平掉、这一次已经作废(引擎当时提醒过);点「恢复」或重新设置才有下一次
        const QJsonValue ms = targets.value("exit_at_ms"_L1);
        out << (ms.isDouble() ? u"到点平仓 美东 "_s + exitMoment(ms.toDouble())
                              : u"到点平仓 美东 %1(已过期,不会再触发)"_s.arg(jsString(targets.value("exit_at"_L1))));
    }
    const QJsonArray tiers = targets.value("take_profit_tiers"_L1).toArray();
    if (!tiers.isEmpty()) {
        const auto done = std::count_if(tiers.begin(), tiers.end(), [](const QJsonValue& t) { return jsTruthy(t[u"done"]); });
        out << u"分批止盈 %1/%2 档"_s.arg(done).arg(tiers.size());
    }
    if (jsTruthy(targets.value("spot_stop_confirm_s"_L1)))
        out << u"%1 %2 秒"_s.arg(stock ? u"止损确认"_s : u"标的止损确认"_s, jsString(targets.value("spot_stop_confirm_s"_L1)));
    if (autoClose.value("stop_basis"_L1) == u"natural"_s) out << u"止损按可成交价判"_s;
    if (jsTruthy(autoClose.value("peak_confirm"_L1))) out << u"峰值两秒确认"_s;
    const QJsonValue grace = autoClose.value("stop_chase_grace"_L1);
    const QJsonValue step = autoClose.value("stop_chase_step"_L1);
    const QJsonValue max = autoClose.value("stop_chase_max_pct"_L1);
    if (!nullish(grace) || !nullish(step) || !nullish(max)) {
        out << u"止损追价 等 %1 秒 / 每秒 %2 跳%3"_s.arg(nullish(grace) ? u"2"_s : jsString(grace), nullish(step) ? u"1"_s : jsString(step),
                                                    nullish(max) ? QString() : u" / 最多 %1%"_s.arg(jsString(max)));
    }
    return out;
}

const QHash<QString, QString>& trackStateLabel() {
    static const QHash<QString, QString> m{
        {u"holding"_s, u"持有中"_s},
        {u"take_profit"_s, u"止盈已触发"_s},
        {u"profit_trail"_s, u"利润回撤已触发"_s},
        {u"stop_loss"_s, u"止损已触发"_s},
        {u"manual"_s, u"已手动平仓"_s},
        {u"time_exit"_s, u"已到点平仓"_s},
        {u"closed"_s, u"持仓已不在"_s},
        // 触发了、正在把托管单改到立刻成交的价往下追(见引擎 sweepReason)
        {u"sweep:take_profit"_s, u"到了目标价,追价平仓中"_s},
        {u"sweep:stop_loss"_s, u"止损触发,追价平仓中"_s},
        {u"sweep:profit_trail"_s, u"利润回撤触发,追价平仓中"_s},
        {u"sweep:manual"_s, u"手动平仓,追价中"_s},
        {u"sweep:time_exit"_s, u"到点了,追价平仓中"_s},
    };
    return m;
}

QString legLabel(const QString& symbol, const QString& secType, const QJsonObject& c) {
    if (secType == u"BAG") return jsTruthy(c.value("label"_L1)) ? symbol + u" · "_s + jsString(c.value("label"_L1)) : symbol + u" 组合"_s;
    if (secType != u"OPT" && secType != u"FOP") return symbol;
    const QJsonValue month = c.value("lastTradeDateOrContractMonth"_L1);
    QString expiry = (jsTruthy(month) ? jsString(month) : QString()).left(8);
    if (expiry.size() == 8) expiry = u"%1-%2-%3"_s.arg(expiry.left(4), expiry.mid(4, 2), expiry.mid(6));
    const QJsonValue strikeValue = c.value("strike"_L1);
    const QString strike = nullish(strikeValue) ? QString() : jsNumberToString(jsNumber(strikeValue));
    const QJsonValue rightValue = c.value("right"_L1);
    const QString right = (jsTruthy(rightValue) ? jsString(rightValue) : QString()).left(1).toUpper();
    QStringList parts;
    for (const QString& s : {symbol, strike + right, expiry})
        if (!jsTrim(s).isEmpty()) parts << s;
    return parts.join(u' ');
}

}  // namespace ibkr::shell::track
