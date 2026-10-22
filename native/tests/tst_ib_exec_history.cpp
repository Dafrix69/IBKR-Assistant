// engine/execution/ib_exec_history(ibExecHistory.ts)。
// 对拍(tests/fixtures/gen_ib_exec_history.mjs):发出去的字节、切消息、成交消息的按位读,逐字节 / 逐字符比;
// 状态机在两千条随机事件序列上一步一步比(写了什么、end / destroy 了几次、结果)。
// 真 socket 那一层:回环上的假 TWS(QTcpServer,只连测试自己开的端口)走一趟成功、连不上、不答、被关、端口不合格。
#include "execution/ib_exec_history.h"
#include "js_fixture.h"
#include "util/error.h"

#include <QElapsedTimer>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTest>
#include <QtEndian>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using jsfix::enc;
using util::OJson;
namespace js = util::js;
namespace ex = execution;

namespace {
QByteArray unhex(const OJson* v) { return QByteArray::fromHex(v->s.toLatin1()); }
QString hex(const QByteArray& b) { return QString::fromLatin1(b.toHex()); }
QList<ex::FrameField> fieldsOf(const OJson& a) {
    QList<ex::FrameField> out;
    for (const OJson& x : a.items) {
        if (x.type == OJson::String) out.append(x.s);
        else out.append(x.n);
    }
    return out;
}
OJson rowJson(const ex::ExecutionRow& r) { return js::object({{u"contract"_s, r.contract}, {u"execution"_s, r.execution}}); }
OJson resultJson(const ex::HistoryResult& r) {
    OJson d = js::array();
    for (const auto& row : r.details) d.items.append(rowJson(row));
    return js::object({{u"serverVersion"_s, js::N(r.serverVersion)}, {u"supported"_s, js::B(r.supported)}, {u"details"_s, d}});
}
QStringList strs(const OJson& a) {
    QStringList out;
    for (const OJson& x : a.items) out.append(x.s);
    return out;
}

QByteArray frameOf(const QStringList& fields) {
    QList<ex::FrameField> f;
    for (const QString& s : fields) f.append(s);
    return ex::frame(f);
}

/// 回环上的假 TWS:按脚本回话。mode 决定怎么回
class LoopbackTws : public QObject {
public:
    enum Mode { Normal, Silent, CloseAfterHello, OldVersion };
    explicit LoopbackTws(Mode mode) : mode_(mode) {
        server_.listen(QHostAddress::LocalHost, 0);
        connect(&server_, &QTcpServer::newConnection, this, [this] {
            peer_ = server_.nextPendingConnection();
            connect(peer_, &QTcpSocket::readyRead, this, [this] { onRead(); });
        });
    }
    quint16 port() const { return server_.serverPort(); }
    QByteArray seen;
    QList<QStringList> requests;

private:
    void onRead() {
        seen += peer_->readAll();
        if (stage_ == 0) {
            if (seen.size() < 8) return;
            const auto size = static_cast<qsizetype>(qFromBigEndian<quint32>(seen.constData() + 4));
            if (seen.size() < 8 + size) return;
            hsLen_ = 8 + size;
            stage_ = 1;
            if (mode_ == Silent) return;
            if (mode_ == OldVersion) {
                peer_->write(frameOf({u"187"_s, u"20261009 10:05:01 Asia/Shanghai"_s}));
                return;
            }
            peer_->write(frameOf({u"200"_s, u"20261009 10:05:01 Asia/Shanghai"_s}));
            if (mode_ == CloseAfterHello) {
                peer_->write(frameOf({u"4"_s, u"-1"_s, u"326"_s, u"Unable to connect as the client id is already in use."_s, QString(), u"2"_s}));
                peer_->flush();
                peer_->disconnectFromHost();
                return;
            }
        }
        const QByteArray tail = seen.mid(hsLen_ + parsed_);
        const auto cut = ex::splitFrames(tail);
        parsed_ += tail.size() - cut.rest.size();
        for (const QStringList& f : cut.frames) {
            requests.append(f);
            if (f.value(0) == u"71") {
                peer_->write(frameOf({u"15"_s, u"1"_s, u"U1234567"_s}) + frameOf({u"9"_s, u"1"_s, u"1"_s}));
            } else if (f.value(0) == u"7") {
                QStringList exec{u"11"_s, u"1"_s, u"0"_s, u"920693462"_s, u"SPX"_s, u"OPT"_s, u"20261007"_s, u"7790.0"_s, u"P"_s, u"100"_s, u"CBOE"_s, u"USD"_s,
                                 u"SPXW  261007P07790000"_s, u"SPXW"_s, u"0002be7b.6ac604b0.02.01"_s, u"20261007-15:59:06"_s, u"U1234567"_s, u"CBOE"_s, u"BOT"_s,
                                 u"1"_s, u"8.58"_s, u"1165676521"_s, u"0"_s, u"0"_s, u"1"_s, u"8.58"_s, QString(), QString(), QString(), QString(), u"2"_s, u"0"_s, QString()};
                const QByteArray all = frameOf(exec) + frameOf({u"55"_s, u"1"_s, u"1"_s});
                // 分两块送,测接上
                peer_->write(all.left(50));
                peer_->flush();
                peer_->write(all.mid(50));
            }
        }
    }

