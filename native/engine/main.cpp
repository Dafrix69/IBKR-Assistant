// ibkr-engine:C++ 引擎的入口。和 TS 引擎(engine-ts/src/cli.ts)说同一份命令行与 stdio JSON-RPC 契约。
//
//   ibkr-engine [--config <settings.json 的路径>]            # 不带命令 = rpc(桌面端这样起它)
//   ibkr-engine <命令> [参数] [--config <路径>]               # selftest / validate / records / … 同 cli.ts,见 transport/cli.h
//
// rpc:起来先发 ready 事件(同步、第一行),之后一行请求一行回执;stdin 关了(EOF)、在途请求答完就退出,退出码 0。
// 阶段 0:只答 system.status(形状对、值大多是空的,见 transport/handlers/system.h),配置还不读——
// 所以这里的 rpc 不走 cli::startupChecks(读配置、开库、打不开就 [fatal:…] 退出);各域 handler 与 service 搬过来时换成它(见交付报告)。
#include "transport/cli.h"
#include "transport/engine_server.h"
#include "transport/rpc_server.h"
#include "transport/stdio.h"
#include "util/secrets.h"

#include <string_view>

#include <QCoreApplication>
#include <QStringList>

namespace {

/// rpc 子命令的函数体(server.ts 的 main()):读配置、把交易库开一遍(打不开当场 [fatal:…] 退出)、建 server 与各域 handler、serve、起那四个后台 service
int runRpc(QCoreApplication& app, const std::optional<QString>& configPath) {
    const ibkr::domain::Settings settings = ibkr::cli::startupChecks(configPath);  // 跑完 rpc::markStartupChecked()
    ibkr::rpc::RpcServer server(ibkr::rpc::writeStdoutLine);
    server.requireStartupChecks();
    ibkr::rpc::EngineServer engine(server, settings, configPath);
    engine.install();
    server.setOnFinished([&app](int code) { app.exit(code); });
    server.begin(settings.source_path.value_or(configPath.value_or(QString())));  // ready 同步发出

    auto* input = new ibkr::rpc::StdinLines;  // 活到进程结束(读线程认着它),不删
    QObject::connect(input, &ibkr::rpc::StdinLines::line, &app, [&server](const QByteArray& line) { server.handleLine(line); });
    QObject::connect(input, &ibkr::rpc::StdinLines::eof, &app, [&server] { server.handleEof(); });
    input->start();
    engine.startBackground();
    return app.exec();
}

}  // namespace

int main(int argc, char* argv[]) {
    // 凭证子进程(util/secrets 起的):读一行请求、做、答一行、退出。不起事件循环、不发 ready
    for (int i = 1; i < argc; ++i)
        if (std::string_view(argv[i]) == "--keychain-child") return ibkr::util::runKeychainChild();
    ibkr::rpc::prepareStdout();
    QCoreApplication app(argc, argv);
    QCoreApplication::setApplicationName(QStringLiteral("ibkr-engine"));

    QStringList args = QCoreApplication::arguments();
    args.removeFirst();  // 程序名
    // 去掉 --config 与它的值之后一个词都不剩 = 没给命令 = rpc(桌面端的起法)
    QStringList rest = args;
    if (const qsizetype at = rest.indexOf(QStringLiteral("--config")); at >= 0) rest.remove(at, qMin<qsizetype>(2, rest.size() - at));
    if (rest.isEmpty()) args.prepend(QStringLiteral("rpc"));

    return ibkr::cli::runMain(args, ibkr::cli::stdIo(), [&app](const std::optional<QString>& configPath) { return runRpc(app, configPath); });
}
