// RpcServer(transport/rpc_server)的线上行为,对着 TS 的 rpc/server.ts 现跑的输出(tools/gen_rpc_server.mjs → fixtures/rpc-server.json):
//   · wire:各种解析不了的行、id / method / params 的各种 JSON 类型、数的写法(1e999、-0、非规格化)、Unicode 与落单代理项的转义、
//     CRLF / 单独的 CR / U+2028、BOM 与 NBSP 的 trim、入参过不了 schema 的 -32602;输出逐字节比;
//   · stub:调度——本地道当场答、读道四个并发、交易道严格顺序且用户请求插到轮询前面、解析不了的行在交易道上按先后答、EOF 等在途请求答完;
//     错误按类映射(RpcError / KeychainError / 别的);各种返回值的写法;
//   · crash:TS 在那几种请求(null、数、串、布尔)上整个进程抛死,C++ 不照搬——按「未知方法:」答,这里钉住;
//   · 道表三张与 laneOf 对夹具里 TS 的值一个不差。
// 每个场景一个新的 RpcServer;一批行同步喂进 handleLine(= TS 里同一个 chunk 在 readline 里同步派发),再让事件循环转到 serve 收尾。
#include "js_fixture.h"
#include "contract/registry.h"
#include "transport/contract_methods.h"
#include "transport/rpc_server.h"
#include "util/jsvalue.h"
#include "util/keychain.h"

#include <QCoreApplication>
#include <QElapsedTimer>
#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using util::OJson;
namespace js = util::js;
using rpc::RpcServer;

