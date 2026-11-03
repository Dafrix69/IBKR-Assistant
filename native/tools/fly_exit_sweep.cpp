// 蝶式出场参数的离线扫描:拿软件自己记下来的盘口(fly-iv/ 目录),问"换一组出场参数,过去这些天会怎样"。
// engine-ts/scripts/sweep-fly-exit.mjs 逐项搬过来的命令行入口;算法在 analysis/fly_exit_sweep*(纯函数,tst_fly_exit_sweep* 钉着),
// 这里只管读目录、把参数拼成配置、打印报告。口径、怎么读报告、它说不了什么,见 docs/features/fly-exit-sweep.md。
//
//   fly-exit-sweep --dir auto --arm 50,100,150 --tighten 150,200,300
//   fly-exit-sweep --dir ~/Library/Application\ Support/Datrix/fly-iv --wings 25 --entry-from 09:45 --entry-to 13:30 \
//       --debit-min 1 --debit-max 4 --dist-min 10 --dist-max 40 --arm 50,75,100,150 --stop-mult none,0.5 --commission 0.65 --out /tmp/sweep.json
//   fly-exit-sweep --dir auto --entries /tmp/my-entries.json --by all --arm 50,100,150      # 只算自己真实的入场
//   fly-exit-sweep --dir auto --replay --replay-grid '{"stop":[0.4,0.5,0.6],"trail_arm":[1.2,1.3,1.5]}'
//
// 只读:不改样本目录、不写仓库、不改任何源文件。要把结果留下来,用 --out 指一个仓库之外的路径(JSON)。
//
// --dir:样本目录(引擎的 IvRecorderService 写的 fly-iv/,一天一个 .jsonl)。auto = 从配置里的 storage.db_path 找:
//        --config → DAFRI_CONFIG → ~/Library/Application Support/Datrix/settings.json。没有别的默认路径。
//
// 入场人群(都没有默认值,不给就是不限;报告里逐项写明):
//   --symbol SPX                只扫这个标的的样本(默认 = 后台那一路记的标的)
//   --by loop|plan|all          用哪一路记的样本(默认 loop:后台五分钟一笔的那一路,行权价一整天不换)
//   --entry-from / --entry-to   入场时刻的窗口,美东 HH:MM
//   --wings 25,50               翼宽;--right C|P
//   --debit-min / --debit-max   入场价 D(点)
//   --dist-min / --dist-max     中心在现价虚值一侧多少点(看涨 = 中心 − 现价,看跌 = 现价 − 中心)
//   --entries file.json         真实入场的清单:[{"time":"2026-10-07 10:32","center":7750,"wing":25,"right":"C","quantity":1,"debit":2.2}]
// 成交口径:
//   --entry-spread-share 1      入场价 = 中间价 + 这一份 ×(立刻买得到的价 − 中间价);1 = 两翼卖价、中心买价(默认,保守)
//   --commission 0.65           每张合约每一边的佣金(美元)。**没有默认值**:不给,报告写明"扣佣金之前"
//   --terminal natural|settle   一直没出场的怎么了结(默认 natural:当天最后一笔的立刻成交价)
//   --settle-within 5.5         settle 口径下,最后一笔离收盘不超过这么多分钟才算记到了收盘(默认 = 记录间隔 + 一个节拍)
//   --stop-basis mid|natural    止损类拿哪个价判(默认 mid,和追踪的默认一样)
//   --qty 1  --multiplier 100   每个情景几组;合约乘数
//   --stride 1                  隔几笔样本判断一次
// 实盘预设要比的参数(每一项给几个取值,做全部组合;参照组 = flyexit 里现在的值,永远在):
//   --arm 50,100,150  --tighten 150,200,300  --tiers 40/30/20,50/35/20  --tight-at 3,4
//   --late-after 15:00,15:30  --late-factor 0.5,1  --floor 0.2,0.3  --stop-mult none,0.5  --exit-at none,15:30
//   --ref '{"stop_mult":0.5}'   参照组里预设之外的那两项(止损、到点)是每条追踪上人填的;你实盘固定这么设,就在这里说
//   --grid file.json            {"live":{"arm_usd":[…],…},"sets":[{…}],"replay":{"stop":[…]}}:同上,写成文件
// 回放策略(flyexit.simulate):
//   --replay                    连回放策略一起比;--replay-grid '{"stop":[0.4,0.5]}' 给要比的参数(键是 flyexit.DEFAULTS 上的)
//   --em auto|36                EM 每天从记下来的平值跨式取(默认),或一律用这个数
// 统计:
//   --objective r|usd           结论按哪个目标出(默认 r:盈亏 ÷ 付出的权利金);--level 0.95  --draws 2000  --seed 1
#include "analysis/fly_exit_sweep.h"
#include "analysis/fly_exit_sweep_json.h"
#include "analysis/fly_exit_sweep_report.h"
#include "analysis/fly_exit_sweep_stats.h"
#include "domain/config.h"
#include "orchestrate/services/iv_recorder.h"
#include "orchestrate/sweep_tracker_rules.h"
#include "util/jsobj.h"
#include "util/ordered_json.h"

