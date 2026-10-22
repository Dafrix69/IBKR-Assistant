#include "shell/ideas_controller.h"

#include "shell/bridge.h"
#include "shell/ideas_rules.h"
#include "shell/jsvalue.h"
#include "shell/status_store.h"
#include "shell/trade_composer.h"

#include <QDateTime>
#include <QPointer>

namespace ibkr::shell {

using namespace Qt::StringLiterals;

IdeasController::IdeasController(Bridge* bridge, StatusStore* status, TradeComposer* composer, QObject* parent)
    : QObject(parent), bridge_(bridge), status_(status), composer_(composer) {
    now = [] { return double(QDateTime::currentMSecsSinceEpoch()); };
    connect(&timer_, &QTimer::timeout, this, [this] { load(); });
    rebuild();
}

void IdeasController::reset() {
    filter_ = u"active"_s;
    query_.clear();
    withTrades_ = true;
    ideas_ = {};
    matched_ = {};
    loadError_.clear();
    digests_ = {};
    digesting_ = false;
    analyzing_.clear();
}

void IdeasController::setVisible(bool on) {
    if (on == visible_) return;
    visible_ = on;
    ++generation_;
    reset();
    if (!on) {
        timer_.stop();
        rebuild();
        return;
    }
    rebuild();
    load();
    timer_.start(refreshMs);
}

void IdeasController::setFilter(const QString& filter) {
    if ((filter != u"active" && filter != u"all") || filter == filter_) return;
    filter_ = filter;
    rebuild();
    load();
    // 原版换筛选会重建定时器(load 变了):节拍从这一刻重新数
    if (visible_) timer_.start(refreshMs);
}

void IdeasController::search(const QString& query) {
    const QString q = jsTrim(query);
    if (q == query_) return;
    query_ = q;
    rebuild();
    load();
    if (visible_) timer_.start(refreshMs);
}

void IdeasController::setWithTrades(bool on) {
    withTrades_ = on;
    rebuild();
}

void IdeasController::load(std::function<void()> done) {
    const int gen = generation_, seq = ++loadSeq_;
    QPointer<IdeasController> self(this);
    QJsonObject params;
    if (filter_ != u"all") params[u"status"_s] = filter_;
    const bool searching = !query_.isEmpty();
    if (searching) {
        params[u"q"_s] = query_;
        params[u"limit"_s] = 200;
    }
    bridge_->rpc(this, searching ? u"ideas.search"_s : u"ideas.list"_s, params, [self, gen, seq, searching, done](const EngineReply& r) {
        if (!self || gen != self->generation_) return;
        if (seq != self->loadSeq_) {
            // 更新的一次已经发出去了:这一份不落地,等的人照样等到「读完了」
            if (done) done();
            return;
        }
        if (r.ok) {
            const QJsonObject res = r.result.toObject();
            if (searching) {
                QJsonArray ideas;
                QJsonObject matched;
                for (const QJsonValue& h : res.value("hits"_L1).toArray()) {
                    ideas.append(h[u"idea"_s]);
                    matched[jsString(h[u"idea"_s][u"id"_s])] = h[u"matched_by"_s];
                }
                self->ideas_ = ideas;
                self->matched_ = matched;
            } else {
                self->ideas_ = res.value("ideas"_L1).toArray();
                self->matched_ = {};
            }
            self->loadError_.clear();
        } else {
            self->loadError_ = r.error;
        }
        if (done) done();
        self->rebuild();
    });
    // 不阻塞想法列表;失败只记日志
    loadDigests();
}

void IdeasController::loadDigests() {
    const int gen = generation_;
    QPointer<IdeasController> self(this);
    bridge_->rpc(this, u"ideas.digests"_s, QJsonObject{}, [self, gen](const EngineReply& r) {
        if (!self || gen != self->generation_) return;
        if (!r.ok) {
            qWarning("读取知识总结失败:%s", qPrintable(r.error));
            return;
        }
        self->digests_ = r.result.toObject().value("digests"_L1).toArray();
        self->rebuild();
    });
}

void IdeasController::add(const QString& text) {
    const QString t = jsTrim(text);
    if (t.isEmpty()) return;
    const int gen = generation_;
    QPointer<IdeasController> self(this);
    bridge_->rpc(this, u"ideas.add"_s, QJsonObject{{u"text"_s, t}}, [self, gen](const EngineReply& r) {
        if (!self || gen != self->generation_) return;
        if (!r.ok) {
            if (self->status_) self->status_->showError(u"记录想法失败:"_s + r.error);
            return;
        }
        emit self->added();
        // 回到「进行中」再读(原版:换了筛选由 effect 读,本来就在进行中就手动读一次——都是读一次)
        self->filter_ = u"active"_s;
        self->rebuild();
        self->load();
    });
}

void IdeasController::setStatus(const QString& id, const QString& status) {
    const int gen = generation_;
    QPointer<IdeasController> self(this);
    bridge_->rpc(this, u"ideas.update"_s, QJsonObject{{u"id"_s, id}, {u"status"_s, status}}, [self, gen](const EngineReply& r) {
        if (!self || gen != self->generation_) return;
        if (!r.ok) {
            if (self->status_) self->status_->showError(u"更新想法失败:"_s + r.error);
            return;
        }
        self->load();
    });
}

void IdeasController::analyze(const QString& id) {
    analyzing_.insert(id);
    rebuild();
    const int gen = generation_;
    QPointer<IdeasController> self(this);
    bridge_->rpc(this, u"ideas.analyze"_s, QJsonObject{{u"id"_s, id}}, [self, gen, id](const EngineReply& r) {
        if (!self || gen != self->generation_) return;
        if (r.ok) {
            // 等列表重读完才撤掉「分析中…」(原版 await onChanged() 之后才进 finally):中间那一下按钮不能又变回可点
            QPointer<IdeasController> again(self);
            self->load([again, id] {
                if (!again) return;
                again->analyzing_.remove(id);
                again->rebuild();
            });
            return;
        }
        if (self->status_) self->status_->showError(r.error.startsWith(u"AI 分析失败:"_s) ? r.error : u"AI 分析失败:"_s + r.error);
        self->analyzing_.remove(id);
        self->rebuild();
    });
}

void IdeasController::digest() {
    digesting_ = true;
    rebuild();
    // 已归档 + 已完成一起看,规律才完整;有检索词时改成「命中的按时间分层抽 + 最近的一批」
    QJsonObject params{{u"scope"_s, u"all"_s}, {u"trades"_s, withTrades_}};
    if (!query_.isEmpty()) params[u"focus"_s] = QJsonObject{{u"q"_s, query_}};
    const int gen = generation_;
    QPointer<IdeasController> self(this);
    bridge_->rpc(this, u"ideas.digest"_s, params, [self, gen](const EngineReply& r) {
        if (!self || gen != self->generation_) return;
        if (r.ok) {
            // 读完总结历史才算完(原版 await loadDigests() 之后才撤掉「总结中…」)
            QPointer<IdeasController> again(self);
            self->bridge_->rpc(self, u"ideas.digests"_s, QJsonObject{}, [again, gen](const EngineReply& d) {
                if (!again || gen != again->generation_) return;
                if (d.ok) again->digests_ = d.result.toObject().value("digests"_L1).toArray();
                again->digesting_ = false;
                again->rebuild();
            });
            return;
        }
        if (self->status_) self->status_->showError(r.error.startsWith(u"知识总结失败:"_s) ? r.error : u"知识总结失败:"_s + r.error);
        self->digesting_ = false;
        self->rebuild();
    });
}

void IdeasController::sendToTrade(const QString& id) {
    for (const QJsonValue& v : std::as_const(ideas_)) {
        if (jsString(v[u"id"_s]) != id) continue;
        if (composer_) composer_->setDraft(jsString(v[u"text"_s]));
        emit navigateRequested(u"trade"_s);
        return;
    }
}

void IdeasController::rebuild() {
    ideas::PageInput in;
    in.filter = filter_;
    in.ideas = ideas_;
    in.loadError = loadError_;
    in.digests = digests_;
    in.query = query_;
    in.matched = matched_;
    in.analyzing = analyzing_;
    in.digesting = digesting_;
    in.withTrades = withTrades_;
    in.nowMs = now();
    in.zone = zone;
    page_ = ideas::pageModel(in);
    emit pageChanged();
}

}  // namespace ibkr::shell
