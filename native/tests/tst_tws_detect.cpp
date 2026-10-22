// engine/execution/tws_detect(tws.ts)对着原模块现跑的答案(tests/fixtures/gen_tws_detect.mjs)。
// 外界(目录、进程、平台、家目录)换成和生成器同一套假的:虚拟目录表、查表回话的 spawnSync,每一次调用都比;
// 端口探测与握手是记下入参、回固定结果的假实现。另比:真的 fs.globSync 在同一棵临时目录树上的结果、path.posix 的四个函数。
// 回环那一段(probePort、默认握手)只连测试自己开的端口。
#include "execution/tws_detect.h"
#include "execution/tws/codec.h"
#include "js_fixture.h"
#include "util/jsformat.h"

#include <QElapsedTimer>
#include <QFile>
#include <QRegularExpression>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTemporaryDir>
#include <QTest>
#include <QtEndian>

#include <cmath>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using jsfix::enc;
using util::OJson;
namespace js = util::js;
namespace td = execution::twsdetect;

namespace {

OJson strs(const QStringList& l) { return js::strings(l); }
QStringList listOf(const OJson* a) {
    QStringList out;
    if (a)
        for (const OJson& x : a->items) out.append(x.s);
    return out;
}
std::optional<double> optNum(const OJson* v) {
    if (jsfix::isUndefined(v) || v->type == OJson::Null) return std::nullopt;
    return jsfix::num(v);
}

/// 生成器里那一套假的外界,外加调用记录
struct FakeWorld {
    QStringList vfs, missing;
    QHash<QString, td::SpawnResult> table;
    OJson calls = js::array();

    explicit FakeWorld(const OJson& c, const QString& home) {
        vfs = listOf(c.get(u"vfs"_s));
        missing = listOf(c.get(u"missing"_s));
        for (const OJson& e : c.get(u"spawnTable"_s)->items) {
            td::SpawnResult r;
            const OJson& v = e.items[1];
            if (v.get(u"status"_s)->type != OJson::Null) r.status = static_cast<int>(v.get(u"status"_s)->n);
            r.stdoutText = v.get(u"stdout"_s)->s;
            r.stderrText = v.get(u"stderr"_s)->type == OJson::Null ? QString() : v.get(u"stderr"_s)->s;
            table.insert(e.items[0].s, r);
        }
        td::TwsSystem& s = td::system();
        s.platform = c.get(u"platform"_s)->s;
        s.homedir = [home] { return home; };
        s.env = [](const QString&) { return std::nullopt; };
        s.globSync = [this](const QString& p) {
            if (p.contains(u"[["_s)) throw util::JsError(u"bad pattern "_s + p);
            QStringList parts = p.split(u'*');
            for (QString& x : parts) x = QRegularExpression::escape(x);
            const QRegularExpression re(u"\\A"_s + parts.join(u"[^/]*"_s) + u"\\z"_s);
            QStringList out;
            for (const QString& v : vfs)
                if (re.match(v).hasMatch()) out.append(v);
            return out;
        };
        s.existsSync = [this](const QString& p) { return vfs.contains(p) && !missing.contains(p); };
        s.spawnSync = [this](const QString& cmd, const QStringList& args, std::optional<int> timeoutMs) {
            calls.items.append(js::object({{u"cmd"_s, js::S(cmd)}, {u"args"_s, strs(args)}, {u"timeout"_s, timeoutMs ? js::N(*timeoutMs) : js::Null()}}));
            return table.value(js::stringify(strs(QStringList{cmd} + args)), td::SpawnResult{1, {}, {}});
        };
        s.spawnDetached = [this](const QString& target, const QString& cwd) {
            calls.items.append(js::object({{u"cmd"_s, js::S(u"<spawn>"_s)}, {u"args"_s, strs({target, cwd})}, {u"timeout"_s, js::Null()}}));
        };
    }
    ~FakeWorld() { td::system() = td::realSystem(); }
};

contract::OrderedMap<QStringList> candsOf(const OJson& o) {
    contract::OrderedMap<QStringList> m;
    for (const auto& [k, v] : o.fields) m.insert(k, listOf(&v));
    return m;
}
contract::OrderedMap<QString> patsOf(const OJson& o) {
    contract::OrderedMap<QString> m;
    for (const auto& [k, v] : o.fields) m.insert(k, v.s);
    return m;
}
OJson appsJson(const std::vector<td::AppStatus>& apps) {
    OJson a = js::array();
    for (const auto& x : apps) a.items.append(x.toJson());
    return a;
}

td::ProbeResult probeOf(double port) {
    const bool open = std::isfinite(port) && std::fmod(std::trunc(port), 3) == 0;
    if (open) return {true, std::fmod(port, 7), std::nullopt};
    return {false, std::nullopt, u"端口未监听:"_s + util::jsNumberToString(port)};
}
td::Endpoint endpointOf(const OJson& e) {
    td::Endpoint x;
    x.port = jsfix::num(e.get(u"port"_s));
    x.label = e.get(u"label"_s)->s;
    x.kind = e.get(u"kind"_s)->s;
    if (e.get(u"paper"_s)->type == OJson::Bool) x.paper = e.get(u"paper"_s)->b;
    return x;
}
OJson statusesJson(const std::vector<td::PortStatus>& v) {
    OJson a = js::array();
    for (const auto& s : v) a.items.append(s.toJson());
    return a;
}
template <class T>
T await(const util::Task<T>& t) {
    QElapsedTimer timer;
    timer.start();
    while (!t.done() && timer.elapsed() < 10000) QCoreApplication::processEvents(QEventLoop::AllEvents, 20);
    if (!t.done()) throw util::JsError(u"<没完成>"_s);
    return t.result();
}

}  // namespace

