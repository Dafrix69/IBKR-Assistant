#include "util/market_js.h"

#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/tz.h"

#include <QRegularExpression>

#include <QStringList>

#include <cmath>

using namespace Qt::StringLiterals;

namespace ibkr::util::market {

void sortNumbers(std::vector<double>& v) {
    jsSort(v, [](double a, double b) { return a - b; });
}

QString shown(const OJson& v) {
    const QString s = v.type == OJson::String ? v.s : js::stringify(v);
    return s.size() > 40 ? s.left(40) + u'…' : s;
}

QString encodeURIComponent(const QString& s) {
    static const QByteArray keep = "-_.!~*'()";
    return QString::fromLatin1(s.toUtf8().toPercentEncoding(keep));
}

bool onObjectPrototype(const QString& k) {
    static const QStringList names{u"constructor"_s,      u"__defineGetter__"_s, u"__defineSetter__"_s, u"hasOwnProperty"_s,
                                   u"__lookupGetter__"_s, u"__lookupSetter__"_s, u"isPrototypeOf"_s,    u"propertyIsEnumerable"_s,
                                   u"toString"_s,         u"valueOf"_s,          u"toLocaleString"_s,   u"__proto__"_s};
    return names.contains(k);
}

namespace {
// ToIntegerOrInfinity 之后按长度夹住
long long relIndex(long long length, double rel) {
    if (std::isnan(rel)) return 0;
    const double t = std::trunc(rel);
    if (t < 0) return t + double(length) < 0 ? 0 : (long long)(t + double(length));
    return t > double(length) ? length : (long long)t;
}
}  // namespace

SliceRange sliceRange(long long length, double start, double end) {
    const long long from = relIndex(length, start), to = relIndex(length, end);
    return {from, to < from ? from : to};
}

}  // namespace ibkr::util::market
