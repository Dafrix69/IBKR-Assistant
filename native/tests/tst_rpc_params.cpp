// transport/params(engine-ts/src/rpc/params.ts)对着原模块现跑的答案(tests/fixtures/gen_rpc_params.mjs):
// symbolOrRaise / optFloat / optInt / drawdownArmOf / drawdownTiersOf / exitSettingsOf / stopSettingsOf。
// 入参是 JSON 文本(同 RPC 的读法);期望是 {out} 或 {error: "RpcError: …", code},逐字符比,键序在内。
#include "js_fixture.h"
#include "transport/params.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using util::OJson;
namespace js = util::js;

namespace {

OJson parsed(const QString& text) {
    QString error;
    const auto v = util::parseOJson(text, &error);
    if (!v) qFatal("输入不是 JSON:%s(%s)", qPrintable(text), qPrintable(error));
    return *v;
}

OJson optional(const std::optional<double>& v) { return js::NOrNull(v); }

/// 一例:f 算出值(或抛 util::RpcError);对 {out} / {error, code}
template <class F>
void check(const OJson& c, F&& f, const QString& what) {
    const OJson* err = c.get(u"error"_s);
    try {
        const OJson got = f();
        if (err) QFAIL(qPrintable(u"%1:TS 抛了「%2」,C++ 没抛,给了 %3"_s.arg(what, err->s, js::stringify(jsfix::enc(got)).left(300))));
        JSFIX_SAME(*c.get(u"out"_s), got, what);
    } catch (const util::RpcError& e) {
        if (!err) QFAIL(qPrintable(u"%1:C++ 抛了「%2」,TS 没抛"_s.arg(what, e.message())));
        if (e.message() != jsfix::errorText(err->s) || !err->s.startsWith(u"RpcError: "_s) || e.code() != int(c.get(u"code"_s)->n))
            QFAIL(qPrintable(u"%1:\n  TS :%2 (%3)\n  C++:%4 (%5)"_s.arg(what, err->s).arg(c.get(u"code"_s)->n).arg(e.message()).arg(e.code())));
    }
}

}  // namespace

class TestRpcParams : public QObject {
    Q_OBJECT
private slots:
    void symbolOrRaise() {
        const OJson fx = jsfix::load(u"rpc-params.json"_s);
        for (const OJson& c : fx.get(u"symbol"_s)->items) {
            const OJson p = parsed(c.get(u"p"_s)->s);
            check(c, [&] { return js::S(rpc::symbolOrRaise(p)); }, c.get(u"p"_s)->s);
        }
    }
    void optFloat() {
        const OJson fx = jsfix::load(u"rpc-params.json"_s);
        for (const OJson& c : fx.get(u"optFloat"_s)->items) {
            const QString t = c.get(u"v"_s)->s;
            const OJson p = t == u"__undefined__" ? OJson() : parsed(t);
            const OJson* v = t == u"__undefined__" ? nullptr : p.get(u"v"_s);
            check(c, [&] { return optional(rpc::optFloat(v)); }, t);
        }
    }
    void optInt() {
        const OJson fx = jsfix::load(u"rpc-params.json"_s);
        for (const OJson& c : fx.get(u"optInt"_s)->items) {
            const QString t = c.get(u"v"_s)->s;
            const OJson p = t == u"__undefined__" ? OJson() : parsed(t);
            const OJson* v = t == u"__undefined__" ? nullptr : p.get(u"v"_s);
            check(c, [&] { return optional(rpc::optInt(v)); }, t);
        }
    }
    void drawdownArmOf() {
        const OJson fx = jsfix::load(u"rpc-params.json"_s);
        for (const OJson& c : fx.get(u"arm"_s)->items) {
            const OJson p = parsed(c.get(u"p"_s)->s);
            check(c, [&] { return optional(rpc::drawdownArmOf(p)); }, c.get(u"p"_s)->s);
        }
    }
    void drawdownTiersOf() {
        const OJson fx = jsfix::load(u"rpc-params.json"_s);
        qsizetype ok = 0;
        for (const OJson& c : fx.get(u"tiers"_s)->items) {
            const OJson p = parsed(c.get(u"p"_s)->s);
            const OJson cost = jsfix::dec(*c.get(u"cost"_s));
            const bool undef = jsfix::isUndefined(c.get(u"cost"_s));
            std::optional<double> usd;
            if (!undef && cost.type == OJson::Number) usd = cost.n;
            check(c, [&] { return undef ? rpc::drawdownTiersOf(p) : rpc::drawdownTiersOf(p, usd); }, c.get(u"p"_s)->s + u" cost="_s + js::stringify(*c.get(u"cost"_s)));
            if (c.get(u"out"_s)) ++ok;
        }
        QVERIFY(ok > 100);
    }
    void exitSettingsOf() {
        const OJson fx = jsfix::load(u"rpc-params.json"_s);
        qsizetype ok = 0;
        for (const OJson& c : fx.get(u"exit"_s)->items) {
            const OJson p = parsed(c.get(u"p"_s)->s);
            const double now = jsfix::dec(*c.get(u"now"_s)).n;
            check(c, [&] { return rpc::exitSettingsOf(p, now); }, c.get(u"p"_s)->s + u" now="_s + js::stringify(*c.get(u"now"_s)));
            if (c.get(u"out"_s)) ++ok;
        }
        QVERIFY(ok > 100);
    }
    void stopSettingsOf() {
        const OJson fx = jsfix::load(u"rpc-params.json"_s);
        qsizetype ok = 0;
        for (const OJson& c : fx.get(u"stop"_s)->items) {
            const OJson p = parsed(c.get(u"p"_s)->s);
            check(c, [&] { return rpc::stopSettingsOf(p); }, c.get(u"p"_s)->s);
            if (c.get(u"out"_s)) ++ok;
        }
        QVERIFY(ok > 100);
    }
    void symbolMatches() {
        QVERIFY(rpc::symbolMatches(u"A"_s));
        QVERIFY(rpc::symbolMatches(u"AB.CD-EF1234"_s));
        QVERIFY(!rpc::symbolMatches(u"AB.CD-EF12345"_s));
        QVERIFY(!rpc::symbolMatches(u""_s));
        QVERIFY(!rpc::symbolMatches(u"1A"_s));
        QVERIFY(!rpc::symbolMatches(u"A\n"_s));  // JS 的 $ 不认串尾前的换行
        QVERIFY(!rpc::symbolMatches(u"a"_s));
    }
};

QTEST_GUILESS_MAIN(TestRpcParams)
#include "tst_rpc_params.moc"
