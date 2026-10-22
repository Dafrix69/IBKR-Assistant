// util/zod 与 util/ordered_json 里早先被绕过去的缺口(tools/gen_zod_gaps.mjs,zod 3.25.76 与 JSON.parse 现跑):
//   · Issue 带 keys / expected / received / unionErrors(递归),与 zod 的 issue 一一对上;
//   · transform 可以返回 undefined(放进对象时键不出现、数组里是 null),入参也可以是 undefined;
//   · parseOJson 读数同 JSON.parse:上溢 → ±Infinity、下溢 → ±0(符号留着)、非规格化数的舍入边界。
#include "js_fixture.h"
#include "util/jsvalue.h"
#include "util/zod.h"

#include <QElapsedTimer>
#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using util::OJson;
namespace js = util::js;
namespace z = util::zod;

namespace {

z::SchemaPtr nullishTo(z::SchemaPtr s, std::optional<OJson> fallback) {
    return s->nullish()->transform([fallback](const OJson* v, z::CheckCtx&) -> std::optional<OJson> {
        if (!v || v->type == OJson::Null) return fallback;
        return *v;
    });
}
using Shape = std::vector<std::pair<QString, z::SchemaPtr>>;
z::SchemaPtr obj(Shape s) { return z::object(std::move(s)); }
z::SchemaPtr strictObj(Shape s) { return z::object(std::move(s))->strict(); }

z::SchemaPtr build(const QString& n) {
    const auto str = [] { return z::string(); };
    const auto num = [] { return z::number(); };
    if (n == u"req") return obj({{u"a"_s, str()}});
    if (n == u"strictObj") return strictObj({{u"a"_s, str()}, {u"b"_s, num()->optional()}});
    if (n == u"nestedStrict")
        return strictObj({{u"x"_s, strictObj({{u"y"_s, str()}})}, {u"z"_s, z::array(strictObj({{u"w"_s, num()}}))}});
    if (n == u"union3") return obj({{u"v"_s, z::unionOf({num(), str(), z::boolean()})}});
    if (n == u"unionObj") return z::unionOf({obj({{u"a"_s, str()}}), obj({{u"b"_s, num()}})});
    if (n == u"unionDeep")
        return obj({{u"v"_s, z::unionOf({obj({{u"c"_s, obj({{u"d"_s, num()}})}}), obj({{u"c"_s, obj({{u"d"_s, str()}})}})})}});
    if (n == u"unionNested") return obj({{u"v"_s, z::unionOf({z::unionOf({num(), str()}), z::boolean()})}});
    if (n == u"unionLit") return obj({{u"v"_s, z::unionOf({z::literal(OJson::string(QString())), z::literal(OJson::number(5))})}});
    if (n == u"unionDirty") return obj({{u"v"_s, z::unionOf({num()->integer(), str()})}});
    if (n == u"unionStrict") return obj({{u"v"_s, z::unionOf({strictObj({{u"a"_s, str()}}), strictObj({{u"b"_s, num()}})})}});
    if (n == u"arrUnion") return z::array(z::unionOf({str(), obj({{u"k"_s, num()}})}));
    if (n == u"enumField") return obj({{u"e"_s, z::enumOf({u"a"_s, u"b"_s})}});
    if (n == u"recordNum") return z::record(num());
    if (n == u"record2") return z::record(str(), obj({{u"n"_s, num()}}));
    if (n == u"numberChecks") return obj({{u"n"_s, num()->integer()->min(1)->max(5)}, {u"s"_s, z::str()->min(2)->max(3)}});
    if (n == u"pipeLike") return obj({{u"t"_s, z::str()->trim()->min(1)}});
    if (n == u"objUndef") return obj({{u"a"_s, nullishTo(str(), std::nullopt)}, {u"b"_s, num()}, {u"c"_s, nullishTo(num(), std::nullopt)}});
    if (n == u"objUndefStrict") return strictObj({{u"a"_s, nullishTo(str(), std::nullopt)}, {u"b"_s, nullishTo(str(), OJson::string(QString()))}});
    if (n == u"arrUndef") return z::array(nullishTo(num(), std::nullopt));
    if (n == u"recordUndef") return z::record(nullishTo(str(), std::nullopt));
    if (n == u"unknownT")
        return obj({{u"u"_s, z::unknown()->transform([](const OJson* v, z::CheckCtx&) -> std::optional<OJson> {
                         if (!v) return std::nullopt;
                         return *v;
                     })},
                    {u"w"_s, z::unknown()->transform([](const OJson* v, z::CheckCtx&) -> std::optional<OJson> {
                         if (!v) return OJson::string(u"was-undefined"_s);
                         return *v;
                     })}});
    if (n == u"optionalUnknownT")
        return obj({{u"u"_s, z::unknown()->optional()->transform([](const OJson* v, z::CheckCtx&) -> std::optional<OJson> {
                        if (!v) return std::nullopt;
                        return *v;
                    })}});
    if (n == u"topUndef") return z::unknown()->transform([](const OJson*, z::CheckCtx&) -> std::optional<OJson> { return std::nullopt; });
    if (n == u"litNull") return obj({{u"v"_s, z::literal(OJson::null())}});
    if (n == u"litTrue") return obj({{u"v"_s, z::literal(OJson::boolean(true))}});
    if (n == u"litFalse") return obj({{u"v"_s, z::literal(OJson::boolean(false))}});
    if (n == u"litStr") return obj({{u"v"_s, z::literal(OJson::string(u"x"_s))}});
    if (n == u"numBounds")
        return obj({{u"a"_s, num()->gte(1)}, {u"b"_s, num()->lte(5)}, {u"c"_s, num()->gt(1)}, {u"d"_s, num()->lt(5)}, {u"e"_s, num()->finite()->optional()}});
    if (n == u"strBounds") return obj({{u"s"_s, z::str()->min(2)->max(3)}});
    if (n == u"arrBounds") return z::array(num())->min(2)->max(3);
    if (n == u"passthroughObj") return z::object({{u"a"_s, str()}})->passthrough();
    if (n == u"recordEnumKey") return z::record(z::enumOf({u"a"_s, u"b"_s}), num());
    if (n == u"trimOnly") return obj({{u"t"_s, z::str()->trim()}});
    if (n == u"transformThenObj") return obj({{u"inner"_s, obj({{u"a"_s, nullishTo(str(), std::nullopt)}})}});
    qFatal("没有这个 schema:%s", qPrintable(n));
}

OJson encIssue(const z::Issue& i) {
    OJson o = js::object({{u"code"_s, js::S(i.code)}});
    OJson path = js::array();
    for (const QString& p : i.path) path.items << js::S(p);
    o.set(u"path"_s, path);
    o.set(u"message"_s, js::S(i.message));
    if (i.code == u"invalid_type") {
        o.set(u"expected"_s, js::S(i.expected));
        o.set(u"received"_s, js::S(i.received));
    }
    if (i.code == u"unrecognized_keys") {
        OJson keys = js::array();
        for (const QString& k : i.keys) keys.items << js::S(k);
        o.set(u"keys"_s, keys);
    }
    if (i.code == u"invalid_union") {
        OJson errors = js::array();
        for (const auto& branch : i.unionErrors) {
            OJson b = js::array();
            for (const z::Issue& x : branch) b.items << encIssue(x);
            errors.items << b;
        }
        o.set(u"unionErrors"_s, errors);
    }
    return o;
}

}  // namespace

