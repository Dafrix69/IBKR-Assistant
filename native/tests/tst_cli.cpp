// 命令行入口(transport/cli,engine-ts 的 cli.ts main(argv))对着 TS 现跑的输出(tools/gen_cli.mjs → fixtures/cli.json):
// 每个场景一个新的临时目录,同一份配置与输入文件,逐行比 console.log / console.error、返回码(或 process.exit 的码)、抛出的话、
// 落到磁盘上的 breaker.json / 导出文件 / 交易库导出。uuid 与临时目录在两边用夹具里同一组正则换成占位串。
// 另测几件夹具里没有的:set-key 走注入的凭证库(真的钥匙串不碰)、parse / run 没搬时的说明、startupChecks。
#include "js_fixture.h"
#include "domain/config.h"
#include "domain/store.h"
#include "domain/store_safety.h"
#include "parsing/providers.h"
#include "transport/cli.h"
#include "transport/rpc_server.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/sqlite.h"

#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QRegularExpression>
#include <QTemporaryDir>
#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;
using util::OJson;
namespace js = util::js;

namespace {

QString normalize(QString text, const QString& dir, const OJson& norm) {
    text.replace(dir, u"<DIR>"_s);
    for (const OJson& pair : norm.items) {
        const QRegularExpression re(pair.items[0].s);
        if (!re.isValid()) qFatal("正则不合法:%s", qPrintable(pair.items[0].s));
        text.replace(re, pair.items[1].s);
    }
    return text;
}

void writeFile(const QString& path, const QString& text) {
    QFile f(path);
    if (!f.open(QIODevice::WriteOnly)) qFatal("写不了 %s", qPrintable(path));
    f.write(util::toNodeUtf8(text));
}

QString readFile(const QString& path, bool* ok) {
    QFile f(path);
    *ok = f.open(QIODevice::ReadOnly);
    return *ok ? util::nodeUtf8(f.readAll()) : QString();
}

QString replaced(QString s, const QString& dir) { return s.replace(u"{DIR}"_s, dir); }

/// 夹具里的配置模板 + 提示词目录(TS 默认找仓库里的 prompts/,C++ 的默认是相对可执行文件的,测试里写明)
QString configText(const OJson& templ, const QString& dir) {
    OJson cfg = templ;
    if (!cfg.get(u"prompt_dir"_s)) cfg.set(u"prompt_dir"_s, js::S(QStringLiteral(IBKR_PROMPTS_DIR)));
    return replaced(js::stringify(cfg), dir);
}

QString afterColon(const QString& s) {
    const qsizetype colon = s.indexOf(u": "_s);
    return colon < 0 ? s : s.mid(colon + 2);
}

struct Run {
    QStringList log, err;
    std::optional<int> code;
    QList<int> codes;
    QString threw;
};

}  // namespace

class TestCli : public QObject {
    Q_OBJECT
private slots:
    void initTestCase() { parsing::providers::setSchemaAssetDir(QDir::cleanPath(QStringLiteral(IBKR_CONTRACT_DIR "/../baseline/llm"))); }
    void cleanup() { domain::setClock(std::nullopt); }

