#include "shell/sectors_store.h"

#include "shell/alerts_store.h"
#include "shell/bridge.h"
#include "shell/feed_stores.h"
#include "shell/jsvalue.h"
#include "shell/status_store.h"

#include <QPointer>
#include <QDateTime>

#include <memory>

namespace ibkr::shell {

using namespace Qt::StringLiterals;

namespace {

/// cleanList:数组的每一项 String(x ?? '').trim(),去掉空的
QStringList cleanList(const QJsonValue& v) {
    QStringList out;
    for (const QJsonValue& x : v.isArray() ? v.toArray() : QJsonArray{}) {
        const QString s = jsTrim(x.isNull() || x.isUndefined() ? QString() : jsString(x));
        if (!s.isEmpty()) out << s;
    }
    return out;
}

/// Promise.all 的两路:两边都回来了才调 done
std::function<void()> both(std::function<void()> done) {
    auto left = std::make_shared<int>(2);
    return [left, done] {
        if (--*left == 0 && done) done();
    };
}

}  // namespace

SectorsStore::SectorsStore(Bridge* bridge, StatusStore* status, AlertsStore* alerts, QualityStore* quality, QObject* parent)
    : QObject(parent), bridge_(bridge), status_(status), alerts_(alerts), quality_(quality) {}

void SectorsStore::error(const QString& text) {
    if (status_) status_->showError(text);
}
void SectorsStore::info(const QString& text) {
    if (status_) status_->showInfo(text);
}

bool SectorsStore::reportSkipped(const QString& prefix, const QJsonValue& skipped) {
    const QStringList reasons = cleanList(skipped);
    if (reasons.isEmpty()) return false;
    info(prefix + reasons.join(u";"_s));
    return true;
}

void SectorsStore::reportDropped(const QJsonValue& dropped) {
    const QStringList symbols = cleanList(dropped);
    if (symbols.isEmpty()) return;
    info(u"%1 已不在任何板块里,顺带把它的价位与异动监控一起撤了。"_s.arg(symbols.join(u"、"_s)));
}

void SectorsStore::reloadBoth(Done done) {
    const auto one = both(std::move(done));
    if (alerts_) alerts_->load(one);
    else one();
    if (quality_) quality_->load(one);
    else one();
}

void SectorsStore::load(Done done) {
    QPointer<SectorsStore> self(this);
    bridge_->rpc(this, u"sectors.list"_s, QJsonObject{}, [self, done](const EngineReply& r) {
        if (!self) return;
        if (r.ok) {
            const QJsonValue list = r.result.toObject().value("sectors"_L1);
            self->sectors_ = list.isArray() ? list.toArray() : QJsonArray{};
            emit self->changed();
        } else {
            self->error(u"读取板块失败:"_s + r.error);
        }
        if (done) done();
    });
}

void SectorsStore::refreshEarnings(const QString& symbol) {
    QStringList symbols;
    if (!symbol.isEmpty()) symbols << symbol;
    else for (const auto& s : sectors_) for (const auto& stock : s[u"stocks"_s].toArray()) symbols << stock[u"symbol"_s].toString();
    for (const auto& s : symbols) {
        const auto old = earnings_[s].toObject();
        const double age = QDateTime::currentMSecsSinceEpoch() - old["at"].toDouble();
        if (s.isEmpty() || earningsQueue_.contains(s) || old["status"] == "loading") continue;
        if (symbol.isEmpty() && age >= 0 && age < 300000) continue;
        earningsQueue_ << s;
    }
    nextEarnings();
}

void SectorsStore::nextEarnings() {
    if (earningsBusy_ || earningsQueue_.isEmpty()) return;
    const QString symbol = earningsQueue_.takeFirst();
    earningsBusy_ = true;
    earnings_[symbol] = QJsonObject{{"status","loading"},{"message",u"正在读取 IBKR 财报日历…"_s}};
    emit earningsChanged();
    QPointer<SectorsStore> self(this);
    bridge_->rpc(this, u"sectors.earnings"_s, QJsonObject{{"symbol",symbol}}, [self,symbol](const EngineReply& r) {
        if (!self) return;
        self->earnings_[symbol] = r.ok ? r.result.toObject() : QJsonObject{{"status","missing"},{"message",r.error},
            {"at",double(QDateTime::currentMSecsSinceEpoch())}};
        self->earningsBusy_ = false;
        emit self->earningsChanged();
        self->nextEarnings();
    });
}

void SectorsStore::refreshQuotes(Done done) {
    QPointer<SectorsStore> self(this);
    bridge_->rpc(this, u"sectors.quotes"_s, QJsonObject{}, [self, done](const EngineReply& r) {
        if (!self) return;
        if (r.ok) {
            const QJsonObject res = r.result.toObject();
            self->quotes_ = res.value("quotes"_L1).toObject();
            self->refreshEarnings();
            emit self->changed();
            bool anyStocks = false;
            for (const QJsonValue& s : std::as_const(self->sectors_)) anyStocks = anyStocks || !s[u"stocks"_s].toArray().isEmpty();
            if (!jsTruthy(res.value("connected"_L1)) && anyStocks) {
                const bool futu = self->status_ && self->status_->status().value("broker_provider"_L1) == u"futu"_s;
                self->info(u"行情需要先在%1面板连接引擎"_s.arg(futu ? u"「富途 OpenD」"_s : u"「TWS 连接」"_s));
            }
        } else {
            self->error(u"刷新板块行情失败:"_s + r.error);
        }
        if (done) done();
    });
}

void SectorsStore::replaceSector(const QJsonValue& fresh, Done done) {
    if (!jsTruthy(fresh) || !jsTruthy(fresh[u"id"_s])) return load(std::move(done));
    QJsonArray next;
    bool found = false;
    for (const QJsonValue& s : std::as_const(sectors_)) {
        if (!found && s[u"id"_s] == fresh[u"id"_s]) {
            next.append(fresh);
            found = true;
        } else {
            next.append(s);
        }
    }
    if (!found) next.append(fresh);
    sectors_ = next;
    emit changed();
    if (done) done();
}

void SectorsStore::addSector(const QString& name, Ok done) {
    QPointer<SectorsStore> self(this);
    bridge_->rpc(this, u"sectors.add"_s, QJsonObject{{u"name"_s, name}}, [self, done](const EngineReply& r) {
        if (!self) return;
        if (!r.ok) {
            self->error(u"新建板块失败:"_s + r.error);
            if (done) done(false);
            return;
        }
        self->replaceSector(r.result.toObject().value("sector"_L1), [done] {
            if (done) done(true);
        });
    });
}

void SectorsStore::deleteSector(const QString& id, const QString& name, Done done) {
    QPointer<SectorsStore> self(this);
    const QJsonObject options{{u"title"_s, u"删除板块"_s}, {u"message"_s, u"删除板块「%1」?"_s.arg(name)},
                              {u"detail"_s, u"只删除这个板块及其 AI 选股结果,不影响任何交易数据。里面的股如果不在别的板块里,连带停止盯价位与盯异动。"_s},
                              {u"confirmLabel"_s, u"删除"_s}};
    bridge_->confirm(this, options, [self, id, done](bool ok, const QString&) {
        if (!self || !ok) {
            if (done) done();
            return;
        }
        self->bridge_->rpc(self, u"sectors.delete"_s, QJsonObject{{u"id"_s, id}}, [self, id, done](const EngineReply& r) {
            if (!self) return;
            if (r.ok) {
                QJsonArray next;
                for (const QJsonValue& s : std::as_const(self->sectors_))
                    if (s[u"id"_s] != QJsonValue(id)) next.append(s);
                self->sectors_ = next;
                emit self->changed();
                self->reportDropped(r.result.toObject().value("dropped"_L1));
                self->reloadBoth(done);
            } else {
                self->error(u"删除板块失败:"_s + r.error);
                self->load(done);
            }
        });
    });
}

void SectorsStore::addStock(const QString& sectorId, const QString& symbol, const QString& tag, Ok done) {
    QPointer<SectorsStore> self(this);
    bridge_->rpc(this, u"sectors.add_stock"_s, QJsonObject{{u"id"_s, sectorId}, {u"symbol"_s, symbol}, {u"tag"_s, tag}}, [self, done](const EngineReply& r) {
        if (!self) return;
        if (!r.ok) {
            self->error(u"添加股票失败:"_s + r.error);
            if (done) done(false);
            return;
        }
        const QJsonObject res = r.result.toObject();
        self->replaceSector(res.value("sector"_L1), [self, res, done] {
            if (!self) return;
            // 默认两个开关都开,开不上的照引擎的原话说
            const QJsonValue w = res.value("watch"_L1);
            if (jsTruthy(w)) self->reportSkipped(jsTruthy(w[u"symbol"_s]) ? jsString(w[u"symbol"_s]) + u":"_s : QString(), w[u"skipped"_s]);
            self->refreshQuotes();  // 新加那只的行情后台补
            self->reloadBoth([done] {
                if (done) done(true);
            });
        });
    });
}

void SectorsStore::removeStock(const QString& sectorId, const QString& symbol) {
    const QJsonArray before = sectors_;
    QJsonArray next;
    for (const QJsonValue& s : before) {
        if (s[u"id"_s] != QJsonValue(sectorId)) {
            next.append(s);
            continue;
        }
        QJsonObject o = s.toObject();
        QJsonArray stocks;
        for (const QJsonValue& x : o.value("stocks"_L1).toArray())
            if (x[u"symbol"_s] != QJsonValue(symbol)) stocks.append(x);
        o[u"stocks"_s] = stocks;
        next.append(o);
    }
    sectors_ = next;
    emit changed();
    QPointer<SectorsStore> self(this);
    bridge_->rpc(this, u"sectors.remove_stock"_s, QJsonObject{{u"id"_s, sectorId}, {u"symbol"_s, symbol}}, [self, before](const EngineReply& r) {
        if (!self) return;
        if (r.ok) {
            const QJsonObject res = r.result.toObject();
            self->replaceSector(res.value("sector"_L1), [self, res] {
                if (!self) return;
                self->reportDropped(res.value("dropped"_L1));  // 它不在任何板块里了:两个开关连带撤掉,说一声
                self->reloadBoth({});
            });
        } else {
            self->sectors_ = before;
            emit self->changed();
            self->error(u"移除股票失败:"_s + r.error);
            self->load();  // 以引擎为准
        }
    });
}

void SectorsStore::setTag(const QString& sectorId, const QString& symbol, const QString& tag, Ok done) {
    QPointer<SectorsStore> self(this);
    bridge_->rpc(this, u"sectors.set_tag"_s, QJsonObject{{u"id"_s, sectorId}, {u"symbol"_s, symbol}, {u"tag"_s, tag}}, [self, done](const EngineReply& r) {
        if (!self) return;
        if (!r.ok) {
            self->error(u"改标签失败:"_s + r.error);
            if (done) done(false);
            return;
        }
        self->replaceSector(r.result.toObject().value("sector"_L1), [done] {
            if (done) done(true);
        });
    });
}

void SectorsStore::pick(const QString& id, Done done) {
    QPointer<SectorsStore> self(this);
    bridge_->rpc(this, u"sectors.pick"_s, QJsonObject{{u"id"_s, id}}, [self, done](const EngineReply& r) {
        if (!self) return;
        if (!r.ok) {
            self->error(u"AI 选股失败:"_s + r.error);
            if (done) done();
            return;
        }
        const QJsonValue skipped = r.result.toObject().value("skipped"_L1);
        self->load([self, skipped, done] {
            if (!self) return;
            self->refreshQuotes([self, skipped, done] {
                if (!self) return;
                // 一次十几只很容易吃满 30 只上限:哪几只没开上,照原话说
                self->reportSkipped(u"这一批里有几只没开上监控:"_s, skipped);
                self->reloadBoth(done);
            });
        });
    });
}

void SectorsStore::setPoolWatch(const QString& symbol, const QJsonObject& patch, Done done) {
    const QString s = jsTrim(symbol).toUpper();
    if (s.isEmpty()) {
        if (done) done();
        return;
    }
    const QString what = patch.contains(u"price"_s) ? u"价位"_s : u"异动"_s;
    QJsonObject params = patch;
    params[u"symbol"_s] = s;
    QPointer<SectorsStore> self(this);
    bridge_->rpc(this, u"pool.set_watch"_s, params, [self, s, what, done](const EngineReply& r) {
        if (!self) return;
        if (r.ok) self->reportSkipped(s + u":"_s, r.result.toObject().value("skipped"_L1));
        else self->error(u"%1 的「%2」没拨动:%3"_s.arg(s, what, r.error));
        // 失败后也重读:开关要退回引擎里真正的状态
        self->reloadBoth(done);
    });
}

}  // namespace ibkr::shell
