#include "shell/review_controller.h"

#include "shell/bridge.h"
#include "shell/chart_source.h"
#include "shell/jsvalue.h"
#include "shell/status_store.h"

#include <QDateTime>
#include <QPointer>
#include <QSettings>

namespace ibkr::shell {

using namespace Qt::StringLiterals;

namespace {

QString kindLabel(const QJsonValue& kind) {
    static const QHash<QString, QString> m{{u"closed"_s, u"已平仓"_s}, {u"expired"_s, u"已到期"_s}, {u"open"_s, u"持仓中"_s}};
    return m.value(jsString(kind));
}

}  // namespace

ReviewController::ReviewController(Bridge* bridge, StatusStore* status, QString settingsPath, QObject* parent)
    : QObject(parent), bridge_(bridge), status_(status), stockChart_(new ChartSource(this)), underlyingChart_(new ChartSource(this)), flyChart_(new ChartSource(this)),
      settingsPath_(std::move(settingsPath)) {
    now = [] { return double(QDateTime::currentMSecsSinceEpoch()); };
    reset();
}

QObject* ReviewController::stockChart() const { return stockChart_; }
QObject* ReviewController::underlyingChart() const { return underlyingChart_; }
QObject* ReviewController::flyChart() const { return flyChart_; }

QString ReviewController::read(const QString& key) const { return QSettings(settingsPath_, QSettings::IniFormat).value(key).toString(); }
void ReviewController::write(const QString& key, const QString& value) const {
    QSettings s(settingsPath_, QSettings::IniFormat);
    s.setValue(key, value);
}

void ReviewController::reset() {
    in_ = review::PageInput{};
    in_.selected = read(u"review/record"_s);
    const QString tf = read(u"review/timeframe"_s);
    in_.timeframe = tf.isEmpty() ? u"auto"_s : tf;
    // Number(read(...)) || null:空、0、认不出都是自动
    const double em = jsNumber(QJsonValue(read(u"review/em-manual"_s)));
    in_.em = em == em && em != 0 ? QJsonValue(em) : QJsonValue(QJsonValue::Null);
    const QString kind = read(u"review/kind"_s);
    in_.kind = kind.isEmpty() ? u"all"_s : kind;
    in_.available = QJsonValue::Null;
    stockChart_->setSpec({});
    underlyingChart_->setSpec({});
    flyChart_->setSpec({});
    rebuild();
}

void ReviewController::setVisible(bool on) {
    if (on == visible_) return;
    visible_ = on;
    ++generation_;
    reset();
    if (!on) return;
    loadCandidates(in_.includeLocal, QString());
    if (!pendingRequest_.isEmpty()) handleRequest();
}

void ReviewController::loadCandidates(bool local, const QString& keep, std::function<void(const QJsonArray&)> done) {
    const int gen = generation_;
    QPointer<ReviewController> self(this);
    bridge_->rpc(this, u"review.candidates"_s, QJsonObject{{u"limit"_s, 200}, {u"include_local"_s, local}}, [self, gen, keep, done](const EngineReply& r) {
        if (!self || gen != self->generation_) return;
        if (!r.ok) {
            if (self->status_) self->status_->showError(u"读取成交明细失败:"_s + r.error);
            if (done) done({});
            return;
        }
        const QJsonValue res = r.result;
        const QJsonArray list = res[u"candidates"_s].toArray();
        self->in_.candidates = list;
        self->in_.available = jsTruthy(res[u"ibkr_available"_s]);
        QStringList bits;
        if (jsTruthy(res[u"ibkr_available"_s]))
            bits << (res[u"synced"_s].isNull() || res[u"synced"_s].isUndefined() ? u"已连 TWS"_s : u"本次新增 %1 笔成交"_s.arg(jsString(res[u"synced"_s])));
        else bits << u"未连 TWS,只看本地累积的成交"_s;
        bits << u"库内成交 %1 笔"_s.arg(res[u"fills_stored"_s].isNull() || res[u"fills_stored"_s].isUndefined() ? u"0"_s : jsString(res[u"fills_stored"_s]));
        const QString f = self->in_.freshness;
        if (f == u"—" || f.startsWith(u"已连"_s) || f.startsWith(u"未连"_s) || f.startsWith(u"本次"_s)) self->in_.freshness = bits.join(u" · "_s);
        const QString want = keep.isNull() ? self->in_.selected : keep;
        bool found = false;
        for (const QJsonValue& c : list) found = found || jsString(c[u"id"_s]) == want;
        self->in_.selected = found ? want : list.isEmpty() ? QString() : jsString(list.first()[u"id"_s]);
        self->fallBackIfFiltered();
        self->rebuild();
        if (done) done(list);
    });
}

// 换了筛选之后选中的那笔不在列表里了:退到列表第一笔,别让下拉框显示一个看不见的 id
void ReviewController::fallBackIfFiltered() {
    const QJsonArray shown = review::shownCandidates(in_.candidates, in_.kind);
    if (shown.isEmpty()) return;
    for (const QJsonValue& c : shown)
        if (jsString(c[u"id"_s]) == in_.selected) return;
    in_.selected = jsString(shown.first()[u"id"_s]);
}

void ReviewController::setKind(const QString& kind) {
    in_.kind = kind;
    write(u"review/kind"_s, kind);
    fallBackIfFiltered();
    rebuild();
}

void ReviewController::select(const QString& id) {
    in_.selected = id;
    write(u"review/record"_s, id);
    rebuild();
}

void ReviewController::setTimeframe(const QString& tf) {
    in_.timeframe = tf;
    rebuild();
}

void ReviewController::setEm(const QVariant& em) {
    bool ok = false;
    const double v = em.isValid() && !em.isNull() ? em.toDouble(&ok) : 0;
    in_.em = ok ? QJsonValue(v) : QJsonValue(QJsonValue::Null);
    rebuild();
}

void ReviewController::setIncludeLocal(bool on) {
    if (on == in_.includeLocal) return;
    in_.includeLocal = on;
    rebuild();
    // 原版的 effect 依赖是 includeLocal:一变就重读
    if (visible_) loadCandidates(on, QString());
}

void ReviewController::sync() { loadCandidates(in_.includeLocal, QString()); }

void ReviewController::analyze() {
    if (in_.loading) return;
    run(in_.selected);
}

void ReviewController::run(const QString& id) {
    if (id.isEmpty()) {
        if (status_) status_->showInfo(u"先选一笔交易"_s);
        return;
    }
    write(u"review/record"_s, id);
    write(u"review/timeframe"_s, in_.timeframe);
    write(u"review/em-manual"_s, jsTruthy(in_.em) ? jsString(in_.em) : QString());
    in_.loading = true;
    rebuild();
    const int gen = generation_;
    QPointer<ReviewController> self(this);
    const QJsonObject exit = jsTruthy(in_.em) ? QJsonObject{{u"em"_s, in_.em}} : QJsonObject{};
    bridge_->rpc(this, u"review.analyze"_s, QJsonObject{{u"id"_s, id}, {u"timeframe"_s, in_.timeframe}, {u"exit"_s, exit}}, [self, gen](const EngineReply& r) {
        if (!self || gen != self->generation_) return;
        if (r.ok) {
            self->in_.data = r.result;
            self->in_.error.clear();
            self->in_.freshness = u"%1 · %2 根 · %3"_s.arg(jsString(r.result[u"timeframe_label"_s]), QString::number(r.result[u"series"_s][u"bars"_s].toArray().size()),
                                                         kindLabel(r.result[u"outcome"_s][u"kind"_s]));
        } else {
            self->in_.data = QJsonValue::Null;
            self->in_.error = r.error;
        }
        self->in_.loading = false;
        const QJsonValue d = self->in_.data;
        const bool stock = jsString(d[u"kind"_s]) == u"stock";
        const QJsonValue s = stock ? review::stockChart(d) : QJsonValue();
        const QJsonValue u = !stock && jsTruthy(d) ? review::underlyingChart(d) : QJsonValue();
        const QJsonValue f = !stock && jsTruthy(d) && jsTruthy(d[u"exit_plan"_s]) ? review::flyChart(d) : QJsonValue();
        self->stockChart_->setSpec(s.isObject() ? chart::specFromJson(s.toObject()) : chart::Spec{});
        self->underlyingChart_->setSpec(u.isObject() ? chart::specFromJson(u.toObject()) : chart::Spec{});
        self->flyChart_->setSpec(f.isObject() ? chart::specFromJson(f.toObject()) : chart::Spec{});
        self->rebuild();
    });
}

void ReviewController::request(const QString& recordId) {
    if (recordId.isEmpty()) return;
    write(u"review/record"_s, recordId);
    pendingRequest_ = recordId;
    if (visible_) handleRequest();
}

// 它可能是本地校验过、没在券商成交的那种——默认的候选列表里没有它,得把「附带本地未成交的记录」打开,
// 否则下拉框会退回到第一条 IBKR 成交,而下面的图和结论却是点进来的那一张,两者对不上
void ReviewController::handleRequest() {
    const QString id = pendingRequest_;
    pendingRequest_.clear();
    in_.selected = id;
    rebuild();
    const int gen = generation_;
    QPointer<ReviewController> self(this);
    loadCandidates(in_.includeLocal, id, [self, gen, id](const QJsonArray& list) {
        if (!self || gen != self->generation_) return;
        bool found = false;
        for (const QJsonValue& c : list) found = found || jsString(c[u"id"_s]) == id;
        if (!self->in_.includeLocal && !found) {
            self->setIncludeLocal(true);  // 原版 setIncludeLocal(true):effect 照样再读一遍
            self->loadCandidates(true, id, [self, gen, id](const QJsonArray&) {
                if (self && gen == self->generation_) self->run(id);
            });
            return;
        }
        self->run(id);
    });
}

void ReviewController::rebuild() {
    in_.nowMs = now();
    in_.zone = zone;
    page_ = review::pageModel(in_);
    emit pageChanged();
}

}  // namespace ibkr::shell
