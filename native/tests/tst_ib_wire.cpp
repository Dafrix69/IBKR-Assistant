// TWS 线协议(wire_out / wire_in)对拍:fixtures/ib-wire-*.json 是 @stoqey/ib 1.6.10 的 Encoder / Decoder 现跑的结果
// (gen_ib_wire.mjs)。发出去的比字段表、字节与报错;读进来的比每一个事件(含 error / info 的先后)与 process() 抛的错。
#include "execution/tws/codec.h"
#include "execution/tws/wire_in.h"
#include "execution/tws/wire_out.h"
#include "js_fixture.h"
#include "util/jsformat.h"
#include "util/jsnum.h"

#include <QTest>

using namespace ibkr;
using namespace ibkr::tws::wire;
using namespace Qt::StringLiterals;
using jsfix::OJson;
namespace js = ibkr::util::js;

namespace {

OJson emitsJson(const std::vector<Emit>& emits) {
    OJson a = js::array();
    for (const Emit& e : emits) a.items.append(js::object({{u"name"_s, js::S(e.name)}, {u"args"_s, e.args}}));
    return a;
}

/// 夹具里的期望:去掉入参那几键,其余照原次序
OJson expected(const OJson& c, std::initializer_list<QString> drop) {
    OJson o = js::object();
    for (const auto& [k, v] : c.fields)
        if (std::find(drop.begin(), drop.end(), k) == drop.end()) o.set(k, v);
    return o;
}

QStringList strings(const OJson& a) {
    QStringList out;
    for (const OJson& x : a.items) out << x.s;
    return out;
}

/// 参数表:"__undefined__" 是 undefined,其余照占位串还原
std::vector<Arg> args(const OJson& a) {
    std::vector<Arg> out;
    for (const OJson& x : a.items) {
        if (x.type == OJson::String && x.s == u"__undefined__") out.push_back(std::nullopt);
        else out.push_back(jsfix::dec(x));
    }
    return out;
}

Encoded call(const QString& fn, int sv, const std::vector<Arg>& a, bool api) {
    const auto at = [&](size_t i) -> Arg { return i < a.size() ? a[i] : std::nullopt; };
    if (api) {
        if (fn == u"cancelOrder") return api::cancelOrder(sv, at(0), at(1));
        if (fn == u"reqMktData") return api::reqMktData(sv, at(0), at(1), at(2), at(3), at(4));
        if (fn == u"reqPnL") return api::reqPnL(sv, at(0), at(1), at(2));
        if (fn == u"reqIds") return api::reqIds(sv, at(0));
        if (fn == u"reqHistoricalData") return api::reqHistoricalData(sv, at(0), at(1), at(2), at(3), at(4), at(5), at(6), at(7), at(8));
        qFatal("夹具里多了一个 api 函数:%s", qPrintable(fn));
    }
    if (fn == u"placeOrder") return placeOrder(sv, at(0), at(1), at(2));
    if (fn == u"reqContractDetails") return reqContractDetails(sv, at(0), at(1));
    if (fn == u"reqMktData") return reqMktData(sv, at(0), at(1), at(2), at(3), at(4));
    if (fn == u"cancelMktData") return cancelMktData(sv, at(0));
    if (fn == u"reqMarketDataType") return reqMarketDataType(sv, at(0));
    if (fn == u"reqHistoricalData") return reqHistoricalData(sv, at(0), at(1), at(2), at(3), at(4), at(5), at(6), at(7), at(8), at(9));
    if (fn == u"cancelHistoricalData") return cancelHistoricalData(sv, at(0));
    if (fn == u"reqPositions") return reqPositions(sv);
    if (fn == u"cancelPositions") return cancelPositions(sv);
    if (fn == u"reqAccountSummary") return reqAccountSummary(sv, at(0), at(1), at(2));
    if (fn == u"cancelAccountSummary") return cancelAccountSummary(sv, at(0));
    if (fn == u"reqPnL") return reqPnL(sv, at(0), at(1), at(2));
    if (fn == u"cancelPnL") return cancelPnL(sv, at(0));
    if (fn == u"reqMktDepth") return reqMktDepth(sv, at(0), at(1), at(2), at(3), at(4));
    if (fn == u"cancelMktDepth") return cancelMktDepth(sv, at(0), at(1));
    if (fn == u"cancelOrder") return cancelOrder(sv, at(0), at(1));
    if (fn == u"reqAllOpenOrders") return reqAllOpenOrders(sv);
    if (fn == u"reqOpenOrders") return reqOpenOrders(sv);
    if (fn == u"reqAutoOpenOrders") return reqAutoOpenOrders(sv, at(0));
    if (fn == u"reqExecutions") return reqExecutions(sv, at(0), at(1));
    if (fn == u"reqSecDefOptParams") return reqSecDefOptParams(sv, at(0), at(1), at(2), at(3), at(4));
    if (fn == u"reqManagedAccts") return reqManagedAccts(sv);
    if (fn == u"reqIds") return reqIds(sv, at(0));
    if (fn == u"reqCurrentTime") return reqCurrentTime(sv);
    qFatal("夹具里多了一个 encoder 函数:%s", qPrintable(fn));
}

/// 一条 encoder 用例:C++ 的结果拼成夹具的样子
OJson runEncoderCase(const OJson& c, bool api) {
    const QString fn = c.get(u"fn"_s)->s;
    const int sv = int(c.get(u"sv"_s)->n);
    try {
        const Encoded r = call(fn, sv, args(*c.get(u"args"_s)), api);
        OJson got = js::object({{u"errors"_s, emitsJson(r.errors)}});
        if (r.tokens) {
            got.set(u"tokens"_s, *r.tokens);
            if (c.get(u"hex"_s)) got.set(u"hex"_s, js::S(QString::fromLatin1(bytesOf(*r.tokens).toHex())));
        }
        return got;
    } catch (const WireError& e) {
        return js::object({{u"error"_s, js::S(e.name() + u": "_s + e.message())}, {u"errors"_s, js::array()}, {u"sent"_s, js::N(0)}});
    }
}

OJson runDecode(int sv, const QStringList& tokens) {
    Decoder d(sv);
    d.enqueueMessage(tokens);
    std::vector<Emit> out;
    OJson got = js::object();
    try {
        d.process(out);
        got.set(u"emits"_s, emitsJson(out));
    } catch (const WireError& e) {
        got.set(u"emits"_s, emitsJson(out));
        got.set(u"thrown"_s, js::S(e.name() + u": "_s + e.message()));
    }
    return got;
}

}  // namespace