class TestTwsDetect : public QObject {
    Q_OBJECT
    OJson fx_;
    std::vector<domain::Settings> settings_;
    QString home_;

private slots:
    void initTestCase() {
        fx_ = jsfix::load(u"tws_detect.json"_s);
        home_ = fx_.get(u"home"_s)->s;
        for (const OJson& raw : fx_.get(u"settings"_s)->items) settings_.push_back(domain::fromDict(raw));
    }
    void cleanup() { td::system() = td::realSystem(); }

    void constants() {
        const OJson& c = *fx_.get(u"constants"_s);
        OJson known = js::array();
        for (const auto& e : td::knownEndpoints())
            known.items.append(js::object({{u"port"_s, js::N(e.port)}, {u"label"_s, js::S(e.label)}, {u"kind"_s, js::S(e.kind)}, {u"paper"_s, e.paper ? js::B(*e.paper) : js::Null()}}));
        JSFIX_SAME(*c.get(u"known"_s), known, u"KNOWN_ENDPOINTS"_s);
        OJson apps = js::object();
        const auto cands = td::appCandidates();
        for (const QString& k : cands.keys()) apps.set(k, strs(*cands.find(k)));
        JSFIX_SAME(*c.get(u"apps"_s), apps, u"APP_CANDIDATES"_s);
        OJson procs = js::object();
        const auto pats = td::processPatterns();
        for (const QString& k : pats.keys()) procs.set(k, js::S(*pats.find(k)));
        JSFIX_SAME(*c.get(u"procs"_s), procs, u"PROCESS_PATTERNS"_s);
        OJson hints = js::array();
        for (const auto& [k, v] : td::ibkrErrorHints()) hints.items.append(js::array({js::S(k), js::S(v)}));
        JSFIX_SAME(*c.get(u"hints"_s), hints, u"IBKR_ERROR_HINTS"_s);
    }

