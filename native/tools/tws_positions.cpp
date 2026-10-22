// tws-positions:用 C++ 的线协议客户端连 TWS,读一次全部持仓(只读),打出来就关。
//
//   tws-positions --port 7497 [--host 127.0.0.1] [--client-id 9700] [--timeout 8] [--record 文件.twsrec]
//
// 阶段 0 拿它在纸面账户上证明握手、报到、读持仓三句通了。只会说这几句,发不了单。
// - 端口没有默认值:纸面账户(TWS 默认 7497)还是实盘(7496)由跑的人自己写明。
// - client id 默认 9700:避开应用平时那条(配置里的 client_id)和往回要成交那条(+9000)。
//   同一个 id 第二次连会被 TWS 以 326 拒掉,换一个就行。
// - 打出来的账号已经遮过(U***567);--record 录下来的文件是原样,含真实账号,只在本机看、不进仓库。
#include "execution/tws/positions_snapshot.h"
#include "execution/tws/recording.h"
#include "positions_json.h"
#include "util/redact.h"

#include <QCommandLineParser>
#include <QCoreApplication>
#include <QJsonDocument>

#include <cstdio>
#include <memory>

using namespace ibkr;
using namespace Qt::StringLiterals;

int main(int argc, char* argv[]) {
    QCoreApplication app(argc, argv);
    QCoreApplication::setApplicationName(QStringLiteral("tws-positions"));

    QCommandLineParser cli;
    cli.setApplicationDescription(QStringLiteral("连 TWS 读一次持仓(只读),账号遮掉后打出来"));
    cli.addHelpOption();
    const QCommandLineOption host(u"host"_s, QStringLiteral("TWS 的地址"), u"host"_s, u"127.0.0.1"_s);
    const QCommandLineOption port(u"port"_s, QStringLiteral("TWS 的 API 端口(纸面账户默认 7497,实盘 7496),必填"), u"port"_s);
    const QCommandLineOption clientId(u"client-id"_s, QStringLiteral("这条连接的 client id"), u"id"_s, u"9700"_s);
    const QCommandLineOption timeout(u"timeout"_s, QStringLiteral("最多等几秒"), u"seconds"_s, u"8"_s);
    const QCommandLineOption record(u"record"_s, QStringLiteral("把来回的报文录进这个文件(含真实账号)"), u"file"_s);
    cli.addOptions({host, port, clientId, timeout, record});
    cli.process(app);

    bool ok = false;
    const int portValue = cli.value(port).toInt(&ok);
    if (!ok || portValue <= 0 || portValue > 65535) {
        std::fprintf(stderr, "要写明 --port(纸面账户默认 7497)\n");
        return 2;
    }

    // 打错了不能悄悄变成 0:client id 0 是 TWS 的主 client(会收到在 TWS 里手工下的单),超时 0 等于一连就算超时
    const int clientIdValue = cli.value(clientId).toInt(&ok);
    if (!ok || clientIdValue <= 0) {
        std::fprintf(stderr, "--client-id 要一个正整数(收到 %s);0 是 TWS 的主 client,这个工具不用它\n", qPrintable(cli.value(clientId)));
        return 2;
    }
    const double timeoutSeconds = cli.value(timeout).toDouble(&ok);
    if (!ok || !(timeoutSeconds > 0) || timeoutSeconds > 600) {
        std::fprintf(stderr, "--timeout 要 0 到 600 之间的秒数(收到 %s)\n", qPrintable(cli.value(timeout)));
        return 2;
    }

    std::unique_ptr<tws::Transport> tcp = std::make_unique<tws::TcpTransport>(cli.value(host), static_cast<quint16>(portValue));
    tws::Transport* transport = tcp.get();
    tws::RecordingWriter writer;
    std::unique_ptr<tws::RecordingTransport> recorder;
    const tws::Client::Options options{clientIdValue, tws::kMinVersion, tws::kMainMaxVersion};
    if (cli.isSet(record)) {
        QString error;
        const QJsonObject header{
            {u"host"_s, cli.value(host)},
            {u"port"_s, portValue},
            {u"client_id"_s, options.clientId},
            {u"min_version"_s, options.minVersion},
            {u"max_version"_s, options.maxVersion},
            {u"tool"_s, u"tws-positions"_s},
        };
        if (!writer.open(cli.value(record), header, &error)) {
            std::fprintf(stderr, "%s\n", qPrintable(error));
            return 2;
        }
        recorder = std::make_unique<tws::RecordingTransport>(transport, &writer);
        transport = recorder.get();
    }

    tws::PositionsSnapshot snapshot(transport, options, static_cast<int>(timeoutSeconds * 1000));
    int exitCode = 0;
    QObject::connect(&snapshot, &tws::PositionsSnapshot::done, &app, [&](const tws::PositionsResult& result) {
        std::printf("%s\n", QJsonDocument(tools::resultToJson(result)).toJson(QJsonDocument::Indented).constData());
        // 撤订阅那一句要先写出去再退
        QMetaObject::invokeMethod(&app, [] { QCoreApplication::exit(0); }, Qt::QueuedConnection);
    });
    QObject::connect(&snapshot, &tws::PositionsSnapshot::failed, &app, [&](const QString& reason) {
        std::fprintf(stderr, "没读到持仓:%s\n", qPrintable(util::maskAccountLikeIds(reason)));
        exitCode = 1;
        QCoreApplication::exit(1);
    });
    snapshot.start();
    const int code = app.exec();
    writer.close();
    return exitCode != 0 ? exitCode : code;
}
