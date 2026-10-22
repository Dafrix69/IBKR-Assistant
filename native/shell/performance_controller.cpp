#include "shell/performance_controller.h"

#include "shell/bridge.h"
#include "shell/chart_source.h"
#include "shell/chart_spec.h"
#include "shell/jsvalue.h"
#include "shell/status_store.h"

#include <QCoreApplication>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QPointer>
#include <QStandardPaths>
#include <QSettings>

#include <cmath>

namespace ibkr::shell {

using namespace Qt::StringLiterals;

namespace {

/// PositionSizer 的 readNum:Number(记下的) 是正的有限数才算,不然给兜底
QJsonValue positive(const QVariant& v, const QJsonValue& fallback) {
    if (!v.isValid() || v.isNull()) return fallback;
    const double x = jsNumber(QJsonValue(v.toString()));
    return std::isfinite(x) && x > 0 ? QJsonValue(x) : fallback;
}

/// InputNumber 的 onChange:null 是清空了,别的是数
QJsonValue fromInput(const QVariant& v) {
    if (!v.isValid() || v.isNull()) return QJsonValue::Null;
    bool ok = false;
    const double x = v.toDouble(&ok);
    return ok && std::isfinite(x) ? QJsonValue(x) : QJsonValue(QJsonValue::Null);
}

}  // namespace

PerformanceController::PerformanceController(Bridge* bridge, StatusStore* status, QString settingsPath, QObject* parent)
    : QObject(parent), bridge_(bridge), status_(status), equityChart_(new ChartSource(this)), settingsPath_(std::move(settingsPath)) {
    now = [] { return double(QDateTime::currentMSecsSinceEpoch()); };
    reset();
}

QObject* PerformanceController::equityChart() const { return equityChart_; }

QString PerformanceController::cardSubtitle() const { return performance::cardSubtitle(in_.data, in_.scope, in_.kind, in_.days); }
QString PerformanceController::cardFootnote() const { return performance::cardFootnote(in_.data); }

QString PerformanceController::read(const QString& key) const { return QSettings(settingsPath_, QSettings::IniFormat).value(key).toString(); }
void PerformanceController::write(const QString& key, const QVariant& value) const {
    QSettings s(settingsPath_, QSettings::IniFormat);
    if (value.isNull()) s.remove(key);
    else s.setValue(key, value);
}

void PerformanceController::reset() {
    in_ = performance::PageInput{};
    const QString scope = read(u"perf/scope"_s), kind = read(u"perf/kind"_s);
    in_.scope = scope == u"live" || scope == u"paper" ? scope : u"all"_s;
    in_.kind = kind == u"butterfly" || kind == u"stock" || kind == u"option" ? kind : u"all"_s;
    const double days = jsNumber(QJsonValue(read(u"perf/days"_s)));  // Number(read(...)) || 0
    in_.days = std::isfinite(days) ? int(days) : 0;
    QSettings s(settingsPath_, QSettings::IniFormat);
    in_.sizerEquity = positive(s.value(u"sizer/equity"_s), QJsonValue(QJsonValue::Null));
    in_.sizerPct = positive(s.value(u"sizer/pct"_s), 1);
    in_.data = QJsonValue::Null;
    in_.sizerUnit = QJsonValue::Null;
    in_.signalData = QJsonValue::Null;
    equityChart_->setSpec({});
    rebuild();
}

void PerformanceController::setVisible(bool on) {
    if (on == visible_) return;
    visible_ = on;
    ++generation_;
    reset();
    if (on) load();
}

void PerformanceController::load() {
    in_.loading = true;
    in_.error.clear();
    rebuild();
    QJsonObject spec{{u"scope"_s, in_.scope}, {u"kind"_s, in_.kind}};
    if (in_.days) spec[u"days"_s] = in_.days;
    const int gen = generation_;
    QPointer<PerformanceController> self(this);
    bridge_->rpc(this, u"review.performance"_s, spec, [self, gen](const EngineReply& r) {
        if (!self || gen != self->generation_) return;
        auto& in = self->in_;
        if (r.ok) {
            // 仓位计算器只在有已了结交易时挂着,key 是 typicalUnitRisk:新挂上或中位数一变,每份最大亏损回到它(权益与比例照读本机的)
            const auto mounted = [](const QJsonValue& d) { return jsTruthy(d) && jsTruthy(d[u"stats"_s][u"trades"_s]); };
            const bool wasMounted = mounted(in.data);
            const QJsonValue before = performance::typicalUnitRisk(in.data);
            in.data = r.result;
            const QJsonValue typical = performance::typicalUnitRisk(in.data);
            if (mounted(in.data) && (!wasMounted || typical != before)) {
                in.sizerUnit = typical;
                QSettings s(self->settingsPath_, QSettings::IniFormat);
                in.sizerEquity = positive(s.value(u"sizer/equity"_s), QJsonValue(QJsonValue::Null));
                in.sizerPct = positive(s.value(u"sizer/pct"_s), 1);
            }
            const QJsonValue chart = performance::equityChart(in.data);
            self->equityChart_->setSpec(chart.isObject() ? chart::specFromJson(chart.toObject()) : chart::Spec{});
        } else {
            in.error = r.error;
        }
        in.loading = false;
        self->rebuild();
    });
}

void PerformanceController::setScope(const QString& scope) {
    if (scope == in_.scope) return;  // Segmented 点已选中的那一项不触发 onChange
    in_.scope = scope;
    write(u"perf/scope"_s, scope);
    if (visible_) load();
    else rebuild();
}

void PerformanceController::setKind(const QString& kind) {
    if (kind == in_.kind) return;
    in_.kind = kind;
    write(u"perf/kind"_s, kind);
    if (visible_) load();
    else rebuild();
}

void PerformanceController::setDays(int days) {
    if (days == in_.days) return;
    in_.days = days;
    write(u"perf/days"_s, QString::number(days));
    if (visible_) load();
    else rebuild();
}

void PerformanceController::reload() {
    if (visible_) load();
}

void PerformanceController::applyAdvice(const QString& rule) {
    QJsonValue advice;
    for (const QJsonValue& a : in_.data[u"protection_advice"_s].toArray())
        if (jsString(a[u"rule"_s]) == rule) advice = a;
    if (!advice.isObject()) return;
    const QString label = performance::ruleLabel(rule), text = performance::adviceText(advice);
    const QJsonObject box{{u"title"_s, u"打开"_s + label}, {u"message"_s, text}, {u"detail"_s, u"只挡新单,永远不挡平仓。之后可以在「设置 → 保护规则」里改或关掉。"_s},
                          {u"confirmLabel"_s, u"按建议填入"_s}};
    const int gen = generation_;
    QPointer<PerformanceController> self(this);
    bridge_->confirm(this, box, [self, gen, rule, advice, label, text](bool ok, const QString&) {
        if (!ok || !self || gen != self->generation_) return;
        self->in_.adviceBusy = rule;
        self->rebuild();
        self->bridge_->rpc(self, u"settings.patch"_s, QJsonObject{{u"patch"_s, performance::advicePatch(advice)}, {u"__confirmed"_s, true}},
                           [self, gen, label, text](const EngineReply& r) {
                               if (!self) return;
                               if (r.ok) {
                                   if (self->status_) self->status_->showInfo(u"%1已打开:%2"_s.arg(label, text));
                                   const auto after = [self, gen] {
                                       if (!self || gen != self->generation_) return;
                                       self->in_.adviceBusy.clear();
                                       self->load();
                                   };
                                   if (self->status_) self->status_->refresh(after);
                                   else after();
                               } else {
                                   if (self->status_) self->status_->showError(u"没填进去(设置未改动):"_s + r.error);
                                   if (gen != self->generation_) return;
                                   self->in_.adviceBusy.clear();
                                   self->rebuild();
                               }
                           });
    });
}

void PerformanceController::scoreSignals() {
    in_.signalsLoading = true;
    in_.signalsError.clear();
    rebuild();
    const QJsonObject spec = in_.days ? QJsonObject{{u"days"_s, in_.days}} : QJsonObject{};
    const int gen = generation_;
    QPointer<PerformanceController> self(this);
    bridge_->rpc(this, u"review.signals"_s, spec, [self, gen](const EngineReply& r) {
        if (!self || gen != self->generation_) return;
        if (r.ok) self->in_.signalData = r.result;
        else self->in_.signalsError = r.error;
        self->in_.signalsLoading = false;
        self->rebuild();
    });
}

void PerformanceController::setSizerEquity(const QVariant& v) {
    in_.sizerEquity = fromInput(v);
    write(u"sizer/equity"_s, in_.sizerEquity.isNull() ? QVariant() : QVariant(jsString(in_.sizerEquity)));
    rebuild();
}

void PerformanceController::setSizerPct(const QVariant& v) {
    in_.sizerPct = fromInput(v);
    write(u"sizer/pct"_s, in_.sizerPct.isNull() ? QVariant() : QVariant(jsString(in_.sizerPct)));
    rebuild();
}

void PerformanceController::setSizerUnit(const QVariant& v) {
    in_.sizerUnit = fromInput(v);
    rebuild();
}

void PerformanceController::setLedgerPage(int page) {
    in_.ledgerPage = page;
    rebuild();
}

void PerformanceController::setExecPage(int page) {
    in_.execPage = page;
    rebuild();
}

QJsonObject PerformanceController::exportImage(const QString& action, const QString& dataUrl, const QString& name) {
    const QString verb = action == u"copy" ? u"拷贝"_s : u"保存"_s;
    const auto fail = [&](const QString& error) {
        if (status_) status_->showError(u"%1失败:%2"_s.arg(verb, error));
        return QJsonObject{{u"ok"_s, false}, {u"error"_s, error}};
    };
    const QString prefix = u"data:image/png;base64,"_s;
    if (!dataUrl.startsWith(prefix) || dataUrl.size() > 12 * 1024 * 1024) return fail(u"图片不合法"_s);
    return exportPng(action, QByteArray::fromBase64(QStringView(dataUrl).mid(prefix.size()).toLatin1(), QByteArray::AbortOnBase64DecodingErrors), name);
}

QString PerformanceController::cardImagePath() const {
    return QDir(QStandardPaths::writableLocation(QStandardPaths::TempLocation)).filePath(u"ibkr-share-card-%1.png"_s.arg(QCoreApplication::applicationPid()));
}

QJsonObject PerformanceController::exportCard(const QString& action, const QString& name) {
    QFile f(cardImagePath());
    QByteArray png;
    if (f.open(QIODevice::ReadOnly) && f.size() <= 12 * 1024 * 1024) png = f.readAll();
    f.close();
    f.remove();
    return exportPng(action, png, name);
}

QJsonObject PerformanceController::exportPng(const QString& action, const QByteArray& png, const QString& name) {
    const QString verb = action == u"copy" ? u"拷贝"_s : u"保存"_s;
    const auto fail = [&](const QString& error) {
        if (status_) status_->showError(u"%1失败:%2"_s.arg(verb, error));
        return QJsonObject{{u"ok"_s, false}, {u"error"_s, error}};
    };
    // 弹保存框之前先认出是 PNG(main.js 先 createFromDataURL、isEmpty 就拒)
    if (!png.startsWith(QByteArray("\x89PNG\r\n\x1a\n", 8)) || !imageWriter) return fail(u"图片不合法"_s);
    if (action == u"copy") {
        if (const QString error = imageWriter(png, QString()); !error.isEmpty()) return fail(error);
        if (status_) status_->showInfo(u"已拷贝到剪贴板,可以直接粘贴"_s);
        return {{u"ok"_s, true}};
    }
    if (action == u"save") {
        const QString dir = downloadsDir ? downloadsDir() : QString();
        const QString start = (dir.isEmpty() ? QString() : dir + u'/') + performance::safeImageName(name) + u".png"_s;
        const QString path = pickSavePath ? pickSavePath(u"保存分享卡片"_s, start, u"PNG 图片 (*.png)"_s) : QString();
        if (path.isEmpty()) return {{u"ok"_s, false}, {u"canceled"_s, true}};
        if (const QString error = imageWriter(png, path); !error.isEmpty()) return fail(error);
        if (status_) status_->showInfo(u"已保存:"_s + path);
        return {{u"ok"_s, true}, {u"path"_s, path}};
    }
    return fail(u"未知操作"_s);
}

void PerformanceController::rebuild() {
    in_.nowMs = now();
    in_.zone = zone;
    page_ = performance::pageModel(in_);
    emit pageChanged();
}

}  // namespace ibkr::shell
