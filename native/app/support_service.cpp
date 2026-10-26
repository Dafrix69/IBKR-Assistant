#include "support_service.h"

#include "shell/alerter.h"
#include "shell/diagnostics.h"
#include "shell/engine_client.h"
#include "shell/engine_supervisor.h"
#include "shell/log_file.h"
#include "shell/store_guard.h"
#include "shell/update_check.h"

#include <QCoreApplication>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QJSEngine>
#include <QJsonArray>
#include <QJsonDocument>
#include <QLocale>
#include <QNetworkReply>
#include <QStandardPaths>
#include <QSysInfo>

#if defined(Q_OS_MACOS)
#include <sys/sysctl.h>
#endif

using namespace Qt::StringLiterals;

namespace ibkr::app {

namespace {

double nowMs() { return double(QDateTime::currentMSecsSinceEpoch()); }

qint64 totalMemoryMb() {
#if defined(Q_OS_MACOS)
    quint64 bytes = 0;
    size_t len = sizeof(bytes);
    if (sysctlbyname("hw.memsize", &bytes, &len, nullptr, 0) == 0) return qint64(bytes / 1024 / 1024);
#endif
    return 0;
}

}  // namespace

struct SupportService::Collected {
    std::optional<QJsonValue> status;
    std::optional<QJsonValue> selftest;
    std::optional<QJsonValue> backups;
    QStringList errors;
};

SupportService::SupportService(Deps deps, QObject* parent) : QObject(parent), deps_(std::move(deps)) {
    if (deps_.latestApi.isEmpty()) deps_.latestApi = shell::update::kLatestApi;
    if (deps_.platform.isEmpty()) deps_.platform = shell::update::nodePlatform();
    if (deps_.arch.isEmpty()) deps_.arch = shell::update::nodeArch();
}

void SupportService::ask(const QString& method, std::function<void(std::optional<QJsonValue>, QString)> done) {
    if (!deps_.engine || !deps_.engine->running()) return done(std::nullopt, {});
    shell::CallOptions o;
    o.timeoutMs = 5000;
    deps_.engine->call(method, QJsonObject{}, o, [done, method](const shell::EngineReply& r) {
        if (r.ok) done(r.result, {});
        else done(std::nullopt, method + u":"_s + r.error);
    });
}

void SupportService::collect(std::function<void(const Collected&)> done) {
    auto out = std::make_shared<Collected>();
    auto left = std::make_shared<int>(3);
    const auto one = [out, left, done](std::optional<QJsonValue> Collected::* field) {
        return [out, left, done, field](std::optional<QJsonValue> v, const QString& error) {
            (*out).*field = v;
            if (!error.isEmpty()) out->errors << error;
            if (--*left == 0) done(*out);
        };
    };
    ask(u"system.status"_s, one(&Collected::status));
    ask(u"system.selftest"_s, one(&Collected::selftest));
    ask(u"data.backups"_s, one(&Collected::backups));
}

void SupportService::exportDiagnostics(Done done) {
    const QString downloads = QStandardPaths::writableLocation(QStandardPaths::DownloadLocation);
    const QString path = deps_.pickSavePath ? deps_.pickSavePath(u"导出诊断信息"_s, QDir(downloads).filePath(shell::diagnostics::defaultFileName(nowMs())), u"文本 (*.txt)"_s) : QString();
    if (path.isEmpty()) return done(QJsonObject{{u"ok"_s, false}, {u"canceled"_s, true}}, {});
    collect([this, path, done](const Collected& c) {
        shell::diagnostics::Input in;
        in.app = shell::OJson::fromQJson(QJsonObject{});
        in.app.type = shell::OJson::Object;
        const auto add = [&in](const QString& k, const shell::OJson& v) { in.app.set(k, v); };
        add(u"name"_s, shell::OJson::string(QCoreApplication::applicationName()));
        add(u"version"_s, shell::OJson::string(deps_.appVersion));
#if defined(IBKR_PACKAGED)
        add(u"packaged"_s, shell::OJson::boolean(true));
#else
        add(u"packaged"_s, shell::OJson::boolean(false));
#endif
        add(u"qt"_s, shell::OJson::string(QString::fromLatin1(qVersion())));
        add(u"platform"_s, shell::OJson::string(deps_.platform));
        add(u"arch"_s, shell::OJson::string(deps_.arch));
        add(u"os"_s, shell::OJson::string(QSysInfo::kernelType() + u' ' + QSysInfo::kernelVersion()));
        add(u"locale"_s, shell::OJson::string(QLocale::system().bcp47Name()));
        add(u"memory_mb"_s, shell::OJson::number(double(totalMemoryMb())));
        add(u"user_data"_s, shell::OJson::string(deps_.userDataDir));
        in.configPath = deps_.configPath;
        in.logPath = deps_.log ? deps_.log->path() : QString();
        in.oldLogPath = in.logPath.endsWith(u".log"_s) ? in.logPath.chopped(4) + u".old.log"_s : QString();
        shell::diagnostics::Engine e;
        e.running = deps_.engine && deps_.engine->running();
        e.restarts = deps_.supervisor ? deps_.supervisor->restarts() : 0;
        if (c.status) e.status = shell::OJson::fromQJson(*c.status);
        if (c.selftest) e.selftest = shell::OJson::fromQJson(*c.selftest);
        if (c.backups) e.backups = shell::OJson::fromQJson(*c.backups);
        e.errors = c.errors;
        in.engine = e;
        shell::OJson extra;
        extra.type = shell::OJson::Object;
        extra.set(u"consent"_s, deps_.consentState ? deps_.consentState() : shell::OJson::null());
        extra.set(u"last_update_check"_s, updateCache_ ? shell::OJson::fromQJson(*updateCache_) : shell::OJson::null());
        in.extra = extra;
        in.now = nowMs();
        in.homedir = QDir::homePath();
        QFile f(path);
        if (!f.open(QIODevice::WriteOnly) || f.write(shell::diagnostics::buildReport(in).toUtf8()) < 0) return done({}, u"写不进去:"_s + path);
        f.close();
        if (deps_.log) deps_.log->info(u"[support] 已导出诊断信息"_s);
        if (deps_.reveal) deps_.reveal(path);
        done(QJsonObject{{u"ok"_s, true}, {u"path"_s, path}}, {});
    });
}

void SupportService::copyDiagnostics(Done done) {
    collect([this, done](const Collected& c) {
        shell::diagnostics::Input in;
        in.app.type = shell::OJson::Object;
        in.app.set(u"version"_s, shell::OJson::string(deps_.appVersion));
        in.app.set(u"qt"_s, shell::OJson::string(QString::fromLatin1(qVersion())));
        in.app.set(u"platform"_s, shell::OJson::string(deps_.platform));
        in.app.set(u"arch"_s, shell::OJson::string(deps_.arch));
        in.app.set(u"os"_s, shell::OJson::string(QSysInfo::kernelType() + u' ' + QSysInfo::kernelVersion()));
        shell::diagnostics::Engine e;
        e.running = deps_.engine && deps_.engine->running();
        e.restarts = deps_.supervisor ? deps_.supervisor->restarts() : 0;
        if (c.status) e.status = shell::OJson::fromQJson(*c.status);
        e.errors = c.errors;
        in.engine = e;
        in.homedir = QDir::homePath();
        if (deps_.copyText) deps_.copyText(shell::diagnostics::buildSummary(in));
        done(QJsonObject{{u"ok"_s, true}}, {});
    });
}

void SupportService::reveal(const QString& kind, Done done) {
    // 只认这几个固定的地方
    if (kind == u"logs") {
        if (deps_.reveal && deps_.log) deps_.reveal(deps_.log->path());
        return done(QJsonObject{{u"ok"_s, true}}, {});
    }
    if (kind == u"config") {
        if (deps_.reveal) deps_.reveal(deps_.configPath);
        return done(QJsonObject{{u"ok"_s, true}}, {});
    }
    if (kind == u"notices") {
        if (deps_.noticesPath.isEmpty() || !QFile::exists(deps_.noticesPath))
            return done({}, u"这一份是打包时生成的:从源码运行时没有这份文件"_s);
        const QString failed = deps_.openPath ? deps_.openPath(deps_.noticesPath) : QString();
        return failed.isEmpty() ? done(QJsonObject{{u"ok"_s, true}}, {}) : done({}, failed);
    }
    if (kind == u"backups") {
        ask(u"data.backups"_s, [this, done](std::optional<QJsonValue> info, const QString&) {
            if (!info) return done({}, u"交易引擎没有在运行,读不到备份目录"_s);
            const QString dir = info->toObject().value("dir"_L1).toString();
            QDir().mkpath(dir);
            const QString failed = deps_.openPath ? deps_.openPath(dir) : QString();
            failed.isEmpty() ? done(QJsonObject{{u"ok"_s, true}}, {}) : done({}, failed);
        });
        return;
    }
    done({}, u"未知的位置:%1"_s.arg(kind));
}

QJsonObject SupportService::accountsInfo() const {
    QFile f(deps_.configPath);
    std::optional<shell::OJson> config;
    if (f.open(QIODevice::ReadOnly)) config = shell::parseOJson(QString::fromUtf8(f.readAll()));
    const shell::OJson c = config.value_or(shell::OJson());
    return QJsonObject{{u"placeholders"_s, QJsonArray::fromStringList(shell::accounts::placeholderAliases(c))}, {u"connections"_s, shell::accounts::connectionChoices(c)}};
}

void SupportService::changeAccount(const shell::OJson& change, Done done) {
    if (deps_.readOnly) return done({}, u"预览模式不改配置文件"_s);
    QString error;
    const auto plan = shell::accounts::planChange(deps_.configPath, change, &error);  // 校验不过在这里就拒,话是给人看的
    if (!plan) return done({}, error);
    Confirm box;
    box.title = box.message = plan->headline;
    box.detail = plan->lines.join(u'\n');
    box.buttons = {u"取消"_s, plan->headline == u"删除账户" ? u"删除"_s : u"保存"_s};
    box.defaultIndex = 0;
    box.cancelIndex = 0;
    if (!deps_.confirm || deps_.confirm(box) != 1) return done(QJsonObject{{u"ok"_s, false}, {u"canceled"_s, true}}, {});
    if (!shell::accounts::commitChange(deps_.configPath, *plan)) return done({}, u"写不进配置文件:"_s + deps_.configPath);
    if (deps_.log) {
        const shell::OJson* alias = change.get(u"alias"_s);
        deps_.log->warn(u"[accounts] %1:%2"_s.arg(plan->headline, alias ? alias->toQJson().toVariant().toString() : u"undefined"_s));
    }
    // 配置是引擎启动时读的:重启它,由它把整份配置再验一遍(验不过会走"配置文件有问题"那个对话框,可以恢复)
    restartEngine();
    done(QJsonObject{{u"ok"_s, true}}, {});
}

void SupportService::restoreBackup(const QString& name, Done done) {
    if (deps_.readOnly) return done({}, u"预览模式不换交易库"_s);
    ask(u"data.backups"_s, [this, name, done](std::optional<QJsonValue> info, const QString&) {
        if (!deps_.engine || !info) return done({}, u"交易引擎没有在运行,现在不能恢复。请先到「关于」里重启引擎。"_s);
        const QString dbPath = info->toObject().value("db_path"_L1).toString();
        std::optional<shell::store::Backup> target;
        for (const shell::store::Backup& b : shell::store::listBackups(dbPath))
            if (b.name == name) target = b;
        if (!target) return done({}, u"找不到这份备份,请刷新备份列表后再试"_s);
        Confirm box;
        box.title = u"从备份恢复交易库"_s;
        box.message = u"用这份备份换掉现在的交易库?"_s;
        box.detail = u"备份:%1\n\n这份备份之后产生的交易记录、成交、追踪设置、想法,在恢复后的库里都没有。\n"
                     u"恢复前会先给现在的库再留一份备份,原文件也会改名留在旁边,不会删。\n"
                     u"恢复期间交易引擎会重启:持仓追踪停几秒,券商连接会重连。已经挂在券商那边的单不受影响。"_s.arg(shell::store::describeBackup(*target));
        box.buttons = {u"取消"_s, u"恢复这一份"_s};
        if (!deps_.confirm || deps_.confirm(box) != 1) return done(QJsonObject{{u"ok"_s, false}, {u"canceled"_s, true}}, {});
        // 先给现在的库留一份(能留就留:库已经坏了的话这一步会失败,不挡恢复)
        shell::CallOptions o;
        o.timeoutMs = 30'000;
        deps_.engine->call(u"data.backup"_s, QJsonObject{}, o, [this, dbPath, target, done](const shell::EngineReply& r) {
            if (!r.ok && deps_.log) deps_.log->warn(u"[backup] 恢复前的备份没有成功:"_s + r.error);
            deps_.engine->stop({}, [this, dbPath, target, done] {
                QString error;
                const auto restored = shell::store::restoreBackup(dbPath, target->name, nowMs(), &error);
                if (restored) {
                    if (deps_.log) deps_.log->warn(u"[backup] 已从备份恢复交易库:%1,原库 %2"_s.arg(restored->restored, restored->kept));
                    if (deps_.alerter) deps_.alerter->systemNotify(u"交易库已恢复"_s, u"已恢复到 %1。原来的库留在旁边,没有删。"_s.arg(shell::store::describeBackup(*target)));
                }
                if (deps_.supervisor) deps_.supervisor->startAgain();
                else deps_.engine->start(true);
                restored ? done(QJsonObject{{u"ok"_s, true}, {u"restored"_s, restored->restored}}, {}) : done({}, error);
            });
        });
    });
}

void SupportService::checkUpdate(bool force, Done done) {
    // 结果缓存 10 分钟:GitHub 对未登录的查询一小时只给 60 次,界面上连点「检查更新」不该把额度点光
    if (!force && updateCache_ && nowMs() - updateCache_->value("checkedAt"_L1).toDouble() < 10 * 60'000) return done(*updateCache_, {});
    QNetworkRequest req{QUrl(deps_.latestApi)};
    req.setRawHeader("Accept", "application/vnd.github+json");
    // GitHub 的 API 不带 User-Agent 直接 403;只报应用名与版本,不带任何账户或机器信息
    req.setRawHeader("User-Agent", u"Datrix/%1"_s.arg(deps_.appVersion).toUtf8());
    req.setTransferTimeout(deps_.updateTimeoutMs);
    QNetworkReply* reply = net_.get(req);
    connect(reply, &QNetworkReply::finished, this, [this, reply, done] {
        reply->deleteLater();
        const QVariant statusAttr = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute);
        if (!statusAttr.isValid()) {
            const bool timeout = reply->error() == QNetworkReply::OperationCanceledError || reply->error() == QNetworkReply::TimeoutError;
            return done({}, timeout ? u"连接 GitHub 超时,稍后再试(不影响交易)"_s : u"连不上 GitHub,稍后再试(不影响交易)"_s);
        }
        const int status = statusAttr.toInt();
        if (status == 404) return done({}, u"还没有发布过正式版本"_s);
        if (status == 403 || status == 429) return done({}, u"GitHub 限制了查询频率,过一小时再试"_s);
        if (status < 200 || status >= 300) return done({}, u"检查更新失败(HTTP %1)"_s.arg(status));
        QJsonParseError err;
        const QJsonDocument doc = QJsonDocument::fromJson(reply->readAll(), &err);
        if (err.error != QJsonParseError::NoError) return done({}, u"GitHub 返回的内容读不懂,稍后再试"_s);
        updateCache_ = shell::update::summarizeRelease(doc.isObject() ? QJsonValue(doc.object()) : QJsonValue(doc.array()), deps_.appVersion, deps_.platform, deps_.arch, nowMs());
        done(*updateCache_, {});
    });
}

QJsonObject SupportService::appInfo() const {
    return QJsonObject{
        {u"version"_s, deps_.appVersion},
        {u"qt"_s, QString::fromLatin1(qVersion())},
        {u"configPath"_s, deps_.configPath},
        {u"repoRoot"_s, deps_.repoDir},
        {u"logPath"_s, deps_.log ? deps_.log->path() : QString()},
        // 引擎与界面同一次编出来(native/),版本就是应用的版本
        {u"engineVersion"_s, deps_.appVersion},
        // 开发态只认源码运行且带 DAFRI_DEV=1(main.js 的 DEV):不带这个变量的源码运行照常自动检查更新
#if defined(IBKR_PACKAGED)
        {u"dev"_s, false},
#else
        {u"dev"_s, qEnvironmentVariable("DAFRI_DEV") == u"1"},
#endif
        {u"engineRunning"_s, deps_.engine && deps_.engine->running()},
    };
}

void SupportService::restartEngine() {
    // 先等旧引擎真的退出再拉新的:两个引擎同时活着会抢同一个 TWS client id、同时写库、同时跑盯盘节拍
    if (!deps_.engine) return;
    if (deps_.supervisor) deps_.supervisor->noteStarted();
    deps_.engine->restart();
}

void SupportService::quitApp() { QCoreApplication::quit(); }

bool SupportService::externalAllowed(const QString& url) {
    const QUrl u(url, QUrl::StrictMode);
    static const QStringList hosts{u"github.com"_s, u"www.tradingview.com"_s};
    return u.isValid() && u.scheme() == u"https" && hosts.contains(u.host());
}

bool SupportService::openExternal(const QString& url) {
    if (externalAllowed(url)) {
        if (deps_.openUrl) deps_.openUrl(QUrl(url));
        return true;
    }
    if (deps_.log) deps_.log->warn(u"[shell] 拒绝打开外部链接 "_s + url.left(200));
    return false;
}

SupportService::Done SupportService::toJs(const QJSValue& callback) {
    QPointer<SupportService> self(this);
    return [self, callback](const QJsonObject& result, const QString& error) mutable {
        if (!self || !callback.isCallable() || !self->js_) return;
        callback.call({QJSValue(error.isEmpty()), self->js_->toScriptValue(result.toVariantMap()), QJSValue(error)});
    };
}

void SupportService::exportDiagnostics(const QJSValue& callback) { exportDiagnostics(toJs(callback)); }
void SupportService::copyDiagnostics(const QJSValue& callback) { copyDiagnostics(toJs(callback)); }
void SupportService::reveal(const QString& kind, const QJSValue& callback) { reveal(kind, toJs(callback)); }
void SupportService::restoreBackup(const QString& name, const QJSValue& callback) { restoreBackup(name, toJs(callback)); }
void SupportService::checkUpdate(bool force, const QJSValue& callback) { checkUpdate(force, toJs(callback)); }
void SupportService::changeAccount(const QJSValue& change, const QJSValue& callback) {
    changeAccount(shell::OJson::fromQJson(QJsonValue::fromVariant(change.toVariant(QJSValue::ConvertJSObjects))), toJs(callback));
}

}  // namespace ibkr::app
