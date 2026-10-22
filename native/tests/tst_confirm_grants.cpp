// 确认凭据(shell/confirm_grants):两层期望。
// 1. 照抄 engine-ts/tests/desktop-confirm-grants.spec.ts 里凭据本身的那几条(发、核销、过期、用途不通用、差一张不白烧……)。
// 2. fixtures/confirm-grants.json:同样的输入,desktop/confirm-grants.js 现算的结果(gen_confirm_grants.mjs)。
//    哪些调用要凭据、哪些限额算放宽、跟单放没放开、确认框上的字、指纹,逐字比。
#include "shell/confirm_grants.h"
#include "shell/jsvalue.h"

#include <QFile>
#include <QJsonDocument>
#include <QTest>

#include <cmath>
#include <limits>

using namespace ibkr;
using namespace Qt::StringLiterals;

namespace {

QJsonObject fixture() {
    QFile file(QStringLiteral(IBKR_FIXTURES_DIR "/confirm-grants.json"));
    if (!file.open(QIODevice::ReadOnly)) qFatal("读不到 fixture:%s", qPrintable(file.fileName()));
    return QJsonDocument::fromJson(file.readAll()).object();
}

QJsonValue json(const char* text) { return QJsonDocument::fromJson(QByteArray("[") + text + "]").array().at(0); }

QString canonNeeds(const QList<shell::GrantNeed>& needs) {
    QJsonArray a;
    for (const auto& n : needs) a.append(QJsonObject{{u"purpose"_s, n.purpose}, {u"binding"_s, n.binding}});
    return shell::canonical(a);
}

QString canonLoosened(const QList<shell::LoosenedLimit>& list) {
    QJsonArray a;
    for (const auto& l : list) a.append(QJsonObject{{u"key"_s, l.key}, {u"label"_s, l.label}, {u"from"_s, l.from}, {u"to"_s, l.to}});
    return shell::canonical(a);
}

const QJsonValue kCurrent = json(R"({"policies":{"auto_execute":false,"allow_live_trading":false},
  "limits":{"max_order_notional":5000,"max_option_contracts":5,"max_mkt_shares":200,"max_spread_slippage":0.1,"min_confidence":0.9,"duplicate_window_minutes":10,"max_orders_per_input":5}})");

constexpr qint64 kT0 = 1'000'000;

}  // namespace

class TestConfirmGrants : public QObject {
    Q_OBJECT
private slots:
    // ---- 2. 对着 JS 现算的 ----
    void purposesMatchJs() {
        const QJsonObject purposes = fixture().value(u"purposes").toObject();
        QStringList mine = shell::purposeNames();
        mine.sort();
        QStringList theirs = purposes.keys();
        theirs.sort();
        QCOMPARE(mine, theirs);
        for (auto it = purposes.begin(); it != purposes.end(); ++it) QCOMPARE(shell::purposeHeadline(it.key()), it.value().toString());
        QCOMPARE(fixture().value(u"ttl_ms").toInteger(), shell::kGrantTtlMs);
    }

    void requiredGrants_data() {
        QTest::addColumn<QString>("method");
        QTest::addColumn<QJsonValue>("params");
        QTest::addColumn<QJsonValue>("current");
        QTest::addColumn<QString>("expected");
        int i = 0;
        for (const QJsonValue& r : fixture().value(u"required").toArray()) {
            const QJsonObject o = r.toObject();
            QTest::newRow(qPrintable(u"%1 %2"_s.arg(++i).arg(o.value(u"method").toString())))
                << o.value(u"method").toString() << o.value(u"params") << o.value(u"current") << o.value(u"expected").toString();
        }
    }
    void requiredGrants() {
        QFETCH(QString, method);
        QFETCH(QJsonValue, params);
        QFETCH(QJsonValue, current);
        QFETCH(QString, expected);
        QCOMPARE(canonNeeds(shell::requiredGrants(method, params, current)), expected);
    }

