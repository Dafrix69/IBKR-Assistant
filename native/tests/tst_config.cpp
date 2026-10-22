// engine/domain/config 对着原模块(engine-ts/src/config.ts)在 tests/fixtures/gen_config.mjs 的一大把输入上的结果:
//   · fromDict:462 份配置(基础配置上逐条改一处,外加几份原文:重复的键、像下标的键、空配置),每一份要么是那句校验的原话,
//     要么是读进来之后整份 Settings 与它的方法(limitsFor、accountByAlias、connectionsFor、accountBroker、两张提示词表、15 个时刻的 marketStatus、indexConfig),
//     连键序一起比(JSON.stringify 的文本逐字相同);
//   · loadSettings 的 missing / syntax / invalid、patchConfigFile 写盘的文本与 .bak、deepMerge;
//   · parseTradingHours、hoursStatus、validateBaseUrl(WHATWG URL 的怪处)、latestPromptVersion、expandHome、etNowFromEpoch。
#include "domain/config.h"
#include "util/market_calendar.h"

#include <QDir>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>
#include <QTemporaryDir>
#include <QTest>

using namespace ibkr;
using namespace ibkr::domain;
using util::OJson;
using namespace Qt::StringLiterals;

namespace {

OJson S(const QString& s) { return OJson::string(s); }
OJson N(double v) { return OJson::number(v); }
OJson B(bool v) { return OJson::boolean(v); }
OJson Q(const QJsonValue& v) { return OJson::fromQJson(v); }
OJson obj(std::initializer_list<std::pair<QString, OJson>> kv) {
    OJson o;
    o.type = OJson::Object;
    for (const auto& [k, v] : kv) o.set(k, v);
    return o;
}
OJson arr(const QList<OJson>& items = {}) {
    OJson o;
    o.type = OJson::Array;
    o.items = items;
    return o;
}
OJson strs(const QStringList& l) {
    QList<OJson> items;
    for (const QString& s : l) items << S(s);
    return arr(items);
}
OJson nullableStr(const QString& s) { return s.isNull() ? OJson::null() : S(s); }

OJson limitsJson(const contract::Limits& l) {
    OJson by = obj({});
    for (const QString& alias : l.by_account.keys()) {
        const auto& a = *l.by_account.find(alias);
        OJson one = obj({});
        const auto put = [&](const char16_t* k, const QJsonValue& v) {
            if (!v.isUndefined()) one.set(QString::fromUtf16(k), Q(v));
        };
        put(u"max_order_notional", a.max_order_notional);
        put(u"max_option_contracts", a.max_option_contracts);
        put(u"max_mkt_shares", a.max_mkt_shares);
        put(u"max_open_risk_usd", a.max_open_risk_usd);
        put(u"max_underlying_contracts", a.max_underlying_contracts);
        by.set(alias, one);
    }
    return obj({{u"max_order_notional"_s, N(l.max_order_notional)}, {u"max_option_contracts"_s, N(l.max_option_contracts)}, {u"max_mkt_shares"_s, N(l.max_mkt_shares)},
                {u"min_confidence"_s, N(l.min_confidence)}, {u"max_spread_slippage"_s, N(l.max_spread_slippage)}, {u"max_orders_per_input"_s, N(l.max_orders_per_input)},
                {u"duplicate_window_minutes"_s, N(l.duplicate_window_minutes)}, {u"duplicate_qty_tolerance"_s, N(l.duplicate_qty_tolerance)},
                {u"max_open_risk_usd"_s, N(l.max_open_risk_usd)}, {u"max_underlying_contracts"_s, N(l.max_underlying_contracts)},
                {u"auto_mid_spread_share"_s, N(l.auto_mid_spread_share)}, {u"by_account"_s, by}});
}

OJson accountJson(const contract::AccountConfig& a) {
    return obj({{u"alias"_s, S(a.alias)}, {u"account_id"_s, S(a.account_id)}, {u"is_paper"_s, B(a.is_paper)}, {u"connection"_s, S(a.connection)}, {u"default"_s, B(a.isDefault)}});
}
OJson indexJson(const contract::IndexConfig& x) {
    return obj({{u"symbol"_s, S(x.symbol)}, {u"exchange"_s, S(x.exchange)}, {u"daily_trading_class"_s, S(x.daily_trading_class)},
                {u"monthly_trading_class"_s, S(x.monthly_trading_class)}, {u"futures"_s, S(x.futures)}, {u"futures_exchange"_s, S(x.futures_exchange)}});
}

struct Masks {
    QString prompts, empty;
    QString apply(QString s) const {
        return s.replace(prompts, u"<PROMPTS>"_s).replace(empty, u"<EMPTY>"_s).replace(defaultPromptDir(), u"<DEFAULT>"_s).replace(QDir::homePath(), u"<HOME>"_s);
    }
};

OJson dump(const Settings& s, const Masks& m, const QList<double>& instants) {
    const auto& p = s.protections;
    OJson conns = obj({});
    for (const QString& n : s.connections.keys()) {
        const auto& c = *s.connections.find(n);
        conns.set(n, obj({{u"name"_s, S(c.name)}, {u"host"_s, S(c.host)}, {u"port"_s, N(c.port)}, {u"client_id"_s, N(c.client_id)}, {u"readonly"_s, B(c.readonly)},
                          {u"broker"_s, S(c.broker)}}));
    }
    OJson symMap = obj({});
    for (const QString& k : s.broker.futu.symbol_map.keys()) symMap.set(k, S(s.broker.futu.symbol_map.value(k)));
    OJson equity = obj({});
    for (const QString& k : s.risk_budget.equity_usd.keys()) equity.set(k, N(s.risk_budget.equity_usd.value(k)));
    OJson aliases = obj({});
    for (const QString& k : s.symbol_aliases.keys()) aliases.set(k, S(s.symbol_aliases.value(k)));
    OJson indexes = obj({});
    for (const QString& k : s.index_symbols.keys()) indexes.set(k, indexJson(*s.index_symbols.find(k)));
    QList<OJson> accounts, limitsFor, byAlias, brokers, status, indexCfg;
    for (const auto& a : s.accounts) {
        accounts << accountJson(a);
        brokers << nullableStr(s.accountBroker(a));
    }
    QStringList probe = s.aliasList();
    probe << u"DEFAULT"_s << u"nobody"_s << u"toString"_s;
    for (const QString& a : probe) {
        limitsFor << limitsJson(s.limitsFor(a));
        const auto* acct = s.accountByAlias(a);
        byAlias << (acct ? S(acct->alias) : OJson::null());
    }
    for (double ms : instants) status << S(s.marketStatus(etNowFromEpoch(ms)));
    for (const QString& x : {u"spx"_s, u"SPX"_s, u"ndx"_s}) {
        const auto* c = s.indexConfig(x);
        indexCfg << (c ? indexJson(*c) : OJson::null());
    }
    const auto extra = [](const QList<OJson>& list, const QStringList& builtin) {
        QList<OJson> out;
        for (const OJson& d : list)
            if (d.type != OJson::String || !builtin.contains(d.s)) out << d;
        return arr({N(double(list.size())), arr(out)});
    };
    const auto keysOf = [](const contract::OrderedMap<contract::ConnectionConfig>& m) { return strs(m.keys()); };
    const auto* dflt = s.defaultAccount();
    return obj({
        {u"prompt_version"_s, S(s.prompt_version)},
        {u"prompt_follows_latest"_s, B(s.prompt_follows_latest)},
        {u"prompt_dir"_s, S(m.apply(s.prompt_dir))},
        {u"llm"_s, obj({{u"provider"_s, S(s.llm.provider)}, {u"model"_s, S(s.llm.model)}, {u"effort"_s, S(s.llm.effort)}, {u"temperature"_s, Q(s.llm.temperature)},
                        {u"base_url"_s, S(s.llm.base_url)}, {u"max_tokens"_s, N(s.llm.max_tokens)}, {u"timeout_s"_s, N(s.llm.timeout_s)},
                        {u"keychain_service"_s, S(s.llm.keychain_service)}, {u"keychain_account"_s, S(s.llm.keychain_account)}})},
        {u"broker"_s, obj({{u"provider"_s, S(s.broker.provider)},
                           {u"futu"_s, obj({{u"trd_market"_s, S(s.broker.futu.trd_market)}, {u"security_firm"_s, S(s.broker.futu.security_firm)},
                                            {u"keychain_service"_s, S(s.broker.futu.keychain_service)}, {u"keychain_account"_s, S(s.broker.futu.keychain_account)},
                                            {u"symbol_map"_s, symMap}})},
                           {u"auto_connect"_s, B(s.broker.auto_connect)}})},
        {u"limits"_s, limitsJson(s.limits)},
        {u"policies"_s, obj({{u"auto_execute"_s, B(s.policies.auto_execute)}, {u"allow_live_trading"_s, B(s.policies.allow_live_trading)},
                             {u"auto_outside_rth"_s, B(s.policies.auto_outside_rth)}, {u"require_trigger_price_verification"_s, B(s.policies.require_trigger_price_verification)},
                             {u"trigger_min_gap_bps"_s, N(s.policies.trigger_min_gap_bps)}, {u"closed_market_policy"_s, S(s.policies.closed_market_policy)},
                             {u"consecutive_failure_breaker"_s, N(s.policies.consecutive_failure_breaker)}, {u"review_feature_enabled"_s, B(s.policies.review_feature_enabled)}})},
        {u"protections"_s,
         obj({{u"stoploss_guard"_s, obj({{u"enabled"_s, B(p.stoploss_guard.enabled)}, {u"lookback_minutes"_s, N(p.stoploss_guard.lookback_minutes)},
                                         {u"trigger_count"_s, N(p.stoploss_guard.trigger_count)}, {u"pause_minutes"_s, N(p.stoploss_guard.pause_minutes)}})},
              {u"max_drawdown"_s, obj({{u"enabled"_s, B(p.max_drawdown.enabled)}, {u"lookback_minutes"_s, N(p.max_drawdown.lookback_minutes)},
                                       {u"max_drawdown_usd"_s, N(p.max_drawdown.max_drawdown_usd)}, {u"pause_minutes"_s, N(p.max_drawdown.pause_minutes)}})},
              {u"cooldown"_s, obj({{u"enabled"_s, B(p.cooldown.enabled)}, {u"minutes"_s, N(p.cooldown.minutes)}, {u"scope"_s, S(p.cooldown.scope)}})},
              {u"daily_loss"_s, obj({{u"enabled"_s, B(p.daily_loss.enabled)}, {u"max_loss_usd"_s, N(p.daily_loss.max_loss_usd)}, {u"basis"_s, S(p.daily_loss.basis)}})}})},
        {u"risk_budget"_s, obj({{u"enabled"_s, B(s.risk_budget.enabled)}, {u"equity_usd"_s, equity}, {u"max_risk_pct"_s, N(s.risk_budget.max_risk_pct)},
                                {u"max_position_pct"_s, N(s.risk_budget.max_position_pct)}})},
        {u"follow"_s, obj({{u"enabled"_s, B(s.follow.enabled)}, {u"channel_id"_s, S(s.follow.channel_id)}, {u"author_ids"_s, strs(s.follow.author_ids)},
                           {u"accounts"_s, strs(s.follow.accounts)}, {u"max_age_seconds"_s, N(s.follow.max_age_seconds)}, {u"max_orders_per_day"_s, N(s.follow.max_orders_per_day)},
                           {u"max_risk_usd"_s, N(s.follow.max_risk_usd)}, {u"local_inbox"_s, B(s.follow.local_inbox)}, {u"local_channel"_s, S(s.follow.local_channel)},
                           {u"track_fly"_s, B(s.follow.track_fly)}, {u"track_exit_at"_s, S(s.follow.track_exit_at)}})},
        {u"accounts"_s, arr(accounts)},
        {u"connections"_s, conns},
        {u"symbol_aliases"_s, aliases},
        {u"index_symbols"_s, indexes},
        {u"holidays"_s, extra(s.market_holidays_raw, util::builtinCalendar().holidays)},
        {u"early"_s, extra(s.early_close_days_raw, util::builtinCalendar().earlyCloses)},
        {u"db_path"_s, S(m.apply(s.db_path))},
        {u"source_path"_s, s.source_path ? S(m.apply(*s.source_path)) : OJson::null()},
        {u"config_warnings"_s, strs(s.config_warnings)},
        {u"paper_flag_missing"_s, strs(s.paper_flag_missing)},
        {u"limitsFor"_s, arr(limitsFor)},
        {u"byAlias"_s, arr(byAlias)},
        {u"defaultAccount"_s, dflt ? S(dflt->alias) : OJson::null()},
        {u"connectionsFor"_s, arr({keysOf(s.connectionsFor()), keysOf(s.connectionsFor(u"futu"_s)), keysOf(s.connectionsFor(u"ibkr"_s))})},
        {u"accountBroker"_s, arr(brokers)},
        {u"promptAccountTable"_s, S(s.promptAccountTable())},
        {u"promptSymbolTable"_s, S(s.promptSymbolTable())},
        {u"status"_s, arr(status)},
        {u"indexConfig"_s, arr(indexCfg)},
    });
}

QString text(const OJson& o) { return util::stringifyOJson(o, 0); }

}  // namespace

