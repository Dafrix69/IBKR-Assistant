// 录制与回放:录一趟(对着字节层的假 TWS)→ 读回文件 → 用同一份剧本放一遍,
// 写出去的字节必须逐块一样、读到的持仓必须一样;剧本改了一个字节(client id)回放要当场说对不上。
#include "execution/tws/positions_snapshot.h"
#include "execution/tws/recording.h"
#include "fake_tws.h"
#include "util/awake_clock.h"

#include <QElapsedTimer>
#include <QSignalSpy>
#include <QTemporaryDir>
#include <QTest>
#include <QThread>

using namespace ibkr;
using namespace Qt::StringLiterals;

namespace {

const tws::Client::Options kOptions{9700, tws::kMinVersion, tws::kMainMaxVersion};

struct Outcome {
    std::optional<tws::PositionsResult> result;
    QString failure;
};

Outcome runSnapshot(tws::Transport* transport, tws::Client::Options options = kOptions) {
    tws::PositionsSnapshot snap(transport, options, 3000);
    Outcome out;
    bool finished = false;
    QObject::connect(&snap, &tws::PositionsSnapshot::done, [&](const tws::PositionsResult& r) { out.result = r; finished = true; });
    QObject::connect(&snap, &tws::PositionsSnapshot::failed, [&](const QString& why) { out.failure = why; finished = true; });
    snap.start();
    if (!QTest::qWaitFor([&] { return finished; }, 5000)) out.failure = u"测试自己等超时了"_s;
    return out;
}

/// 对着假 TWS 录一趟,返回录像文件的路径
QString recordOnce(const QTemporaryDir& dir, int chunkBytes = 0) {
    test::FakeTws tws;
    tws.chunkBytes = chunkBytes;
    tws.positions = {test::optionPosition(u"U1234567"_s, u"7790.0"_s, u"2"_s), test::optionPosition(u"DU7654321"_s, u"7765.0"_s, u"-1"_s)};
    const QString path = dir.filePath(u"session.twsrec"_s);
    tws::RecordingWriter writer;
    QString error;
    if (!writer.open(path, QJsonObject{{u"client_id"_s, kOptions.clientId}, {u"tool"_s, u"tst_recording"_s}}, &error)) qFatal("%s", qPrintable(error));
    tws::RecordingTransport recorder(&tws, &writer);
    const Outcome live = runSnapshot(&recorder);
    if (!live.result) qFatal("录的那一趟就没成:%s", qPrintable(live.failure));
    writer.close();
    return path;
}

/// 一趟完整的录像(假 TWS 上录的):replay 一份改过的,看回放能不能认出来
tws::Recording recorded(const QTemporaryDir& dir) {
    QString error;
    auto rec = tws::readRecording(recordOnce(dir), &error);
    if (!rec) qFatal("%s", qPrintable(error));
    return *rec;
}

qsizetype lastOut(const tws::Recording& rec) {
    for (qsizetype i = rec.records.size() - 1; i >= 0; --i)
        if (rec.records[i].kind == tws::Record::Kind::Out) return i;
    return -1;
}

struct ReplayRun {
    Outcome outcome;
    QList<QList<QVariant>> mismatches;
};

ReplayRun replayWithSnapshot(tws::Recording rec) {
    tws::ReplayTransport replay(std::move(rec), 0);
    QSignalSpy mismatch(&replay, &tws::ReplayTransport::mismatch);
    ReplayRun run;
    run.outcome = runSnapshot(&replay);
    QTest::qWait(20);  // 关之后的核对是同步的,这里只是让排着的事件走完
    for (const auto& args : mismatch) run.mismatches.append(args);
    return run;
}

}  // namespace

class TestRecording : public QObject {
    Q_OBJECT
private slots:
    void recordsEveryChunkWithTimes() {
        QTemporaryDir dir;
        QString error;
        const auto rec = tws::readRecording(recordOnce(dir), &error);
        QVERIFY2(rec, qPrintable(error));
        QCOMPARE(rec->header.value(u"format").toString(), u"ibkr-tws-recording"_s);
        QCOMPARE(rec->header.value(u"client_id").toInt(), 9700);
        QVERIFY(!rec->header.value(u"started_at").toString().isEmpty());
        QStringList kinds;
        for (const tws::Record& r : rec->records) kinds.append(tws::kindName(r.kind));
        // 连、连上、握手、版本、报到、问候(一块)、要持仓、持仓(一块)、撤、关
        QCOMPARE(kinds, (QStringList{u"open"_s, u"opened"_s, u"out"_s, u"in"_s, u"out"_s, u"in"_s, u"out"_s, u"in"_s, u"out"_s, u"close"_s}));
        QCOMPARE(rec->records[2].bytes, tws::handshake(100, 193));
        QCOMPARE(rec->records[8].bytes, tws::cancelPositions());
        for (qsizetype i = 1; i < rec->records.size(); ++i) {
            QVERIFY(rec->records[i].tUs >= rec->records[i - 1].tUs);  // 单调时钟不往回走
            QVERIFY(rec->records[i].wallMs > 0);
        }
    }