    void posixPaths() {
        const QStringList pool = [&] {
            QStringList l;
            for (const OJson& c : fx_.get(u"posix"_s)->items) l.append(c.get(u"a"_s)->s);
            return l;
        }();
        for (const OJson& c : fx_.get(u"posix"_s)->items) {
            const QString a = c.get(u"a"_s)->s;
            QCOMPARE(td::posixNormalize(a), c.get(u"normalize"_s)->s);
            QCOMPARE(td::posixBasename(a), c.get(u"basename"_s)->s);
            QCOMPARE(td::posixDirname(a), c.get(u"dirname"_s)->s);
            const auto& joins = c.get(u"join"_s)->items;
            for (int i = 0; i < pool.size(); ++i) QCOMPARE(td::posixJoin(a, pool[i]), joins[i].s);
        }
    }

    void realGlob() {
        QTemporaryDir dir;
        QVERIFY(dir.isValid());
        const QString root = dir.path();
        const OJson& g = *fx_.get(u"real_glob"_s);
        for (const OJson& n : g.get(u"tree"_s)->items) {
            const QString name = n.s;
            if (name.endsWith(u'/')) QVERIFY(QDir().mkpath(root + u'/' + name));
            else {
                QFile f(root + u'/' + name);
                QVERIFY(f.open(QIODevice::WriteOnly));
                f.write("x");
            }
        }
        for (const OJson& l : g.get(u"links"_s)->items) QVERIFY(QFile::link(root + u'/' + l.items[1].s, root + u'/' + l.items[0].s));
        for (const OJson& c : g.get(u"cases"_s)->items) {
            JSFIX_EXPECT(c, [&] {
                QStringList got = td::globFiles(td::posixJoin(root, c.get(u"p"_s)->s));
                for (QString& s : got) s.replace(root, u"<ROOT>"_s);
                std::sort(got.begin(), got.end());
                return strs(got);
            }, u"glob "_s + c.get(u"p"_s)->s);
        }
    }

    void expand() {
        for (const OJson& c : fx_.get(u"expand"_s)->items) {
            FakeWorld w(c, home_);
            JSFIX_EXPECT(c, [&] { return strs(td::expandGlob(c.get(u"p"_s)->s)); }, u"expandGlob "_s + c.get(u"p"_s)->s);
        }
    }

    void detect() {
        int n = 0;
        for (const OJson& c : fx_.get(u"detect"_s)->items) {
            FakeWorld w(c, home_);
            const OJson* cands = c.get(u"cands"_s);
            JSFIX_EXPECT(c, [&] {
                if (cands->type == OJson::Null) return appsJson(td::detectApps());
                return appsJson(td::detectApps(candsOf(*cands), patsOf(*c.get(u"pats"_s))));
            }, u"detectApps #%1"_s.arg(n));
            JSFIX_SAME(*c.get(u"calls"_s), w.calls, u"detectApps 的进程调用 #%1"_s.arg(n));
            ++n;
        }
        QVERIFY(n >= 300);
    }

    void launch() {
        int n = 0;
        for (const OJson& c : fx_.get(u"launch"_s)->items) {
            FakeWorld w(c, home_);
            JSFIX_EXPECT(c, [&] { return td::launchApp(c.get(u"key"_s)->s).toJson(); }, u"launchApp #%1 %2"_s.arg(n).arg(c.get(u"key"_s)->s));
            JSFIX_SAME(*c.get(u"calls"_s), w.calls, u"launchApp 的进程调用 #%1"_s.arg(n));
            ++n;
        }
        QVERIFY(n >= 250);
    }

    void explain() {
        for (const OJson& c : fx_.get(u"explain"_s)->items) {
            td::ConnectErrorInfo info;
            info.name = c.get(u"name"_s)->s;
            info.ctorName = c.get(u"ctor"_s)->s;
            info.message = c.get(u"message"_s)->s;
            info.code = c.get(u"code"_s)->s;
            const auto port = optNum(c.get(u"port"_s));
            JSFIX_EXPECT(c, [&] { return td::explainConnectError(info, port, c.get(u"portOpen"_s)->b).toJson(); }, u"explain "_s + js::stringify(c).left(200));
        }
    }

