// engine/parsing/prompts(prompts.ts)对着原模块现跑的答案(tests/fixtures/gen_prompts.mjs):每一版提示词在几份配置下的指纹、系统提示词全文、
// 少样本(业务用的那一份按 JSON.stringify 比键序),三千多次用户消息渲染(含泄漏与残留变量的报错),写坏的提示词目录。
#include "js_fixture.h"
#include "parsing/prompts.h"

#include <QDir>
#include <QFile>
#include <QTemporaryDir>
#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using jsfix::dec;
using util::OJson;
namespace js = util::js;
namespace pr = parsing::prompts;

namespace {
const QString kPrompts = QStringLiteral(IBKR_PROMPTS_DIR);

domain::Settings settingsOf(const OJson& base, const OJson* over, const QString& version, const QString& dir) {
    OJson raw = base;
    if (over)
        for (const auto& [k, v] : over->fields) raw.set(k, v);
    raw.set(u"prompt_dir"_s, js::S(dir));
    raw.set(u"prompt_version"_s, js::S(version));
    return domain::fromDict(raw);
}
OJson bundleJson(const pr::PromptBundle& b) {
    OJson few = js::array();
    for (const pr::FewShotPair& p : b.fewshot)
        few.items.append(js::object({{u"name"_s, js::S(p.name)}, {u"user"_s, js::S(p.user)}, {u"assistant"_s, js::S(js::stringify(p.assistant))}}));
    return js::object({{u"fingerprint"_s, js::S(pr::fingerprint(b))},
                       {u"version"_s, js::S(b.version)},
                       {u"system_text"_s, js::S(b.system_text)},
                       {u"user_template"_s, js::S(b.user_template)},
                       {u"fewshot"_s, few}});
}
domain::EtNow momentOf(const OJson& m) { return {m.get(u"epochMs"_s)->n, m.get(u"date"_s)->s, m.get(u"minutes"_s)->n, m.get(u"seconds"_s)->n}; }
QString masked(QString s, const QString& dir, const QString& tag) { return s.replace(dir, tag); }
}  // namespace

class TestPrompts : public QObject {
    Q_OBJECT
    OJson fx_;
    QList<OJson> configs_;

private slots:
    void initTestCase() {
        fx_ = jsfix::load(u"prompts.json"_s);
        // 与生成器里 configs 那张表同序(TS 那边写在脚本里)
        const OJson& base = *fx_.get(u"config"_s);
        OJson limitsA = *base.get(u"limits"_s), limitsB = *base.get(u"limits"_s);
        limitsA.set(u"max_order_notional"_s, js::N(999.5));
        limitsB.set(u"max_order_notional"_s, js::N(12345.678901));
        configs_ = {js::object(), js::object({{u"limits"_s, limitsA}}), js::object({{u"limits"_s, limitsB}}), js::object({{u"symbol_aliases"_s, js::object()}}),
                    js::object({{u"accounts"_s, js::array({js::object({{u"alias"_s, js::S(u"唯一"_s)},
                                                                       {u"account_id"_s, js::S(u"DU1"_s)},
                                                                       {u"is_paper"_s, js::B(true)},
                                                                       {u"connection"_s, js::S(u"paper"_s)},
                                                                       {u"default"_s, js::B(true)}})})}})};
    }

    void bundlesAndUsers() {
        const OJson& base = *fx_.get(u"config"_s);
        for (const OJson& c : fx_.get(u"bundles"_s)->items) {
            const domain::Settings s = settingsOf(base, &configs_[qsizetype(c.get(u"c"_s)->n)], c.get(u"version"_s)->s, kPrompts);
            const QString what = u"loadPromptBundle "_s + c.get(u"version"_s)->s;
            JSFIX_EXPECT(c, [&] {
                try {
                    return bundleJson(pr::loadPromptBundle(s));
                } catch (const util::JsError& e) {
                    throw pr::PromptError(masked(e.message(), kPrompts, u"<PROMPTS>"_s));
                }
            }, what);
        }
        int n = 0;
        pr::PromptBundle bundle;
        domain::Settings settings;
        QString loadedKey;
        for (const OJson& c : fx_.get(u"users"_s)->items) {
            const QString version = c.get(u"version"_s)->s;
            const QString key = version + js::stringify(*c.get(u"c"_s));
            if (key != loadedKey) {
                settings = settingsOf(base, &configs_[qsizetype(c.get(u"c"_s)->n)], version, kPrompts);
                bundle = pr::loadPromptBundle(settings);
                loadedKey = key;
            }
            const domain::Settings& s = settings;
            const OJson* snapRaw = c.get(u"snap"_s);
            std::optional<OJson> snap;
            if (snapRaw->type == OJson::String && snapRaw->s != u"__undefined__") {
                // 生成器把非有限数写成 "__NaN__" 一类,-0 写成 "__neg0__"
                snap = dec(*util::parseOJson(snapRaw->s));
            }
            const OJson* status = c.get(u"status"_s);
            JSFIX_EXPECT(c, [&] {
                return js::S(pr::renderUser(bundle, s, c.get(u"ins"_s)->s, momentOf(*c.get(u"m"_s)), status->type == OJson::String ? status->s : QString(),
                                            snap && snap->type != OJson::Null ? &*snap : nullptr));
            }, u"renderUser #%1"_s.arg(n));
            ++n;
        }
        QVERIFY(n > 3000);
    }

    void brokenDirectory() {
        QTemporaryDir dir;
        QVERIFY(dir.isValid());
        for (const QString& f : QDir(kPrompts).entryList(QDir::Files)) QVERIFY(QFile::copy(kPrompts + u'/' + f, dir.path() + u'/' + f));
        for (const auto& [name, text] : fx_.get(u"badFiles"_s)->fields) {
            QFile f(dir.path() + u'/' + name);
            QVERIFY(f.open(QIODevice::WriteOnly));
            f.write(text.s.toUtf8());
        }
        const OJson& base = *fx_.get(u"config"_s);
        for (const OJson& c : fx_.get(u"bad"_s)->items) {
            const domain::Settings s = settingsOf(base, nullptr, c.get(u"version"_s)->s, dir.path());
            std::optional<pr::PromptBundle> loaded;
            JSFIX_EXPECT(c, [&] {
                try {
                    loaded = pr::loadPromptBundle(s);
                } catch (const util::JsError& e) {
                    throw pr::PromptError(masked(e.message(), dir.path(), u"<BAD>"_s));
                }
                OJson few = js::array();
                for (const pr::FewShotPair& p : loaded->fewshot)
                    few.items.append(js::object({{u"name"_s, js::S(p.name)}, {u"user"_s, js::S(p.user)}, {u"assistant"_s, js::S(js::stringify(p.assistant))}}));
                return js::object({{u"fingerprint"_s, js::S(pr::fingerprint(*loaded))}, {u"system"_s, js::S(loaded->system_text)}, {u"fewshot"_s, few}});
            }, u"bad "_s + c.get(u"version"_s)->s);
            if (const OJson* u = c.get(u"user"_s)) {
                QVERIFY(loaded);
                const domain::EtNow m = momentOf(*fx_.get(u"users"_s)->items[0].get(u"m"_s));
                JSFIX_EXPECT(*u, [&] { return js::S(pr::renderUser(*loaded, s, u"hi"_s, m)); }, u"bad renderUser "_s + c.get(u"version"_s)->s);
            }
        }
    }
};

QTEST_GUILESS_MAIN(TestPrompts)
#include "tst_prompts.moc"