    void replayReproducesTheSession() {
        QTemporaryDir dir;
        QString error;
        const auto rec = tws::readRecording(recordOnce(dir, /*chunkBytes=*/7), &error);
        QVERIFY2(rec, qPrintable(error));
        tws::ReplayTransport replay(*rec, 0);
        QSignalSpy finished(&replay, &tws::ReplayTransport::finished);
        const Outcome out = runSnapshot(&replay);
        QVERIFY2(out.result, qPrintable(out.failure));
        QCOMPARE(replay.mismatches(), 0);
        QCOMPARE(out.result->positions.size(), 2);
        QCOMPARE(out.result->positions[0].account, u"U1234567"_s);
        QCOMPARE(out.result->positions[1].pos.value_or(0), -1.0);
        QCOMPARE(out.result->serverVersion, 193);
    }

    void replayCatchesAChangedRequest() {
        // 剧本里 client id 换了一个:报到那一句的字节不一样,回放当场说出来,读持仓失败
        QTemporaryDir dir;
        QString error;
        const auto rec = tws::readRecording(recordOnce(dir), &error);
        QVERIFY2(rec, qPrintable(error));
        tws::ReplayTransport replay(*rec, 0);
        QSignalSpy mismatch(&replay, &tws::ReplayTransport::mismatch);
        tws::Client::Options other = kOptions;
        other.clientId = 9701;
        const Outcome out = runSnapshot(&replay, other);
        QVERIFY(!out.result);
        QCOMPARE(mismatch.size(), 1);
        QCOMPARE(mismatch[0][0].toInt(), 4);  // 第 5 条:报到
        QCOMPARE(mismatch[0][1].toByteArray(), tws::startApi(9700));
        QCOMPARE(mismatch[0][2].toByteArray(), tws::startApi(9701));
        QVERIFY2(out.failure.contains(u"对不上"_s) || out.failure.contains(u"不一样"_s), qPrintable(out.failure));
    }

