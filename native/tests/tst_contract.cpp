// engine/contract(契约方法的入参 schema)与 transport/contract_methods(rpc/contractMethods.ts)对着原模块现跑的答案
// (tests/fixtures/gen_contract.mjs):每一例是一段 JSON 文本(同 server.ts 的读法:JSON.parse),期望是引擎真走的那条路——
// contractMethods({[方法]: p => p})[方法](raw)——的结果:过了就是解出来的对象(逐字符比 JSON,键序在内),
// 不过就是 RpcError 的码与话,外加 zod 的 issue 清单(code / path / message)。
// 另外:登记表对得上(方法名、SENSITIVE_METHODS、顶层 strict 的那几个),钱路径方法的不认识的键穷举拒绝,
// 以及接进 RpcServer 之后的整条路(-32602 的话、handler 抛的 RpcError 的码)。
#include "contract/registry.h"
#include "js_fixture.h"
#include "transport/contract_methods.h"
#include "util/rpc_error.h"

#include <QJsonDocument>
#include <QCoreApplication>
#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using util::OJson;
namespace js = util::js;

namespace {

/// 夹具里的输入文本 → 值;"__undefined__" 是没有(undefined)
std::optional<OJson> rawOf(const QString& text) {
    if (text == u"__undefined__") return std::nullopt;
    QString error;
    const auto parsed = util::parseOJson(text, &error);
    if (!parsed) qFatal("输入不是 JSON:%s(%s)", qPrintable(text), qPrintable(error));
    return parsed;
}

struct Outcome {
    bool ok = false;
    OJson data;
    int code = 0;
    QString message;
};

Outcome callContract(const QString& method, const std::optional<OJson>& raw) {
    Outcome o;
    try {
        o.data = rpc::parseContractParams(method, raw ? &*raw : nullptr);
        o.ok = true;
    } catch (const util::RpcError& e) {
        o.code = e.code();
        o.message = e.message();
    }
    return o;
}

QString issuesText(const std::vector<contract::zod::Issue>& issues) {
    QStringList parts;
    for (const auto& i : issues) parts << u"%1|%2|%3"_s.arg(i.code, i.path.join(u'\u0001'), i.message);
    return parts.join(u"\n"_s);
}

OJson obj(std::initializer_list<std::pair<QString, OJson>> kv) { return js::object(kv); }

/// gen_contract.mjs 的 SYN:同一份描述,用 contract/kit.h 的积木再拼一遍
contract::ParamsSchema syntheticSchema(const QString& name) {
    namespace z = contract::zod;
    using contract::obj;
    using contract::optional;
    using contract::unionOf;
    const auto str = [] { return z::string(); };
    const auto num = [] { return z::number(); };
    const auto field = [](const QString& k, z::SchemaPtr s) { return std::pair<QString, z::SchemaPtr>{k, std::move(s)}; };
    const auto v = [&](z::SchemaPtr s) { return obj({field(u"v"_s, std::move(s))}); };
    const auto numStrNull = [&] { return unionOf({num(), str(), z::null()}); };
    if (name == u"u2obj") return v(unionOf({obj({field(u"a"_s, str())}), obj({field(u"b"_s, num())})}));
    if (name == u"uDeep")
        return v(unionOf({obj({field(u"a"_s, str()), field(u"c"_s, obj({field(u"d"_s, num())}))}),
                          obj({field(u"a"_s, str()), field(u"c"_s, obj({field(u"d"_s, str())}))})}));
    if (name == u"uDeepTie")
        return v(unionOf({obj({field(u"a"_s, obj({field(u"b"_s, str())}))}), obj({field(u"a"_s, obj({field(u"b"_s, num())}))})}));
    if (name == u"uDepths")
        return v(unionOf({obj({field(u"c"_s, obj({field(u"d"_s, num())}))}), obj({field(u"c"_s, obj({field(u"e"_s, num())}))}),
                          obj({field(u"x"_s, num())})}));
    if (name == u"uArr") return v(unionOf({z::array(num()), num()}));
    if (name == u"uNest") return v(unionOf({unionOf({num(), str()}), z::boolean()}));
    if (name == u"uLit") return v(unionOf({z::literal(OJson::string(QString())), z::literal(OJson::number(5))}));
    if (name == u"uEnum") return v(unionOf({z::enumOf({u"p"_s, u"q"_s}), num()}));
    if (name == u"uStrictArr")
        return v(unionOf({z::literal(OJson::string(QString())), z::array(obj({field(u"a"_s, numStrNull())})->strict())}));
    if (name == u"uTop") return unionOf({obj({field(u"a"_s, str())}), z::array(num())});
    if (name == u"strictNested")
        return obj({field(u"x"_s, optional(obj({field(u"y"_s, str())})->strict())), field(u"z"_s, z::array(obj({field(u"w"_s, num())})->strict()))})->strict();
    if (name == u"optionals")
        return obj({field(u"a"_s, optional(str())), field(u"b"_s, optional(unionOf({num(), str()}))), field(u"c"_s, optional(contract::truthyOf())),
                    field(u"d"_s, contract::requiredButReportedByHandler()), field(u"e"_s, optional(z::number()->nullable())),
                    field(u"f"_s, optional(obj({field(u"g"_s, num())})))});
    if (name == u"nullableUnion") return v(unionOf({z::number()->nullable(), str()}));
    if (name == u"recordU") return obj({field(u"r"_s, z::record(z::string(), unionOf({num(), str()})))});
    if (name == u"partialStrict")
        return obj({field(u"a"_s, z::boolean()), field(u"b"_s, z::number()->nullable()), field(u"c"_s, str())})->partial()->strict();
    if (name == u"noParams") return contract::noParams();
    if (name == u"literalNum") return obj({field(u"v"_s, z::literal(OJson::number(5))), field(u"w"_s, z::enumOf({u"a"_s, u"b"_s}))});
    qFatal("没有合成 schema %s", qPrintable(name));
}

/// 界面 Tracker.tsx 的 start() 拼出来的载荷(tracker-rpc.spec.ts 的 ui())
OJson uiPayload() {
    return obj({{u"key"_s, js::S(u"模拟|BE|STK"_s)}, {u"take_profit"_s, js::S({})}, {u"stop_loss"_s, js::S({})}, {u"trail_pct"_s, js::S({})},
                {u"profit_drawdown_pct"_s, js::S({})}, {u"spot_target"_s, js::S({})}, {u"auto_close"_s, js::B(false)},
                {u"order_type"_s, js::S(u"MKT"_s)}, {u"host_at_broker"_s, js::B(false)}});
}

}  // namespace