class TestIbWire : public QObject {
    Q_OBJECT
private slots:
    void encoderMatchesStoqey_data() {
        QTest::addColumn<QString>("file");
        QTest::newRow("orders") << u"ib-wire-orders.json"_s;
        QTest::newRow("other") << u"ib-wire-out.json"_s;
    }
    void encoderMatchesStoqey() {
        QFETCH(QString, file);
        const OJson f = jsfix::load(file);
        QVERIFY(f.get(u"library"_s)->s.startsWith(u"@stoqey/ib 1.6.10"));
        int n = 0, hex = 0;
        for (const OJson& c : f.get(u"encoder"_s)->items) {
            const QString what = u"%1 #%2 v%3"_s.arg(c.get(u"fn"_s)->s).arg(n).arg(c.get(u"sv"_s)->n);
            JSFIX_SAME(expected(c, {u"fn"_s, u"sv"_s, u"args"_s}), runEncoderCase(c, false), what);
            if (c.get(u"hex"_s)) ++hex;
            ++n;
        }
        QVERIFY(n > 1000 || file != u"ib-wire-orders.json");
        QVERIFY(hex > 50);
    }
    void apiLayerMatchesStoqey() {
        const OJson f = jsfix::load(u"ib-wire-out.json"_s);
        int n = 0;
        for (const OJson& c : f.get(u"api"_s)->items) {
            JSFIX_SAME(expected(c, {u"fn"_s, u"sv"_s, u"args"_s}), runEncoderCase(c, true), u"api %1 #%2"_s.arg(c.get(u"fn"_s)->s).arg(n));
            ++n;
        }
        QVERIFY(n >= 300);
    }
    void startApiMatchesSocket() {
        const OJson f = jsfix::load(u"ib-wire-out.json"_s);
        for (const OJson& c : f.get(u"startApi"_s)->items) {
            const Encoded r = startApi(int(c.get(u"sv"_s)->n), *c.get(u"clientId"_s));
            QVERIFY(r.tokens && r.errors.empty());
            JSFIX_SAME(*c.get(u"tokens"_s), *r.tokens, u"startApi tokens"_s);
            QCOMPARE(QString::fromLatin1(bytesOf(*r.tokens).toHex()), c.get(u"hex"_s)->s);
        }
        // 和 stage 0 的手写分帧逐字节一样
        QCOMPARE(bytesOf(*startApi(193, js::N(9012)).tokens), ibkr::tws::startApi(9012));
        QCOMPARE(bytesOf(*reqPositions(193).tokens), ibkr::tws::reqPositions());
        QCOMPARE(bytesOf(*reqCurrentTime(193).tokens), ibkr::tws::reqCurrentTime());
        QVERIFY(!startApi(2, js::N(1)).tokens);
        QCOMPARE(fieldsOf(*startApi(60, js::N(7)).tokens), QStringList{u"7"_s});
        QCOMPARE(fieldsOf(*startApi(71, js::N(7)).tokens), (QStringList{u"71"_s, u"2"_s, u"7"_s}));
    }
    void fieldsFollowJoin() {
        // join 的规矩:null 与 undefined 是空串、布尔先变 1/0、嵌套数组展平、对象是 [object Object]、数照 JS 的 String
        OJson t = js::array({js::N(3), OJson::null(), js::B(true), js::B(false), js::array({js::S(u"a"_s), js::array({js::N(-0.0)})}), js::object(),
                             js::N(1e21), js::N(std::nan("")), js::N(0.1)});
        QCOMPARE(fieldsOf(t), (QStringList{u"3"_s, u""_s, u"1"_s, u"0"_s, u"a"_s, u"0"_s, u"[object Object]"_s, u"1e+21"_s, u"NaN"_s, u"0.1"_s}));
        QCOMPARE(bytesOf(js::array({js::S(u"x"_s)})), QByteArray("x"));  // 首格是串:不加长度(V100 以前的样子)
        QCOMPARE(bytesOf(js::array()), QByteArray("\0\0\0\1\0", 5));
    }