    void scenariosMatchTs() {
        const OJson fx = jsfix::load(u"cli.json"_s);
        const OJson& norm = *fx.get(u"norm"_s);
        int checked = 0;
        for (const OJson& sc : fx.get(u"scenarios"_s)->items) {
            const OJson& spec = *sc.get(u"spec"_s);
            const OJson& want = *sc.get(u"res"_s);
            const QString name = spec.get(u"name"_s)->s;
            QTemporaryDir tmp;
            QVERIFY(tmp.isValid());
            const QString dir = QDir(tmp.path()).canonicalPath();
            const QString settingsPath = dir + u"/settings.json"_s;
            if (const OJson* raw = spec.get(u"rawConfig"_s); raw && raw->type == OJson::String) writeFile(settingsPath, raw->s);
            else if (!spec.get(u"noConfig"_s)->b) writeFile(settingsPath, configText(*spec.get(u"configTemplate"_s), dir));
            for (const auto& [fname, text] : fx.get(u"files"_s)->fields) writeFile(dir + u'/' + fname, text.s);
            for (const auto& [fname, text] : spec.get(u"files"_s)->fields) writeFile(dir + u'/' + fname, text.s);
            if (spec.get(u"newerDb"_s)->b) {
                util::sqlite::Database db(dir + u"/t.db"_s);
                db.exec(u"PRAGMA user_version = 999"_s);
            }
            if (spec.get(u"dbIsDir"_s)->b) QVERIFY(QDir().mkdir(dir + u"/t.db"_s));
            if (spec.get(u"subdir"_s)->b) QVERIFY(QDir().mkdir(dir + u"/sub"_s));
            if (const OJson* ch = spec.get(u"chmod"_s); ch && ch->type == OJson::Array) QVERIFY(QFile::setPermissions(dir + u'/' + ch->items[0].s, QFileDevice::Permissions()));
            const QString oldCwd = QDir::currentPath();
            if (spec.get(u"cwd"_s)->b) QVERIFY(QDir::setCurrent(dir));
            domain::setClock(jsfix::num(fx.get(u"clocks"_s)->get(spec.get(u"clock"_s)->s)));
            const QString dbPath = dir + u"/t.db"_s;
            if (!spec.get(u"steps"_s)->items.isEmpty()) {
                domain::TradeStore store(dbPath);
                for (const OJson& step : spec.get(u"steps"_s)->items) {
                    if (const OJson* r = step.get(u"createRecord"_s)) {
                        OJson record = *r;
                        store.createRecord(record);
                    } else if (const OJson* e = step.get(u"appendEvent"_s)) {
                        store.appendEvent(e->items[0].s, e->items[1].s, e->items[2]);
                    } else if (const OJson* f = step.get(u"setFinalStatus"_s)) {
                        store.setFinalStatus(f->items[0].s, f->items[1].s);
                    } else if (const OJson* i = step.get(u"addIdea"_s)) {
                        QStringList symbols;
                        for (const OJson& s : i->items[1].items) symbols << s.s;
                        const OJson idea = store.addIdea(i->items[0].s, symbols);
                        if (const OJson* st = step.get(u"status"_s)) store.setIdeaStatus(idea.get(u"id"_s)->s, st->s);
                    } else {
                        QFAIL(qPrintable(name + u": 没有这种步骤"_s));
                    }
                }
            }
            // 要跑的几次 main(argv):argvs 有就用它,没有就是 argv 一次
            QList<QStringList> runs;
            if (const OJson* argvs = spec.get(u"argvs"_s); argvs && argvs->type == OJson::Array) {
                for (const OJson& a : argvs->items) {
                    QStringList argv;
                    for (const OJson& x : a.items) argv << replaced(x.s, dir);
                    runs << argv;
                }
            } else {
                QStringList argv;
                for (const OJson& x : spec.get(u"argv"_s)->items) argv << replaced(x.s, dir);
                runs << argv;
            }
            Run got;
            cli::Io io{[&](const QString& l) { got.log << l; }, [&](const QString& l) { got.err << l; }};
            const bool multi = runs.size() > 1;
            try {
                for (qsizetype i = 0; i < runs.size(); ++i) {
                    if (multi) got.log << u"--- run %1 ---"_s.arg(i + 1);
                    QStringList argv = runs[i];
                    if (!argv.contains(u"--config"_s) && !spec.get(u"noConfigFlag"_s)->b) argv << u"--config"_s << settingsPath;
                    got.code = cli::main(argv, io, [](const std::optional<QString>& path) {
                        cli::startupChecks(path);  // 抛的才是这一支的结果;没抛说明库与配置都好好的,TS 会去起服务
                        return 99;
                    });
                    got.codes << *got.code;
                }
            } catch (const util::JsError& e) {
                got.threw = e.message();
                got.code.reset();
            }
            QDir::setCurrent(oldCwd);
            if (const OJson* ch = spec.get(u"chmod"_s); ch && ch->type == OJson::Array) QFile::setPermissions(dir + u'/' + ch->items[0].s, QFileDevice::ReadOwner | QFileDevice::WriteOwner);
            // 返回码(process.exit 的码也是返回码)
            const OJson* wantCode = want.get(u"code"_s);
            const OJson* wantExit = want.get(u"exit"_s);
            if (want.get(u"threw"_s)) {
                QVERIFY2(!got.code && !got.threw.isEmpty(), qPrintable(name + u": TS 抛了「%1」,C++ 没抛(返回码 %2)"_s.arg(want.get(u"threw"_s)->s).arg(got.code.value_or(-1))));
                QCOMPARE_EQ(normalize(got.threw, dir, norm), afterColon(want.get(u"threw"_s)->s));
            } else {
                QVERIFY2(got.code.has_value(), qPrintable(name + u": C++ 抛了「%1」"_s.arg(got.threw)));
                QCOMPARE_EQ(*got.code, int(wantExit ? wantExit->n : wantCode->n));
                if (const OJson* codes = want.get(u"codes"_s)) {  // 多次 main:每一次的返回码
                    QList<int> wantCodes;
                    for (const OJson& c : codes->items) wantCodes << int(c.n);
                    QCOMPARE_EQ(got.codes, wantCodes);
                }
            }
            QStringList wantLog, wantErr;
            for (const OJson& l : want.get(u"log"_s)->items) wantLog << l.s;
            for (const OJson& l : want.get(u"err"_s)->items) wantErr << l.s;
            QStringList gotLog, gotErr;
            for (const QString& l : got.log) gotLog << normalize(l, dir, norm);
            for (const QString& l : got.err) gotErr << normalize(l, dir, norm);
            if (gotLog != wantLog) QFAIL(qPrintable(name + u": console.log 不同\n  TS :%1\n  C++:%2"_s.arg(wantLog.join(u" ⏎ "_s).left(1500), gotLog.join(u" ⏎ "_s).left(1500))));
            if (gotErr != wantErr) QFAIL(qPrintable(name + u": console.error 不同\n  TS :%1\n  C++:%2"_s.arg(wantErr.join(u" ⏎ "_s).left(800), gotErr.join(u" ⏎ "_s).left(800))));
            for (const auto& [fname, content] : want.get(u"files"_s)->fields) {
                bool ok = false;
                const QString text = readFile(dir + u'/' + fname, &ok);
                const QString gotText = ok ? normalize(text, dir, norm) : u"ENOENT"_s;
                if (gotText != content.s) QFAIL(qPrintable(name + u": 文件 %1 不同\n  TS :%2\n  C++:%3"_s.arg(fname, content.s.left(600), gotText.left(600))));
            }
            if (const OJson* db = want.get(u"db"_s)) {
                const QString dbText = normalize(util::stringifyOJson(domain::TradeStore(dbPath).exportAll(), 2), dir, norm);
                if (dbText != db->s) QFAIL(qPrintable(name + u": 库的导出不同\n  TS :%1\n  C++:%2"_s.arg(db->s.left(900), dbText.left(900))));
            }
            // 目录里多出来的文件(WAL 的 -shm / -wal 是 TS 那边没关库留下的,不比)
            QStringList gotFiles = QDir(dir).entryList(QDir::Files | QDir::Dirs | QDir::NoDotAndDotDot, QDir::Name);
            QStringList known{u"settings.json"_s};
            for (const auto& [fname, text] : fx.get(u"files"_s)->fields) known << fname;
            for (const auto& [fname, text] : spec.get(u"files"_s)->fields) known << fname;
            QStringList extra;
            for (const QString& f : gotFiles)
                if (!known.contains(f) && f != u"t.db-shm" && f != u"t.db-wal") extra << f;
            QStringList wantExtra;
            for (const OJson& f : want.get(u"dirFiles"_s)->items)
                if (f.s != u"t.db-shm" && f.s != u"t.db-wal") wantExtra << f.s;
            extra.sort();
            if (extra != wantExtra) QFAIL(qPrintable(name + u": 目录里的文件不同\n  TS :%1\n  C++:%2"_s.arg(wantExtra.join(u","_s), extra.join(u","_s))));
            ++checked;
        }
        QVERIFY(checked > 70);
    }