class TestZodGaps : public QObject {
    Q_OBJECT
private slots:
    void issuesAndValuesMatchZod() {
        const OJson fx = jsfix::load(u"zod-gaps.json"_s);
        QHash<QString, z::SchemaPtr> schemas;
        for (const OJson& n : fx.get(u"schemas"_s)->items) schemas.insert(n.s, build(n.s));
        qsizetype rejected = 0, accepted = 0, unions = 0, undefinedKeys = 0;
        for (const OJson& c : fx.get(u"cases"_s)->items) {
            const QString name = c.get(u"s"_s)->s, text = c.get(u"t"_s)->s;
            const QString what = name + u" <- "_s + text;
            std::optional<OJson> raw;
            if (!text.isEmpty()) raw = util::parseOJson(text);
            if (!text.isEmpty()) QVERIFY2(raw, qPrintable(what));
            const z::SafeParse sp = z::safeParse(*schemas.value(name), raw ? &*raw : nullptr);
            if (const OJson* ok = c.get(u"ok"_s)) {
                ++accepted;
                if (!sp.success) QFAIL(qPrintable(u"%1:zod 通过,C++ 拒了:%2"_s.arg(what, sp.issues.empty() ? QString() : sp.issues.front().message)));
                if (!sp.data) {
                    QVERIFY2(jsfix::isUndefined(ok), qPrintable(what));
                    QCOMPARE(c.get(u"json"_s)->s, u"__undefined__"_s);
                    continue;
                }
                JSFIX_SAME(*ok, *sp.data, what);
                // JSON.stringify 的样子:undefined 的键不出现、数组里是 null
                QCOMPARE_EQ(util::stringifyOJson(*sp.data, 0), c.get(u"json"_s)->s);
                if (text.contains(u"null") && name.contains(u"Undef")) ++undefinedKeys;
                continue;
            }
            ++rejected;
            if (sp.success) QFAIL(qPrintable(u"%1:zod 拒了,C++ 通过"_s.arg(what)));
            OJson got = js::array();
            for (const z::Issue& i : sp.issues) got.items << encIssue(i);
            QCOMPARE_EQ(util::stringifyOJson(got, 0), util::stringifyOJson(*c.get(u"issues"_s), 0));
            for (const z::Issue& i : sp.issues)
                if (i.code == u"invalid_union") ++unions;
        }
        QVERIFY(rejected > 500);
        QVERIFY(accepted > 200);
        QVERIFY(unions > 40);
        QVERIFY2(undefinedKeys >= 5, qPrintable(QString::number(undefinedKeys)));
    }

