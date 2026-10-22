#include "shell/screener_controller.h"

#include "shell/bridge.h"
#include "shell/chart_source.h"
#include "shell/jsvalue.h"
#include "shell/keyed_list_model.h"
#include "shell/order_rules.h"
#include "shell/screener_rules.h"
#include "shell/sectors_store.h"
#include "shell/status_store.h"

#include <QDateTime>
#include <QPointer>
#include <QSettings>

namespace ibkr::shell {

using namespace Qt::StringLiterals;

ScreenerController::ScreenerController(Bridge* bridge, SectorsStore* sectors, StatusStore* status, QString settingsPath, QObject* parent)
    : QObject(parent), bridge_(bridge), sectors_(sectors), status_(status), devChart_(new ChartSource(this)), pressureChart_(new ChartSource(this)),
      rows_(new KeyedListModel(u"symbol"_s, this)), leaderRows_(new KeyedListModel(u"symbol"_s, this)),
      settingsPath_(std::move(settingsPath)) {
    now = [] { return double(QDateTime::currentMSecsSinceEpoch()); };
    connect(sectors_, &SectorsStore::changed, this, &ScreenerController::rebuild);
    reset();
}

QObject* ScreenerController::devChart() const { return devChart_; }
QObject* ScreenerController::pressureChart() const { return pressureChart_; }
QObject* ScreenerController::rows() const { return rows_; }
QObject* ScreenerController::leaderRows() const { return leaderRows_; }

void ScreenerController::drill(const QString& symbol) {
    review(symbol);
    emit revealDeviation();
}

void ScreenerController::error(const QString& text) {
    if (status_) status_->showError(text);
}

void ScreenerController::reset() {
    sector_ = QSettings(settingsPath_, QSettings::IniFormat).value(u"screener/sector"_s).toString();
    if (sector_.isEmpty()) sector_ = u"all"_s;
    sortKey_.clear();
    sortOrder_.clear();
    benchmark_ = u"SPY"_s;
    timeframes_ = {u"1w"_s, u"1d"_s};
    ma_ = 20;
    busy_ = false;
    progress_.clear();
    rs_ = infl_ = QJsonValue::Null;
    devSymbol_.clear();
    devFree_.clear();
    devTf_ = u"1d"_s;
    devPeriod_ = 20;
    devLookback_ = 120;
    devBusy_ = false;
    devResult_ = QJsonValue::Null;
    devStatus_.clear();
    devSeq_ = 0;
    leaders_ = QJsonValue::Null;
    leadersBusy_ = false;
    leadersError_.clear();
    leadersFilter_ = u"all"_s;
    devChart_->setSpec({});
    pressureChart_->setSpec({});
    rebuild();
}

void ScreenerController::setVisible(bool on) {
    if (on == visible_) return;
    visible_ = on;
    ++generation_;
    reset();
    // 进页时重读板块(板块页刚加的股要立刻可选)
    if (on) sectors_->load();
}

void ScreenerController::setSector(const QString& id) {
    sector_ = id;
    QSettings(settingsPath_, QSettings::IniFormat).setValue(u"screener/sector"_s, id);
    rebuild();
}

void ScreenerController::setBenchmark(const QString& b) {
    benchmark_ = b == u"QQQ" ? u"QQQ"_s : u"SPY"_s;
    rebuild();
}

void ScreenerController::toggleTimeframe(const QString& tf, bool on) {
    if (on && !timeframes_.contains(tf)) timeframes_ << tf;
    if (!on) timeframes_.removeAll(tf);
    rebuild();
}

void ScreenerController::setMa(const QVariant& v) {
    ma_ = v.isValid() && !v.isNull() ? QJsonValue(v.toDouble()) : QJsonValue(QJsonValue::Null);
    rebuild();
}

void ScreenerController::sortBy(const QString& key) {
    if (sortKey_ != key || sortOrder_.isEmpty()) {
        sortKey_ = key;
        sortOrder_ = u"descend"_s;
    } else if (sortOrder_ == u"descend") {
        sortOrder_ = u"ascend"_s;
    } else {
        sortKey_.clear();
        sortOrder_.clear();
    }
    rebuild();
}

void ScreenerController::run() {
    if (busy_) return;
    const QString sector = page_.value("sector"_L1).toString();
    QStringList tfs;
    for (const auto& [k, v] : screener::timeframeOptions())
        if (timeframes_.contains(k)) tfs << k;
    // 背离结果没回来之前,表里先把这几列占住(格子里是「…」),免得 RS 出来后表再跳一次宽度
    const QJsonValue pending = tfs.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(QJsonObject{{u"pending"_s, true}, {u"timeframes"_s, QJsonArray::fromStringList(tfs)}});
    busy_ = true;
    progress_ = u"正在拉日线算 RS…(一个 30 只的板块约 10~30 秒)"_s;
    rebuild();
    const int gen = generation_;
    const QJsonValue ma = jsTruthy(ma_) ? ma_ : QJsonValue(QJsonValue::Null);
    QPointer<ScreenerController> self(this);
    bridge_->rpc(this, u"screener.rs"_s, QJsonObject{{u"sector"_s, sector}, {u"benchmark"_s, benchmark_}},
                 [self, gen, sector, tfs, pending, ma](const EngineReply& r) {
                     if (!self || gen != self->generation_) return;
                     QString first, rsError;
                     if (r.ok) {
                         self->rs_ = r.result;
                         first = jsString(r.result[u"rows"_s][0][u"symbol"_s]);
                         if (first == u"undefined") first.clear();
                     } else {
                         self->rs_ = QJsonValue::Null;
                         rsError = r.error;
                     }
                     self->infl_ = pending;
                     if (!first.isEmpty()) self->reviewIfUntouched(first);
                     if (tfs.isEmpty()) {
                         if (!rsError.isEmpty()) self->error(u"扫描失败:"_s + rsError);
                         self->progress_.clear();
                         self->busy_ = false;
                         self->rebuild();
                         return;
                     }
                     bool intraday = false;
                     for (const QString& tf : tfs) intraday = intraday || (tf != u"1d" && tf != u"1w");
                     self->progress_ = intraday ? u"正在逐只拉 K 线找背离…日内周期受券商节流,可能要一两分钟"_s : u"正在找背离…"_s;
                     self->rebuild();
                     self->bridge_->rpc(self, u"screener.inflection"_s,
                                        QJsonObject{{u"sector"_s, sector}, {u"timeframes"_s, QJsonArray::fromStringList(tfs)}, {u"ma_period"_s, ma}},
                                        [self, gen, first, rsError](const EngineReply& r2) {
                                            if (!self || gen != self->generation_) return;
                                            if (r2.ok) {
                                                self->infl_ = r2.result;
                                                const QJsonValue s = r2.result[u"rows"_s][0][u"symbol"_s];
                                                if (first.isEmpty() && jsTruthy(s)) self->reviewIfUntouched(jsString(s));
                                                if (!rsError.isEmpty()) self->error(u"RS 强度没算出来:"_s + rsError);
                                            } else {
                                                self->infl_ = QJsonValue::Null;
                                                // 池子是空的、没连券商:两步是同一个原因,说一遍就够
                                                if (!rsError.isEmpty() && rsError != r2.error) self->error(u"RS 强度没算出来:"_s + rsError);
                                                self->error(!rsError.isEmpty() ? u"扫描失败:"_s + r2.error : u"背离没找成:"_s + r2.error);
                                            }
                                            self->progress_.clear();
                                            self->busy_ = false;
                                            self->rebuild();
                                        });
                 });
}

void ScreenerController::reviewIfUntouched(const QString& symbol) {
    if (devSeq_ == 0) review(symbol);
}

void ScreenerController::review(const QString& target) {
    const QString chosen = jsTrim(target).toUpper();
    if (chosen.isEmpty()) {
        if (status_) status_->showInfo(u"先选或手输一个标的"_s);
        return;
    }
    const int mine = ++devSeq_;
    if (chosen != jsTrim(devFree_).toUpper()) devFree_.clear();
    devSymbol_ = chosen;
    devBusy_ = true;
    devStatus_ = u"正在拉 %1 的 K 线…"_s.arg(chosen);
    rebuild();
    const int gen = generation_;
    QPointer<ScreenerController> self(this);
    const QJsonObject params{{u"symbol"_s, chosen}, {u"timeframe"_s, devTf_}, {u"period"_s, jsTruthy(devPeriod_) ? devPeriod_ : QJsonValue(20)},
                             {u"lookback"_s, jsTruthy(devLookback_) ? devLookback_ : QJsonValue(120)}};
    bridge_->rpc(this, u"screener.deviation"_s, params, [self, gen, mine](const EngineReply& r) {
        // 连着点几行时只认最后一次:前面的回包到了也不落地
        if (!self || gen != self->generation_ || mine != self->devSeq_) return;
        self->devBusy_ = false;
        if (r.ok) {
            self->devResult_ = r.result;
            QString tf;
            for (const auto& [k, v] : screener::timeframeOptions())
                if (k == r.result[u"timeframe"_s].toString()) tf = v;
            self->devStatus_ = u"%1 · %2 根 · %3"_s.arg(tf.isEmpty() ? jsString(r.result[u"timeframe"_s]) : tf, jsString(r.result[u"bars"_s]),
                                                        orders::fmtTimeShort(r.result[u"fetched_at"_s], self->now(), self->zone));
        } else {
            // 上一只的数字不能留在新选的这只名下
            self->devResult_ = QJsonValue::Null;
            self->devStatus_.clear();
            self->error(u"极值偏离失败:"_s + r.error);
        }
        const QJsonValue charts = screener::devCharts(self->devResult_);
        self->devChart_->setSpec(charts.isObject() ? chart::specFromJson(charts[u"dev"_s].toObject()) : chart::Spec{});
        self->pressureChart_->setSpec(charts.isObject() ? chart::specFromJson(charts[u"pressure"_s].toObject()) : chart::Spec{});
        self->rebuild();
    });
}

void ScreenerController::reviewCurrent() {
    const QString current = page_.value("dev"_L1)[u"current"_s].toString();
    review(!devFree_.isEmpty() ? devFree_ : current);
}

void ScreenerController::step(int delta) {
    const QJsonArray order = page_.value("order"_L1).toArray();
    if (order.isEmpty()) return;
    const QString current = page_.value("dev"_L1)[u"current"_s].toString();
    int idx = -1;
    for (int i = 0; i < order.size(); ++i)
        if (order[i].toString() == current) idx = i;
    const int i = idx < 0 ? 0 : (idx + delta + int(order.size())) % int(order.size());
    review(order[i].toString());
}

void ScreenerController::setFree(const QString& text) {
    devFree_ = text;
    rebuild();
}
void ScreenerController::setDevTimeframe(const QString& tf) {
    devTf_ = tf;
    rebuild();
}
void ScreenerController::setPeriod(const QVariant& v) {
    devPeriod_ = v.isValid() && !v.isNull() ? QJsonValue(v.toDouble()) : QJsonValue(QJsonValue::Null);
    rebuild();
}
void ScreenerController::setLookback(const QVariant& v) {
    devLookback_ = v.isValid() && !v.isNull() ? QJsonValue(v.toDouble()) : QJsonValue(QJsonValue::Null);
    rebuild();
}

void ScreenerController::runLeaders() {
    if (leadersBusy_) return;
    leadersBusy_ = true;
    leadersError_.clear();
    rebuild();
    const int gen = generation_;
    QPointer<ScreenerController> self(this);
    bridge_->rpc(this, u"screener.leaders"_s, QJsonObject{{u"sector"_s, page_.value("sector"_L1).toString()}, {u"benchmark"_s, benchmark_}}, [self, gen](const EngineReply& r) {
        if (!self || gen != self->generation_) return;
        if (r.ok) self->leaders_ = r.result;
        else self->leadersError_ = r.error;
        self->leadersBusy_ = false;
        self->rebuild();
    });
}

void ScreenerController::setLeadersFilter(const QString& f) {
    leadersFilter_ = f;
    rebuild();
}

void ScreenerController::rebuild() {
    screener::PageInput in;
    in.sectors = sectors_->sectors();
    in.sector = sector_;
    in.sortKey = sortKey_;
    in.sortOrder = sortOrder_;
    in.benchmark = benchmark_;
    in.timeframes = timeframes_;
    in.ma = ma_;
    in.busy = busy_;
    in.progress = progress_;
    in.rs = rs_;
    in.infl = infl_;
    in.dev.symbol = devSymbol_;
    in.dev.free = devFree_;
    in.dev.timeframe = devTf_;
    in.dev.period = devPeriod_;
    in.dev.lookback = devLookback_;
    in.dev.busy = devBusy_;
    in.dev.result = devResult_;
    in.dev.status = devStatus_;
    in.leaders = leaders_;
    in.leadersBusy = leadersBusy_;
    in.leadersError = leadersError_;
    in.leadersFilter = leadersFilter_;
    in.nowMs = now();
    in.zone = zone;
    page_ = screener::pageModel(in);
    rows_->setItems(page_.value("table"_L1).toObject().value("rows"_L1).toArray());
    leaderRows_->setItems(page_.value("leaders"_L1).toObject().value("data"_L1).toObject().value("rows"_L1).toArray());
    emit pageChanged();
}

}  // namespace ibkr::shell
