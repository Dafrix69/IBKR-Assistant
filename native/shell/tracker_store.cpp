#include "shell/tracker_store.h"

#include "shell/alerter.h"
#include "shell/bridge.h"
#include "shell/jsvalue.h"
#include "shell/status_store.h"

#include <QJsonDocument>

#include <memory>

using namespace Qt::StringLiterals;

namespace ibkr::shell {

namespace {
QByteArray sig(const QJsonValue& v) {
    return QJsonDocument(v.isArray() ? QJsonDocument(v.toArray()) : QJsonDocument(QJsonArray{v})).toJson(QJsonDocument::Compact);
}
}  // namespace

TrackerStore::TrackerStore(Bridge* bridge, StatusStore* status, Alerter* alerter, QObject* parent)
    : QObject(parent), bridge_(bridge), status_(status), alerter_(alerter) {
    pollTimer_.setInterval(1'000);
    connect(&pollTimer_, &QTimer::timeout, this, &TrackerStore::poll);
    reconcileTimer_.setInterval(1'000);
    connect(&reconcileTimer_, &QTimer::timeout, this, &TrackerStore::reconcile);
}

QJsonObject TrackerStore::snap() const {
    return {{u"positions"_s, positions_}, {u"positionsError"_s, positionsError_}, {u"tracks"_s, tracks_}, {u"tracksError"_s, tracksError_},
            {u"rows"_s, rows_}, {u"hosted"_s, hosted_}, {u"delayed"_s, delayed_}, {u"loop"_s, loop_}, {u"pollError"_s, pollError_}};
}

void TrackerStore::start() {
    if (started_) return;
    started_ = true;
    load(false);
    pollTimer_.start();
    reconcileTimer_.start();
}

void TrackerStore::load(bool refreshPositions, std::function<void()> then) {
    // 两个请求先后发(同 React 版的 await 次序),都回来了才一次写进快照
    auto part = std::make_shared<QJsonObject>();
    const auto finish = [this, part, refreshPositions, then] {
        if (refreshPositions) positionsSig_.clear();  // 这里换过持仓了,下一轮 refreshPositions 不能拿旧签名判"没变"
        if (part->contains(u"tracks"_s)) tracks_ = part->value(u"tracks"_s).toArray();
        if (part->contains(u"tracksError"_s)) tracksError_ = part->value(u"tracksError"_s);
        if (part->contains(u"positions"_s)) positions_ = part->value(u"positions"_s).toArray();
        if (part->contains(u"positionsError"_s)) positionsError_ = part->value(u"positionsError"_s);
        emit changed();
        if (then) then();
    };
    bridge_->rpc(this, u"tracker.list"_s, QJsonObject{}, [this, part, refreshPositions, finish](const EngineReply& r) {
        if (r.ok) {
            part->insert(u"tracks"_s, r.result[u"tracks"].isArray() ? r.result[u"tracks"] : QJsonValue(QJsonArray()));
            part->insert(u"tracksError"_s, QJsonValue::Null);
        } else {
            // 读不到 ≠ 没有:页面若显示"还没有在追踪任何持仓",每秒的盯盘读取也跟着停——而引擎里那几条追踪其实还在盯、还会发平仓单
            part->insert(u"tracksError"_s, r.error);
        }
        if (!refreshPositions) return finish();
        // 没连券商时读不到持仓,引擎会直接拒绝:不发这个请求,页面按"连接后才能读到"显示
        if (!status_ || !status_->status().value("broker_connected"_L1).toBool()) {
            part->insert(u"positions"_s, QJsonArray());
            part->insert(u"positionsError"_s, QJsonValue::Null);
            return finish();
        }
        bridge_->rpc(this, u"positions.list"_s, QJsonObject{}, [part, finish](const EngineReply& p) {
            part->insert(u"positions"_s, p.ok && p.result[u"positions"].isArray() ? p.result[u"positions"] : QJsonValue(QJsonArray()));
            part->insert(u"positionsError"_s, p.ok ? QJsonValue(QJsonValue::Null) : QJsonValue(p.error));
            finish();
        });
    });
}

void TrackerStore::refreshPositions() {
    if (positionsBusy_ || !status_ || !status_->status().value("broker_connected"_L1).toBool()) return;
    positionsBusy_ = true;
    bridge_->rpc(this, u"positions.list"_s, QJsonObject{}, [this](const EngineReply& r) {
        positionsBusy_ = false;
        if (r.ok) {
            const QJsonArray positions = r.result[u"positions"].toArray();
            positionsFails_ = 0;
            // 行情不动的那些轮次不发通知,免得整页每秒重画一遍
            const QByteArray s = sig(positions);
            if (s != positionsSig_ || !positionsError_.isNull()) {
                positionsSig_ = s;
                positions_ = positions;
                positionsError_ = QJsonValue::Null;
                emit changed();
            }
            return;
        }
        // 单轮读不到先留着上一份;连着 3 轮都读不到才报,免得拿旧数冒充实时
        positionsFails_ += 1;
        if (positionsFails_ >= kPositionsFailLimit) {
            positionsSig_.clear();
            positions_ = {};
            positionsError_ = r.error;
            emit changed();
        }
    });
}

void TrackerStore::onFired(const QJsonArray& fired) {
    if (fired.isEmpty()) return;
    for (const QJsonValue& f : fired)
        if (alerter_) alerter_->pushFeed(u"自动平仓:"_s + jsString(f[u"symbol"]), jsString(f[u"reason"]));
    load(true);
    emit recordsStale();
}

void TrackerStore::poll() {
    if (pollBusy_ || !status_ || !status_->status().value("broker_connected"_L1).toBool() || tracks_.isEmpty()) return;
    pollBusy_ = true;
    bridge_->rpc(this, u"tracker.poll"_s, QJsonObject{}, [this](const EngineReply& r) {
        pollBusy_ = false;
        if (!r.ok) {
            // 单轮失败不打断界面;连着几轮都读不到,就得说出来——页面上那行"盯盘:引擎每 1 秒一轮"是上一份心跳,
            // 引擎要是已经不回话了,它还显示着一切正常
            pollFails_ += 1;
            if (pollFails_ >= kPollFailLimit && pollError_.isNull()) {
                rowsSig_.clear();
                loop_ = QJsonValue::Null;
                pollError_ = r.error;
                emit changed();
            }
            return;
        }
        pollFails_ = 0;
        bool dirty = false;
        if (!pollError_.isNull()) {
            pollError_ = QJsonValue::Null;
            dirty = true;
        }
        const QJsonArray list = r.result[u"rows"].toArray();
        QJsonObject rows;
        for (const QJsonValue& row : list) rows.insert(jsString(row[u"id"]), row);
        const QJsonValue loopValue = r.result[u"loop"];
        const QJsonValue loop = loopValue.isUndefined() ? QJsonValue(QJsonValue::Null) : loopValue;
        // 节拍器没在跑时(兜底路径)返回值里仍会带触发
        const QJsonArray fired = r.result[u"fired"].toArray();
        if (!fired.isEmpty()) {
            rows_ = rows;
            loop_ = loop;
            emit changed();
            return onFired(fired);
        }
        // 盘口不动的那些轮次不发通知
        QJsonArray parts;
        for (const QJsonValue& row : list) {
            parts.append(QJsonArray{row[u"id"], row[u"state"], row[u"price"], row[u"unrealized_pnl"], row[u"profit_peak"], row[u"profit_drawdown_threshold"],
                                    row[u"profit_trail_stop"], row[u"stop_effective"], row[u"blocked"], row[u"spot_target"][u"price"], row[u"spot_target"][u"pnl"],
                                    row[u"spot_target"][u"sigma_source"], row[u"sweeping"], row[u"chase"][u"rounds"], row[u"chase"][u"limit"]});
        }
        const QByteArray s = sig(parts);
        if (s != rowsSig_) {
            rowsSig_ = s;
            rows_ = rows;
            loop_ = loop;
            dirty = true;
        } else if (loop.isObject() && (loop[u"ticks"] != loop_[u"ticks"] || loop[u"last_error"] != loop_[u"last_error"])) {
            loop_ = loop;  // 心跳每轮都变;行没变时只刷心跳
            dirty = true;
        }
        if (dirty) emit changed();
    });
}

void TrackerStore::reconcile() {
    if (reconcileBusy_ || !status_ || !status_->status().value("broker_connected"_L1).toBool()) return;
    bool hostedAny = false;
    for (const QJsonValue& t : tracks_) hostedAny = hostedAny || jsTruthy(t[u"auto_close"][u"host_at_broker"]);
    if (!hostedAny) return;
    reconcileBusy_ = true;
    bridge_->rpc(this, u"tracker.reconcile"_s, QJsonObject{}, [this](const EngineReply& r) {
        reconcileBusy_ = false;
        if (!r.ok) return;  // 单轮失败不打扰;托管单仍在券商侧站岗,下一秒再对
        QJsonObject hosted;
        for (const QJsonValue& h : r.result[u"hosted"].toArray())
            hosted.insert(jsString(h[u"id"]), QJsonObject{{u"orders"_s, h[u"orders"].isArray() ? h[u"orders"] : QJsonValue(QJsonArray())}});
        const bool delayed = jsTruthy(r.result[u"quote_maybe_delayed"]);
        const QJsonValue blocked = r.result[u"blocked"].isArray() ? r.result[u"blocked"] : QJsonValue(QJsonArray());
        const QByteArray s = sig(QJsonArray{hosted, delayed, blocked});
        if (s == hostedSig_) return;
        hostedSig_ = s;
        hosted_ = hosted;
        delayed_ = delayed;
        emit changed();
    });
}

void TrackerStore::onEngineEvent(const QString& event, const QJsonValue& data) {
    if (event != u"tracker") return;
    onFired(data[u"fired"].toArray());
}

}  // namespace ibkr::shell
