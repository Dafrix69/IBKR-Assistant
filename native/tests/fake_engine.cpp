// 假引擎:测界面那一半(native/shell)用。照 engine-ts/tests/desktop-engine-client.spec.ts 里的 FAKE_ENGINE:
//   system.status 回自己的 pid;hang 永远不回;crash 直接退出(退出码 3);slow 过 params.ms 毫秒才回;
//   FAKE_IGNORE_TERM=1 不理 SIGTERM;FAKE_EXIT_ON_EOF=1 时像真引擎那样,stdin 关了就把在途的答完再退;
//   默认 stdin 关了也不自己退:模拟一个只认信号的引擎,才测得出"旧进程还活着"的窗口。
// 另外几样(测退出码、心跳、状态快照用):
//   FAKE_EXIT_AT_START=N   一起来先把 FAKE_STDERR 打到 stderr(\n 分行),再以 N 退出
//   FAKE_SILENT_MS=N       起来之后 N 毫秒内谁都不理(心跳)
//   FAKE_STATUS='{…}'      system.status 回的字段(pid 另加)
//   FAKE_STATUS_DELAY_MS=N system.status 晚 N 毫秒回
//   FAKE_READY=1           起来先发 ready 事件
//   方法 emit              发一个事件:params.event / params.data
//   方法 garbage           往 stdout 打一行不是 JSON 的东西
//   方法 selfterm          给自己发 SIGTERM
//   FAKE_SETTINGS='{…}'     settings.get 回的设置
//   FAKE_DELAY_METHODS='a=300,b=50'  这几个方法晚这么多毫秒才回
//   FAKE_LOG_PARAMS=1      stderr 那一行带上收到的入参:"[fake] <方法> <入参 JSON>"
//   FAKE_RESULTS_FILE=路径  { "方法": 结果 }:按方法回这份结果,每次现读(测试中途可以改);{ "__error": "…" } 回引擎报错;
//                          结果里带 "__delay_ms": N 时这一次晚 N 毫秒回(盖过 FAKE_DELAY_METHODS;测回包乱序:先发的后到);
//                          { "__raw": "<JSON 原文>" } 原样当 result 发出去(键序不动;测界面照引擎的键序摆的地方)
// 每收到一条请求往 stderr 打一行 "[fake] <方法>",测试拿它数。全部离线。
#include "transport/stdio.h"

#include <QCoreApplication>
#include <QElapsedTimer>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QHash>
#include <QJsonObject>
#include <QTimer>

#include <csignal>
#include <cstdio>
#include <cstdlib>

using namespace ibkr;
using namespace Qt::StringLiterals;

namespace {

void write(const QJsonObject& message) { rpc::writeStdoutLine(QJsonDocument(message).toJson(QJsonDocument::Compact)); }

void reply(const QJsonValue& id, QJsonObject result) {
    result.insert(u"pid"_s, QCoreApplication::applicationPid());
    write({{u"jsonrpc"_s, u"2.0"_s}, {u"id"_s, id}, {u"result"_s, result}});
}

/// result 用原文拼进去(不经 QJsonObject,键序照原文)
void replyRaw(const QJsonValue& id, const QByteArray& raw) {
    rpc::writeStdoutLine("{\"jsonrpc\":\"2.0\",\"id\":" + QJsonDocument(QJsonArray{id}).toJson(QJsonDocument::Compact).mid(1).chopped(1) + ",\"result\":" + raw + "}");
}

void replyError(const QJsonValue& id, const QString& message) {
    write({{u"jsonrpc"_s, u"2.0"_s}, {u"id"_s, id}, {u"error"_s, QJsonObject{{u"code"_s, -32000}, {u"message"_s, message}}}});
}

void event(const QString& name, const QJsonValue& data) {
    write({{u"jsonrpc"_s, u"2.0"_s}, {u"method"_s, u"event"_s}, {u"params"_s, QJsonObject{{u"event"_s, name}, {u"data"_s, data}}}});
}

int envInt(const char* name) { return qEnvironmentVariableIntValue(name); }

}  // namespace

