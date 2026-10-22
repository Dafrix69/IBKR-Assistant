#include "util/py.h"

#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsnum.h"
#include "util/jsvalue.h"

#include <QJsonArray>
#include <QRegularExpression>

#include <cmath>

namespace ibkr::util {

using namespace Qt::StringLiterals;

namespace {
QString nonFinite(double v) { return v > 0 ? u"inf"_s : std::isnan(v) ? u"nan"_s : u"-inf"_s; }
bool isInteger(double v) { return std::isfinite(v) && std::trunc(v) == v; }
}  // namespace

double pyRound(double x, int nd) {
    if (!std::isfinite(x)) return x;
    const double sign = x < 0 ? -1 : 1;
    const double ax = std::fabs(x);
    if (ax >= 1e21) return x;  // toFixed 之外的量级,交易数值不会到这里
    const int expand = std::min(100, std::max(nd + 55, 20));
    const QString s = jsToFixed(ax, expand);
    const qsizetype dot = s.indexOf(u'.');
    const QString frac = s.mid(dot + 1);
    const QString tail = frac.mid(nd);
    static const QRegularExpression half(u"^50*\\z"_s);
    if (half.match(tail).hasMatch()) {
        // 精确平局 → 取偶
        const QString truncStr = nd > 0 ? s.left(dot) + u'.' + frac.left(nd) : s.left(dot);
        const int lastDigit = nd > 0 ? frac[nd - 1].digitValue() : s[dot - 1].digitValue();
        double out = jsParseFloat(truncStr);
        if (lastDigit % 2 == 1) out = jsParseFloat(jsToFixed(out + jsmath::pow(10.0, -nd), nd));
        return sign * out;
    }
    return sign * jsParseFloat(jsToFixed(ax, nd));
}

QString fmtF(double x, int nd) {
    if (!std::isfinite(x)) return nonFinite(x);
    QString s = jsToFixed(pyRound(x, nd), nd);
    if ((x < 0 || (x == 0 && std::signbit(x))) && !s.startsWith(u'-') && jsStringToNumber(s) == 0) s = u'-' + s;
    return s;
}

QString fmtSF(double x, int nd) {
    const QString s = fmtF(x, nd);
    return s.startsWith(u'-') ? s : u'+' + s;
}

QString pyG(double v) {
    if (v == 0) return std::signbit(v) ? u"-0"_s : u"0"_s;
    if (!std::isfinite(v)) return nonFinite(v);
    const QString exp = jsToExponential(v, 5);
    const qsizetype at = exp.indexOf(u'e');
    QString m = exp.left(at);
    const int e = exp.mid(at + 1).toInt();
    static const QRegularExpression zeros(u"0+\\z"_s), dotEnd(u"\\.\\z"_s);
    if (e < -4 || e >= 6) {
        if (m.contains(u'.')) m = m.remove(zeros).remove(dotEnd);
        return m + u'e' + (e < 0 ? u'-' : u'+') + QString::number(std::abs(e)).rightJustified(2, u'0');
    }
    QString s = jsToFixed(v, std::max(0, 5 - e));
    if (s.contains(u'.')) s = s.remove(zeros).remove(dotEnd);
    return s;
}

QString pyFloat(double v) {
    if (!std::isfinite(v)) return nonFinite(v);
    if (isInteger(v) && std::fabs(v) < 1e16) return (v == 0 && std::signbit(v) ? u"-0"_s : jsNumberToString(v)) + u".0"_s;
    const double a = std::fabs(v);
    if (a >= 1e16 || (a > 0 && a < 1e-4)) {
        // Python repr 在这个区间转科学计数;JS 的阈值不同(<1e-6 / >=1e21),补齐差异(最短表示)
        const QString exp = jsToExponentialShortest(v);
        const qsizetype at = exp.indexOf(u'e');
        const int e = exp.mid(at + 1).toInt();
        return exp.left(at) + u'e' + (e < 0 ? u'-' : u'+') + QString::number(std::abs(e)).rightJustified(2, u'0');
    }
    const QString s = jsNumberToString(v);
    static const QRegularExpression sci(u"^(-?[\\d.]+)e([+-])(\\d+)\\z"_s);
    const auto m = sci.match(s);
    if (m.hasMatch()) return m.captured(1) + u'e' + m.captured(2) + m.captured(3).rightJustified(2, u'0');
    return s;
}

QString pyRepr(const QJsonValue& v) {
    if (v.isNull() || v.isUndefined()) return u"None"_s;
    if (v.isBool()) return v.toBool() ? u"True"_s : u"False"_s;
    if (v.isDouble()) {
        const double d = v.toDouble();
        return isInteger(d) ? jsNumberToString(d) : pyFloat(d);
    }
    if (v.isString()) {
        const QString s = v.toString();
        const bool useDouble = s.contains(u'\'') && !s.contains(u'"');
        const QChar q = useDouble ? u'"' : u'\'';
        QString out = q;
        for (const QChar ch : s) {
            if (ch == u'\\') out += u"\\\\"_s;
            else if (ch == q) out += u'\\' + QString(q);
            else if (ch == u'\n') out += u"\\n"_s;
            else if (ch == u'\r') out += u"\\r"_s;
            else if (ch == u'\t') out += u"\\t"_s;
            else out += ch;
        }
        return out + q;
    }
    return jsString(v);
}

QString fmtD(double x) {
    return jsNumberToString(std::trunc(x));
}

bool truthy(const QJsonValue& v) {
    switch (v.type()) {
    case QJsonValue::Null:
    case QJsonValue::Undefined: return false;
    case QJsonValue::Bool: return v.toBool();
    case QJsonValue::Double: return v.toDouble() != 0;  // NaN != 0 → 真,同 Python
    case QJsonValue::String: return !v.toString().isEmpty();
    case QJsonValue::Array: return !v.toArray().isEmpty();
    case QJsonValue::Object: return true;
    }
    return false;
}

std::optional<double> finiteOrNull(const QJsonValue& v) {
    if (v.isNull() || v.isUndefined() || v.isBool()) return std::nullopt;
    const double out = v.isDouble() ? v.toDouble() : jsNumber(v);
    return std::isfinite(out) ? std::optional<double>(out) : std::nullopt;
}

}  // namespace ibkr::util
