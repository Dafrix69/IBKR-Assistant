#include "transport/cli.h"
#include "transport/rpc_server.h"

#include "analysis/fills_csv.h"
#include "analysis/market.h"
#include "analysis/option_positions_csv.h"
#include "analysis/option_trades_csv.h"
#include "domain/models.h"
#include "execution/broker.h"
#include "orchestrate/engine.h"
#include "domain/store.h"
#include "domain/store_safety.h"
#include "parsing/prompts.h"
#include "parsing/providers.h"
#include "parsing/validator.h"
#include "util/error.h"
#include "util/jsformat.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/keychain.h"
#include "util/killswitch.h"
#include "util/notify.h"
#include "util/py.h"

#include <QDir>
#include <QEventLoop>
#include <QFile>
#include <QFileInfo>
#include <QRegularExpression>

#include <algorithm>
#include <cstdio>

namespace ibkr::cli {

using namespace Qt::StringLiterals;
using domain::Settings;
using util::JsError;
using util::OJson;
namespace js = util::js;

Io stdIo() {
    return Io{
        [](const QString& line) { std::fprintf(stdout, "%s\n", util::toNodeUtf8(line).constData()); std::fflush(stdout); },
        [](const QString& line) { std::fprintf(stderr, "%s\n", util::toNodeUtf8(line).constData()); },
    };
}

namespace {

// ---------------------------------------------------------------- 小工具(cli.ts 底部那几个 + Node 的 fs / path)
/// flagValue(args, flag):没有这个旗标或旗标后面没东西是空
std::optional<QString> flagValue(const QStringList& args, const QString& flag) {
    const qsizetype idx = args.indexOf(flag);
    if (idx < 0 || idx + 1 >= args.size()) return std::nullopt;
    return args[idx + 1];
}

QString pyBool(bool v) { return v ? u"True"_s : u"False"_s; }

/// partition(text, sep):[前, sep, 后];没有 sep 是 [text, "", ""]
std::array<QString, 3> partition(const QString& text, const QString& sep) {
    const qsizetype idx = text.indexOf(sep);
    if (idx < 0) return {text, QString(), QString()};
    return {text.left(idx), sep, text.mid(idx + sep.size())};
}

/// parseSnapshot:`SPX=7462.35,AAPL=230` → {代码: 价};写错了打一句并 process.exit(1)
OJson parseSnapshot(const QString& raw, const Io& io) {
    OJson snapshot = js::object();
    for (const QString& chunkRaw : raw.split(u',')) {
        const QString chunk = util::jsTrim(chunkRaw);
        if (chunk.isEmpty()) continue;
        const auto [symbol, sep, value] = partition(chunk, u"="_s);
        const double num = util::jsStringToNumber(value);
        if (std::isnan(num)) {
            io.error(u"行情快照格式应为 SPX=7462.35,AAPL=230,收到:'%1'"_s.arg(chunk));
            throw ExitRequest(1);
        }
        snapshot.set(util::jsTrim(symbol).toUpper(), js::N(num));
    }
    return snapshot;
}

/// fs.readFileSync(p, "utf-8")
QString readText(const QString& path) {
    QFileInfo info(path);
    if (!info.exists()) throw JsError(u"ENOENT: no such file or directory, open '%1'"_s.arg(path));
    if (info.isDir()) throw JsError(u"EISDIR: illegal operation on a directory, read"_s);
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly)) throw JsError(u"EACCES: permission denied, open '%1'"_s.arg(path));
    return util::nodeUtf8(f.readAll());
}

/// path.basename(p)
QString baseName(QString path) {
    while (path.size() > 1 && path.endsWith(u'/')) path.chop(1);
    const qsizetype slash = path.lastIndexOf(u'/');
    return slash < 0 ? path : path.mid(slash + 1);
}

/// path.join(path.dirname(dbPath), "breaker.json")
QString breakerPath(const QString& dbPath) {
    const QString dir = QFileInfo(dbPath).path();  // 没有目录部分时是 "."(同 path.dirname)
    return QDir::cleanPath(dir + u"/breaker.json"_s);
}

