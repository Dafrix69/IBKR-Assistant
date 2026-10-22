// engine/parsing/validator(validator.ts)对着原模块现跑的答案(tests/fixtures/gen_validator.mjs):每一例是一份原始配置(两边各用 fromDict 读)、
// 时刻、快照、近期订单、时段表、extras 与一批订单;比 validateAll 的结果(含就地复核过的订单)、primaryCode / rejectionMessage、
// 减仓回调的调用次序、statusFor、orderSignature、riskWidth,以及同一实例上逐张 validateOne 的结果,逐字符比 JSON。
#include "domain/config.h"
#include "js_fixture.h"
#include "parsing/validator.h"

#include <QTest>

#include <memory>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using util::OJson;
namespace js = util::js;
namespace val = parsing::validator;

namespace {

/// 夹具里的一个格子:没有这个键 / '__undefined__' 都是 undefined
const OJson* field(const OJson& c, const QString& k) {
    const OJson* v = c.get(k);
    return jsfix::isUndefined(v) ? nullptr : v;
}

struct Built {
    std::unique_ptr<val::Validator> v;
    std::shared_ptr<OJson> log;
};

Built build(const OJson& c, const domain::Settings& settings) {
    Built b;
    b.log = std::make_shared<OJson>(js::array());
    const domain::EtNow now = domain::etNowFromEpoch(c.get(u"now"_s)->n);
    const OJson* snapshot = field(c, u"snapshot"_s);
    const OJson snap = snapshot ? dec(*snapshot) : OJson();
    std::optional<QList<OJson>> recent;
    if (const OJson* r = field(c, u"recent"_s); r && r->type == OJson::Array) recent = dec(*r).items;

    val::MarketStatusFn statusFn;
    if (const OJson* table = c.get(u"status"_s); table && table->type == OJson::Object) {
        const OJson t = *table;
        statusFn = [t](const OJson& order) -> std::optional<QString> {
            const OJson* v = t.get(js::str(js::path(&order, {u"contract"_s, u"symbol"_s})));
            if (v && v->type == OJson::String && v->s == u"THROW") throw std::runtime_error("boom");
            if (!v || v->type == OJson::Null) return std::nullopt;
            return v->s;
        };
    }

    val::ValidatorExtras extras;
    if (const OJson* e = field(c, u"extras"_s); e && e->type == OJson::Object) {
        const OJson ex = dec(*e);
        if (const OJson* exposure = ex.get(u"exposure"_s)) extras.exposure = *exposure;
        if (const OJson* note = ex.get(u"capNote"_s)) extras.capNote = note->s;
        if (const OJson* eq = ex.get(u"equity"_s)) {
            contract::OrderedMap<double> m;
            for (const auto& [k, v] : eq->fields) m.insert(k, v.n);
            extras.equity = m;
        }
        if (const OJson* reduce = ex.get(u"reduce"_s)) {
            auto left = std::make_shared<QHash<QString, double>>();
            for (const auto& [k, v] : reduce->fields) left->insert(k, v.n);
            const auto key = [](const OJson& order, const QString& alias) { return alias + u'|' + js::str(js::path(&order, {u"contract"_s, u"symbol"_s})); };
            auto log = b.log;
            extras.isReduction = [left, log, key](const OJson& order, const QString& alias) {
                const QString k = key(order, alias);
                const bool r = left->value(k, 0) > 0;
                log->items.append(js::array({js::S(u"is"_s), js::S(k), js::B(r)}));
                return r;
            };
            extras.consumeReduction = [left, log, key](const OJson& order, const QString& alias) {
                const QString k = key(order, alias);
                left->insert(k, left->value(k, 0) - 1);
                log->items.append(js::array({js::S(u"consume"_s), js::S(k)}));
            };
        }
    }
    b.v = std::make_unique<val::Validator>(settings, now, snapshot ? &snap : nullptr, recent ? &*recent : nullptr, statusFn, extras);
    return b;
}

OJson strList(const QStringList& l) { return js::strings(l); }

}  // namespace

class TestValidator : public QObject {
    Q_OBJECT
    OJson fx_;

private slots:
    void initTestCase() {
        fx_ = jsfix::load(u"validator.json"_s);
        QVERIFY(fx_.get(u"cases"_s)->items.size() > 300);
    }

    void cases() {
        int n = 0;
        for (const OJson& c : fx_.get(u"cases"_s)->items) {
            const QString name = c.get(u"name"_s)->s;
            const domain::Settings settings = domain::fromDict(dec(*c.get(u"config"_s)));
            const QList<OJson> original = dec(*c.get(u"orders"_s)).items;

            // validateAll
            Built b = build(c, settings);
            QList<OJson> orders = original;
            std::optional<double> limit;
            if (const OJson* l = c.get(u"limit"_s); l && l->type != OJson::Null && !(l->type == OJson::String && l->s == u"__omit__")) limit = dec(*l).n;
            const val::ValidationOutcome outcome = b.v->validateAll(orders, limit);
            JSFIX_SAME(*c.get(u"out"_s), val::toJson(outcome), name + u" validateAll"_s);
            QStringList primary, message;
            for (const auto& r : outcome.rejected) {
                primary << val::primaryCode(r);
                message << val::rejectionMessage(r);
            }
            JSFIX_SAME(*c.get(u"primary"_s), strList(primary), name + u" primaryCode"_s);
            JSFIX_SAME(*c.get(u"message"_s), strList(message), name + u" rejectionMessage"_s);
            JSFIX_SAME(*c.get(u"log"_s), *b.log, name + u" 减仓回调"_s);

            QStringList status, sigs;
            OJson widths = js::array();
            for (const OJson& o : original) {
                status << b.v->statusFor(o);
                sigs << val::orderSignature(o, js::str(o.get(u"account"_s)));
                widths.items.append(js::N(val::riskWidth(*o.get(u"contract"_s))));
            }
            JSFIX_SAME(*c.get(u"statusFor"_s), strList(status), name + u" statusFor"_s);
            JSFIX_SAME(*c.get(u"signatures"_s), strList(sigs), name + u" orderSignature"_s);
            JSFIX_SAME(*c.get(u"widths"_s), widths, name + u" riskWidth"_s);

            // 同一个实例上逐张 validateOne
            Built b2 = build(c, settings);
            OJson one = js::array();
            for (OJson o : original) {
                auto [issues, approved] = b2.v->validateOne(o);
                OJson is = js::array();
                for (const auto& i : issues) is.items.append(val::toJson(i));
                one.items.append(js::array({is, approved ? val::toJson(*approved) : js::Null()}));
            }
            JSFIX_SAME(*c.get(u"one"_s), one, name + u" validateOne"_s);
            JSFIX_SAME(*c.get(u"oneLog"_s), *b2.log, name + u" validateOne 减仓回调"_s);
            ++n;
        }
        QVERIFY(n > 300);
    }

    void constants() {
        QCOMPARE(val::kValidatorCodes.size(), 12);
        QCOMPARE(val::primaryCode(val::RejectedOrder{}), u"UNSUPPORTED"_s);
        QCOMPARE(val::rejectionMessage(val::RejectedOrder{OJson(), {{u"A"_s, u"x"_s}, {u"B"_s, u"y"_s}, {u"C"_s, u"x"_s}}}), u"x / y"_s);
    }
};

QTEST_GUILESS_MAIN(TestValidator)
#include "tst_validator.moc"
