#include "shell/access_controller.h"

#include "shell/access_rules.h"
#include "shell/bridge.h"
#include "shell/jsvalue.h"
#include "shell/llm_store.h"
#include "shell/shell_actions.h"
#include "shell/status_store.h"

#include <QJsonArray>
#include <QJsonDocument>
#include <QPointer>
#include <QSettings>
#include <QTimer>

namespace ibkr::shell {

using namespace Qt::StringLiterals;

namespace {

QString S(const QJsonValue& v) { return jsString(v); }
bool T(const QJsonValue& v) { return jsTruthy(v); }
bool has(const QJsonValue& v) { return !v.isUndefined() && !v.isNull(); }
/// errorWithPrefix:报错本身已经带着这个开头就不再加
QString withPrefix(const QString& prefix, const QString& error) { return error.startsWith(prefix) ? error : prefix + error; }
/// InputNumber 的 onChange:null 是清空了,别的是数
QJsonValue numOrNull(const QVariant& v) {
    if (!v.isValid() || v.isNull()) return QJsonValue::Null;
    bool ok = false;
    const double x = v.toDouble(&ok);
    return ok ? QJsonValue(x) : QJsonValue(QJsonValue::Null);
}

}  // namespace

AccessController::AccessController(Bridge* bridge, StatusStore* status, LlmStore* llm, ShellActions* actions, QString settingsPath, QObject* parent)
    : QObject(parent), bridge_(bridge), status_(status), llm_(llm), actions_(actions), settingsPath_(std::move(settingsPath)) {
    const QString saved = QSettings(settingsPath_, QSettings::IniFormat).value(u"access/subtab"_s).toString();
    if (saved == u"tws" || saved == u"accounts" || saved == u"llm" || saved == u"follow") sub_ = saved;
    if (status_) connect(status_, &StatusStore::statusChanged, this, [this] { if (visible_) rebuild(); });
    if (llm_)
        connect(llm_, &LlmStore::changed, this, [this] {
            if (!visible_ || sub_ != u"llm") return;
            reseedLlm();
            rebuild();
        });
    // 「连接 / 断开交易引擎」借壳上的动作:那边做完了,这一颗按钮的读着才落下(只认从这里点的那一次)
    if (actions_)
        connect(actions_, &ShellActions::busyChanged, this, [this] {
            if (bits_[u"busy"_s].toBool() && !actions_->busy()) {
                bits_[u"busy"_s] = false;
                rebuild();
            }
        });
    rebuild();
}

void AccessController::writeSub(const QString& sub) const { QSettings(settingsPath_, QSettings::IniFormat).setValue(u"access/subtab"_s, sub); }

QJsonObject& AccessController::panel() { return state_; }

void AccessController::setVisible(bool on) {
    if (on == visible_) return;
    visible_ = on;
    ++generation_;
    state_ = {};
    bits_ = {};
    llmSeeded_.clear();
    if (on) mount();
    rebuild();
}

void AccessController::setSub(const QString& sub) {
    if (sub == sub_) return;
    sub_ = sub;
    writeSub(sub);
    // 换子页签 = 旧的那节卸载、新的那节挂上
    ++generation_;
    state_ = {};
    bits_ = {};
    llmSeeded_.clear();
    if (visible_) mount();
    rebuild();
}

void AccessController::mount() {
    if (sub_ == u"tws") loadTwsScan();
    else if (sub_ == u"accounts") loadAccounts();
    else if (sub_ == u"llm") {
        if (llm_) llm_->load();
        reseedLlm();
    } else if (sub_ == u"follow") loadFollow(true);
}

void AccessController::rebuild() {
    const QJsonObject st = status_ ? status_->status() : QJsonObject{};
    const QJsonValue status = st.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(st);
    if (sub_ == u"tws") model_ = access::twsModel(state_, bits_, status);
    else if (sub_ == u"accounts") model_ = access::accountsModel(state_, status);
    else if (sub_ == u"llm") model_ = access::llmModel(state_, llm_ ? llm_->catalog() : QJsonValue());
    else {
        model_ = access::followModel(state_, status, zone);
    }
    emit changed();
}

// ---- TWS --------------------------------------------------------------------------------------------

void AccessController::loadTwsScan() {
    const int gen = generation_;
    QPointer<AccessController> self(this);
    bridge_->rpc(this, u"tws.scan"_s, QJsonObject{}, [self, gen](const EngineReply& r) {
        if (!self || gen != self->generation_) return;
        if (r.ok) {
            self->state_[u"scan"_s] = r.result;
            self->state_[u"scanError"_s] = QJsonValue::Null;
        } else self->state_[u"scanError"_s] = r.error;
        self->rebuild();
        // 横幅只是提示:读不到券商目录就不显示
        self->bridge_->rpc(self, u"broker.catalog"_s, QJsonObject{}, [self, gen](const EngineReply& c) {
            if (!self || gen != self->generation_ || !c.ok) return;
            self->state_[u"current"_s] = T(c.result[u"current"_s]) ? c.result[u"current"_s] : QJsonValue(QJsonValue::Null);
            self->rebuild();
        });
    });
}

void AccessController::rescan() {
    if (sub_ == u"tws") loadTwsScan();
}

void AccessController::diagnose() {
    if (sub_ != u"tws") return;
    state_[u"diagState"_s] = u"working"_s;
    rebuild();
    const int gen = generation_;
    QPointer<AccessController> self(this);
    // diagnoseTws() 不带连接:{ connections: undefined } 在 JSON 里没有这个键
    bridge_->rpc(this, u"tws.diagnose"_s, QJsonObject{}, [self, gen](const EngineReply& r) {
        if (!self || gen != self->generation_) return;
        if (r.ok) {
            self->state_[u"diag"_s] = r.result[u"results"_s].isArray() ? r.result[u"results"_s] : QJsonValue(QJsonArray{});
            self->state_[u"diagState"_s] = u"idle"_s;
        } else {
            self->state_[u"diagError"_s] = r.error;
            self->state_[u"diagState"_s] = u"error"_s;
        }
        self->rebuild();
    });
}

void AccessController::launch(const QString& key, const QString& name) {
    if (sub_ != u"tws") return;
    bits_[u"launching"_s] = key;
    rebuild();
    const int gen = generation_;
    QPointer<AccessController> self(this);
    const QJsonObject params{{u"app"_s, key}, {u"__confirmed"_s, true}};
    bridge_->rpc(this, u"tws.launch"_s, params, [self, gen, name](const EngineReply& r) {
        if (!self) return;
        if (r.ok) {
            emit self->notify(u"已启动 "_s + name, u"请在它自己的窗口里登录"_s);
            QTimer::singleShot(self->relaunchScanMs, self, [self, gen] {
                if (!self || gen != self->generation_) return;
                self->loadTwsScan();
            });
        } else if (self->status_) self->status_->showError(withPrefix(u"启动失败:"_s, r.error));
        if (gen != self->generation_) return;
        self->bits_[u"launching"_s] = QJsonValue::Null;
        self->rebuild();
    });
}

void AccessController::toggleConnection() {
    if (!actions_ || bits_[u"busy"_s].toBool() || actions_->busy()) return;
    bits_[u"busy"_s] = true;
    rebuild();
    actions_->toggleBrokerConnection();
    if (!actions_->busy()) {  // 那边当场就回了(没在跑)
        bits_[u"busy"_s] = false;
        rebuild();
    }
}

// ---- 账户 ---------------------------------------------------------------------------------------------------

void AccessController::loadAccounts() {
    state_[u"info"_s] = accountsInfo ? accountsInfo() : QJsonObject{{u"placeholders"_s, QJsonArray{}}, {u"connections"_s, QJsonArray{}}};
}

void AccessController::openDraft(const QString& alias) {
    QJsonObject account;
    const QJsonArray accounts = status_ ? status_->status()[u"accounts"_s].toArray() : QJsonArray{};
    for (const QJsonValue& a : accounts)
        if (!alias.isEmpty() && S(a[u"alias"_s]) == alias) account = a.toObject();
    const QJsonArray conns = state_[u"info"_s][u"connections"_s].toArray();
    const bool editing = !account.isEmpty();
    state_[u"draft"_s] = QJsonObject{{u"editing"_s, editing ? QJsonValue(alias) : QJsonValue(QJsonValue::Null)},
                                     {u"alias"_s, editing ? alias : QString()},
                                     {u"accountId"_s, QString()},
                                     {u"paper"_s, editing ? account[u"is_paper"_s].toBool() : true},
                                     {u"connection"_s, editing ? S(account[u"connection"_s]) : conns.isEmpty() ? QString() : S(conns.first()[u"name"_s])},
                                     {u"makeDefault"_s, editing ? account[u"default"_s].toBool() : accounts.isEmpty()}};
    rebuild();
}

void AccessController::setDraft(const QString& field, const QVariant& value) {
    QJsonObject d = state_[u"draft"_s].toObject();
    if (d.isEmpty()) return;
    d[field] = QJsonValue::fromVariant(value);
    state_[u"draft"_s] = d;
    rebuild();
}

void AccessController::cancelDraft() {
    state_[u"draft"_s] = QJsonValue::Null;
    rebuild();
}

void AccessController::saveDraft() {
    const QJsonObject d = state_[u"draft"_s].toObject();
    if (d.isEmpty()) return;
    submitAccount(QJsonObject{{u"action"_s, u"upsert"_s},
                              {u"alias"_s, jsTrim(d[u"alias"_s].toString())},
                              {u"account_id"_s, jsTrim(d[u"accountId"_s].toString())},
                              {u"is_paper"_s, d[u"paper"_s].toBool()},
                              {u"connection"_s, d[u"connection"_s].toString()},
                              {u"make_default"_s, d[u"makeDefault"_s].toBool()}});
}

void AccessController::removeAccount(const QString& alias) { submitAccount(QJsonObject{{u"action"_s, u"remove"_s}, {u"alias"_s, alias}}); }

void AccessController::submitAccount(const QJsonObject& change) {
    if (!changeAccount) return;
    state_[u"busy"_s] = true;
    rebuild();
    const int gen = generation_;
    QPointer<AccessController> self(this);
    changeAccount(change, [self, gen](const QJsonObject& result, const QString& error) {
        if (!self) return;
        if (!error.isEmpty()) {
            if (self->status_) self->status_->showError(error);
        } else if (result[u"ok"_s].toBool()) {
            if (gen == self->generation_) self->state_[u"draft"_s] = QJsonValue::Null;
            if (self->status_) self->status_->showInfo(u"账户已保存,交易引擎正在重启。"_s);
            // 引擎重启要几秒:等它起来再读状态
            QTimer::singleShot(self->accountsRefreshMs, self, [self, gen] {
                if (!self) return;
                if (self->status_) self->status_->refresh();
                if (gen != self->generation_) return;
                self->loadAccounts();
                self->rebuild();
            });
        }
        if (gen != self->generation_) return;
        self->state_[u"busy"_s] = false;
        self->rebuild();
    });
}

// ---- 大模型 -------------------------------------------------------------------------------------------------

void AccessController::reseedLlm() {
    const QJsonValue catalog = llm_ ? llm_->catalog() : QJsonValue();
    if (!catalog.isObject()) return;
    const QJsonValue current = catalog[u"current"_s];
    QString provider = state_[u"provider"_s].toString();
    const QString p = provider.isEmpty() ? S(current[u"provider"_s]) : provider;
    if (provider.isEmpty()) state_[u"provider"_s] = p;
    QJsonObject meta;
    for (const QJsonValue& x : catalog[u"providers"_s].toArray())
        if (S(x[u"key"_s]) == p) meta = x.toObject();
    const bool same = p == S(current[u"provider"_s]);
    // 只在供应商或已存配置真的变了时重填:目录每次读都是新的一份,按对象换不换判断会把还没存的模型名、Base URL 冲掉
    const QString sig = QString::fromUtf8(QJsonDocument(QJsonArray{p, current}).toJson(QJsonDocument::Compact));
    if (llmSeeded_ == sig) return;
    llmSeeded_ = sig;
    const QJsonArray models = meta[u"models"_s].toArray();
    state_[u"model"_s] = same && T(current[u"model"_s]) ? S(current[u"model"_s])
                         : !models.isEmpty() && T(models.first()) ? S(models.first())
                         : T(meta[u"default_model"_s])           ? S(meta[u"default_model"_s])
                                                                  : QString();
    state_[u"customModel"_s] = QString();
    state_[u"baseUrl"_s] = same ? (T(current[u"base_url"_s]) ? S(current[u"base_url"_s]) : QString()) : (T(meta[u"default_base_url"_s]) ? S(meta[u"default_base_url"_s]) : QString());
    state_[u"effort"_s] = T(current[u"effort"_s]) ? S(current[u"effort"_s]) : u"high"_s;
    state_[u"temperature"_s] = has(current[u"temperature"_s]) ? current[u"temperature"_s] : QJsonValue(QJsonValue::Null);
    state_[u"maxTokens"_s] = has(current[u"max_tokens"_s]) ? current[u"max_tokens"_s] : QJsonValue(QJsonValue::Null);
    state_[u"timeout"_s] = has(current[u"timeout_s"_s]) ? current[u"timeout_s"_s] : QJsonValue(QJsonValue::Null);
}

void AccessController::setLlm(const QString& field, const QVariant& value) {
    if (field == u"temperature" || field == u"maxTokens" || field == u"timeout") state_[field] = numOrNull(value);
    else state_[field] = value.toString();
    if (field == u"provider") {
        state_[u"test"_s] = QJsonValue::Null;
        reseedLlm();
    }
    rebuild();
}

QJsonObject AccessController::llmPatch() const {
    QJsonObject meta;
    const QJsonValue catalog = llm_ ? llm_->catalog() : QJsonValue();
    for (const QJsonValue& x : catalog[u"providers"_s].toArray())
        if (S(x[u"key"_s]) == state_[u"provider"_s].toString()) meta = x.toObject();
    const QString custom = jsTrim(state_[u"customModel"_s].toString());
    QJsonObject patch{{u"provider"_s, state_[u"provider"_s].toString()},
                      {u"model"_s, custom.isEmpty() ? state_[u"model"_s].toString() : custom},
                      {u"max_tokens"_s, state_[u"maxTokens"_s].toDouble()},
                      {u"timeout_s"_s, state_[u"timeout"_s].toDouble()}};
    if (T(meta[u"needs_base_url"_s])) patch[u"base_url"_s] = jsTrim(state_[u"baseUrl"_s].toString());
    if (T(meta[u"supports_effort"_s])) patch[u"effort"_s] = state_.contains(u"effort"_s) ? state_[u"effort"_s].toString() : u"high"_s;
    if (T(meta[u"supports_temperature"_s])) patch[u"temperature"_s] = state_[u"temperature"_s].isDouble() ? state_[u"temperature"_s] : QJsonValue(QJsonValue::Null);
    return patch;
}

QString AccessController::llmInvalid() const {
    const QJsonValue mt = state_[u"maxTokens"_s], to = state_[u"timeout"_s];
    if (!mt.isDouble() || mt.toDouble() < 1000) return u"max_tokens 至少 1000,先把它填上"_s;
    if (!to.isDouble() || to.toDouble() < 1) return u"超时(秒)至少 1,先把它填上"_s;
    return {};
}

void AccessController::testLlm() {
    if (const QString bad = llmInvalid(); !bad.isEmpty()) {
        if (status_) status_->showInfo(bad);
        return;
    }
    state_[u"testing"_s] = true;
    state_[u"test"_s] = QJsonObject{{u"pending"_s, true}};
    rebuild();
    const QJsonObject patch = llmPatch();
    QJsonObject params{{u"llm"_s, patch}};
    // 允许带一把还没保存的 key 先试,试通了再保存
    if (const QString key = jsTrim(state_[u"apiKey"_s].toString()); !key.isEmpty()) params[u"api_key"_s] = key;
    const int gen = generation_;
    QPointer<AccessController> self(this);
    bridge_->rpc(this, u"llm.test"_s, params, [self, gen, patch](const EngineReply& r) {
        if (!self || gen != self->generation_) return;
        self->state_[u"test"_s] = r.ok ? r.result : QJsonValue(QJsonObject{{u"ok"_s, false}, {u"error"_s, r.error}, {u"provider"_s, patch[u"provider"_s]}, {u"model"_s, patch[u"model"_s]}});
        self->state_[u"testing"_s] = false;
        self->rebuild();
    });
}

void AccessController::saveLlm() {
    if (const QString bad = llmInvalid(); !bad.isEmpty()) {
        if (status_) status_->showInfo(bad);
        return;
    }
    QPointer<AccessController> self(this);
    bridge_->rpc(this, u"llm.patch"_s, QJsonObject{{u"llm"_s, llmPatch()}, {u"__confirmed"_s, true}}, [self](const EngineReply& r) {
        if (!self) return;
        if (r.ok) {
            if (self->llm_) self->llm_->load();
            if (self->status_) {
                self->status_->refresh();
                self->status_->showInfo(u"模型配置已保存,提示词与解析引擎已重建。"_s);
            }
        } else if (self->status_) self->status_->showError(u"保存失败(配置未改动):"_s + r.error);
    });
}

void AccessController::saveLlmKey() {
    const QString secret = jsTrim(state_[u"apiKey"_s].toString());
    if (secret.isEmpty()) return;
    const QString provider = state_[u"provider"_s].toString();
    QString label;
    for (const QJsonValue& x : (llm_ ? llm_->catalog() : QJsonValue())[u"providers"_s].toArray())
        if (S(x[u"key"_s]) == provider) label = S(x[u"label"_s]);
    const int gen = generation_;
    QPointer<AccessController> self(this);
    bridge_->rpc(this, u"keychain.set"_s, QJsonObject{{u"secret"_s, secret}, {u"provider"_s, provider}, {u"__confirmed"_s, true}}, [self, gen, label](const EngineReply& r) {
        if (!self) return;
        if (r.ok) {
            if (gen == self->generation_) {
                self->state_[u"apiKey"_s] = QString();
                self->rebuild();
            }
            if (self->llm_) self->llm_->load();
            if (self->status_) self->status_->showInfo(u"已把 %1 的 API Key 写入 Keychain。"_s.arg(label));
        } else if (self->status_) self->status_->showError(u"写入失败:"_s + r.error);
    });
}

// ---- Discord 跟单 --------------------------------------------------------------------------------------------

void AccessController::loadFollow(bool resetForm) {
    const int gen = generation_;
    QPointer<AccessController> self(this);
    bridge_->rpc(this, u"follow.status"_s, QJsonObject{}, [self, gen, resetForm](const EngineReply& r) {
        if (!self || gen != self->generation_) return;
        if (r.ok) {
            self->state_[u"status"_s] = r.result;
            // 平时刷新不动表单:人可能正填到一半
            if (!self->state_[u"form"_s].isObject() || resetForm) self->state_[u"form"_s] = access::follow::toForm(r.result[u"config"_s]);
            self->state_[u"loadError"_s] = QJsonValue::Null;
        } else self->state_[u"loadError"_s] = r.error;
        self->rebuild();
    });
}

void AccessController::onEngineEvent(const QString& event, const QJsonValue&) {
    if (event == u"follow" && visible_ && sub_ == u"follow") loadFollow(false);
}

void AccessController::setFollow(const QString& field, const QVariant& value) {
    QJsonObject f = state_[u"form"_s].toObject();
    if (f.isEmpty()) return;
    if (field == u"maxRisk" || field == u"perDay" || field == u"maxAge") f[field] = numOrNull(value);
    else if (field == u"localInbox" || field == u"trackFly") f[field] = value.toBool();
    else f[field] = value.toString();
    state_[u"form"_s] = f;
    rebuild();
}

void AccessController::setFollowToken(const QString& text) {
    state_[u"token"_s] = text;
    rebuild();
}

void AccessController::setNewAuthor(const QString& text) {
    state_[u"newAuthor"_s] = text;
    rebuild();
}

void AccessController::saveFollowToken() {
    const QString token = jsTrim(state_[u"token"_s].toString());
    if (token.isEmpty()) return;
    state_[u"busy"_s] = u"token"_s;
    rebuild();
    const int gen = generation_;
    QPointer<AccessController> self(this);
    bridge_->rpc(this, u"follow.set_token"_s, QJsonObject{{u"token"_s, token}, {u"__confirmed"_s, true}}, [self, gen](const EngineReply& r) {
        if (!self) return;
        if (r.ok) {
            if (gen == self->generation_) {
                self->state_[u"status"_s] = r.result;
                self->state_[u"token"_s] = QString();
            }
            if (self->status_) self->status_->showInfo(u"bot token 已写入系统凭证库。"_s);
        } else if (self->status_) self->status_->showError(u"没有存上:"_s + r.error);
        if (gen != self->generation_) return;
        self->state_[u"busy"_s] = QJsonValue::Null;
        self->rebuild();
    });
}

void AccessController::reconnectFollow() {
    state_[u"busy"_s] = u"reconnect"_s;
    rebuild();
    const int gen = generation_;
    QPointer<AccessController> self(this);
    bridge_->rpc(this, u"follow.reconnect"_s, QJsonObject{}, [self, gen](const EngineReply& r) {
        if (!self) return;
        if (r.ok) {
            if (gen == self->generation_) self->state_[u"status"_s] = r.result;
        } else if (self->status_) self->status_->showError(u"重新连接失败:"_s + r.error);
        if (gen != self->generation_) return;
        self->state_[u"busy"_s] = QJsonValue::Null;
        self->rebuild();
    });
}

void AccessController::addAuthor(const QString& id) {
    QJsonObject f = state_[u"form"_s].toObject();
    if (f.isEmpty()) return;
    if (id.isEmpty()) {
        // 「手动添加」:加进去、框清空(加不进去时按钮本来就点不动)
        state_[u"form"_s] = access::follow::addAuthor(f, state_[u"newAuthor"_s].toString());
        state_[u"newAuthor"_s] = QString();
    } else state_[u"form"_s] = access::follow::addAuthor(f, id);
    rebuild();
}

void AccessController::removeAuthor(const QString& id) {
    QJsonObject f = state_[u"form"_s].toObject();
    if (f.isEmpty()) return;
    QJsonArray kept;
    for (const QJsonValue& a : f[u"authorIds"_s].toArray())
        if (a.toString() != id) kept.append(a);
    f[u"authorIds"_s] = kept;
    state_[u"form"_s] = f;
    rebuild();
}

void AccessController::toggleFollowAccount(const QString& alias, bool on) {
    QJsonObject f = state_[u"form"_s].toObject();
    if (f.isEmpty()) return;
    QStringList picked;
    for (const QJsonValue& a : f[u"accounts"_s].toArray()) picked << a.toString();
    if (on && !picked.contains(alias)) picked << alias;
    if (!on) picked.removeAll(alias);
    // Checkbox.Group 交回来的次序是选项的次序(状态快照里账户的次序);不在选项里的(账户删了)排在后面
    QStringList ordered;
    for (const QJsonValue& a : (status_ ? status_->status() : QJsonObject{})[u"accounts"_s].toArray())
        if (picked.contains(S(a[u"alias"_s]))) ordered << S(a[u"alias"_s]);
    for (const QString& p : picked)
        if (!ordered.contains(p)) ordered << p;
    f[u"accounts"_s] = QJsonArray::fromStringList(ordered);
    state_[u"form"_s] = f;
    rebuild();
}

void AccessController::setFollowEnabled(bool on) {
    QJsonObject f = state_[u"form"_s].toObject();
    if (f.isEmpty()) return;
    f[u"enabled"_s] = on;
    state_[u"form"_s] = f;
    rebuild();
    // 关是当场生效的(和「设置」页的执行闸门一样);开只改表单,跟着「保存」走确认框
    if (on || !T(state_[u"status"_s][u"config"_s][u"enabled"_s])) return;
    const int gen = generation_;
    QPointer<AccessController> self(this);
    bridge_->rpc(this, u"settings.patch"_s, QJsonObject{{u"patch"_s, QJsonObject{{u"follow"_s, QJsonObject{{u"enabled"_s, false}}}}}, {u"__confirmed"_s, true}},
                 [self, gen](const EngineReply& r) {
                     if (!self) return;
                     if (r.ok) {
                         if (self->status_) self->status_->showInfo(u"已关闭自动跟单,当场生效。频道照常在听,只观察、不发单。"_s);
                         if (gen == self->generation_) self->loadFollow(false);
                         return;
                     }
                     if (gen == self->generation_) {
                         QJsonObject back = self->state_[u"form"_s].toObject();
                         back[u"enabled"_s] = true;
                         self->state_[u"form"_s] = back;
                         self->rebuild();
                     }
                     if (self->status_) self->status_->showError(u"没有关掉:"_s + r.error);
                 });
}

void AccessController::saveFollow() {
    const QJsonObject f = state_[u"form"_s].toObject();
    if (f.isEmpty()) return;
    state_[u"checked"_s] = true;
    rebuild();
    const QStringList problems = access::follow::formProblems(f);
    if (!problems.isEmpty()) {
        if (status_)
            status_->showError(u"还不能保存:%1%2"_s.arg(problems.first(), problems.size() > 1 ? u"(另有 %1 处)"_s.arg(problems.size() - 1) : QString()));
        return;
    }
    const QJsonObject next = access::follow::toConfig(f);
    const int gen = generation_;
    QPointer<AccessController> self(this);
    const auto send = [self, gen, next] {
        if (!self || gen != self->generation_) return;
        self->state_[u"busy"_s] = u"save"_s;
        self->rebuild();
        self->bridge_->rpc(self, u"settings.patch"_s, QJsonObject{{u"patch"_s, QJsonObject{{u"follow"_s, next}}}, {u"__confirmed"_s, true}}, [self, gen, next](const EngineReply& r) {
            if (!self) return;
            if (r.ok) {
                if (self->status_) self->status_->showInfo(next[u"enabled"_s].toBool() ? u"已保存:自动跟单开着。"_s : u"已保存:只观察,不发单。"_s);
                if (gen == self->generation_) {
                    self->state_[u"checked"_s] = false;
                    self->loadFollow(true);
                }
            } else if (self->status_) self->status_->showError(u"保存失败(配置未改动):"_s + r.error);
            if (gen != self->generation_) return;
            self->state_[u"busy"_s] = QJsonValue::Null;
            self->rebuild();
        });
    };
    if (!next[u"enabled"_s].toBool()) return send();
    // 从关到开、换频道、多信任一个人、换账户、调大上限、打开成交后自动建追踪(或换它的钟点):要一张确认凭据;只是往紧了改时 Bridge 不弹框、直接回 true
    bridge_->confirm(this, QJsonObject{{u"purpose"_s, u"gate.follow"_s}, {u"binding"_s, next}, {u"title"_s, u"打开 Discord 自动跟单"_s}, {u"message"_s, QString()},
                                       {u"confirmLabel"_s, u"我明白,打开跟单"_s}},
                     [send](bool ok, const QString&) {
                         if (ok) send();
                     });
}

}  // namespace ibkr::shell