namespace {

// ---------------------------------------------------------------- 合成方法(同 gen_rpc_server.mjs 的 STUB)
util::Task<OJson> delayed(int ms, OJson value) {
    co_await util::sleepMs(ms);
    co_return value;
}
util::Task<OJson> delayedThrow(int ms) {
    co_await util::sleepMs(ms);
    throw util::RpcError(-32004, u"等了一会儿才拒"_s);
}
util::Task<OJson> asyncPlain() {
    co_await util::sleepMs(1);
    throw util::JsError(u"plain"_s);
}

OJson lane(const QString& name, std::initializer_list<std::pair<QString, OJson>> more = {}) {
    OJson o = js::object({{u"lane"_s, js::S(name)}});
    for (const auto& [k, v] : more) o.set(k, v);
    return o;
}

void registerStubs(RpcServer& s) {
    const auto sync = [&s](const QString& name, RpcServer::OJsonHandler h) { s.addOJson(name, std::move(h)); };
    const auto later = [&s](const QString& name, int ms, OJson value) {
        s.addAsync(name, [ms, value](const OJson&) { return delayed(ms, value); });
    };
    sync(u"sectors.list"_s, [](const OJson&) { return lane(u"local"_s, {{u"sync"_s, js::B(true)}}); });
    later(u"sectors.add"_s, 30, lane(u"local"_s, {{u"slow"_s, js::B(true)}}));
    sync(u"settings.get"_s, [](const OJson&) -> OJson { throw util::RpcError(-32001, u"本地道上的拒绝"_s); });
    sync(u"system.status"_s, [](const OJson&) { return js::object({{u"ok"_s, js::B(true)}}); });
    later(u"pa.analyze"_s, 800, lane(u"read"_s, {{u"n"_s, js::N(1)}}));
    later(u"backtest.strategies"_s, 150, lane(u"read"_s, {{u"n"_s, js::N(2)}}));
    later(u"book.snapshot"_s, 160, lane(u"read"_s, {{u"n"_s, js::N(3)}}));
    later(u"options.wall"_s, 170, lane(u"read"_s, {{u"n"_s, js::N(4)}}));
    later(u"screener.rs"_s, 180, lane(u"read"_s, {{u"n"_s, js::N(5)}}));
    later(u"screener.inflection"_s, 250, lane(u"read"_s, {{u"n"_s, js::N(6)}}));
    later(u"screener.deviation"_s, 60, lane(u"read"_s, {{u"n"_s, js::N(7)}}));
    later(u"macro.board"_s, 30, lane(u"read+low"_s, {{u"n"_s, js::N(8)}}));
    later(u"instruction.submit"_s, 100, lane(u"trade"_s, {{u"n"_s, js::N(1)}}));
    later(u"alerts.poll"_s, 60, lane(u"low"_s, {{u"n"_s, js::N(1)}}));
    later(u"pending.poll"_s, 60, lane(u"low"_s, {{u"n"_s, js::N(2)}}));
    sync(u"tracker.add"_s, [](const OJson&) { return lane(u"trade"_s, {{u"sync"_s, js::B(true)}}); });
    sync(u"x.throw_rpc"_s, [](const OJson&) -> OJson { throw util::RpcError(-32005, u"被拒了:额度不够"_s); });
    sync(u"x.throw_rpc_zero"_s, [](const OJson&) -> OJson { throw util::RpcError(0, QString()); });
    sync(u"x.throw_type"_s, [](const OJson&) -> OJson { throw util::JsError(u"boom"_s); });
    sync(u"x.throw_range"_s, [](const OJson&) -> OJson { throw util::JsError(u"远了"_s); });
    s.addAsync(u"x.throw_plain"_s, [](const OJson&) { return asyncPlain(); });
    sync(u"x.throw_keychain"_s, [](const OJson&) -> OJson { throw util::KeychainError(u"钥匙串被拒:点一下系统弹窗"_s); });
    s.addAsync(u"x.throw_async_rpc"_s, [](const OJson&) { return delayedThrow(20); });
    sync(u"x.echo"_s, [](const OJson& p) { return js::object({{u"echo"_s, p}}); });
    sync(u"x.null"_s, [](const OJson&) { return OJson::null(); });
    sync(u"x.number"_s, [](const OJson&) { return js::N(42); });
    sync(u"x.array"_s, [](const OJson&) { return js::array({js::N(1), js::S(u"a"_s), OJson::null(), js::object({{u"k"_s, js::N(-0.0)}})}); });
    sync(u"x.string"_s, [](const OJson&) { return js::S(u"text"_s); });
    sync(u"x.unicode"_s, [](const OJson&) {
        QString text = u" 中文😀"_s;
        text += QChar(char16_t(0xd800));
        text += u" \u0001\"\\/"_s;
        return js::object({{u"s"_s, js::S(text)}});
    });
    sync(u"x.nums"_s, [](const OJson&) {
        constexpr double inf = std::numeric_limits<double>::infinity();
        return js::object({{u"a"_s, js::N(-0.0)}, {u"b"_s, js::N(1e21)}, {u"c"_s, js::N(1e-7)}, {u"d"_s, js::N(0.1 + 0.2)}, {u"e"_s, js::N(123456789012345680000.0)},
                           {u"f"_s, js::N(inf)}, {u"g"_s, js::N(std::nan(""))}, {u"h"_s, js::N(5e-324)}, {u"i"_s, js::N(1.7976931348623157e308)},
                           {u"j"_s, js::N(100)}, {u"k"_s, js::N(1.5e300)}});
    });
    later(u"x.slow_trade"_s, 300, lane(u"trade"_s, {{u"slow"_s, js::B(true)}}));
    sync(u"x.fast_trade"_s, [](const OJson&) { return lane(u"trade"_s, {{u"fast"_s, js::B(true)}}); });
}

/// 真方法表里入参会过 schema 的那些:全部契约方法登记上,handler 一到就是错(wire 场景都不该走到 handler)
void registerContract(RpcServer& s) {
    for (const contract::MethodSpec& spec : contract::methodSpecs())
        rpc::addContractMethod(s, spec.name, [name = spec.name](const OJson&) -> OJson { throw util::JsError(u"不该走到 handler:%1"_s.arg(name)); });
}

QByteArray fromBase64(const QString& b64) { return QByteArray::fromBase64(b64.toLatin1()); }

struct Outcome {
    QStringList out;
    int exitCode = -1;
    bool finished = false;
};

/// 跑一个场景:ops 是夹具里的(base64 的 chunk、{wait}、{emit})。chunk 按 \n 断成行再喂 handleLine(= 读入层的 getline);没有换行的尾巴等下一个 chunk,EOF 时当一行
Outcome replay(const OJson& ops, bool stub) {
    Outcome outcome;
    RpcServer server([&outcome](const QByteArray& line) { outcome.out << QString::fromUtf8(line); });
    server.hooks.stderrLine = [](const QString&) {};
    if (stub) registerStubs(server);
    else registerContract(server);
    server.setOnFinished([&outcome](int code) {
        outcome.finished = true;
        outcome.exitCode = code;
    });
    server.begin(u"<CONFIG>"_s);
    QByteArray pending;
    const auto feed = [&](const QByteArray& chunk) {
        pending += chunk;
        for (qsizetype nl; (nl = pending.indexOf('\n')) >= 0;) {
            const QByteArray line = pending.left(nl);
            pending.remove(0, nl + 1);
            server.handleLine(line);
        }
    };
    for (const OJson& op : ops.items) {
        if (op.type == OJson::String) {
            feed(fromBase64(op.s));
        } else if (const OJson* ms = op.get(u"wait"_s)) {
            QTest::qWait(int(ms->n));
        } else if (const OJson* ev = op.get(u"emit"_s)) {
            const QString event = ev->items[0].s;
            // JSON 夹具里写不出 -0 与 Infinity:tracker 事件的载荷按 TS 那边真发的来(k: -0, n: Infinity)
            if (event == u"tracker") {
                constexpr double inf = std::numeric_limits<double>::infinity();
                server.emitEvent(event, js::object({{u"fired"_s, js::array()}, {u"blocked"_s, js::array({js::object({{u"k"_s, js::N(-0.0)}, {u"n"_s, js::N(inf)}})})}}));
            } else {
                server.emitEvent(event, ev->items[1]);
            }
        }
    }
    if (!pending.isEmpty()) {  // 最后一行没有换行:readline 在 close 时照样给出来
        server.handleLine(pending);
        pending.clear();
    }
    server.handleEof();
    QElapsedTimer timer;
    timer.start();
    while (!outcome.finished && timer.elapsed() < 10000) QTest::qWait(5);
    return outcome;
}

/// TS 的 -32000 话是 `<构造函数名>: <message>`(TypeError / RangeError / Error……)。C++ 认不出 JS 的类名,一律 Error:比的时候把前缀统一掉
QString normalized(const QString& line) {
    const auto parsed = util::parseOJson(line);
    if (!parsed) return line;
    const OJson* err = js::prop(&*parsed, u"error"_s);
    const OJson* code = js::prop(err, u"code"_s);
    if (!code || code->n != -32000) return line;
    OJson copy = *parsed;
    OJson* e = copy.get(u"error"_s);
    OJson* m = e->get(u"message"_s);
    const qsizetype colon = m->s.indexOf(u": "_s);
    if (colon > 0) m->s = u"Error"_s + m->s.mid(colon);
    return util::stringifyOJson(copy, 0);
}

QString diffAt(const QStringList& want, const QStringList& got) {
    for (qsizetype i = 0; i < qMax(want.size(), got.size()); ++i) {
        const QString w = i < want.size() ? want[i] : u"<无>"_s, g = i < got.size() ? got[i] : u"<无>"_s;
        if (normalized(w) != normalized(g)) return u"第 %1 行不同\n  TS :%2\n  C++:%3"_s.arg(i).arg(w.left(400), g.left(400));
    }
    return {};
}

QStringList stringsOf(const OJson* arr) {
    QStringList out;
    for (const OJson& x : arr->items) out << x.s;
    return out;
}

}  // namespace

