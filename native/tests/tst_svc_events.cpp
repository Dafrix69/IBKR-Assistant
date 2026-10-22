// EventsService(services/events.ts)对着原模块现跑的答案:脚本驱动的假取数器 / 假 router + 真的交易库(偏好表)+ 虚拟钟。
// 夹具:fixtures/svc_events.json(gen_svc_events.mjs)。另有:缺省取数器(publicFetch)对着回环上的假服务器。
#include "orchestrate/services/events.h"
#include "orchestrate/services/public_fetch.h"
#include "svc_world.h"

#include <QTcpServer>
#include <QTcpSocket>
#include <QTest>

using namespace svcw;

namespace {

Svc buildEvents(World&, Host& host, const OJson&, Runner& runner) {
    ibkr::analysis::macro::clearMacroCache();
    auto svc = std::make_shared<EventsService>(host);
    svc->fetcher = runner.makeFetcher();
    Svc s;
    s.methods[u"list"_s] = [svc](OJson a) -> Task<OJson> { co_return co_await svc->list(flag(a, u"force"_s)); };
    s.methods[u"setConfig"_s] = [svc](OJson a) -> Task<OJson> { co_return svc->setConfig(*a.get(u"input"_s)); };
    s.methods[u"config"_s] = [svc](const OJson&) -> Task<OJson> { co_return svc->config(); };
    s.methods[u"add"_s] = [svc](OJson a) -> Task<OJson> {
        const OJson& p = *a.get(u"params"_s);
        EventsService::AddParams params;
        params.title = str(p, u"title"_s);
        params.date_et = str(p, u"date_et"_s);
        params.time_et = str(p, u"time_et"_s);
        if (const OJson* v = p.get(u"note"_s)) params.note = v->s;
        if (const OJson* v = p.get(u"impact"_s)) params.impact = v->s;
        if (const OJson* v = p.get(u"linger_min"_s)) params.linger_min = v->n;
        co_return svc->add(params);
    };
    s.methods[u"remove"_s] = [svc](OJson a) -> Task<OJson> { co_return js::B(svc->remove(str(a, u"id"_s))); };
    s.gets[u"config"_s] = [svc](const OJson&) { return svc->config(); };
    s.stop = [svc] {};
    return s;
}

}  // namespace

class TstSvcEvents : public QObject {
    Q_OBJECT
private slots:
    void scenarios() {
        const OJson fx = jsfix::load(u"svc_events.json"_s);
        const OJson& base = *fx.get(u"base"_s);
        QStringList failures;
        int n = 0;
        for (const OJson& sc : fx.get(u"scenarios"_s)->items) {
            const QString what = sc.get(u"name"_s)->s;
            if (qEnvironmentVariableIsSet("SVC_TRACE")) fprintf(stderr, "scenario %s\n", qPrintable(what));
            const OJson script = jsfix::dec(*sc.get(u"script"_s));
            Runner runner(script, base, buildEvents);
            const OJson got = runner.run();
            if (qEnvironmentVariableIsSet("SVC_DUMP") && what == qEnvironmentVariable("SVC_DUMP")) {
                QFile f(QDir::tempPath() + u"/svc_got.json"_s);
                if (f.open(QIODevice::WriteOnly)) f.write(js::stringify(jsfix::enc(got)).toUtf8());
            }
            if (!jsfix::same(*sc.get(u"expected"_s), got, what)) failures.append(what);
            ++n;
        }
        QVERIFY2(failures.isEmpty(), qPrintable(failures.join(u"\n"_s)));
        QVERIFY(n > 0);
    }

