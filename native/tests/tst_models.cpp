// engine/domain/models(+ util/zod)对着原模块(engine-ts/src/models.ts 跑在 zod 3.25.76 上,tests/fixtures/gen_models.mjs):
// 16 个 schema 上 7368 次 safeParse——成功时的输出逐字比(键序、默认值、trim / 大写 / 乘数归一),失败时每一条 issue 的 code、path、message
// 与先后逐条比(哪些检查在类型错之后还会跑、superRefine 什么时候不跑,都在这里看得出来);外加 parseLlmPayload 与 multiplierValue。
#include "domain/models.h"
#include "util/error.h"
#include "util/jsobj.h"

#include <QFile>
#include <QTest>

using namespace ibkr;
using util::OJson;
namespace js = ibkr::util::js;
namespace z = ibkr::util::zod;
using namespace Qt::StringLiterals;

namespace {
const z::Schema& schemaByName(const QString& n) {
    using namespace domain::models;
    if (n == u"LegSchema") return legSchema();
    if (n == u"ContractSpecSchema") return contractSpecSchema();
    if (n == u"TriggerSpecSchema") return triggerSpecSchema();
    if (n == u"OrderSpecSchema") return orderSpecSchema();
    if (n == u"ParsedOrderSchema") return parsedOrderSchema();
    if (n == u"RejectionSchema") return rejectionSchema();
    if (n == u"StockPickSchema") return stockPickSchema();
    if (n == u"SectorPicksSchema") return sectorPicksSchema();
    if (n == u"RuleOperandSchema") return ruleOperandSchema();
    if (n == u"RuleConditionSchema") return ruleConditionSchema();
    if (n == u"CustomRulesSchema") return customRulesSchema();
    if (n == u"BacktestInstrumentSchema") return backtestInstrumentSchema();
    if (n == u"IdeaAnalysisSchema") return ideaAnalysisSchema();
    if (n == u"IdeaDigestSchema") return ideaDigestSchema();
    if (n == u"PACommentSchema") return paCommentSchema();
    if (n == u"ParseResultSchema") return parseResultSchema();
    throw std::logic_error("unknown schema");
}
}  // namespace

class TestModels : public QObject {
    Q_OBJECT
    OJson fx;

private slots:
    void initTestCase() {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR) + u"/models.json"_s);
        QVERIFY(f.open(QIODevice::ReadOnly));
        fx = *util::parseOJson(QString::fromUtf8(f.readAll()));
    }

    void safeParse() {
        int n = 0, failed = 0;
        for (const OJson& c : fx.get(u"cases"_s)->items) {
            const QString name = c.get(u"schema"_s)->s;
            const OJson* in = c.get(u"input"_s);
            const bool undef = in->type == OJson::String && in->s == u"__undefined__";
            const auto r = z::safeParse(schemaByName(name), undef ? nullptr : in);
            QString got;
            if (r.success) {
                got = u"OK "_s + js::stringify(r.data.value_or(OJson()));
            } else {
                QList<OJson> issues;
                for (const auto& i : r.issues) issues << js::array({js::S(i.code), js::strings(i.path), js::S(i.message)});
                got = u"ERR "_s + js::stringify(js::array(issues));
            }
            const OJson* data = c.get(u"data"_s);
            const QString want = data ? u"OK "_s + js::stringify(*data) : u"ERR "_s + js::stringify(*c.get(u"issues"_s));
            if (got != want) qWarning().noquote() << name << js::stringify(*in).left(500) << "\nC++:" << got.left(1500) << "\nTS :" << want.left(1500);
            QCOMPARE(got, want);
            ++n;
            failed += r.success ? 0 : 1;
        }
        QCOMPARE(n, 7368);
        QCOMPARE(failed, 6422);
    }

    void llmPayloads() {
        for (const OJson& c : fx.get(u"llm"_s)->items) {
            QString got;
            try {
                got = js::stringify(domain::models::parseLlmPayload(c.get(u"payload"_s)));
            } catch (const util::JsError& e) {
                got = u"ERR "_s + e.message();
            }
            const OJson* err = c.get(u"error"_s);
            QCOMPARE(got, err ? u"ERR "_s + err->s : js::stringify(*c.get(u"out"_s)));
        }
        for (const OJson& c : fx.get(u"mult"_s)->items) QCOMPARE(domain::models::multiplierValue(*c.get(u"c"_s)), c.get(u"out"_s)->n);
    }
};

QTEST_GUILESS_MAIN(TestModels)
#include "tst_models.moc"
