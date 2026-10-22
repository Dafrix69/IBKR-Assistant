#include "power_controller.h"

#include "platform.h"
#include "shell/alerter.h"
#include "shell/log_file.h"

#include <QDateTime>
#include <QDir>
#include <QGuiApplication>
#include <QMessageBox>
#include <QTimer>

using namespace Qt::StringLiterals;

namespace ibkr::app {

namespace {
double nowMs() { return double(QDateTime::currentMSecsSinceEpoch()); }

/// 跑一个命令,等它完;stdout / stderr / 退出码交给回调。到时限就杀掉,按失败算
void runFile(QObject* owner, const QString& program, const QStringList& args, int timeoutMs, std::function<void(bool ok, QString out, QString err)> done) {
    auto* p = new QProcess(owner);
    auto finished = std::make_shared<bool>(false);
    QObject::connect(p, &QProcess::finished, owner, [p, done, finished](int code, QProcess::ExitStatus status) {
        if (*finished) return;
        *finished = true;
        done(status == QProcess::NormalExit && code == 0, QString::fromUtf8(p->readAllStandardOutput()), QString::fromUtf8(p->readAllStandardError()));
        p->deleteLater();
    });
    QObject::connect(p, &QProcess::errorOccurred, owner, [p, done, finished](QProcess::ProcessError e) {
        if (e != QProcess::FailedToStart || *finished) return;
        *finished = true;
        done(false, {}, p->errorString());
        p->deleteLater();
    });
    QTimer::singleShot(timeoutMs, p, [p] { if (p->state() != QProcess::NotRunning) p->kill(); });
    p->start(program, args);
}
}  // namespace

PowerController::PowerController(shell::LogFile* log, shell::Alerter* alerter, QString userDataDir, QObject* parent)
    : QObject(parent), log_(log), alerter_(alerter), lidFile_(QDir(userDataDir).filePath(u"lid-guard.json"_s)) {}

void PowerController::start() {
    // 应用开着就不让系统挂起:挂起期间引擎不跑,追踪止盈止损也就不盯了
    if (!platform::preventAppSuspension() && QGuiApplication::platformName() == u"cocoa") log_->warn(u"[power] 阻止系统挂起失败"_s);
    apply(watch_.observe(QJsonObject{{u"onBattery"_s, platform::onBatteryPower() ? QJsonValue(*platform::onBatteryPower()) : QJsonValue()}}));
    platform::watchPower([this](bool battery) { apply(watch_.observe({{u"onBattery"_s, battery}})); },
                         [this] { apply(watch_.suspend(nowMs())); }, [this] { apply(watch_.resume(nowMs())); });
#if defined(Q_OS_MACOS)
    lid_ = shell::power::loadLidGuard(lidFile_);
    lidAvailable_ = true;
#endif
}

void PowerController::apply(const shell::power::Action& action) {
    if (!action.log.isEmpty()) log_->info(action.log);
    if (!action.notify) return;
    alerter_->systemNotify(action.notify->title, action.notify->body);
    emit alerter_->notified(action.notify->title, action.notify->body);
}

void PowerController::observeStatus(const QJsonObject& status) {
    const QJsonObject loop = status.value("broker_connected"_L1).toBool() ? status.value("tracker_loop"_L1).toObject() : QJsonObject();
    const int live = int(loop.value("live_tracks"_L1).toDouble());
    const auto battery = platform::onBatteryPower();
    QJsonObject args{{u"live"_s, live}, {u"lidAwake"_s, lidAvailable_ && lid_.owned}};
    if (battery) args.insert(u"onBattery"_s, *battery);
    apply(watch_.observe(args));
    driveLid(live);
}

void PowerController::save() { shell::power::saveLidGuard(lidFile_, lid_); }

void PowerController::driveLid(int live, std::function<void()> then) {
    const auto finish = [then] { if (then) then(); };
    if (!lidAvailable_ || lidDriving_ || quitting_) return finish();
    lidDriving_ = true;
    if (!lid_.wantsReading(live)) {
        lid_.observe({{u"live"_s, live}, {u"now"_s, nowMs()}});
        lidDriving_ = false;
        return finish();
    }
    runFile(this, u"/usr/bin/pmset"_s, {u"-g"_s}, 5000, [this, live, finish](bool ok, const QString& out, const QString&) {
        QJsonObject args{{u"live"_s, live}, {u"now"_s, nowMs()}};
        if (ok) {
            if (const auto disabled = shell::power::parseSleepDisabled(out)) args.insert(u"sleepDisabled"_s, *disabled);
        }
        applyLidAction(lid_.observe(args), [this, finish] {
            lidDriving_ = false;
            finish();
        });
    });
}

void PowerController::applyLidAction(const shell::power::Action& action, std::function<void()> then) {
    if (!action.log.isEmpty()) log_->info(action.log);
    if (!action.set) return then();
    const bool on = *action.set;
    // 授权框最多等 2 分钟
    runFile(this, u"/usr/bin/osascript"_s, {u"-e"_s, shell::power::pmsetScript(on)}, 120'000, [this, on, then](bool ok, const QString&, const QString& err) {
        const QString outcome = ok ? u"ok"_s : shell::power::isCancelled(err, {}) ? u"cancelled"_s : u"failed"_s;
        apply(lid_.done(on, outcome, err.trimmed().left(200)));
        save();
        emit lidChanged();
        then();
    });
}

void PowerController::setLidGuardEnabled(bool enabled) {
    if (!lidAvailable_) return;
    lid_.setEnabled(enabled);
    log_->info(u"[power] 「盯盘时合盖不睡」%1"_s.arg(enabled ? u"打开"_s : u"关掉"_s));
    save();
    emit lidChanged();
    driveLid(watch_.live);
}

bool PowerController::lidRestorePending() const { return lidAvailable_ && lid_.owned && !lidRestored_; }

void PowerController::restoreLidSleep(std::function<void()> done) {
    quitting_ = true;
    if (!lidRestorePending()) return done();
    lidRestored_ = true;
    const shell::power::Action action = lid_.quitAction();
    if (!action.set) return done();
    applyLidAction(action, [this, done] {
        if (lid_.owned) {
            QMessageBox box(QMessageBox::Warning, u"合盖睡眠还关着"_s, u"合盖睡眠还关着"_s);
            box.setInformativeText(u"合上盖子电脑不会睡。要恢复,在终端里运行:\nsudo pmset -a disablesleep 0"_s);
            box.exec();
        }
        done();
    });
}

}  // namespace ibkr::app