class TestRpcServer : public QObject {
    Q_OBJECT
private slots:
    void wireScenariosMatchTs() {
        const OJson fx = jsfix::load(u"rpc-server.json"_s);
        qsizetype lines = 0;
        QStringList failures;  // 全部场景都跑完再一起报
        for (const OJson& w : fx.get(u"wire"_s)->items) {
            const QString name = w.get(u"name"_s)->s;
            QVERIFY2(!w.get(u"crash"_s), qPrintable(name));  // TS 没抛死的场景才放在这里
            const Outcome got = replay(*w.get(u"in"_s), false);
            const QStringList want = stringsOf(w.get(u"out"_s));
            const QString diff = diffAt(want, got.out);
            if (!diff.isEmpty()) failures << name + u":"_s + diff;
            if (!got.finished || got.exitCode != int(w.get(u"code"_s)->n)) failures << name + u":没有按 TS 的退出码收尾"_s;
            lines += want.size();
        }
        QVERIFY2(failures.isEmpty(), qPrintable(u"%1 个场景不同:\n"_s.arg(failures.size()) + failures.join(u"\n"_s)));
        QVERIFY(lines > 150);
    }

    void stubScenariosMatchTs() {
        const OJson fx = jsfix::load(u"rpc-server.json"_s);
        QStringList failures;
        for (const OJson& s : fx.get(u"stub"_s)->items) {
            const QString name = s.get(u"name"_s)->s;
            QVERIFY2(!s.get(u"crash"_s), qPrintable(name));
            const Outcome got = replay(*s.get(u"ops"_s), true);
            const QString diff = diffAt(stringsOf(s.get(u"out"_s)), got.out);
            if (!diff.isEmpty()) failures << name + u":"_s + diff;
            if (!got.finished || got.exitCode != int(s.get(u"code"_s)->n)) failures << name + u":没有按 TS 的退出码收尾"_s;
        }
        QVERIFY2(failures.isEmpty(), qPrintable(u"%1 个场景不同:\n"_s.arg(failures.size()) + failures.join(u"\n"_s)));
    }

    /// TS 里让 line 监听抛死的请求:C++ 照数组那样答「未知方法:」(id null),引擎不死
    void requestsThatCrashTsAreAnsweredHere() {
        const OJson fx = jsfix::load(u"rpc-server.json"_s);
        const QString unknown = u"{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32601,\"message\":\"未知方法:\"}}"_s;
        int n = 0;
        for (const OJson& c : fx.get(u"crash"_s)->items) {
            QVERIFY2(c.get(u"crash"_s)->type == OJson::String, qPrintable(c.get(u"name"_s)->s));  // TS 真的抛了
            const Outcome got = replay(*c.get(u"in"_s), false);
            QCOMPARE(got.out.size(), 2);
            QCOMPARE(got.out[1], unknown);
            QVERIFY(got.finished);
            ++n;
        }
        QCOMPARE(n, 8);
    }