    Mode mode_;
    QTcpServer server_;
    QTcpSocket* peer_ = nullptr;
    int stage_ = 0;
    qsizetype hsLen_ = 0;
    qsizetype parsed_ = 0;
};

/// 等一个 Task 完成;返回 {结果, 错的话}
template <class T>
std::pair<std::optional<T>, QString> settle(const util::Task<T>& task, int ms = 5000) {
    QElapsedTimer t;
    t.start();
    while (!task.done() && t.elapsed() < ms) QCoreApplication::processEvents(QEventLoop::AllEvents, 20);
    if (!task.done()) return {std::nullopt, u"<没完成>"_s};
    try {
        return {task.result(), QString()};
    } catch (const util::JsError& e) {
        return {std::nullopt, e.message()};
    }
}
}  // namespace

class TestIbExecHistory : public QObject {
    Q_OBJECT
    OJson fx_;

private slots:
    void initTestCase() { fx_ = jsfix::load(u"ib_exec_history.json"_s); }

    void timerDelay() {
        // Node 的 setTimeout:不在 [1, 2^31 − 1] 里的按 1 毫秒(并警告),小数截掉
        const double nan = std::nan("");
        const QList<QPair<double, double>> cases{{8000, 8000}, {1, 1}, {0.4, 1}, {0, 1}, {-1, 1}, {nan, 1}, {1.9, 1}, {7500.7, 7500}, {2147483647.0, 2147483647.0},
                                                 {2147483648.0, 1}, {1e10, 1}, {INFINITY, 1}, {-INFINITY, 1}};
        for (const auto& c : cases) QCOMPARE(ex::nodeTimerDelay(c.first), c.second);
    }

    void bytesOut() {
        const OJson& b = *fx_.get(u"bytes"_s);
        QCOMPARE(hex(ex::handshakeBytes()), b.get(u"handshake"_s)->s);
        for (const OJson& r : b.get(u"clientIds"_s)->items) QCOMPARE(js::stringify(enc(js::N(ex::historyClientId(jsfix::num(&r.items[0]))))), js::stringify(r.items[1]));
        for (const OJson& r : b.get(u"startApi"_s)->items) QCOMPARE(hex(ex::startApiBytes(jsfix::num(&r.items[0]))), r.items[1].s);
        for (const OJson& r : b.get(u"exec"_s)->items) QCOMPARE(hex(ex::executionsRequestBytes(jsfix::num(&r.items[0]), jsfix::num(&r.items[1]))), r.items[2].s);
        for (const OJson& c : fx_.get(u"frames"_s)->items) QCOMPARE(hex(ex::frame(fieldsOf(dec(*c.get(u"fields"_s))))), c.get(u"hex"_s)->s);
    }

    void split() {
        for (const OJson& c : fx_.get(u"split"_s)->items) {
            JSFIX_EXPECT(c, [&] {
                const auto s = ex::splitFrames(unhex(c.get(u"hex"_s)));
                OJson frames = js::array();
                for (const QStringList& f : s.frames) frames.items.append(js::strings(f));
                return js::object({{u"frames"_s, frames}, {u"rest"_s, js::S(hex(s.rest))}});
            }, u"splitFrames "_s + c.get(u"hex"_s)->s);
        }
    }

    void decode() {
        int n = 0;
        for (const OJson& c : fx_.get(u"decode"_s)->items) {
            JSFIX_EXPECT(c, [&] {
                const auto got = ex::decodeExecution(strs(*c.get(u"fields"_s)));
                if (!got) return js::Null();
                return js::object({{u"reqId"_s, js::N(got->reqId)}, {u"detail"_s, rowJson(got->detail)}});
            }, u"decodeExecution "_s + js::stringify(*c.get(u"fields"_s)));
            ++n;
        }
        QVERIFY(n >= 600);
    }