class TestContract : public QObject {
    Q_OBJECT
private slots:
    /// 全部用例:解出来的对象、拒绝的码与话、issue 清单
    void schemasMatchTs() {
        const OJson fx = jsfix::load(u"contract.json"_s);
        const OJson* cases = fx.get(u"cases"_s);
        QVERIFY(cases && cases->items.size() > 9000);
        qsizetype rejected = 0;
        for (const OJson& c : cases->items) {
            const QString method = c.get(u"m"_s)->s, text = c.get(u"t"_s)->s;
            const QString what = method + u" <- "_s + text.left(300);
            const auto raw = rawOf(text);
            const Outcome got = callContract(method, raw);
            if (const OJson* want = c.get(u"o"_s)) {
                if (!got.ok) QFAIL(qPrintable(u"%1:TS 通过,C++ 拒了:%2"_s.arg(what, got.message)));
                JSFIX_SAME(*want, got.data, what);
                continue;
            }
            ++rejected;
            const QString wantMessage = c.get(u"e"_s)->s;
            if (got.ok) QFAIL(qPrintable(u"%1:TS 拒了「%2」,C++ 通过,给了 %3"_s.arg(what, wantMessage, js::stringify(jsfix::enc(got.data)).left(300))));
            if (got.code != int(c.get(u"c"_s)->n) || got.message != wantMessage)
                QFAIL(qPrintable(u"%1:\n  TS :%2 %3\n  C++:%4 %5"_s.arg(what).arg(int(c.get(u"c"_s)->n)).arg(wantMessage).arg(got.code).arg(got.message)));
            // zod 的 issue 清单(code / path / message,先后也要一样);穷举的叶子用例没存清单,只比上面的码与话
            if (!c.get(u"i"_s)) continue;
            QStringList want;
            for (const OJson& i : c.get(u"i"_s)->items) {
                QStringList path;
                for (const OJson& p : i.items[1].items) path << p.s;
                want << u"%1|%2|%3"_s.arg(i.items[0].s, path.join(u'\u0001'), i.items[2].s);
            }
            const auto sp = contract::parseParams(method, raw ? &*raw : nullptr);
            QVERIFY2(!sp.success, qPrintable(what));
            QCOMPARE_EQ(issuesText(sp.issues), want.join(u"\n"_s));
        }
        QVERIFY(rejected > 3000);
    }