    /// 道表:三张表、laneOf、常量
    void laneTablesMatchTs() {
        const OJson fx = jsfix::load(u"rpc-server.json"_s);
        const OJson* sets = fx.get(u"sets"_s);
        const auto setOf = [](const OJson* arr) {
            QSet<QString> s;
            for (const OJson& x : arr->items) s.insert(x.s);
            return s;
        };
        const rpc::LaneTable& table = rpc::defaultLaneTable();
        QCOMPARE(table.local, setOf(sets->get(u"local"_s)));
        QCOMPARE(table.read, setOf(sets->get(u"read"_s)));
        QCOMPARE(table.low, setOf(sets->get(u"low"_s)));
        QCOMPARE(table.local.size(), sets->get(u"local"_s)->items.size());  // 夹具里没有重复,C++ 的写法也不该有
        QCOMPARE(table.read.size(), sets->get(u"read"_s)->items.size());
        QCOMPARE(table.low.size(), sets->get(u"low"_s)->items.size());
        QCOMPARE(rpc::kReadConcurrency, int(sets->get(u"readConcurrency"_s)->n));
        QCOMPARE(rpc::kSlowMs, sets->get(u"slowMs"_s)->n);
        RpcServer server([](const QByteArray&) {});
        for (const auto& [name, laneJson] : fx.get(u"lanes"_s)->fields)
            QCOMPARE(rpc::laneName(server.laneOf(name)), laneJson.s);
        QCOMPARE(fx.get(u"misc"_s)->get(u"protocol"_s)->s, QString::fromLatin1(rpc::kProtocolVersion));
    }

    /// 真方法表的方法名(夹具里是 TS 的 101 个):契约里的方法 C++ 都登记得上,留给以后搬 handler 的人对
    void contractMethodsAreSubsetOfTsMethodNames() {
        const OJson fx = jsfix::load(u"rpc-server.json"_s);
        const QStringList tsNames = stringsOf(fx.get(u"methodNames"_s));
        QVERIFY(tsNames.size() > 90);
        for (const QString& name : contract::contractMethodNames()) QVERIFY2(tsNames.contains(name), qPrintable(name));
        QStringList sortedNames = tsNames;
        sortedNames.sort();
        QCOMPARE(tsNames, sortedNames);
    }

    /// 直接调(call):不包信封,失败原样抛
    void directCallMatchesTs() {
        const OJson fx = jsfix::load(u"rpc-server.json"_s);
        RpcServer server([](const QByteArray&) {});
        registerStubs(server);
        server.hooks.stderrLine = [](const QString&) {};
        for (const auto& [method, expect] : fx.get(u"misc"_s)->get(u"call"_s)->fields) {
            OJson params = method == u"x.echo" ? js::object({{u"a"_s, js::N(1)}}) : js::object();
            const util::Task<OJson> task = server.call(method, params);
            QVERIFY(task.done());  // 这几个都是同步的
            if (const OJson* out = expect.get(u"out"_s)) {
                QCOMPARE(util::stringifyOJson(task.result(), 0), out->s);
                continue;
            }
            const QString error = expect.get(u"error"_s)->s;
            try {
                task.result();
                QFAIL(qPrintable(method + u" 该抛"_s));
            } catch (const util::RpcError& e) {
                QVERIFY2(error.startsWith(u"RpcError: "_s), qPrintable(method));
                QCOMPARE(e.message(), jsfix::errorText(error));
                QCOMPARE(e.code(), int(expect.get(u"code"_s)->n));
            } catch (const util::JsError& e) {
                QVERIFY2(!error.startsWith(u"RpcError: "_s), qPrintable(method));
                QCOMPARE(e.message(), jsfix::errorText(error));
            }
        }
        // 没登记的(含 "constructor" 之类 Object.prototype 上有的名字)一律未知方法
        for (const QString& name : {u"nope"_s, u"constructor"_s, u"__proto__"_s, u"toString"_s, QString()}) {
            const util::Task<OJson> t = server.call(name, js::object());
            QVERIFY(t.done());
            try {
                t.result();
                QFAIL("该抛");
            } catch (const util::RpcError& e) {
                QCOMPARE(e.code(), -32601);
                QCOMPARE(e.message(), u"未知方法:%1"_s.arg(name));
            }
        }
    }

    /// addContractMethodAsync:契约里没有的名字抛 JsError;入参过不了 schema 是已失败的 Task(-32602);通过了交给协程 handler,它抛的错照样回执
    void contractAsyncMethods() {
        QStringList out;
        RpcServer server([&out](const QByteArray& l) { out << QString::fromUtf8(l); });
        server.hooks.stderrLine = [](const QString&) {};
        try {
            rpc::addContractMethodAsync(server, u"nope.method"_s, [](OJson) { return util::Task<OJson>::resolved(OJson()); });
            QFAIL("该抛");
        } catch (const util::JsError& e) {
            QCOMPARE(e.message(), u"契约里没有这个方法:nope.method"_s);
        }
        int reached = 0;
        rpc::addContractMethodAsync(server, u"alerts.create"_s, [&reached](OJson p) -> util::Task<OJson> {
            ++reached;
            co_await util::sleepMs(10);
            co_return js::object({{u"symbol"_s, *p.get(u"symbol"_s)}});
        });
        rpc::addContractMethodAsync(server, u"alerts.delete"_s, [](OJson) -> util::Task<OJson> {
            co_await util::sleepMs(5);
            throw util::RpcError(-32011, u"晚到的拒绝"_s);
        });
        server.handleLine(R"({"id":1,"method":"alerts.create","params":{}})");
        server.handleLine(R"({"id":2,"method":"alerts.create","params":{"symbol":"AAPL","extra":1}})");
        server.handleLine(R"({"id":3,"method":"alerts.delete","params":{"id":"x"}})");
        QTRY_COMPARE(out.size(), 3);
        QCOMPARE(reached, 1);
        QCOMPARE(out[0], u"{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32602,\"message\":\"alerts.create 的参数不对:缺少 symbol\"}}"_s);
        QCOMPARE(out[1], u"{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"symbol\":\"AAPL\"}}"_s);
        QCOMPARE(out[2], u"{\"jsonrpc\":\"2.0\",\"id\":3,\"error\":{\"code\":-32011,\"message\":\"晚到的拒绝\"}}"_s);
    }

