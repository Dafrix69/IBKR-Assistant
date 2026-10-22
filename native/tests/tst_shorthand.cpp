// engine/parsing/shorthand(shorthand.ts)对着原模块现跑的答案(tests/fixtures/gen_shorthand.mjs):3700 多句话的「像不像」、要谁的现价,
// 4800 次解析的整份产出(含拒绝、写到 meta 里的相对中心),逐字比 JSON。句子按 UTF-16 存(里面有落单的代理项)。
#include "js_fixture.h"
#include "parsing/shorthand.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using util::OJson;
namespace js = util::js;
namespace sh = parsing::shorthand;

namespace {
QString fromHex(const QString& h) {
    const QByteArray b = QByteArray::fromHex(h.toLatin1());
    return QString(reinterpret_cast<const QChar*>(b.constData()), b.size() / 2);
}
QString toHex(const QString& s) { return QString::fromLatin1(QByteArray(reinterpret_cast<const char*>(s.utf16()), s.size() * 2).toHex()); }
domain::EtNow momentOf(const OJson& m) { return {m.get(u"epochMs"_s)->n, m.get(u"date"_s)->s, m.get(u"minutes"_s)->n, m.get(u"seconds"_s)->n}; }
/// 产出里那两格原文换成 {hex}(同夹具)
OJson hexed(OJson o) {
    if (o.type != OJson::Object) return o;
    if (OJson* orders = o.get(u"orders"_s))
        for (OJson& order : orders->items)
            if (OJson* r = order.get(u"reason"_s)) *r = js::object({{u"hex"_s, js::S(toHex(r->s))}});
    if (OJson* rej = o.get(u"rejections"_s))
        for (OJson& r : rej->items)
            if (OJson* t = r.get(u"original_text"_s)) *t = js::object({{u"hex"_s, js::S(toHex(t->s))}});
    return o;
}
}  // namespace

class TestShorthand : public QObject {
    Q_OBJECT
    OJson fx_;

private slots:
    void initTestCase() { fx_ = jsfix::load(u"shorthand.json"_s); }

    void looks() {
        for (const OJson& c : fx_.get(u"looks"_s)->items) {
            const QString t = fromHex(c.get(u"t"_s)->s);
            const QString what = js::stringify(js::S(t));
            QVERIFY2(sh::looksLikeShorthand(t) == c.get(u"shorthand"_s)->b, qPrintable(u"looksLikeShorthand "_s + what));
            QVERIFY2(sh::looksLikeOrder(t) == c.get(u"order"_s)->b, qPrintable(u"looksLikeOrder "_s + what));
            QVERIFY2(sh::spreadWithoutType(t) == c.get(u"noType"_s)->b, qPrintable(u"spreadWithoutType "_s + what));
            JSFIX_SAME(*c.get(u"symbols"_s), js::strings(sh::shorthandSymbols(t)), u"shorthandSymbols "_s + what);
        }
    }

    void parses() {
        int hits = 0;
        for (const OJson& c : fx_.get(u"parses"_s)->items) {
            const QString t = fromHex(c.get(u"t"_s)->s);
            const OJson snap = dec(*c.get(u"snap"_s));
            sh::ShorthandMeta meta;
            const QString what = u"tryParseShorthand "_s + js::stringify(js::S(t)) + u" @ "_s + c.get(u"moment"_s)->get(u"date"_s)->s;
            JSFIX_EXPECT(c, [&] { return hexed(sh::tryParseShorthand(t, snap, momentOf(*c.get(u"moment"_s)), &meta)); }, what);
            const OJson* m = c.get(u"meta"_s);
            if (m->type == OJson::String) QVERIFY2(!meta.set, qPrintable(u"meta 不该被写:"_s + what));
            else QVERIFY2(meta.set && meta.relativeCenter == m->b, qPrintable(u"meta.relativeCenter:"_s + what));
            if (c.get(u"out"_s) && c.get(u"out"_s)->type == OJson::Object) ++hits;
        }
        QVERIFY(hits > 600);
    }
};

QTEST_GUILESS_MAIN(TestShorthand)
#include "tst_shorthand.moc"