/// 一段 JSON.stringify(v, null, 2) 的输出
QString pretty(const OJson& v) { return util::stringifyOJson(v, 2); }

// ---------------------------------------------------------------- parse / run(要引擎;cli.ts 的 parseCmd / run / buildRouter)
/// 把一个 Task 跑到完成(命令行是同步的;引擎的协程要事件循环)。失败原样抛
template <class T>
T runBlocking(util::Task<T> task) {
    if (!task.done()) {
        QEventLoop loop;
        task.onDone([&loop] { loop.quit(); });
        if (!task.done()) loop.exec();
    }
    return task.result();
}

/// `--accounts 模拟,主账户`:目标账户别名,写两个就同时向两个账户发单
QStringList accountsArg(const std::optional<QString>& raw) {
    QStringList out;
    for (const QString& part : raw.value_or(QString()).split(u',')) {
        const QString a = part.trimmed();
        if (!a.isEmpty()) out << a;
    }
    return out;
}

int parseCmd(Settings settings, const QString& instruction, const OJson& snapshot, const QStringList& accounts, const Io& io, const Hooks& hooks) {
    // parse 子命令永不下单,不管配置怎么写
    settings.policies.auto_execute = false;
    orchestrate::EngineArgs a;
    a.settings = settings;
    a.parser = hooks.parser ? hooks.parser(settings) : orchestrate::adaptParser(parsing::providers::buildParser(settings.llm));
    a.notifier = std::make_shared<util::Notifier>(false);
    orchestrate::TradingEngine engine(std::move(a));
    const orchestrate::EngineResult result =
        runBlocking(engine.handleInstruction(instruction, u"manual"_s, std::nullopt, snapshot, accounts));
    io.log(pretty(result.toJson()));
    return result.rejections.isEmpty() ? 0 : 2;
}

int runCmd(const Settings& settings, const QString& instruction, bool confirmed, const QStringList& accounts, const Io& io) {
    if (!confirmed) {
        io.error(u"拒绝执行:缺少 --i-understand-this-places-real-orders 开关。"_s);
        return 1;
    }
    if (!settings.policies.auto_execute) {
        io.error(u"拒绝执行:配置里 policies.auto_execute=false。"_s);
        return 1;
    }
    auto router = std::make_shared<execution::BrokerRouter>(settings);  // buildRouter:富途不移植,只有 IBKR
    orchestrate::EngineArgs a;
    a.settings = settings;
    a.parser = orchestrate::adaptParser(parsing::providers::buildParser(settings.llm));
    a.router = std::make_shared<orchestrate::BrokerEngineRouter>(router);
    orchestrate::TradingEngine engine(std::move(a));
    std::exception_ptr failure;
    try {
        const orchestrate::EngineResult result = runBlocking(engine.handleInstruction(instruction, u"manual"_s, std::nullopt, std::nullopt, accounts));
        io.log(pretty(result.toJson()));
        runBlocking(engine.syncBrokerOrders());
    } catch (...) {
        failure = std::current_exception();
    }
    runBlocking(router->disconnectAll());
    if (failure) std::rethrow_exception(failure);
    return 0;
}


OJson toArray(const QList<OJson>& items) {
    OJson out = js::array();
    out.items = items;
    return out;
}

// ---------------------------------------------------------------- 三个 import-*
const OJson& orEmptyArray(const OJson* v) {
    static const OJson empty = js::array();
    return v ? *v : empty;
}

bool hasAlias(const Settings& settings, const QString& alias, const contract::AccountConfig** found) {
    for (const contract::AccountConfig& a : settings.accounts)
        if (a.alias == alias) {
            *found = &a;
            return true;
        }
    return false;
}

QString knownAliases(const Settings& settings) {
    QStringList known;
    for (const contract::AccountConfig& a : settings.accounts) known << a.alias;
    return known.isEmpty() ? u"(配置里没有账户)"_s : known.join(u"、"_s);
}

