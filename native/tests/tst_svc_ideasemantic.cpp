// IdeaSemanticService(services/ideaSemantic.ts)对着原模块现跑的答案:脚本驱动的假大模型 / 假嵌入器 + 真的交易库(想法向量表)+ 虚拟钟。
// 夹具:fixtures/svc_ideasemantic.json(gen_svc_ideasemantic.mjs)。
#include "orchestrate/services/idea_semantic.h"
#include "svc_world.h"

#include <QTest>

using namespace svcw;

namespace {

std::vector<double> vecOf(const QString& t) {
    int sum = 0;
    for (QChar c : t) sum += c.unicode();
    return {double((t.size() % 7) + 1), double((sum % 11) + 1), 1, double(((t.size() * 3) % 5) + 1)};
}

class FakeEmbedder : public EmbedderPort {
public:
    FakeEmbedder(World* w, const OJson& script) : w_(w), script_(script), model_(str(script, u"model"_s, u"qwen3-embedding:8b-q8_0"_s)) {}
    QString model() const override { return model_; }
    Task<std::vector<std::vector<double>>> embed(std::vector<QString> texts, double timeoutMs) override {
        QStringList l(texts.begin(), texts.end());
        w_->rec(u"embed"_s, u"call"_s, js::array({js::strings(l), js::N(timeoutMs)}));
        const OJson r = pickResult(script_, counters_, u"embed"_s, js::array({js::object()}));
        if (flag(r, u"hang"_s)) co_await ibkr::util::Deferred<>().task();
        if (num(r, u"delay"_s) > 0) co_await w_->sleep(num(r, u"delay"_s));
        co_await w_->tick();
        if (const OJson* e = r.get(u"error"_s)) throw ibkr::util::JsError(e->s);
        std::vector<std::vector<double>> out;
        for (const QString& t : texts) {
            if (const OJson* f = r.get(u"fixed"_s)) {
                std::vector<double> v;
                for (const OJson& x : f->items) v.push_back(x.n);
                out.push_back(v);
            } else {
                out.push_back(vecOf(t));
            }
        }
        if (flag(r, u"short"_s) && !out.empty()) out.pop_back();
        co_return out;
    }

private:
    World* w_;
    OJson script_;
    QString model_;
    QHash<QString, int> counters_;
};

Svc buildIdea(World& w, Host& host, const OJson& script, Runner&) {
    auto svc = std::make_shared<IdeaSemanticService>(host);
    const QString m = str(script, u"mode"_s);
    svc->mode = m == u"embed" ? SemanticMode::Embed : m == u"off" ? SemanticMode::Off : SemanticMode::Llm;
    if (!flag(script, u"noEmbedder"_s)) svc->embedder = std::make_shared<FakeEmbedder>(&w, script);
    World* world = &w;
    auto llmCounters = std::make_shared<QHash<QString, int>>();
    const OJson scriptCopy = script;
    LlmJson llm = [world, llmCounters, scriptCopy](QString system, QString user, OJson schema) -> Task<OJson> {
        world->rec(u"llm"_s, u"call"_s, js::array({js::S(system), js::S(user), schema}));
        const OJson r = pickResult(scriptCopy, *llmCounters, u"llm"_s, js::array({js::object({{u"value"_s, js::object({{u"ids"_s, js::array()}})}})}));
        if (flag(r, u"hang"_s)) co_await ibkr::util::Deferred<>().task();
        if (num(r, u"delay"_s) > 0) co_await world->sleep(num(r, u"delay"_s));
        co_await world->tick();
        if (const OJson* e = r.get(u"error"_s)) throw ibkr::util::JsError(e->s);
        const OJson* v = r.get(u"value"_s);
        co_return v ? *v : js::Null();
    };
    Svc s;
    s.methods[u"rank"_s] = [svc, llm](OJson a) -> Task<OJson> {
        const auto r = co_await svc->rank(str(a, u"query"_s), a.get(u"pool"_s)->items, flag(a, u"useLlm"_s) ? llm : LlmJson{});
        if (!r) co_return js::Null();
        OJson out = js::array();
        for (const QString& k : r->keys()) out.items.append(js::array({js::S(k), js::N(r->value(k))}));
        co_return out;
    };
    s.ops[u"mode"_s] = [svc](const OJson& step, OJson&) {
        const QString m = str(step, u"mode"_s);
        svc->mode = m == u"embed" ? SemanticMode::Embed : m == u"off" ? SemanticMode::Off : SemanticMode::Llm;
    };
    s.stop = [svc] {};
    return s;
}

}  // namespace

class TstSvcIdeaSemantic : public QObject {
    Q_OBJECT
private slots:
    void scenarios() {
        const OJson fx = jsfix::load(u"svc_ideasemantic.json"_s);
        const OJson& base = *fx.get(u"base"_s);
        QStringList failures;
        int n = 0;
        for (const OJson& sc : fx.get(u"scenarios"_s)->items) {
            const QString what = sc.get(u"name"_s)->s;
            if (qEnvironmentVariableIsSet("SVC_TRACE")) fprintf(stderr, "scenario %s\n", qPrintable(what));
            const OJson script = jsfix::dec(*sc.get(u"script"_s));
            Runner runner(script, base, buildIdea);
            const OJson got = runner.run();
            if (qEnvironmentVariableIsSet("SVC_DUMP") && what == qEnvironmentVariable("SVC_DUMP")) {
                QFile f(QDir::tempPath() + u"/svc_got.json"_s);
                if (f.open(QIODevice::WriteOnly)) f.write(js::stringify(jsfix::enc(got)).toUtf8());
            }
            if (!jsfix::same(*sc.get(u"expected"_s), got, what)) failures.append(what);
            ++n;
        }
        QVERIFY2(failures.isEmpty(), qPrintable(failures.join(u"\n"_s)));
        QVERIFY(n > 0);
    }
};

QTEST_GUILESS_MAIN(TstSvcIdeaSemantic)
#include "tst_svc_ideasemantic.moc"
