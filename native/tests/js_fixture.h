// 对拍夹具的读法(gen_fly_model.mjs、gen_flyexit.mjs 那一套):NaN / ±Infinity / −0 / undefined 在 JSON 里写不出来,写成占位串;
// 期望是 {out} 或 {error: "TypeError: …"}。
//
// 重做基线(IBKR_REBASELINE=目录):行为是刻意改的、原版又已删掉时用。对不上不报错,把期望就地换成 C++ 现算的那一份;
// 测试把整份夹具写进那个目录(rewrite),再由 tools/rebaseline_check.py 对着仓库里的旧夹具逐条归类——归不了类的差别不许拷回去。
#pragma once

#include "util/error.h"
#include "util/jsobj.h"
#include "util/ordered_json.h"

#include <QDir>
#include <QFile>
#include <QTest>

#include <cmath>
#include <limits>

namespace jsfix {

using ibkr::util::OJson;
namespace js = ibkr::util::js;

/// 占位串 → 值;"__undefined__" 的键删掉
inline OJson dec(const OJson& v) {
    using namespace Qt::StringLiterals;
    constexpr double inf = std::numeric_limits<double>::infinity();
    if (v.type == OJson::String) {
        if (v.s == u"__NaN__") return OJson::number(std::nan(""));
        if (v.s == u"__Inf__") return OJson::number(inf);
        if (v.s == u"__-Inf__") return OJson::number(-inf);
        if (v.s == u"__neg0__") return OJson::number(-0.0);
        return v;
    }
    if (v.type == OJson::Array) {
        OJson o = js::array();
        for (const OJson& x : v.items) o.items.append(dec(x));
        return o;
    }
    if (v.type == OJson::Object) {
        OJson o = js::object();
        for (const auto& [k, x] : v.fields)
            if (!(x.type == OJson::String && x.s == u"__undefined__")) o.set(k, dec(x));
        return o;
    }
    return v;
}
/// 值 → 夹具的写法
inline OJson enc(const OJson& v) {
    using namespace Qt::StringLiterals;
    constexpr double inf = std::numeric_limits<double>::infinity();
    if (v.type == OJson::Number) {
        if (std::isnan(v.n)) return OJson::string(u"__NaN__"_s);
        if (v.n == inf) return OJson::string(u"__Inf__"_s);
        if (v.n == -inf) return OJson::string(u"__-Inf__"_s);
        if (v.n == 0 && std::signbit(v.n)) return OJson::string(u"__neg0__"_s);
        return v;
    }
    if (v.type == OJson::Array) {
        OJson o = js::array();
        for (const OJson& x : v.items) o.items.append(enc(x));
        return o;
    }
    if (v.type == OJson::Object) {
        OJson o = js::object();
        for (const auto& [k, x] : v.fields) o.set(k, enc(x));
        return o;
    }
    return v;
}
/// 期望值里的 undefined 按 JSON.stringify 的样子落:对象里的键去掉,数组里的那一格是 null
inline OJson stripUndefined(const OJson& v) {
    if (v.type == OJson::Array) {
        OJson o = js::array();
        for (const OJson& x : v.items) o.items.append(x.type == OJson::String && x.s == u"__undefined__" ? OJson::null() : stripUndefined(x));
        return o;
    }
    if (v.type == OJson::Object) {
        OJson o = js::object();
        for (const auto& [k, x] : v.fields)
            if (!(x.type == OJson::String && x.s == u"__undefined__")) o.set(k, stripUndefined(x));
        return o;
    }
    return v;
}
inline bool isUndefined(const OJson* v) { return !v || (v->type == OJson::String && v->s == u"__undefined__"); }
inline double num(const OJson* v) { return dec(*v).n; }
/// "Error: …" / "TypeError: …" → 话
inline QString errorText(const QString& s) {
    const qsizetype colon = s.indexOf(QStringLiteral(": "));
    return colon < 0 ? s : s.mid(colon + 2);
}
inline OJson load(const QString& name) {
    QFile f(QStringLiteral(IBKR_FIXTURES_DIR) + u'/' + name);
    if (!f.open(QIODevice::ReadOnly)) qFatal("读不了夹具 %s", qPrintable(name));
    QString error;
    const auto parsed = ibkr::util::parseOJson(QString::fromUtf8(f.readAll()), &error);
    if (!parsed) qFatal("夹具 %s 不是 JSON:%s", qPrintable(name), qPrintable(error));
    return *parsed;
}

inline bool rebaselining() { return qEnvironmentVariableIsSet("IBKR_REBASELINE"); }
/// 重做基线时把整份夹具写到 IBKR_REBASELINE 目录(原文件是缩进两格的就照样缩进,否则紧凑)
inline void rewrite(const QString& name, const OJson& doc) {
    if (!rebaselining()) return;
    QFile orig(QStringLiteral(IBKR_FIXTURES_DIR) + u'/' + name);
    const bool pretty = orig.open(QIODevice::ReadOnly) && orig.read(2) == "{\n";
    const QString dir = qEnvironmentVariable("IBKR_REBASELINE");
    QDir().mkpath(dir);
    QFile f(dir + u'/' + name);
    if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate)) qFatal("写不进 %s", qPrintable(f.fileName()));
    f.write((ibkr::util::stringifyOJson(doc, pretty ? 2 : 0) + (pretty ? QStringLiteral("\n") : QString())).toUtf8());
}