int main(int argc, char* argv[]) {
    rpc::prepareStdout();
    QCoreApplication app(argc, argv);
    if (qEnvironmentVariableIsSet("FAKE_EXIT_AT_START")) {
        const QString text = qEnvironmentVariable("FAKE_STDERR").replace(u"\\n"_s, u"\n"_s);
        if (!text.isEmpty()) std::fprintf(stderr, "%s\n", qPrintable(text));
        std::fflush(stderr);
        return envInt("FAKE_EXIT_AT_START");
    }
    if (envInt("FAKE_IGNORE_TERM") == 1) std::signal(SIGTERM, SIG_IGN);
    const bool exitOnEof = envInt("FAKE_EXIT_ON_EOF") == 1;
    const int silentMs = envInt("FAKE_SILENT_MS");
    const int statusDelayMs = envInt("FAKE_STATUS_DELAY_MS");
    const QJsonObject statusFields = QJsonDocument::fromJson(qgetenv("FAKE_STATUS")).object();
    const QJsonObject settingsFields = QJsonDocument::fromJson(qgetenv("FAKE_SETTINGS")).object();
    const bool logParams = envInt("FAKE_LOG_PARAMS") == 1;
    QHash<QString, int> delays;
    for (const QString& pair : qEnvironmentVariable("FAKE_DELAY_METHODS").split(u',', Qt::SkipEmptyParts)) {
        delays.insert(pair.section(u'=', 0, 0), pair.section(u'=', 1).toInt());
    }
    QElapsedTimer alive;
    alive.start();
    int inFlight = 0;
    bool closed = false;
    const auto maybeExit = [&] {
        if (closed && inFlight == 0 && exitOnEof) QCoreApplication::exit(0);
    };

    auto* input = new rpc::StdinLines;  // 活到进程结束(读线程认着它)
    QObject::connect(input, &rpc::StdinLines::line, &app, [&](const QByteArray& line) {
        const QJsonObject msg = QJsonDocument::fromJson(line).object();
        const QString method = msg.value(u"method").toString();
        const QJsonValue id = msg.value(u"id");
        const QJsonObject params = msg.value(u"params").toObject();
        if (logParams) std::fprintf(stderr, "[fake] %s %s\n", qPrintable(method), QJsonDocument(params).toJson(QJsonDocument::Compact).constData());
        else std::fprintf(stderr, "[fake] %s\n", qPrintable(method));
        std::fflush(stderr);
        if (silentMs > 0 && alive.elapsed() < silentMs) return;
        if (method == u"hang") return;
        if (method == u"crash") std::exit(3);
        if (method == u"selfterm") {
            std::raise(SIGTERM);
            return;
        }
        if (method == u"garbage") {
            rpc::writeStdoutLine("this is not json");
            reply(id, {});
            return;
        }
        if (method == u"emit") {
            event(params.value(u"event").toString(), params.value(u"data"));
            reply(id, {});
            return;
        }
        if (method == u"slow") {
            ++inFlight;
            QTimer::singleShot(params.value(u"ms").toInt(), &app, [&, id] {
                reply(id, {});
                --inFlight;
                maybeExit();
            });
            return;
        }
        if (method == u"system.status" && statusDelayMs > 0) {
            ++inFlight;
            QTimer::singleShot(statusDelayMs, &app, [&, id, statusFields] {
                reply(id, statusFields);
                --inFlight;
                maybeExit();
            });
            return;
        }
        QJsonObject result = method == u"system.status" ? statusFields : method == u"settings.get" ? settingsFields : QJsonObject{};
        int delay = delays.value(method, -1);
        // FAKE_RESULTS_FILE:{ "方法": 结果 },每次现读,测试中途可以改;回的是 { "__error": "…" } 时按引擎报错回
        if (const QString path = qEnvironmentVariable("FAKE_RESULTS_FILE"); !path.isEmpty()) {
            QFile f(path);
            if (f.open(QIODevice::ReadOnly)) {
                const QJsonObject all = QJsonDocument::fromJson(f.readAll()).object();
                if (all.contains(method)) {
                    QJsonObject r = all.value(method).toObject();
                    if (r.contains(u"__delay_ms"_s)) delay = r.take(u"__delay_ms"_s).toInt();
                    if (r.contains(u"__error"_s)) {
                        const QString message = r.value(u"__error"_s).toString();
                        if (delay < 0) {
                            replyError(id, message);
                            return;
                        }
                        ++inFlight;
                        QTimer::singleShot(delay, &app, [&, id, message] {
                            replyError(id, message);
                            --inFlight;
                            maybeExit();
                        });
                        return;
                    }
                    if (r.contains(u"__raw"_s)) {
                        // 一行一条:原文里的换行换成空格(JSON 里本来就是空白)
                        const QByteArray raw = r.value(u"__raw"_s).toString().toUtf8().replace('\n', ' ').replace('\r', ' ');
                        if (delay < 0) {
                            replyRaw(id, raw);
                            return;
                        }
                        ++inFlight;
                        QTimer::singleShot(delay, &app, [&, id, raw] {
                            replyRaw(id, raw);
                            --inFlight;
                            maybeExit();
                        });
                        return;
                    }
                    result = method == u"system.status" ? [&] { QJsonObject m = statusFields; for (auto it = r.begin(); it != r.end(); ++it) m.insert(it.key(), it.value()); return m; }() : r;
                }
            }
        }
        if (delay >= 0) {
            ++inFlight;
            QTimer::singleShot(delay, &app, [&, id, result] {
                reply(id, result);
                --inFlight;
                maybeExit();
            });
            return;
        }
        reply(id, result);
    });
    QObject::connect(input, &rpc::StdinLines::eof, &app, [&] {
        closed = true;
        maybeExit();
    });
    input->start();
    if (envInt("FAKE_READY") == 1) event(u"ready"_s, QJsonObject{{u"protocol"_s, u"1.0"_s}});
    return app.exec();
}