    /// set-key 走注入的凭证库;没给密钥时的说明
    void setKeyUsesTheInjectedSecretStore() {
        QTemporaryDir tmp;
        const QString settingsPath = tmp.filePath(u"settings.json"_s);
        const OJson fx = jsfix::load(u"cli.json"_s);
        writeFile(settingsPath, configText(*fx.get(u"scenarios"_s)->items[0].get(u"spec"_s)->get(u"configTemplate"_s), tmp.path()));
        QStringList log, err;
        QList<QStringList> calls;
        cli::Io io{[&](const QString& l) { log << l; }, [&](const QString& l) { err << l; }};
        cli::Hooks hooks;
        hooks.setSecret = [&](const QString& service, const QString& account, const QString& secret) { calls.append({service, account, secret}); };
        const auto rpc = [](const std::optional<QString>&) { return 0; };
        QCOMPARE(cli::main({u"set-key"_s, u"sk-test-123"_s, u"--config"_s, settingsPath}, io, rpc, hooks), 0);
        QCOMPARE(calls.size(), 1);
        const domain::Settings settings = domain::loadSettings(settingsPath);
        QCOMPARE(calls[0], (QStringList{settings.llm.keychain_service, settings.llm.keychain_account, u"sk-test-123"_s}));
        QCOMPARE(log, (QStringList{u"已写入 Keychain(service=%1)"_s.arg(settings.llm.keychain_service)}));
        QVERIFY(err.isEmpty());
    }

