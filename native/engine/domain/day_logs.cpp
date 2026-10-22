#include "domain/day_logs.h"

#include "util/error.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/tz.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QRegularExpression>

#include <algorithm>
#include <cmath>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;

namespace ibkr::domain {

// ---------------------------------------------------------------- 共用
void JsonlDayFiles::append(const QString& date, const OJson& record) const {
    QDir().mkpath(dir_);
    QFile f(fileOf(date));
    // 0600 只在新建时生效(同 appendFileSync 的 mode)
    // 不带缓冲:写失败(磁盘满)当场知道并抛,同 appendFileSync;带缓冲的话失败发生在析构的 flush 里,没人看得见
    if (!f.open(QIODevice::WriteOnly | QIODevice::Append | QIODevice::Unbuffered, QFileDevice::ReadOwner | QFileDevice::WriteOwner))
        throw util::JsError(u"EACCES: permission denied, open '%1'"_s.arg(fileOf(date)));
    const QByteArray line = util::toNodeUtf8(js::stringify(record) + u'\n');
    if (f.write(line) != line.size() || !f.flush()) throw util::JsError(u"ENOSPC: no space left on device, write"_s);
}

QList<OJson> JsonlDayFiles::readValid(const QString& date, const std::function<bool(const OJson&)>& valid) const {
    QFile f(fileOf(date));
    if (!f.open(QIODevice::ReadOnly)) return {};
    const QString text = util::nodeUtf8(f.readAll());
    QList<OJson> out;
    for (const QString& line : text.split(u'\n')) {
        if (util::jsTrim(line).isEmpty()) continue;
        const auto raw = js::parse(line);
        if (raw && valid(*raw)) out << *raw;  // 写了一半的行、形状不对的行跳过
    }
    return out;
}

QStringList JsonlDayFiles::dates() const {
    QDir d(dir_);
    if (!d.exists()) return {};
    static const QRegularExpression re(u"^([0-9]{4}-[0-9]{2}-[0-9]{2})\\.jsonl\\z"_s);
    QStringList out;
    for (const QString& n : d.entryList(QDir::AllEntries | QDir::NoDotAndDotDot | QDir::Hidden | QDir::System, QDir::Unsorted)) {
        const auto m = re.match(n);
        if (m.hasMatch()) out << m.captured(1);
    }
    std::sort(out.begin(), out.end());
    return out;
}

double JsonlDayFiles::prune(double keep) const {
    const QStringList all = dates();
    const qsizetype dropN = qsizetype(std::max(0.0, double(all.size()) - keep));
    for (qsizetype i = 0; i < dropN; ++i) QFile::remove(fileOf(all[i]));  // 删不掉就留着,下次再试
    return double(dropN);
}

namespace {
const OJson* f(const OJson& o, const char16_t* k) { return o.get(QString::fromUtf16(k)); }
bool num(const OJson* v) { return v && v->type == OJson::Number && std::isfinite(v->n); }
bool numOrNull(const OJson* v) { return (v && v->type == OJson::Null) || num(v); }
bool isStr(const OJson* v) { return v && v->type == OJson::String; }
bool strIs(const OJson* v, std::initializer_list<const char16_t*> options) {
    if (!isStr(v)) return false;
    for (const char16_t* o : options)
        if (v->s == QString::fromUtf16(o)) return true;
    return false;
}
/// typeof x === "object" && x !== null
bool objectLike(const OJson& v) { return v.type == OJson::Object || v.type == OJson::Array; }

// ---- ivSamples.ts
bool validLeg(const OJson& leg) { return objectLike(leg) && num(f(leg, u"strike")) && strIs(f(leg, u"right"), {u"C", u"P"}); }
bool validSample(const OJson& s) {
    if (!objectLike(s)) return false;
    const OJson* t = f(s, u"t");
    const OJson* spot = f(s, u"spot");
    const OJson* legs = f(s, u"legs");
    if (!num(t) || !isStr(f(s, u"symbol")) || !isStr(f(s, u"expiry")) || !(spot && spot->type == OJson::Number && spot->n > 0) || !(legs && legs->type == OJson::Array))
        return false;
    for (const OJson& l : legs->items)
        if (!validLeg(l)) return false;
    return true;
}

// ---- playbookLog.ts
bool validBand(const OJson* b) {
    if (!b || !objectLike(*b)) return false;
    return num(f(*b, u"at")) && num(f(*b, u"anchor")) && num(f(*b, u"strike")) && isStr(f(*b, u"expiry")) && num(f(*b, u"call")) && num(f(*b, u"put")) &&
           num(f(*b, u"em")) && num(f(*b, u"lower")) && num(f(*b, u"upper")) && strIs(f(*b, u"source"), {u"live", u"backfill"});
}
bool validEvent(const OJson* e) {
    if (!e || !objectLike(*e)) return false;
    return num(f(*e, u"at")) && num(f(*e, u"level")) && num(f(*e, u"price")) && isStr(f(*e, u"state")) && strIs(f(*e, u"kind"), {u"enter", u"invalid", u"accel"});
}
bool validAnchor(const OJson* a) {
    if (!a || !objectLike(*a)) return false;
    return num(f(*a, u"at")) && num(f(*a, u"price")) && f(*a, u"price")->n > 0 && strIs(f(*a, u"source"), {u"live", u"backfill"});
}
bool validMachine(const OJson* m) {
    if (!m || !objectLike(*m)) return false;
    return num(f(*m, u"at")) && strIs(f(*m, u"state"), {u"B2", u"B3", u"R", u"none"}) && numOrNull(f(*m, u"trigger")) && numOrNull(f(*m, u"since")) &&
           numOrNull(f(*m, u"lost"));
}
bool validRecord(const OJson& r) {
    if (!objectLike(r)) return false;
    const OJson* kind = f(r, u"kind");
    if (strIs(kind, {u"event"})) return validEvent(f(r, u"event"));
    if (strIs(kind, {u"anchor"})) return validAnchor(f(r, u"anchor"));
    if (strIs(kind, {u"machine"})) return validMachine(f(r, u"machine"));
    return strIs(kind, {u"prior", u"open", u"frame"}) && validBand(f(r, u"band"));
}
}  // namespace

// ---------------------------------------------------------------- IV 样本
void IvSampleStore::append(const OJson& sample) const {
    JsonlDayFiles::append(util::dateStrAt(js::num(sample.get(u"t"_s)), QString::fromUtf16(util::kET)), sample);
}

QList<OJson> IvSampleStore::read(const QString& date) const {
    QList<OJson> out = readValid(date, validSample);
    std::stable_sort(out.begin(), out.end(), [](const OJson& a, const OJson& b) { return a.get(u"t"_s)->n < b.get(u"t"_s)->n; });
    return out;
}

QList<OJson> IvSampleStore::days() const {
    QList<OJson> out;
    for (const QString& date : dates()) {
        const double bytes = double(QFileInfo(fileOf(date)).size());  // 刚被删掉就是 0
        out << js::object({{u"date"_s, js::S(date)}, {u"samples"_s, js::N(double(read(date).size()))}, {u"bytes"_s, js::N(bytes)}});
    }
    return out;
}

// ---------------------------------------------------------------- 日内剧本
QList<OJson> PlaybookLog::read(const QString& date) const { return readValid(date, validRecord); }

}  // namespace ibkr::domain
