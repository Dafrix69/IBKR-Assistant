// transport/perf_log(engine-ts/src/rpc/perfLog.ts)对着原模块现跑的答案(tests/fixtures/gen_perf_log.mjs):
// quantile、slowLine,以及 RpcTimings 按脚本跑(记 / 批量记 / 看汇总 / 写一行)——逐字符比 JSON,蓄水池抽样的随机数两边同序。
#include "js_fixture.h"
#include "transport/perf_log.h"

#include <QTest>

#include <cmath>

using namespace ibkr;
using namespace Qt::StringLiterals;
using util::OJson;
namespace js = util::js;

namespace {

std::vector<double> numbers(const OJson& list) {
    std::vector<double> out;
    for (const OJson& x : list.items) out.push_back(jsfix::dec(x).n);
    return out;
}

rpc::Lane laneOf(const QString& s) { return s == u"local" ? rpc::Lane::Local : s == u"read" ? rpc::Lane::Read : rpc::Lane::Trade; }

/// 第 i 次调用:((i+1)·2654435761 mod 2^32) / 2^32(生成器里同一条公式)
std::function<double()> sequence() {
    auto i = std::make_shared<quint64>(0);
    return [i] { return double((++*i * 2654435761ULL) % 4294967296ULL) / 4294967296.0; };
}

/// 边界那一组(生成器的 edgeRng):第一次 0.9999,之后轮流 0、0.9996、0.99999999、0.5
std::function<double()> edgeSequence() {
    auto i = std::make_shared<quint64>(0);
    return [i] {
        static const double cyc[] = {0, 0.9996, 0.99999999, 0.5};
        if (*i == 0) return ++*i, 0.9999;
        return cyc[(*i)++ - 1 & 3];
    };
}

}  // namespace