    void loosenedLimits_data() {
        QTest::addColumn<QJsonValue>("patch");
        QTest::addColumn<QJsonValue>("current");
        QTest::addColumn<QString>("expected");
        int i = 0;
        for (const QJsonValue& r : fixture().value(u"loosened").toArray()) {
            const QJsonObject o = r.toObject();
            QJsonValue patch = o.value(u"patch");
            if (patch == QJsonValue(u"__undefined__"_s)) patch = QJsonValue(QJsonValue::Undefined);
            QTest::newRow(qPrintable(QString::number(++i))) << patch << o.value(u"current") << o.value(u"expected").toString();
        }
    }
    void loosenedLimits() {
        QFETCH(QJsonValue, patch);
        QFETCH(QJsonValue, current);
        QFETCH(QString, expected);
        QCOMPARE(canonLoosened(shell::loosenedLimits(patch, current)), expected);
    }

    void normalizeBinding_data() {
        QTest::addColumn<QString>("purpose");
        QTest::addColumn<QJsonValue>("binding");
        QTest::addColumn<QString>("expected");
        int i = 0;
        for (const QJsonValue& r : fixture().value(u"normalize").toArray()) {
            const QJsonObject o = r.toObject();
            QTest::newRow(qPrintable(u"%1 %2"_s.arg(++i).arg(o.value(u"purpose").toString()))) << o.value(u"purpose").toString() << o.value(u"binding") << o.value(u"expected").toString();
        }
    }
    void normalizeBinding() {
        QFETCH(QString, purpose);
        QFETCH(QJsonValue, binding);
        QFETCH(QString, expected);
        QCOMPARE(shell::canonical(shell::normalizeBinding(purpose, binding)), expected);
    }

    void followBindingAndWidened() {
        const QJsonObject f = fixture();
        for (const QJsonValue& r : f.value(u"follow_binding").toArray())
            QCOMPARE(shell::canonical(shell::followBinding(r[u"cfg"])), r[u"expected"].toString());
        int i = 0;
        for (const QJsonValue& r : f.value(u"follow_widened").toArray()) {
            ++i;
            QVERIFY2(shell::followWidened(r[u"next"], r[u"now"]) == r[u"expected"].toBool(), qPrintable(QString::number(i)));
        }
    }

    void followConfirmTextMatchesJs() {
        int i = 0;
        for (const QJsonValue& r : fixture().value(u"follow_text").toArray()) {
            ++i;
            const auto got = shell::followConfirmText(shell::followBinding(r[u"binding"]), r[u"accounts"].toArray());
            QVERIFY2(got.live == r[u"expected"][u"live"].toBool(), qPrintable(QString::number(i)));
            QCOMPARE(got.detail, r[u"expected"][u"detail"].toString());
        }
    }

    void canonicalMatchesJs() {
        // 同 gen_confirm_grants.mjs 的 values(JSON 写不出 NaN、-0、落单的代理项,这里照着现造)
        const double nan = std::numeric_limits<double>::quiet_NaN();
        const double inf = std::numeric_limits<double>::infinity();
        const QList<QJsonValue> values{
            json(R"({"b":1,"a":[3,{"y":null,"x":"z"}]})"), 0.1, 1e21, 1e-7, 123456789012345680000.0, -0.0, 5e-324, 0.000001, 1.5e-6, nan, inf,
            true, QJsonValue(QJsonValue::Null), u"引号\"与\\反斜杠\n换行\t\u0001\u001f"_s, u"😀"_s,
            u"lone "_s + QChar(0xD800) + u" surrogate"_s, json(R"({"":1,"a":2})"), QJsonArray{QJsonValue::Null, nan, u"a"_s},
        };
        const QJsonArray expected = fixture().value(u"canonical").toArray();
        QCOMPARE(expected.size(), values.size());
        for (qsizetype i = 0; i < values.size(); ++i) QCOMPARE(shell::canonical(values[i]), expected[i][u"expected"].toString());
    }

    void digestsMatchJs() {
        for (const QJsonValue& r : fixture().value(u"digests").toArray()) {
            const QString purpose = r[u"purpose"].toString();
            QCOMPARE(shell::grantDigest(purpose, shell::normalizeBinding(purpose, r[u"binding"])), r[u"expected"].toString());
        }
    }