    void alias() {
        for (const OJson& c : fx_.get(u"alias"_s)->items) {
            const auto& s = settings_[static_cast<std::size_t>(c.get(u"si"_s)->n)];
            const OJson* cn = c.get(u"cn"_s);
            const std::optional<QString> name = jsfix::isUndefined(cn) ? std::nullopt : std::optional(cn->s);
            JSFIX_EXPECT(c, [&] {
                const auto got = td::checkAliasMapping(s, listOf(c.get(u"managed"_s)), name);
                OJson r = js::array();
                for (const auto& x : got.first) r.items.append(x.toJson());
                return js::array(QList<OJson>{r, strs(got.second)});
            }, u"checkAliasMapping "_s + js::stringify(c).left(200));
        }
    }

    void scan() {
        int n = 0;
        for (const OJson& c : fx_.get(u"scan"_s)->items) {
            OJson probes = js::array();
            td::PortProber prober = [&probes](std::optional<QString> h, std::optional<double> p) {
                probes.items.append(js::array({h ? js::S(*h) : js::Null(), p ? js::N(*p) : js::Null()}));
                return util::Task<td::ProbeResult>::resolved(probeOf(p.value_or(std::nan(""))));
            };
            JSFIX_EXPECT(c, [&] {
                if (const OJson* si = c.get(u"si"_s)) return statusesJson(await(td::scanPorts(settings_[static_cast<std::size_t>(si->n)], c.get(u"host"_s)->s, prober)));
                std::vector<td::Endpoint> known;
                for (const OJson& e : dec(*c.get(u"known"_s)).items) known.push_back(endpointOf(e));
                td::ConfiguredPorts configured;
                for (const OJson& p : c.get(u"configured"_s)->items) configured.emplace_back(util::jsStringToNumber(p.items[0].s), p.items[1].s);
                return statusesJson(await(td::scanEndpoints(known, configured, u"127.0.0.1"_s, prober)));
            }, u"scan #%1"_s.arg(n));
            JSFIX_SAME(*c.get(u"probes"_s), probes, u"scan 的探测 #%1"_s.arg(n));
            ++n;
        }
    }

    void diagnose() {
        int n = 0;
        for (const OJson& c : fx_.get(u"diagnose"_s)->items) {
            const auto& s = settings_[static_cast<std::size_t>(c.get(u"si"_s)->n)];
            OJson probes = js::array(), shakes = js::array();
            const OJson& probe = *c.get(u"probe"_s);
            td::ProbeResult pr{probe.get(u"open"_s)->b, optNum(probe.get(u"latency_ms"_s)),
                               probe.get(u"error"_s)->type == OJson::Null ? std::nullopt : std::optional(probe.get(u"error"_s)->s)};
            td::DiagnoseOptions o;
            o.clientId = optNum(c.get(u"clientId"_s));
            o.timeoutMs = optNum(c.get(u"timeoutMs"_s));
            o.prober = [&probes, pr](std::optional<QString> h, std::optional<double> p) {
                probes.items.append(js::array({h ? js::S(*h) : js::Null(), p ? js::N(*p) : js::Null()}));
                return util::Task<td::ProbeResult>::resolved(pr);
            };
            const bool throws = c.get(u"hsKind"_s)->s == u"throw";
            const OJson info = *c.get(u"info"_s), err = *c.get(u"err"_s);
            o.handshake = [&shakes, throws, info, err](td::HandshakeArgs a) -> util::Task<td::HandshakeInfo> {
                OJson j = js::object();
                if (a.host) j.set(u"host"_s, js::S(*a.host));
                if (a.port) j.set(u"port"_s, js::N(*a.port));
                j.set(u"clientId"_s, js::N(a.clientId));
                j.set(u"timeoutMs"_s, js::N(a.timeoutMs));
                shakes.items.append(j);
                util::Deferred<td::HandshakeInfo> d;
                if (throws) {
                    const QString name = err.get(u"name"_s)->s, code = err.get(u"code"_s)->s, msg = err.get(u"message"_s)->s;
                    if (name == u"Error" && code.isEmpty()) d.reject(util::JsError(msg));
                    else d.reject(td::NamedError(msg, name, code));
                } else {
                    td::HandshakeInfo hi;
                    hi.serverVersion = optNum(info.get(u"serverVersion"_s));
                    if (info.get(u"serverTime"_s)->type == OJson::String) hi.serverTime = info.get(u"serverTime"_s)->s;
                    hi.managedAccounts = listOf(info.get(u"managedAccounts"_s));
                    d.resolve(hi);
                }
                return d.task();
            };
            JSFIX_EXPECT(c, [&] { return await(td::diagnose(s, c.get(u"name"_s)->s, o)); }, u"diagnose #%1 %2"_s.arg(n).arg(c.get(u"name"_s)->s));
            JSFIX_SAME(*c.get(u"probes"_s), probes, u"diagnose 的探测 #%1"_s.arg(n));
            JSFIX_SAME(*c.get(u"shakes"_s), shakes, u"diagnose 的握手入参 #%1"_s.arg(n));
            ++n;
        }
        QVERIFY(n >= 700);
    }

