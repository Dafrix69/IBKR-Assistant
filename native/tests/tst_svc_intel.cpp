// IntelService(services/intel.ts)对着原模块现跑的答案:脚本驱动的假 router + 真的交易库 + 真的 EventsService / MarketDataService + 虚拟钟。
// 夹具:fixtures/svc_intel.json(gen_svc_intel.mjs)。
#include "orchestrate/services/intel.h"
#include "svc_world.h"

#include <QTest>

using namespace svcw;

namespace {

Svc buildIntel(World& w, Host& host, const OJson& script, Runner& runner) {
    ibkr::analysis::macro::clearMacroCache();
    auto market = std::make_shared<MarketDataService>(host);
    auto events = std::make_shared<EventsService>(host);
    events->fetcher = runner.makeFetcher();
    const OJson changes = script.get(u"changePct"_s) ? *script.get(u"changePct"_s) : js::object();
    auto intel = std::make_shared<IntelService>(host, *market, *events, [changes](const QString& s) -> std::optional<double> {
        const OJson* v = changes.get(s);
        return (v && v->type == OJson::Number) ? std::optional<double>(v->n) : std::nullopt;
    });
    Svc s;
    s.methods[u"record"_s] = [intel](OJson a) -> Task<OJson> {
        const OJson& m = *a.get(u"message"_s);
        ibkr::util::DiscordMessage dm;
        dm.id = str(m, u"id"_s);
        dm.channel_id = str(m, u"channel_id"_s);
        dm.author_id = str(m, u"author_id"_s);
        dm.author_name = str(m, u"author_name"_s);
        dm.content = str(m, u"content"_s);
        dm.sentAtMs = num(m, u"sentAtMs"_s);
        co_await intel->record(dm, flag(a, u"trusted"_s));
        co_return js::Null();
    };
    s.methods[u"feed"_s] = [intel](OJson a) -> Task<OJson> { co_return co_await intel->feed(*a.get(u"params"_s)); };
    s.methods[u"dossier"_s] = [intel](OJson a) -> Task<OJson> { co_return co_await intel->dossier(*a.get(u"params"_s)); };
    s.methods[u"held"_s] = [intel](const OJson&) -> Task<OJson> { co_return js::array(co_await intel->heldRows()); };
    s.stop = [market, events, intel] {};
    (void)w;
    return s;
}

}  // namespace

class TstSvcIntel : public QObject {
    Q_OBJECT
private slots:
    void scenarios() {
        const OJson fx = jsfix::load(u"svc_intel.json"_s);
        const OJson& base = *fx.get(u"base"_s);
        QStringList failures;
        int n = 0;
        for (const OJson& sc : fx.get(u"scenarios"_s)->items) {
            const QString what = sc.get(u"name"_s)->s;
            if (qEnvironmentVariableIsSet("SVC_TRACE")) fprintf(stderr, "scenario %s\n", qPrintable(what));
            const OJson script = jsfix::dec(*sc.get(u"script"_s));
            Runner runner(script, base, buildIntel);
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

QTEST_GUILESS_MAIN(TstSvcIntel)
#include "tst_svc_intel.moc"
