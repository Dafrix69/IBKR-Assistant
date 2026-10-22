#include "shell/status_store.h"

#include <QPointer>

#include "shell/topbar_state.h"
#include "util/redact.h"

#include <utility>

namespace ibkr::shell {

using namespace Qt::StringLiterals;

StatusStore::StatusStore(EngineClient* engine, int pollMs, QObject* parent) : QObject(parent), engine_(engine) {
    poll_.setInterval(pollMs);
    connect(&poll_, &QTimer::timeout, this, [this] { refresh(); });
    infoTimer_.setSingleShot(true);
    infoTimer_.setInterval(6000);
    connect(&infoTimer_, &QTimer::timeout, this, [this] { setBanner({}); });
    connect(engine_, &EngineClient::engineEvent, this, &StatusStore::onEvent);
}

QJsonObject StatusStore::topbar() const { return topbarState(status_, engineOk_); }

void StatusStore::startPolling() {
    if (poll_.isActive()) return;
    refresh();
    poll_.start();
}

void StatusStore::refresh(std::function<void()> done) {
    if (done) waiters_.push_back(std::move(done));
    if (inFlight_) return;
    inFlight_ = true;
    // 回包到时 store 可能已经析构(退出时引擎还在答):带 QPointer,不在了就不碰
    engine_->call(u"system.status"_s, QJsonObject{}, {}, [self = QPointer<StatusStore>(this), this](const EngineReply& reply) {
        if (!self) return;
        inFlight_ = false;
        if (reply.ok) {
            status_ = reply.result.toObject();
            emit statusChanged();
            emit topbarChanged();
            setEngineOk(1);
            announceBreaker(status_);
        } else {
            setEngineOk(0);
            setBanner(u"引擎无响应:%1"_s.arg(reply.error));
        }
        // 等这一次的人:状态落定之后再叫(先换出来,叫的过程中又来的等下一次)
        const std::vector<std::function<void()>> waiters = std::exchange(waiters_, {});
        for (const auto& w : waiters) w();
    });
}

void StatusStore::onEvent(const QString& event, const QJsonValue& data) {
    // broker_link:与 TWS 断开 / 自动连回,顶栏的连接状态当场跟着变
    if (event == u"breaker" || event == u"ready" || event == u"settings" || event == u"pending" || event == u"broker_link") {
        refresh();
    } else if (event == u"error") {
        // 引擎报上来的错(券商掉线、鉴权失效之类)必须落到界面上,不能只留在日志里
        const QString message = data.toObject().value(u"message").toString();
        setBanner(message.isEmpty() ? u"引擎报告了一个错误"_s : message);
    }
}

void StatusStore::announceBreaker(const QJsonObject& next) {
    const QJsonObject breaker = next.value(u"breaker").toObject();
    const bool now = breaker.value(u"engaged").toBool();
    if (now == engaged_) return;
    engaged_ = now;
    if (now) {
        const QString reason = breaker.value(u"reason").toString();
        setBanner(u"已熔断:%1"_s.arg(reason.isEmpty() ? u"自动执行已停止"_s : reason));
    } else {
        setBanner({});
    }
}

void StatusStore::engineExited(const QString& fatalKind, const QString& detail) {
    setEngineOk(0);
    // 配置读不进来 / 交易库打不开不会自动重启(重启也是同一个错):原因留在横幅上
    if (fatalKind == u"config") setBanner(u"配置文件有问题,交易引擎没有启动:%1"_s.arg(detail));
    else if (fatalKind == u"store") setBanner(u"交易库打不开,交易引擎没有启动:%1"_s.arg(detail));
    else setBanner(u"交易引擎已退出:%1。正在自动重启,重启后自动连回券商。"_s.arg(detail));
}

void StatusStore::showBanner(const QString& text) { setBanner(text); }
void StatusStore::hideBanner() { setBanner({}); }
void StatusStore::showInfo(const QString& text) { setBanner(text, true); }

void StatusStore::setEngineOk(int value) {
    if (engineOk_ == value) return;
    engineOk_ = value;
    emit engineOkChanged();
    emit topbarChanged();
}

void StatusStore::setBanner(const QString& text, bool info) {
    const QString masked = util::maskAccountLikeIds(text);
    // 提示类 6 秒自己走,错误类留着;同一条反复来不重发(熔断时每轮状态都会喊一次),但计时照样重起
    if (info && !masked.isEmpty()) infoTimer_.start();
    else infoTimer_.stop();
    if (banner_ == masked && bannerInfo_ == info) return;
    banner_ = masked;
    bannerInfo_ = info;
    emit bannerChanged();
}

}  // namespace ibkr::shell