    /// 合成的 schema(真实 schema 里没有的形状:联合的两个分支都走得更深、联合套联合……):解出来的对象 / describeIssue / issue 清单对着 TS
    void syntheticMatchesTs() {
        const OJson fx = jsfix::load(u"contract.json"_s);
        QHash<QString, contract::ParamsSchema> schemas;
        qsizetype rejected = 0, unions = 0;
        for (const OJson& c : fx.get(u"synthetic"_s)->items) {
            const QString name = c.get(u"s"_s)->s, text = c.get(u"t"_s)->s;
            if (!schemas.contains(name)) schemas.insert(name, syntheticSchema(name));
            const auto raw = rawOf(text);
            const QString what = name + u" <- "_s + text.left(200);
            const auto sp = contract::zod::safeParse(*schemas.value(name), raw ? &*raw : nullptr);
            if (const OJson* want = c.get(u"o"_s)) {
                if (!sp.success) QFAIL(qPrintable(u"%1:TS 通过,C++ 拒了:%2"_s.arg(what, contract::describeIssue(sp.issues))));
                JSFIX_SAME(*want, sp.data.value_or(OJson()), what);
                continue;
            }
            ++rejected;
            if (sp.success) QFAIL(qPrintable(u"%1:TS 拒了「%2」,C++ 通过"_s.arg(what, c.get(u"d"_s)->s)));
            QCOMPARE_EQ(contract::describeIssue(sp.issues), c.get(u"d"_s)->s);
            QStringList want;
            for (const OJson& i : c.get(u"i"_s)->items) {
                QStringList path;
                for (const OJson& p : i.items[1].items) path << p.s;
                want << u"%1|%2|%3"_s.arg(i.items[0].s, path.join(u'\u0001'), i.items[2].s);
                if (i.items[0].s == u"invalid_union") ++unions;
            }
            QCOMPARE_EQ(issuesText(sp.issues), want.join(u"\n"_s));
        }
        QVERIFY(rejected > 600);
        QVERIFY(unions > 60);
    }

    /// 方法名、SENSITIVE_METHODS、顶层 strict 的那几个
    void registryMatchesTs() {
        const OJson fx = jsfix::load(u"contract.json"_s);
        QStringList names;
        for (const OJson& n : fx.get(u"names"_s)->items) names << n.s;
        QCOMPARE(contract::contractMethodNames(), names);
        QCOMPARE(contract::methodSpecs().size(), size_t(names.size()));
        QStringList sensitive;
        for (const OJson& n : fx.get(u"sensitive"_s)->items) sensitive << n.s;
        QCOMPARE(contract::sensitiveMethods(), sensitive);
        const OJson* strict = fx.get(u"strictTop"_s);
        for (const contract::MethodSpec& spec : contract::methodSpecs()) {
            const OJson* want = strict->get(spec.name);
            QVERIFY2(want, qPrintable(spec.name));
            QCOMPARE_EQ(spec.strictTop, want->b);
            QCOMPARE_EQ(spec.sensitive, sensitive.contains(spec.name));
            QVERIFY(contract::findMethod(spec.name) == &spec);
        }
        QVERIFY(!contract::findMethod(u"nope.method"_s));
        // 钱路径的四个方法顶层必须是 strict,且都是敏感方法(CLAUDE.md「引擎 ↔ 界面契约」)
        for (const QString& m : {u"tracker.add"_s, u"tracker.update"_s, u"tracker.close_now"_s, u"instruction.submit"_s}) {
            QVERIFY2(contract::findMethod(m)->strictTop, qPrintable(m));
            QVERIFY2(contract::findMethod(m)->sensitive, qPrintable(m));
        }
        // 没登记的方法:编程错误
        try {
            contract::parseParams(u"nope.method"_s, nullptr);
            QFAIL("应当抛");
        } catch (const util::JsError& e) {
            QCOMPARE(e.message(), u"Cannot read properties of undefined (reading 'safeParse')"_s);
        }
    }