/// parsed.first / parsed.last:`?? "-"`
QString orDash(const OJson* v) { return js::nullish(v) ? u"-"_s : js::str(v); }

/// 把 parsed.skipped 一行行打出来(Object.entries 的次序)
void printSkipped(const OJson& parsed, const Io& io) {
    if (const OJson* skipped = js::prop(&parsed, u"skipped"_s))
        for (const auto& [reason, count] : skipped->fields) io.log(u"  未收 %1 行:%2"_s.arg(js::str(&count), reason));
}

/// 把 CSV 里的整数写成 JS 的数字串
QString num(double v) { return util::jsNumberToString(v); }

int importFills(const Settings& settings, const QString& csvPath, const QString& alias, bool dryRun, const Io& io) {
    const contract::AccountConfig* account = nullptr;
    if (csvPath.isEmpty() || !hasAlias(settings, alias, &account)) {
        io.error(u"用法:cli import-fills fills.csv --account <别名> [--dry-run];可选的别名:%1"_s.arg(knownAliases(settings)));
        return 1;
    }
    const OJson parsed = analysis::fills_csv::parseFillsCsv(readText(csvPath), account->account_id);
    domain::TradeStore store(settings.db_path);
    QSet<QString> known;
    for (const OJson& f : store.listFills()) known.insert(js::strOr(js::prop(&f, u"exec_id"_s), QString()));
    const OJson& fills = orEmptyArray(js::prop(&parsed, u"fills"_s));
    QList<OJson> fresh;
    for (const OJson& f : fills.items) {
        const OJson* exec = js::prop(&f, u"exec_id"_s);
        // Set.has 是严格相等:不是字符串的 exec_id 永远对不上(known 里放的是 String(...) 之后的串)
        if (!(js::isStr(exec) && known.contains(exec->s))) fresh << f;
    }
    io.log(u"账户:%1%2"_s.arg(alias, account->is_paper ? u"(模拟)"_s : QString()));
    io.log(u"股票成交 %1 笔(%2 → %3),库里已有 %4 笔,新增 %5 笔"_s.arg(fills.items.size())
               .arg(orDash(js::prop(&parsed, u"first"_s)), orDash(js::prop(&parsed, u"last"_s)))
               .arg(fills.items.size() - fresh.size())
               .arg(fresh.size()));
    printSkipped(parsed, io);
    if (dryRun) {
        io.log(u"--dry-run:没有写库。"_s);
        return 0;
    }
    const double added = store.rememberFills(fills.items);
    const OJson detail = js::object({{u"file"_s, js::S(baseName(csvPath))},
                                     {u"account"_s, js::S(alias)},
                                     {u"added"_s, js::N(added)},
                                     {u"skipped"_s, js::copyOrNull(js::prop(&parsed, u"skipped"_s))}});
    store.audit(u"cli"_s, u"fills_import"_s, &detail);
    io.log(u"已写入 %1 笔。"_s.arg(num(added)));
    return 0;
}