    void guide() {
        for (const OJson& c : fx_.get(u"guide"_s)->items) {
            OJson a = js::array();
            for (const auto& g : td::connectionGuide(settings_[static_cast<std::size_t>(c.get(u"si"_s)->n)])) a.items.append(g.toJson());
            JSFIX_SAME(*c.get(u"out"_s), a, u"connectionGuide"_s);
        }
    }

    // ---- 回环(只连测试自己开的端口)
    void probeLoopback() {
        QTcpServer server;
        QVERIFY(server.listen(QHostAddress::LocalHost, 0));
        const auto open = await(td::probePort(u"127.0.0.1"_s, server.serverPort()));
        QVERIFY(open.open);
        QVERIFY(open.latency_ms.has_value());
        QVERIFY(!open.error);
        quint16 closedPort;
        {
            QTcpServer probe;
            probe.listen(QHostAddress::LocalHost, 0);
            closedPort = probe.serverPort();
        }
        const auto closed = await(td::probePort(u"127.0.0.1"_s, closedPort));
        QVERIFY(!closed.open);
        QCOMPARE(closed.error, std::optional<QString>(u"端口未监听"_s));
        QVERIFY(!closed.latency_ms);
        bool threw = false;
        try {
            await(td::probePort(u"127.0.0.1"_s, 70000));
        } catch (const util::JsError& e) {
            threw = true;
            QCOMPARE(e.message(), u"Port should be >= 0 and < 65536. Received type number (70000)."_s);
        }
        QVERIFY(threw);
    }