    /// QJsonValue 版 objectParams 的类型名(zod 的 getParsedType 那几个)
    void objectParamsQJsonTypeNames() {
        const auto say = [](const QJsonValue& v) {
            try {
                rpc::objectParams(u"m"_s, v);
            } catch (const rpc::RpcError& e) {
                return e.message();
            }
            return QString();
        };
        QCOMPARE(say(QJsonValue(true)), u"m 的参数不对:params 应为 object,收到 boolean"_s);
        QCOMPARE(say(QJsonValue(QJsonValue::Null)), u"m 的参数不对:params 应为 object,收到 null"_s);
        QCOMPARE(say(QJsonValue(QJsonValue::Undefined)), u"m 的参数不对:params 应为 object,收到 undefined"_s);
        QCOMPARE(say(QJsonValue(u"s"_s)), u"m 的参数不对:params 应为 object,收到 string"_s);
        QCOMPARE(say(QJsonObject{{u"a"_s, 1}}), QString());
    }

    /// 没料到的错:调用栈那一行进 stderr(经 hooks),界面拿「Error: …」;不是 std::exception 的也接住
    void unexpectedErrorsGoToStderr() {
        QStringList out, err;
        RpcServer server([&out](const QByteArray& l) { out << QString::fromUtf8(l); });
        server.hooks.stderrLine = [&err](const QString& l) { err << l; };
        server.addOJson(u"t.js"_s, [](const OJson&) -> OJson { throw util::JsError(u"坏了"_s); });
        server.addOJson(u"t.std"_s, [](const OJson&) -> OJson { throw std::runtime_error("kaput"); });
        server.addOJson(u"t.int"_s, [](const OJson&) -> OJson { throw 42; });
        server.addOJson(u"t.rpc"_s, [](const OJson&) -> OJson { throw util::RpcError(-32001, u"拒"_s); });
        server.addOJson(u"t.key"_s, [](const OJson&) -> OJson { throw util::KeychainError(u"钥匙串"_s); });
        for (const char* m : {"t.js", "t.std", "t.int", "t.rpc", "t.key"}) server.handleLine(QByteArray("{\"id\":1,\"method\":\"") + m + "\"}");
        QCoreApplication::processEvents();
        QCOMPARE(out.size(), 5);
        QCOMPARE(out[0], u"{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"message\":\"Error: 坏了\"}}"_s);
        QCOMPARE(out[1], u"{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"message\":\"Error: kaput\"}}"_s);
        QCOMPARE(out[2], u"{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"message\":\"Error: 未知的异常\"}}"_s);
        QCOMPARE(out[3], u"{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32001,\"message\":\"拒\"}}"_s);
        QCOMPARE(out[4], u"{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32008,\"message\":\"钥匙串\"}}"_s);
        // RpcError 与 KeychainError 不打调用栈;其余三种各一行
        QCOMPARE(err, (QStringList{u"t.js: 坏了"_s, u"t.std: kaput"_s, u"t.int: 不是 std::exception 的异常"_s}));
    }

    /// 慢请求那一行与汇总:门槛与间隔可调,到点才写;收尾后计时器停了
    void slowLogAndFlushTimer() {
        QStringList out, err;
        RpcServer server([&out](const QByteArray& l) { out << QString::fromUtf8(l); });
        server.hooks.stderrLine = [&err](const QString& l) { err << l; };
        server.setSlowMs(20);
        server.setFlushIntervalMs(40);
        server.addAsync(u"x.slow"_s, [](const OJson&) { return delayed(70, js::object()); });
        server.lanes().local.insert(u"x.slow"_s);
        server.addOJson(u"x.fast"_s, [](const OJson&) { return js::object(); });
        server.lanes().local.insert(u"x.fast"_s);
        bool finished = false;
        server.setOnFinished([&](int) { finished = true; });
        server.begin(u"c"_s);
        server.handleLine(R"({"id":1,"method":"x.slow"})");
        server.handleLine(R"({"id":2,"method":"x.fast"})");
        QTRY_VERIFY(out.size() >= 3);
        QVERIFY2(err.filter(u"[rpc] 慢请求 x.slow "_s).size() == 1, qPrintable(err.join(u"|"_s)));
        QVERIFY(err.filter(u"x.fast"_s).isEmpty() || err.filter(u"慢请求 x.fast"_s).isEmpty());
        QTRY_VERIFY2(!err.filter(u"[perf] "_s).isEmpty(), "间隔到了应写一行汇总");  // 计时器在 begin 里起
        server.handleEof();
        QTRY_VERIFY(finished);
        const qsizetype before = err.size();
        server.handleLine(R"({"id":3,"method":"x.fast"})");  // 收尾之后的新请求:计时器停了,不会再有汇总行
        QTest::qWait(150);
        QCOMPARE(err.size(), before);
        // onFinished 只调一次:再 EOF、再 pump 都不重复
        int calls = 0;
        RpcServer second([](const QByteArray&) {});
        second.setOnFinished([&calls](int) { ++calls; });
        second.handleEof();
        second.handleEof();
        QCoreApplication::processEvents();
        second.handleEof();
        QCoreApplication::processEvents();
        QCOMPARE(calls, 1);
        QVERIFY(second.finished());
    }