/// 两份 JSON 逐字比,不一样时报出第一个不同的位置附近
inline bool same(const OJson& want, const OJson& got, const QString& what) {
    using namespace Qt::StringLiterals;
    const QString w = js::stringify(stripUndefined(want)), h = js::stringify(enc(got));
    if (w == h) return true;
    if (rebaselining()) {
        const_cast<OJson&>(want) = enc(got);
        return true;
    }
    qsizetype i = 0;
    while (i < w.size() && i < h.size() && w[i] == h[i]) ++i;
    const qsizetype from = qMax<qsizetype>(0, i - 120);
    QTest::qFail(qPrintable(u"%1:第 %2 个字符起不同\n  TS :%3\n  C++:%4"_s.arg(what, QString::number(i), w.mid(from, 300), h.mid(from, 300))), __FILE__, __LINE__);
    return false;
}
#define JSFIX_SAME(want, got, what)                          \
    do {                                                      \
        if (!jsfix::same((want), (got), (what))) return;      \
    } while (false)

/// 期望与实际都按夹具的写法比;期望是抛错时比话。用法:JSFIX_EXPECT(case, lambda, 说明)
template <class F>
bool expect(const OJson& c, F&& f, const QString& what) {
    using namespace Qt::StringLiterals;
    const OJson* err = c.get(u"error"_s);
    try {
        const OJson got = enc(f());
        if (err) {
            QTest::qFail(qPrintable(u"%1:TS 抛了「%2」,C++ 没抛,给了 %3"_s.arg(what, err->s, js::stringify(got).left(400))), __FILE__, __LINE__);
            return false;
        }
        const QString want = js::stringify(stripUndefined(*c.get(u"out"_s))), have = js::stringify(got);
        if (want != have && rebaselining()) {
            *const_cast<OJson&>(c).get(u"out"_s) = got;
            return true;
        }
        if (want != have) {
            qsizetype i = 0;
            while (i < want.size() && i < have.size() && want[i] == have[i]) ++i;
            const qsizetype from = qMax<qsizetype>(0, i - 120);
            QTest::qFail(qPrintable(u"%1:第 %2 个字符起不同\n  TS :%3\n  C++:%4"_s.arg(what, QString::number(i), want.mid(from, 300), have.mid(from, 300))), __FILE__, __LINE__);
            return false;
        }
    } catch (const ibkr::util::JsError& e) {
        if (!err) {
            QTest::qFail(qPrintable(u"%1:C++ 抛了「%2」,TS 没抛"_s.arg(what, e.message())), __FILE__, __LINE__);
            return false;
        }
        if (e.message() != errorText(err->s)) {
            QTest::qFail(qPrintable(u"%1:话不一样\n  TS :%2\n  C++:%3"_s.arg(what, errorText(err->s), e.message())), __FILE__, __LINE__);
            return false;
        }
    }
    return true;
}

}  // namespace jsfix

/// 比一个用例;不一样就结束当前测试函数
#define JSFIX_EXPECT(c, f, what)                         \
    do {                                                  \
        if (!jsfix::expect((c), (f), (what))) return;     \
    } while (false)
