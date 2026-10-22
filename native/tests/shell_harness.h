// 测界面那一半用的小工具:拉假引擎(fake_engine.cpp)的 resolver,以及把回调式的调用等成同步的。
#pragma once

#include "shell/engine_client.h"
#include "shell/instance_guard.h"

#include <QDir>
#include <QElapsedTimer>
#include <QJsonObject>
#include <QSignalSpy>
#include <QTest>

#include <optional>

namespace ibkr::test {

inline shell::EngineResolver fakeEngine(QHash<QString, QString> env = {}) {
    return [env] {
        shell::EngineCommand cmd;
        cmd.program = QStringLiteral(IBKR_FAKE_ENGINE_PATH);
        cmd.env = env;
        cmd.workingDir = QDir::tempPath();
        cmd.label = QStringLiteral("fake");
        return shell::ResolvedEngine{cmd, {}};
    };
}

inline shell::EngineReply callSync(shell::EngineClient& c, const QString& method, const QJsonValue& params = QJsonObject{},
                                   shell::CallOptions options = {}, int waitMs = 8000) {
    std::optional<shell::EngineReply> got;
    c.call(method, params, options, [&got](const shell::EngineReply& r) { got = r; });
    if (!QTest::qWaitFor([&] { return got.has_value(); }, waitMs)) {
        shell::EngineReply r;
        r.error = QStringLiteral("测试自己等超时了");
        return r;
    }
    return *got;
}

/// 发出去但先不等:回话落到 slot 里
struct Async {
    std::optional<shell::EngineReply> reply;
    bool wait(int ms = 8000) { return QTest::qWaitFor([this] { return reply.has_value(); }, ms); }
};

inline void callAsync(shell::EngineClient& c, Async& slot, const QString& method, const QJsonValue& params = QJsonObject{},
                      shell::CallOptions options = {}) {
    c.call(method, params, options, [&slot](const shell::EngineReply& r) { slot.reply = r; });
}

inline qint64 pidOf(const shell::EngineReply& r) { return r.result.toObject().value(u"pid").toInteger(); }

inline QString startSync(shell::EngineClient& c, bool force = false) {
    std::optional<QString> got;
    c.start(force, [&got](const QString& e) { got = e; });
    (void)QTest::qWaitFor([&] { return got.has_value(); }, 8000);
    return got.value_or(QStringLiteral("测试自己等超时了"));
}

inline bool stopSync(shell::EngineClient& c, shell::StopOptions options = {}, int waitMs = 10000) {
    bool done = false;
    c.stop(options, [&done] { done = true; });
    return QTest::qWaitFor([&] { return done; }, waitMs);
}

inline QString restartSync(shell::EngineClient& c, shell::StopOptions options = {}) {
    std::optional<QString> got;
    c.restart(options, [&got](const QString& e) { got = e; });
    (void)QTest::qWaitFor([&] { return got.has_value(); }, 15000);
    return got.value_or(QStringLiteral("测试自己等超时了"));
}

/// 进程还在不在(Windows 上认不出,一律当作不在:那几条断言只在 Unix 上做)
inline bool alive(qint64 pid) { return shell::processAlive(pid); }

}  // namespace ibkr::test
