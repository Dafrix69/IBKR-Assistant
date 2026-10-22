// tws-replay:把 tws-positions --record 录下来的报文放回给同一份"读一次持仓"的剧本。
//
//   tws-replay 文件.twsrec [--speed 1]      # 1 = 按录下来的间隔,0 = 不等,2 = 两倍速
//
// 证明两件事:写出去的字节和录的时候逐块一样(差一个字节就退出码 3),读出来的持仓与当时一样(打出来,账号遮过)。
// 录像本身含真实账号,只在本机放。
#include "execution/tws/positions_snapshot.h"
#include "execution/tws/recording.h"
#include "positions_json.h"
#include "util/redact.h"

#include <QCommandLineParser>
#include <QCoreApplication>
#include <QJsonDocument>

#include <cmath>
#include <cstdio>

using namespace ibkr;
using namespace Qt::StringLiterals;

int main(int argc, char* argv[]) {
    QCoreApplication app(argc, argv);
    QCoreApplication::setApplicationName(QStringLiteral("tws-replay"));

    QCommandLineParser cli;
    cli.setApplicationDescription(QStringLiteral("回放 tws-positions 录下来的报文"));
    cli.addHelpOption();
    cli.addPositionalArgument(u"file"_s, QStringLiteral("录像文件(.twsrec)"));
    const QCommandLineOption speed(u"speed"_s, QStringLiteral("回放速度:1 原速,0 不等"), u"x"_s, u"0"_s);
    cli.addOption(speed);
    cli.process(app);
    if (cli.positionalArguments().size() != 1) cli.showHelp(2);
    bool ok = false;
    const double speedValue = cli.value(speed).toDouble(&ok);
    if (!ok || !(speedValue >= 0) || !std::isfinite(speedValue)) {
        std::fprintf(stderr, "--speed 要一个不小于 0 的数(收到 %s)\n", qPrintable(cli.value(speed)));
        return 2;
    }

    QString error;
    const auto recording = tws::readRecording(cli.positionalArguments().first(), &error);
    if (!recording) {
        std::fprintf(stderr, "%s\n", qPrintable(error));
        return 2;
    }
    const QJsonObject& h = recording->header;
    const tws::Client::Options options{
        h.value(u"client_id").toInt(),
        h.value(u"min_version").toInt(tws::kMinVersion),
        h.value(u"max_version").toInt(tws::kMainMaxVersion),
    };

    tws::ReplayTransport replay(*recording, speedValue);
    tws::PositionsSnapshot snapshot(&replay, options, 60'000);
    int exitCode = 0;
    QObject::connect(&replay, &tws::ReplayTransport::mismatch, &app, [&](int index, const QByteArray& expected, const QByteArray& actual) {
        if (expected.isEmpty())
            std::fprintf(stderr, "录像里这里已经没有写出去的了(第 %d 条之后),这次多写了 %s\n", index, actual.toHex(' ').constData());
        else
            std::fprintf(stderr, "第 %d 条录像对不上:录的是 %s,这次写的是 %s\n", index + 1, expected.toHex(' ').constData(), actual.isEmpty() ? "(没写)" : actual.toHex(' ').constData());
        exitCode = 3;
    });
    QObject::connect(&snapshot, &tws::PositionsSnapshot::done, &app, [&](const tws::PositionsResult& result) {
        std::printf("%s\n", QJsonDocument(tools::resultToJson(result)).toJson(QJsonDocument::Indented).constData());
        QMetaObject::invokeMethod(&app, [] { QCoreApplication::exit(0); }, Qt::QueuedConnection);
    });
    QObject::connect(&snapshot, &tws::PositionsSnapshot::failed, &app, [&](const QString& reason) {
        std::fprintf(stderr, "回放没读完:%s\n", qPrintable(util::maskAccountLikeIds(reason)));
        if (exitCode == 0) exitCode = 1;
        QCoreApplication::exit(1);
    });
    snapshot.start();
    app.exec();
    return exitCode;
}
