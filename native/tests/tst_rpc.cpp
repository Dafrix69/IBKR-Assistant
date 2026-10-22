// stdio JSON-RPC:回的话与 TS 版一字不差(-32700 / -32601 的原话、id 的回法),system.status 的形状与契约一样。
// 契约的键不在这里抄一份:直接读 engine-ts/src/contract/system.ts 里的接口定义,TS 那边加了字段这里就红。
// 最后一条把真的 ibkr-engine 进程跑起来:ready 是第一行、一行请求一行回执、stdin 关了就退出码 0。
#include "json_compare.h"
#include "transport/handlers/system.h"
#include "transport/rpc_server.h"

#include <QCoreApplication>
#include <QFile>
#include <QJsonArray>
#include <QProcess>
#include <QTemporaryDir>
#include <QRegularExpression>
#include "util/rpc_error.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;

namespace {

/// TS 源码 text 里 `export interface <name> {` 到 `}` 之间声明的字段名(按出现的先后)。
/// 字段名按 TS 标识符认(大小写、数字都算),不只认现在恰好在用的 snake_case
QStringList interfaceFields(const QString& text, const QString& interfaceName) {
    const qsizetype start = text.indexOf(u"export interface "_s + interfaceName + u" {"_s);
    if (start < 0) qFatal("契约里没有 %s", qPrintable(interfaceName));
    const qsizetype end = text.indexOf(u"\n}"_s, start);
    const QString body = text.mid(start, end - start);
    QStringList fields;
    static const QRegularExpression field(uR"(^  (?:readonly )?([A-Za-z_$][A-Za-z0-9_$]*)\??:)"_s, QRegularExpression::MultilineOption);
    for (auto it = field.globalMatch(body); it.hasNext();) fields.append(it.next().captured(1));
    return fields;
}

/// contract/system.ts 里那个接口的字段名
QStringList contractFields(const QString& interfaceName) {
    QFile file(QStringLiteral(IBKR_CONTRACT_DIR "/system.ts"));
    if (!file.open(QIODevice::ReadOnly)) qFatal("读不到契约:%s", qPrintable(file.fileName()));
    return interfaceFields(QString::fromUtf8(file.readAll()), interfaceName);
}

QStringList sorted(QStringList list) {
    list.sort();
    return list;
}

struct Captured {
    QList<QJsonObject> lines;
    rpc::RpcServer server{[this](const QByteArray& line) { lines.append(QJsonDocument::fromJson(line).object()); }};
    /// 交易道上的请求入队、由下一轮事件循环里的 pump 去答(本地道与读道当场答),所以交易道的回执要让一轮事件循环才出现
    void drain() { QCoreApplication::processEvents(); }
};

}  // namespace

class TestRpc : public QObject {
    Q_OBJECT
private slots:
    // 给人看的失败原因:RpcError 原样;其余截到 200 个 UTF-16 码元(TS 的 String(e.message).slice(0, 200))
    void errTextTruncatesTo200() {
        using namespace ibkr::util;
        const QString long300 = QString(300, u'字');
        QCOMPARE(errText(std::make_exception_ptr(JsError(long300))), QString(200, u'字'));
        QCOMPARE(errText(std::make_exception_ptr(JsError(QString(200, u'x')))).size(), 200);
        QCOMPARE(errText(std::make_exception_ptr(RpcError(-32602, long300))), long300);
        QCOMPARE(errText(std::make_exception_ptr(std::runtime_error(std::string(250, 'a')))), QString(200, u'a'));
    }
    void statusHasExactlyTheContractKeys() {
        const QJsonObject status = rpc::systemStatus(1791500000000);
        QCOMPARE(sorted(status.keys()), sorted(contractFields(u"SystemStatus"_s)));
        QCOMPARE(sorted(status[u"breaker"].toObject().keys()), sorted(contractFields(u"BreakerBrief"_s)));
        QCOMPARE(sorted(status[u"protections"].toObject().keys()), sorted(contractFields(u"ProtectionsSummary"_s)));
        QCOMPARE(sorted(status[u"limits"].toObject().keys()), sorted(contractFields(u"StatusLimits"_s)));
        // 读契约的正则没读空:SystemStatus 有 18 个字段
        QCOMPARE(contractFields(u"SystemStatus"_s).size(), 18);
    }

    void statusTypesMatchTheContract() {
        const QJsonObject s = rpc::systemStatus(1791500000000);
        QCOMPARE(s[u"protocol"].toString(), u"1.0"_s);  // 是串不是数
        QVERIFY(s[u"tracker_loop"].isNull());
        QVERIFY(s[u"index_spot"].isObject());
        QVERIFY(s[u"accounts"].isArray());
        QVERIFY(s[u"broker_upstream_ok"].toBool());  // 没连券商时是 true
        QCOMPARE(s[u"breaker"][u"reason"].toString(), QString());  // 空串,不是 null
        QVERIFY(s[u"protections"][u"until_ms"].isNull());
    }