#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QHash>
#include <QRegularExpression>
#include <QSet>
#include <QStandardPaths>

#include <cmath>
#include <cstdio>
#include <cstdlib>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace sw = ibkr::analysis::sweep;

#ifndef IBKR_REPO_DIR
#error "IBKR_REPO_DIR 要由 CMake 给出(--out 不许写进仓库)"
#endif

namespace {

[[noreturn]] void fail(const QString& message) {
    std::fprintf(stderr, "扫描没做:%s\n", message.toUtf8().constData());
    std::exit(1);
}
void err(const QString& line) { std::fprintf(stderr, "%s\n", line.toUtf8().constData()); }

const QSet<QString> kFlags = {
    u"dir"_s, u"config"_s, u"out"_s, u"symbol"_s, u"by"_s, u"entry-from"_s, u"entry-to"_s, u"wings"_s, u"right"_s, u"debit-min"_s, u"debit-max"_s,
    u"dist-min"_s, u"dist-max"_s, u"entries"_s, u"entry-spread-share"_s, u"commission"_s, u"terminal"_s, u"settle-within"_s, u"stop-basis"_s,
    u"qty"_s, u"multiplier"_s, u"stride"_s, u"arm"_s, u"tighten"_s, u"tiers"_s, u"tight-at"_s, u"late-after"_s, u"late-factor"_s, u"floor"_s,
    u"stop-mult"_s, u"exit-at"_s, u"ref"_s, u"grid"_s, u"replay"_s, u"replay-grid"_s, u"em"_s, u"objective"_s, u"level"_s, u"draws"_s, u"seed"_s,
};
const QSet<QString> kSwitches = {u"replay"_s};

/// 给了哪些参数,按给的先后(写进 --out 的 args 里)
QList<QPair<QString, QString>> g_order;
QHash<QString, QString> g_given;

bool has(const QString& name) { return g_given.contains(name); }
std::optional<QString> opt(const QString& name) {
    if (!has(name)) return std::nullopt;
    return g_given.value(name);
}
QString optOr(const QString& name, const QString& dflt) { return has(name) ? g_given.value(name) : dflt; }

std::optional<double> num(const QString& name) {
    const auto raw = opt(name);
    if (!raw) return std::nullopt;
    bool ok = false;
    const double v = raw->trimmed().toDouble(&ok);
    if (!ok || !std::isfinite(v)) fail(u"--%1 要是一个数,收到「%2」。"_s.arg(name, *raw));
    return v;
}
double numOr(const QString& name, double dflt) { return num(name).value_or(dflt); }

std::optional<QStringList> list(const QString& name) {
    const auto raw = opt(name);
    if (!raw) return std::nullopt;
    QStringList out;
    for (const QString& v : raw->split(u',')) {
        const QString t = v.trimmed();
        if (!t.isEmpty()) out << t;
    }
    return out;
}
double toNum(const QString& name, const QString& v, const QString& hint = {}) {
    bool ok = false;
    const double x = v.toDouble(&ok);
    if (!ok || !std::isfinite(x)) fail(u"--%1 里的「%2」不是数%3。"_s.arg(name, v, hint));
    return x;
}
/// [数…] 的 JSON 数组;没给是空
std::optional<OJson> nums(const QString& name) {
    const auto raw = list(name);
    if (!raw) return std::nullopt;
    OJson a = js::array();
    for (const QString& v : *raw) a.items.append(js::N(toNum(name, v)));
    return a;
}
/// 同上,none 写成 null
std::optional<OJson> numsOrNone(const QString& name) {
    const auto raw = list(name);
    if (!raw) return std::nullopt;
    OJson a = js::array();
    for (const QString& v : *raw) a.items.append(v == u"none" ? OJson::null() : js::N(toNum(name, v, u"(不设写 none)"_s)));
    return a;
}
QString oneOf(const QString& name, const QStringList& choices, const QString& dflt) {
    const QString v = optOr(name, dflt);
    if (!choices.contains(v)) fail(u"--%1 只能是 %2,收到「%3」。"_s.arg(name, choices.join(u" / "_s), v));
    return v;
}
OJson json(const QString& text, const QString& what) {
    QString why;
    const auto v = ibkr::util::parseOJson(text, &why);
    if (!v) fail(u"%1 不是合法的 JSON:%2"_s.arg(what, why));
    return *v;
}
OJson readJson(const QString& file) {
    QFile f(file);
    if (!f.exists()) fail(u"没有 %1。"_s.arg(file));
    if (!f.open(QIODevice::ReadOnly)) fail(u"读不了 %1。"_s.arg(file));
    return json(QString::fromUtf8(f.readAll()), file);
}
QString absPath(const QString& p) { return QDir::cleanPath(QDir::current().absoluteFilePath(ibkr::domain::expandHome(p))); }

/// --dir auto:配置里的交易库在哪,样本就在它旁边的 fly-iv/
QString samplesDir() {
    const auto dir = opt(u"dir"_s);
    if (!dir) fail(u"要给 --dir(样本目录;auto = 从配置里的 storage.db_path 找)。"_s);
    if (*dir != u"auto") return absPath(*dir);
    QString config;
    if (has(u"config"_s)) config = absPath(g_given.value(u"config"_s));
    else if (qEnvironmentVariableIsSet("DAFRI_CONFIG")) config = absPath(qEnvironmentVariable("DAFRI_CONFIG"));
    else config = QStandardPaths::writableLocation(QStandardPaths::GenericDataLocation) + u"/Datrix/settings.json"_s;
    if (!QFileInfo::exists(config))
        fail(u"--dir auto 要读配置里的 storage.db_path,但没有 %1。用 --config 指过去,或者直接给 --dir 一个目录。"_s.arg(config));
    const OJson cfg = readJson(config);
    const OJson* storage = cfg.get(u"storage"_s);
    const OJson* db = storage ? storage->get(u"db_path"_s) : nullptr;
    const QString raw = js::isStr(db) ? db->s : QString();
    if (raw.isEmpty()) fail(u"%1 里没有 storage.db_path。"_s.arg(config));
    return QFileInfo(absPath(raw)).absolutePath() + u"/fly-iv"_s;
}

std::optional<double> optNum(const OJson* v) {
    if (!v || v->type != OJson::Number) return std::nullopt;
    return v->n;
}
std::optional<QString> optStr(const OJson* v) {
    if (!v || v->type != OJson::String) return std::nullopt;
    return v->s;
}

struct Loaded {
    int files = 0;
    std::vector<sw::QuoteSample> samples;
};
/// 读整个目录;写了一半的行、形状不对的行跳过(同引擎读底账)
Loaded loadSamples(const QString& dir) {
    QDir d(dir);
    if (!d.exists()) fail(u"读不了样本目录 %1。"_s.arg(dir));
    static const QRegularExpression name(u"^\\d{4}-\\d{2}-\\d{2}\\.jsonl$"_s);
    QStringList files;
    for (const QString& f : d.entryList(QDir::Files, QDir::Name))
        if (name.match(f).hasMatch()) files << f;
    Loaded out;
    out.files = int(files.size());
    for (const QString& f : files) {
        QFile file(d.filePath(f));
        if (!file.open(QIODevice::ReadOnly)) continue;
        for (const QByteArray& line : file.readAll().split('\n')) {
            const QString text = QString::fromUtf8(line).trimmed();
            if (text.isEmpty()) continue;
            const auto v = ibkr::util::parseOJson(text);
            if (!v) continue;
            const OJson* t = v->get(u"t"_s);
            const OJson* spot = v->get(u"spot"_s);
            const OJson* legs = v->get(u"legs"_s);
            if (!t || t->type != OJson::Number || !spot || spot->type != OJson::Number || !(spot->n > 0) || !legs || legs->type != OJson::Array) continue;
            sw::QuoteSample s;
            s.t = t->n;
            s.spot = spot->n;
            s.by = optStr(v->get(u"by"_s));
            s.expiry = optStr(v->get(u"expiry"_s));
            s.symbol = optStr(v->get(u"symbol"_s));
            bool ok = true;
            for (const OJson& l : legs->items) {
                const OJson* k = l.get(u"strike"_s);
                const OJson* r = l.get(u"right"_s);
                if (!k || k->type != OJson::Number || !r || r->type != OJson::String) {
                    ok = false;
                    break;
                }
                s.legs.push_back({k->n, r->s, optNum(l.get(u"bid"_s)), optNum(l.get(u"ask"_s))});
            }
            if (ok) out.samples.push_back(std::move(s));
        }
    }
    return out;
}

/// --out 写到哪。派生出来的数可以留,但不留在仓库里:里面有按天的盈亏,换一批数据就过时。算之前就查,别算完才发现写不了
std::optional<QString> outTarget() {
    const auto out = opt(u"out"_s);
    if (!out) return std::nullopt;
    const QString target = absPath(*out);
    const QString where = QFileInfo(QFileInfo(target).absolutePath()).canonicalFilePath();
    if (where.isEmpty()) fail(u"--out 的目录不存在:%1"_s.arg(QFileInfo(target).absolutePath()));
    const QString repo = QFileInfo(QStringLiteral(IBKR_REPO_DIR)).canonicalFilePath();
    if (!repo.isEmpty() && (where == repo || where.startsWith(repo + u'/')))
        fail(u"--out 不能指到仓库里(%1):结果不进仓库。"_s.arg(repo));
    return target;
}

/// --ref 叠在参照组上:只认参照组本来就有的键(写错的键名当场拒,不悄悄忽略)
sw::LiveParams referenceWith(const OJson* ref) {
    const sw::LiveParams base = sw::liveReference();
    if (!ref) return base;
    if (ref->type != OJson::Object) fail(u"--ref 要是一个 JSON 对象。"_s);
    OJson row = sw::liveRow(base);
    for (const auto& [key, value] : ref->fields) {
        if (!row.get(key)) fail(u"--ref 里没有「%1」这个参数(认得的是:%2)。"_s.arg(key, [&] {
                                     QStringList ks;
                                     for (const auto& [k, _] : row.fields) ks << k;
                                     return ks.join(u", "_s);
                                 }()));
        row.set(key, value);
    }
    const auto n = [&](const QString& k) {
        const OJson* v = row.get(k);
        if (!v || v->type != OJson::Number) fail(u"--ref 里的 %1 要是一个数。"_s.arg(k));
        return v->n;
    };
    const auto s = [&](const QString& k) {
        const OJson* v = row.get(k);
        if (!v || v->type != OJson::String) fail(u"--ref 里的 %1 要是 HH:MM。"_s.arg(k));
        return v->s;
    };
    sw::LiveParams p;
    p.arm_usd = n(u"arm_usd"_s);
    p.tighten_usd = n(u"tighten_usd"_s);
    p.loose_pct = n(u"loose_pct"_s);
    p.mid_pct = n(u"mid_pct"_s);
    p.tight_pct = n(u"tight_pct"_s);
    p.tight_at = n(u"tight_at"_s);
    p.late_after = s(u"late_after"_s);
    p.late_factor = n(u"late_factor"_s);
    p.floor = n(u"floor"_s);
    p.stop_mult = optNum(row.get(u"stop_mult"_s));
    p.exit_at = optStr(row.get(u"exit_at"_s));
    return p;
}

OJson objectOr(const OJson& v) { return v.type == OJson::Object ? v : js::object(); }

}  // namespace