int importOptionTrades(const Settings& settings, const QString& csvPath, const QString& alias, bool dryRun, const Io& io) {
    const contract::AccountConfig* account = nullptr;
    if (csvPath.isEmpty() || !hasAlias(settings, alias, &account)) {
        io.error(u"用法:cli import-option-trades trades.csv --account <别名> [--dry-run];可选的别名:%1"_s.arg(knownAliases(settings)));
        return 1;
    }
    const OJson parsed = analysis::option_trades_csv::parseOptionTradesCsv(readText(csvPath), account->account_id, baseName(csvPath));
    domain::TradeStore store(settings.db_path);
    QSet<QString> known;
    for (const OJson& r : store.imports().listOptionTrades())
        if (const OJson* acct = js::prop(&r, u"account_id"_s); js::isStr(acct) && acct->s == account->account_id) known.insert(js::str(js::prop(&r, u"id"_s)));
    const OJson& rows = orEmptyArray(js::prop(&parsed, u"rows"_s));
    qsizetype fresh = 0, exits = 0;
    for (const OJson& r : rows.items) {
        const OJson* id = js::prop(&r, u"id"_s);
        if (!(js::isStr(id) && known.contains(id->s))) ++fresh;
        const OJson* action = js::prop(&r, u"action"_s);
        if (!(js::isStr(action) && action->s == u"开仓")) ++exits;
    }
    io.log(u"账户:%1%2"_s.arg(alias, account->is_paper ? u"(模拟)"_s : QString()));
    io.log(u"期权结构 %1 行(其中出场 %2 行;%3 → %4),库里已有 %5 行,新增 %6 行"_s.arg(rows.items.size())
               .arg(exits)
               .arg(orDash(js::prop(&parsed, u"first"_s)), orDash(js::prop(&parsed, u"last"_s)))
               .arg(rows.items.size() - fresh)
               .arg(fresh));
    printSkipped(parsed, io);
    if (dryRun) {
        io.log(u"--dry-run:没有写库。"_s);
        return 0;
    }
    const double added = store.imports().rememberOptionTrades(rows.items);
    const OJson detail = js::object({{u"file"_s, js::S(baseName(csvPath))},
                                     {u"account"_s, js::S(alias)},
                                     {u"added"_s, js::N(added)},
                                     {u"skipped"_s, js::copyOrNull(js::prop(&parsed, u"skipped"_s))}});
    store.audit(u"cli"_s, u"option_trades_import"_s, &detail);
    io.log(u"已写入 %1 行。"_s.arg(num(added)));
    return 0;
}

int importOptionPositions(const Settings& settings, const QString& csvPath, const QString& alias, bool dryRun, const Io& io) {
    const contract::AccountConfig* account = nullptr;
    if (csvPath.isEmpty() || !hasAlias(settings, alias, &account)) {
        io.error(u"用法:cli import-option-positions option_positions.csv --account <别名> [--dry-run];可选的别名:%1"_s.arg(knownAliases(settings)));
        return 1;
    }
    const OJson parsed = analysis::option_positions_csv::parseOptionPositionsCsv(readText(csvPath), account->account_id, baseName(csvPath));
    domain::TradeStore store(settings.db_path);
    QSet<QString> known;
    for (const OJson& r : store.imports().listOptionPositions())
        if (const OJson* acct = js::prop(&r, u"account_id"_s); js::isStr(acct) && acct->s == account->account_id) known.insert(js::str(js::prop(&r, u"id"_s)));
    const OJson& rows = orEmptyArray(js::prop(&parsed, u"rows"_s));
    qsizetype fresh = 0;
    QList<std::pair<QString, double>> byStructure;  // Map 的插入次序
    for (const OJson& r : rows.items) {
        const OJson* id = js::prop(&r, u"id"_s);
        if (!(js::isStr(id) && known.contains(id->s))) ++fresh;
        const QString structure = js::str(js::prop(&r, u"structure"_s));
        const auto it = std::find_if(byStructure.begin(), byStructure.end(), [&](const auto& p) { return p.first == structure; });
        if (it == byStructure.end()) byStructure.append({structure, 1});
        else it->second += 1;
    }
    io.log(u"账户:%1%2"_s.arg(alias, account->is_paper ? u"(模拟)"_s : QString()));
    io.log(u"期权仓位 %1 个(%2 → %3),库里已有 %4 个,新增 %5 个"_s.arg(rows.items.size())
               .arg(orDash(js::prop(&parsed, u"first"_s)), orDash(js::prop(&parsed, u"last"_s)))
               .arg(rows.items.size() - fresh)
               .arg(fresh));
    QStringList structures;
    for (const auto& [k, n] : byStructure) structures << u"%1 %2"_s.arg(k, num(n));
    io.log(u"  结构:%1"_s.arg(structures.join(u"、"_s)));
    printSkipped(parsed, io);
    if (dryRun) {
        io.log(u"--dry-run:没有写库。"_s);
        return 0;
    }
    const double added = store.imports().rememberOptionPositions(rows.items);
    const OJson detail = js::object({{u"file"_s, js::S(baseName(csvPath))},
                                     {u"account"_s, js::S(alias)},
                                     {u"added"_s, js::N(added)},
                                     {u"skipped"_s, js::copyOrNull(js::prop(&parsed, u"skipped"_s))}});
    store.audit(u"cli"_s, u"option_positions_import"_s, &detail);
    io.log(u"已写入 %1 个。"_s.arg(num(added)));
    return 0;
}