    /// run 没带确认开关:拒绝(parse 要调大模型,离线测试不跑)
    void runRefusesWithoutConfirmation() {
        QTemporaryDir tmp;
        const QString settingsPath = tmp.filePath(u"settings.json"_s);
        const OJson fx = jsfix::load(u"cli.json"_s);
        writeFile(settingsPath, configText(*fx.get(u"scenarios"_s)->items[0].get(u"spec"_s)->get(u"configTemplate"_s), tmp.path()));
        const auto rpc = [](const std::optional<QString>&) { return 0; };
        // run 没带确认开关:拒绝、退出码 1(不碰引擎、不碰券商)。parse 要调大模型,离线测试不跑
        QStringList err;
        cli::Io io{[](const QString&) {}, [&](const QString& l) { err << l; }};
        QCOMPARE(cli::main({u"run"_s, u"买入 AAPL"_s, u"--config"_s, settingsPath}, io, rpc), 1);
        QCOMPARE(err.size(), 1);
        QCOMPARE(err[0], u"拒绝执行:缺少 --i-understand-this-places-real-orders 开关。"_s);
    }

    static QString configAuto(bool autoExecute, const QString& dir) {
        const OJson fx = jsfix::load(u"cli.json"_s);
        OJson templ = *fx.get(u"scenarios"_s)->items[0].get(u"spec"_s)->get(u"configTemplate"_s);
        templ.get(u"policies"_s)->set(u"auto_execute"_s, js::B(autoExecute));
        return configText(templ, dir);
    }

    /// run 的两道闸(钱路径):先看确认开关,再看 policies.auto_execute;两道都过才会碰引擎与券商(这里过不了,所以离线)。话一字不差
    void runGatesRefuseBeforeTouchingTheBroker() {
        QTemporaryDir tmp;
        const QString settingsPath = tmp.filePath(u"settings.json"_s);
        const auto rpc = [](const std::optional<QString>&) { return 0; };
        const auto go = [&](bool autoExecute, QStringList args, QStringList* err) {
            writeFile(settingsPath, configAuto(autoExecute, tmp.path()));
            err->clear();
            cli::Io io{[](const QString&) {}, [err](const QString& l) { *err << l; }};
            return cli::main(args + QStringList{u"--config"_s, settingsPath}, io, rpc);
        };
        QStringList err;
        // 没带确认开关:不管 auto_execute 开没开,先说开关的事(两种配置都一样)
        for (const bool on : {false, true}) {
            QCOMPARE(go(on, {u"run"_s, u"买入 AAPL"_s}, &err), 1);
            QCOMPARE(err, (QStringList{u"拒绝执行:缺少 --i-understand-this-places-real-orders 开关。"_s}));
        }
        // 带了开关、配置里 auto_execute=false:拒绝
        QCOMPARE(go(false, {u"run"_s, u"买入 AAPL"_s, u"--i-understand-this-places-real-orders"_s}, &err), 1);
        QCOMPARE(err, (QStringList{u"拒绝执行:配置里 policies.auto_execute=false。"_s}));
    }