    // ---- 1. 照抄 spec:凭据本身 ----
    void issueConsumeOnce() {
        shell::GrantBook book;
        const QJsonValue binding = json(R"({"text":"买 AAPL 100 股","accounts":["模拟"]})");
        QVERIFY(!book.consume(u"instruction.submit"_s, binding, kT0));
        book.issue(u"instruction.submit"_s, binding, kT0);
        QVERIFY(book.consume(u"instruction.submit"_s, binding, kT0));
        QVERIFY(!book.consume(u"instruction.submit"_s, binding, kT0));
    }

    void differentContentKeepsTheGrant() {
        // 确认的是一句话,发的是另一句:不放行,而且那张凭据还在(给原来那句用)
        shell::GrantBook book;
        book.issue(u"instruction.submit"_s, json(R"({"text":"买 AAPL 1 股","accounts":["模拟"]})"), kT0);
        QVERIFY(!book.consume(u"instruction.submit"_s, json(R"({"text":"买 TSLA 1000 股","accounts":["模拟"]})"), kT0));
        QVERIFY(!book.consume(u"instruction.submit"_s, json(R"({"text":"买 AAPL 1 股","accounts":["主账户"]})"), kT0));
        QVERIFY(!book.consume(u"instruction.submit"_s, json(R"({"text":"买 AAPL 1 股","accounts":["模拟","主账户"]})"), kT0));
        QVERIFY(book.consume(u"instruction.submit"_s, json(R"({"text":"买 AAPL 1 股","accounts":["模拟"]})"), kT0));
    }

    void purposesAreNotInterchangeable() {
        shell::GrantBook book;
        book.issue(u"tracker.close_now"_s, json(R"({"id":"t1"})"), kT0);
        QVERIFY(!book.consume(u"instruction.submit"_s, json(R"({"id":"t1"})"), kT0));
        QVERIFY(!book.consume(u"tracker.close_now"_s, json(R"({"id":"t2"})"), kT0));
        QVERIFY(book.consume(u"tracker.close_now"_s, json(R"({"id":"t1"})"), kT0));
    }

    void expiresAfterAMinute() {
        shell::GrantBook book;
        book.issue(u"tracker.close_now"_s, json(R"({"id":"t1"})"), kT0);
        QVERIFY(!book.consume(u"tracker.close_now"_s, json(R"({"id":"t1"})"), kT0 + shell::kGrantTtlMs + 1));
        book.issue(u"tracker.close_now"_s, json(R"({"id":"t1"})"), kT0);
        QVERIFY(book.consume(u"tracker.close_now"_s, json(R"({"id":"t1"})"), kT0 + shell::kGrantTtlMs - 1));
    }

    void unknownPurposeCannotBeIssued() {
        shell::GrantBook book;
        for (const char16_t* p : {u"anything.goes", u"toString"}) {
            try {
                book.issue(QString::fromUtf16(p), QJsonObject{}, kT0);
                QFAIL("应当抛出");
            } catch (const shell::GrantError& e) {
                QVERIFY(e.message().startsWith(u"未知的确认用途"_s));
            }
        }
    }

    void keyOrderDoesNotMatter() {
        shell::GrantBook book;
        book.issue(u"tracker.add"_s, json(R"({"key":"k","auto_close":true,"stop_loss":"95"})"), kT0);
        QVERIFY(book.consume(u"tracker.add"_s, json(R"({"stop_loss":"95","key":"k","auto_close":true})"), kT0));
        book.issue(u"tracker.add"_s, json(R"({"key":"k","auto_close":true,"stop_loss":"95"})"), kT0);
        QVERIFY(!book.consume(u"tracker.add"_s, json(R"({"key":"k","auto_close":true,"stop_loss":"90"})"), kT0));
    }

