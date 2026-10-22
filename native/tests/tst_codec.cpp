// TWS 编解码:两层期望。
// 1. 逐字节照抄 engine-ts/tests/ib-exec-history.spec.ts 的那几条(TS 版手写客户端的期望,独立于这份实现)。
// 2. fixtures/stoqey-v193.json:同样的字节,TS 引擎在用的 @stoqey/ib 发出去 / 读出来的是什么(gen_stoqey_v193.mjs 现算)。
//    这是对拍:C++ 读出来的必须和 TS 引擎看到的一样,含 NaN、undefined、千分位、\uXXXX 这些角落。
#include "execution/tws/codec.h"
#include "json_compare.h"

#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QTest>

#include <cmath>

using namespace ibkr;
using namespace Qt::StringLiterals;

namespace {

QJsonObject fixture() {
    QFile file(QStringLiteral(IBKR_FIXTURES_DIR "/stoqey-v193.json"));
    if (!file.open(QIODevice::ReadOnly)) qFatal("读不到 fixture:%s", qPrintable(file.fileName()));
    return QJsonDocument::fromJson(file.readAll()).object();
}

QStringList strings(const QJsonArray& array) {
    QStringList out;
    for (const QJsonValue& v : array) out.append(v.toString());
    return out;
}

QJsonValue number(double v) { return std::isfinite(v) ? QJsonValue(v) : QJsonValue(QJsonValue::Null); }
QJsonValue number(const std::optional<double>& v) { return v ? number(*v) : QJsonValue(QJsonValue::Null); }

/// C++ 解出来的一条 → 和 fixture 同样的形状:库发了哪些事件、报错、通告,外加三个标志
QJsonObject asLibraryWouldEmit(const tws::Message& m) {
    QJsonArray events, errors, infos;
    const auto event = [&](const QString& name, const QJsonArray& args) { events.append(QJsonObject{{u"name"_s, name}, {u"args"_s, args}}); };
    if (const auto* a = std::get_if<tws::ManagedAccounts>(&m.body)) event(u"managedAccounts"_s, {a->accounts});
    if (const auto* n = std::get_if<tws::NextValidId>(&m.body)) event(u"nextValidId"_s, {number(n->orderId)});
    if (const auto* t = std::get_if<tws::CurrentTime>(&m.body)) event(u"currentTime"_s, {number(t->epochSeconds)});
    if (std::holds_alternative<tws::PositionEnd>(m.body)) event(u"positionEnd"_s, {});
    if (const auto* p = std::get_if<tws::Position>(&m.body))
        event(u"position"_s, {p->account, tws::contractToJson(p->contract), number(p->pos), number(p->avgCost)});
    if (const auto* e = std::get_if<tws::ErrorMessage>(&m.body)) {
        if (e->info) {
            infos.append(QJsonObject{{u"message"_s, e->message}, {u"code"_s, number(e->code)}});
        } else {
            QJsonObject o{{u"message"_s, e->message}, {u"code"_s, number(e->code)}};
            if (e->reqId) o.insert(u"reqId"_s, number(*e->reqId));
            if (e->advancedOrderReject) o.insert(u"advanced"_s, *e->advancedOrderReject);
            errors.append(o);
        }
    }
    return QJsonObject{
        {u"events"_s, events}, {u"errors"_s, errors}, {u"infos"_s, infos},
        {u"underrun"_s, m.underrun}, {u"leftover"_s, m.leftover}, {u"unknown"_s, m.unknown},
    };
}

QByteArray bytes(std::initializer_list<int> values) {
    QByteArray out;
    for (int v : values) out.append(static_cast<char>(v));
    return out;
}

}  // namespace

class TestCodec : public QObject {
    Q_OBJECT
private slots:
    // ---- 1. 照抄 TS 版手写客户端的期望 ----
    void handshakeLikeExecHistory() {
        QCOMPARE(tws::handshake(100, 200), QByteArray("API\0", 4) + bytes({0, 0, 0, 9}) + "v100..200");
        QCOMPARE(tws::handshake(100, 193), QByteArray("API\0", 4) + bytes({0, 0, 0, 9}) + "v100..193");
        QCOMPARE(tws::handshake(176, 176), QByteArray("API\0", 4) + bytes({0, 0, 0, 4}) + "v176");
    }
    void frameLikeExecHistory() {
        QCOMPARE(tws::frame({u"a"_s, u"7"_s}), bytes({0, 0, 0, 4}) + QByteArray("a\0" "7\0", 4));
        QCOMPARE(tws::startApi(9012).mid(4), QByteArray("71\0" "2\0" "9012\0" "\0", 11));
        // 中文按 UTF-8 算长度
        QCOMPARE(tws::frame({u"价"_s}), bytes({0, 0, 0, 4}) + QByteArray("\xe4\xbb\xb7\0", 4));
    }

    // ---- 2. 对着 @stoqey/ib ----
    void fixtureIsTheLibraryTheEngineUses() {
        const QJsonObject f = fixture();
        QCOMPARE(f.value(u"server_version").toInt(), tws::kMainMaxVersion);
        QVERIFY(f.value(u"library").toString().startsWith(u"@stoqey/ib "));
        QVERIFY(f.value(u"in").toArray().size() >= 25);
        QCOMPARE(f.value(u"out").toArray().size(), 7);
    }

