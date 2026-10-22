// engine/domain/follow_reader(followReader.ts)对着原模块(tests/fixtures/gen_follow_reader.mjs):状态行、参数、程序在哪;
// 一段假子进程 + 假定时器的脚本里每一步报出的状态、view、起了几次(最后一次的参数)、kill 了谁、排着的定时器(退避的节奏)。
// 外加一条真的子进程:/bin/sh 现编一个报两行状态再以 77 退出的程序。
#include "domain/follow_reader.h"
#include "util/error.h"
#include "util/jsobj.h"

#include <QFile>
#include <QTemporaryDir>
#include <QTest>

using namespace ibkr;
using util::OJson;
namespace js = ibkr::util::js;
using namespace Qt::StringLiterals;

namespace {
struct FakeChild : domain::ReaderChild {
    QStringList args;
    bool killed = false;
    void kill() override { killed = true; }
};
OJson statusJson(const domain::ReaderStatus& s) {
    return js::object({{u"state"_s, js::S(s.state)}, {u"title"_s, s.title ? js::S(*s.title) : js::Null()}, {u"error"_s, s.error ? js::S(*s.error) : js::Null()}});
}
}  // namespace

class TestFollowReader : public QObject {
    Q_OBJECT
    OJson fx;

private slots:
    void initTestCase() {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR) + u"/follow-reader.json"_s);
        QVERIFY(f.open(QIODevice::ReadOnly));
        fx = *util::parseOJson(QString::fromUtf8(f.readAll()));
    }

    void pure() {
        for (const OJson& c : fx.get(u"parsed"_s)->items) {
            const auto p = domain::parseReaderLine(c.get(u"l"_s)->s);
            const OJson got = p ? js::object({{u"state"_s, js::S(p->first)}, {u"title"_s, p->second ? js::S(*p->second) : js::Null()}}) : js::Null();
            QCOMPARE(js::stringify(got), js::stringify(*c.get(u"out"_s)));
        }
        for (const OJson& c : fx.get(u"args"_s)->items) {
            const auto& a = c.get(u"a"_s)->items;
            QCOMPARE(js::stringify(js::strings(domain::readerArgs(a[0].s, a[1].s, a[2].b))), js::stringify(*c.get(u"out"_s)));
        }
        QTemporaryDir dir;
        QVERIFY(QFile(dir.path() + u"/reader"_s).open(QIODevice::WriteOnly));
        QDir().mkpath(dir.path() + u"/sub"_s);
        const QList<std::pair<QString, QString>> envs{{dir.path() + u"/reader"_s, u"darwin"_s}, {dir.path() + u"/reader"_s, u"win32"_s},
                                                       {u"  "_s + dir.path() + u"/reader  "_s, u"darwin"_s}, {u"relative/reader"_s, u"darwin"_s},
                                                       {dir.path() + u"/sub"_s, u"darwin"_s}, {dir.path() + u"/missing"_s, u"darwin"_s}, {QString(), u"darwin"_s}};
        const QList<OJson>& want = fx.get(u"programs"_s)->items;
        for (qsizetype i = 0; i < envs.size(); ++i) {
            QProcessEnvironment env;
            if (!envs[i].first.isNull()) env.insert(domain::kReaderEnv, envs[i].first);
            const auto got = domain::readerProgram(env, envs[i].second);
            QCOMPARE(js::stringify(got ? js::S(u"FOUND"_s) : js::Null()), js::stringify(*want[i].get(u"out"_s)));
        }
    }

    void scripted() {
        QList<std::shared_ptr<FakeChild>> children;
        bool throwNext = false;
        struct Timer {
            int id, ms;
            std::function<void()> fn;
        };
        QList<Timer> timers;
        int nextId = 1;
        QList<OJson> statuses;
        domain::FollowReader reader(
            u"/bin/reader"_s, u"Charlie"_s, u"/x/inbox.jsonl"_s, [&](const domain::ReaderStatus& s) { statuses << statusJson(s); },
            [&](const QString&, const QStringList& a) -> std::shared_ptr<domain::ReaderChild> {
                if (throwNext) {
                    throwNext = false;
                    throw util::JsError(u"spawn ENOENT"_s);
                }
                auto c = std::make_shared<FakeChild>();
                c->args = a;
                children << c;
                return c;
            },
            [&](int ms, std::function<void()> fn) -> std::function<void()> {
                const int id = nextId++;
                timers << Timer{id, ms, std::move(fn)};
                return [&timers, id] { timers.removeIf([id](const Timer& t) { return t.id == id; }); };
            });
        int i = 0;
        for (const OJson& step : fx.get(u"steps"_s)->items) {
            statuses.clear();
            const QString k = step.get(u"op"_s)->items[0].s;
            const OJson* v = step.get(u"op"_s)->items.size() > 1 ? &step.get(u"op"_s)->items[1] : nullptr;
            FakeChild* last = children.isEmpty() ? nullptr : children.last().get();
            if (k == u"start") reader.start();
            else if (k == u"stop") reader.stop();
            else if (k == u"stdout" && last && last->onStdout) last->onStdout(v->s.toUtf8());
            else if (k == u"exit" && last && last->onExit) last->onExit(v->type == OJson::Null ? std::nullopt : std::optional<int>(int(v->n)));
            else if (k == u"error" && last && last->onError) last->onError(v->s);
            else if (k == u"oldExit") children[0]->onExit(int(v->n));
            else if (k == u"oldStdout") children[0]->onStdout(v->s.toUtf8());
            else if (k == u"throwNext") throwNext = true;
            else if (k == u"fire" && !timers.isEmpty()) {
                const Timer t = timers.takeFirst();
                t.fn();
            }
            QList<OJson> killed, ms;
            for (const auto& c : children) killed << js::B(c->killed);
            for (const Timer& t : timers) ms << js::N(t.ms);
            const OJson got = js::object({{u"statuses"_s, js::array(statuses)},
                                          {u"view"_s, statusJson(reader.view())},
                                          {u"spawned"_s, js::N(double(children.size()))},
                                          {u"lastArgs"_s, children.isEmpty() ? js::Null() : js::strings(children.last()->args)},
                                          {u"killed"_s, js::array(killed)},
                                          {u"timers"_s, js::array(ms)}});
            OJson want = step;
            want.remove(u"op"_s);
            QVERIFY2(js::stringify(got) == js::stringify(want), qPrintable(u"第 %1 步 %2\nC++:%3\nTS :%4"_s.arg(i).arg(js::stringify(*step.get(u"op"_s)), js::stringify(got), js::stringify(want))));
            ++i;
        }
    }

    // onStatus 里把读窗口对象删掉:回来之后不能再碰它(ASan 下跑)
    void deletedInsideStatusCallback() {
        std::shared_ptr<FakeChild> child;
        auto* holder = new std::unique_ptr<domain::FollowReader>();
        *holder = std::make_unique<domain::FollowReader>(
            u"/bin/reader"_s, u"c"_s, u"/o"_s, [holder](const domain::ReaderStatus& s) {
                if (s.state == u"failed" || s.state == u"untrusted") holder->reset();
            },
            [&](const QString&, const QStringList&) -> std::shared_ptr<domain::ReaderChild> {
                child = std::make_shared<FakeChild>();
                return child;
            },
            [](int, std::function<void()>) -> std::function<void()> { return [] {}; });
        (*holder)->start();
        child->onExit(1);
        QVERIFY(!*holder);
        delete holder;
    }

    void realProcess() {
        QTemporaryDir dir;
        const QString script = dir.path() + u"/reader.sh"_s;
        {
            QFile f(script);
            QVERIFY(f.open(QIODevice::WriteOnly));
            f.write("#!/bin/sh\necho '{\"state\":\"waiting\"}'\necho 'noise'\necho '{\"state\":\"reading\",\"title\":\"T\"}'\nexit 77\n");
        }
        QFile::setPermissions(script, QFileDevice::ReadOwner | QFileDevice::WriteOwner | QFileDevice::ExeOwner);
        QStringList seen;
        domain::FollowReader reader(script, u"c"_s, dir.path() + u"/out.jsonl"_s, [&](const domain::ReaderStatus& s) { seen << s.state + u':' + s.title.value_or(QString()); });
        reader.start();
        QTRY_VERIFY_WITH_TIMEOUT(seen.contains(u"untrusted:"_s), 5000);
        reader.stop();
        QCOMPARE(seen.mid(0, 3), (QStringList{u"waiting:"_s, u"reading:T"_s, u"untrusted:"_s}));
    }
};

QTEST_GUILESS_MAIN(TestFollowReader)
#include "tst_follow_reader.moc"
