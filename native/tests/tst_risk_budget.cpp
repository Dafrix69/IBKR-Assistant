// engine/util/risk_budget 对着原模块(engine-ts/src/riskBudget.ts)现算的答案(tests/fixtures/gen_risk_budget.mjs)。
#include "util/risk_budget.h"

#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTest>

#include <limits>

using namespace ibkr;
using namespace Qt::StringLiterals;

class TestRiskBudget : public QObject {
    Q_OBJECT
private slots:
    void cases() {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/risk-budget.json"));
        QVERIFY(f.open(QIODevice::ReadOnly));
        const QJsonObject j = QJsonDocument::fromJson(f.readAll()).object();
        QList<contract::RiskBudgetConfig> cfgs;
        for (const QJsonValue& v : j[u"cfgs"_s].toArray()) {
            contract::RiskBudgetConfig c;
            c.enabled = v[u"enabled"_s].toBool();
            c.max_risk_pct = v[u"max_risk_pct"_s].toDouble();
            c.max_position_pct = v[u"max_position_pct"_s].toDouble();
            const QJsonObject eq = v[u"equity_usd"_s].toObject();
            for (auto it = eq.begin(); it != eq.end(); ++it) c.equity_usd.insert(it.key(), it.value().toDouble());
            cfgs << c;
        }
        const QJsonArray cases = j[u"cases"_s].toArray();
        QVERIFY(cases.size() > 400);
        for (const QJsonValue& v : cases) {
            const QJsonValue e = v[u"exposure"_s];
            const double exposure = e.isString() ? std::numeric_limits<double>::quiet_NaN() : e.toDouble();
            const std::optional<QString> got = util::riskBudgetWarning(cfgs[v[u"ci"_s].toInt()], v[u"alias"_s].toString(), v[u"sec"_s].toString(), exposure);
            if (v[u"out"_s].isNull()) QVERIFY2(!got, qPrintable(got.value_or(QString())));
            else QCOMPARE(got.value_or(u"<空>"_s), v[u"out"_s].toString());
        }
    }
};

QTEST_GUILESS_MAIN(TestRiskBudget)
#include "tst_risk_budget.moc"