    /// parse 永不下单:配置里 auto_execute=true 也只解析、只校验(validated_only),不发、不记券商错
    void parseNeverSubmitsEvenWhenAutoExecuteIsOn() {
        class Fake final : public orchestrate::EngineParser {
        public:
            util::Task<parsing::providers::LLMResponse> parse(parsing::prompts::PromptBundle bundle, QString) override {
                parsing::providers::LLMResponse r;
                r.text = QStringLiteral(
                    R"({"orders":[{"intent_summary":"限价 230 买入 100 股 AAPL","contract":{"secType":"STK","symbol":"AAPL","exchange":"SMART","currency":"USD"},"execution_type":"IMMEDIATE","trigger":null,"account":"DEFAULT","order":{"action":"BUY","orderType":"LMT","totalQuantity":100,"price_mode":"EXPLICIT","lmtPrice":230.0,"tif":"DAY","outsideRth":false},"reason":"x","confidence":0.99,"warnings":[]}],"rejections":[]})");
                r.model = js::S(u"fake"_s);
                r.prompt_version = bundle.version;
                r.prompt_fingerprint = parsing::prompts::fingerprint(bundle);
                co_return r;
            }
        };
        QTemporaryDir tmp;
        const QString settingsPath = tmp.filePath(u"settings.json"_s);
        writeFile(settingsPath, configAuto(true, tmp.path()));
        domain::setClock(double(QDateTime::fromString(u"2026-09-11T16:00:00Z"_s, Qt::ISODate).toMSecsSinceEpoch()));
        QStringList log;
        cli::Io io{[&](const QString& l) { log << l; }, [](const QString&) {}};
        cli::Hooks hooks;
        hooks.parser = [](const domain::Settings&) { return std::make_shared<Fake>(); };
        const int code = cli::main({u"parse"_s, u"买入 AAPL 100股 limit 230"_s, u"--config"_s, settingsPath}, io, [](const std::optional<QString>&) { return 0; }, hooks);
        domain::setClock(std::nullopt);
        QCOMPARE(code, 0);
        const auto result = util::parseOJson(log.join(u"\n"_s));
        QVERIFY(result);
        QCOMPARE(js::prop(&*result, u"submitted"_s)->items.size(), 0);
        QCOMPARE(js::prop(&*result, u"queued"_s)->items.size(), 0);
        QCOMPARE(js::prop(&*result, u"rejections"_s)->items.size(), 0);
        QCOMPARE(js::prop(&*result, u"validated_only"_s)->items.size(), 1);
    }

