// util/intel_dateparse(V8 的 Date.parse)对着 Electron 41 现跑的答案(tests/fixtures/gen_intel_dateparse.mjs):
// 两万多个 ISO、老写法、写坏的与拼出来的串,本机时区 Asia/Shanghai,逐个比时刻(NaN 也比)。
#include "js_fixture.h"
#include "util/intel_dateparse.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using util::OJson;

class TestIntelDateParse : public QObject {
    Q_OBJECT
private slots:
    void parse() {
        const OJson fx = jsfix::load(u"intel-dateparse.json"_s);
        const QTimeZone local(QByteArrayLiteral("Asia/Shanghai"));
        int n = 0;
        for (const OJson& c : fx.get(u"cases"_s)->items) {
            const QString s = c.items[0].s;
            const double want = jsfix::dec(c.items[1]).n, got = util::v8DateParse(s, local);
            if (std::isnan(want) && std::isnan(got)) continue;
            QVERIFY2(want == got, qPrintable(u"Date.parse(%1):V8 %2,C++ %3"_s.arg(util::js::stringify(c.items[0])).arg(want, 0, 'f', 0).arg(got, 0, 'f', 0)));
            ++n;
        }
        QVERIFY(n > 1000);
    }
};

QTEST_GUILESS_MAIN(TestIntelDateParse)
#include "tst_intel_dateparse.moc"
