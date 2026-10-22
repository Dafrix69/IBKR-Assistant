// engine/domain/follow_inbox(followInbox.ts)对着原模块(tests/fixtures/gen_follow_inbox.mjs):parseInboxLine 的每一行、显示名 → 信任项、
// Node 的 UTF-8 解码(util::nodeUtf8:坏字节、切成两半的字、BOM)、一段脚本化的文件会话里每一步发出的消息与错、received、lastAt、error。
#include "domain/follow_inbox.h"
#include "util/js_runtime.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"

#include <QDir>
#include <QFile>
#include <QTemporaryDir>
#include <QTest>

using namespace ibkr;
using util::OJson;
namespace js = ibkr::util::js;
using namespace Qt::StringLiterals;

namespace {
double g_now = 0;
OJson parsedJson(const domain::ParsedInboxLine& p) {
    return p.ok ? js::object({{u"ok"_s, js::B(true)}, {u"message"_s, p.message}}) : js::object({{u"ok"_s, js::B(false)}, {u"error"_s, js::S(p.error)}});
}
}  // namespace

class TestFollowInbox : public QObject {
    Q_OBJECT
    OJson fx;

private slots:
    void initTestCase() {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR) + u"/follow-inbox.json"_s);
        QVERIFY(f.open(QIODevice::ReadOnly));
        fx = *util::parseOJson(QString::fromUtf8(f.readAll()));
        util::setDateNowForTests([] { return g_now; });
    }
    void cleanupTestCase() { util::setDateNowForTests({}); }

    void lines() {
        for (const OJson& c : fx.get(u"parsed"_s)->items) QCOMPARE(js::stringify(parsedJson(domain::parseInboxLine(c.get(u"line"_s)->s))), js::stringify(*c.get(u"out"_s)));
        for (const OJson& c : fx.get(u"ids"_s)->items) QCOMPARE(domain::localAuthorId(c.get(u"n"_s)->s), c.get(u"out"_s)->s);
        QCOMPARE(domain::inboxPath(u"/a/b/trades.db"_s), fx.get(u"inboxPath"_s)->s);
    }

    void utf8() {
        for (const OJson& c : fx.get(u"utf8"_s)->items) QCOMPARE(util::nodeUtf8(QByteArray::fromHex(c.get(u"hex"_s)->s.toLatin1())), c.get(u"out"_s)->s);
    }

    // 收件文件所在的目录进不去:要报「读不了」,不能当成还没建
    void unreadableDirectoryIsReported() {
        QTemporaryDir dir;
        const QString sub = dir.path() + u"/locked"_s;
        QVERIFY(QDir().mkpath(sub));
        QStringList errors;
        domain::FollowInbox inbox(sub + u"/follow-inbox.jsonl"_s, {[](const OJson&) {}, [&](const QString& e) { errors << e; }});
        QFile::setPermissions(sub, QFileDevice::ReadOwner);
        inbox.poll();
        QFile::setPermissions(sub, QFileDevice::ReadOwner | QFileDevice::WriteOwner | QFileDevice::ExeOwner);
        QCOMPARE(errors.size(), 1);
        QVERIFY(errors[0].startsWith(u"读不了收件文件:EACCES"_s));
        errors.clear();
        inbox.poll();
        QVERIFY(errors.isEmpty());
    }

    void session() {
        QTemporaryDir dir;
        const QString path = dir.path() + u"/follow-inbox.jsonl"_s;
        QList<OJson> events;
        domain::FollowInbox inbox(path, {[&](const OJson& m) { events << js::object({{u"m"_s, m}}); }, [&](const QString& e) { events << js::object({{u"e"_s, js::S(e)}}); }});
        const auto writeBytes = [&](const QByteArray& b, bool append) {
            QFile f(path);
            QVERIFY(f.open(append ? QIODevice::Append : (QIODevice::WriteOnly | QIODevice::Truncate)));
            f.write(b);
        };
        for (const OJson& step : fx.get(u"session"_s)->items) {
            const OJson& op = *step.get(u"op"_s);
            const QString kind = op.items[0].s;
            g_now = step.get(u"clock"_s)->n;
            events.clear();
            if (kind == u"write") writeBytes(op.items[1].s.toUtf8(), false);
            else if (kind == u"append") writeBytes(op.items[1].s.toUtf8(), true);
            else if (kind == u"appendBytes") writeBytes(QByteArray::fromHex(op.items[1].s.toLatin1()), true);
            else if (kind == u"delete") QFile::remove(path);
            else if (kind == u"start") {
                inbox.start();
                inbox.stop();
            } else if (kind == u"poll") inbox.poll();
            const OJson got = js::object({{u"events"_s, js::array(events)},
                                          {u"received"_s, js::N(inbox.received)},
                                          {u"lastAt"_s, inbox.lastAt ? js::S(*inbox.lastAt) : js::Null()},
                                          {u"error"_s, inbox.error() ? js::S(*inbox.error()) : js::Null()}});
            OJson want = step;
            want.remove(u"op"_s);
            want.remove(u"clock"_s);
            QCOMPARE(js::stringify(got), js::stringify(want));
        }
    }
};

QTEST_GUILESS_MAIN(TestFollowInbox)
#include "tst_follow_inbox.moc"
