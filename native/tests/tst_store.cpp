// engine/domain/store(+ store_safety、risk_queries、log_stores、imported_trades)对着原模块(engine-ts/src/store.ts 那一组)
// 在 tests/fixtures/gen_store.mjs 的同一串操作上:239 步,每一步的返回值(或抛出的话与 code)、之后整个库的样子
// (每张表按 rowid 的全部行、sqlite_master 里的建表原文、user_version)逐字比;再加老结构的库打开时的迁移、真应用开库的保险
// (版本、完整性、每日 / 升级 / 手动备份与留几份、损坏 / 占用 / 写不进去的人话)。钟与 id 两边换成同一套可复现的。
#include "domain/store.h"
#include "domain/store_safety.h"
#include "util/js_runtime.h"
#include "util/jsobj.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QTemporaryDir>
#include <QTest>

using namespace ibkr;
using namespace ibkr::domain;
using util::OJson;
using util::sqlite::Bind;
namespace js = ibkr::util::js;
using namespace Qt::StringLiterals;

namespace {

double g_now = 0;
int g_uuid = 0;
QString uuidOf(int n) { return u"00000000-0000-4000-8000-%1"_s.arg(n, 12, 10, QChar(u'0')); }

OJson dumpDb(const QString& path) {
    util::sqlite::Database db(path, {true, true, 5000});
    const QList<OJson> master = db.prepare(u"SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name"_s).all();
    OJson tables = js::object();
    for (const OJson& t : master) {
        if (js::str(t.get(u"type"_s)) != u"table") continue;
        const QString name = js::str(t.get(u"name"_s));
        QList<util::sqlite::Row> rows;
        try {
            rows = db.prepare(u"SELECT * FROM \"%1\" ORDER BY rowid"_s.arg(name)).allRows();
        } catch (const util::JsError&) {
            rows = db.prepare(u"SELECT * FROM \"%1\""_s.arg(name)).allRows();
        }
        QList<OJson> out;
        for (const auto& r : rows) {
            QList<OJson> cells;
            for (const auto& c : r.cells) {
                if (std::holds_alternative<QByteArray>(c)) cells << js::object({{u"blob"_s, js::S(QString::fromLatin1(std::get<QByteArray>(c).toHex()))}});
                else cells << util::sqlite::cellJson(c);
            }
            out << js::array(cells);
        }
        tables.set(name, js::array(out));
    }
    const auto uv = db.pragmaSimple(u"user_version"_s);
    return js::object({{u"user_version"_s, uv ? *uv : js::Null()}, {u"master"_s, js::array(master)}, {u"tables"_s, tables}});
}

OJson list(const QList<OJson>& l) { return js::array(l); }
OJson opt(const std::optional<OJson>& v) { return v ? *v : js::Null(); }
QString s(const OJson& args, int i) { return js::str(&args.items[i]); }
double n(const OJson& args, int i) { return args.items[i].n; }
bool has(const OJson& args, int i) { return args.items.size() > i; }
const OJson* a(const OJson& args, int i) { return has(args, i) ? &args.items[i] : nullptr; }
std::optional<QString> optStr(const OJson& args, int i) {
    if (!has(args, i) || args.items[i].type == OJson::Null) return std::nullopt;
    return s(args, i);
}
QStringList strList(const OJson& v) {
    QStringList out;
    for (const OJson& x : v.items) out << js::str(&x);
    return out;
}
OJson mapOf(const QList<std::pair<QString, OJson>>& m) {
    QList<OJson> entries;
    for (const auto& [k, v] : m) entries << js::array({js::S(k), v});
    return js::object({{u"__map"_s, js::array(entries)}});
}

/// 一步操作(名字与参数同 gen_store.mjs 的 ops)
OJson call(TradeStore& st, const QString& name, OJson& args) {
    if (name == u"createRecord") return js::S(st.createRecord(args.items[0]));
    if (name == u"appendEvent") return st.appendEvent(s(args, 0), s(args, 1), args.items[2]), js::Null();
    if (name == u"markSubmitIntent") return st.markSubmitIntent(s(args, 0)), js::Null();
    if (name == u"setFinalStatus") return st.setFinalStatus(s(args, 0), s(args, 1), optStr(args, 2)), js::Null();
    if (name == u"getRecord") return opt(st.getRecord(s(args, 0)));
    if (name == u"listRecords") return list(st.listRecords());
    if (name == u"rememberFills") return js::N(st.rememberFills(args.items[0].items));
    if (name == u"listFills") return list(st.listFills());
    if (name == u"countFills") return js::N(st.countFills());
    if (name == u"fillsByOrderRef") return list(has(args, 1) ? st.fillsByOrderRef(s(args, 0), n(args, 1)) : st.fillsByOrderRef(s(args, 0)));
    if (name == u"rawExec") {
        util::sqlite::Binds b;
        if (has(args, 1))
            for (const OJson& x : args.items[1].items) b << Bind::from(x);
        return st.rawExec(s(args, 0), b), js::Null();
    }
    if (name == u"audit") return st.audit(s(args, 0), s(args, 1), a(args, 2)), js::Null();
    if (name == u"plannedStops") return list(st.plannedStops());
    if (name == u"closeTraces") return list(has(args, 0) ? st.closeTraces(n(args, 0)) : st.closeTraces());
    if (name == u"recentCloses") return list(st.recentCloses(n(args, 0), n(args, 1)));
    if (name == u"recentOrders") return list(st.recentOrders(n(args, 0), n(args, 1)));
    if (name == u"realizedPnlEvents") return list(st.realizedPnlEvents(n(args, 0), n(args, 1)));
    if (name == u"listWorkingRecords")
        return list(st.listWorkingRecords(has(args, 0) ? n(args, 0) : 7, has(args, 1) ? std::optional<double>(n(args, 1)) : std::nullopt, has(args, 2) ? n(args, 2) : 200));
    if (name == u"risk.dailyLossTrips") return list(st.risk().dailyLossTrips(n(args, 0), n(args, 1)));
    if (name == u"risk.recentOrderDetails") return list(st.risk().recentOrderDetails(n(args, 0), n(args, 1)));
    if (name == u"risk.workingOrders") return list(st.risk().workingOrders(n(args, 0), n(args, 1)));
    if (name == u"addWatch") return st.addWatch(s(args, 0), has(args, 1) ? n(args, 1) : 0, has(args, 2) ? s(args, 2) : QString());
    if (name == u"updateWatch") return js::B(st.updateWatch(s(args, 0), args.items[1]));
    if (name == u"listWatches") return list(st.listWatches());
    if (name == u"getWatch") return opt(st.getWatch(s(args, 0)));
    if (name == u"deleteWatch") return js::B(st.deleteWatch(s(args, 0)));
    if (name == u"addTrack") return st.addTrack(args.items[0]);
    if (name == u"updateTrack") return js::B(st.updateTrack(s(args, 0), args.items[1]));
    if (name == u"listTracks") return list(st.listTracks());
    if (name == u"getTrack") return opt(st.getTrack(s(args, 0)));
    if (name == u"deleteTrack") return js::B(st.deleteTrack(s(args, 0)));
    if (name == u"addQualityStock") return st.addQualityStock(s(args, 0), a(args, 1));
    if (name == u"updateQualityStock") return js::B(st.updateQualityStock(s(args, 0), args.items[1]));
    if (name == u"listQualityStocks") return list(st.listQualityStocks());
    if (name == u"getQualityStock") return opt(st.getQualityStock(s(args, 0)));
    if (name == u"deleteQualityStock") return js::B(st.deleteQualityStock(s(args, 0)));
    if (name == u"setPref") return st.setPref(s(args, 0), a(args, 1)), js::Null();
    if (name == u"getPref") return st.getPref(s(args, 0));
    if (name == u"addSector") return st.addSector(s(args, 0));
    if (name == u"setSectorStocks") return js::B(st.setSectorStocks(s(args, 0), args.items[1]));
    if (name == u"symbolsInSectors") return js::object({{u"__set"_s, js::strings(st.symbolsInSectors())}});
    if (name == u"listSectors") return list(st.listSectors());
    if (name == u"getSector") return opt(st.getSector(s(args, 0)));
    if (name == u"deleteSector") return js::B(st.deleteSector(s(args, 0)));
    if (name == u"addIdea")
        return st.addIdea(s(args, 0), has(args, 1) && args.items[1].type != OJson::Null ? std::optional<QStringList>(strList(args.items[1])) : std::nullopt);
    if (name == u"setIdeaStatus") return js::B(st.setIdeaStatus(s(args, 0), s(args, 1)));
    if (name == u"setIdeaSymbols") return js::B(st.setIdeaSymbols(s(args, 0), strList(args.items[1])));
    if (name == u"setIdeaAnalysis") return js::B(st.setIdeaAnalysis(s(args, 0), args.items[1]));
    if (name == u"listIdeas") return list(st.listIdeas(optStr(args, 0), has(args, 1) ? n(args, 1) : 200));
    if (name == u"getIdea") return opt(st.getIdea(s(args, 0)));
    if (name == u"searchIdeas") return list(st.searchIdeas(args.items[0]));
    if (name == u"addIdeaDigest") return st.addIdeaDigest(s(args, 0), strList(args.items[1]), args.items[2], a(args, 3), a(args, 4));
    if (name == u"listIdeaDigests") return list(has(args, 0) ? st.listIdeaDigests(n(args, 0)) : st.listIdeaDigests());
    if (name == u"signals.log") return st.signalLog().log(args.items[0].items), js::Null();
    if (name == u"signals.logOnce") return js::N(st.signalLog().logOnce(args.items[0].items, s(args, 1)));
    if (name == u"signals.list") return list(has(args, 0) ? st.signalLog().list(s(args, 0), n(args, 1)) : st.signalLog().list());
    if (name == u"signals.listWithSeq") return list(st.signalLog().listWithSeq());
    if (name == u"follow.add") return js::B(st.follow().add(args.items[0]));
    if (name == u"follow.has") return js::B(st.follow().has(s(args, 0)));
    if (name == u"follow.addQuote") return js::B(st.follow().addQuote(s(args, 0), s(args, 1), args.items[2]));
    if (name == u"follow.verdictsFor") return mapOf(st.follow().verdictsFor(strList(args.items[0])));
    if (name == u"follow.sentSince") return js::N(st.follow().sentSince(s(args, 0)));
    if (name == u"follow.recent") return list(has(args, 0) ? st.follow().recent(n(args, 0)) : st.follow().recent());
    if (name == u"messages.add") return js::B(st.messages().add(args.items[0]));
    if (name == u"messages.has") return js::B(st.messages().has(s(args, 0)));
    if (name == u"messages.recent") return list(st.messages().recent(args.items[0]));
    if (name == u"messages.count") return js::N(st.messages().count());
    if (name == u"messages.countSince") return js::N(st.messages().countSince(s(args, 0), optStr(args, 1)));
    if (name == u"imports.rememberOptionTrades") return js::N(st.imports().rememberOptionTrades(args.items[0].items));
    if (name == u"imports.listOptionTrades") return list(st.imports().listOptionTrades());
    if (name == u"imports.rememberOptionPositions") return js::N(st.imports().rememberOptionPositions(args.items[0].items));
    if (name == u"imports.listOptionPositions") return list(st.imports().listOptionPositions());
    if (name == u"imports.rememberEntryUnderlying") return st.imports().rememberEntryUnderlying(s(args, 0), s(args, 1), s(args, 2), n(args, 3), s(args, 4)), js::Null();
    if (name == u"imports.entryUnderlyings") {
        QList<std::pair<QString, OJson>> m;
        for (const auto& [k, v] : st.imports().entryUnderlyings(strList(args.items[0]))) m.append({k, js::N(v)});
        return mapOf(m);
    }
    if (name == u"vectors.put") {
        QVector<double> v;
        for (const OJson& x : args.items[3].items) v << x.n;
        return st.vectors().put(s(args, 0), s(args, 1), s(args, 2), v), js::Null();
    }
    if (name == u"vectors.get") {
        QList<std::pair<QString, QString>> ideas;
        for (const OJson& p : args.items[1].items) ideas.append({p.items[0].s, p.items[1].s});
        QList<std::pair<QString, OJson>> m;
        for (const auto& [k, vec] : st.vectors().get(s(args, 0), ideas)) {
            QList<OJson> xs;
            for (float x : vec) xs << js::N(double(x));
            m.append({k, js::object({{u"__f32"_s, js::array(xs)}})});
        }
        return mapOf(m);
    }
    if (name == u"vectors.count") return js::N(st.vectors().count(s(args, 0)));
    if (name == u"exportAll") return st.exportAll();
    if (name == u"backupNow") return st.backupNow(s(args, 0));
    if (name == u"listBackups") return list(listBackups(st.dbPath));
    if (name == u"purgeEverything") return st.purgeEverything(s(args, 0)), js::Null();
    throw std::logic_error(("未知操作 " + name.toStdString()).c_str());
}

OJson errOf(const util::JsError& e) {
    const auto* c = dynamic_cast<const util::CodedError*>(&e);
    const auto* so = dynamic_cast<const StoreOpenError*>(&e);
    return js::object({{u"error"_s, js::S(e.message())}, {u"code"_s, c ? js::S(c->code()) : js::Null()}, {u"kind"_s, so ? js::S(so->kind) : js::Null()}});
}

}  // namespace