// ---------------------------------------------------------------- selftest / validate
int selftest(const Settings& settings, const Io& io) {
    const parsing::prompts::PromptBundle bundle = parsing::prompts::loadPromptBundle(settings);
    const domain::EtNow moment = domain::nowEt();
    const OJson snapshot = js::object({{u"AAPL"_s, js::N(230.1)}});
    const QString user = parsing::prompts::renderUser(bundle, settings, u"买入 AAPL 100股 limit 230"_s, moment, QString(), &snapshot);
    io.log(u"提示词版本 : %1 (%2)"_s.arg(bundle.version, parsing::prompts::fingerprint(bundle)));
    io.log(u"少样本对数 : %1"_s.arg(bundle.fewshot.size()));
    io.log(u"系统提示词 : %1 字"_s.arg(bundle.system_text.toUcs4().size()));
    io.log(u"市场状态   : %1"_s.arg(settings.marketStatus(moment)));
    io.log(u"账户别名   : %1"_s.arg(settings.aliasList().join(u", "_s)));
    io.log(u"自动执行   : %1 / 实盘允许:%2"_s.arg(pyBool(settings.policies.auto_execute), pyBool(settings.policies.allow_live_trading)));
    const OJson schema = parsing::providers::structuredOutputSchema();
    QStringList top;
    if (const OJson* props = js::prop(&schema, u"properties"_s); js::isObj(props))
        for (const auto& f : props->fields) top << f.first;
    top.sort();  // JS 的 sort() 按 UTF-16 码元,QString 的 < 也是
    io.log(u"输出 schema 顶层字段:%1"_s.arg(top.join(u", "_s)));
    io.log(QString(60, u'-'));
    io.log(user);
    return 0;
}

int validate(const Settings& settings, const QString& payloadPath, bool hasPath, const OJson& snapshot, const Io& io) {
    if (!hasPath) throw JsError(u"The \"path\" argument must be of type string or an instance of Buffer or URL. Received undefined"_s);
    const OJson payload = js::parseOrThrow(readText(payloadPath));
    const OJson parsed = domain::models::parseLlmPayload(&payload);
    parsing::validator::Validator validator(settings, domain::nowEt(), &snapshot);
    QList<OJson> orders = orEmptyArray(js::prop(&parsed, u"orders"_s)).items;
    const parsing::validator::ValidationOutcome outcome = validator.validateAll(orders);
    for (const OJson& note : orEmptyArray(js::prop(&parsed, u"schema_errors"_s)).items) io.log(u"[schema] %1"_s.arg(js::str(&note)));
    for (const OJson& rejection : orEmptyArray(js::prop(&parsed, u"rejections"_s)).items)
        io.log(u"[模型拒绝] %1: %2"_s.arg(js::str(js::prop(&rejection, u"code"_s)), js::str(js::prop(&rejection, u"message"_s))));
    for (const auto& approved : outcome.approved) {
        io.log(u"[通过] %1 | 账户=%2 | 敞口≈%3 USD"_s.arg(js::str(js::prop(&approved.order, u"intent_summary"_s)), approved.account.alias, util::fmtF(approved.notional, 2)));
        for (const QString& warning : approved.warnings) io.log(u"        ! %1"_s.arg(warning));
    }
    for (const auto& rejected : outcome.rejected)
        io.log(u"[校验拒绝] %1: %2"_s.arg(parsing::validator::primaryCode(rejected), parsing::validator::rejectionMessage(rejected)));
    return outcome.rejected.isEmpty() ? 0 : 2;
}

}  // namespace