    /// 钱路径:每一层对象里,各种不认识的键都当场拒;载荷里已登记的每个键都收
    void moneyPathRejectsUnknownKeys_data() {
        QTest::addColumn<QString>("method");
        QTest::addColumn<QString>("payload");
        QTest::newRow("add ui") << u"tracker.add"_s << js::stringify(uiPayload());
        QTest::newRow("add full") << u"tracker.add"_s
                                  << u"{\"key\":\"k\",\"take_profit\":\"1\",\"stop_loss\":2,\"trail_pct\":\"3\",\"profit_drawdown_pct\":\"4\","
                                     "\"profit_drawdown_preset\":\"fly\",\"profit_drawdown_tiers\":[{\"above\":\"0\",\"pct\":\"35\"}],"
                                     "\"profit_drawdown_late\":{\"after\":\"15:30\",\"factor\":\"0.6\"},\"profit_drawdown_arm_pct\":\"5\","
                                     "\"spot_target\":\"1\",\"spot_stop_below\":\"1\",\"spot_stop_above\":\"1\",\"spot_stop_confirm_s\":\"1\","
                                     "\"exit_at\":\"15:45\",\"take_profit_tiers\":[{\"price\":\"1\",\"fraction_pct\":\"50\"}],\"auto_close\":true,"
                                     "\"order_type\":\"LMT\",\"slippage_pct\":\"0.5\",\"close_fraction_pct\":\"50\",\"host_at_broker\":true,"
                                     "\"chase_max_pct\":\"0\",\"stop_basis\":\"mid\",\"stop_chase_grace\":\"2\",\"stop_chase_step\":1,"
                                     "\"stop_chase_max_pct\":\"10\",\"peak_confirm\":true,\"note\":\"n\"}"_s;
        QTest::newRow("update full") << u"tracker.update"_s
                                     << u"{\"id\":\"a\",\"enabled\":false,\"auto_close\":{\"enabled\":true,\"order_type\":\"LMT\",\"slippage_pct\":1,"
                                        "\"close_fraction_pct\":50,\"host_at_broker\":false,\"chase_max_pct\":5,\"stop_basis\":\"mid\","
                                        "\"stop_chase_grace\":null,\"stop_chase_step\":2,\"stop_chase_max_pct\":null,\"peak_confirm\":true},"
                                        "\"take_profit\":\"1\",\"stop_loss\":\"\",\"trail_pct\":null,\"profit_drawdown_pct\":1,\"profit_drawdown_preset\":\"fly\","
                                        "\"profit_drawdown_tiers\":[{\"above\":0,\"pct\":null}],\"profit_drawdown_late\":{\"after\":\"15:30\",\"factor\":1},"
                                        "\"profit_drawdown_arm_pct\":1,\"spot_target\":1,\"spot_stop_below\":1,\"spot_stop_above\":1,\"spot_stop_confirm_s\":1,"
                                        "\"exit_at\":\"15:45\",\"take_profit_tiers\":[{\"price\":null,\"fraction_pct\":1}]}"_s;
        QTest::newRow("close_now") << u"tracker.close_now"_s << u"{\"id\":\"a\"}"_s;
        QTest::newRow("delete") << u"tracker.delete"_s << u"{\"id\":\"a\"}"_s;
        QTest::newRow("preview") << u"tracker.target_preview"_s << u"{\"key\":\"k\",\"spot_target\":\"1\",\"chase_max_pct\":1}"_s;
        QTest::newRow("instruction") << u"instruction.submit"_s << u"{\"text\":\"t\",\"execute\":true,\"accounts\":[\"模拟\"],\"channel\":\"c\"}"_s;
    }
    void moneyPathRejectsUnknownKeys() {
        QFETCH(QString, method);
        QFETCH(QString, payload);
        const OJson base = *util::parseOJson(payload);
        QVERIFY2(callContract(method, base).ok, qPrintable(method + u" 的合法载荷被拒了"_s));
        // 每一层对象(含数组里的、嵌套的)各加一个不认识的键
        const QStringList badKeys{u"stoploss"_s, u"stop_loss "_s, u"takeProfit"_s, u"__proto__"_s, u"constructor"_s, u""_s, u"1"_s, u"note2"_s, u"中"_s};
        qsizetype tried = 0;
        std::function<void(const OJson&, const QList<std::variant<QString, qsizetype>>&)> walk;
        const auto at = [](OJson& root, const QList<std::variant<QString, qsizetype>>& path) -> OJson* {
            OJson* cur = &root;
            for (const auto& step : path) cur = std::holds_alternative<QString>(step) ? cur->get(std::get<QString>(step)) : &cur->items[std::get<qsizetype>(step)];
            return cur;
        };
        walk = [&](const OJson& node, const QList<std::variant<QString, qsizetype>>& path) {
            if (node.type == OJson::Array) {
                for (qsizetype i = 0; i < node.items.size(); ++i) walk(node.items[i], path + QList<std::variant<QString, qsizetype>>{i});
            } else if (node.type == OJson::Object) {
                for (const auto& f : node.fields) walk(f.second, path + QList<std::variant<QString, qsizetype>>{f.first});
                for (const QString& bad : badKeys) {
                    OJson mutated = base;
                    at(mutated, path)->set(bad, js::N(1));
                    const Outcome got = callContract(method, mutated);
                    QVERIFY2(!got.ok, qPrintable(u"%1:在 %2 层加了键「%3」,被收下了"_s.arg(method).arg(path.size()).arg(bad)));
                    QCOMPARE(got.code, -32602);
                    QVERIFY2(got.message.startsWith(method + u" 的参数不对:"_s), qPrintable(got.message));
                    QVERIFY2(got.message.contains(u"有不认识的键:"_s + bad), qPrintable(got.message));
                    ++tried;
                }
            }
        };
        walk(base, {});
        QVERIFY(tried >= badKeys.size());
    }

