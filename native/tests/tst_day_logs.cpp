// engine/domain/day_logs(ivSamples.ts、playbookLog.ts)对着原模块(tests/fixtures/gen_day_logs.mjs):同样的追加之后文件里逐字一样
// (落在哪一天的文件按美东日历日,含夏令时那两天),手写的坏文件读回来留下哪几行,dates / days / prune。
#include "domain/day_logs.h"
#include "util/error.h"
#include "util/jsobj.h"

#include <QDir>
#include <QFile>
#include <QTemporaryDir>
#include <QTest>

using namespace ibkr;
using util::OJson;
namespace js = ibkr::util::js;
using namespace Qt::StringLiterals;

namespace {
OJson filesOf(const QString& dir) {
    OJson out = js::object();
    QStringList names = QDir(dir).entryList(QDir::Files);
    std::sort(names.begin(), names.end());
    for (const QString& n : names) {
        QFile f(dir + u'/' + n);
        if (!f.open(QIODevice::ReadOnly)) continue;
        out.set(n, js::S(QString::fromUtf8(f.readAll())));
    }
    return out;
}
OJson byDate(const QStringList& dates, const std::function<QList<OJson>(const QString&)>& read) {
    OJson out = js::object();
    for (const QString& d : dates) out.set(d, js::array(read(d)));
    return out;
}
}  // namespace

class TestDayLogs : public QObject {
    Q_OBJECT
    OJson fx;
    const OJson& at(const char16_t* k) const { return *fx.get(QString::fromUtf16(k)); }

private slots:
    void initTestCase() {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR) + u"/day-logs.json"_s);
        QVERIFY(f.open(QIODevice::ReadOnly));
        fx = *util::parseOJson(QString::fromUtf8(f.readAll()));
    }

    void ivSamples() {
        QTemporaryDir tmp;
        const QString dir = tmp.path() + u"/fly-iv"_s;
        domain::IvSampleStore iv(dir);
        for (const OJson& s : at(u"samples").items) iv.append(s);
        QCOMPARE(js::stringify(filesOf(dir)), js::stringify(at(u"ivFiles")));
#if !defined(Q_OS_WIN)
        QCOMPARE(QFile::permissions(dir + u"/2026-10-16.jsonl"_s) & (QFileDevice::ReadGroup | QFileDevice::ReadOther), QFileDevice::Permissions());
#endif
        for (const auto& [name, text] : at(u"crafted").fields) {
            QFile f(dir + u'/' + name);
            QVERIFY(f.open(QIODevice::WriteOnly));
            f.write(text.s.toUtf8());
        }
        QCOMPARE(js::stringify(js::strings(iv.dates())), js::stringify(at(u"ivDates")));
        QCOMPARE(js::stringify(byDate(iv.dates(), [&](const QString& d) { return iv.read(d); })), js::stringify(at(u"ivRead")));
        QCOMPARE(js::stringify(js::array(iv.days())), js::stringify(at(u"ivDays")));
        QCOMPARE(iv.prune(3), at(u"ivPrune").n);
        QCOMPARE(js::stringify(js::strings(iv.dates())), js::stringify(at(u"ivAfter")));
        QCOMPARE(iv.prune(), at(u"ivPruneDefault").n);
        domain::IvSampleStore missing(tmp.path() + u"/nope"_s);
        QVERIFY(missing.dates().isEmpty() && missing.read(u"2026-01-01"_s).isEmpty() && missing.days().isEmpty() && missing.prune() == 0);
    }

    // 写不进去(文件只读)要当场抛,同 appendFileSync;/dev/full 写满时也抛(只在有它的系统上)
    void appendFailureThrows() {
        QTemporaryDir tmp;
        domain::PlaybookLog pb(tmp.path());
        pb.append(u"2026-10-16"_s, js::object({{u"a"_s, js::N(1)}}));
        QFile::setPermissions(pb.fileOf(u"2026-10-16"_s), QFileDevice::ReadOwner);
        bool threw = false;
        try {
            pb.append(u"2026-10-16"_s, js::object({{u"a"_s, js::N(2)}}));
        } catch (const util::JsError&) {
            threw = true;
        }
        QVERIFY(threw);
    }

    void playbook() {
        QTemporaryDir tmp;
        const QString dir = tmp.path() + u"/playbook"_s;
        domain::PlaybookLog pb(dir);
        for (const OJson& r : at(u"records").items) pb.append(r.items[0].s, r.items[1]);
        QCOMPARE(js::stringify(filesOf(dir)), js::stringify(at(u"pbFiles")));
        QCOMPARE(js::stringify(byDate(pb.dates(), [&](const QString& d) { return pb.read(d); })), js::stringify(at(u"pbRead")));
        QCOMPARE(pb.prune(1), at(u"pbPrune").n);
        QCOMPARE(js::stringify(js::strings(pb.dates())), js::stringify(at(u"pbAfter")));
    }
};

QTEST_GUILESS_MAIN(TestDayLogs)
#include "tst_day_logs.moc"