    void nowEtIsNewYorkWallClockAcrossDst() {
        // 期望值是 node 的 Intl(America/New_York)现算的
        QCOMPARE(rpc::nowEt(1791500000000), u"2026-10-08 18:53:20"_s);
        QCOMPARE(rpc::nowEt(1793512799000), u"2026-11-01 01:59:59"_s);  // 夏令时最后一秒
        QCOMPARE(rpc::nowEt(1793512800000), u"2026-11-01 01:00:00"_s);  // 回拨一小时
        QCOMPARE(rpc::nowEt(1772953199000), u"2026-03-08 01:59:59"_s);
        QCOMPARE(rpc::nowEt(1772953200000), u"2026-03-08 03:00:00"_s);  // 跳过两点
    }

    void usRuleFallbackMatchesIntl_data() {
        QTest::addColumn<qint64>("epochMs");
        QTest::addColumn<QString>("expected");
        // 期望值是 node 的 Intl(America/New_York)扫出来的各年切换前后一秒,外加跨年那一刻(UTC 已是次年、ET 还在当年)
        const QList<QPair<qint64, QString>> rows{
            {1772953199000LL, u"2026-03-08 01:59:59"_s}, {1772953200000LL, u"2026-03-08 03:00:00"_s},
            {1793512799000LL, u"2026-11-01 01:59:59"_s}, {1793512800000LL, u"2026-11-01 01:00:00"_s},
            {1741503599000LL, u"2025-03-09 01:59:59"_s}, {1741503600000LL, u"2025-03-09 03:00:00"_s},
            {1762063199000LL, u"2025-11-02 01:59:59"_s}, {1762063200000LL, u"2025-11-02 01:00:00"_s},
            {1805007599000LL, u"2027-03-14 01:59:59"_s}, {1805007600000LL, u"2027-03-14 03:00:00"_s},
            {1825567199000LL, u"2027-11-07 01:59:59"_s}, {1825567200000LL, u"2027-11-07 01:00:00"_s},
            {1899356399000LL, u"2030-03-10 01:59:59"_s}, {1899356400000LL, u"2030-03-10 03:00:00"_s},
            {1919915999000LL, u"2030-11-03 01:59:59"_s}, {1919916000000LL, u"2030-11-03 01:00:00"_s},
            {2088658799000LL, u"2036-03-09 01:59:59"_s}, {2088658800000LL, u"2036-03-09 03:00:00"_s},
            {2109218399000LL, u"2036-11-02 01:59:59"_s}, {2109218400000LL, u"2036-11-02 01:00:00"_s},
            {1798759800000LL, u"2026-12-31 18:30:00"_s},
        };
        for (const auto& [ms, text] : rows) QTest::newRow(qPrintable(text + u' ' + QString::number(ms))) << ms << text;
    }
    void usRuleFallbackMatchesIntl() {
        // 时区库里没有 America/New_York 时退到的那一套:和 Intl 一秒不差,也和 Qt 的时区库一样
        QFETCH(qint64, epochMs);
        QFETCH(QString, expected);
        QCOMPARE(rpc::nowEtByUsRule(epochMs), expected);
        QCOMPARE(rpc::nowEt(epochMs), expected);
    }

    void contractFieldRegexTakesAnyIdentifier() {
        // 契约以后加了带数字或驼峰的字段,读契约的这一段也得读得到,否则"TS 加了字段这里就红"就不成立
        const QString text = u"export interface Demo {\n  /** doc */\n  plain: string;\n  index_spot2?: number;\n  brokerName: string;\n  readonly at: string;\n}\n"_s;
        QCOMPARE(interfaceFields(text, u"Demo"_s), (QStringList{u"plain"_s, u"index_spot2"_s, u"brokerName"_s, u"at"_s}));
    }

    void badJsonAnswersWithNullId() {
        Captured c;
        c.server.handleLine("{not json");
        c.drain();
        QCOMPARE(c.lines.size(), 1);
        const QString diff = test::jsonDiff(QJsonDocument::fromJson(R"({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"无法解析的 JSON"}})").object(), c.lines[0]);
        QVERIFY2(diff.isEmpty(), qPrintable(diff));
    }