    /// 少给必需参数、rpc 那一支的错误映射(消息里的换行折成空格)、runMain 接住别的异常
    void argumentAndFatalLineEdgeCases() {
        QTemporaryDir tmp;
        const QString settingsPath = tmp.filePath(u"settings.json"_s);
        const OJson fx = jsfix::load(u"cli.json"_s);
        writeFile(settingsPath, configText(*fx.get(u"scenarios"_s)->items[0].get(u"spec"_s)->get(u"configTemplate"_s), tmp.path()));
        const auto quiet = cli::Io{[](const QString&) {}, [](const QString&) {}};
        const auto noRpc = [](const std::optional<QString>&) { return 0; };
        for (const QString& command : {u"idea"_s, u"set-key"_s, u"validate"_s, u"export"_s}) {
            try {
                cli::main({command, u"--config"_s, settingsPath}, quiet, noRpc);
                QFAIL(qPrintable(command + u" 该抛"_s));
            } catch (const util::JsError& e) {
                QVERIFY2(!e.message().isEmpty(), qPrintable(command));
                if (command == u"idea") QCOMPARE(e.message(), u"cli idea 缺少想法文字(TS 在 args[0]! 上抛 TypeError)"_s);
                if (command == u"set-key") QCOMPARE(e.message(), u"cli set-key 缺少密钥(TS 在 args[0]! 上把 undefined 交给凭证库)"_s);
                if (command == u"validate" || command == u"export")
                    QCOMPARE(e.message(), u"The \"path\" argument must be of type string or an instance of Buffer or URL. Received undefined"_s);
            }
        }
        QStringList err;
        const cli::Io io{[](const QString&) {}, [&err](const QString& l) { err << l; }};
        QCOMPARE(cli::main({u"rpc"_s}, io, [](const std::optional<QString>&) -> int {
                     throw domain::ConfigLoadError(u"invalid"_s, u"/p"_s, u"第一行\n   第二行 \t\n第三行"_s);
                 }), 78);
        QCOMPARE(err, (QStringList{u"[fatal:config:invalid] 第一行 第二行 第三行"_s}));
        err.clear();
        QCOMPARE(cli::main({u"rpc"_s}, io, [](const std::optional<QString>&) -> int {
                     throw domain::StoreOpenError(u"corrupt"_s, u"/db"_s, u"坏了\n请恢复"_s);
                 }), 74);
        QCOMPARE(err, (QStringList{u"[fatal:store:path] /db"_s, u"[fatal:store:corrupt] 坏了 请恢复"_s}));
        // rpc 入口自己返回的码原样给;--config 的值递给它;不带值的 --config 给空
        std::optional<QString> seen = u"unset"_s;
        QCOMPARE(cli::main({u"rpc"_s, u"--config"_s, u"/x.json"_s}, io, [&](const std::optional<QString>& p) { seen = p; return 7; }), 7);
        QCOMPARE(seen, std::optional<QString>(u"/x.json"_s));
        QCOMPARE(cli::main({u"--config"_s, u"/y.json"_s, u"rpc"_s}, io, [&](const std::optional<QString>& p) { seen = p; return 0; }), 0);
        QCOMPARE(seen, std::optional<QString>(u"/y.json"_s));
        QCOMPARE(cli::main({u"rpc"_s, u"--config"_s}, io, [&](const std::optional<QString>& p) { seen = p; return 0; }), 0);
        QVERIFY(!seen);
        // runMain:std::exception 与 JsError 都打成 Error: 话、退出码 1;ExitRequest 是它自己的码
        err.clear();
        QCOMPARE(cli::runMain({u"rpc"_s}, io, [](const std::optional<QString>&) -> int { throw std::runtime_error("kaput"); }), 1);
        QCOMPARE(err, (QStringList{u"Error: kaput"_s}));
        err.clear();
        QCOMPARE(cli::runMain({u"rpc"_s}, io, [](const std::optional<QString>&) -> int { throw cli::ExitRequest(5); }), 5);
        QVERIFY(err.isEmpty());
    }

    /// runMain 把抛出来的错打成 `Error: <话>` 退出码 1
    void runMainReportsThrownErrors() {
        QStringList err;
        cli::Io io{[](const QString&) {}, [&](const QString& l) { err << l; }};
        QCOMPARE(cli::runMain({u"selftest"_s, u"--config"_s, u"/nowhere/settings.json"_s}, io, [](const std::optional<QString>&) { return 0; }), 1);
        QCOMPARE(err.size(), 1);
        QVERIFY2(err[0].startsWith(u"Error: 找不到配置文件 /nowhere/settings.json"_s), qPrintable(err[0]));
    }

    /// 先读配置、再开库、最后才记「检查过了」:配置读不进来时库根本没碰;库打不开时(坏了的库)抛 StoreOpenError 且不算检查过
    void startupChecksOrderIsConfigThenStoreThenMark() {
        const OJson fx = jsfix::load(u"cli.json"_s);
        const OJson& templ = *fx.get(u"scenarios"_s)->items[0].get(u"spec"_s)->get(u"configTemplate"_s);
        // 1. 配置读不进来:库文件没被建出来,标记没打
        {
            QTemporaryDir tmp;
            writeFile(tmp.filePath(u"settings.json"_s), u"{\"limits\": "_s);
            ibkr::rpc::resetStartupCheckedForTest();
            try {
                cli::startupChecks(tmp.filePath(u"settings.json"_s));
                QFAIL("该抛");
            } catch (const domain::ConfigLoadError& e) {
                QCOMPARE(e.kind, u"syntax"_s);
            }
            QVERIFY(!ibkr::rpc::startupChecked());
            QVERIFY(!QFile::exists(tmp.filePath(u"t.db"_s)));
        }
        // 2. 库坏了 / 比软件新 / 路径是目录:StoreOpenError,标记没打
        for (const QString& breakage : {u"corrupt"_s, u"newer"_s, u"dir"_s}) {
            QTemporaryDir tmp;
            const QString dir = QDir(tmp.path()).canonicalPath();
            writeFile(dir + u"/settings.json"_s, configText(templ, dir));
            const QString db = dir + u"/t.db"_s;
            if (breakage == u"corrupt") writeFile(db, QString(u"这不是一个 sqlite 库\n").repeated(300));
            else if (breakage == u"newer") {
                util::sqlite::Database raw(db);
                raw.exec(u"PRAGMA user_version = 999"_s);
            } else QVERIFY(QDir().mkdir(db));
            ibkr::rpc::resetStartupCheckedForTest();
            try {
                cli::startupChecks(dir + u"/settings.json"_s);
                QFAIL(qPrintable(breakage + u" 该抛"_s));
            } catch (const domain::StoreOpenError& e) {
                QVERIFY2(!e.kind.isEmpty(), qPrintable(breakage));
            }
            QVERIFY2(!ibkr::rpc::startupChecked(), qPrintable(breakage));
        }
        // 3. 都好:库被开过(文件在)、标记打了
        {
            QTemporaryDir tmp;
            const QString dir = QDir(tmp.path()).canonicalPath();
            writeFile(dir + u"/settings.json"_s, configText(templ, dir));
            ibkr::rpc::resetStartupCheckedForTest();
            cli::startupChecks(dir + u"/settings.json"_s);
            QVERIFY(QFile::exists(dir + u"/t.db"_s));
            QVERIFY(ibkr::rpc::startupChecked());
        }
        ibkr::rpc::resetStartupCheckedForTest();
    }