    /// 界面真实载荷(数值是字符串,'' = 不设)原样收下,解出来键序同 shape
    void trackerUiPayload() {
        const Outcome o = callContract(u"tracker.add"_s, uiPayload());
        QVERIFY(o.ok);
        QCOMPARE(js::stringify(o.data),
                 u"{\"key\":\"模拟|BE|STK\",\"take_profit\":\"\",\"stop_loss\":\"\",\"trail_pct\":\"\",\"profit_drawdown_pct\":\"\",\"spot_target\":\"\","
                  "\"auto_close\":false,\"order_type\":\"MKT\",\"host_at_broker\":false}"_s);
        // 键序按 shape,不按来稿:同样的键倒过来写
        OJson reversed = js::object();
        for (qsizetype i = uiPayload().fields.size() - 1; i >= 0; --i) reversed.set(uiPayload().fields[i].first, uiPayload().fields[i].second);
        QCOMPARE(js::stringify(callContract(u"tracker.add"_s, reversed).data), js::stringify(o.data));
        // 授权发单的两个开关只收布尔
        OJson bad = uiPayload();
        bad.set(u"auto_close"_s, js::S(u"false"_s));
        const Outcome rejected = callContract(u"tracker.add"_s, bad);
        QVERIFY(!rejected.ok);
        QCOMPARE(rejected.message, u"tracker.add 的参数不对:auto_close 应为 boolean,收到 string"_s);
        bad = uiPayload();
        bad.set(u"host_at_broker"_s, js::N(1));
        QCOMPARE(callContract(u"tracker.add"_s, bad).message, u"tracker.add 的参数不对:host_at_broker 应为 boolean,收到 number"_s);
        // 没有 key:schema 报「缺少 key」(不是 handler 的话)
        OJson noKey = uiPayload();
        noKey.remove(u"key"_s);
        QCOMPARE(callContract(u"tracker.add"_s, noKey).message, u"tracker.add 的参数不对:缺少 key"_s);
        // close_now 不带 id 照样过(handler 报「没有这个追踪」),解成空串
        QCOMPARE(js::stringify(callContract(u"tracker.close_now"_s, js::object()).data), u"{\"id\":\"\"}"_s);
    }

