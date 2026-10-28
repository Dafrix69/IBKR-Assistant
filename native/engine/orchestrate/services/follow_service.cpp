#include "orchestrate/services/follow_service.h"

#include "domain/models.h"
#include "domain/positions.h"
#include "execution/auto_mid.h"
#include "execution/broker_pricing.h"
#include "execution/held_streams.h"
#include "execution/ib_types.h"
#include "execution/option_marks.h"
#include "orchestrate/services/svc1_util.h"
#include "parsing/shorthand.h"
#include "util/error.h"
#include "util/jsformat.h"
#include "util/jsvalue.h"
#include "util/protections.h"
#include "util/rpc_error.h"
#include "util/secrets.h"
#include "util/sqlite.h"
#include "util/tz.h"
#include "util/zod.h"

#include <QRegularExpression>
#include <QSet>

#include <algorithm>
#include <cmath>
#include <limits>

namespace ibkr::orchestrate {

using namespace Qt::StringLiterals;
using util::DiscordMessage;
using util::OJson;
using util::Task;
namespace js = util::js;
namespace pf = parsing::follow;
using svc1::excMessage;

namespace {

/// 下场是这几种的信号才记盘口:解析出了恰好一张写明价格的单。没接住的、太旧的没有可比的价
bool quotedOutcome(const QString& outcome) {
    return outcome == u"sent" || outcome == u"held" || outcome == u"observed" || outcome == u"capped" || outcome == u"blocked" || outcome == u"rejected";
}

QString outcomeLabel(const QString& outcome) {
    if (outcome == u"sent") return u"已跟单"_s;
    if (outcome == u"held") return u"没有发出"_s;
    if (outcome == u"observed") return u"只观察"_s;
    if (outcome == u"stale") return u"太旧,没跟"_s;
    if (outcome == u"unparsed") return u"没接住,没跟"_s;
    if (outcome == u"capped") return u"超上限,没跟"_s;
    if (outcome == u"blocked") return u"闸门关着,没跟"_s;
    return u"被拒"_s;  // rejected
}

/// 不建追踪的几种下场各说什么(空串 = 不提醒:单子没成交,本来就没有持仓)
QString dropText(const QString& verdict) {
    if (verdict == u"unfilled") return {};
    if (verdict == u"expired") return u"隔了一天仍没有等到这张单的成交回报,不再等;它之后成交的话不会自动建追踪,请自己到「持仓追踪」里设"_s;
    if (verdict == u"covered") return u"这份持仓已经有一条在盯的追踪,没有另建:同一份持仓只能有一条,加进来的数量由它按触发那一刻的持仓一起平"_s;
    if (verdict == u"idle_track") {
        return u"同一份持仓上留着一条已停用(或已触发过)的旧追踪,同一份持仓只能有一条,软件不替你删。这一单现在没有追踪在盯:"
               u"请到「持仓追踪」删掉旧的再建,或重新启用它"_s;
    }
    if (verdict == u"no_position") return u"这张单成交了,但持仓里找不到这份组合(已经平掉了,或者它的腿和同一到期日的别的持仓并在了一起),没有建追踪,请自己到「持仓追踪」里看"_s;
    return {};  // DROP_TEXT[verdict] 对别的值得 undefined,在 TS 里 `if (why)` 为假
}

/// 速记产出里那张单的标的;形状不对回空
std::optional<QString> parsedSymbol(const OJson& payload) {
    if (payload.type != OJson::Object) return std::nullopt;
    const OJson* orders = payload.get(u"orders"_s);
    if (!js::isArr(orders) || orders->items.size() != 1) return std::nullopt;
    const OJson* sym = js::path(&orders->items[0], {u"contract"_s, u"symbol"_s});
    if (js::isStr(sym) && !sym->s.isEmpty()) return sym->s;
    return std::nullopt;
}

/// 一条交易记录(或速记产出里的一张单)里的合约与对方写的价;不是跟单认的那两种、形状不对回空
struct SignalOf {
    OJson contract;
    pf::LeaderPrice leader;
};
std::optional<SignalOf> signalOf(const OJson& item) {
    if (item.type != OJson::Object) return std::nullopt;
    const OJson* c = item.get(u"contract"_s);
    const OJson* o = item.get(u"order"_s);
    const auto contract = util::zod::safeParse(domain::models::contractSpecSchema(), c);
    const auto order = util::zod::safeParse(domain::models::orderSpecSchema(), o);
    if (!contract.success || !order.success) return std::nullopt;
    const auto leader = pf::leaderPrice(contract.data ? *contract.data : OJson(), order.data ? *order.data : OJson());
    if (!leader) return std::nullopt;
    return SignalOf{contract.data ? *contract.data : OJson(), *leader};
}

/// 记录读不到(库被换了)按"走完了、没成交"算:没有可等的
struct Facts {
    bool filled = false, final_ = false;
    double fills = 0;
};
Facts orderFacts(const std::optional<OJson>& record) {
    if (!record || record->type != OJson::Object) return {false, true, 0};
    const OJson* status = record->get(u"final_status"_s);
    const OJson* ibkr = record->get(u"ibkr"_s);
    const OJson* fillsV = js::prop(ibkr, u"fills"_s);
    const double fills = js::isArr(fillsV) ? double(fillsV->items.size()) : 0;
    const OJson* tl = js::prop(ibkr, u"status_timeline"_s);
    bool reported = false;
    if (js::isArr(tl)) {
        for (const OJson& row : tl->items) {
            if (row.type == OJson::Object) {
                const OJson* s = row.get(u"status"_s);
                if (js::isStr(s) && s->s == u"Filled") {
                    reported = true;
                    break;
                }
            }
        }
    }
    const bool statusStr = js::isStr(status);
    return {fills > 0 || reported || (statusStr && (status->s == u"filled" || status->s == u"partially_filled")), statusStr && !status->s.isEmpty(), fills};
}

/// 异常的第一行(TS 的 err.stack 第一行 "<类名>: <话>";C++ 没有栈)
QString errHeader(std::exception_ptr e) {
    QString name = u"Error"_s;
    try {
        std::rethrow_exception(e);
    } catch (const util::sqlite::SqliteError&) {
        name = u"SqliteError"_s;
    } catch (...) {
    }
    return name + u": "_s + excMessage(e);
}

bool isBrokerLike(std::exception_ptr e) {
    try {
        std::rethrow_exception(e);
    } catch (const execution::BrokerError&) {
        return true;
    } catch (const execution::OptionMarksError&) {
        return true;
    } catch (...) {
        return false;
    }
}

// ---------------------------------------------------------------- 真的来源
class RealGateway : public GatewayLike {
public:
    RealGateway(const QString& token, util::GatewayHooks hooks, util::GatewayOptions options) : gw_(token, std::move(hooks), std::move(options)) {}
    void start() override { gw_.start(); }
    void stop() override { gw_.stop(); }
    std::optional<QString> bot() const override { return gw_.bot; }
    bool guildsSeen() const override { return gw_.guildsSeen; }
    bool hasChannel(const QString& id) const override { return gw_.channels.contains(id); }

private:
    util::DiscordGateway gw_;
};

DiscordMessage messageOf(const OJson& m) {
    DiscordMessage out;
    out.id = js::str(m.get(u"id"_s));
    out.channel_id = js::str(m.get(u"channel_id"_s));
    out.author_id = js::str(m.get(u"author_id"_s));
    out.author_name = js::str(m.get(u"author_name"_s));
    out.content = js::str(m.get(u"content"_s));
    out.sentAtMs = js::num(m.get(u"sentAtMs"_s));
    return out;
}

/// 「频道里最近的消息」的一行
OJson seenRow(const DiscordMessage& message, bool trusted) {
    return js::object({{u"at"_s, js::S(util::utcIso(std::floor(message.sentAtMs / 1000) * 1000))},
                       {u"source"_s, js::S(message.channel_id == domain::kLocalChannel ? u"local"_s : u"discord"_s)},
                       {u"author_id"_s, js::S(message.author_id)},
                       {u"author_name"_s, js::S(message.author_name.left(80))},
                       {u"text"_s, js::S(message.content.left(domain::kFollowTextMax))},
                       {u"trusted"_s, js::B(trusted)}});
}

class RealInbox : public InboxLike {
public:
    RealInbox(const QString& path, InboxHooks hooks, int intervalMs)
        : inbox_(path, {[h = hooks](const OJson& m) { if (h.onMessage) h.onMessage(messageOf(m)); }, hooks.onError}, intervalMs) {}
    QString path() const override { return inbox_.path(); }
    bool watching() const override { return inbox_.watching(); }
    std::optional<QString> lastAt() const override { return inbox_.lastAt; }
    double received() const override { return inbox_.received; }
    std::optional<QString> error() const override { return inbox_.error(); }
    void start() override { inbox_.start(); }
    void stop() override { inbox_.stop(); }
    void poll() override { inbox_.poll(); }

private:
    domain::FollowInbox inbox_;
};

class RealReader : public ReaderLike {
public:
    RealReader(const QString& program, const QString& channel, const QString& out, std::function<void(const domain::ReaderStatus&)> onStatus)
        : reader_(program, channel, out, std::move(onStatus)) {}
    QString program() const override { return reader_.program; }
    QString channel() const override { return reader_.channel; }
    QString out() const override { return reader_.out; }
    domain::ReaderStatus view() const override { return reader_.view(); }
    void start() override { reader_.start(); }
    void stop() override { reader_.stop(); }

private:
    domain::FollowReader reader_;
};

}  // namespace

FollowService::FollowService(Svc1Host& host) : Svc1Base(host) {
    sources.gateway = [this](const QString& token, util::GatewayHooks hooks) -> std::unique_ptr<GatewayLike> {
        return std::make_unique<RealGateway>(token, std::move(hooks), gatewayOptions);
    };
    sources.inbox = [this](const QString& path, InboxHooks hooks) -> std::unique_ptr<InboxLike> {
        return std::make_unique<RealInbox>(path, std::move(hooks), inboxIntervalMs);
    };
    sources.reader = [](const QString& program, const QString& channel, const QString& out, std::function<void(const domain::ReaderStatus&)> onStatus) -> std::unique_ptr<ReaderLike> {
        return std::make_unique<RealReader>(program, channel, out, std::move(onStatus));
    };
    sources.readerProgram = [] { return domain::readerProgram(); };
    sources.secretExists = [](QString service, QString account) { return util::secretExists(std::move(service), std::move(account)); };
    sources.readSecret = [](QString service, QString account) { return util::readSecret(std::move(service), std::move(account)); };
    sources.writeSecret = [](QString service, QString account, QString secret) { return util::writeSecret(std::move(service), std::move(account), std::move(secret)); };
}

// ---------------------------------------------------------------- 连接的起停
void FollowService::start() {
    started_ = true;
    // JS 里 `void this.sync()` 的 syncOnce 在 start() 返回之后(下一个微任务)才跑,定时器是 start() 里同步设的:先设定时器、再 sync,可观察的次序才一样
    // 上次退出时还在等成交的蝴蝶存在库里:起来之后接着核对(没有在等的,这一轮之后就不再跑)
    armTrackTimer();
    util::detach(sync());
}

void FollowService::stop() {
    started_ = false;
    dropGateway();
    dropInbox();
    dropReader();
    if (trackTimer_ != 0) rt().clearTimeout(trackTimer_);
    trackTimer_ = 0;
}

Task<> FollowService::sync(bool restart) {
    syncChain_ = syncStep(syncChain_, restart);
    return syncChain_;
}

Task<> FollowService::syncStep(Task<> prev, bool restart) {
    co_await prev;
    std::exception_ptr failure;
    try {
        co_await syncOnce(restart);
    } catch (...) {
        failure = std::current_exception();
    }
    if (failure) {
        LinkPatch p;
        p.state = u"failed"_s;
        p.hasError = true;
        p.error = u"跟单连接没有起来:"_s + excMessage(failure);
        setLink(p);
    }
}

Task<> FollowService::syncOnce(bool restart) {
    if (!started_) co_return;
    syncInbox();
    syncReader();
    if (settings().follow.channel_id.isEmpty()) {
        dropGateway();
        LinkPatch p;
        p.state = u"off"_s;
        p.hasBot = p.hasError = true;
        setLink(p);
        co_return;
    }
    if (gateway_ && !restart) co_return;
    dropGateway();
    if (!(co_await sources.secretExists(kFollowKeychainService, kFollowKeychainAccount))) {
        LinkPatch p;
        p.state = u"no_token"_s;
        p.hasBot = p.hasError = true;
        setLink(p);
        co_return;
    }
    // 取 token 可能弹系统对话框问人(secrets 有时限);超时与被拒都是一句人话,原样给界面
    const std::optional<QString> token = co_await sources.readSecret(kFollowKeychainService, kFollowKeychainAccount);
    if (!started_ || settings().follow.channel_id.isEmpty()) co_return;
    if (!token || token->isEmpty()) {
        LinkPatch p;
        p.state = u"no_token"_s;
        p.hasBot = p.hasError = true;
        setLink(p);
        co_return;
    }
    const quint64 id = ++gatewayGen_;
    util::GatewayHooks hooks;
    hooks.onMessage = [this, id](const DiscordMessage& message) {
        if (gatewayId_ == id) util::detach(onMessage(message));
    };
    hooks.onPhase = [this, id](util::GatewayPhase phase, const std::optional<QString>& error) {
        if (gatewayId_ == id) onPhase(phase, error);
    };
    gateway_ = sources.gateway(*token, std::move(hooks));
    gatewayId_ = id;
    gateway_->start();
}

void FollowService::dropGateway() {
    std::unique_ptr<GatewayLike> old = std::move(gateway_);
    gatewayId_ = 0;
    if (old) old->stop();
}

/// 本地收件:开着就盯文件(路径跟着交易库走),关了就停。和 Discord 连接互不影响
void FollowService::syncInbox() {
    const std::optional<QString> want = settings().follow.local_inbox ? std::optional<QString>(domain::inboxPath(settings().db_path)) : std::nullopt;
    if (inbox_ && want && inbox_->path() == *want) return;
    dropInbox();
    if (!want) return;
    const quint64 id = ++inboxGen_;
    InboxHooks hooks;
    hooks.onMessage = [this, id](const DiscordMessage& message) {
        if (inboxId_ == id) util::detach(onMessage(message));
    };
    hooks.onError = [this, id](const QString& error) {
        if (inboxId_ != id) return;
        log(u"[follow] 本地收件:"_s + error);
        emitEvent(u"follow"_s, js::object({{u"kind"_s, js::S(u"inbox"_s)}}));
    };
    inbox_ = sources.inbox(*want, std::move(hooks));
    inboxId_ = id;
    inbox_->start();
    emitEvent(u"follow"_s, js::object({{u"kind"_s, js::S(u"inbox"_s)}}));
}

void FollowService::dropInbox() {
    std::unique_ptr<InboxLike> old = std::move(inbox_);
    inboxId_ = 0;
    if (old) old->stop();
}

/// 读窗口的程序:本地收件开着、填了频道名、这台机器上有这个程序,就拉起来看着;频道名或收件文件换了就换一个
void FollowService::syncReader() {
    const contract::FollowConfig& cfg = settings().follow;
    const std::optional<QString> program = (cfg.local_inbox && !cfg.local_channel.isEmpty()) ? readerProgramPath() : std::nullopt;
    const QString out = domain::inboxPath(settings().db_path);
    if (reader_ && program && reader_->program() == *program && reader_->channel() == cfg.local_channel && reader_->out() == out) return;
    dropReader();
    if (!program) return;
    const quint64 id = ++readerGen_;
    reader_ = sources.reader(*program, cfg.local_channel, out, [this, id](const domain::ReaderStatus&) {
        if (readerId_ == id) emitEvent(u"follow"_s, js::object({{u"kind"_s, js::S(u"inbox"_s)}}));
    });
    readerId_ = id;
    reader_->start();
    emitEvent(u"follow"_s, js::object({{u"kind"_s, js::S(u"inbox"_s)}}));
}

void FollowService::dropReader() {
    std::unique_ptr<ReaderLike> old = std::move(reader_);
    readerId_ = 0;
    if (old) old->stop();
}

std::optional<QString> FollowService::readerProgramPath() { return sources.readerProgram(); }

OJson FollowService::readerView() {
    const contract::FollowConfig& cfg = settings().follow;
    const auto view = [](const QString& state, const std::optional<QString>& title, const std::optional<QString>& error) {
        return js::object({{u"state"_s, js::S(state)}, {u"title"_s, title ? js::S(*title) : js::Null()}, {u"error"_s, error ? js::S(*error) : js::Null()}});
    };
    if (!cfg.local_inbox) return view(u"off"_s, std::nullopt, std::nullopt);
    if (cfg.local_channel.isEmpty()) return view(u"no_channel"_s, std::nullopt, std::nullopt);
    if (reader_) {
        const domain::ReaderStatus v = reader_->view();
        return view(v.state, v.title, v.error);
    }
    // 引擎还没真正起来(started 之前)也落在这里:说"还在起"不如照实说有没有这个程序
    return view(readerProgramPath() ? u"starting"_s : u"unavailable"_s, std::nullopt, std::nullopt);
}

OJson FollowService::inboxView() {
    return js::object({{u"enabled"_s, js::B(settings().follow.local_inbox)},
                       {u"path"_s, js::S(domain::inboxPath(settings().db_path))},
                       {u"watching"_s, js::B(inbox_ && inbox_->watching())},
                       {u"last_at"_s, (inbox_ && inbox_->lastAt()) ? js::S(*inbox_->lastAt()) : js::Null()},
                       {u"received"_s, js::N(inbox_ ? inbox_->received() : 0)},
                       {u"error"_s, (inbox_ && inbox_->error()) ? js::S(*inbox_->error()) : js::Null()},
                       {u"reader"_s, readerView()}});
}

Task<> FollowService::pollInbox() {
    if (inbox_) inbox_->poll();
    return chain_;
}

Task<> FollowService::settled() {
    co_await chain_;
    while (!background_.empty()) {
        const auto now = background_;
        for (const auto& entry : now) co_await entry.second;
    }
}

void FollowService::onPhase(util::GatewayPhase phase, const std::optional<QString>& error) {
    if (phase == util::GatewayPhase::Stopped) return;
    LinkPatch p;
    if (phase == util::GatewayPhase::Ready) {
        p.state = u"ready"_s;
        p.hasBot = p.hasError = true;
        p.bot = gateway_ ? gateway_->bot() : std::nullopt;
        setLink(p);
        return;
    }
    if (phase == util::GatewayPhase::Failed) {
        p.state = u"failed"_s;
        p.hasError = true;
        p.error = error;
        setLink(p);
        // 连不上了而且不会自己好:人不在这一页也得知道
        notify(u"Discord 跟单停了"_s, error ? *error : u"连接失败"_s);
        return;
    }
    // 重连途中留着上一次的问题说明,连上了才清
    p.state = u"connecting"_s;
    p.hasError = true;
    p.error = error ? error : link_.error;
    setLink(p);
}

void FollowService::setLink(const LinkPatch& patch) {
    Link next = link_;
    if (patch.state) next.state = *patch.state;
    if (patch.hasBot) next.bot = patch.bot;
    if (patch.hasError) next.error = patch.error;
    const bool changed = next.state != link_.state || next.error != link_.error || next.bot != link_.bot;
    link_ = next;
    if (changed) emitEvent(u"follow"_s, js::object({{u"kind"_s, js::S(u"link"_s)}, {u"link"_s, linkView()}}));
}

OJson FollowService::linkView() {
    const QString channel = settings().follow.channel_id;
    OJson known = js::Null();
    if (gateway_ && link_.state == u"ready" && gateway_->guildsSeen()) known = js::B(gateway_->hasChannel(channel));
    return js::object({{u"state"_s, js::S(link_.state)},
                       {u"bot"_s, link_.bot ? js::S(*link_.bot) : js::Null()},
                       {u"error"_s, link_.error ? js::S(*link_.error) : js::Null()},
                       {u"channel_known"_s, known}});
}

// ---------------------------------------------------------------- token
Task<> FollowService::setToken(QString token) {
    co_await sources.writeSecret(kFollowKeychainService, kFollowKeychainAccount, token);
    const OJson detail = js::object({{u"service"_s, js::S(kFollowKeychainService)}});
    store().audit(u"ui"_s, u"follow_token_set"_s, &detail);
    co_await sync(true);
}

// ---------------------------------------------------------------- 一条消息
Task<> FollowService::onMessage(DiscordMessage message) {
    const contract::FollowConfig& cfg = settings().follow;
    const pf::Triage verdict = pf::triage(cfg, pf::FollowMessage{message.channel_id, message.author_id, message.content, message.sentAtMs}, domain::nowEt().epochMs);
    if (verdict.kind == u"other_channel") return Task<>::resolved();
    remember(message);
    if (verdict.kind == u"untrusted" || verdict.kind == u"chatter") return Task<>::resolved();
    // 已经在处理(或处理过)的同一条:不再处理,只把队列交回去,等的人等到它走完
    if (handled_.contains(message.id)) return chain_;
    handled_.insert(message.id);
    handledOrder_.push_back(message.id);
    if (handled_.size() > kHandledMax) {
        // this.handled.delete(this.handled.values().next().value ?? ""):最早插进去的那个
        handled_.remove(handledOrder_.front());
        handledOrder_.pop_front();
    }
    const std::optional<QString> stale = verdict.kind == u"stale" ? std::optional<QString>(verdict.detail) : std::nullopt;
    chain_ = chainStep(chain_, std::move(message), stale);
    return chain_;
}

Task<> FollowService::chainStep(Task<> prev, DiscordMessage message, std::optional<QString> stale) {
    co_await prev;
    std::exception_ptr failure;
    try {
        co_await process(message, stale);
    } catch (...) {
        failure = std::current_exception();
    }
    if (failure) log(u"[follow] 处理消息 %1 出错:%2"_s.arg(message.id, errHeader(failure)));
}

void FollowService::remember(const DiscordMessage& message) {
    const contract::FollowConfig& cfg = settings().follow;
    const bool trusted = cfg.author_ids.contains(message.author_id);
    seen_.prepend(seenRow(message, trusted));
    while (seen_.size() > kSeenMax) seen_.removeLast();
    emitEvent(u"follow"_s, js::object({{u"kind"_s, js::S(u"seen"_s)}}));
    if (onSeen) onSeen(message, trusted);
}

Task<> FollowService::process(DiscordMessage message, std::optional<QString> stale) {
    domain::TradeStore& st = store();
    if (st.follow().has(message.id)) co_return;
    // 摘掉 @everyone 这类提及再解析;交给引擎的也是这一份,日志里记原文。
    // 价差消息里的「站稳 / 跌破 N 止损」也摘掉:速记不认止损,这一句由成交后建的追踪来执行
    const pf::StopClause stopClause = pf::takeStopClause(pf::orderText(message.content));
    const QString text = stopClause.text;
    if (stale) {
        conclude(message, Result{u"stale"_s, *stale, QString(), {}}, OJson::null(), js::array());
        co_return;
    }

    const contract::FollowConfig cfg = settings().follow;
    const domain::EtNow at = domain::nowEt();
    PriceSnap snap = js::object();
    parsing::shorthand::ShorthandMeta meta;
    meta.relativeCenter = false;
    const OJson payload = co_await eng().tryLocalShorthand(text, snap, at, meta);
    // 「N蝴蝶」是"现价的百位 + N":现价在两个百位之间时说不清是哪个。手动下单有人看摘要,跟单没有——不跟。
    // 放在判定之前:只观察时也要照实说"这条跟不了",不能记成"只观察"让人以为打开之后会跟上
    std::optional<pf::CenterProblem> edge;
    if (meta.relativeCenter) {
        const std::optional<QString> sym = parsedSymbol(payload);
        const OJson* px = snap.get(sym ? *sym : QString());
        edge = pf::relativeCenterProblem(payload, px ? js::num(px) : std::nan(""));
    }
    if (edge) {
        conclude(message, Result{u"unparsed"_s, edge->detail, edge->summary, {}}, OJson::null(), js::array());
        co_return;
    }
    const auto router = routerPort();
    const BreakerView breaker = eng().breaker();
    pf::FollowGates gates;
    if (breaker.engaged) gates.breaker = breaker.reason;
    gates.connected = router && router->hasSessions();
    const pf::Decision decision = pf::decide(cfg, payload, gates, sentToday());
    if (decision.outcome != u"send") {
        // 整句没接住时,说得出差的是哪一样就说(没写方向的价差);说不出就用通用的那句
        QString detail = decision.detail;
        if (payload.type == OJson::Null) {
            const auto why = pf::whyUnparsed(text);
            if (why) detail = *why;
        }
        conclude(message, Result{decision.outcome, detail, decision.summary, {}}, payload, js::array());
        co_return;
    }

    QStringList accounts;
    std::exception_ptr fanoutFailure;
    try {
        accounts = eng().resolveFanoutAccounts(settings(), cfg.accounts);
    } catch (...) {
        fanoutFailure = std::current_exception();
    }
    if (fanoutFailure) {
        conclude(message, Result{u"blocked"_s, excMessage(fanoutFailure), decision.summary, {}}, payload, js::array());
        co_return;
    }
    // 这一遍必须拿到了标的现价:速记靠它核对"中心离现价太远 = 多半写错了",手动下单时这一步有人看着,跟单没有
    const std::optional<QString> symbol = parsedSymbol(payload);
    if (!symbol || !snap.get(*symbol)) {
        {
            Result r{u"unparsed"_s, u"拿不到这张单的标的现价,没法核对中心与方向,没有发单"_s, decision.summary, {}};
            r.detailLast = true;  // TS 的字面量键序:outcome, summary, record_ids, detail
            conclude(message, r, OJson::null(), js::array());
        }
        co_return;
    }

    if (stopClause.level) {
        static const QRegularExpression bull(u"bull\\s*put"_s, QRegularExpression::CaseInsensitiveOption);
        const OJson* px = snap.get(*symbol);
        spreadStops_.insert(message.id, pf::resolveSpreadStop(*stopClause.level, bull.match(text).hasMatch(),
                                                              js::isNum(px) ? std::optional(px->n) : std::nullopt));
    }

    OJson result;
    std::exception_ptr failure;
    try {
        // 同一句话、同一个时刻、同一份现价交给引擎:它那一遍本地解析通常得出同一张单。引擎只保留它自己从这句话里抽出来的标的的现价,
        // 别的会重取——所以两遍之间现价可能差一点,以引擎那一遍为准,摘要也取它的。引擎现取:解析那一下配置可能重载过
        // **C++ 与 TS 不同(用户 2026-10 决定)**:try 只罩发单本身(下面这一句)。引擎一返回,单子就发出去了,后面任何一步出错
        // 都不许把它改记成「被拒:发单过程出错」(TS 里后面的步骤也在这个 try 里)
        result = co_await eng().handleInstruction(text, u"discord"_s, at, snap, accounts, false, InstructionScope{true});
    } catch (...) {
        failure = std::current_exception();
    }
    if (!failure) {
        postSubmit(message, result, payload, decision.summary);
        co_return;
    }
    bool localOnly = false;
    try {
        std::rethrow_exception(failure);
    } catch (const FollowLocalOnlyError&) {
        localOnly = true;
    } catch (...) {
    }
    const QString detail = localOnly ? excMessage(failure) : u"发单过程出错:"_s + excMessage(failure);
    conclude(message, Result{localOnly ? u"unparsed"_s : u"rejected"_s, detail, decision.summary, {}}, payload, js::array());
}

/// 发单之后的警告:不改单子的下场,只落 stderr 与审计(审计写不进去就只剩 stderr)
void FollowService::postWarn(const DiscordMessage& message, const QString& step, std::exception_ptr error) {
    const QString text = excMessage(error);
    log(u"[follow] 发单之后的步骤出错(单子已发出,下场不改):%1:%2"_s.arg(step, text));
    try {
        const OJson detail = js::object({{u"message"_s, js::S(message.id)}, {u"step"_s, js::S(step)}, {u"error"_s, js::S(text.left(300))}});
        store().audit(u"engine"_s, u"follow_post_submit_error"_s, &detail);
    } catch (...) {
    }
}

/// 引擎已经返回之后的全部步骤。每一步各自兜住:出错记警告,继续做还做得了的;单子的下场(已跟单)不会因此变成「被拒」
void FollowService::postSubmit(const DiscordMessage& message, const OJson& result, const OJson& payload, const QString& decisionSummary) {
    const OJson* submittedP = result.get(u"submitted"_s);
    const OJson submitted = submittedP ? *submittedP : js::array();
    try {
        const OJson* llm = result.get(u"llm"_s);
        if (!llm) throw util::JsError(u"Cannot read properties of undefined (reading 'model')"_s);  // TS 在这里抛、并把单子记成被拒;C++ 只记警告
        if (llm->type != OJson::Null) {
            const OJson* model = js::propStrict(llm, u"model"_s);
            if (!(js::isStr(model) && model->s == parsing::shorthand::kLocalModel)) {
                // 不该发生(出口那道闸会先拒):发生了就留痕
                const OJson detail = js::object({{u"message"_s, js::S(message.id)}, {u"model"_s, js::copyOrNull(model)}});
                store().audit(u"engine"_s, u"follow_model_used"_s, &detail);
            }
        }
    } catch (...) {
        postWarn(message, u"llm"_s, std::current_exception());
    }
    Result r;
    try {
        const OJson* queued = result.get(u"queued"_s);
        const OJson* validated = result.get(u"validated_only"_s);
        const OJson* placed = nullptr;
        for (const OJson* bucket : {submittedP, queued, validated}) {
            if (js::isArr(bucket) && !bucket->items.isEmpty()) {
                placed = &bucket->items.first();
                break;
            }
        }
        const pf::OutcomeResult o = pf::outcomeOf(result);
        const OJson* summary = placed ? js::prop(placed, u"intent_summary"_s) : nullptr;
        r = Result{o.outcome, o.detail, js::nullish(summary) ? decisionSummary : js::str(summary), o.record_ids, true};
    } catch (...) {
        postWarn(message, u"outcome"_s, std::current_exception());
        QStringList ids;
        if (js::isArr(submittedP)) {
            for (const OJson& o : submittedP->items) {
                if (o.type == OJson::Object) ids.append(js::str(o.get(u"record_id"_s)));
            }
        }
        r = Result{u"sent"_s, u"已发出(结果解析出错,详见审计 follow_post_submit_error)"_s, decisionSummary, ids, true};
    }
    try {
        conclude(message, r, payload, submitted, true);
    } catch (...) {
        postWarn(message, u"conclude"_s, std::current_exception());
        // 日志行没落下的再试一次最简的;还不行就只剩警告(进程内的去重表已经记了这条消息,不会再处理第二遍)
        try {
            if (!store().follow().has(message.id)) finish(message, r, true);
        } catch (...) {
        }
    }
}

/// 一条信号的收尾:落日志、发通知(finish),然后两件"之后的事"——发出去的蝴蝶登记成"等成交之后建追踪"(track_fly 开着时),以及在后台记一次盘口
void FollowService::conclude(const DiscordMessage& message, Result result, const OJson& payload, const OJson& submitted, bool postSubmit) {
    // 这两件事出了错只落一行日志:单子的下场已经定了,不能因为它们把一张发出去的单记成"出错"
    std::optional<TrackPlan> tracking;
    // 价差的止损线只在发出去时用得上;别的下场也在这里取走,不留在表里
    const pf::SpreadStop stop = spreadStops_.take(message.id);
    if (result.outcome == u"sent") {
        try {
            tracking = trackPlan(message, submitted, stop);
        } catch (...) {
            log(u"[follow] 登记待建的追踪出错(不影响这条信号的下场):"_s + excMessage(std::current_exception()));
        }
    }
    if (tracking) result.detail = result.detail + u";"_s + tracking->note;
    const std::optional<OJson> entry = finish(message, result, postSubmit);
    if (!entry) return;
    if (tracking && !tracking->items.empty()) {
        try {
            std::vector<pf::PendingTrack> all = pendingList();
            all.insert(all.end(), tracking->items.begin(), tracking->items.end());
            savePending(all);
            armTrackTimer();
        } catch (...) {
            log(u"[follow] 登记待建的追踪出错(不影响这条信号的下场):"_s + excMessage(std::current_exception()));
        }
    }
    if (!quotedOutcome(js::str(entry->get(u"outcome"_s)))) return;
    std::optional<Signal> signal;
    try {
        QStringList ids;
        if (const OJson* r = entry->get(u"record_ids"_s)) {
            for (const OJson& x : r->items) ids.append(js::str(&x));
        }
        signal = signalFor(ids, payload);
    } catch (...) {
        log(u"[follow] 记盘口出错(不影响这条信号的下场):"_s + excMessage(std::current_exception()));
    }
    if (signal) later(recordQuote(message, *signal));
}

std::optional<OJson> FollowService::finish(const DiscordMessage& message, const Result& result, bool postSubmit) {
    OJson entry = js::object({{u"at"_s, js::S(util::utcIso(std::floor(domain::nowEt().epochMs / 1000) * 1000))},
                              {u"message_id"_s, js::S(message.id)},
                              {u"author_id"_s, js::S(message.author_id)},
                              {u"author_name"_s, js::S(message.author_name.left(80))},
                              {u"text"_s, js::S(message.content.left(domain::kFollowTextMax))}});
    const OJson ids = js::strings(result.recordIds);
    if (result.detailLast) {
        entry.set(u"outcome"_s, js::S(result.outcome));
        entry.set(u"summary"_s, js::S(result.summary));
        entry.set(u"record_ids"_s, ids);
        entry.set(u"detail"_s, js::S(result.detail));
    } else if (result.summaryLast) {
        entry.set(u"outcome"_s, js::S(result.outcome));
        entry.set(u"detail"_s, js::S(result.detail));
        entry.set(u"record_ids"_s, ids);
        entry.set(u"summary"_s, js::S(result.summary));
    } else {
        entry.set(u"outcome"_s, js::S(result.outcome));
        entry.set(u"detail"_s, js::S(result.detail));
        entry.set(u"summary"_s, js::S(result.summary));
        entry.set(u"record_ids"_s, ids);
    }
    domain::TradeStore& st = store();
    if (!st.follow().add(entry)) return std::nullopt;
    const OJson auditDetail = js::object({{u"message"_s, *entry.get(u"message_id"_s)},
                                          {u"author"_s, *entry.get(u"author_id"_s)},
                                          {u"outcome"_s, *entry.get(u"outcome"_s)},
                                          {u"records"_s, *entry.get(u"record_ids"_s)}});
    // 发单之后的收尾:日志行已经落下,审计与事件出错只记警告,后面的通知、登记追踪照做
    const auto guarded = [&](const char16_t* step, const std::function<void()>& fn) {
        if (!postSubmit) return fn();
        try {
            fn();
        } catch (...) {
            postWarn(message, QString::fromUtf16(step), std::current_exception());
        }
    };
    guarded(u"audit", [&] { st.audit(u"engine"_s, u"follow_signal"_s, &auditDetail); });
    guarded(u"emit", [&] { emitEvent(u"follow"_s, js::object({{u"kind"_s, js::S(u"signal"_s)}, {u"entry"_s, entry}})); });
    const QString summary = js::str(entry.get(u"summary"_s)), text = js::str(entry.get(u"text"_s)), detail = js::str(entry.get(u"detail"_s));
    notify(u"Discord 跟单:"_s + outcomeLabel(result.outcome), (summary.isEmpty() ? text : summary) + (detail.isEmpty() ? QString() : u" —— "_s + detail),
           js::str(entry.get(u"author_name"_s)));
    return entry;
}

void FollowService::notify(const QString& title, const QString& body, const QString& subtitle) {
    try {
        eng().notify(title, body, subtitle, true);
    } catch (...) {
        /* 通知发不出去不该影响跟单本身 */
    }
}

/// 今天(美东)已经跟了几单:从日志里数,引擎重建、软件重启都不归零
double FollowService::sentToday() { return store().follow().sentSince(util::utcIso(util::etDayStart(domain::nowEt().epochMs))); }

// ---------------------------------------------------------------- 状态
Task<OJson> FollowService::status() {
    const contract::FollowConfig cfg = settings().follow;
    OJson config = js::object({{u"enabled"_s, js::B(cfg.enabled)},
                               {u"channel_id"_s, js::S(cfg.channel_id)},
                               {u"author_ids"_s, js::strings(cfg.author_ids)},
                               {u"accounts"_s, js::strings(cfg.accounts)},
                               {u"max_age_seconds"_s, js::N(cfg.max_age_seconds)},
                               {u"max_orders_per_day"_s, js::N(cfg.max_orders_per_day)},
                               {u"max_risk_usd"_s, js::N(cfg.max_risk_usd)},
                               {u"local_inbox"_s, js::B(cfg.local_inbox)},
                               {u"local_channel"_s, js::S(cfg.local_channel)},
                               {u"track_fly"_s, js::B(cfg.track_fly)},
                               {u"track_exit_at"_s, js::S(cfg.track_exit_at)}});
    const bool configured = co_await sources.secretExists(kFollowKeychainService, kFollowKeychainAccount);
    OJson link = linkView();
    const OJson today = js::object({{u"sent"_s, js::N(sentToday())}, {u"max"_s, js::N(cfg.max_orders_per_day)}});
    const OJson recent = js::array(store().follow().recent(30));
    OJson seen = js::array();
    QSet<QString> listed;
    const auto keyOf = [](const OJson& row) {
        return js::str(row.get(u"author_id"_s)) + u'\n' + js::str(row.get(u"at"_s)) + u'\n' + js::str(row.get(u"text"_s));
    };
    for (const OJson& s : seen_) {
        OJson row = s;
        row.set(u"trusted"_s, js::B(cfg.author_ids.contains(js::str(s.get(u"author_id"_s)))));
        listed.insert(keyOf(row));
        seen.items.append(row);
    }
    // 收件文件里已有的(这次启动之前收到的、本地收件关着时脚本抄进来的):照样列出来,标 history,不判定、不发单;
    // 这次已经看见过的同一条只列一次。按时刻新的在前,总数仍是 kSeenMax
    bool fromFile = false;
    for (const OJson& m : domain::readInboxTail(domain::inboxPath(settings().db_path), kSeenMax)) {
        const DiscordMessage message = messageOf(m);
        OJson row = seenRow(message, cfg.author_ids.contains(message.author_id));
        if (listed.contains(keyOf(row))) continue;
        row.set(u"history"_s, js::B(true));
        seen.items.append(row);
        fromFile = true;
    }
    if (fromFile) {
        std::stable_sort(seen.items.begin(), seen.items.end(), [](const OJson& a, const OJson& b) { return js::str(a.get(u"at"_s)) > js::str(b.get(u"at"_s)); });
        while (seen.items.size() > kSeenMax) seen.items.removeLast();
    }
    const OJson inbox = inboxView();
    double waiting = 0;
    for (const pf::PendingTrack& item : pendingList()) {
        if (!item.settled_fills) waiting += 1;
    }
    co_return js::object({{u"config"_s, config},
                          {u"token_configured"_s, js::B(configured)},
                          {u"link"_s, link},
                          {u"today"_s, today},
                          {u"recent"_s, recent},
                          {u"seen"_s, seen},
                          {u"inbox"_s, inbox},
                          {u"tracks_pending"_s, js::N(waiting)}});
}

// ---------------------------------------------------------------- 延迟的代价:处理完之后记一次盘口
/// 在后台跑一件事:不占消息的队,出什么错都只落一行日志
void FollowService::later(Task<> task) {
    const quint64 id = ++backgroundSeq_;
    Task<> run = laterRun(std::move(task), id);
    // 同步就走完了的,laterRun 结尾那一下已经(没东西可)摘;没走完的登记在册。摘除发生在 Task 完成之前,等它的人醒来时名单已经是干净的(JS 的 finally 同样先于等待者)
    if (!run.done()) background_.emplace_back(id, run);
}

Task<> FollowService::laterRun(Task<> task, quint64 id) {
    std::exception_ptr failure;
    try {
        co_await task;
    } catch (...) {
        failure = std::current_exception();
    }
    if (failure) log(u"[follow] 记盘口出错(不影响跟单):"_s + excMessage(failure));
    for (auto it = background_.begin(); it != background_.end(); ++it) {
        if (it->first == id) {
            background_.erase(it);
            break;
        }
    }
}

/// 这条信号里的那张单。发出去的(或落了库的)以引擎那一遍为准,取它的交易记录;没落库的用这里自己解析的那一份
std::optional<FollowService::Signal> FollowService::signalFor(const QStringList& recordIds, const OJson& payload) {
    for (const QString& id : recordIds) {
        const std::optional<OJson> record = store().getRecord(id);
        const auto signal = record ? signalOf(*record) : std::nullopt;
        if (signal) return Signal{signal->contract, signal->leader};
    }
    const OJson* orders = payload.type == OJson::Object ? payload.get(u"orders"_s) : nullptr;
    if (js::isArr(orders) && orders->items.size() == 1) {
        const auto signal = signalOf(orders->items[0]);
        if (signal) return Signal{signal->contract, signal->leader};
    }
    return std::nullopt;
}

/// 取一次这张单各腿的盘口,和对方写的价一起记下。只在连着 IBKR 时做;没连、盘口不全、TWS 不答话,一律不记、不重试、不提醒
Task<> FollowService::recordQuote(DiscordMessage message, Signal signal) {
    MarksPort* marks = wiring_.marks;
    const auto router = routerPort();
    if (!marks || !router || !router->hasSessions() || settings().broker.provider != u"ibkr") co_return;
    const OJson* legsV = signal.contract.get(u"legs"_s);
    const QList<OJson> legs = js::isArr(legsV) ? legsV->items : QList<OJson>();
    if (legs.isEmpty()) co_return;
    std::vector<execution::LegQuote> quotes;
    bool paper = false;
    std::exception_ptr failure;
    try {
        const std::shared_ptr<execution::IbSession> session = router->marketSession();
        const QStringList managed = session->managedAccounts();
        // 和蝴蝶测算同一个口径:这条会话管的全是纸面账号(DU…)才按"可以退到延迟行情"订
        paper = !managed.isEmpty() && std::all_of(managed.begin(), managed.end(), [](const QString& id) { return id.startsWith(u'D'); });
        std::vector<execution::OptionLegSpec> specs;
        for (const OJson& leg : legs) {
            execution::OptionLegSpec spec;
            spec.symbol = js::str(signal.contract.get(u"symbol"_s));
            spec.expiry = js::str(leg.get(u"lastTradeDateOrContractMonth"_s));
            spec.strike = js::num(leg.get(u"strike"_s));
            spec.right = js::str(leg.get(u"right"_s));
            spec.exchange = js::str(signal.contract.get(u"exchange"_s));
            const OJson* tc = leg.get(u"tradingClass"_s);
            spec.tradingClass = js::nullish(tc) ? QString() : js::str(tc);
            specs.push_back(spec);
        }
        const std::vector<execution::OptionMark> got = co_await marks->read(session, specs, paper, execution::silenceLimitMs(settings().marketStatus(domain::nowEt())));
        for (qsizetype i = 0; i < legs.size(); ++i) {
            execution::LegQuote q;
            q.action = js::str(legs[i].get(u"action"_s));
            q.ratio = js::num(legs[i].get(u"ratio"_s));
            q.bid = (size_t(i) < got.size() && got[i].bid) ? *got[i].bid : std::nan("");
            q.ask = (size_t(i) < got.size() && got[i].ask) ? *got[i].ask : std::nan("");
            quotes.push_back(q);
        }
    } catch (...) {
        failure = std::current_exception();
    }
    if (failure) {
        // 没连上、TWS 没回合约确认:就是"取不到",不算出错
        if (isBrokerLike(failure)) co_return;
        std::rethrow_exception(failure);
    }
    const double at = domain::nowEt().epochMs;
    double mid = 0, natural = 0;
    try {
        mid = execution::comboMidPrice(quotes);
        natural = execution::comboNaturalPrice(quotes);
    } catch (const execution::BrokerError&) {
        co_return;  // 有一条腿没有买价或卖价:拿它算出来的不是价
    }
    const OJson quote = pf::followQuote(signal.leader, mid, natural, at - message.sentAtMs, paper);
    if (quote.type == OJson::Null) co_return;
    if (store().follow().addQuote(message.id, util::utcIso(std::floor(at / 1000) * 1000), quote)) {
        emitEvent(u"follow"_s, js::object({{u"kind"_s, js::S(u"quote"_s)}, {u"message_id"_s, js::S(message.id)}}));
    }
}

// ---------------------------------------------------------------- 跟进来的蝴蝶:成交之后建追踪
/// 现在在等的那几只(每次从库里读:引擎会重建、软件会重启,内存里不留一份会过期的)
std::vector<pf::PendingTrack> FollowService::pendingList() {
    const OJson raw = store().getPref(kPendingPref);
    return pf::pendingTracksOf(&raw);
}

void FollowService::savePending(const std::vector<pf::PendingTrack>& items) {
    OJson arr = js::array();
    for (const pf::PendingTrack& item : items) arr.items.append(item.toJson());
    store().setPref(kPendingPref, &arr);
    QSet<QString> live;
    for (const pf::PendingTrack& item : items) live.insert(item.record_id);
    for (auto* book : {&trackMisses_, &trackFailures_}) {
        for (const QString& id : QList<QString>(book->keys())) {
            if (!live.contains(id)) book->remove(id);
        }
    }
    emitEvent(u"follow"_s, js::object({{u"kind"_s, js::S(u"track"_s)}}));
}

/// 刚发出去的这几笔里,哪些要在成交之后建追踪,以及日志那一行该补哪句话。track_fly 关着回空(什么都不补)。
/// 买入的蝴蝶用蝶式预设;贷方价差用「收回 60% 权利金止盈」加消息里给的标的止损线,消息里没有可用的止损线就「亏到权利金的 50% 止损」
std::optional<FollowService::TrackPlan> FollowService::trackPlan(const DiscordMessage& message, const OJson& submitted, const pf::SpreadStop& stop) {
    const contract::FollowConfig& cfg = settings().follow;
    if (!cfg.track_fly || !js::isArr(&submitted) || submitted.items.isEmpty()) return std::nullopt;
    TrackPlan plan;
    bool fly = false, credit = false;
    for (const OJson& order : submitted.items) {
        const QString recordId = js::str(order.get(u"record_id"_s));
        const std::optional<OJson> record = store().getRecord(recordId);
        const auto signal = record ? signalOf(*record) : std::nullopt;
        if (!signal) continue;
        pf::PendingTrack t;
        t.side = signal->leader.side;
        if (t.side == u"credit") {
            t.stop_below = stop.below;
            t.stop_above = stop.above;
            credit = true;
        } else {
            fly = true;
        }
        t.record_id = recordId;
        t.message_id = message.id;
        t.account = js::str(order.get(u"account"_s));
        t.symbol = js::str(signal->contract.get(u"symbol"_s));
        t.leg = eng().orderLegId(signal->contract);
        t.summary = js::str(order.get(u"intent_summary"_s));
        t.at_ms = domain::nowEt().epochMs;
        plan.items.push_back(t);
    }
    const QString exitText = cfg.track_exit_at.isEmpty() ? QString() : u"、美东 %1 到点平仓"_s.arg(cfg.track_exit_at);
    if (fly) {
        plan.note = u"成交后自动建持仓追踪(蝶式预设、到价自动平仓%1)"_s.arg(exitText);
    } else if (credit) {
        const QString stopText = stop.below ? u"、标的跌破 %1 止损"_s.arg(util::jsNumberToString(*stop.below))
                                 : stop.above ? u"、标的突破 %1 止损"_s.arg(util::jsNumberToString(*stop.above))
                                              : u"、亏到权利金的 %1% 止损"_s.arg(util::jsNumberToString(pf::kCreditStopLossPct));
        plan.note = u"成交后自动建持仓追踪(收回 %1% 权利金止盈%2%3、到价自动平仓)"_s.arg(util::jsNumberToString(pf::kCreditTakeProfitPct), stopText, exitText) +
                    (stop.note.isEmpty() ? QString() : u";"_s + stop.note);
    } else {
        plan.note = u"这一单不是买入的蝴蝶或贷方价差,不自动建追踪,平仓由你自己管"_s;
    }
    return plan;
}

/// 有蝴蝶在等就定一个下一轮(只在引擎真正起来之后;测试里直接调 trackTick)
void FollowService::armTrackTimer() {
    if (!started_ || trackTimer_ != 0) return;
    trackTimer_ = rt().setTimeout(kTrackPollMs, [this] {
        trackTimer_ = 0;
        Task<> run = trackTick();
        run.onDone([this] {
            if (pendingCount() > 0) armTrackTimer();
        });
    });
}

int FollowService::pendingCount() {
    try {
        return int(pendingList().size());
    } catch (...) {
        return 0;  // 库这一下读不了:不为核对追踪把别的拖下水,下一条跟单会重新定时
    }
}

Task<> FollowService::trackTick() {
    trackRun_ = trackStep(trackRun_);
    return trackRun_;
}

Task<> FollowService::trackStep(Task<> prev) {
    co_await prev;
    std::exception_ptr failure;
    try {
        co_await trackOnce();
    } catch (...) {
        failure = std::current_exception();
    }
    if (failure) log(u"[follow] 核对待建的追踪出错:"_s + errHeader(failure));
}

Task<> FollowService::trackOnce() {
    const std::vector<pf::PendingTrack> items = pendingList();
    if (items.empty()) co_return;
    const contract::FollowConfig cfg = settings().follow;
    if (!cfg.enabled || !cfg.track_fly) {
        // 授权收回了(跟单关了,或者这一项关了):在等的一律不建。关掉自动化不该比打开它难
        std::vector<pf::PendingTrack> waiting;
        for (const pf::PendingTrack& item : items) {
            if (!item.settled_fills) waiting.push_back(item);
        }
        for (const pf::PendingTrack& item : waiting) auditDropped(item, u"switched_off"_s);
        savePending({});
        if (!waiting.empty()) {
            notify(u"Discord 跟单:不再自动建追踪"_s,
                   u"自动跟单或「成交后自动建追踪」已经关掉:还在等成交的 %1 张单,成交之后不会自动建追踪,平仓由你自己管。"_s.arg(waiting.size()));
        }
        co_return;
    }
    const double nowMs = domain::nowEt().epochMs;
    domain::TradeStore& st = store();
    QHash<QString, OrderFacts> orders;
    for (const pf::PendingTrack& item : items) {
        const Facts f = orderFacts(st.getRecord(item.record_id));
        orders.insert(item.record_id, OrderFacts{f.filled, f.final_, f.fills});
    }
    // 持仓只在有还没建追踪的单子成交了的时候才读:一张限价单可能挂上几个小时,这段时间里每几秒读一遍持仓没有用处
    bool needRows = false;
    for (const pf::PendingTrack& item : items) {
        if (!item.settled_fills && orders.value(item.record_id).filled) needRows = true;
    }
    std::optional<QList<OJson>> rows;
    if (needRows) rows = co_await positionRows();
    std::optional<QStringList> covered;
    if (const auto r = sh_.svc1Router()) covered = r->coveredAccounts();
    std::vector<pf::PendingTrack> keep;
    for (const pf::PendingTrack& item : items) {
        std::exception_ptr failure;
        std::optional<pf::PendingTrack> next;
        try {
            const OrderFacts order = orders.contains(item.record_id) ? orders.value(item.record_id) : OrderFacts{false, true, 0};
            next = co_await settleOne(item, order, cfg.track_exit_at, nowMs, rows, covered);
        } catch (...) {
            failure = std::current_exception();
        }
        if (failure) {
            // 这一只这一轮没看成(库这一下读不了之类):留着下一轮再看,别的照常
            log(u"[follow] 核对待建的追踪 %1 出错:%2"_s.arg(item.record_id, excMessage(failure)));
            keep.push_back(item);
        } else if (next) {
            keep.push_back(*next);
        }
    }
    // 这一轮里又有新的蝴蝶登记进来(消息不等这里):留着它们。名单没变就不写库、不惊动界面
    QSet<QString> known;
    for (const pf::PendingTrack& item : items) known.insert(item.record_id);
    std::vector<pf::PendingTrack> next = keep;
    for (const pf::PendingTrack& item : pendingList()) {
        if (!known.contains(item.record_id)) next.push_back(item);
    }
    const auto dump = [](const std::vector<pf::PendingTrack>& v) {
        OJson arr = js::array();
        for (const pf::PendingTrack& t : v) arr.items.append(t.toJson());
        return js::stringify(arr);
    };
    if (dump(next) != dump(items)) savePending(next);
}

/// 一只在等的蝶这一轮怎么办;回要留到下一轮的那一条(可能改过),不留回空
Task<std::optional<pf::PendingTrack>> FollowService::settleOne(pf::PendingTrack item, OrderFacts order, QString exitAt, double nowMs, std::optional<QList<OJson>> rows,
                                                               std::optional<QStringList> covered) {
    domain::TradeStore& st = store();
    const QString key = domain::makeKey(item.account, item.symbol, u"BAG"_s, item.leg);
    std::optional<OJson> existing;
    for (const OJson& t : st.listTracks()) {
        const OJson* secType = t.get(u"sec_type"_s);
        const OJson* leg = t.get(u"leg"_s);
        if (domain::makeKey(js::str(t.get(u"account"_s)), js::str(t.get(u"symbol"_s)), js::truthy(secType) ? js::str(secType) : u"STK"_s,
                            js::truthy(leg) ? js::str(leg) : QString()) == key) {
            existing = t;
            break;
        }
    }
    QString track = u"none"_s;
    if (existing) track = (js::truthy(existing->get(u"enabled"_s)) && !js::truthy(existing->get(u"fired_at"_s))) ? u"active"_s : u"idle"_s;
    // 追踪已经有了着落、单子还没走完:只看它后来有没有再成交
    if (item.settled_fills) {
        const QString verdict = pf::remainderVerdict(item.leg, item.at_ms, item.settled_fills, nowMs, order.final_, order.fills, track);
        if (verdict == u"wait") co_return item;
        if (verdict == u"absorbed") {
            pf::PendingTrack t = item;
            t.settled_fills = order.fills;
            co_return t;
        }
        if (verdict == u"late_fill") {
            auditDropped(item, verdict);
            notify(u"Discord 跟单:后成交的部分没有追踪"_s,
                   u"%1 —— 这张单后来又有成交,而这份持仓上的追踪已经触发过(或已停用、被删掉):后成交的部分现在没有追踪在盯,请自己到「持仓追踪」里处理。"_s.arg(item.summary));
        }
        co_return std::nullopt;
    }
    const bool readable = rows && (!covered || covered->contains(item.account));
    const OJson* rowFound = nullptr;
    if (readable) {
        for (const OJson& r : *rows) {
            // 贷方价差是空头组合,数量是负的
            if (js::str(r.get(u"key"_s)) == key && js::num(r.get(u"quantity"_s)) != 0) {
                rowFound = &r;
                break;
            }
        }
    }
    std::optional<bool> held;
    if (readable) held = rowFound != nullptr;
    // 单子走完了、有成交,持仓里却没有:数着,连续几轮都这样才下结论;别的情形清零
    const double misses = (order.filled && order.final_ && held.has_value() && !*held) ? double(trackMisses_.value(item.record_id, 0)) + 1 : 0;
    trackMisses_.insert(item.record_id, int(misses));
    pf::PendingFacts facts;
    facts.nowMs = nowMs;
    facts.filled = order.filled;
    facts.final_ = order.final_;
    facts.held = held;
    facts.misses = misses;
    facts.track = track;
    const QString verdict = pf::pendingVerdict(item.leg, item.at_ms, facts);
    if (verdict == u"wait") co_return item;
    // 追踪有了着落(建好了 / 沿用已有的)而单子还挂着:留着看它后来的成交
    std::optional<pf::PendingTrack> settled;
    if (!order.final_) {
        pf::PendingTrack t = item;
        t.settled_fills = order.fills;
        settled = t;
    }
    if (verdict == u"create") {
        const double held2 = rowFound ? std::fabs(js::num(rowFound->get(u"quantity"_s))) : 0;
        // 每股收到的权利金:组合行的 avg_cost 含乘数
        const double mult = rowFound ? js::num(rowFound->get(u"multiplier"_s)) : 0;
        const double unitCredit = rowFound && mult > 0 ? std::fabs(js::num(rowFound->get(u"avg_cost"_s))) / mult : 0;
        const QString outcome = co_await createTrack(item, key, exitAt, nowMs, held2, unitCredit);
        if (outcome == u"retry") co_return item;
        co_return outcome == u"created" ? settled : std::nullopt;
    }
    auditDropped(item, verdict);
    const QString why = dropText(verdict);
    if (verdict == u"covered" && existing) {
        notify(u"Discord 跟单:沿用已有的追踪"_s, u"%1 —— %2(%3)"_s.arg(item.summary, why, pf::trackExitsText(*existing, nowMs)));
        co_return settled;
    }
    if (!why.isEmpty()) notify(u"Discord 跟单:没有建追踪"_s, u"%1 —— %2"_s.arg(item.summary, why));
    co_return std::nullopt;
}

/// 此刻的持仓行(带组合行);没连券商、读不到回空——读不到不等于没有。读法和「持仓追踪」页那一头相同
Task<std::optional<QList<OJson>>> FollowService::positionRows() {
    const auto router = routerPort();
    if (!router || !router->hasSessions()) co_return std::nullopt;
    std::optional<QList<OJson>> out;
    try {
        out = domain::withCombos(co_await router->positions());
    } catch (...) {
        out = std::nullopt;
    }
    co_return out;
}

/// 建一条追踪。retry = 这一轮没建成、下一轮再试;refused = 建不了,已经说明原因,不再试。
/// 入参被拒(同一条 tracker.add 的校验)当场算 refused。`held` 是持仓里这只蝶现在有几张
Task<QString> FollowService::createTrack(pf::PendingTrack item, QString key, QString exitAt, double nowMs, double held, double unitCredit) {
    domain::TradeStore& st = store();
    QString result;
    std::exception_ptr failure;
    const bool credit = item.side == u"credit";
    const QString what = credit ? u"这张价差"_s : u"这只蝶"_s;
    try {
        if (!wiring_.addTrack) throw util::JsError(u"建追踪的通道没有接上"_s);
        // 用不上的那一条线让 tracker.add 拒了:这条线不带、追踪照建——因为一条线建不成整条追踪,那份持仓就什么保护都没有了。
        // 到点平仓的钟点已经过了(下一次落在到期之后);价差成交时已经跌到止盈价以下(止盈价得低于现价)、已经涨过止损价(止损价得高于现价)
        std::optional<double> takeProfit = credit ? pf::creditTakeProfit(unitCredit) : std::nullopt;
        // 按权利金的止损只在消息里没有可用的标的止损线时才带
        std::optional<double> stopLoss = credit && !item.stop_below && !item.stop_above ? pf::creditStopLoss(unitCredit) : std::nullopt;
        const auto params = [&] {
            return credit ? pf::creditTrackParams(key, exitAt, takeProfit, stopLoss, item.stop_below, item.stop_above) : pf::flyTrackParams(key, exitAt);
        };
        QString dropped;
        OJson reply;
        for (int attempt = 0;; ++attempt) {
            std::exception_ptr first;
            try {
                reply = co_await wiring_.addTrack(params());
            } catch (...) {
                first = std::current_exception();
            }
            if (!first) break;
            QString refusal;
            try {
                std::rethrow_exception(first);
            } catch (const util::RpcError& e) {
                if (e.code() == -32602) refusal = e.message();
            } catch (...) {
            }
            if (attempt < 3 && !exitAt.isEmpty() && refusal.startsWith(u"到点平仓"_s)) {
                dropped += u";美东 %1 的到点平仓对%2用不上(下一次到点已经在它到期之后),这条追踪没有带"_s.arg(exitAt, what);
                exitAt.clear();
            } else if (attempt < 3 && takeProfit && refusal.contains(u"止盈价"_s)) {
                dropped += u";成交时价差已经不到止盈价 %1(%2),这条追踪没有带止盈"_s.arg(util::jsNumberToString(*takeProfit), refusal);
                takeProfit.reset();
            } else if (attempt < 3 && stopLoss && refusal.contains(u"止损价"_s)) {
                dropped += u";成交时价差已经过了止损价 %1(%2),这条追踪没有带止损,请自己处理这张价差"_s.arg(util::jsNumberToString(*stopLoss), refusal);
                stopLoss.reset();
            } else {
                std::rethrow_exception(first);
            }
        }
        const OJson* trackP = reply.get(u"track"_s);
        const OJson track = trackP ? *trackP : OJson();
        const QString exits = pf::trackExitsText(track, nowMs) + dropped;
        OJson detail = js::object({{u"message"_s, js::S(item.message_id)},
                                   {u"record"_s, js::S(item.record_id)},
                                   {u"account"_s, js::S(item.account)},
                                   {u"symbol"_s, js::S(item.symbol)},
                                   {u"leg"_s, js::S(item.leg)}});
        // 值是 undefined 的键 JSON.stringify 会丢掉
        for (const auto& [k, from] : {std::pair<QString, QString>{u"track"_s, u"id"_s}, {u"targets"_s, u"targets"_s}, {u"auto_close"_s, u"auto_close"_s}}) {
            if (const OJson* v = js::prop(&track, from)) detail.set(k, *v);
        }
        st.audit(u"engine"_s, u"follow_track"_s, &detail);
        notify(u"Discord 跟单:已建持仓追踪"_s,
               u"%1 —— %2现在持有 %3 张,追踪管的是这一整份:%4。对方自己什么时候走,软件仍然不知道。"_s.arg(item.summary, what, util::jsNumberToString(held), exits));
        result = u"created"_s;
    } catch (...) {
        failure = std::current_exception();
    }
    if (failure) {
        const QString reason = excMessage(failure);
        bool refused = false;
        try {
            std::rethrow_exception(failure);
        } catch (const util::RpcError& e) {
            refused = e.code() == -32602;
        } catch (...) {
        }
        const int failures = trackFailures_.value(item.record_id, 0) + 1;
        trackFailures_.insert(item.record_id, failures);
        if (!refused && failures < kTrackAddAttempts) {
            result = u"retry"_s;
        } else {
            const OJson detail = js::object({{u"message"_s, js::S(item.message_id)},
                                             {u"record"_s, js::S(item.record_id)},
                                             {u"leg"_s, js::S(item.leg)},
                                             {u"error"_s, js::S(reason.left(300))}});
            st.audit(u"engine"_s, u"follow_track_failed"_s, &detail);
            notify(u"Discord 跟单:没有建追踪"_s,
                   u"%1 —— %2。%3现在没有追踪在盯,请自己到「持仓追踪」里设。"_s.arg(
                       item.summary, refused ? reason : u"试了 %1 次都没建成(%2)"_s.arg(failures).arg(reason), what));
            result = u"refused"_s;
        }
    }
    co_return result;
}

void FollowService::auditDropped(const pf::PendingTrack& item, const QString& reason) {
    const OJson detail = js::object({{u"message"_s, js::S(item.message_id)},
                                     {u"record"_s, js::S(item.record_id)},
                                     {u"account"_s, js::S(item.account)},
                                     {u"leg"_s, js::S(item.leg)},
                                     {u"reason"_s, js::S(reason)}});
    store().audit(u"engine"_s, u"follow_track_dropped"_s, &detail);
}

}  // namespace ibkr::orchestrate
