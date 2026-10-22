#include "orchestrate/services/pool.h"

#include "execution/ib_link.h"
#include "orchestrate/services/svc_util.h"
#include "util/js_runtime.h"
#include "util/jsnum.h"
#include "util/jsobj.h"
#include "util/rpc_error.h"

#include <QDateTime>
#include <QTimeZone>

#include <cmath>

namespace ibkr::orchestrate {

using namespace Qt::StringLiterals;
using util::OJson;
namespace js = util::js;

namespace {

QString strOf(const OJson* v) { return js::str(v); }

QString jsTrim(const QString& s) {
    qsizetype a = 0, b = s.size();
    while (a < b && util::isJsWhitespace(s[a])) ++a;
    while (b > a && util::isJsWhitespace(s[b - 1])) --b;
    return s.mid(a, b - a);
}

template <class L>
std::optional<OJson> findBySymbol(const L& rows, const QString& symbol) {
    for (const OJson& r : rows)
        if (strOf(js::prop(&r, u"symbol"_s)) == symbol) return r;
    return std::nullopt;
}

}  // namespace

OJson PoolService::setWatch(const QString& symbol, const PoolWatchPatch& patch, const QString& note) {
    // 迁移必须排在任何一次开关变化之前:否则用户刚关掉的开关,会被随后才跑的迁移又打开(迁移自己也走这里,靠 poolMigrated_ 直接返回)
    ensureMigrated();
    auto& st = store();
    QStringList skipped;
    const auto watch = findBySymbol(st.listWatches(), symbol);
    const auto quality = findBySymbol(st.listQualityStocks(), symbol);
    bool priceOn = watch.has_value();
    bool anomalyOn = quality.has_value();

    if (patch.price && *patch.price && !watch) {
        if (st.listWatches().size() >= ports_.maxWatch) {
            skipped.append(u"价位已达 %1 只上限,%2 没打开"_s.arg(ports_.maxWatch).arg(symbol));
        } else {
            try {
                st.addWatch(symbol, kDefaultWatchStep);
                const OJson d = js::object({{u"symbol"_s, js::S(symbol)}, {u"which"_s, js::S(u"price"_s)}});
                st.audit(u"ui"_s, u"pool_watch_on"_s, &d);
                priceOn = true;
            } catch (...) {
                skipped.append(util::errText(std::current_exception()));
            }
        }
    } else if (patch.price && !*patch.price && watch) {
        st.deleteWatch(strOf(js::prop(&*watch, u"id"_s)));
        const OJson d = js::object({{u"symbol"_s, js::S(symbol)}, {u"which"_s, js::S(u"price"_s)}});
        st.audit(u"ui"_s, u"pool_watch_off"_s, &d);
        if (ports_.forgetAlert) ports_.forgetAlert(symbol);
        priceOn = false;
    }

    if (patch.anomaly && *patch.anomaly && !quality) {
        if (settings().indexConfig(symbol)) {
            // 指数不是可交易合约,量能流按正股去订一定订不上(quality.add 拒的也是这个原因)
            skipped.append(u"%1 是指数,异动监控只支持个股 / ETF"_s.arg(symbol));
        } else if (st.listQualityStocks().size() >= ports_.maxQuality) {
            skipped.append(u"异动已达 %1 只上限,%2 没打开"_s.arg(ports_.maxQuality).arg(symbol));
        } else {
            try {
                const OJson n = js::S(note);
                st.addQualityStock(symbol, &n);
                const OJson d = js::object({{u"symbol"_s, js::S(symbol)}, {u"which"_s, js::S(u"anomaly"_s)}});
                st.audit(u"ui"_s, u"pool_watch_on"_s, &d);
                anomalyOn = true;
            } catch (...) {
                skipped.append(util::errText(std::current_exception()));
            }
        }
    } else if (patch.anomaly && !*patch.anomaly && quality) {
        st.deleteQualityStock(strOf(js::prop(&*quality, u"id"_s)));
        const OJson d = js::object({{u"symbol"_s, js::S(symbol)}, {u"which"_s, js::S(u"anomaly"_s)}});
        st.audit(u"ui"_s, u"pool_watch_off"_s, &d);
        // 关掉期间的样本等到重新打开时早过时了,留着只会把一段空档算成"窗口"
        if (ports_.forgetAnomaly) ports_.forgetAnomaly(symbol);
        anomalyOn = false;
    }
    return js::object({{u"symbol"_s, js::S(symbol)}, {u"price_on"_s, js::B(priceOn)}, {u"anomaly_on"_s, js::B(anomalyOn)}, {u"skipped"_s, js::strings(skipped)}});
}

std::optional<QString> PoolService::ensureInPool(const QString& symbol, const QString& company) {
    auto& st = store();
    if (st.symbolsInSectors().contains(symbol)) return std::nullopt;
    OJson sector;
    bool found = false;
    for (const OJson& s : st.listSectors()) {
        if (strOf(js::prop(&s, u"name"_s)) == kPoolDefaultSector) {
            sector = s;
            found = true;
            break;
        }
    }
    if (!found) sector = st.addSector(kPoolDefaultSector);
    OJson stocks = js::array();
    if (const OJson* old = js::prop(&sector, u"stocks"_s); !js::nullish(old)) stocks.items = old->items;
    stocks.items.append(js::object({{u"symbol"_s, js::S(symbol)}, {u"company"_s, js::S(company.left(60))}, {u"reason"_s, js::S(u"手动加入"_s)}, {u"tag"_s, js::S(QString())}}));
    st.setSectorStocks(strOf(js::prop(&sector, u"id"_s)), stocks);
    return strOf(js::prop(&sector, u"name"_s));
}

QStringList PoolService::dropWatches(const QStringList& symbols) {
    ensureMigrated();  // 同上:先把旧库并成池子,再谈谁该被清掉
    auto& st = store();
    const QStringList inPool = st.symbolsInSectors();
    QStringList dropped;
    for (const QString& raw : symbols) {
        const QString symbol = jsTrim(raw).toUpper();
        if (symbol.isEmpty() || inPool.contains(symbol) || dropped.contains(symbol)) continue;
        const bool had = findBySymbol(st.listWatches(), symbol).has_value() || findBySymbol(st.listQualityStocks(), symbol).has_value();
        if (!had) continue;
        setWatch(symbol, PoolWatchPatch{false, false});
        dropped.append(symbol);
    }
    return dropped;
}

void PoolService::ensureMigrated() {
    if (poolMigrated_) return;
    poolMigrated_ = true;
    auto& st = store();
    if (st.getPref(kPoolMigratedPref).type != OJson::Null) return;
    try {
        const QStringList inPool = st.symbolsInSectors();
        QStringList orphans;
        // 持仓追踪自动建的盯单不是孤儿:它归追踪管,追踪删掉时自己会走
        QList<OJson> rows;
        for (const OJson& w : st.listWatches()) {
            const OJson* o = js::prop(&w, u"origin"_s);
            if ((js::nullish(o) ? QString() : js::str(o)) != ports_.originTracker) rows.append(w);
        }
        rows.append(st.listQualityStocks());
        for (const OJson& row : rows) {
            const OJson* sv = js::prop(&row, u"symbol"_s);
            const QString symbol = jsTrim(js::nullish(sv) ? QString() : js::str(sv)).toUpper();
            if (symbol.isEmpty() || inPool.contains(symbol) || orphans.contains(symbol)) continue;
            orphans.append(symbol);
        }
        if (!orphans.isEmpty()) {
            OJson sector;
            bool found = false;
            for (const OJson& s : st.listSectors())
                if (strOf(js::prop(&s, u"name"_s)) == kPoolDefaultSector) {
                    sector = s;
                    found = true;
                    break;
                }
            if (!found) sector = st.addSector(kPoolDefaultSector);
            // 这里不按"单个板块最多 30 只"截断:截掉的那几只会留着两张表的行却不在池子里,反而成了新的孤儿——迁移的本分是一只不落地搬过来
            OJson stocks = js::array();
            if (const OJson* old = js::prop(&sector, u"stocks"_s); !js::nullish(old)) stocks.items = old->items;
            for (const QString& symbol : orphans)
                stocks.items.append(js::object({{u"symbol"_s, js::S(symbol)}, {u"company"_s, js::S(QString())}, {u"reason"_s, js::S(u"迁移并入"_s)}, {u"tag"_s, js::S(QString())}}));
            st.setSectorStocks(strOf(js::prop(&sector, u"id"_s)), stocks);
        }
        QStringList skipped;
        double armed = 0;
        for (const QString& symbol : st.symbolsInSectors()) {
            const OJson out = setWatch(symbol, PoolWatchPatch{kDefaultPrice, kDefaultAnomaly});
            for (const OJson& s : js::prop(&out, u"skipped"_s)->items) skipped.append(s.s);
            if (js::truthy(js::prop(&out, u"price_on"_s)) || js::truthy(js::prop(&out, u"anomaly_on"_s))) armed += 1;
        }
        const OJson d = js::object({{u"orphans"_s, js::strings(orphans)}, {u"armed"_s, js::N(armed)}, {u"skipped"_s, js::strings(skipped)}});
        st.audit(u"ui"_s, u"pool_migrate_v1"_s, &d);
    } catch (...) {
        // 迁移失败不该挡住这次读取:标记照写(见上:重跑会把用户关掉的开关再打开)
        execution::logStderr(u"[pool] 迁移失败:%1"_s.arg(util::errText(std::current_exception())));
    }
    const OJson mark = js::object({{u"at"_s, js::S(isoMsZ(util::dateNow()))}});
    st.setPref(kPoolMigratedPref, &mark);
}

}  // namespace ibkr::orchestrate
