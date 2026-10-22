#include "shell/tracker_page.h"

#include "shell/jsvalue.h"
#include "shell/track_card.h"
#include "shell/track_rules.h"

#include <cmath>

using namespace Qt::StringLiterals;

namespace ibkr::shell::track {

namespace {
bool nullish(const QJsonValue& v) { return v.isNull() || v.isUndefined(); }

QStringList stringList(const QJsonValue& v) {
    QStringList out;
    for (const QJsonValue& s : v.toArray()) out << s.toString();
    return out;
}
}  // namespace

QJsonObject positionModel(const QJsonObject& p, bool compact, const QString& openKey) {
    const QString secType = p.value("sec_type"_L1).toString();
    const bool isCombo = secType == u"BAG";
    const bool credit = p.value("net_side"_L1) == u"credit"_s;
    const QString unit = isCombo ? u"组"_s : secType == u"OPT" ? u"张"_s : u"股"_s;
    // 组合的成本 / 现价是"每组净价"(IBKR 口径含乘数的成本 → 按乘数折回每股价),借方 / 贷方要标出来
    const auto perUnit = [&](const QJsonValue& v) -> QJsonValue {
        if (!isCombo || nullish(v)) return v;
        const double mult = jsTruthy(p.value("multiplier"_L1)) ? jsNumber(p.value("multiplier"_L1)) : 100;
        return v.toDouble() / mult;
    };
    const QJsonValue cost = perUnit(p.value("avg_cost"_L1));
    // 休市没有现价(个股期权没有夜盘):退到昨收估一个数,并明说它是昨收
    const bool stale = nullish(p.value("unrealized_pnl"_L1)) && nullish(p.value("market_price"_L1)) && !nullish(p.value("close_price"_L1));
    const QJsonValue pnl = stale ? p.value("close_pnl"_L1) : p.value("unrealized_pnl"_L1);
    const QJsonValue pct = stale ? p.value("close_pct"_L1) : p.value("unrealized_pct"_L1);
    const QString dir = nullish(pnl) || pnl.toDouble() == 0 ? QString() : pnl.toDouble() > 0 ? u"up"_s : u"down"_s;
    const double qty = jsNumber(p.value("quantity"_L1));
    const QString symbol = p.value("symbol"_L1).toString();
    const QString label = jsTruthy(p.value("label"_L1)) ? jsString(p.value("label"_L1)) : legLabel(symbol, secType, p.value("contract"_L1).toObject());

    QJsonObject pill;
    if (isCombo) pill = {{u"tint"_s, credit ? u"orange"_s : u"indigo"_s}, {u"text"_s, credit ? u"贷方 · 收权利金"_s : u"借方 · 付权利金"_s}};
    else pill = {{u"tint"_s, qty > 0 ? u"up"_s : u"down"_s}, {u"text"_s, qty > 0 ? u"多头"_s : u"空头"_s}, {u"tri"_s, qty > 0 ? u"up"_s : u"down"_s}};

    QJsonArray notes;
    if (stale) notes.append(QJsonObject{{u"text"_s, u" · 按昨收估算(休市无报价)"_s},
                                        {u"tip"_s, u"这个合约此刻休市,券商不报买卖价也没有最新成交,只有昨收。这里按昨收估算,仅供参考;追踪的触发与挂单定价不用它,开盘有报价后自动换回现价。"_s}});
    if (p.value("pnl_source"_L1) == u"computed"_s)
        notes.append(QJsonObject{{u"text"_s, u" · 本地按现价计算"_s}, {u"tip"_s, u"券商这条路没报盈亏(只给了成本),这里用与追踪器同一套口径算出来;对账以券商为准。"_s}});

    QJsonArray facts{
        QJsonObject{{u"value"_s, jsNumberToString(std::fabs(qty))}, {u"label"_s, unit}},
        QJsonObject{{u"value"_s, fmtMoney(cost)}, {u"label"_s, isCombo ? (credit ? u"净收"_s : u"净付"_s) : u"成本"_s}},
        QJsonObject{{u"value"_s, !nullish(p.value("market_price"_L1)) ? fmtMoney(p.value("market_price"_L1)) : stale ? fmtMoney(p.value("close_price"_L1)) : u"—"_s},
                    {u"label"_s, stale ? (isCombo ? u"组合昨收"_s : u"昨收"_s) : isCombo ? u"组合现价"_s : u"现价"_s}},
    };
    if (!compact) facts.append(QJsonObject{{u"value"_s, jsString(p.value("account"_L1))}, {u"label"_s, u"账户"_s}, {u"text"_s, true}});

    const QString key = p.value("key"_L1).toString();
    return {
        {u"key"_s, key},
        {u"position"_s, p},
        {u"title"_s, label},
        {u"pill"_s, pill},
        {u"compact"_s, compact},
        {u"badge"_s, compact ? QJsonValue() : QJsonValue(QJsonObject{{u"text"_s, symbol.left(5)}, {u"tint"_s, dir == u"down" ? u"down"_s : dir == u"up" ? u"up"_s : u"blue"_s}})},
        {u"hero"_s, nullish(pnl) ? u"—"_s : (pnl.toDouble() > 0 ? u"+"_s : QString()) + fmtMoney(pnl)},
        {u"heroDir"_s, dir},
        {u"heroSub"_s, isCombo ? u"组合未实现盈亏"_s : u"未实现盈亏"_s},
        {u"heroNotes"_s, notes},
        {u"pct"_s, !nullish(pct) && !dir.isEmpty() ? QJsonValue(QJsonObject{{u"text"_s, jsToFixed(std::fabs(jsNumber(pct)), 2) + u'%'}, {u"tint"_s, dir}}) : QJsonValue()},
        {u"facts"_s, facts},
        {u"tracked"_s, jsTruthy(p.value("tracked"_L1))},
        {u"open"_s, openKey == key},
    };
}

QJsonObject loopPulse(const QJsonValue& loopValue) {
    if (!loopValue.isObject()) return {{u"text"_s, u"盯盘节拍器:等第一轮结果…"_s}, {u"bad"_s, false}};
    const QJsonObject loop = loopValue.toObject();
    const QJsonValue age = loop.value("age_ms"_L1);
    // age_ms !== null && age_ms > 3000(缺键时 undefined > 3000 为假)
    const bool stale = !age.isNull() && age.isDouble() && age.toDouble() > 3000;
    const bool running = jsTruthy(loop.value("running"_L1));
    const bool bad = !running || stale || jsTruthy(loop.value("last_error"_L1)) || jsTruthy(loop.value("hold"_L1));
    QString text;
    if (!running) text = u"盯盘节拍器没在跑:追踪止盈与托管调价都停了"_s;
    else if (jsTruthy(loop.value("last_error"_L1))) text = u"盯盘这一轮没做成:"_s + jsString(loop.value("last_error"_L1));
    else if (stale) text = u"盯盘节拍器已经 %1 秒没跳了"_s.arg(jsNumberToString(jsRound((age.isDouble() ? age.toDouble() : 0) / 1000)));
    else if (jsTruthy(loop.value("hold"_L1))) text = jsString(loop.value("hold"_L1));
    else {
        const QJsonValue last = loop.value("last_ms"_L1);
        text = u"盯盘:引擎每 %1 秒一轮 · 上一轮 %2 ms"_s.arg(jsNumberToString(jsRound(loop.value("interval_ms"_L1).toDouble() / 100) / 10), nullish(last) ? u"—"_s : jsString(last));
        if (jsTruthy(loop.value("slow_ticks"_L1)))
            text += u" · 慢过 %1 轮(最长 %2 ms)"_s.arg(jsString(loop.value("slow_ticks"_L1)), jsString(loop.value("max_ms"_L1)));
    }
    return {{u"text"_s, text}, {u"bad"_s, bad}};
}

QJsonObject trackerPageModel(const PageInput& in) {
    const QJsonObject& snap = in.tracker;
    const QJsonArray positions = snap.value("positions"_L1).toArray();
    QJsonObject posSection;
    const QJsonValue posError = snap.value("positionsError"_L1);
    if (jsTruthy(posError)) {
        posSection = {{u"empty"_s, jsString(posError)}};
    } else if (positions.isEmpty()) {
        posSection = {{u"empty"_s, in.connected ? u"这个账户里没有持仓。"_s : u"连接%1之后才能读到持仓。"_s.arg(in.gateway)}};
    } else {
        // 组合优先:一只蝴蝶就是一张卡,组合价格与盈亏在最上面,整组一个追踪表单;腿明细折叠在下面
        QHash<QString, QJsonObject> byKey;
        for (const QJsonValue& p : positions) byKey.insert(p[u"key"].toString(), p.toObject());
        QSet<QString> inCombo;
        QJsonArray cards;
        for (const QJsonValue& v : positions) {
            if (v[u"sec_type"] != u"BAG"_s) continue;
            QJsonArray legs;
            for (const QString& k : stringList(v[u"legs"])) {
                inCombo.insert(k);
                if (byKey.contains(k)) legs.append(positionModel(byKey.value(k), true, in.openKey));
            }
            QJsonObject card = positionModel(v.toObject(), false, in.openKey);
            // 组合那张卡的标题是「代码 · 组合名」;单腿与正股是组合名或腿的写法
            card.insert(u"title"_s, u"%1 · %2"_s.arg(v[u"symbol"].toString(), jsString(v[u"label"])));
            card.insert(u"legs"_s, legs);
            card.insert(u"legsHeader"_s, u"腿明细(%1)· 按腿追踪"_s.arg(legs.size()));
            cards.append(card);
        }
        for (const QJsonValue& v : positions)
            if (v[u"sec_type"] != u"BAG"_s && !inCombo.contains(v[u"key"].toString())) cards.append(positionModel(v.toObject(), false, in.openKey));
        posSection = {{u"cards"_s, cards}};
    }

    const QJsonArray tracks = snap.value("tracks"_L1).toArray();
    const QJsonValue tracksError = snap.value("tracksError"_L1);
    QJsonValue pulse;
    const QJsonValue pollError = snap.value("pollError"_L1);
    if (jsTruthy(pollError))
        pulse = QJsonObject{{u"text"_s, u"读不到盯盘结果:%1。下面的价格与状态停在最后一次读到的时候。"_s.arg(jsString(pollError))}, {u"bad"_s, true}};
    else if (in.connected && !tracks.isEmpty())
        pulse = loopPulse(snap.value("loop"_L1));

    QJsonObject trackSection;
    if (tracks.isEmpty()) {
        trackSection = {{u"empty"_s, jsTruthy(tracksError) ? u"追踪列表没读到。"_s : u"还没有在追踪任何持仓。在上面的持仓卡片里设置止盈止损。"_s}};
    } else {
        QJsonArray cards;
        const QJsonObject rows = snap.value("rows"_L1).toObject();
        const QJsonObject hosted = snap.value("hosted"_L1).toObject();
        for (const QJsonValue& t : tracks) {
            const QString id = jsString(t[u"id"]);
            CardInput c;
            c.track = t.toObject();
            c.live = rows.contains(id) ? rows.value(id).toObject() : QJsonObject{{u"id"_s, t[u"id"]}};
            c.hosted = hosted.contains(id) ? hosted.value(id) : QJsonValue();
            c.delayed = jsTruthy(snap.value("delayed"_L1));
            c.connected = in.connected;
            c.gateway = in.gateway;
            c.watches = in.watches;
            c.busy = in.busy;
            cards.append(trackCardModel(c));
        }
        trackSection = {{u"cards"_s, cards}};
    }
    return {
        {u"positions"_s, posSection},
        {u"tracksError"_s, jsTruthy(tracksError) ? QJsonValue(u"%1。引擎里的追踪不受影响;引擎恢复后点「刷新持仓」。"_s.arg(jsString(tracksError))) : QJsonValue()},
        {u"pulse"_s, pulse},
        {u"tracks"_s, trackSection},
    };
}

namespace {
void positionTexts(const QJsonObject& m, QStringList& out) {
    out << m[u"title"].toString() << m[u"pill"][u"text"].toString();
    if (m[u"badge"].isObject()) out << m[u"badge"][u"text"].toString();
    out << m[u"hero"].toString() << m[u"heroSub"].toString();
    for (const QJsonValue& n : m[u"heroNotes"].toArray()) out << n[u"text"].toString().trimmed();
    if (m[u"pct"].isObject()) out << m[u"pct"][u"text"].toString();
    for (const QJsonValue& f : m[u"facts"].toArray()) out << f[u"value"].toString() << f[u"label"].toString();
    if (m[u"tracked"].toBool()) out << u"已在追踪中,设置见下方。"_s;
    else out << (m[u"open"].toBool() ? u"收起"_s : u"设置追踪"_s);
}
}  // namespace

QStringList pageTexts(const QJsonObject& model) {
    QStringList out{u"持仓追踪"_s, u"刷新持仓"_s, u"这一页会真的发单。"_s,
                    u"打开「到价自动平仓」后,价格触及止盈 / 止损时软件会自动发出平仓单;仍受三道闸门约束:自动执行已打开、实盘账户需在「设置」里允许实盘下单、熔断期间不发。"_s,
                    u"软件必须开着。"_s, u"盯盘在本机进行,关掉就不再盯,不同于挂在券商服务器上的条件单。"_s, u"账户持仓"_s, u"哪些持仓会出现在这里"_s};
    const QJsonObject pos = model[u"positions"].toObject();
    if (pos.contains(u"empty"_s)) out << pos[u"empty"].toString();
    for (const QJsonValue& c : pos[u"cards"].toArray()) {
        positionTexts(c.toObject(), out);
        if (c.toObject().contains(u"legsHeader"_s)) out << c[u"legsHeader"].toString();  // 腿明细默认收着,里面不渲染
    }
    out << u"正在追踪"_s;
    if (model[u"tracksError"].isString()) out << u"追踪列表没读到,下面是上一次读到的"_s << model[u"tracksError"].toString();
    if (model[u"pulse"].isObject()) out << model[u"pulse"][u"text"].toString();
    const QJsonObject tracks = model[u"tracks"].toObject();
    if (tracks.contains(u"empty"_s)) out << tracks[u"empty"].toString();
    for (const QJsonValue& c : tracks[u"cards"].toArray()) out << cardTexts(c.toObject());
    return out;
}

}  // namespace ibkr::shell::track