    void defaultHandshakeLoopback() {
        // 假 TWS:回版本 176、账户表、下一个订单号;记下收到的报到与要账户表
        QTcpServer server;
        QVERIFY(server.listen(QHostAddress::LocalHost, 0));
        QByteArray seen;
        QTcpSocket* peer = nullptr;
        bool greeted = false;
        connect(&server, &QTcpServer::newConnection, this, [&] {
            peer = server.nextPendingConnection();
            connect(peer, &QTcpSocket::readyRead, this, [&] {
                seen += peer->readAll();
                if (!greeted && seen.size() >= 8) {
                    greeted = true;
                    peer->write(tws::frame({u"176"_s, u"20261019 10:00:00 Asia/Shanghai"_s}));
                    peer->write(tws::frame({u"15"_s, u"1"_s, u"DU7654321, DU0000001,"_s}));
                }
            });
        });
        const auto info = await(td::defaultHandshake({u"127.0.0.1"_s, double(server.serverPort()), 101, 3000}));
        QCOMPARE(info.serverVersion, std::optional<double>(176));
        QVERIFY(!info.serverTime);
        QCOMPARE(info.managedAccounts, (QStringList{u"DU7654321"_s, u"DU0000001"_s}));
        QVERIFY(seen.startsWith(tws::handshake(100, 193)));
        QTRY_VERIFY(seen.contains(tws::frame({u"71"_s, u"2"_s, u"101"_s, QString()})));

        // 不答:超时
        QTcpServer silent;
        QVERIFY(silent.listen(QHostAddress::LocalHost, 0));
        bool threw = false;
        try {
            await(td::defaultHandshake({u"127.0.0.1"_s, double(silent.serverPort()), 101, 200}));
        } catch (const util::JsError& e) {
            threw = true;
            QCOMPARE(e.message(), u"timeout"_s);
            QCOMPARE(td::explainConnectError(td::errorInfoOf(e), 7497, true).code, u"handshake_timeout"_s);
        }
        QVERIFY(threw);
        // 端口是 undefined(Object.prototype 上的连接名)
        threw = false;
        try {
            await(td::defaultHandshake({std::nullopt, std::nullopt, std::nan(""), 200}));
        } catch (const util::JsError& e) {
            threw = true;
            QCOMPARE(td::explainConnectError(td::errorInfoOf(e), std::nullopt, true).reason,
                     u"TypeError: The \"options\" or \"port\" or \"path\" argument must be specified"_s);
        }
        QVERIFY(threw);
    }

    void defaultHandshakeErrorWindow() {
        // 连接级错误只认 500–599;别的(498、600、2104…)当通告忽略,接着等账户表
        struct Case {
            QString code;
            bool rejects;
        };
        for (const Case& c : {Case{u"499"_s, false}, Case{u"500"_s, true}, Case{u"502"_s, true}, Case{u"599"_s, true}, Case{u"600"_s, false}, Case{u"2104"_s, false}}) {
            QTcpServer server;
            QVERIFY(server.listen(QHostAddress::LocalHost, 0));
            QTcpSocket* peer = nullptr;
            QByteArray seen;
            bool greeted = false, started = false;
            connect(&server, &QTcpServer::newConnection, this, [&] {
                peer = server.nextPendingConnection();
                connect(peer, &QTcpSocket::readyRead, this, [&] {
                    seen += peer->readAll();
                    if (!greeted && seen.size() >= 8) {
                        greeted = true;
                        peer->write(tws::frame({u"176"_s, u"20261019 10:00:00 Asia/Shanghai"_s}));
                    }
                    if (greeted && !started && seen.contains(tws::frame({u"71"_s, u"2"_s, u"101"_s, QString()}))) {
                        started = true;
                        peer->write(tws::frame({u"4"_s, u"2"_s, u"-1"_s, c.code, u"boom"_s, QString()}));
                        peer->write(tws::frame({u"15"_s, u"1"_s, u"DU7654321"_s}));
                    }
                });
            });
            bool threw = false;
            QString message;
            try {
                const auto info = await(td::defaultHandshake({u"127.0.0.1"_s, double(server.serverPort()), 101, 3000}));
                QCOMPARE(info.managedAccounts, (QStringList{u"DU7654321"_s}));
            } catch (const util::JsError& e) {
                threw = true;
                message = e.message();
            }
            QVERIFY2(threw == c.rejects, qPrintable(c.code));
            if (c.rejects) QCOMPARE(message, c.code + u": boom"_s);
        }
    }

