// engine/analysis/symbol_mentions(symbolMentions.ts)对着原模块现跑的答案(tests/fixtures/gen_symbol_mentions.mjs):
// 六千多句拼出来的话在九份名单上认出的标的(档位、原词、先后)、行话判定、名单的拼法、叫法表的值不是串时抛的话,逐字符比 JSON。
#include "analysis/symbol_mentions.h"
#include "js_fixture.h"

#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using util::OJson;
namespace js = util::js;
namespace sm = analysis::symbol_mentions;

namespace {
sm::Universe universeOf(const OJson& u) {
    sm::Universe out;
    for (const OJson& k : u.get(u"known"_s)->items) out.add(k.s);
    out.aliases = *u.get(u"aliases"_s);
    const OJson* implied = u.get(u"implied"_s);
    if (implied->type == OJson::String) out.implied = implied->s;
    return out;
}
OJson toJson(const std::vector<sm::Mention>& ms) {
    OJson a = js::array();
    for (const sm::Mention& m : ms) a.items.append(m.toJson());
    return a;
}
std::vector<sm::Mention> mentionsOf(const OJson& a) {
    std::vector<sm::Mention> out;
    for (const OJson& m : a.items) out.push_back({m.get(u"symbol"_s)->s, m.get(u"how"_s)->s, m.get(u"term"_s)->s});
    return out;
}
}  // namespace

class TestSymbolMentions : public QObject {
    Q_OBJECT
    OJson fx_;
    QList<sm::Universe> universes_;

private slots:
    void initTestCase() {
        fx_ = jsfix::load(u"symbol-mentions.json"_s);
        for (const OJson& u : fx_.get(u"universes"_s)->items) universes_ << universeOf(u);
    }

    void builtins() {
        QCOMPARE(js::stringify(sm::builtinAliases()), js::stringify(*fx_.get(u"builtinAliases"_s)));
        QCOMPARE(js::stringify(js::strings(sm::builtinKnown())), js::stringify(*fx_.get(u"builtinKnown"_s)));
    }

    void universes() {
        for (const OJson& c : fx_.get(u"made"_s)->items) {
            const OJson* aliases = c.get(u"aliases"_s);
            const OJson* implied = c.get(u"implied"_s);
            const OJson al = jsfix::isUndefined(aliases) ? js::object() : *aliases;
            std::optional<QString> imp = u"SPX"_s;
            if (!jsfix::isUndefined(implied)) imp = implied->type == OJson::String ? std::optional(implied->s) : std::nullopt;
            const sm::Universe u = sm::makeUniverse(c.get(u"known"_s)->items, al, imp);
            JSFIX_SAME(*c.get(u"out"_s), u.toJson(), js::stringify(*c.get(u"known"_s)));
        }
    }

    void mentions() {
        int n = 0;
        for (const OJson& c : fx_.get(u"cases"_s)->items) {
            const sm::Universe& u = universes_[qsizetype(c.get(u"u"_s)->n)];
            const QString text = c.get(u"text"_s)->s;
            JSFIX_EXPECT(c, [&] { return toJson(sm::extractMentions(text, u)); }, u"「%1」 名单 %2"_s.arg(text).arg(c.get(u"u"_s)->n));
            ++n;
        }
        QVERIFY(n > 6000);
        for (const OJson& c : fx_.get(u"nullish"_s)->items)
            JSFIX_EXPECT(c, [&] { return toJson(sm::extractMentions(QString(), universes_[1])); }, u"null 原文"_s);
    }

    void badAliasValues() {
        QList<sm::Universe> bad;
        for (const OJson& u : fx_.get(u"badUniverses"_s)->items) bad << universeOf(u);
        for (const OJson& c : fx_.get(u"bad"_s)->items) {
            const QString text = c.get(u"text"_s)->s;
            JSFIX_EXPECT(c, [&] { return toJson(sm::extractMentions(text, bad[qsizetype(c.get(u"b"_s)->n)])); }, text);
        }
    }

    void optionTalk() {
        for (const OJson& c : fx_.get(u"talk"_s)->items) {
            const QString text = c.get(u"text"_s)->s;
            QVERIFY2(sm::looksLikeOptionTalk(text) == c.get(u"out"_s)->b, qPrintable(text));
        }
    }

    void dedupe() {
        for (const OJson& c : fx_.get(u"lists"_s)->items) {
            const auto ms = mentionsOf(*c.get(u"ms"_s));
            QCOMPARE(js::stringify(js::strings(sm::confidentSymbols(ms))), js::stringify(*c.get(u"confident"_s)));
            QCOMPARE(js::stringify(js::strings(sm::guessedSymbols(ms))), js::stringify(*c.get(u"guessed"_s)));
        }
    }
};

QTEST_GUILESS_MAIN(TestSymbolMentions)
#include "tst_symbol_mentions.moc"