    void describeEmptyIssues() { QCOMPARE(contract::describeIssue({}), u"参数不对"_s); }

    /// 接进 RpcServer:-32602 的话、handler 的返回、handler 抛的 util::RpcError 的码
    void serverPlugIn() {
        QStringList lines;
        rpc::RpcServer server([&lines](const QByteArray& l) { lines << QString::fromUtf8(l); });
        OJson seen;
        rpc::addContractMethod(server, u"tracker.add"_s, [&seen](const OJson& p) {
            seen = p;
            return js::object({{u"ok"_s, js::B(true)}});
        });
        rpc::addContractMethod(server, u"tracker.close_now"_s, [](const OJson&) -> OJson { throw util::RpcError(-32602, u"没有这个追踪"_s); });
        rpc::addContractMethod(server, u"alerts.list"_s, [](const OJson& p) { return js::object({{u"n"_s, js::N(double(p.fields.size()))}}); });
        try {
            rpc::addContractMethod(server, u"nope"_s, [](const OJson&) { return OJson(); });
            QFAIL("应当抛");
        } catch (const util::JsError& e) {
            QCOMPARE(e.message(), u"契约里没有这个方法:nope"_s);
        }
        const auto reply = [&](const QString& line) -> QJsonObject {
            lines.clear();
            server.handleLine(line.toUtf8());
            QCoreApplication::processEvents();  // 交易道的回执在下一轮事件循环里写
            if (lines.size() != 1) qFatal("一行请求应得一行回执");
            return QJsonDocument::fromJson(lines[0].toUtf8()).object();
        };
        auto r = reply(u"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tracker.add\",\"params\":{\"key\":\"k\",\"stoploss\":\"1\"}}"_s);
        QCOMPARE(r.value(u"error"_s).toObject().value(u"code"_s).toInt(), -32602);
        QCOMPARE(r.value(u"error"_s).toObject().value(u"message"_s).toString(),
                 u"tracker.add 的参数不对:有不认识的键:stoploss(这个方法不收没登记的键,没有照单全收)"_s);
        r = reply(u"{\"id\":2,\"method\":\"tracker.add\",\"params\":{\"key\":\"k\",\"stop_loss\":\"95\"}}"_s);
        QCOMPARE(r.value(u"result"_s).toObject().value(u"ok"_s).toBool(), true);
        QCOMPARE(js::stringify(seen), u"{\"key\":\"k\",\"stop_loss\":\"95\"}"_s);
        r = reply(u"{\"id\":3,\"method\":\"tracker.close_now\",\"params\":{}}"_s);
        QCOMPARE(r.value(u"error"_s).toObject().value(u"code"_s).toInt(), -32602);
        QCOMPARE(r.value(u"error"_s).toObject().value(u"message"_s).toString(), u"没有这个追踪"_s);
        // params 没带:RpcServer 换成 {}
        QCOMPARE(reply(u"{\"id\":4,\"method\":\"alerts.list\"}"_s).value(u"result"_s).toObject().value(u"n"_s).toInt(), 0);
        // 多余的键对不收参数的方法不看
        QCOMPARE(reply(u"{\"id\":5,\"method\":\"alerts.list\",\"params\":{\"x\":1}}"_s).value(u"result"_s).toObject().value(u"n"_s).toInt(), 0);
        // params 不是对象
        r = reply(u"{\"id\":6,\"method\":\"tracker.add\",\"params\":[1]}"_s);
        QCOMPARE(r.value(u"error"_s).toObject().value(u"message"_s).toString(), u"tracker.add 的参数不对:params 应为 object,收到 array"_s);
        r = reply(u"{\"id\":7,\"method\":\"tracker.add\",\"params\":5}"_s);
        QCOMPARE(r.value(u"error"_s).toObject().value(u"message"_s).toString(), u"tracker.add 的参数不对:params 应为 object,收到 number"_s);
    }
};

QTEST_GUILESS_MAIN(TestContract)
#include "tst_contract.moc"