    void consumeAllIsAllOrNothing() {
        shell::GrantBook book;
        const auto needs = shell::requiredGrants(u"settings.patch"_s, json(R"({"patch":{"policies":{"auto_execute":true,"allow_live_trading":true}}})"), kCurrent);
        book.issue(u"gate.auto_execute"_s, QJsonObject{}, kT0);
        QCOMPARE(book.consumeAll(needs, kT0), QStringList{u"允许实盘账户下单"_s});
        book.issue(u"gate.allow_live_trading"_s, QJsonObject{}, kT0);
        QCOMPARE(book.consumeAll(needs, kT0), QStringList());
        QCOMPARE(book.consumeAll(needs, kT0), (QStringList{u"打开自动执行"_s, u"允许实盘账户下单"_s}));
    }

    void wholePathSameFingerprint() {
        // 界面:confirm({ purpose, binding: { text, accounts } }) → issue;随后 submit 的入参(摘掉 __confirmed)→ requiredGrants
        shell::GrantBook book;
        book.issue(u"instruction.submit"_s, json(R"({"text":"1.8 挂15蝴蝶 15CM","accounts":["模拟","主账户"]})"), kT0);
        const auto needs = shell::requiredGrants(u"instruction.submit"_s, json(R"({"text":"1.8 挂15蝴蝶 15CM","execute":true,"accounts":["模拟","主账户"]})"));
        QCOMPARE(book.consumeAll(needs, kT0), QStringList());
    }

    void followShownVersusSaved() {
        // 确认的是一份,存的是另一份:不放行;名单的先后不影响
        const QJsonValue off = json(R"({"policies":{},"limits":{},"follow":{"enabled":false,"channel_id":"","author_ids":[],"accounts":[],"max_age_seconds":30,"max_orders_per_day":3,"max_risk_usd":300}})");
        const QJsonObject shown = json(R"({"enabled":true,"channel_id":"1100000000000000001","author_ids":["330000000000000003","220000000000000002"],
            "accounts":["主账户","模拟"],"max_age_seconds":30,"max_orders_per_day":3,"max_risk_usd":300})").toObject();
        const auto needs = [&off](QJsonObject follow) {
            return shell::requiredGrants(u"settings.patch"_s, QJsonObject{{u"patch"_s, QJsonObject{{u"follow"_s, follow}}}}, off);
        };
        shell::GrantBook book;
        book.issue(u"gate.follow"_s, shown, kT0);
        QJsonObject more = shown;
        QJsonArray authors = shown.value(u"author_ids").toArray();
        authors.append(u"440000000000000004"_s);
        more.insert(u"author_ids"_s, authors);
        QCOMPARE(book.consumeAll(needs(more), kT0), QStringList{u"打开 Discord 自动跟单"_s});
        QJsonObject reversed = shown;
        reversed.insert(u"author_ids"_s, QJsonArray{u"220000000000000002"_s, u"330000000000000003"_s});
        reversed.insert(u"accounts"_s, QJsonArray{u"模拟"_s, u"主账户"_s});
        QCOMPARE(book.consumeAll(needs(reversed), kT0), QStringList());
        QCOMPARE(book.consumeAll(needs(reversed), kT0), QStringList{u"打开 Discord 自动跟单"_s});
    }

    void jsNumberAndStringBasics() {
        QCOMPARE(shell::jsNumber(QJsonValue(u""_s)), 0.0);
        QVERIFY(std::isnan(shell::jsNumber(QJsonValue(QJsonValue::Undefined))));
        QCOMPARE(shell::jsNumber(QJsonValue(QJsonValue::Null)), 0.0);
        QCOMPARE(shell::jsNumber(QJsonValue(u" 0x1F40 "_s)), 8000.0);
        QVERIFY(std::isnan(shell::jsNumber(QJsonValue(u"1,000"_s))));
        QCOMPARE(shell::jsString(QJsonValue(0.1)), u"0.1"_s);
        QCOMPARE(shell::jsNumberToString(1e21), u"1e+21"_s);
        QCOMPARE(shell::jsNumberToString(-1.5e-7), u"-1.5e-7"_s);
        QCOMPARE(shell::formatEnUs(1.005, 2), u"1.01"_s);
        QCOMPARE(shell::formatEnUs(-1234567.891, 2), u"-1,234,567.89"_s);
    }
};

QTEST_GUILESS_MAIN(TestConfirmGrants)
#include "tst_confirm_grants.moc"