// ---------------------------------------------------------------- 启动前的两件事
domain::Settings startupChecks(const std::optional<QString>& configPath) {
    Settings settings = domain::loadSettings(configPath.value_or(QString()));
    // 先把交易库开一遍:打不开(坏了、被占着、写不进去、比软件新)就在这里当场说清楚并退出
    domain::TradeStore(settings.db_path, true).close();
    rpc::markStartupChecked();
    return settings;
}

// ---------------------------------------------------------------- main
int main(const QStringList& argvIn, const Io& io, const RpcEntry& rpc, const Hooks& hooks) {
    try {
        QStringList args = argvIn;
        std::optional<QString> configPath;
        const qsizetype configIdx = args.indexOf(u"--config"_s);
        if (configIdx >= 0) {
            configPath = configIdx + 1 < args.size() ? std::optional<QString>(args[configIdx + 1]) : std::nullopt;
            args.remove(configIdx, std::min<qsizetype>(2, args.size() - configIdx));
        }
        const std::optional<QString> command = args.isEmpty() ? std::nullopt : std::optional<QString>(args.takeFirst());

        if (command == u"rpc") {
            try {
                return rpc(configPath);
            } catch (const domain::ConfigLoadError& exc) {
                // 配置读不进来 / 交易库打不开:不打调用栈(桌面端只看得见 stderr 的最后几行,十行栈会把这句话顶出去),
                // 只留给人看的话,并用专门的退出码告诉桌面端"别重启我,去问用户"
                static const QRegularExpression newline(u"[%1]*\\n[%1]*"_s.arg(util::jsSpaceClassBody()));
                QString message = exc.message();
                message.replace(newline, u" "_s);
                io.error(u"[fatal:config:%1] %2"_s.arg(exc.kind, message));
                return domain::kExitConfig;
            } catch (const domain::StoreOpenError& exc) {
                static const QRegularExpression newline(u"[%1]*\\n[%1]*"_s.arg(util::jsSpaceClassBody()));
                QString message = exc.message();
                message.replace(newline, u" "_s);
                io.error(u"[fatal:store:path] %1"_s.arg(exc.dbPath));
                io.error(u"[fatal:store:%1] %2"_s.arg(exc.kind, message));
                return domain::kExitStore;
            }
        }

        const Settings settings = domain::loadSettings(configPath.value_or(QString()));
        const bool hasFirst = !args.isEmpty();

        if (command == u"selftest") return selftest(settings, io);
        if (command == u"validate") {
            const OJson snapshot = parseSnapshot(flagValue(args, u"--snapshot"_s).value_or(QString()), io);
            return validate(settings, args.value(0), hasFirst, snapshot, io);
        }
        if (command == u"parse") {
            const OJson snapshot = parseSnapshot(flagValue(args, u"--snapshot"_s).value_or(QString()), io);
            return parseCmd(settings, args.value(0), snapshot, accountsArg(flagValue(args, u"--accounts"_s)), io, hooks);
        }
        if (command == u"run") return runCmd(settings, args.value(0), args.contains(u"--i-understand-this-places-real-orders"_s), accountsArg(flagValue(args, u"--accounts"_s)), io);
        if (command == u"records") {
            domain::TradeStore store(settings.db_path);
            const double limit = util::jsStringToNumber(flagValue(args, u"--limit"_s).value_or(u"10"_s));
            io.log(pretty(toArray(store.listRecords(limit))));
            return 0;
        }
        if (command == u"idea") {
            domain::TradeStore store(settings.db_path);
            if (!hasFirst) throw JsError(u"cli idea 缺少想法文字(TS 在 args[0]! 上抛 TypeError)"_s);
            const QString text = args[0];
            const OJson idea = store.addIdea(text, analysis::market::extractSymbols(text, settings, std::nullopt, false));
            io.log(u"已记下(%1):%2"_s.arg(js::str(js::prop(&idea, u"id"_s)).left(8), js::str(js::prop(&idea, u"text"_s))));
            return 0;
        }
        if (command == u"ideas") {
            domain::TradeStore store(settings.db_path);
            const bool all = args.contains(u"--all"_s);
            const double limit = util::jsStringToNumber(flagValue(args, u"--limit"_s).value_or(u"20"_s));
            io.log(pretty(toArray(store.listIdeas(all ? std::nullopt : std::optional<QString>(u"active"_s), limit))));
            return 0;
        }
        if (command == u"halt") {
            const QString reason = flagValue(args, u"--reason"_s).value_or(u"用户手动熔断"_s);
            util::KillSwitch ks(breakerPath(settings.db_path));
            const util::BreakerState state = ks.engage(reason);
            const OJson detail = js::object({{u"reason"_s, js::S(reason)}});
            domain::TradeStore(settings.db_path).audit(u"cli"_s, u"halt"_s, &detail);
            io.log(u"已熔断:%1"_s.arg(state.reason));
            return 0;
        }
        if (command == u"resume") {
            util::KillSwitch ks(breakerPath(settings.db_path));
            ks.release(u"cli"_s);
            const OJson detail = js::object();
            domain::TradeStore(settings.db_path).audit(u"cli"_s, u"resume"_s, &detail);
            io.log(u"熔断已解除。注意:auto_execute 仍受配置控制。"_s);
            return 0;
        }
        if (command == u"export") {
            const OJson data = domain::TradeStore(settings.db_path).exportAll();
            if (!hasFirst) throw JsError(u"The \"path\" argument must be of type string or an instance of Buffer or URL. Received undefined"_s);
            QFile out(args[0]);
            if (!out.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
                // fs.writeFileSync 的错:目录 / 上级不在 / 没权限
                const QFileInfo info(args[0]);
                const QString why = info.isDir() ? u"EISDIR: illegal operation on a directory"_s
                                    : !info.dir().exists() ? u"ENOENT: no such file or directory"_s
                                                           : u"EACCES: permission denied"_s;
                throw JsError(u"%1, open '%2'"_s.arg(why, args[0]));
            }
            out.write(util::toNodeUtf8(pretty(data)));
            out.close();
            io.log(u"已导出到 %1"_s.arg(args[0]));
            return 0;
        }
        const bool dryRun = args.contains(u"--dry-run"_s);
        if (command == u"import-fills") return importFills(settings, args.value(0), flagValue(args, u"--account"_s).value_or(QString()), dryRun, io);
        if (command == u"import-option-trades") return importOptionTrades(settings, args.value(0), flagValue(args, u"--account"_s).value_or(QString()), dryRun, io);
        if (command == u"import-option-positions") return importOptionPositions(settings, args.value(0), flagValue(args, u"--account"_s).value_or(QString()), dryRun, io);
        if (command == u"set-key") {
            if (!hasFirst) throw JsError(u"cli set-key 缺少密钥(TS 在 args[0]! 上把 undefined 交给凭证库)"_s);
            if (hooks.setSecret) hooks.setSecret(settings.llm.keychain_service, settings.llm.keychain_account, args[0]);
            else util::setSecret(settings.llm.keychain_service, settings.llm.keychain_account, args[0]);
            io.log(u"已写入 Keychain(service=%1)"_s.arg(settings.llm.keychain_service));
            return 0;
        }
        io.error(u"用法:cli <selftest|rpc|validate|parse|run|records|idea|ideas|halt|resume|export|import-fills|import-option-trades|import-option-positions|set-key> [--config path]"_s);
        return 1;
    } catch (const ExitRequest& exit) {
        return exit.code();
    }
}

int runMain(const QStringList& argv, const Io& io, const RpcEntry& rpc, const Hooks& hooks) {
    try {
        return main(argv, io, rpc, hooks);
    } catch (const JsError& exc) {
        io.error(u"Error: %1"_s.arg(exc.message()));
        return 1;
    } catch (const std::exception& exc) {
        io.error(u"Error: %1"_s.arg(QString::fromUtf8(exc.what())));
        return 1;
    }
}

}  // namespace ibkr::cli