    void outgoingBytes_data() {
        QTest::addColumn<QByteArray>("actual");
        QTest::addColumn<QByteArray>("expected");
        const QHash<QString, QByteArray> ours{
            {u"handshake v100..193"_s, tws::handshake(100, 193)},
            {u"handshake v100..200"_s, tws::handshake(100, 200)},
            {u"startApi 0"_s, tws::startApi(0)},
            {u"startApi 9012"_s, tws::startApi(9012)},
            {u"reqPositions"_s, tws::reqPositions()},
            {u"cancelPositions"_s, tws::cancelPositions()},
            {u"reqCurrentTime"_s, tws::reqCurrentTime()},
        };
        for (const QJsonValue& v : fixture().value(u"out").toArray()) {
            const QString name = v[u"name"].toString();
            QVERIFY2(ours.contains(name), qPrintable(u"fixture 里多了一条 C++ 不会发的:"_s + name));
            QTest::newRow(qPrintable(name)) << ours.value(name) << QByteArray::fromHex(v[u"hex"].toString().toLatin1());
        }
    }
    void outgoingBytes() {
        QFETCH(QByteArray, actual);
        QFETCH(QByteArray, expected);
        QCOMPARE(actual.toHex(' '), expected.toHex(' '));
    }

    void incomingMessages_data() {
        QTest::addColumn<QStringList>("tokens");
        QTest::addColumn<QJsonObject>("expected");
        for (const QJsonValue& v : fixture().value(u"in").toArray()) {
            QJsonObject expected = v.toObject();
            const QStringList tokens = strings(expected.take(u"tokens").toArray());
            expected.remove(u"name");
            QTest::newRow(qPrintable(v[u"name"].toString())) << tokens << expected;
        }
    }
    void incomingMessages() {
        QFETCH(QStringList, tokens);
        QFETCH(QJsonObject, expected);
        const QJsonObject actual = asLibraryWouldEmit(tws::decode(tokens, tws::kMainMaxVersion));
        const QString diff = test::jsonDiff(expected, actual);
        QVERIFY2(diff.isEmpty(), qPrintable(diff));
    }

    void serverVersionReply() {
        const QJsonObject reply = fixture().value(u"server_version_reply").toObject();
        const tws::ServerVersion v = tws::decodeServerVersion(strings(reply.value(u"tokens").toArray()));
        QCOMPARE(v.version, reply.value(u"version").toDouble());
        QCOMPARE(v.connectionTime, reply.value(u"connection_time").toString());
        QVERIFY(std::isnan(tws::decodeServerVersion({u"abc"_s}).version));
    }

    // ---- 分帧 ----
    void splitsWholeFramesAndKeepsTheRest() {
        const QByteArray two = tws::frame({u"9"_s, u"1"_s, u"42"_s}) + tws::frame({u"62"_s, u"1"_s});
        const QByteArray third = tws::frame({u"15"_s, u"1"_s, u"U1234567"_s});
        const tws::SplitResult cut = tws::splitFrames(two + third.left(5));
        QCOMPARE(cut.frames.size(), 2);
        QCOMPARE(cut.frames[0], (QStringList{u"9"_s, u"1"_s, u"42"_s}));
        QCOMPARE(cut.frames[1], (QStringList{u"62"_s, u"1"_s}));
        QCOMPARE(cut.consumed, two.size());
        QVERIFY(!cut.badSize);
    }
    void reassemblesByteByByte() {
        // TCP 可以在任何一个字节上切开,含一个汉字的中间
        const QByteArray stream = tws::frame({u"4"_s, u"2"_s, u"-1"_s, u"2104"_s, u"数据农场连上了"_s, QString()}) + tws::frame({u"62"_s, u"1"_s});
        QByteArray pending;
        QList<QStringList> frames;
        for (char c : stream) {
            pending += c;
            const tws::SplitResult cut = tws::splitFrames(pending);
            frames += cut.frames;
            pending.remove(0, cut.consumed);
        }
        QCOMPARE(frames.size(), 2);
        QCOMPARE(frames[0].value(4), u"数据农场连上了"_s);
        QCOMPARE(frames[0].size(), 6);  // 末尾那个空字段(详细拒单原因)要留着
        QVERIFY(pending.isEmpty());
    }
    void rejectsAbsurdLength() {
        const tws::SplitResult cut = tws::splitFrames(bytes({0x7f, 0, 0, 0}) + "xx");
        QVERIFY(cut.badSize);
        QCOMPARE(*cut.badSize, 0x7f000000u);
    }
    void emptyFrameHasNoFields() {
        const tws::SplitResult cut = tws::splitFrames(bytes({0, 0, 0, 0}));
        QCOMPARE(cut.frames.size(), 1);
        QVERIFY(cut.frames[0].isEmpty());
        QVERIFY(tws::decode(cut.frames[0], tws::kMainMaxVersion).underrun);
    }
};

QTEST_GUILESS_MAIN(TestCodec)
#include "tst_codec.moc"