    // V8 的 Number.prototype.toString(radix):整数、小数、进位、2^53 以上补零
    void radix() {
        const OJson fx = jsfix::load(u"svc_events.json"_s);
        int n = 0;
        QStringList bad;
        for (const OJson& row : fx.get(u"radix"_s)->items) {
            const double v = row.items[0].n;
            const int base = int(row.items[1].n);
            const QString got = ibkr::orchestrate::toRadixString(v, base);
            if (got != row.items[2].s) bad.append(QString::number(v, 'g', 17) + u" /"_s + QString::number(base) + u": 想要 "_s + row.items[2].s + u" 得到 "_s + got);
            ++n;
        }
        QVERIFY2(bad.isEmpty(), qPrintable(bad.mid(0, 10).join(u"\n"_s)));
        QVERIFY(n > 3000);
    }

    // 缺省取数器:回环上的假服务器(绝不连真主机)。到点前回 JSON / 回 HTML / 回 404 / 不回话
    void publicFetchLoopback() {
        QTcpServer server;
        QVERIFY(server.listen(QHostAddress::LocalHost, 0));
        QStringList seenAgents;
        QObject::connect(&server, &QTcpServer::newConnection, [&] {
            while (QTcpSocket* c = server.nextPendingConnection()) {
                QObject::connect(c, &QTcpSocket::readyRead, c, [c, &seenAgents] {
                    const QByteArray req = c->readAll();
                    const QString line = QString::fromLatin1(req.left(req.indexOf("\r\n")));
                    for (const QByteArray& h : req.split('\n'))
                        if (h.toLower().startsWith("user-agent:")) seenAgents.append(QString::fromLatin1(h.mid(11)).trimmed());
                    QByteArray body, status = "200 OK";
                    if (line.contains(u"/json")) body = R"([{"a":1}])";
                    else if (line.contains(u"/html")) body = "<html>  not   json\n  at all, this page is long enough to cut off at sixty characters ........</html>";
                    else if (line.contains(u"/missing")) status = "404 Not Found";
                    else if (line.contains(u"/hang")) return;
                    c->write("HTTP/1.1 " + status + "\r\nContent-Length: " + QByteArray::number(body.size()) + "\r\nConnection: close\r\n\r\n" + body);
                    c->disconnectFromHost();
                });
            }
        });
        const QString base = u"http://127.0.0.1:%1"_s.arg(server.serverPort());
        const auto run = [&](const QString& path, double ms) -> Task<OJson> {
            Task<OJson> t = ibkr::orchestrate::publicFetch(base + path, ms, u"dafri-test/1"_s, u"日历源"_s);
            for (int i = 0; i < 500 && !t.done(); ++i) QTest::qWait(10);
            return t;
        };
        const Task<OJson> ok = run(u"/json"_s, 3000);
        QVERIFY(ok.done());
        QVERIFY(!ok.error());
        QCOMPARE(js::stringify(ok.result()), u"[{\"a\":1}]"_s);
        QVERIFY(seenAgents.contains(u"dafri-test/1"_s));
        const Task<OJson> html = run(u"/html"_s, 3000);
        QVERIFY(html.error());
        try {
            html.result();
        } catch (const ibkr::util::JsError& e) {
            QCOMPARE(e.message(), u"日历源返回的不是 JSON(前 60 字:<html> not json at all, this page is long enough to cut)"_s);
        }
        const Task<OJson> miss = run(u"/missing"_s, 3000);
        try {
            miss.result();
            QFAIL("应当抛");
        } catch (const ibkr::util::JsError& e) {
            QCOMPARE(e.message(), u"日历源返回 HTTP 404"_s);
        }
        const Task<OJson> hang = run(u"/hang"_s, 200);
        try {
            hang.result();
            QFAIL("应当抛");
        } catch (const ibkr::util::JsError& e) {
            QCOMPARE(e.message(), u"This operation was aborted"_s);
        }
        const Task<OJson> refused = run(u"x"_s, 200);  // 地址解析不了:http://127.0.0.1:Nx → 端口不合法
        QVERIFY(refused.error());
    }
};

QTEST_GUILESS_MAIN(TstSvcEvents)
#include "tst_svc_events.moc"