    /// NaN 在 JSON 里写不出来,但 OJson 里有(别处算出来的数):zod 的类型名是 nan(夹不进夹具,值是 node 里 z.number().safeParse(NaN) 现看的)
    void nanIsReportedAsNan() {
        const OJson nan = js::N(std::nan(""));
        const z::SafeParse sp = z::safeParse(*z::number(), &nan);
        QVERIFY(!sp.success);
        QCOMPARE(sp.issues.size(), size_t(1));
        QCOMPARE(sp.issues[0].message, u"Expected number, received nan"_s);
        QCOMPARE(sp.issues[0].expected, u"number"_s);
        QCOMPARE(sp.issues[0].received, u"nan"_s);
        QCOMPARE(z::parsedTypeName(&nan), u"nan"_s);
    }

    /// parseOJson 自己的失败说明(不是 V8 的原话,V8 的原话在 v8JsonParseError):一种写错各一例,话钉住;嵌套太深也在这里
    void parseOJsonErrorTexts() {
        const QList<std::pair<QString, QString>> bad{
            {u""_s, u"第 1 个字符附近:内容不完整"_s},
            {u"-"_s, u"第 2 个字符附近:数字写得不对"_s},
            {u"1."_s, u"第 3 个字符附近:数字写得不对"_s},
            {u"1e"_s, u"第 3 个字符附近:数字写得不对"_s},
            {u"1e+"_s, u"第 4 个字符附近:数字写得不对"_s},
            {u"\"a\\x\""_s, u"第 5 个字符附近:认不出的转义"_s},
            {u"\"abc"_s, u"第 5 个字符附近:字符串没有收尾"_s},
            {u"\"a\u0001\""_s, u"第 4 个字符附近:字符串里有控制字符"_s},
            {u"\"\\u12\""_s, u"第 4 个字符附近:\\u 后面不是四位十六进制"_s},
            {u"[1 2]"_s, u"第 4 个字符附近:数组里少了逗号或 ]"_s},
            {u"["_s, u"第 2 个字符附近:内容不完整"_s},
            {u"[1,"_s, u"第 4 个字符附近:内容不完整"_s},
            {u"{a:1}"_s, u"第 2 个字符附近:键要用双引号"_s},
            {u"{ "_s, u"第 3 个字符附近:键要用双引号"_s},
            {u"{\"a\" 1}"_s, u"第 6 个字符附近:键后面少了冒号"_s},
            {u"{\"a\":1 \"b\"}"_s, u"第 8 个字符附近:对象里少了逗号或 }"_s},
            {u"1 2"_s, u"第 3 个字符附近:多出来的内容"_s},
            {u"x"_s, u"第 1 个字符附近:认不出的字符「x」"_s},
        };
        for (const auto& [text, want] : bad) {
            QString error;
            QVERIFY2(!util::parseOJson(text, &error), qPrintable(text));
            QCOMPARE(error, want);
        }
        // 空白:数组 / 对象开头与逗号前后都可以有
        QVERIFY(util::parseOJson(u"[ ]"_s));
        QVERIFY(util::parseOJson(u"{ }"_s));
        QVERIFY(util::parseOJson(u"[ 1 , 2 ]"_s));
        QVERIFY(util::parseOJson(u"{ \"a\" : 1 , \"b\" : [ ] }"_s));
        QVERIFY(util::parseOJson(u"\n\t\r 1 \n"_s));
        // 嵌套深度:上限那一层读得进,多一层读不进(话在 error 里)
        const auto nested = [](int d) { return QString(d, u'[') + QString(d, u']'); };
        QVERIFY(util::parseOJson(nested(util::kMaxJsonDepth)));
        QString error;
        QVERIFY(!util::parseOJson(nested(util::kMaxJsonDepth + 1), &error));
        QVERIFY2(error.endsWith(u"嵌套太深"_s), qPrintable(error));
        QVERIFY(util::parseOJson(u"{\"a\":"_s + nested(util::kMaxJsonDepth - 1) + u"}"_s));
        QVERIFY(!util::parseOJson(u"{\"a\":"_s + nested(util::kMaxJsonDepth) + u"}"_s));
        // 同一层的兄弟不累计深度
        QString flat = u"["_s;
        for (int i = 0; i < 3000; ++i) flat += u"[],"_s;
        flat += u"[]]"_s;
        QVERIFY(util::parseOJson(flat));
    }