    /// EOF 之后每一条道上没答完的都要等:交易道在途、交易道排队、轮询队列、读道在途与排队、本地道在途
    void eofWaitsForEveryLane() {
        for (const QString& lane : {u"trade"_s, u"low"_s, u"read"_s, u"local"_s}) {
            QStringList out;
            RpcServer server([&out](const QByteArray& l) { out << QString::fromUtf8(l); });
            server.addAsync(u"x.a"_s, [](const OJson&) { return delayed(50, js::object()); });
            if (lane == u"low") server.lanes().low.insert(u"x.a"_s);
            if (lane == u"read") server.lanes().read.insert(u"x.a"_s);
            if (lane == u"local") server.lanes().local.insert(u"x.a"_s);
            int n = lane == u"read" ? 6 : 2;  // 读道:四个在途、两个排队
            bool finished = false;
            server.setOnFinished([&](int) { finished = true; });
            for (int i = 0; i < n; ++i) server.handleLine(R"({"id":1,"method":"x.a"})");
            server.handleEof();
            QCoreApplication::processEvents();
            QVERIFY2(!finished && !server.finished(), qPrintable(lane));
            QTest::qWait(30);
            QVERIFY2(!finished, qPrintable(lane));
            QTRY_VERIFY2(finished, qPrintable(lane));
            QCOMPARE(out.size(), n);  // 先全部答完,再收尾
        }
        // 只有 EOF 没有请求:同一轮事件循环里就收尾
        RpcServer idle([](const QByteArray&) {});
        bool done = false;
        idle.setOnFinished([&](int) { done = true; });
        idle.handleEof();
        QCoreApplication::processEvents();
        QVERIFY(done);
        // 没有 EOF:再空闲也不收尾
        RpcServer open([](const QByteArray&) {});
        bool openDone = false;
        open.setOnFinished([&](int) { openDone = true; });
        open.handleLine(R"({"id":1,"method":"nope"})");
        QCoreApplication::processEvents();
        QVERIFY(!openDone && !open.finished());
    }

    /// 读道同时最多四个
    void readLaneConcurrencyIsFour() {
        RpcServer server([](const QByteArray&) {});
        int active = 0, peak = 0;
        server.addAsync(u"r.a"_s, [&](const OJson&) -> util::Task<OJson> {
            ++active;
            peak = qMax(peak, active);
            co_await util::sleepMs(30);
            --active;
            co_return js::object();
        });
        server.lanes().read.insert(u"r.a"_s);
        bool finished = false;
        server.setOnFinished([&](int) { finished = true; });
        for (int i = 0; i < 9; ++i) server.handleLine(R"({"id":1,"method":"r.a"})");
        server.handleEof();
        QTRY_VERIFY(finished);
        QCOMPARE(peak, rpc::kReadConcurrency);
    }

    /// 服务器先没了、在途的请求后到:不碰已释放的对象(ASan 下才真咬得住守卫)
    void destroyedWhileRequestsAreInFlight() {
        int outs = 0;
        auto* server = new RpcServer([&outs](const QByteArray&) { ++outs; });
        server->addAsync(u"x.a"_s, [](const OJson&) { return delayed(20, js::object()); });
        server->lanes().read.insert(u"x.a"_s);
        server->addAsync(u"x.b"_s, [](const OJson&) { return delayed(20, js::object()); });
        server->lanes().local.insert(u"x.b"_s);
        server->addAsync(u"x.c"_s, [](const OJson&) { return delayed(20, js::object()); });
        for (const char* m : {"x.a", "x.b", "x.c", "x.c"}) server->handleLine(QByteArray("{\"id\":1,\"method\":\"") + m + "\"}");
        server->handleEof();
        delete server;
        QTest::qWait(80);
        QCOMPARE(outs, 0);
    }

    /// 启动前的检查没跑过,开了 requireStartupChecks 的 server 不许登记 system.status 之外的方法;跑过(startupChecks)之后可以
    void startupChecksGateMethodRegistration() {
        rpc::resetStartupCheckedForTest();
        RpcServer plain([](const QByteArray&) {});
        plain.addOJson(u"x.free"_s, [](const OJson&) { return OJson(); });  // 没要求就不拦(测试与阶段 0)
        RpcServer strict([](const QByteArray&) {});
        strict.requireStartupChecks();
        strict.addOJson(u"system.status"_s, [](const OJson&) { return OJson(); });
        try {
            strict.addOJson(u"x.a"_s, [](const OJson&) { return OJson(); });
            QFAIL("该抛");
        } catch (const util::JsError& e) {
            QVERIFY2(e.message().contains(u"startupChecks"_s) && e.message().endsWith(u"x.a"_s), qPrintable(e.message()));
        }
        QVERIFY(!strict.has(u"x.a"_s));
        rpc::markStartupChecked();
        strict.addOJson(u"x.a"_s, [](const OJson&) { return OJson(); });
        QVERIFY(strict.has(u"x.a"_s));
        rpc::resetStartupCheckedForTest();
    }