    void replayWaitsTheRecordedGaps() {
        // 原速回放:握手的回话录在 80 毫秒之后,放的时候也至少等那么久(只钉下限:慢的 CI 机器上会更久)
        tws::Recording rec;
        rec.header = QJsonObject{{u"format"_s, u"ibkr-tws-recording"_s}, {u"version"_s, 1}};
        rec.records = {
            {0, 0, tws::Record::Kind::Opened, {}, {}},
            {10, 0, tws::Record::Kind::Out, tws::handshake(100, 193), {}},
            {80'010, 0, tws::Record::Kind::In, tws::frame({u"193"_s, u"t"_s}), {}},
        };
        tws::ReplayTransport replay(rec, 1.0);
        tws::Client client(&replay, kOptions);
        QSignalSpy shaken(&client, &tws::Client::handshaken);
        QElapsedTimer clock;
        clock.start();
        client.start();
        QVERIFY(shaken.wait(3000));
        QVERIFY2(clock.elapsed() >= 70, qPrintable(QString::number(clock.elapsed())));
    }

    void writerStampsAwakeTime() {
        // t_us 取的是"醒着的时间"(睡眠里不走的那个钟),从 open 起算;墙钟另记一格
        QTemporaryDir dir;
        qint64 fake = 5'000'000;
        tws::RecordingWriter writer([&fake] { return fake; });
        QString error;
        QVERIFY(writer.open(dir.filePath(u"w.twsrec"_s), {}, &error));
        fake += 250;
        writer.write(tws::Record::Kind::Out, "ab");
        fake += 8'000'000;
        writer.write(tws::Record::Kind::In, "cd");
        writer.close();
        const auto rec = tws::readRecording(dir.filePath(u"w.twsrec"_s), &error);
        QVERIFY2(rec, qPrintable(error));
        QCOMPARE(rec->records.size(), 2);
        QCOMPARE(rec->records[0].tUs, 250);
        QCOMPARE(rec->records[1].tUs, 8'000'250);
        QCOMPARE(rec->records[1].bytes, QByteArray("cd"));
        QVERIFY(rec->records[1].wallMs >= rec->records[0].wallMs);
    }

    void awakeClockRunsWhileAwake() {
        // 醒着时它和墙钟一起走(睡着时不走,那一半只有真合盖才验得了,见 awake_clock.h)
        const qint64 before = util::awakeMicros();
        QThread::msleep(30);
        const qint64 after = util::awakeMicros();
        QVERIFY2(after - before >= 25'000, qPrintable(QString::number(after - before)));
    }

    void replaySkipsWhatTheMacSleptThrough() {
        // 合盖一夜:墙钟跳了 8 小时,醒着的时间只过了 50 毫秒。原速回放按醒着的时间等,不会干等一夜
        tws::Recording rec;
        rec.header = QJsonObject{{u"format"_s, u"ibkr-tws-recording"_s}, {u"version"_s, 1}};
        const qint64 wall = 1791500000000;
        rec.records = {
            {0, wall, tws::Record::Kind::Opened, {}, {}},
            {10, wall, tws::Record::Kind::Out, tws::handshake(100, 193), {}},
            {50'010, wall + 8LL * 3600 * 1000, tws::Record::Kind::In, tws::frame({u"193"_s, u"t"_s}), {}},
        };
        tws::ReplayTransport replay(rec, 1.0);
        tws::Client client(&replay, kOptions);
        QSignalSpy shaken(&client, &tws::Client::handshaken);
        client.start();
        QVERIFY(shaken.wait(10'000));
    }

    void replayCatchesAnExtraWriteAtClose() {
        // 录像里没有撤订阅那一句,这一趟关之前写了:多写的也算对不上
        QTemporaryDir dir;
        tws::Recording rec = recorded(dir);
        const qsizetype cancelAt = lastOut(rec);
        QCOMPARE(rec.records[cancelAt].bytes, tws::cancelPositions());
        rec.records.removeAt(cancelAt);
        const ReplayRun run = replayWithSnapshot(rec);
        QCOMPARE(run.mismatches.size(), 1);
        QVERIFY(run.mismatches[0][1].toByteArray().isEmpty());
        QCOMPARE(run.mismatches[0][2].toByteArray(), tws::cancelPositions());
    }

    void replayCatchesADifferentWriteAtClose() {
        // 最后一句(关之前写的)和录的不一样:关的时候也要逐字节核对,不能因为客户端先关了就不看
        QTemporaryDir dir;
        tws::Recording rec = recorded(dir);
        const qsizetype cancelAt = lastOut(rec);
        rec.records[cancelAt].bytes = tws::reqCurrentTime();
        const ReplayRun run = replayWithSnapshot(rec);
        QCOMPARE(run.mismatches.size(), 1);
        QCOMPARE(run.mismatches[0][0].toInt(), static_cast<int>(cancelAt));
        QCOMPARE(run.mismatches[0][1].toByteArray(), tws::reqCurrentTime());
        QCOMPARE(run.mismatches[0][2].toByteArray(), tws::cancelPositions());
    }

    void replayCatchesAMissingWriteAtClose() {
        // 录的那一趟关之前还写了一句,这一趟没写就关了
        QTemporaryDir dir;
        tws::Recording rec = recorded(dir);
        const qsizetype cancelAt = lastOut(rec);
        tws::Record extra = rec.records[cancelAt];
        extra.bytes = tws::reqCurrentTime();
        rec.records.insert(cancelAt + 1, extra);
        const ReplayRun run = replayWithSnapshot(rec);
        QCOMPARE(run.mismatches.size(), 1);
        QCOMPARE(run.mismatches[0][0].toInt(), static_cast<int>(cancelAt + 1));
        QCOMPARE(run.mismatches[0][1].toByteArray(), tws::reqCurrentTime());
        QVERIFY(run.mismatches[0][2].toByteArray().isEmpty());
    }

    void replayCatchesWritesAfterTheEnd() {
        // 录像到握手的回话就完了,客户端接着报到:录像里没有的写
        tws::Recording rec;
        rec.header = QJsonObject{{u"format"_s, u"ibkr-tws-recording"_s}, {u"version"_s, 1}};
        rec.records = {
            {0, 0, tws::Record::Kind::Opened, {}, {}},
            {1, 0, tws::Record::Kind::Out, tws::handshake(100, 193), {}},
            {2, 0, tws::Record::Kind::In, tws::frame({u"193"_s, u"t"_s}), {}},
        };
        tws::ReplayTransport replay(rec, 0);
        QSignalSpy mismatch(&replay, &tws::ReplayTransport::mismatch);
        QSignalSpy finished(&replay, &tws::ReplayTransport::finished);
        tws::Client client(&replay, kOptions);
        client.start();
        QVERIFY(finished.wait(3000));
        QCOMPARE(mismatch.size(), 1);
        QCOMPARE(mismatch[0][0].toInt(), 3);  // 录像的条数:之后就没有了
        QCOMPARE(mismatch[0][2].toByteArray(), tws::startApi(9700));
    }

    void rejectsFilesThatAreNotRecordings() {
        QString error;
        QVERIFY(!tws::parseRecording("", &error));
        QVERIFY(!tws::parseRecording(R"({"format":"something-else","version":1})", &error));
        QVERIFY(error.contains(u"头"_s));
        QVERIFY(!tws::parseRecording(R"({"format":"ibkr-tws-recording","version":1})" "\n" R"({"kind":"sideways"})", &error));
        QVERIFY2(error.contains(u"第 2 行"_s), qPrintable(error));
        QVERIFY(!tws::parseRecording("{\"format\":\"ibkr-tws-recording\",\"version\":1}\nnot json", &error));
    }
};

QTEST_GUILESS_MAIN(TestRecording)
#include "tst_recording.moc"
