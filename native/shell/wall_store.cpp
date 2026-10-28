#include "shell/wall_store.h"

#include "shell/bridge.h"
#include "shell/jsvalue.h"
#include "shell/playbook_format.h"

#include <QDateTime>
#include <QPointer>

#include <cmath>

namespace ibkr::shell {

using namespace Qt::StringLiterals;

namespace walls {

namespace {

/// 离现价不到这么多(百分比)的墙标成橙色:价已经贴着墙了
constexpr double kNearPct = 0.25;

std::optional<double> pctOff(const QJsonValue& level, const QJsonValue& spot) {
    if (!level.isDouble() || !spot.isDouble() || !(spot.toDouble() > 0) || !std::isfinite(level.toDouble())) return std::nullopt;
    return (level.toDouble() / spot.toDouble() - 1.0) * 100.0;
}

QJsonValue strikeOf(const QJsonValue& wall) { return wall.isObject() ? wall.toObject().value("strike"_L1) : QJsonValue(); }

QJsonObject levelItem(const QString& label, const QJsonValue& level, const QJsonValue& spot, const QString& tip) {
    const QString d = distanceText(level, spot);
    const QString value = level.isDouble() ? jsString(level) : u"—"_s;
    const auto pct = pctOff(level, spot);
    return {{u"text"_s, d.isEmpty() ? u"%1 %2"_s.arg(label, value) : u"%1 %2(%3)"_s.arg(label, value, d)},
            {u"tip"_s, tip},
            {u"tone"_s, pct && std::fabs(*pct) <= kNearPct ? u"near"_s : u""_s}};
}

QString expiryText(const QJsonValue& expiry) {
    const QString e = jsString(expiry);
    return e.size() == 8 ? u"%1-%2"_s.arg(e.mid(4, 2), e.mid(6, 2)) : e;
}

}  // namespace

const QStringList& symbols() {
    static const QStringList s{u"SPX"_s, u"QQQ"_s};
    return s;
}

QString distanceText(const QJsonValue& level, const QJsonValue& spot) {
    const auto pct = pctOff(level, spot);
    if (!pct) return {};
    return (*pct >= 0 ? u"+"_s : u"−"_s) + jsToFixed(std::fabs(*pct), 2) + u'%';
}

QJsonObject rowModel(const QString& symbol, const QJsonObject& state) {
    const QJsonValue failure = state.value("failure"_L1);
    QJsonObject row{{u"symbol"_s, symbol}, {u"failure"_s, failure.isString() ? failure : QJsonValue(u""_s)}};
    if (!state.value("result"_L1).isObject()) {
        row.insert(u"items"_s, QJsonArray{});
        row.insert(u"spot"_s, u"—"_s);
        row.insert(u"expiry"_s, u""_s);
        row.insert(u"note"_s, failure.isString() ? u""_s : (state.value("busy"_L1).toBool() ? u"正在取期权链…"_s : u"连上 TWS 之后显示"_s));
        return row;
    }
    const QJsonObject w = state.value("result"_L1).toObject();
    const QJsonValue spot = w.value("spot"_L1);
    QJsonArray items{
        levelItem(u"看涨墙"_s, strikeOf(w.value("call_wall"_L1)), spot, u"现价上方未平仓量最大的看涨行权价:涨到这里常被压住"_s),
        levelItem(u"看跌墙"_s, strikeOf(w.value("put_wall"_L1)), spot, u"现价下方未平仓量最大的看跌行权价:跌到这里常被托住"_s),
        levelItem(u"Gamma 翻转"_s, w.value("gamma_flip"_L1), spot,
                  u"净 gamma 变号的价位里离现价最近的那个:越过它,正负 gamma 换边。取到的行权价范围里不变号、或推算它的那条曲线在现价处的正负和净 gamma 对不上,就不给"_s),
        levelItem(u"最大痛点"_s, strikeOf(w.value("max_pain"_L1)), spot, u"按未平仓量算,到期时期权买方总共赚得最少的价位(统计量,不是预言)"_s),
        levelItem(u"量墙 C"_s, strikeOf(w.value("call_vol_wall"_L1)), spot, u"今天成交量最大的看涨行权价(现价上方):今天新开的仓,比未平仓量更新"_s),
        levelItem(u"量墙 P"_s, strikeOf(w.value("put_vol_wall"_L1)), spot, u"今天成交量最大的看跌行权价(现价下方)"_s),
        QJsonObject{{u"text"_s, playbook::gexText(w)}, {u"tip"_s, playbook::kGexAssumptionHint}, {u"tone"_s, u""_s}},
    };
    QStringList note;
    if (state.value("at"_L1).isDouble()) note << u"取于美东 "_s + playbook::etTime(state.value("at"_L1));
    const QString cover = playbook::coverageText(w.value("coverage"_L1), w.value("oi_missing"_L1));
    if (!cover.isEmpty()) note << cover;
    if (failure.isString()) note << u"这一次没取到,摆的是上一次的"_s;
    row.insert(u"spot"_s, playbook::fmtLevel(spot));
    row.insert(u"expiry"_s, expiryText(w.value("expiry"_L1)));
    row.insert(u"items"_s, items);
    row.insert(u"note"_s, note.join(u" · "_s));
    return row;
}

}  // namespace walls

WallStore::WallStore(walls::StoreDeps deps, QObject* parent) : QObject(parent), deps_(std::move(deps)) {
    for (const QString& s : walls::symbols())
        state_.insert(s, QJsonObject{{u"result"_s, QJsonValue()}, {u"failure"_s, QJsonValue()}, {u"at"_s, QJsonValue()}, {u"busy"_s, false}});
    timer_.setInterval(kRefreshMs);
    connect(&timer_, &QTimer::timeout, this, &WallStore::refresh);
}

WallStore::WallStore(Bridge* bridge, QObject* parent) : WallStore(walls::StoreDeps{}, parent) { deps_ = bridgeDeps(bridge, this); }

walls::StoreDeps WallStore::bridgeDeps(Bridge* bridge, QObject* context) {
    walls::StoreDeps d;
    d.wall = [bridge, context](const QJsonObject& params, walls::StoreDeps::Reply done) { bridge->rpc(context, u"options.wall"_s, params, done); };
    d.nowMs = [] { return double(QDateTime::currentMSecsSinceEpoch()); };
    return d;
}

QJsonArray WallStore::rows() const {
    QJsonArray out;
    for (const QString& s : walls::symbols()) out.append(walls::rowModel(s, state_.value(s).toObject()));
    return out;
}

void WallStore::put(const QString& symbol, const QJsonObject& part) {
    QJsonObject s = state_.value(symbol).toObject();
    for (auto it = part.begin(); it != part.end(); ++it) s.insert(it.key(), it.value());
    state_.insert(symbol, s);
    emit changed();
}

void WallStore::setVisible(bool on) {
    visible_ = on;
    if (!on) {
        timer_.stop();
        return;
    }
    timer_.setInterval(refreshMs);
    timer_.start();
    refresh();
}

void WallStore::refresh() {
    if (running_) return;
    running_ = true;
    fetch(0);
}

void WallStore::fetch(qsizetype index) {
    // 一个取完再取下一个:两条链同时订,行情线路翻倍
    if (index >= walls::symbols().size()) {
        running_ = false;
        return;
    }
    const QString symbol = walls::symbols().at(index);
    put(symbol, {{u"busy"_s, true}});
    QPointer<WallStore> self(this);
    deps_.wall(QJsonObject{{u"symbol"_s, symbol}, {u"width"_s, walls::kWidth}}, [self, symbol, index](const EngineReply& r) {
        if (!self) return;
        if (r.ok && r.result.isObject())
            self->put(symbol, {{u"result"_s, r.result}, {u"failure"_s, QJsonValue()}, {u"at"_s, self->deps_.nowMs()}, {u"busy"_s, false}});
        else
            self->put(symbol, {{u"failure"_s, r.ok ? u"引擎回的不是期权墙"_s : r.error}, {u"busy"_s, false}});
        // 页面在这一轮中途卸下了:剩下的不取
        if (!self->visible_) {
            self->running_ = false;
            return;
        }
        self->fetch(index + 1);
    });
}

}  // namespace ibkr::shell