    /// engine/main.cpp 的接线:先 requireStartupChecks(),之后才登记任何方法(源码断言:没有更干净的办法——main.cpp 是可执行文件的入口)
    void mainRequiresStartupChecksBeforeRegisteringMethods() {
        bool ok = false;
        const QString src = readFile(QStringLiteral(IBKR_MAIN_CPP), &ok);
        QVERIFY(ok);
        const qsizetype require = src.indexOf(u"server.requireStartupChecks();"_s);
        QVERIFY2(require > 0, "main.cpp 没有调 server.requireStartupChecks()");
        QCOMPARE(src.count(u"requireStartupChecks("_s), 1);
        // 之前不许出现任何登记
        const QString before = src.left(require);
        for (const QString& reg : {u"addSystemHandlers("_s, u"addOJson("_s, u"addAsync("_s, u"addContractMethod"_s, u".add("_s, u"installMethods("_s})
            QVERIFY2(!before.contains(reg), qPrintable(u"requireStartupChecks 之前就登记了:"_s + reg));
        QVERIFY2(src.indexOf(u"engine.install("_s, require) > require, "engine.install()(登记全部方法)应在 requireStartupChecks 之后");
        // main.cpp 自己不登记任何方法:全部经 EngineServer::install()(它走 installMethods)
        QCOMPARE(src.count(u"addOJson("_s) + src.count(u"addAsync("_s) + src.count(u"addContractMethod"_s) + src.count(u"installMethods("_s), 0);
    }

    /// server.ts main() 在 serve() 之前的两件事:读配置、开库(库比软件新 → StoreOpenError)
    void startupChecksOpenTheStore() {
        QTemporaryDir tmp;
        const QString settingsPath = tmp.filePath(u"settings.json"_s);
        const OJson fx = jsfix::load(u"cli.json"_s);
        writeFile(settingsPath, configText(*fx.get(u"scenarios"_s)->items[0].get(u"spec"_s)->get(u"configTemplate"_s), tmp.path()));
        ibkr::rpc::resetStartupCheckedForTest();
        QVERIFY(!ibkr::rpc::startupChecked());
        try {
            cli::startupChecks(tmp.filePath(u"nope2.json"_s));
        } catch (const domain::ConfigLoadError&) {
        }
        QVERIFY(!ibkr::rpc::startupChecked());  // 抛了就不算跑过
        const domain::Settings s = cli::startupChecks(settingsPath);
        QVERIFY(ibkr::rpc::startupChecked());
        QVERIFY(QFile::exists(s.db_path));
        try {
            cli::startupChecks(tmp.filePath(u"nope.json"_s));
            QFAIL("该抛");
        } catch (const domain::ConfigLoadError& e) {
            QCOMPARE(e.kind, u"missing"_s);
        }
    }
};

QTEST_GUILESS_MAIN(TestCli)
#include "tst_cli.moc"