int main(int argc, char** argv) {
    QCoreApplication app(argc, argv);
    const QStringList args = app.arguments().mid(1);
    // 不认识的参数当场拒:一个写错名字的人群限定被悄悄忽略,报告说的就不是你以为的那群蝶
    for (qsizetype i = 0; i < args.size(); ++i) {
        const QString& arg = args[i];
        if (arg == u"--help" || arg == u"-h") {
            err(u"用法见源文件 native/tools/fly_exit_sweep.cpp 的开头,口径见 docs/features/fly-exit-sweep.md。"_s);
            return 0;
        }
        if (!arg.startsWith(u"--")) fail(u"看不懂「%1」:参数都以 -- 开头。"_s.arg(arg));
        const QString name = arg.mid(2);
        if (!kFlags.contains(name)) fail(u"没有 --%1 这个参数(用法在 native/tools/fly_exit_sweep.cpp 的开头)。"_s.arg(name));
        QString value = u"1"_s;
        if (!kSwitches.contains(name)) {
            if (i + 1 >= args.size()) fail(u"--%1 后面要跟一个值。"_s.arg(name));
            value = args[++i];
        }
        g_given.insert(name, value);
        g_order.append({name, value});
    }

    const auto target = outTarget();
    const QString dir = samplesDir();
    const Loaded loaded = loadSamples(dir);
    if (loaded.samples.empty()) fail(u"%1 里没有样本(%2 个文件)。"_s.arg(dir).arg(loaded.files));

    std::optional<OJson> tiers;
    if (const auto raw = list(u"tiers"_s)) {
        tiers = js::array();
        for (const QString& t : *raw) {
            const QStringList parts = t.split(u'/');
            OJson tri = js::array();
            bool ok = parts.size() == 3;
            for (const QString& p : parts) {
                bool good = false;
                const double v = p.toDouble(&good);
                ok = ok && good && std::isfinite(v);
                tri.items.append(js::N(v));
            }
            if (!ok) fail(u"--tiers 的每一组要写成 40/30/20,收到「%1」。"_s.arg(t));
            tiers->items.append(tri);
        }
    }
    std::optional<OJson> exitAt;
    if (const auto raw = list(u"exit-at"_s)) {
        exitAt = js::array();
        for (const QString& v : *raw) exitAt->items.append(v == u"none" ? OJson::null() : js::S(v));
    }
    std::optional<OJson> lateAfter;
    if (const auto raw = list(u"late-after"_s)) lateAfter = js::strings(*raw);
    const QString em = optOr(u"em"_s, u"auto"_s);
    double emNum = 0;
    if (em != u"auto") {
        bool ok = false;
        emNum = em.toDouble(&ok);
        if (!ok || !(emNum > 0)) fail(u"--em 要是 auto 或一个正数,收到「%1」。"_s.arg(em));
    }
    const std::optional<QString> right = has(u"right"_s) ? std::optional<QString>(oneOf(u"right"_s, {u"C"_s, u"P"_s}, {})) : std::nullopt;
    const QString objective = oneOf(u"objective"_s, {u"r"_s, u"usd"_s}, u"r"_s);

    sw::SweepConfig config;
    try {
        // 文件与命令行里写错的键名、看不懂的时刻,都由 fly_exit_sweep_spec 里的校验当场拒(gridFileFrom / entriesFrom / liveSets / replaySets)
        const sw::GridFile file = sw::gridFileFrom(has(u"grid"_s) ? readJson(absPath(g_given.value(u"grid"_s))) : js::object());
        OJson grid = objectOr(file.live);
        const auto put = [&](const QString& key, const std::optional<OJson>& v) {
            if (v) grid.set(key, *v);
        };
        put(u"arm_usd"_s, nums(u"arm"_s));
        put(u"tighten_usd"_s, nums(u"tighten"_s));
        put(u"tiers"_s, tiers);
        put(u"tight_at"_s, nums(u"tight-at"_s));
        put(u"late_after"_s, lateAfter);
        put(u"late_factor"_s, nums(u"late-factor"_s));
        put(u"floor"_s, nums(u"floor"_s));
        put(u"stop_mult"_s, numsOrNone(u"stop-mult"_s));
        put(u"exit_at"_s, exitAt);
        const OJson refJson = has(u"ref"_s) ? json(g_given.value(u"ref"_s), u"--ref"_s) : OJson::null();
        const sw::LiveParams reference = referenceWith(has(u"ref"_s) ? &refJson : nullptr);
        OJson replayGrid = objectOr(file.replay);
        if (has(u"replay-grid"_s)) {
            const OJson extra = json(g_given.value(u"replay-grid"_s), u"--replay-grid"_s);
            if (extra.type != OJson::Object) fail(u"--replay-grid 要是一个 JSON 对象。"_s);
            for (const auto& [k, v] : extra.fields) replayGrid.set(k, v);
        }
        const bool wantReplay = has(u"replay"_s) || !replayGrid.fields.isEmpty();

        config.symbol = optOr(u"symbol"_s, ibkr::orchestrate::IvRecorderService::kSymbol);
        sw::Population& pop = config.population;
        pop.by = oneOf(u"by"_s, {u"loop"_s, u"plan"_s, u"all"_s}, u"loop"_s);
        pop.entry_from = opt(u"entry-from"_s);
        pop.entry_to = opt(u"entry-to"_s);
        if (const auto w = nums(u"wings"_s)) {
            pop.wings.emplace();
            for (const OJson& x : w->items) pop.wings->push_back(x.n);
        }
        if (right) pop.rights = std::vector<QString>{*right};
        pop.debit_min = num(u"debit-min"_s);
        pop.debit_max = num(u"debit-max"_s);
        pop.dist_min = num(u"dist-min"_s);
        pop.dist_max = num(u"dist-max"_s);
        if (has(u"entries"_s)) config.entries = sw::entriesFrom(readJson(absPath(g_given.value(u"entries"_s))));
        sw::FillModel& fill = config.fill;
        fill.entry_spread_share = numOr(u"entry-spread-share"_s, 1);
        fill.commission = num(u"commission"_s);
        fill.terminal = oneOf(u"terminal"_s, {u"natural"_s, u"settle"_s}, u"natural"_s);
        // 后台那一路每隔 kIntervalMs 记一笔、每个 kTickMs 看一眼:记到了收盘的那一天,最后一笔离收盘不会超过两者之和
        fill.settle_within_min = numOr(u"settle-within"_s,
                                       (ibkr::orchestrate::IvRecorderService::kIntervalMs + ibkr::orchestrate::IvRecorderService::kTickMs) / 60'000.0);
        fill.stop_basis = oneOf(u"stop-basis"_s, {u"mid"_s, u"natural"_s}, u"mid"_s);
        fill.qty = numOr(u"qty"_s, 1);
        fill.multiplier = numOr(u"multiplier"_s, 100);
        config.live = sw::liveSets(reference, &grid, file.sets);
        if (wantReplay) {
            sw::ReplayConfig rc;
            rc.emAuto = em == u"auto";
            rc.em = emNum;
            for (const OJson& s : sw::replaySets(&replayGrid)) rc.sets.push_back(s);
            config.replay = rc;
        }
        config.stride = numOr(u"stride"_s, 1);
    } catch (const sw::SweepError& e) {
        fail(e.message());
    }

    err(u"读到 %1:%2 天的文件、%3 笔;实盘预设 %4 组%5。开始算……"_s.arg(dir)
            .arg(loaded.files)
            .arg(qsizetype(loaded.samples.size()))
            .arg(qsizetype(config.live.size()))
            .arg(config.replay ? u"、回放策略 %1 组"_s.arg(qsizetype(config.replay->sets.size())) : QString()));
    sw::SweepResult result;
    try {
        const ibkr::orchestrate::SweepTrackerRules rules;  // 判定用的就是实盘那一份
        result = sw::runSweep(loaded.samples, config, rules,
                              [](const QString& date, double done, double total) { err(u"  %1(%2/%3)"_s.arg(date).arg(done).arg(total)); });
    } catch (const sw::SweepError& e) {
        fail(e.message());
    }
    sw::BootOptions boot;
    boot.level = numOr(u"level"_s, 0.95);
    boot.draws = numOr(u"draws"_s, 2000);
    boot.seed = numOr(u"seed"_s, 1);
    const sw::Summary summary = sw::summarise(result, objective, boot);
    std::puts(sw::formatReport(result, summary).join(u'\n').toUtf8().constData());
    std::printf("\n样本目录:%s\n", dir.toUtf8().constData());

    if (!target) {
        std::puts("没有写任何文件(要把数留下来加 --out 路径.json)。");
        return 0;
    }
    OJson given = js::object();
    for (const auto& [k, v] : g_order) given.set(k, js::S(v));
    const OJson out = js::object({{u"dir"_s, js::S(dir)}, {u"args"_s, given}, {u"result"_s, sw::resultJson(result)}, {u"summary"_s, sw::summaryJson(summary)}});
    QFile f(*target);
    if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate)) fail(u"写不了 %1。"_s.arg(*target));
    f.write(ibkr::util::stringifyOJson(out, 2).toUtf8());
    std::printf("已写入 %s。\n", target->toUtf8().constData());
    return 0;
}