    /// 对象解析的键序与「逐个 OJson::set」一模一样(重复的键值取后一个、位置留第一次;像下标的键按数值排最前),随机序列对拍
    void objectKeyOrderMatchesSequentialSet() {
        quint32 seed = 0x9e3779b9u;
        const auto rnd = [&seed](quint32 n) {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            return seed % n;
        };
        const QStringList pool{u"0"_s, u"1"_s, u"2"_s, u"7"_s, u"10"_s, u"11"_s, u"01"_s, u"-1"_s, u"4294967294"_s, u"4294967295"_s, u"a"_s, u"b"_s, u"c"_s, u"__proto__"_s, u""_s, u"1.5"_s, u"中"_s, u"constructor"_s};
        for (int round = 0; round < 400; ++round) {
            const int n = int(rnd(14));
            QString text = u"{"_s;
            OJson expected = js::object();
            for (int i = 0; i < n; ++i) {
                const QString key = pool[int(rnd(pool.size()))];
                if (i) text += u',';
                text += util::jsonQuote(key) + u':' + QString::number(i);
                expected.set(key, js::N(i));
            }
            text += u'}';
            const auto got = util::parseOJson(text);
            QVERIFY2(got, qPrintable(text));
            QCOMPARE(util::stringifyOJson(*got, 0), util::stringifyOJson(expected, 0));
        }
        // 嵌套对象里同样
        const auto nested = util::parseOJson(u"{\"b\":{\"2\":1,\"1\":2,\"x\":3,\"1\":9},\"1\":0,\"a\":[{\"z\":1,\"0\":2}]}"_s);
        QVERIFY(nested);
        QCOMPARE(util::stringifyOJson(*nested, 0), u"{\"1\":0,\"b\":{\"1\":9,\"2\":1,\"x\":3},\"a\":[{\"0\":2,\"z\":1}]}"_s);
    }