class TestStore : public QObject {
    Q_OBJECT
    OJson fx;
    QTemporaryDir work;
    const OJson& at(const char16_t* key) const { return *fx.get(QString::fromUtf16(key)); }

private slots:
    void initTestCase() {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR) + u"/store.json"_s);
        QVERIFY(f.open(QIODevice::ReadOnly));
        fx = *util::parseOJson(QString::fromUtf8(f.readAll()));
        util::setDateNowForTests([] { return g_now; });
        util::setRandomUUIDForTests([] { return uuidOf(++g_uuid); });
    }
    void cleanupTestCase() {
        util::setDateNowForTests({});
        util::setRandomUUIDForTests({});
    }

    // better-sqlite3 本身的行为:run 的 changes(这一步真改了才算)、lastInsertRowid、DEFENSIVE、嵌套事务、绑定与 prepare 的错
    void sqliteProbe() {
        const QString path = work.path() + u"/probe/p.db"_s;
        QVERIFY(QDir().mkpath(work.path() + u"/probe"_s));
        util::sqlite::Database db(path);
        const QList<OJson>& ops = at(u"probeOps").items;
        const QList<OJson>& want = at(u"probe").items;
        QCOMPARE(ops.size(), want.size());
        for (qsizetype i = 0; i < ops.size(); ++i) {
            const OJson& op = ops[i];
            const QString m = op.items[0].s;
            const QString sql = op.items.size() > 1 ? op.items[1].s : QString();
            util::sqlite::Binds args;
            if (op.items.size() > 2)
                for (const OJson& x : op.items[2].items) args << (x.type == OJson::Bool ? Bind::boolean() : Bind::from(x));
            OJson got;
            try {
                OJson r = js::Null();
                if (m == u"exec") db.exec(sql);
                else if (m == u"pragma") r = list(db.pragma(sql));
                else if (m == u"pragmaSimple") r = opt(db.pragmaSimple(sql));
                else if (m == u"inTransaction") r = js::B(db.inTransaction());
                else if (m == u"txNested") {
                    auto ins = db.prepare(u"INSERT INTO p (v) VALUES (?)"_s);
                    db.transaction([&] {
                        ins.run({100});
                        try {
                            db.transaction([&] {
                                ins.run({200});
                                throw util::JsError(u"里面那层失败"_s);
                            });
                        } catch (const util::JsError& e) {
                            ins.run({e.message()});
                        }
                        ins.run({300});
                    });
                    try {
                        db.transaction([&] {
                            ins.run({400});
                            throw util::JsError(u"外层失败"_s);
                        });
                    } catch (const util::JsError& e) {
                        r = js::S(e.message());
                    }
                } else if (m == u"run") {
                    const auto res = db.prepare(sql).run(args);
                    r = js::object({{u"changes"_s, js::N(res.changes)}, {u"lastInsertRowid"_s, js::N(res.lastInsertRowid)}});
                } else if (m == u"get") r = opt(db.prepare(sql).get(args));
                else if (m == u"all") r = list(db.prepare(sql).all(args));
                got = js::object({{u"ok"_s, r}});
            } catch (const util::JsError& e) {
                got = errOf(e);
            }
            OJson w = want[i];
            w.remove(u"ename"_s);
            QCOMPARE(js::stringify(got), js::stringify(w));
        }
    }

    // 提交失败(另一个连接拿着读锁,COMMIT 拿不到写锁 → SQLITE_BUSY):照 better-sqlite3 回滚,事务不能一直开着
    void commitFailureRollsBack() {
        const QString path = work.path() + u"/busy/b.db"_s;
        QVERIFY(QDir().mkpath(work.path() + u"/busy"_s));
        util::sqlite::Database a(path, {false, false, 0});
        a.exec(u"CREATE TABLE t (v)"_s);
        util::sqlite::Database b(path, {false, false, 0});
        b.exec(u"BEGIN; SELECT * FROM t;"_s);  // 读事务:拿着 SHARED 锁
        QString code;
        try {
            a.transaction([&] { a.prepare(u"INSERT INTO t VALUES (1)"_s).run(); });
        } catch (const util::sqlite::SqliteError& e) {
            code = e.code();
        }
        QVERIFY2(code.startsWith(u"SQLITE_BUSY"_s), qPrintable(code));
        QVERIFY(!a.inTransaction());
        b.exec(u"ROLLBACK"_s);
        a.prepare(u"INSERT INTO t VALUES (2)"_s).run();
        util::sqlite::Database c(path);
        QCOMPARE(js::stringify(list(c.prepare(u"SELECT v FROM t"_s).all())), u"[{\"v\":2}]"_s);
    }

    // 新建的库是 0600(TS:fs.chmodSync(dbPath, 0o600));已有的库不动它的权限
    void freshDbIsPrivate() {
#if !defined(Q_OS_WIN)
        const QString p = work.path() + u"/perm/trades.db"_s;
        {
            TradeStore st(p);
        }
        QCOMPARE(QFile::permissions(p) & (QFileDevice::ReadGroup | QFileDevice::WriteGroup | QFileDevice::ReadOther | QFileDevice::WriteOther), QFileDevice::Permissions());
        QFile::setPermissions(p, QFileDevice::ReadOwner | QFileDevice::WriteOwner | QFileDevice::ReadGroup);
        {
            TradeStore st(p);
        }
        QVERIFY(QFile::permissions(p) & QFileDevice::ReadGroup);
#endif
    }

    void steps() {
        g_uuid = 0;
        const QString dbPath = work.path() + u"/main/data/trades.db"_s;
        TradeStore st(dbPath);
        QString lastDump;
        int i = 0, errors = 0;
        for (const OJson& step : at(u"steps").items) {
            const QString name = step.get(u"name"_s)->s;
            g_now = step.get(u"clock"_s)->n;
            OJson args = *step.get(u"args"_s);
            OJson got;
            try {
                got = js::object({{u"ret"_s, call(st, name, args)}});
                if (name == u"createRecord") got.set(u"mutated"_s, args.items[0]);
            } catch (const util::JsError& e) {
                got = errOf(e);
            }
            OJson want = js::object();
            if (const OJson* e = step.get(u"error"_s)) {
                ++errors;
                want = js::object({{u"error"_s, *e}, {u"code"_s, *step.get(u"code"_s)}, {u"kind"_s, *step.get(u"kind"_s)}});
            } else {
                want.set(u"ret"_s, *step.get(u"ret"_s));
                if (const OJson* m = step.get(u"mutated"_s)) want.set(u"mutated"_s, *m);
            }
            const QString g = js::stringify(got), w = js::stringify(want);
            if (g != w) qWarning().noquote() << "第" << i << "步" << name << js::stringify(*step.get(u"args"_s)).left(300) << "\nC++:" << g.left(3000) << "\nTS :" << w.left(3000);
            QCOMPARE(g, w);
            if (name != u"purgeEverything" || step.get(u"error"_s)) {
                const QString dump = js::stringify(dumpDb(dbPath));
                const OJson* wd = step.get(u"dump"_s);
                const QString wantDump = wd->type == OJson::Null ? lastDump : js::stringify(*wd);
                if (dump != wantDump) {
                    // 找第一处不同,打出附近
                    qsizetype k = 0;
                    while (k < dump.size() && k < wantDump.size() && dump[k] == wantDump[k]) ++k;
                    qWarning().noquote() << "第" << i << "步" << name << "之后的库不同,第" << k << "个字附近:\nC++:" << dump.mid(std::max<qsizetype>(0, k - 300), 600)
                                         << "\nTS :" << wantDump.mid(std::max<qsizetype>(0, k - 300), 600);
                }
                QCOMPARE(dump, wantDump);
                lastDump = wantDump;
            }
            ++i;
        }
        QCOMPARE(i, 261);
        QCOMPARE(errors, 38);
        st.close();
        // purgeEverything 的正路:三份文件都删掉
        const QString p = work.path() + u"/p/trades.db"_s;
        {
            TradeStore s2(p);
            s2.purgeEverything(u"DELETE ALL MY TRADING DATA"_s);
        }
        QList<OJson> exists;
        for (const QString& x : {QString(), u"-wal"_s, u"-shm"_s}) exists << js::B(QFileInfo::exists(p + x));
        QCOMPARE(js::stringify(js::array(exists)), js::stringify(at(u"purgeCheck")));
    }

    void migration() {
        const QString path = work.path() + u"/mig/trades.db"_s;
        QVERIFY(QDir().mkpath(work.path() + u"/mig"_s));
        {
            util::sqlite::Database db(path);
            db.exec(at(u"oldSql").s);
        }
        g_now = at(u"t0").n + 30 * 60000;
        g_uuid = 1000;
        TradeStore st(path);
        const OJson& want = at(u"migration");
        QCOMPARE(js::stringify(list(st.listTracks())), js::stringify(*want.get(u"tracks"_s)));
        QCOMPARE(js::stringify(list(st.listWatches())), js::stringify(*want.get(u"watches"_s)));
        QCOMPARE(js::stringify(list(st.listIdeas())), js::stringify(*want.get(u"ideas"_s)));
        QCOMPARE(js::stringify(list(st.searchIdeas(js::object({{u"terms"_s, js::strings({u"蝴蝶 中"_s})}})))), js::stringify(*want.get(u"search"_s)));
        QCOMPARE(js::stringify(list(st.signalLog().list())), js::stringify(*want.get(u"signals"_s)));
        st.close();
        QCOMPARE(js::stringify(dumpDb(path)), js::stringify(*want.get(u"dump"_s)));
    }

    void safety() {
        const QString sDir = work.path() + u"/safe"_s;
        QVERIFY(QDir().mkpath(sDir));
        const QString sPath = sDir + u"/db/trades.db"_s;
        QList<OJson> got;
        const auto record = [&](const QString& label, const std::function<OJson()>& fn) {
            try {
                got << js::object({{u"label"_s, js::S(label)}, {u"ok"_s, fn()}});
            } catch (const util::JsError& e) {
                OJson r = errOf(e);
                r.set(u"error"_s, js::S(QString(e.message()).replace(sDir, u"<S>"_s)));
                OJson o = js::object({{u"label"_s, js::S(label)}});
                for (const auto& [k, v] : r.fields) o.set(k, v);
                got << o;
            }
        };
        const auto names = [&] { return list(listBackups(sPath)); };
        resetIntegrityCache();
        g_now = 1792371600000;  // Date.UTC(2026, 9, 19, 1, 0, 0)
        record(u"fresh"_s, [&] {
            TradeStore s(sPath, true);
            s.close();
            return js::object({{u"v"_s, *dumpDb(sPath).get(u"user_version"_s)}, {u"backups"_s, names()}});
        });
        g_now += 3600 * 1000;
        record(u"reopen-daily"_s, [&] {
            TradeStore s(sPath, true);
            s.close();
            return names();
        });
        g_now += 3600 * 1000;
        record(u"within-20h"_s, [&] {
            TradeStore s(sPath, true);
            s.close();
            return names();
        });
        g_now += 21 * 3600 * 1000;
        record(u"after-20h"_s, [&] {
            TradeStore s(sPath, true);
            s.close();
            return names();
        });
        record(u"same-second-twice"_s, [&] {
            TradeStore s(sPath);
            const OJson x = s.backupNow(u"manual"_s), y = s.backupNow(u"manual"_s);
            s.close();
            return js::array({x, y});
        });
        record(u"manual-keep-5"_s, [&] {
            TradeStore s(sPath);
            for (int i = 0; i < 5; ++i) {
                g_now += 1000;
                s.backupNow(u"manual"_s);
            }
            s.close();
            QList<OJson> m;
            for (const OJson& b : listBackups(sPath))
                if (b.get(u"reason"_s)->s == u"manual") m << b;
            return list(m);
        });
        for (int i = 0; i < 9; ++i) {
            QFile f(sDir + u"/db/backups/trades-202601%1-000000-daily.db"_s.arg(10 + i));
            QVERIFY(f.open(QIODevice::WriteOnly));
            f.write(QByteArray(i, 'x'));
        }
        for (const auto& [file, text] : {std::pair{u"trades-20260101-000000-weekly.db"_s, QByteArray("nope")}, std::pair{u"trades-20260110-000000-daily-3.db"_s, QByteArray("z")}}) {
            QFile f(sDir + u"/db/backups/"_s + file);
            QVERIFY(f.open(QIODevice::WriteOnly));
            f.write(text);
        }
        record(u"list-before-prune"_s, names);
        record(u"prune"_s, [&] { return js::strings(pruneBackups(sPath)); });
        record(u"list-after-prune"_s, names);
        record(u"newer"_s, [&] {
            {
                util::sqlite::Database db(sPath);
                db.pragma(u"user_version = 2"_s);
            }
            TradeStore s(sPath, true);
            return js::Null();
        });
        record(u"older"_s, [&] {
            {
                util::sqlite::Database db(sPath);
                db.pragma(u"user_version = 0"_s);
            }
            resetIntegrityCache();
            TradeStore s(sPath, true);
            s.close();
            QList<OJson> up;
            for (const OJson& b : listBackups(sPath))
                if (b.get(u"reason"_s)->s == u"upgrade") up << b;
            return js::object({{u"backups"_s, list(up)}, {u"v"_s, *dumpDb(sPath).get(u"user_version"_s)}});
        });
        const QString cPath = sDir + u"/corrupt/trades.db"_s;
        QVERIFY(QDir().mkpath(sDir + u"/corrupt"_s));
        {
            QFile f(cPath);
            QVERIFY(f.open(QIODevice::WriteOnly));
            f.write(QByteArray("this is definitely not a sqlite database file, just text, repeated ").repeated(200));
        }
        record(u"corrupt-header"_s, [&] { TradeStore s(cPath, true); return js::Null(); });
        record(u"corrupt-no-safety"_s, [&] { TradeStore s(cPath); return js::Null(); });
        const QString qPath = sDir + u"/qc/trades.db"_s;
        QVERIFY(QDir().mkpath(sDir + u"/qc"_s));
        {
            util::sqlite::Database db(qPath);
            db.exec(u"CREATE TABLE t (a TEXT); CREATE INDEX t_a ON t(a);"_s);
            auto ins = db.prepare(u"INSERT INTO t VALUES (?)"_s);
            for (int i = 0; i < 2000; ++i) ins.run({u"row-%1-%2"_s.arg(i).arg(QString(40, u'p'))});
        }
        {
            QFile f(qPath);
            QVERIFY(f.open(QIODevice::ReadWrite));
            QByteArray bytes = f.readAll();
            for (int k = 4096 * 3 + 100; k < 4096 * 3 + 400; ++k) bytes[k] = 0x41;
            f.seek(0);
            f.write(bytes);
        }
        resetIntegrityCache();
        record(u"quick-check"_s, [&] { TradeStore s(qPath, true); return js::Null(); });
        const QString roDir = sDir + u"/ro"_s;
        QVERIFY(QDir().mkpath(roDir));
        QFile::setPermissions(roDir, QFileDevice::ReadOwner | QFileDevice::ExeOwner);
        record(u"unwritable"_s, [&] { TradeStore s(roDir + u"/trades.db"_s, true); return js::Null(); });
        record(u"unwritable-mkdir"_s, [&] { TradeStore s(roDir + u"/sub/trades.db"_s, true); return js::Null(); });
        QFile::setPermissions(roDir, QFileDevice::ReadOwner | QFileDevice::WriteOwner | QFileDevice::ExeOwner);
        const QString lPath = sDir + u"/locked/trades.db"_s;
        QVERIFY(QDir().mkpath(sDir + u"/locked"_s));
        {
            util::sqlite::Database holder(lPath);
            holder.exec(u"CREATE TABLE x (a); BEGIN EXCLUSIVE; INSERT INTO x VALUES (1);"_s);
            record(u"locked"_s, [&] { TradeStore s(lPath, true); return js::Null(); });
            holder.exec(u"ROLLBACK"_s);
        }
        const QList<OJson>& want = at(u"safe").items;
        QCOMPARE(got.size(), want.size());
        for (qsizetype i = 0; i < want.size(); ++i) {
            OJson w = want[i];
            w.remove(u"ename"_s);  // JS 的错误类名(SqliteError / Error…),这边没有
            const QString g = js::stringify(got[i]), ws = js::stringify(w);
            if (g != ws) qWarning().noquote() << "C++:" << g.left(2000) << "\nTS :" << ws.left(2000);
            QCOMPARE(g, ws);
        }
    }
};

QTEST_GUILESS_MAIN(TestStore)
#include "tst_store.moc"
