#include "domain/terrain_log.h"
#include "util/error.h"
#include "util/jsobj.h"
#include "util/redact.h"
#include "util/tz.h"
#include <QDate>
#include <QDir>
#include <QFile>
#include <algorithm>
#include <cmath>

namespace ibkr::domain {
using namespace Qt::StringLiterals;
using util::OJson;
namespace js = util::js;
namespace {
bool number(const OJson* p) { return p && p->type == OJson::Number && std::isfinite(p->n); }
void dateCheck(const QString& date) {
    if (QDate::fromString(date, Qt::ISODate).toString(Qt::ISODate) != date || date.size() != 10)
        throw util::JsError(u"地形日期必须是 YYYY-MM-DD"_s);
}
OJson numeric(const OJson& src, std::initializer_list<const char16_t*> keys) {
    OJson out = js::object();
    for (const auto k : keys) {
        const QString key = QString::fromUtf16(k);
        const auto p = src.get(key);
        out.set(key, number(p) ? *p : js::Null());
    }
    return out;
}
OJson project(const OJson& src) {
    OJson out = numeric(src, {u"spot", u"net_gex", u"gross_gex", u"net_gex_ratio", u"gamma_flip", u"oi_missing", u"multiplier"});
    const auto expiry = src.get(u"expiry"_s);
    out.set(u"expiry"_s, expiry && expiry->type == OJson::String && QDate::fromString(expiry->s, u"yyyyMMdd"_s).isValid() ? *expiry : js::Null());
    const auto regime = src.get(u"regime"_s);
    out.set(u"regime"_s, regime && regime->type == OJson::String && QStringList{u"positive"_s,u"negative"_s,u"neutral"_s,u"unknown"_s}.contains(regime->s) ? *regime : js::S(u"unknown"_s));
    OJson rows = js::array();
    if (const auto p = src.get(u"strikes"_s); p && p->type == OJson::Array)
        for (const auto& r : p->items) rows.items.append(numeric(r, {u"strike",u"call_oi",u"put_oi",u"call_vol",u"put_vol",u"net_gex"}));
    out.set(u"strikes"_s, rows);
    for (const auto key : {u"call_wall"_s,u"put_wall"_s,u"call_vol_wall"_s,u"put_vol_wall"_s}) {
        const auto p = src.get(key);
        out.set(key, p && p->type == OJson::Object ? numeric(*p,{u"strike",u"size",u"distance_pct"}) : js::Null());
    }
    const auto c = src.get(u"coverage"_s);
    OJson coverage = numeric(c ? *c : js::Null(),{u"lower",u"upper",u"strikes",u"grid_strikes"});
    const auto thinned = c ? c->get(u"thinned"_s) : nullptr;
    coverage.set(u"thinned"_s, thinned && thinned->type == OJson::Bool ? *thinned : js::Null());
    out.set(u"coverage"_s, coverage);
    return out;
}
bool valid(const OJson& r) {
    if (r.type != OJson::Object || r.fields.size() != 9) return false;
    const auto symbol = r.get(u"symbol"_s), model = r.get(u"model_version"_s);
    const auto marketAt = r.get(u"market_at"_s), marketType = r.get(u"market_data_type"_s);
    if (!symbol || symbol->type != OJson::String || symbol->s != u"SPX" || !model || model->type != OJson::String || model->s != u"oi-gex-v1" ||
        !marketAt || marketAt->type != OJson::Null || !marketType || marketType->type != OJson::Null) return false;
    const auto version = r.get(u"schema_version"_s), at = r.get(u"received_at"_s), start = r.get(u"requested_at"_s);
    const auto status = r.get(u"status"_s), wall = r.get(u"wall"_s);
    if (!number(version) || version->n != 1 || !number(at) || !number(start) || start->n <= 0 || at->n < start->n || !status || status->type != OJson::String) return false;
    if (status->s == u"refresh_failed") return wall && wall->type == OJson::Null;
    if (status->s != u"observed" || !wall || wall->type != OJson::Object) return false;
    return js::stringify(project(*wall)) == js::stringify(*wall);
}
}
void TerrainLog::record(double requestedAt, double receivedAt, const OJson* wall) {
    if (!std::isfinite(requestedAt) || !std::isfinite(receivedAt) || requestedAt <= 0 || receivedAt < requestedAt)
        throw util::JsError(u"地形采集时间无效"_s);
    const QString date = util::dateStrAt(receivedAt, QString::fromUtf16(util::kET));
    OJson r = js::object({{u"schema_version"_s,js::N(1)}, {u"model_version"_s,js::S(u"oi-gex-v1"_s)},
        {u"symbol"_s,js::S(u"SPX"_s)}, {u"requested_at"_s,js::N(requestedAt)}, {u"received_at"_s,js::N(receivedAt)},
        {u"market_at"_s,js::Null()}, {u"market_data_type"_s,js::Null()},
        {u"status"_s,js::S(wall ? u"observed"_s : u"refresh_failed"_s)}, {u"wall"_s,wall ? project(*wall) : js::Null()}});
    QDir().mkpath(dir());
    QFile f(fileOf(date));
    if (!f.open(QIODevice::ReadWrite | QIODevice::Unbuffered, QFileDevice::ReadOwner | QFileDevice::WriteOwner))
        throw util::JsError(u"地形记录文件无法写入"_s);
    // 断电留下半行时先隔开,下一条有效记录不能与坏尾行粘在一起。
    QByteArray prefix;
    if (f.size() > 0) { f.seek(f.size()-1); if (f.read(1) != "\n") prefix = "\n"; }
    f.seek(f.size());
    const QByteArray bytes = prefix + util::maskAccountLikeIds(js::stringify(r)).toUtf8() + '\n';
    if (f.write(bytes) != bytes.size() || !f.flush()) throw util::JsError(u"地形记录写入失败"_s);
}
QList<OJson> TerrainLog::read(const QString& date, int* rejected) const {
    dateCheck(date);
    if (rejected) *rejected = 0;
    QFile f(fileOf(date));
    if (!f.exists()) return {};
    if (!f.open(QIODevice::ReadOnly)) throw util::JsError(u"地形记录文件无法读取"_s);
    QList<OJson> out;
    while (!f.atEnd()) {
        const auto line = f.readLine().trimmed();
        if (line.isEmpty()) continue;
        auto r = js::parse(QString::fromUtf8(line));
        if (!r || !valid(*r) || util::dateStrAt(r->get(u"received_at"_s)->n, QString::fromUtf16(util::kET)) != date) {
            if (rejected) ++*rejected;
            continue;
        }
        out.append(*r);
    }
    std::stable_sort(out.begin(),out.end(),[](const OJson& a,const OJson& b){return a.get(u"received_at"_s)->n < b.get(u"received_at"_s)->n;});
    return out;
}
OJson TerrainLog::replay(const QString& date, double asOf, double maxAgeMs) const {
    if (!std::isfinite(asOf) || !std::isfinite(maxAgeMs) || maxAgeMs < 0) throw util::JsError(u"回放时间与最大帧龄无效"_s);
    dateCheck(date);
    if (util::dateStrAt(asOf, QString::fromUtf16(util::kET)) != date) throw util::JsError(u"回放时刻必须属于指定美东日期"_s);
    int rejected = 0;
    const auto rows = read(date,&rejected);
    const OJson* last = nullptr;
    int visible = 0;
    for (const auto& r : rows) if (r.get(u"received_at"_s)->n <= asOf) { last = &r; ++visible; }
    QString status = u"no_data"_s;
    OJson age = js::Null();
    if (last) {
        age = js::N(asOf-last->get(u"received_at"_s)->n);
        status = last->get(u"status"_s)->s == u"refresh_failed" ? u"refresh_failed"_s : age.n > maxAgeMs ? u"stale"_s : u"observed_market_age_unknown"_s;
    }
    // 损坏行可能正是失败标记,有损坏时不把最后成功帧当作完整回放。
    if (rejected) status = u"incomplete_log"_s;
    return js::object({{u"as_of"_s,js::N(asOf)}, {u"status"_s,js::S(status)}, {u"observation_age_ms"_s,age},
        {u"visible_records"_s,js::N(visible)}, {u"rejected_records"_s,js::N(rejected)}, {u"record"_s,last ? *last : js::Null()}});
}
}  // namespace ibkr::domain
