#include "shell/track_form.h"

#include "shell/jsvalue.h"

#include "shell/track_levels.h"

#include <QHash>
#include <QJsonArray>

#include <cmath>
#include <memory>

using namespace Qt::StringLiterals;

namespace ibkr::shell::track {

namespace {

QString str(const std::optional<double>& v) { return v ? jsNumberToString(*v) : QString(); }
QJsonValue num(const std::optional<double>& v) { return v ? QJsonValue(*v) : QJsonValue(QJsonValue::Null); }
bool nullish(const QJsonValue& v) { return v.isNull() || v.isUndefined(); }

}  // namespace

FormState FormState::fromJson(const QJsonObject& position, bool autoExecute, const QJsonObject& v) {
    FormState s;
    s.position = position;
    s.autoExecute = autoExecute;
    const auto number = [&s, &v](const char* key, std::optional<double> fallback) {
        const QString k = QString::fromLatin1(key);
        return v.contains(k) ? formNumber(v.value(k), k, &s.invalid) : fallback;
    };
    const auto flag = [&s, &v](const char* key) {
        const QJsonValue x = v.value(QLatin1StringView(key));
        if (!x.isBool() && !x.isNull() && !x.isUndefined()) s.invalid << QString::fromLatin1(key);
        return x.toBool();
    };
    s.tp = number("tp", std::nullopt);
    s.sl = number("sl", std::nullopt);
    s.trail = number("trail", std::nullopt);
    s.profitDd = number("profitDd", std::nullopt);
    s.ddArm = number("ddArm", 10);
    s.tiers = flag("tiers");
    s.spotTarget = number("spotTarget", std::nullopt);
    s.stopBelow = number("stopBelow", std::nullopt);
    s.stopAbove = number("stopAbove", std::nullopt);
    s.fraction = number("fraction", std::nullopt);
    s.chaseMax = number("chaseMax", std::nullopt);
    const QJsonValue picked = v.value("autoPicked"_L1);
    if (picked.isBool()) s.autoPicked = picked.toBool();
    else if (!picked.isNull() && !picked.isUndefined()) s.invalid << u"autoPicked"_s;
    const QJsonValue order = v.value("orderType"_L1);
    if (order == u"MKT"_s || order == u"LMT"_s) s.orderType = order.toString();
    else if (!order.isNull() && !order.isUndefined()) s.invalid << u"orderType"_s;
    s.host = flag("host");
    s.exits = ExitFields::fromJson(v.value("exits"_L1).toObject());
    return s;
}

QString FormState::orderTypeOrDefault() const { return orderType.value_or(isCombo() ? u"LMT"_s : u"MKT"_s); }

bool FormState::isCombo() const { return position.value("sec_type"_L1) == u"BAG"_s; }
bool FormState::derivative() const {
    const QString t = position.value("sec_type"_L1).toString();
    return isCombo() || t == u"OPT" || t == u"FOP";
}
bool FormState::autoClose() const { return autoPicked.value_or(autoExecute); }
bool FormState::hasSpotTarget() const { return spotTarget && *spotTarget > 0; }
bool FormState::hostAllowed() const { return !isCombo() || hasSpotTarget(); }
bool FormState::hostOn() const { return host && hostAllowed(); }

QJsonObject buildSpec(const FormState& s) {
    QJsonObject spec{
        {u"key"_s, s.position.value("key"_L1)},
        {u"take_profit"_s, s.hasSpotTarget() ? QString() : str(s.tp)},
        {u"stop_loss"_s, str(s.sl)},
        {u"trail_pct"_s, str(s.trail)},
        {u"profit_drawdown_pct"_s, s.tiers ? QString() : str(s.profitDd)},
        {u"profit_drawdown_arm_pct"_s, s.tiers || !s.profitDd ? QString() : str(s.ddArm)},
        {u"spot_target"_s, str(s.spotTarget)},
        {u"spot_stop_below"_s, str(s.stopBelow)},
        {u"spot_stop_above"_s, str(s.stopAbove)},
        {u"auto_close"_s, s.autoClose()},
        {u"order_type"_s, s.orderTypeOrDefault()},
        {u"host_at_broker"_s, s.hostOn()},
    };
    // 原版里是 undefined 的键在线上不存在:这几样只在有值时带
    if (s.tiers) spec.insert(u"profit_drawdown_preset"_s, u"fly"_s);
    if (!str(s.fraction).isEmpty()) spec.insert(u"close_fraction_pct"_s, str(s.fraction));
    if (!str(s.chaseMax).isEmpty()) spec.insert(u"chase_max_pct"_s, str(s.chaseMax));
    const QJsonObject exits = exitSpec(s.exits, s.derivative());
    for (auto it = exits.begin(); it != exits.end(); ++it) spec.insert(it.key(), it.value());
    return spec;
}

namespace {

/// 确认、建追踪那后半段(试算过了、或者不用试算)
void confirmAndAdd(const FormState& s, const FormDeps& deps, const QJsonObject& spec, const std::optional<QJsonObject>& quoted) {
    const QJsonObject& p = s.position;
    const QString symbol = p.value("symbol"_L1).toString();
    const QString account = jsString(p.value("account"_L1));
    const QString qty = jsNumberToString(std::fabs(jsNumber(p.value("quantity"_L1))));
    const QString target = fmtNum(num(s.spotTarget));
    // 要同意的那句话:先说价,再说它之后会怎么动
    QString priceLine;
    if (quoted) {
        const QJsonObject& q = *quoted;
        if (jsTruthy(q.value("spot_note"_L1)))
            priceLine += u"现价 %1:%2\n"_s.arg(nullish(q.value("spot"_L1)) ? u"—"_s : fmtNum(q.value("spot"_L1)), jsString(q.value("spot_note"_L1)));
        priceLine += u"%1 到 %2 → %3约 %4,预估收益 %5\n"_s.arg(symbol, target, s.isCombo() ? u"组合净价"_s : u"价格"_s, fmtMoney(q.value("price"_L1)),
                                                             fmtMoney(q.value("pnl"_L1)));
        priceLine += u"这个价按当前波动率算出来,软件开着时每秒重算并改单——标的真走到 %1 时\n挂的就是那一刻的价,不是现在这个数。\n"_s.arg(target);
        if (s.derivative())
            priceLine += u"标的真到了 %1(软件开着时按秒盯),不等%2价追上来,直接按各腿当时的买卖价挂立刻成交的价平掉,没成交就每秒再追。\n"_s.arg(
                target, s.isCombo() ? u"组合"_s : u"期权"_s);
    }
    const QString stopLine = spotStopConfirmLine(symbol, s.stopBelow, s.stopAbove) + exitConfirmLines(s.exits, s.derivative());
    const QString quotedMessage = quoted ? u"%1 到 %2 就走,现在算下来约 %3。"_s.arg(symbol, target, fmtMoney(quoted->value("price"_L1))) : QString();

    const auto add = [s, deps, spec, symbol] {
        deps.saving(true);
        deps.add(spec, [deps, symbol](const QJsonValue& created, const QString& error) {
            if (!error.isEmpty()) {
                deps.banner(error, false);
                return deps.saving(false);
            }
            deps.banner(u"已开始追踪 %1,下面「正在追踪」里可以看盯盘进度。"_s.arg(symbol), true);
            deps.reload([deps, created] {
                const QJsonValue id = created[u"track"][u"id"];
                deps.created(jsTruthy(id) ? id : QJsonValue(QJsonValue::Null));
                deps.saving(false);
            });
        });
    };

    QJsonObject box;
    if (s.hostOn()) {
        box = {{u"purpose"_s, u"tracker.add"_s},
               {u"binding"_s, spec},
               {u"title"_s, quoted ? u"确认这个止盈价位,并挂到券商"_s : u"托管到券商服务器"_s},
               {u"message"_s, quoted ? quotedMessage : u"%1 的止盈/止损将作为 GTC 单挂在券商服务器上。"_s.arg(symbol)},
               {u"detail"_s, priceLine + stopLine + u"数量 %1 · 账户 %2\n"_s.arg(qty, account) +
                                 u"这张 GTC 限价单会立刻挂到券商服务器上;软件关闭后它仍然有效,价格停在最后一次调整的位置。\n"_s +
                                 u"触发由券商实时行情决定,一张成交其余自动撤销(OCA)。"_s},
               {u"confirmLabel"_s, quoted ? u"同意这个价,挂单"_s : u"我确认"_s}};
    } else if (s.autoClose()) {
        // 这一步是在授权软件替你发单,值得一次明确的确认
        box = {{u"purpose"_s, u"tracker.add"_s},
               {u"binding"_s, spec},
               {u"title"_s, quoted ? u"确认这个止盈价位,并开启自动平仓"_s : u"开启到价自动平仓"_s},
               {u"message"_s, quoted ? quotedMessage : u"%1 到价后会自动发出平仓单,不再询问。"_s.arg(symbol)},
               {u"detail"_s, priceLine + stopLine +
                                 u"数量 %1 · 账户 %2 · %3\n软件关闭后不再盯盘。"_s.arg(qty, account, s.orderTypeOrDefault() == u"MKT" ? u"市价平仓"_s : u"限价平仓"_s)},
               {u"confirmLabel"_s, quoted ? u"同意这个价,开始追踪"_s : u"我确认"_s}};
    }
    if (box.isEmpty()) return add();
    deps.confirm(box, [add](bool ok) {
        if (ok) add();
    });
}

}  // namespace

QJsonValue levelPickerModel(const QJsonObject& p, const QJsonArray& watches, const QStringList& busy) {
    const QString symbol = p.value("symbol"_L1).toString();
    const QString secType = p.value("sec_type"_L1).toString();
    const bool derivative = secType == u"BAG" || secType == u"OPT" || secType == u"FOP";
    const bool isLong = jsNumber(p.value("quantity"_L1)) > 0;
    QJsonObject watch;
    for (const QJsonValue& w : watches)
        if (w[u"symbol"].toString() == symbol.toUpper()) {
            watch = w.toObject();
            break;
        }
    const bool computing = !watch.isEmpty() && busy.contains(watch.value("id"_L1).toString());
    const QJsonArray levelList = watch.value("levels"_L1).toArray();
    if (watch.isEmpty())
        return QJsonObject{{u"pending"_s, QJsonObject{{u"text"_s, symbol + u" 还没在盯价位(期权墙、均线、整数关口)。"_s}, {u"button"_s, u"算关键价位"_s}, {u"create"_s, true}, {u"computing"_s, false}}}};
    if (levelList.isEmpty())
        return QJsonObject{{u"pending"_s, QJsonObject{{u"text"_s, computing ? u"正在算关键价位…"_s : symbol + u" 的关键价位还没算出来"_s}, {u"button"_s, u"立刻算"_s},
                                                      {u"watchId"_s, watch.value("id"_L1)}, {u"computing"_s, computing}}}};
    const auto positive = [](const QJsonValue& v) -> std::optional<double> {
        if (v.isDouble() && std::isfinite(v.toDouble()) && v.toDouble() > 0) return v.toDouble();
        return std::nullopt;
    };
    std::optional<double> spot = derivative ? positive(watch.value("last_price"_L1)) : positive(p.value("market_price"_L1));
    if (!spot) spot = positive(watch.value("last_price"_L1));
    if (!spot) return QJsonValue();
    const auto chips = [&](const QString& mode) {
        const QJsonObject sides = levels::pickSides(levelList, *spot, mode, isLong, derivative);
        QJsonArray out;
        for (const QString& side : {u"below"_s, u"above"_s}) {
            const QJsonArray list = sides.value(side).toArray();
            for (qsizetype i = 0; i < list.size() && i < 3; ++i) {
                const QJsonObject l = list[i].toObject();
                const double price = l.value("price"_L1).toDouble();
                out.append(QJsonObject{{u"label"_s, levels::levelName(l, levels::sourceShort()) + u' ' + levels::fmtLevel(price)},
                                       {u"price"_s, price},
                                       {u"side"_s, side},
                                       {u"tip"_s, u"%1 · 距现价 %2"_s.arg(jsString(l.value("label"_L1)), levels::fmtGap((price / *spot - 1) * 100))}});
            }
        }
        return out;
    };
    return QJsonObject{
        {u"title"_s, symbol + u" 的关键价位"_s},
        {u"summary"_s, levels::levelSummary(levelList, *spot, levels::sourceShort())},
        {u"strip"_s, QJsonObject{{u"levels"_s, levelList}, {u"spot"_s, *spot}}},
        {u"stopLabel"_s, derivative ? u"点一下填进标的止损(%1 跌到 / 涨到)"_s.arg(symbol) : u"点一下填进止损价"_s},
        {u"targetLabel"_s, derivative ? u"点一下填进标的目标价"_s : u"点一下填进止盈价"_s},
        {u"stopChips"_s, chips(u"stop"_s)},
        {u"targetChips"_s, chips(u"target"_s)},
        {u"hint"_s, u"建好之后,卡片上会写出每条线和最近那个价位的位置关系。止损在支撑之上(空头:在阻力之下)时,价格还没碰到那个价位就会先止损。"_s},
    };
}

QJsonObject previewOutcome(const QJsonValue& result, const QString& error) {
    if (!error.isEmpty()) return {{u"priced"_s, QJsonValue()}, {u"error"_s, error}};
    const QJsonValue row = result[u"spot_target"];
    if (row.isObject() && !nullish(row[u"price"])) return {{u"priced"_s, row}, {u"error"_s, QJsonValue()}};
    const QJsonValue reason = row[u"reason"];
    return {{u"priced"_s, QJsonValue()}, {u"error"_s, jsTruthy(reason) ? jsString(reason) : u"这一刻算不出这个点位的价格。"_s}};
}

QJsonArray previewLines(const QJsonObject& p, double target, const QJsonValue& pricedValue, const QString& error) {
    static const QHash<QString, QString> sigmaHint{
        {u"none"_s, u"正股:目标价就是价格,不用波动率"_s},
        {u"ibkr"_s, u"每条腿用 IBKR 推的模型隐含波动率,在目标价处各自重估,再锚到当前报价上"_s},
        {u"smile"_s, u"每条腿按各自当前的报价反解波动率,在目标价处各自重估"_s},
        {u"net"_s, u"按这份持仓当前的报价反解波动率"_s},
        {u"leg"_s, u"有腿缺报价,按最贴近平值那条腿的波动率给所有腿用"_s},
        {u"clock"_s, u"拿不到市场报价,用的是模型默认波动率(EM×√剩余方差)——不是市场价,只当个参考"_s},
    };
    if (!pricedValue.isObject()) return {QJsonObject{{u"text"_s, error.isEmpty() ? u"正在按当前行情试算…"_s : error}, {u"cls"_s, u"hint"_s}}};
    const QJsonObject q = pricedValue.toObject();
    const QString symbol = p.value("symbol"_L1).toString();
    const bool isCombo = p.value("sec_type"_L1) == u"BAG"_s;
    const double pnl = q.value("pnl"_L1).isDouble() ? q.value("pnl"_L1).toDouble() : 0;
    QJsonArray out;
    out.append(QJsonObject{{u"text"_s, u"%1 到 %2"_s.arg(symbol, fmtNum(QJsonValue(target)))}, {u"cls"_s, u"meta"_s}});
    out.append(QJsonObject{{u"text"_s, u"%1 %2"_s.arg(isCombo ? u"组合净价"_s : u"约值"_s, fmtMoney(q.value("price"_L1)))}, {u"cls"_s, u"strong"_s}});
    QString pnlText = u"预估收益 %1%2"_s.arg(pnl >= 0 ? u"+"_s : QString(), fmtMoney(q.value("pnl"_L1)));
    if (!nullish(q.value("pnl_pct"_L1))) pnlText += u" (%1%)"_s.arg(jsToFixed(jsNumber(q.value("pnl_pct"_L1)), 1));
    out.append(QJsonObject{{u"text"_s, pnlText}, {u"cls"_s, pnl >= 0 ? u"up"_s : u"down"_s}});
    if (jsTruthy(q.value("warning"_L1))) out.append(QJsonObject{{u"text"_s, jsString(q.value("warning"_L1))}, {u"cls"_s, u"warn"_s}});
    if (!nullish(q.value("natural"_L1))) {
        QString s = u"现在立刻平掉约 %1(按各腿当前买卖价;标的到了目标价、或止损类目标触发时,平仓单会改到这个口径的价追着平)"_s.arg(fmtMoney(q.value("natural"_L1)));
        if (!nullish(q.value("chase_floor"_L1)))
            s += u";追价先在这个价上等两秒,之后每秒再让一跳,最多让到 %1(%2%)"_s.arg(fmtMoney(q.value("chase_floor"_L1)),
                                                                                 nullish(q.value("chase_max_pct"_L1)) ? u"10"_s : jsString(q.value("chase_max_pct"_L1)));
        out.append(QJsonObject{{u"text"_s, s}, {u"cls"_s, u"hint"_s}});
    }
    const QString source = jsTruthy(q.value("sigma_source"_L1)) ? jsString(q.value("sigma_source"_L1)) : QString();
    QString sigma = sigmaHint.value(source);
    const QJsonObject legs = q.value("leg_sigmas"_L1).toObject();
    if (jsTruthy(q.value("leg_sigmas"_L1))) {
        // 原版是 Object.entries(leg_sigmas):引擎插键的次序 = 持仓合约里各腿的次序(tracker.ts 的 structureOf → ibkrLegSigmas / smileSigmas,
        // 键是 legPriceKey:行权价 + C/P)。QJsonObject 把键按字母排了,所以照合约的腿重排;对不上的(不该有)按原来的次序接在后面
        QStringList order;
        for (const QJsonValue& lv : p.value("contract"_L1).toObject().value("legs"_L1).toArray()) {
            const QJsonObject l = lv.toObject();
            const QString key = jsNumberToString(jsNumber(l.value("strike"_L1))) + jsString(l.value("right"_L1)).left(1).toUpper();
            if (legs.contains(key) && !order.contains(key)) order << key;
        }
        for (auto it = legs.begin(); it != legs.end(); ++it)
            if (!order.contains(it.key())) order << it.key();
        QStringList parts;
        for (const QString& k : order) parts << k + u' ' + fmtNum(legs.value(k));
        sigma += u" · σ_剩余 %1 点"_s.arg(parts.join(u" / "_s));
    } else if (!nullish(q.value("sigma"_L1))) {
        sigma += u" · σ_剩余 %1 点"_s.arg(fmtNum(q.value("sigma"_L1)));
    }
    out.append(QJsonObject{{u"text"_s, sigma}, {u"cls"_s, source == u"clock" ? u"warn"_s : u"hint"_s}});
    if (jsTruthy(q.value("spot_note"_L1)))
        out.append(QJsonObject{{u"text"_s, u"%1 现价 %2:%3"_s.arg(symbol, nullish(q.value("spot"_L1)) ? u"—"_s : fmtNum(q.value("spot"_L1)), jsString(q.value("spot_note"_L1)))},
                               {u"cls"_s, u"hint"_s}});
    if (source == u"clock") out.append(QJsonObject{{u"text"_s, u"这个价只能参考:拿不到市场报价,不能拿它开自动平仓或挂单。"_s}, {u"cls"_s, u"warn"_s}});
    return out;
}

void startTrack(const FormState& s, const FormDeps& deps) {
    // 读不成数的值绝不当"没填":那会让一道保护悄悄没设上。原版的输入框只交数,这一条只会在界面写错时出现
    const QStringList invalid = s.invalid + s.exits.invalid;
    if (!invalid.isEmpty()) return deps.banner(u"表单里有读不成数字的值(%1),没有发出任何请求。"_s.arg(invalid.join(u"、"_s)), false);
    const QJsonObject spec = buildSpec(s);
    ProblemOpts opts;
    opts.hosted = s.hostOn();
    opts.hasSpotStop = s.stopBelow || s.stopAbove;
    opts.stock = !s.derivative();
    opts.hasStockStop = s.sl || s.trail;
    const QStringList problems = exitProblems(s.exits, opts);
    if (!problems.isEmpty()) return deps.banner(problems.first(), false);
    if (s.hostOn() && !s.autoClose()) {
        // 托管单就是授权发单——没有总开关的托管是自相矛盾的设置
        return deps.banner(u"托管到券商需先打开「到价自动平仓」:挂托管单即发单授权。"_s, false);
    }
    // 「同意价格后发单」:同意的那一刻现取一次价,不拿几秒前那份凑数。算不出来就不往下走——盲签一张会真发出去的单,比不发危险得多
    if (!(s.hasSpotTarget() && (s.autoClose() || s.hostOn()))) return confirmAndAdd(s, deps, spec, std::nullopt);
    deps.saving(true);
    const QString symbol = s.position.value("symbol"_L1).toString();
    deps.preview(s.position.value("key"_L1).toString(), *s.spotTarget, s.chaseMax, [s, deps, spec, symbol](const QJsonValue& res, const QString& error) {
        if (!error.isEmpty()) {
            deps.banner(error, false);
            deps.saving(false);  // catch 里一次、finally 里一次(原样)
            return deps.saving(false);
        }
        deps.saving(false);
        const QJsonValue quoted = res[u"spot_target"];
        if (!quoted.isObject() || nullish(quoted[u"price"])) {
            const QJsonValue reason = quoted[u"reason"];
            return deps.banner(jsTruthy(reason) ? jsString(reason) : u"这一刻算不出 %1 到 %2 的价格,先别发单。"_s.arg(symbol, jsNumberToString(*s.spotTarget)), false);
        }
        if (quoted[u"sigma_source"] == u"clock"_s) {
            // 能同意的只有市场价算出来的数;模型默认波动率算的参考价没有人能替你担保
            return deps.banner(u"现在拿不到市场报价,这个价是按模型默认波动率算的参考值,不能拿它发单。等行情来了再设。"_s, false);
        }
        if (jsTruthy(quoted[u"warning"])) return deps.banner(jsString(quoted[u"warning"]), false);
        confirmAndAdd(s, deps, spec, quoted.toObject());
    });
}

}  // namespace ibkr::shell::track