    void decoderMatchesStoqey_data() {
        QTest::addColumn<QString>("file");
        QTest::addColumn<int>("minCases");
        QTest::newRow("random") << u"ib-wire-in.json"_s << 3000;
        // 消息自带的版本格读不出(NaN):`version >= N` 与 `version < N` 都是假的那些分支;
        // 以及每道版本闸的 N−1 / N / N+1,和只有特定值才分得出两边的定点样本
        QTest::newRow("edge") << u"ib-wire-edge.json"_s << 600;
    }
    void decoderMatchesStoqey() {
        QFETCH(QString, file);
        QFETCH(int, minCases);
        const OJson f = jsfix::load(file);
        QList<double> unportedIds;
        for (const OJson& x : f.get(u"unportedIds"_s)->items) unportedIds << x.n;
        int n = 0, skipped = 0;
        for (const OJson& c : f.get(u"messages"_s)->items) {
            const int sv = int(c.get(u"sv"_s)->n);
            const QStringList tokens = strings(*c.get(u"tokens"_s));
            const QString what = u"%1 #%2 v%3"_s.arg(c.get(u"name"_s)->s).arg(n++).arg(sv);
            const double id = tokens.isEmpty() ? std::nan("") : (tokens[0].isEmpty() ? 0 : util::jsParseInt(tokens[0], 10));
            if (unportedIds.contains(id)) {
                // 库里有解码、C++ 没搬:只许说"没搬",不许冒充不认识或读出东西
                const OJson got = runDecode(sv, tokens);
                QCOMPARE(js::stringify(got), u"{\"emits\":[{\"name\":\"__unported__\",\"args\":[%1]}]}"_s.arg(util::jsNumberToString(id)));
                ++skipped;
                continue;
            }
            JSFIX_SAME(expected(c, {u"name"_s, u"sv"_s, u"tokens"_s}), runDecode(sv, tokens), what);
        }
        QVERIFY(n > minCases);
        QVERIFY(skipped > 20 || file != u"ib-wire-in.json");
    }
    void streamsMatchStoqey() {
        const OJson f = jsfix::load(u"ib-wire-in.json"_s);
        int n = 0, thrown = 0;
        for (const OJson& s : f.get(u"streams"_s)->items) {
            Decoder d(int(s.get(u"sv"_s)->n));
            int step = 0;
            for (const OJson& st : s.get(u"steps"_s)->items) {
                ++step;
                if (const OJson* tokens = st.get(u"enqueue"_s)) {
                    d.enqueueMessage(strings(*tokens));
                    continue;
                }
                std::vector<Emit> out;
                OJson got = js::object();
                try {
                    d.process(out);
                    got.set(u"process"_s, emitsJson(out));
                } catch (const WireError& e) {
                    got.set(u"process"_s, emitsJson(out));
                    got.set(u"thrown"_s, js::S(e.name() + u": "_s + e.message()));
                    ++thrown;
                }
                JSFIX_SAME(st, got, u"stream #%1 step %2"_s.arg(n).arg(step));
            }
            ++n;
        }
        QVERIFY(thrown > 0);
    }
    void splitFramesDecodesUtf8LikeNode() {
        // 坏的 UTF-8(截断、过长编码、代理区、超出 U+10FFFF、孤立的续字节)按 Node 的 Buffer#toString 换成 U+FFFD,BOM 留着
        const OJson f = jsfix::load(u"ib-wire-edge.json"_s);
        int n = 0;
        for (const OJson& c : f.get(u"utf8Frames"_s)->items) {
            const QByteArray bytes = QByteArray::fromHex(c.get(u"hex"_s)->s.toLatin1());
            const ibkr::tws::SplitResult cut = ibkr::tws::splitFrames(bytes);
            QCOMPARE(cut.frames.size(), 1);
            QCOMPARE(cut.consumed, bytes.size());
            QCOMPARE(cut.frames[0], strings(*c.get(u"tokens"_s)));
            ++n;
        }
        QVERIFY(n >= 15);
    }
    void decodeOneShot() {
        const std::vector<Emit> e = decode(193, {u"9"_s, u"1"_s, u"42"_s});
        QCOMPARE(e.size(), size_t(1));
        QCOMPARE(e[0].name, u"nextValidId"_s);
        QCOMPARE(js::stringify(e[0].args), u"[42]"_s);
        QCOMPARE(inMsgName(5), u"OPEN_ORDER"_s);
        QCOMPARE(inMsgName(-0.0), u"undefined"_s);
        QCOMPARE(inMsgName(std::nan("")), u"undefined"_s);
    }
};

QTEST_GUILESS_MAIN(TestIbWire)
#include "tst_ib_wire.moc"