    void duplicateRegistrationThrows() {
        RpcServer server([](const QByteArray&) {});
        server.addOJson(u"a.b"_s, [](const OJson&) { return OJson(); });
        try {
            server.addOJson(u"a.b"_s, [](const OJson&) { return OJson(); });
            QFAIL("该抛");
        } catch (const util::JsError& e) {
            QCOMPARE(e.message(), u"RPC 方法重复登记:a.b"_s);
        }
        try {
            server.add(u"a.b"_s, [](const QJsonValue&) { return QJsonValue(); });
            QFAIL("该抛");
        } catch (const util::JsError&) {
        }
        server.add(u"a.a"_s, [](const QJsonValue&) { return QJsonValue(); });
        server.addAsync(u"0"_s, [](const OJson&) { return util::Task<OJson>::resolved(OJson()); });
        QCOMPARE(server.methodNames(), (QStringList{u"0"_s, u"a.a"_s, u"a.b"_s}));
        QVERIFY(server.has(u"a.b"_s));
        QVERIFY(!server.has(u"a"_s));
    }

    void objectParamsOJson() {
        const auto messageFor = [](const OJson& params) {
            try {
                rpc::objectParams(u"tracker.add"_s, params);
            } catch (const rpc::RpcError& e) {
                return u"%1 %2"_s.arg(e.code()).arg(e.message());
            }
            return QString();
        };
        QCOMPARE(messageFor(js::array()), u"-32602 tracker.add 的参数不对:params 应为 object,收到 array"_s);
        QCOMPARE(messageFor(js::N(3)), u"-32602 tracker.add 的参数不对:params 应为 object,收到 number"_s);
        QCOMPARE(messageFor(js::N(std::nan(""))), u"-32602 tracker.add 的参数不对:params 应为 object,收到 nan"_s);
        QCOMPARE(messageFor(OJson::null()), u"-32602 tracker.add 的参数不对:params 应为 object,收到 null"_s);
        QCOMPARE(messageFor(js::object()), QString());
    }

    /// util::RpcError 与 rpc::RpcError 是同一个类:handler 抛哪个名字都一样接得住
    void rpcErrorIsOneClass() {
        static_assert(std::is_same_v<rpc::RpcError, util::RpcError>);
        QStringList out;
        RpcServer server([&out](const QByteArray& l) { out << QString::fromUtf8(l); });
        server.addOJson(u"t.a"_s, [](const OJson&) -> OJson { throw rpc::RpcError(-32010, u"甲"_s); });
        server.addOJson(u"t.b"_s, [](const OJson&) -> OJson { throw util::RpcError(-32011, u"乙"_s); });
        server.handleLine(R"({"id":1,"method":"t.a"})");
        server.handleLine(R"({"id":2,"method":"t.b"})");
        QCoreApplication::processEvents();
        QCOMPARE(out, (QStringList{u"{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32010,\"message\":\"甲\"}}"_s,
                                   u"{\"jsonrpc\":\"2.0\",\"id\":2,\"error\":{\"code\":-32011,\"message\":\"乙\"}}"_s}));
    }

    /// parseOJson 的嵌套深度上限:超过按解析不了答 -32700(C++ 才有的一条,JS 没有上限);上限以内原样回
    void nestingDepthLimit() {
        QStringList out;
        RpcServer server([&out](const QByteArray& l) { out << QString::fromUtf8(l); });
        const auto nested = [](int depth) { return QString(depth, u'[') + QString(depth, u']'); };
        server.handleLine((u"{\"id\":"_s + nested(util::kMaxJsonDepth - 1) + u",\"method\":\"a\"}"_s).toUtf8());  // 外面这层对象也算一层
        server.handleLine((u"{\"id\":"_s + nested(util::kMaxJsonDepth) + u",\"method\":\"a\"}"_s).toUtf8());
        server.handleLine((u"{\"id\":1,\"method\":\"a\",\"params\":"_s + nested(100000) + u"}"_s).toUtf8());  // 十万层:不崩
        QCoreApplication::processEvents();
        QCOMPARE(out.size(), 3);
        QVERIFY(out[0].contains(u"-32601"_s));
        QCOMPARE(out[1], u"{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32700,\"message\":\"无法解析的 JSON\"}}"_s);
        QCOMPARE(out[2], out[1]);
    }