class TestConfig : public QObject {
    Q_OBJECT
    OJson fx;
    QTemporaryDir prompts, empty, work;
    Masks masks;
    QList<double> instants;

    const OJson& at(const char16_t* key) const { return *fx.get(QString::fromUtf16(key)); }
    QString subst(QString t) const {
        const auto esc = [](QString p) { return p.replace(u"\\"_s, u"\\\\"_s); };
        return t.replace(u"<PROMPTS>"_s, esc(prompts.path())).replace(u"<EMPTY>"_s, esc(empty.path()));
    }

private slots:
    void initTestCase() {
        // 默认提示词目录:TS 那边从模块往上找到的是仓库的 prompts/;这边的测试程序在编译目录里,往上找不到,直接指给它
        qputenv("DAFRI_PROMPT_DIR", (QStringLiteral(IBKR_FIXTURES_DIR) + u"/../../../prompts"_s).toUtf8());
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR) + u"/config.json"_s);
        QVERIFY(f.open(QIODevice::ReadOnly));
        fx = *util::parseOJson(QString::fromUtf8(f.readAll()));
        for (const OJson& name : at(u"promptFiles").items) {
            QFile p(prompts.path() + u'/' + name.s);
            QVERIFY(p.open(QIODevice::WriteOnly));
            p.write("x");
        }
        masks = {prompts.path(), empty.path()};
        for (const OJson& e : at(u"etNow").items) instants << e.get(u"ms"_s)->n;
    }

    void fromDictCases() {
        int n = 0, errors = 0;
        for (const OJson& c : at(u"fromDict").items) {
            const QString src = c.get(u"text"_s)->s;
            const auto raw = util::parseOJson(subst(src));
            QVERIFY(raw);
            QString got, want;
            try {
                got = text(dump(fromDict(*raw, u"/cfg/settings.json"_s), masks, instants));
            } catch (const util::JsError& e) {
                got = u"ERR "_s + masks.apply(e.message());
            }
            if (const OJson* err = c.get(u"error"_s)) {
                want = u"ERR "_s + err->s;
                ++errors;
            } else {
                want = text(*c.get(u"out"_s));
            }
            if (got != want) {
                qWarning().noquote() << "配置:" << src.left(600);
                qWarning().noquote() << "C++ :" << got.left(3000);
                qWarning().noquote() << "TS  :" << want.left(3000);
            }
            QCOMPARE(got, want);
            ++n;
        }
        QCOMPARE(n, 465);
        QCOMPARE(errors, 243);
    }

    void loadSettingsKinds() {
        int i = 0;
        for (const OJson& c : at(u"load").items) {
            const QString p = work.path() + u"/s%1.json"_s.arg(i++);
            const OJson* t = c.get(u"text"_s);
            if (t->type != OJson::Null) {
                QFile f(p);
                QVERIFY(f.open(QIODevice::WriteOnly));
                f.write(t->s.toUtf8());
            }
            try {
                loadSettings(p);
                QVERIFY2(c.get(u"ok"_s), qPrintable(t->s));
            } catch (const ConfigLoadError& e) {
                QVERIFY2(!c.get(u"ok"_s), qPrintable(e.message()));
                QCOMPARE(e.kind, c.get(u"kind"_s)->s);
                QCOMPARE(e.path, p);
                if (c.get(u"message"_s)->s != u"<V8>") QCOMPARE(QString(e.message()).replace(p, u"<P>"_s), c.get(u"message"_s)->s);
            }
        }
    }

    void mergesAndPatches() {
        for (const OJson& c : at(u"merges").items) QCOMPARE(text(deepMerge(*c.get(u"base"_s), *c.get(u"patch"_s))), text(*c.get(u"out"_s)));
        int i = 0;
        for (const OJson& c : at(u"patches").items) {
            const QString p = work.path() + u"/patch%1.json"_s.arg(i++);
            {
                QFile f(p);
                QVERIFY(f.open(QIODevice::WriteOnly));
                f.write(at(u"original").s.toUtf8());
            }
            QString got;
            try {
                got = text(dump(patchConfigFile(p, *c.get(u"patch"_s)), masks, instants));
            } catch (const util::JsError& e) {
                got = u"ERR "_s + e.message();
            }
            const OJson* err = c.get(u"error"_s);
            // source_path 是两边各自的临时文件:不比
            static const QRegularExpression src(u"\"source_path\":\"[^\"]*\""_s);
            const auto unsrc = [](QString t) { return t.replace(src, u"\"source_path\":\"<P>\""_s); };
            QCOMPARE(unsrc(got), err ? u"ERR "_s + err->s : unsrc(text(*c.get(u"out"_s))));
            QFile f(p), bak(p + u".bak"_s);
            QVERIFY(f.open(QIODevice::ReadOnly));
            QCOMPARE(QString::fromUtf8(f.readAll()), c.get(u"file"_s)->s);
            const OJson* wantBak = c.get(u"bak"_s);
            QCOMPARE(bak.exists(), wantBak->type != OJson::Null);
            if (bak.open(QIODevice::ReadOnly)) QCOMPARE(QString::fromUtf8(bak.readAll()), wantBak->s);
        }
        try {
            patchConfigFile(std::nullopt, OJson());
            QFAIL("应当抛");
        } catch (const util::JsError& e) {
            QCOMPARE(e.message(), at(u"nullPath").s);
        }
    }

    // 写不进去(目录只读、文件本身可写):照 TS 抛,settings.json 一个字节不动;写成功的文件是 0600(TS 的临时文件用 0600 建再换上去)
    void patchWriteFailureLeavesFileAlone() {
        const QString dir = work.path() + u"/ro"_s;
        QVERIFY(QDir().mkpath(dir));
        const QString p = dir + u"/settings.json"_s;
        {
            QFile f(p);
            QVERIFY(f.open(QIODevice::WriteOnly));
            f.write(at(u"original").s.toUtf8());
        }
        QFile::setPermissions(p, QFileDevice::ReadOwner | QFileDevice::WriteOwner | QFileDevice::ReadGroup | QFileDevice::ReadOther);
        const auto patch = util::parseOJson(uR"({"limits":{"max_mkt_shares":300}})"_s);
        QVERIFY(QFile::setPermissions(dir, QFileDevice::ReadOwner | QFileDevice::ExeOwner));
        bool threw = false;
        try {
            patchConfigFile(p, *patch);
        } catch (const util::JsError& e) {
            threw = true;
            QVERIFY2(e.message().startsWith(u"EACCES: permission denied, open '"_s), qPrintable(e.message()));
        }
        QVERIFY(threw);
        {
            QFile f(p);
            QVERIFY(f.open(QIODevice::ReadOnly));
            QCOMPARE(QString::fromUtf8(f.readAll()), at(u"original").s);
        }
        QVERIFY(QFile::setPermissions(dir, QFileDevice::ReadOwner | QFileDevice::WriteOwner | QFileDevice::ExeOwner));
        patchConfigFile(p, *patch);
#if !defined(Q_OS_WIN)
        QCOMPARE(QFile::permissions(p) & (QFileDevice::ReadGroup | QFileDevice::ReadOther | QFileDevice::WriteGroup | QFileDevice::WriteOther), QFileDevice::Permissions());
#endif
        QVERIFY(QDir(dir).entryList({u"*.tmp-*"_s}, QDir::Files).isEmpty());
    }

    void tradingHours() {
        for (const OJson& c : at(u"hours").items) {
            QList<OJson> got;
            for (const auto& [a, b] : parseTradingHours(c.get(u"spec"_s)->s)) got << arr({N(a), N(b)});
            QCOMPARE(text(arr(got)), text(*c.get(u"out"_s)));
        }
        for (const OJson& c : at(u"status").items) {
            const OJson* liq = c.get(u"liquid"_s);
            QCOMPARE(hoursStatus(c.get(u"spec"_s)->s, c.get(u"tz"_s)->s, c.get(u"ms"_s)->n, liq->type == OJson::Null ? QString() : liq->s), c.get(u"out"_s)->s);
        }
    }

    void baseUrls() {
        for (const OJson& c : at(u"urls").items) {
            const QString url = c.get(u"url"_s)->s;
            QString got;
            try {
                got = u"OK "_s + validateBaseUrl(url);
            } catch (const LLMError& e) {
                got = u"ERR "_s + e.message();
            }
            const OJson* ok = c.get(u"ok"_s);
            QCOMPARE(got, ok ? u"OK "_s + ok->s : u"ERR "_s + c.get(u"error"_s)->s);
        }
    }

    void smallHelpers() {
        const QList<OJson>& latest = at(u"latest").items;
        const QStringList dirs{prompts.path(), empty.path(), prompts.path() + u"/nope"_s};
        for (int i = 0; i < 3; ++i) {
            const auto v = latestPromptVersion(dirs[i]);
            QCOMPARE(v ? S(masks.apply(*v)).s : u"<null>"_s, latest[i].type == OJson::Null ? u"<null>"_s : latest[i].s);
        }
        for (const OJson& c : at(u"homes").items) QCOMPARE(masks.apply(expandHome(c.get(u"p"_s)->s)), c.get(u"out"_s)->s);
        for (const OJson& c : at(u"etNow").items) {
            const EtNow n = etNowFromEpoch(c.get(u"ms"_s)->n);
            const OJson* o = c.get(u"out"_s);
            QCOMPARE(n.epochMs, o->get(u"epochMs"_s)->n);
            QCOMPARE(n.date, o->get(u"date"_s)->s);
            QCOMPARE(n.minutes, o->get(u"minutes"_s)->n);
            QCOMPARE(n.seconds, o->get(u"seconds"_s)->n);
        }
        const OJson& d = at(u"defaults");
        QCOMPARE(double(kExitConfig), d.get(u"exitConfig"_s)->n);
        QCOMPARE(configBackupPath(u"/a/b.json"_s), d.get(u"backup"_s)->s);
        QCOMPARE(text(strs(kBrokerProviders)), text(*d.get(u"brokers"_s)));
        QCOMPARE(defaultBrokerPort(u"ibkr"_s), d.get(u"ports"_s)->get(u"ibkr"_s)->n);
        QCOMPARE(defaultBrokerPort(u"futu"_s), d.get(u"ports"_s)->get(u"futu"_s)->n);
    }

    // OJson 的键序就是 JS 对象的键序:像下标的键按数值排在最前
    void ojsonKeyOrder() {
        const auto o = util::parseOJson(uR"({"b":1,"10":2,"a":3,"2":4,"01":5,"4294967295":6,"4294967294":7,"b":8})"_s);
        QVERIFY(o);
        QCOMPARE(util::stringifyOJson(*o, 0), uR"({"2":4,"10":2,"4294967294":7,"b":8,"a":3,"01":5,"4294967295":6})"_s);
    }
};

QTEST_GUILESS_MAIN(TestConfig)
#include "tst_config.moc"
