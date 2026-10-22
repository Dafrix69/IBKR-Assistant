// engine/execution/auto_mid + broker_pricing(autoMid.ts 与 broker.ts 的纯定价那一小段)对着原模块现跑的答案(tests/fixtures/gen_auto_mid.mjs):
// 立刻成交的净价、按价差的一份让价(含份额 / 结构宽度 / 跳动的各种坏值)、中间价、腿中间价、向上 / 向下对齐跳动,逐字符比。
#include "execution/auto_mid.h"
#include "js_fixture.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using util::OJson;
namespace js = util::js;
namespace ex = execution;

namespace {
std::vector<ex::LegQuote> legsFrom(const OJson& arr) {
    std::vector<ex::LegQuote> out;
    for (const OJson& raw : arr.items) {
        const OJson l = dec(raw);
        ex::LegQuote q;
        q.action = l.get(u"action"_s)->s;
        q.ratio = l.get(u"ratio"_s)->n;
        q.bid = l.get(u"bid"_s)->n;
        q.ask = l.get(u"ask"_s)->n;
        out.push_back(q);
    }
    return out;
}
std::optional<double> optNum(const OJson* v) {
    const OJson d = v ? dec(*v) : OJson::null();
    if (d.type == OJson::Number) return d.n;
    return std::nullopt;
}
}  // namespace

class TstAutoMid : public QObject {
    Q_OBJECT
private slots:
    void natural() {
        const OJson fx = jsfix::load(u"auto_mid.json"_s);
        for (const OJson& c : fx.get(u"natural"_s)->items) JSFIX_EXPECT(c, [&] { return js::N(ex::comboNaturalPrice(legsFrom(*c.get(u"legs"_s)))); }, u"natural"_s);
    }
    void share() {
        const OJson fx = jsfix::load(u"auto_mid.json"_s);
        int i = 0;
        for (const OJson& c : fx.get(u"share"_s)->items) {
            JSFIX_EXPECT(c, [&] {
                const auto tick = optNum(c.get(u"tick"_s));
                return js::N(ex::autoMidShareLimit(legsFrom(*c.get(u"legs"_s)), c.get(u"action"_s)->s, dec(*c.get(u"share"_s)).n, optNum(c.get(u"width"_s)),
                                                   tick ? *tick : ex::kDefaultComboTick));
            }, u"share #%1"_s.arg(i));
            ++i;
        }
    }
    void mid() {
        const OJson fx = jsfix::load(u"auto_mid.json"_s);
        for (const OJson& c : fx.get(u"mid"_s)->items) JSFIX_EXPECT(c, [&] { return js::N(ex::comboMidPrice(legsFrom(*c.get(u"legs"_s)))); }, u"mid"_s);
    }
    void legMid() {
        const OJson fx = jsfix::load(u"auto_mid.json"_s);
        for (const OJson& c : fx.get(u"legMid"_s)->items) JSFIX_EXPECT(c, [&] { return js::N(ex::legMid(legsFrom(js::array({*c.get(u"leg"_s)}))[0])); }, u"legMid"_s);
    }
    void align() {
        const OJson fx = jsfix::load(u"auto_mid.json"_s);
        for (const OJson& c : fx.get(u"align"_s)->items) {
            const double value = dec(*c.get(u"value"_s)).n;
            const auto t = optNum(c.get(u"tick"_s));
            const double tick = t ? *t : ex::kDefaultComboTick;
            const OJson up = *c.get(u"up"_s), down = *c.get(u"down"_s);
            JSFIX_SAME(up, js::N(ex::alignTickUp(value, tick)), u"alignTickUp"_s);
            JSFIX_SAME(down, js::N(ex::alignTickDown(value, tick)), u"alignTickDown"_s);
        }
    }
};

QTEST_GUILESS_MAIN(TstAutoMid)
#include "tst_auto_mid.moc"