    void unknownMethodEchoesTheId() {
        Captured c;
        rpc::addSystemHandlers(c.server);
        c.server.handleLine(R"({"jsonrpc":"2.0","id":7,"method":"nope"})");
        c.server.handleLine(R"({"jsonrpc":"2.0","id":"a-1","method":"nope"})");
        c.server.handleLine(R"({"jsonrpc":"2.0","method":"nope"})");
        c.drain();
        QCOMPARE(c.lines.size(), 3);
        QCOMPARE(c.lines[0][u"error"][u"code"].toInt(), -32601);
        QCOMPARE(c.lines[0][u"error"][u"message"].toString(), u"未知方法:nope"_s);
        QCOMPARE(c.lines[0][u"id"].toInt(), 7);
        QCOMPARE(c.lines[1][u"id"].toString(), u"a-1"_s);
        QVERIFY(c.lines[2][u"id"].isNull());
    }

    void crlfAndBlankLines() {
        Captured c;
        rpc::addSystemHandlers(c.server);
        c.server.handleLine("\r");
        c.server.handleLine("   ");
        c.server.handleLine("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"system.status\"}\r");
        c.drain();
        QCOMPARE(c.lines.size(), 1);
        QCOMPARE(c.lines[0][u"result"][u"protocol"].toString(), u"1.0"_s);
    }

    void handlerErrors() {
        Captured c;
        c.server.add(u"t.coded"_s, [](const QJsonValue&) -> QJsonValue { throw rpc::RpcError(-32602, u"参数不对"_s); });
        c.server.add(u"t.boom"_s, [](const QJsonValue&) -> QJsonValue { throw std::runtime_error("kaput"); });
        // 不是 std::exception 的也得接住,引擎不能被它带走
        c.server.add(u"t.weird"_s, [](const QJsonValue&) -> QJsonValue { throw 42; });
        c.server.handleLine(R"({"id":1,"method":"t.coded"})");
        c.server.handleLine(R"({"id":2,"method":"t.boom"})");
        c.server.handleLine(R"({"id":3,"method":"t.weird"})");
        c.server.handleLine(R"({"id":4,"method":"t.coded"})");
        c.drain();
        QCOMPARE(c.lines.size(), 4);
        QCOMPARE(c.lines[0][u"error"][u"code"].toInt(), -32602);
        QCOMPARE(c.lines[0][u"error"][u"message"].toString(), u"参数不对"_s);
        QCOMPARE(c.lines[1][u"error"][u"code"].toInt(), -32000);
        QVERIFY(c.lines[1][u"error"][u"message"].toString().contains(u"kaput"_s));
        QCOMPARE(c.lines[2][u"error"][u"code"].toInt(), -32000);
        QCOMPARE(c.lines[2][u"id"].toInt(), 3);
        QCOMPARE(c.lines[3][u"id"].toInt(), 4);  // 之后照常答
    }

    void paramsArePassedThroughLikeTs() {
        // 同 TS 版的 request["params"] ?? {}:没带与 null 换成 {},数组、数原样给 handler
        Captured c;
        QList<QJsonValue> seen;
        c.server.add(u"t.echo"_s, [&seen](const QJsonValue& p) -> QJsonValue { seen.append(p); return true; });
        c.server.handleLine(R"({"id":1,"method":"t.echo"})");
        c.server.handleLine(R"({"id":2,"method":"t.echo","params":null})");
        c.server.handleLine(R"({"id":3,"method":"t.echo","params":[1,"a"]})");
        c.server.handleLine(R"({"id":4,"method":"t.echo","params":7})");
        c.server.handleLine(R"({"id":5,"method":"t.echo","params":{"k":"v"}})");
        c.drain();
        QCOMPARE(seen.size(), 5);
        QCOMPARE(seen[0], QJsonValue(QJsonObject{}));
        QCOMPARE(seen[1], QJsonValue(QJsonObject{}));
        QCOMPARE(seen[2], QJsonValue(QJsonArray{1, u"a"_s}));
        QCOMPARE(seen[3].toInt(), 7);
        QCOMPARE(seen[4].toObject().value(u"k").toString(), u"v"_s);
    }

    void objectParamsRejectsLikeZod() {
        // 要对象的方法收到别的:原话同 contractMethods.ts + describeIssue
        const auto messageFor = [](const QJsonValue& params) {
            try {
                rpc::objectParams(u"tracker.add"_s, params);
            } catch (const rpc::RpcError& e) {
                return QStringLiteral("%1 %2").arg(e.code()).arg(e.message());
            }
            return QString();
        };
        QCOMPARE(messageFor(QJsonArray{}), u"-32602 tracker.add 的参数不对:params 应为 object,收到 array"_s);
        QCOMPARE(messageFor(QJsonValue(3)), u"-32602 tracker.add 的参数不对:params 应为 object,收到 number"_s);
        QCOMPARE(messageFor(QJsonValue(u"x"_s)), u"-32602 tracker.add 的参数不对:params 应为 object,收到 string"_s);
        QCOMPARE(messageFor(QJsonObject{}), QString());
    }