    /// 键很多时不能是二次方(一行几十万个不同的键曾经要跑几分钟):20 万个不同键、升序数字键、倒序数字键、20 万次重复同一个键,各限 2 秒
    void hugeObjectsParseInLinearTime() {
        const auto timed = [](const QString& what, const QString& text, qsizetype expectFields) {
            QElapsedTimer t;
            t.start();
            const auto got = util::parseOJson(text);
            const qint64 ms = t.elapsed();
            QVERIFY2(got, qPrintable(what));
            QCOMPARE(got->fields.size(), expectFields);
            // 二次方的版本这里要几分钟;ASan / UBSan 编法慢四五倍,门槛放宽到 20 秒仍然分得开
#if defined(__SANITIZE_ADDRESS__) || (defined(__has_feature) && __has_feature(address_sanitizer))
            constexpr qint64 limitMs = 20000;
#else
            constexpr qint64 limitMs = 8000;  // 线性解析 20 万键约 1 秒;平方级要 160 秒,8 秒照样分得出来,机器忙时不误报
#endif
            QVERIFY2(ms < limitMs, qPrintable(u"%1 用了 %2 ms"_s.arg(what).arg(ms)));
        };
        constexpr int n = 200000;
        QString distinct = u"{"_s, ascending = u"{"_s, descending = u"{"_s, dup = u"{"_s;
        for (int i = 0; i < n; ++i) {
            const QString sep = i ? u","_s : QString();
            distinct += sep + u"\"k"_s + QString::number(i) + u"\":1"_s;
            ascending += sep + u'"' + QString::number(i) + u"\":1"_s;
            descending += sep + u'"' + QString::number(n - 1 - i) + u"\":1"_s;
            dup += sep + u"\"same\":"_s + QString::number(i);
        }
        timed(u"不同的键"_s, distinct + u"}"_s, n);
        timed(u"升序数字键"_s, ascending + u"}"_s, n);
        timed(u"倒序数字键"_s, descending + u"}"_s, n);
        timed(u"重复的键"_s, dup + u"}"_s, 1);
        const auto first = util::parseOJson(u"{\"9\":0,\"3\":0,\"a\":0}"_s);
        QCOMPARE(first->fields[0].first, u"3"_s);
    }

    void parseOJsonNumbersMatchJsonParse() {
        const OJson fx = jsfix::load(u"zod-gaps.json"_s);
        for (const OJson& c : fx.get(u"numbers"_s)->items) {
            const QString t = c.get(u"t"_s)->s;
            const auto got = util::parseOJson(t);
            QVERIFY2(got, qPrintable(t));
            QCOMPARE(got->type, OJson::Number);
            JSFIX_SAME(*c.get(u"v"_s), *got, t);
            QCOMPARE(util::stringifyOJson(*got, 0), c.get(u"s"_s)->s);
        }
        // 夹在数组里、对象里、前后有空白时同样(数是从文本里切出来的,边界别吃掉别的字符)
        const auto arr = util::parseOJson(u" [1e-400 , -1e-400,1e999 ,-0] "_s);
        QVERIFY(arr);
        QCOMPARE(arr->items.size(), 4);
        QVERIFY(arr->items[0].n == 0 && !std::signbit(arr->items[0].n));
        QVERIFY(arr->items[1].n == 0 && std::signbit(arr->items[1].n));
        QVERIFY(std::isinf(arr->items[2].n) && arr->items[2].n > 0);
        QVERIFY(arr->items[3].n == 0 && std::signbit(arr->items[3].n));
    }
};

QTEST_GUILESS_MAIN(TestZodGaps)
#include "tst_zod_gaps.moc"