    /// 钩子:serve 的开头(ready 之后)与收尾(EOF 清空之后),perf 汇总里带 extra,每个请求都被记进 timings
    void lifecycleHooks() {
        QStringList out, err, order;
        RpcServer server([&](const QByteArray& l) { out << QString::fromUtf8(l); });
        server.hooks.onServe = [&] { order << u"serve"_s << u"out=%1"_s.arg(out.size()); };
        server.hooks.onShutdown = [&] { order << u"shutdown"_s; };
        server.hooks.perfExtra = [] { return js::object({{u"qualify"_s, js::object({{u"timeouts"_s, js::N(2)}})}}); };
        server.hooks.stderrLine = [&](const QString& l) { err << l; };
        server.addAsync(u"x.slow"_s, [](const OJson&) { return delayed(40, js::object()); });
        server.addOJson(u"x.fast"_s, [](const OJson&) { return js::object(); });
        server.lanes().read.insert(u"x.slow"_s);
        bool finished = false;
        server.setOnFinished([&](int code) {
            order << u"finished %1"_s.arg(code);
            finished = true;
        });
        server.begin(u"/c.json"_s);
        QCOMPARE(out, (QStringList{u"{\"jsonrpc\":\"2.0\",\"method\":\"event\",\"params\":{\"event\":\"ready\",\"data\":{\"protocol\":\"1.0\",\"config\":\"/c.json\"}}}"_s}));
        server.handleLine(R"({"id":1,"method":"x.slow"})");
        server.handleLine(R"({"id":2,"method":"x.fast"})");
        server.handleEof();  // 读道上还有一个在跑:不能收尾
        QCoreApplication::processEvents();
        QVERIFY(!server.finished());
        QTRY_VERIFY(finished);
        QCOMPARE(order, (QStringList{u"serve"_s, u"out=1"_s, u"shutdown"_s, u"finished 0"_s}));  // 先 onShutdown、再 onFinished
        QCOMPARE(out.size(), 3);
        QVERIFY(out[1].contains(u"\"id\":2"_s));  // 快的先答
        QVERIFY(out[2].contains(u"\"id\":1"_s));
        // 收尾前最后一次汇总:两个请求、qualify 的计数摊在后面
        QCOMPARE(err.size(), 1);
        QVERIFY2(err[0].startsWith(u"[perf] "_s), qPrintable(err[0]));
        QVERIFY2(err[0].contains(u"\"qualify\":{\"timeouts\":2}"_s), qPrintable(err[0]));
        QVERIFY2(err[0].contains(u"\"x.fast\":{\"lane\":\"trade\""_s), qPrintable(err[0]));
        QVERIFY2(err[0].contains(u"\"x.slow\":{\"lane\":\"trade\""_s) || err[0].contains(u"\"x.slow\":{\"lane\":\"read\""_s), qPrintable(err[0]));
        // 没有新请求:再 flush 什么都不写
        server.flushPerf();
        QCOMPARE(err.size(), 1);
    }

    /// 本地道与读道在 handleLine 里开始,回执与交易道一样在下一轮事件循环的微任务队列里按先后写
    void dispatchTiming() {
        QStringList out;
        RpcServer server([&out](const QByteArray& l) { out << QString::fromUtf8(l); });
        server.addOJson(u"l.a"_s, [](const OJson&) { return js::object(); });
        server.addOJson(u"r.a"_s, [](const OJson&) { return js::object(); });
        server.addOJson(u"t.a"_s, [](const OJson&) { return js::object(); });
        server.addOJson(u"p.a"_s, [](const OJson&) { return js::object(); });
        server.lanes().local.insert(u"l.a"_s);
        server.lanes().read.insert(u"r.a"_s);
        server.lanes().low.insert(u"p.a"_s);
        server.handleLine(R"({"id":"t1","method":"t.a"})");
        server.handleLine(R"({"id":"p1","method":"p.a"})");
        server.handleLine(R"({"id":"l1","method":"l.a"})");
        server.handleLine(R"({"id":"r1","method":"r.a"})");
        server.handleLine(R"({"id":"t2","method":"t.a"})");
        QCOMPARE(out.size(), 0);  // 回执都晚一个「微任务」才写(微任务队列在下一轮事件循环里抽空)
        QCoreApplication::processEvents();
        QCOMPARE(out.size(), 5);  // 本地、读按各自开始的先后;交易道:t1、t2 在前,轮询 p1 殿后
        QVERIFY(out[0].contains(u"\"l1\""_s));
        QVERIFY(out[1].contains(u"\"r1\""_s));
        QVERIFY(out[2].contains(u"\"t1\""_s));
        QVERIFY(out[3].contains(u"\"t2\""_s));
        QVERIFY(out[4].contains(u"\"p1\""_s));
    }

    /// 同步答完的交易道请求很多时不递归(一批一万行也不爆栈)
    void bigBurstOfSyncRequests() {
        int answered = 0;
        RpcServer server([&answered](const QByteArray&) { ++answered; });
        server.addOJson(u"t.a"_s, [](const OJson&) { return js::object(); });
        server.addOJson(u"r.a"_s, [](const OJson&) { return js::object(); });
        server.lanes().read.insert(u"r.a"_s);
        for (int i = 0; i < 20000; ++i) server.handleLine(i % 2 ? R"({"id":1,"method":"t.a"})" : R"({"id":1,"method":"r.a"})");
        QCoreApplication::processEvents();
        QCOMPARE(answered, 20000);
    }
};

QTEST_GUILESS_MAIN(TestRpcServer)
#include "tst_rpc_server.moc"