    void runs() {
        int n = 0;
        for (const OJson& run : fx_.get(u"runs"_s)->items) {
            const QString what = u"第 %1 趟"_s.arg(n);
            QStringList sent;
            int ended = 0, destroyed = 0;
            bool cleared = false;
            std::optional<OJson> outcome;
            const OJson* tmo = run.get(u"timeoutMs"_s);
            const double timeoutMs = jsfix::isUndefined(tmo) ? 8000 : jsfix::num(tmo);
            ex::HistoryExchange x(
                ex::HistoryExchange::Io{
                    [&](const QByteArray& b) { sent.append(hex(b)); },
                    [&] { ++ended; },
                    [&] { ++destroyed; },
                    [&] { cleared = true; },
                },
                jsfix::num(run.get(u"clientId"_s)), jsfix::num(run.get(u"days"_s)), timeoutMs,
                [&](std::optional<ex::HistoryResult> r, const QString& error) {
                    QVERIFY2(!outcome, qPrintable(what + u":结果交了两次"_s));
                    outcome = r ? js::object({{u"ok"_s, resultJson(*r)}}) : js::object({{u"error"_s, js::S(error)}});
                });
            bool fired = false;
            for (const OJson& step : run.get(u"steps"_s)->items) {
                const QString t = step.get(u"t"_s)->s;
                if (t == u"connect") x.onConnect();
                else if (t == u"data") x.onData(unhex(step.get(u"hex"_s)));
                else if (t == u"error") x.onError(step.get(u"msg"_s)->s);
                else if (t == u"close") x.onClose();
                else if (t == u"timeout" && !cleared && !fired) {
                    fired = true;
                    x.onTimeout();
                }
                QCOMPARE(double(sent.size()), step.get(u"sent"_s)->n);
                QCOMPARE(double(ended), step.get(u"ended"_s)->n);
                QCOMPARE(double(destroyed), step.get(u"destroyed"_s)->n);
            }
            QCOMPARE(js::stringify(js::strings(sent)), js::stringify(*run.get(u"sent"_s)));
            QCOMPARE(cleared, run.get(u"timerCleared"_s)->b);
            const OJson* want = run.get(u"outcome"_s);
            if (want->type == OJson::Null) QVERIFY2(!outcome, qPrintable(what));
            else {
                QVERIFY2(outcome, qPrintable(what + u":C++ 没给结果"_s));
                JSFIX_SAME(*want, *outcome, what);
            }
            ++n;
        }
        QVERIFY(n >= 2000);
    }

    // ---- 真 socket(回环,只连测试自己开的端口)
    void loopbackSuccess() {
        LoopbackTws tws(LoopbackTws::Normal);
        auto [r, err] = settle(ex::fetchExecutionHistory({u"127.0.0.1"_s, double(tws.port()), ex::historyClientId(12), 30, std::nullopt, {}}));
        QVERIFY2(r, qPrintable(err));
        QCOMPARE(r->serverVersion, 200.0);
        QVERIFY(r->supported);
        QCOMPARE(int(r->details.size()), 1);
        QCOMPARE(r->details[0].execution.get(u"execId"_s)->s, u"0002be7b.6ac604b0.02.01"_s);
        QCOMPARE(r->details[0].contract.get(u"strike"_s)->n, 7790.0);
        QVERIFY(tws.seen.startsWith(ex::handshakeBytes()));
        QCOMPARE(tws.requests.size(), 2);
        QCOMPARE(tws.requests[0], (QStringList{u"71"_s, u"2"_s, u"9012"_s, QString()}));
        // 天数夹到 7
        QCOMPARE(tws.requests[1], (QStringList{u"7"_s, u"3"_s, u"1"_s, u"0"_s, QString(), QString(), QString(), QString(), QString(), QString(), u"7"_s, u"0"_s}));
    }

    void loopbackOldVersion() {
        LoopbackTws tws(LoopbackTws::OldVersion);
        auto [r, err] = settle(ex::fetchExecutionHistory({u"127.0.0.1"_s, double(tws.port()), 9012, 7, std::nullopt, {}}));
        QVERIFY2(r, qPrintable(err));
        QCOMPARE(r->serverVersion, 187.0);
        QVERIFY(!r->supported);
        QVERIFY(r->details.empty());
    }

    void loopbackRefused() {
        quint16 port;
        {
            QTcpServer probe;
            probe.listen(QHostAddress::LocalHost, 0);
            port = probe.serverPort();
        }
        auto [r, err] = settle(ex::fetchExecutionHistory({u"127.0.0.1"_s, double(port), 9012, 7, std::nullopt, {}}));
        QVERIFY(!r);
        QCOMPARE(err, u"往回要成交的连接出错:connect ECONNREFUSED 127.0.0.1:%1"_s.arg(port));
    }

    void loopbackSilent() {
        LoopbackTws tws(LoopbackTws::Silent);
        auto [r, err] = settle(ex::fetchExecutionHistory({u"127.0.0.1"_s, double(tws.port()), 9012, 7, 300, {}}));
        QVERIFY(!r);
        QCOMPARE(err, u"往回要成交等了 0 秒没有回应"_s);
    }

    void loopbackClosed() {
        LoopbackTws tws(LoopbackTws::CloseAfterHello);
        auto [r, err] = settle(ex::fetchExecutionHistory({u"127.0.0.1"_s, double(tws.port()), 9012, 7, std::nullopt, {}}));
        QVERIFY(!r);
        QCOMPARE(err, u"往回要成交的连接被 TWS 关了:326 Unable to connect as the client id is already in use."_s);
    }

    void badPort() {
        for (const double p : {70000.0, -1.0, 1.5, std::nan("")}) {
            auto [r, err] = settle(ex::fetchExecutionHistory({u"127.0.0.1"_s, p, 9012, 7, std::nullopt, {}}));
            QVERIFY(!r);
            QVERIFY2(err.startsWith(u"Port should be >= 0 and < 65536. Received type number ("_s), qPrintable(err));
        }
    }
};

QTEST_GUILESS_MAIN(TestIbExecHistory)
#include "tst_ib_exec_history.moc"
