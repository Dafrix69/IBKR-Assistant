#include "shell/trade_composer.h"

#include "engine/util/awake_clock.h"
#include "shell/bridge.h"
#include "shell/jsvalue.h"
#include "shell/status_store.h"
#include "shell/trade_rules.h"

#include <QJsonDocument>
#include <QPointer>
#include <QSettings>

#include <cmath>
#include <memory>

namespace ibkr::shell {

using namespace Qt::StringLiterals;

namespace {
// React 版 localStorage 的 dafri-submit-accounts
constexpr auto kPickKey = "trade/accounts";
}  // namespace

TradeComposer::TradeComposer(trade::ComposerDeps deps, QString settingsPath, QObject* parent)
    : QObject(parent), deps_(std::move(deps)), settingsPath_(std::move(settingsPath)) {
    // 只在启动时读一次盘:之后以内存里这一份为准,勾选立刻生效,不受写盘失败影响
    if (!settingsPath_.isEmpty()) {
        const QVariant raw = QSettings(settingsPath_, QSettings::IniFormat).value(QLatin1StringView(kPickKey));
        picked_ = trade::readPicked(raw.isValid() ? std::optional<QString>(raw.toString()) : std::nullopt);
    }
}

TradeComposer::TradeComposer(Bridge* bridge, StatusStore* status, QString settingsPath, QObject* parent)
    : TradeComposer(trade::ComposerDeps{}, std::move(settingsPath), parent) {
    deps_ = bridgeDeps(bridge, status, this);
}

trade::ComposerDeps TradeComposer::bridgeDeps(Bridge* bridge, StatusStore* status, TradeComposer* self) {
    trade::ComposerDeps d;
    QPointer<StatusStore> st(status);
    d.confirm = [bridge, self](const QJsonObject& options, std::function<void(bool)> done) {
        // 确认框没弹成(桥报错)和点了取消一样:什么都不发(React 版这里是一个没人接的 reject,同样什么都不做)
        bridge->confirm(self, options, [done](bool ok, const QString& error) {
            if (!error.isEmpty()) qWarning("确认框没弹成:%s", qPrintable(error));
            done(ok && error.isEmpty());
        });
    };
    d.submit = [bridge, self](const QString& text, bool execute, const QStringList& accounts, trade::ComposerDeps::Reply done) {
        // preload.js 的 submit:__confirmed 只说明调用是从桥上走的,发不发由桥对着确认框发的凭据判
        const QJsonObject params{{u"text"_s, text}, {u"execute"_s, execute}, {u"accounts"_s, QJsonArray::fromStringList(accounts)}, {u"__confirmed"_s, true}};
        bridge->rpc(self, u"instruction.submit"_s, params, done);
    };
    d.reload = [st, self](std::function<void()> done) {
        // Promise.all([refreshStatus(), loadRecords(), loadPending()]):三样都读完才收起转圈
        emit self->submitted();
        auto left = std::make_shared<int>(2);
        const auto one = [left, done] {
            if (--*left == 0) done();
        };
        if (st) st->refresh(one);
        else one();
        if (self && self->reloadOthers) self->reloadOthers(one);
        else one();
    };
    d.banner = [st](const QString& text, bool info) {
        if (!st) return;
        if (info) st->showInfo(text);
        else st->showError(text);
    };
    d.brokerShortName = [st] { return trade::brokerShortName(st ? QJsonValue(st->status()) : QJsonValue()); };
    d.nowMs = [] { return double(util::awakeMicros()) / 1000.0; };
    return d;
}

void TradeComposer::setText(const QString& text) {
    if (text == text_) return;
    text_ = text;
    emit changed();
}

void TradeComposer::setPane(const QString& pane) {
    if (pane == pane_) return;
    pane_ = pane;
    emit changed();
}

void TradeComposer::appendInstruction(const QString& line) { setText(trade::appendInstruction(text_, line)); }

void TradeComposer::clearResult() {
    payload_ = QJsonValue();
    failure_.clear();
    emit changed();
}

void TradeComposer::setDraft(const QString& text) {
    text_ = text;
    payload_ = QJsonValue();
    failure_.clear();
    emit changed();
}

void TradeComposer::submit(bool execute, const QStringList& accounts) {
    const QString body = jsTrim(text_);
    if (body.isEmpty() || !busy_.isEmpty()) return;
    if (accounts.isEmpty()) {
        deps_.banner(u"请至少勾选一个发单账户"_s, false);
        return;
    }
    QPointer<TradeComposer> self(this);
    auto run = [self, body, execute, accounts] {
        if (!self) return;
        // 右栏要是正摆着蝴蝶测算,切回解析结果:点了按钮却看不到结果,会以为没反应
        self->pane_ = u"result"_s;
        self->busy_ = execute ? u"execute"_s : u"parse"_s;
        self->working_ = execute ? u"正在解析并发送…"_s : u"正在解析…(最长约 1 分钟)"_s;
        self->failure_.clear();
        emit self->changed();
        const double t0 = self->deps_.nowMs();
        self->deps_.submit(body, execute, accounts, [self, t0](const EngineReply& reply) {
            if (!self) return;
            const auto finish = [self] {
                if (!self) return;
                self->busy_.clear();
                self->working_.clear();
                emit self->changed();
            };
            if (!reply.ok) {
                self->payload_ = QJsonValue();
                self->failure_ = reply.error;
                emit self->changed();
                return finish();
            }
            QJsonObject payload = reply.result.toObject();
            payload.insert(u"__elapsedMs"_s, jsRound(self->deps_.nowMs() - t0));
            self->payload_ = payload;
            emit self->changed();
            self->deps_.reload(finish);
        });
    };
    if (!execute) return run();
    // 这一步是在授权直接发单,值得一次明确的确认。指令原文、发到哪些账户、各是纸面还是实盘,由桥自己写在确认框上(账户类别它去问引擎);
    // 这里绑的内容(binding)要和 submit 的入参是同一份,对不上桥不放行
    const QJsonObject options{
        {u"purpose"_s, u"instruction.submit"_s},
        {u"binding"_s, QJsonObject{{u"text"_s, body}, {u"accounts"_s, QJsonArray::fromStringList(accounts)}}},
        {u"title"_s, u"发送真实订单"_s},
        {u"message"_s, u"这条指令解析后会直接发送到%1,没有二次确认环节。"_s.arg(deps_.brokerShortName())},
        {u"confirmLabel"_s, u"我确认,发送"_s},
    };
    deps_.confirm(options, [run](bool ok) {
        if (ok) run();
    });
}

void TradeComposer::savePicked(const QStringList& aliases) {
    picked_ = aliases;
    ++pickRevision_;
    emit pickedChanged();
    // 记不住就算了,本次会话仍然按用户勾的来
    if (!settingsPath_.isEmpty())
        QSettings(settingsPath_, QSettings::IniFormat)
            .setValue(QLatin1StringView(kPickKey), QString::fromUtf8(QJsonDocument(QJsonArray::fromStringList(aliases)).toJson(QJsonDocument::Compact)));
}

QStringList TradeComposer::selectedAccounts(const QJsonArray& usable) const { return trade::pickAccounts(usable, picked_); }

QJsonObject TradeComposer::snapshot() const {
    return {
        {u"text"_s, text_},
        {u"pane"_s, pane_},
        {u"busy"_s, busy_.isEmpty() ? QJsonValue() : QJsonValue(busy_)},
        {u"working"_s, working_.isEmpty() ? QJsonValue() : QJsonValue(working_)},
        {u"payload"_s, payload_},
        {u"failure"_s, failure_.isEmpty() ? QJsonValue() : QJsonValue(failure_)},
    };
}

}  // namespace ibkr::shell