    void eventEnvelope() {
        Captured c;
        c.server.emitEvent(u"ready"_s, QJsonObject{{u"protocol"_s, u"1.0"_s}});
        const QString diff = test::jsonDiff(QJsonDocument::fromJson(R"({"jsonrpc":"2.0","method":"event","params":{"event":"ready","data":{"protocol":"1.0"}}})").object(), c.lines.value(0));
        QVERIFY2(diff.isEmpty(), qPrintable(diff));
    }

    void realEngineProcess() {
        // 配置读不进来 → [fatal:config:…] 退出码 78(server.ts main() 在 serve() 之前的 startupChecks)
        {
            QProcess bad;
            bad.start(QStringLiteral(IBKR_ENGINE_PATH), {u"--config"_s, u"/nowhere/settings.json"_s});
            QVERIFY(bad.waitForFinished(10000));
            QCOMPARE(bad.exitCode(), 78);
        }
        // 真配置(契约回放那份,库放临时目录)。IBKR_ENGINE_FAKE_LLM 让引擎进测试模式:不起任何后台 service、不连券商
        QTemporaryDir dir;
        QByteArray configText;
        {
            QFile base(QStringLiteral(IBKR_REPO_DIR "/engine-ts/baseline/rpc/base_config.json"));
            QVERIFY(base.open(QIODevice::ReadOnly));
            configText = base.readAll();
        }
        const QByteArray dbPath = QJsonDocument(QJsonArray{dir.filePath(u"trades.db"_s)}).toJson(QJsonDocument::Compact);
        configText.insert(configText.lastIndexOf('}'), ",\n  \"storage\": {\"db_path\": " + dbPath.mid(1, dbPath.size() - 2) + "}\n");
        const QString settingsPath = dir.filePath(u"settings.json"_s);
        {
            QFile f(settingsPath);
            QVERIFY(f.open(QIODevice::WriteOnly));
            f.write(configText);
        }
        QProcess engine;
        QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
        env.insert(u"IBKR_ENGINE_FAKE_LLM"_s, u"golden-rpc"_s);
        env.insert(u"IBKR_USER_DATA_DIR"_s, dir.path());
        env.insert(u"DAFRI_PROMPT_DIR"_s, QStringLiteral(IBKR_REPO_DIR "/prompts"));
        engine.setProcessEnvironment(env);
        engine.start(QStringLiteral(IBKR_ENGINE_PATH), {u"--config"_s, settingsPath});
        QVERIFY2(engine.waitForStarted(5000), qPrintable(engine.errorString()));
        QVERIFY(engine.waitForReadyRead(5000));
        const QJsonObject ready = QJsonDocument::fromJson(engine.readLine()).object();
        QCOMPARE(ready[u"method"].toString(), u"event"_s);
        QCOMPARE(ready[u"params"][u"event"].toString(), u"ready"_s);
        QCOMPARE(ready[u"params"][u"data"][u"protocol"].toString(), u"1.0"_s);
        QCOMPARE(ready[u"params"][u"data"][u"config"].toString(), settingsPath);

        // 两条请求一次写进去、第二条以 \r\n 结尾、最后一条没有换行就关 stdin:都要答
        engine.write("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"system.status\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"nope\"}\r\n{\"id\":3,\"method\":\"system.status\"}");
        engine.closeWriteChannel();
        QVERIFY(engine.waitForFinished(5000));
        QCOMPARE(engine.exitStatus(), QProcess::NormalExit);
        QCOMPARE(engine.exitCode(), 0);
        const QList<QByteArray> lines = engine.readAllStandardOutput().split('\n');
        QCOMPARE(lines.size(), 4);  // 三行回执 + 末尾换行后的空串
        // 同一批来的行:本地道的 system.status 当场答,交易道的(未知方法)排到后面,同 TS 的 serve()——所以按 id 找,不按先后
        QHash<int, QJsonObject> byId;
        for (int i = 0; i < 3; ++i) {
            const QJsonObject reply = QJsonDocument::fromJson(lines[i]).object();
            byId.insert(reply[u"id"].toInt(), reply);
        }
        QCOMPARE(byId.size(), 3);
        QCOMPARE(byId[1][u"result"][u"protocol"].toString(), u"1.0"_s);
        QCOMPARE(byId[2][u"error"][u"code"].toInt(), -32601);
        QCOMPARE(byId[3][u"result"][u"protocol"].toString(), u"1.0"_s);
        QVERIFY(lines[3].isEmpty());
    }
};

QTEST_GUILESS_MAIN(TestRpc)
#include "tst_rpc.moc"