class TestPerfLog : public QObject {
    Q_OBJECT
private slots:
    void constants() {
        const OJson fx = jsfix::load(u"perf-log.json"_s);
        const OJson* c = fx.get(u"constants"_s);
        QCOMPARE(rpc::kFlushMs, c->get(u"FLUSH_MS"_s)->n);
        QCOMPARE(rpc::kQueueNoteMs, c->get(u"QUEUE_NOTE_MS"_s)->n);
        QCOMPARE(double(rpc::kMaxSamples), c->get(u"MAX_SAMPLES"_s)->n);
    }
    void quantile() {
        const OJson fx = jsfix::load(u"perf-log.json"_s);
        for (const OJson& c : fx.get(u"quantile"_s)->items) {
            const auto xs = numbers(*c.get(u"xs"_s));
            const double q = jsfix::dec(*c.get(u"q"_s)).n;
            const QString what = js::stringify(*c.get(u"xs"_s)).left(80) + u" q="_s + js::stringify(*c.get(u"q"_s));
            JSFIX_EXPECT(c, [&] { return js::N(rpc::quantile(xs, q)); }, what);
        }
    }
    void slowLine() {
        const OJson fx = jsfix::load(u"perf-log.json"_s);
        qsizetype lines = 0;
        for (const OJson& c : fx.get(u"slow"_s)->items) {
            const double w = jsfix::dec(*c.get(u"w"_s)).n, r = jsfix::dec(*c.get(u"r"_s)).n, s = jsfix::dec(*c.get(u"s"_s)).n;
            const QString m = c.get(u"m"_s)->s;
            const QString what = u"%1 w=%2 r=%3 s=%4"_s.arg(m, js::stringify(*c.get(u"w"_s)), js::stringify(*c.get(u"r"_s)), js::stringify(*c.get(u"s"_s)));
            JSFIX_EXPECT(c, [&] {
                const auto line = rpc::slowLine(m, w, r, s);
                return line ? js::S(*line) : js::Null();
            }, what);
            if (c.get(u"out"_s) && c.get(u"out"_s)->type == OJson::String) ++lines;
        }
        QCOMPARE(fx.get(u"slow"_s)->items.size(), qsizetype(600));
        QVERIFY(lines > 100 && lines < 500);  // 慢与不慢两边都有
    }
    void timingsScripts() {
        const OJson fx = jsfix::load(u"perf-log.json"_s);
        qsizetype flushed = 0, summaries = 0, errors = 0, idx = 0;
        for (const OJson& sc : fx.get(u"scenarios"_s)->items) {
            ++idx;
            const bool edge = sc.get(u"rand"_s)->s == u"edge";
            rpc::RpcTimings timings(sc.get(u"now0"_s)->n, edge ? edgeSequence() : sequence());
            qsizetype r = 0;
            const OJson* res = sc.get(u"res"_s);
            for (const OJson& rawOp : sc.get(u"ops"_s)->items) {
                const OJson op = jsfix::dec(rawOp);
                const QString kind = op.items[0].s;
                if (kind == u"r") {
                    timings.record(op.items[1].s, laneOf(op.items[2].s), op.items[3].n, op.items[4].n);
                    continue;
                }
                if (kind == u"gen") {
                    const double count = op.items[3].n, a = op.items[4].n, b = op.items[5].n;
                    for (double i = 0; i < count; ++i) timings.record(op.items[1].s, laneOf(op.items[2].s), std::fmod(i * a, 1013) / 8, std::fmod(i * b, 4999) / 16);
                    continue;
                }
                const OJson& want = res->items[r++];
                const QString what = u"场景 %1 第 %2 个结果"_s.arg(idx).arg(r);
                if (kind == u"s") {
                    ++summaries;
                    JSFIX_EXPECT(want, [&] { return timings.summary(); }, what);
                } else {
                    const bool hasExtra = !(rawOp.items[2].type == OJson::String && rawOp.items[2].s == u"__undefined__");
                    JSFIX_EXPECT(want, [&] {
                        const auto line = hasExtra ? timings.flush(op.items[1].n, op.items[2]) : timings.flush(op.items[1].n);
                        return line ? js::S(*line) : js::Null();
                    }, what);
                    if (want.get(u"error"_s)) ++errors;
                    else if (want.get(u"out"_s)->type == OJson::String) ++flushed;
                }
            }
            QCOMPARE(r, res->items.size());
        }
        QVERIFY(flushed > 100);
        QVERIFY(summaries > 100);
        QVERIFY(errors > 0);
    }
    /// 样本里有 NaN(TS 的 sort((a,b)=>a-b) 对它的结果取决于 V8 的实现,生成器不喂):这边把 NaN 排在最后,分位数落到它就是 NaN(JSON 里 null)
    void nanSamplesSortLast() {
        rpc::RpcTimings t(0, [] { return 0.5; });
        for (const double ms : {3.0, std::nan(""), 1.0, 2.0, std::nan(""), 0.0}) t.record(u"m"_s, rpc::Lane::Read, 0, ms);
        const OJson s = t.summary();
        QCOMPARE(js::stringify(*js::path(&s, {u"m"_s, u"run"_s})), u"{\"p50\":2,\"p90\":null,\"p99\":null,\"max\":null}"_s);  // 排序后 0 1 2 3 NaN NaN;max 是 NaN(Math.max 见 NaN 就是 NaN)
        // 只有一个 NaN 在最前面也排到最后
        rpc::RpcTimings u(0, [] { return 0.5; });
        for (const double ms : {std::nan(""), 5.0, 4.0}) u.record(u"m"_s, rpc::Lane::Read, 0, ms);
        const OJson s2 = u.summary();
        QCOMPARE(js::stringify(*js::path(&s2, {u"m"_s, u"run"_s})), u"{\"p50\":5,\"p90\":null,\"p99\":null,\"max\":null}"_s);
    }
    void laneNames() {
        QCOMPARE(rpc::laneName(rpc::Lane::Local), u"local"_s);
        QCOMPARE(rpc::laneName(rpc::Lane::Read), u"read"_s);
        QCOMPARE(rpc::laneName(rpc::Lane::Trade), u"trade"_s);
    }
};

QTEST_GUILESS_MAIN(TestPerfLog)
#include "tst_perf_log.moc"