    void defaultHandshakePeerLimits() {
        // 失常的对端:版本超出 [100, 193] 当场拒(506);缓冲攒过 0xffffff 字节当场拒(502),正好 0xffffff 还不拒
        for (const auto& [version, rejects] : std::vector<std::pair<QString, bool>>{{u"99"_s, true}, {u"193"_s, false}, {u"194"_s, true}}) {
            QTcpServer server;
            QVERIFY(server.listen(QHostAddress::LocalHost, 0));
            QTcpSocket* peer = nullptr;
            QByteArray seen;
            bool greeted = false;
            connect(&server, &QTcpServer::newConnection, this, [&] {
                peer = server.nextPendingConnection();
                connect(peer, &QTcpSocket::readyRead, this, [&] {
                    seen += peer->readAll();
                    if (!greeted && seen.size() >= 8) {
                        greeted = true;
                        peer->write(tws::frame({version, u"20261019 10:00:00 Asia/Shanghai"_s}));
                        peer->write(tws::frame({u"15"_s, u"1"_s, u"DU7654321"_s}));
                    }
                });
            });
            QString message;
            try {
                const auto info = await(td::defaultHandshake({u"127.0.0.1"_s, double(server.serverPort()), 101, 3000}));
                QCOMPARE(info.serverVersion, std::optional<double>(version.toDouble()));
            } catch (const util::JsError& e) {
                message = e.message();
            }
            if (rejects) QCOMPARE(message, u"506: Unsupported Version "_s + version);
            else QVERIFY2(message.isEmpty(), qPrintable(message));
        }

        QTcpServer server;
        QVERIFY(server.listen(QHostAddress::LocalHost, 0));
        QTcpSocket* peer = nullptr;
        QByteArray seen;
        bool greeted = false, versionSent = false;
        connect(&server, &QTcpServer::newConnection, this, [&] {
            peer = server.nextPendingConnection();
            connect(peer, &QTcpSocket::readyRead, this, [&] {
                seen += peer->readAll();
                if (!versionSent && seen.size() >= 8) {
                    versionSent = true;
                    peer->write(tws::frame({u"176"_s, u"20261019 10:00:00 Asia/Shanghai"_s}));
                } else if (!greeted && seen.contains(tws::frame({u"71"_s, u"2"_s, u"101"_s, QString()}))) {
                    // 客户端已经读完版本(报到发出来了),缓冲是空的。再送一条永远凑不齐的消息:长度写 0x7fffffff,
                    // 先送到缓冲里正好 0xffffff 字节(含 4 字节长度)。库是先拼进缓冲再比长度,所以要等版本那条被消费掉
                    greeted = true;
                    QByteArray big(0xffffff, 'x');
                    qToBigEndian<quint32>(0x7fffffff, big.data());
                    peer->write(big);
                }
            });
        });
        auto task = td::defaultHandshake({u"127.0.0.1"_s, double(server.serverPort()), 101, 20000});
        QTRY_VERIFY_WITH_TIMEOUT(peer && peer->bytesToWrite() == 0 && greeted, 10000);
        QTest::qWait(500);
        QVERIFY2(!task.done(), "正好 0xffffff 字节不该拒");
        peer->write("y");
        QString message;
        try {
            await(task);
        } catch (const util::JsError& e) {
            message = e.message();
        }
        QCOMPARE(message, u"502: Message of size 16777216 exceeded max message length 16777215"_s);
    }

    void launchWithoutInstall() {
        // 真的那一套里只换进程与目录:确认 launchApp 的闸门先于任何动作
        td::system().spawnSync = [](const QString&, const QStringList&, std::optional<int>) -> td::SpawnResult { throw util::JsError(u"不该起进程"_s); };
        for (const QString& bad : {u"evil.exe"_s, QString(), u"C:/别的程序.exe"_s}) {
            bool threw = false;
            try {
                td::launchApp(bad);
            } catch (const util::JsError& e) {
                threw = true;
                QVERIFY(e.message().startsWith(u"只支持拉起 tws 或 gateway"_s));
            }
            QVERIFY(threw);
        }
    }
};

QTEST_GUILESS_MAIN(TestTwsDetect)
#include "tst_tws_detect.moc"
