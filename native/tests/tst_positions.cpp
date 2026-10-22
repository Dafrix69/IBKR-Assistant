// engine/domain/positions(positions.ts + combos.ts + marketdata.ts)对着原模块(tests/fixtures/gen_positions.mjs):
// 行权价写法、腿身份、名字、key;613 组持仓上的 withCombos(组合识别、虚拟行的每个字段与键序)与 groupLegs;K 线周期表。
#include "domain/positions.h"
#include "util/jsobj.h"

#include <QFile>
#include <QTest>

using namespace ibkr;
using util::OJson;
namespace js = ibkr::util::js;
using namespace Qt::StringLiterals;

class TestPositions : public QObject {
    Q_OBJECT
    OJson fx;
    static const OJson* undefOr(const OJson* v) { return v->type == OJson::String && v->s == u"__undefined__" ? nullptr : v; }

private slots:
    void initTestCase() {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR) + u"/positions.json"_s);
        QVERIFY(f.open(QIODevice::ReadOnly));
        fx = *util::parseOJson(QString::fromUtf8(f.readAll()));
    }

    void identity() {
        const OJson negZero = OJson::number(-0.0);
        for (const OJson& c : fx.get(u"fmt"_s)->items) {
            const OJson* s = c.get(u"s"_s);
            QCOMPARE(domain::fmtStrike(s->type == OJson::String && s->s == u"__neg0__" ? &negZero : undefOr(s)), c.get(u"out"_s)->s);
        }
        for (const OJson& c : fx.get(u"legs"_s)->items) {
            const OJson* ct = undefOr(c.get(u"c"_s));
            QCOMPARE(domain::legOf(ct), c.get(u"legOf"_s)->s);
            const QList<std::pair<QString, QString>> args{{u"SPX"_s, u"OPT"_s}, {u"SPX"_s, u"STK"_s}, {QString(), u"OPT"_s}, {u"  "_s, u"FOP"_s}};
            for (qsizetype i = 0; i < args.size(); ++i) QCOMPARE(domain::positionLabel(args[i].first, args[i].second, ct), c.get(u"labels"_s)->items[i].s);
        }
        const QStringList keys{domain::makeKey(u"a"_s, u"b"_s, u"c"_s, QString()), domain::makeKey(u"a"_s, u"b"_s, u"OPT"_s, u"20261016|7800|C"_s),
                               domain::makeKey(QString(), QString(), QString(), QString())};
        QCOMPARE(js::stringify(js::strings(keys)), js::stringify(*fx.get(u"keys"_s)));
    }

    void combos() {
        int n = 0;
        for (const OJson& c : fx.get(u"combos"_s)->items) {
            const QList<OJson> rows = c.get(u"rows"_s)->items;
            const QString got = js::stringify(js::array(domain::withCombos(rows)));
            const QString want = js::stringify(*c.get(u"out"_s));
            if (got != want) qWarning().noquote() << "持仓:" << js::stringify(*c.get(u"rows"_s)).left(1500) << "\nC++:" << got.right(2500) << "\nTS :" << want.right(2500);
            QCOMPARE(got, want);
            QCOMPARE(js::stringify(js::array(domain::groupLegs(rows))), js::stringify(*c.get(u"groups"_s)));
            ++n;
        }
        QCOMPARE(n, 619);
    }

    void marketdata() {
        QCOMPARE(js::stringify(domain::timeframes()), js::stringify(*fx.get(u"timeframes"_s)));
        QCOMPARE(double(domain::kMinBars), fx.get(u"minBars"_s)->n);
        QCOMPARE(domain::kDelayedFeedMaxMs, fx.get(u"delayedMax"_s)->n);
    }
};

QTEST_GUILESS_MAIN(TestPositions)
#include "tst_positions.moc"
