// 「接入」五节(shell/access_rules)对着原版现算的期望值(tests/fixtures/gen_access.mjs,本机时区 Asia/Shanghai):
//   · 46 个页面场景:整节的字、按钮(读着、点不动、主次、危险)、卡片的状态色、提示条、端口开没开、状态点、标签、胶囊、
//     跟单的连接 / 读窗口 / 收件那三行的颜色、账户勾选、开关、分段、输入框、参考资料展开没有;
//   · followForm.ts:表单的检查、拼出要存的那一份、改过没有、加信任的人、读窗口那一行、盘口那一行。
// fixture 按原文的键序读(OJson::toQJsonKeyed):券商目录里连接的次序就是 Object.entries 的次序。
#include "shell/access_rules.h"
#include "shell/ordered_json.h"

#include <QFile>
#include <QRegularExpression>
#include <QTest>

using namespace ibkr;
using namespace ibkr::shell;
using namespace Qt::StringLiterals;

namespace {

QJsonObject fixture() {
    static const QJsonObject j = [] {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/access.json"));
        if (!f.open(QIODevice::ReadOnly)) qFatal("access.json 打不开");
        const auto o = parseOJson(QString::fromUtf8(f.readAll()));
        if (!o) qFatal("access.json 读不出来");
        return o->toQJsonKeyed().toObject();
    }();
    return j;
}
const QTimeZone kZone("Asia/Shanghai");

QStringList normalize(const QStringList& in) {
    QStringList out;
    static const QRegularExpression ws(u"\\s+"_s);
    for (const QString& s : in) {
        const QString t = QString(s).replace(ws, u" "_s).trimmed();
        if (!t.isEmpty()) out << t;
    }
    return out;
}

void compareTexts(const QStringList& got, const QJsonArray& want) {
    QStringList expected;
    for (const QJsonValue& t : want) expected << t.toString();
    for (qsizetype i = 0; i < std::max(got.size(), expected.size()); ++i) {
        if (got.value(i) != expected.value(i))
            QFAIL(qPrintable(u"第 %1 段:期望「%2」,实际「%3」\n前后:%4"_s.arg(i).arg(expected.value(i), got.value(i), expected.mid(std::max<qsizetype>(0, i - 3), 6).join(u" | "_s))));
    }
}

/// 期望值里的 "__keys"(键序记号)不算:比较前去掉
QJsonValue strip(const QJsonValue& v) {
    if (v.isArray()) {
        QJsonArray out;
        for (const QJsonValue& x : v.toArray()) out.append(strip(x));
        return out;
    }
    if (v.isObject()) {
        QJsonObject out;
        const QJsonObject o = v.toObject();
        for (auto it = o.begin(); it != o.end(); ++it)
            if (it.key() != u"__keys") out.insert(it.key(), strip(it.value()));
        return out;
    }
    return v;
}
QJsonArray want(const QJsonObject& c, const QString& key) { return strip(c[key]).toArray(); }

QJsonObject modelOf(const QJsonObject& c) {
    const QString sub = c[u"sub"_s].toString();
    const QJsonObject seed = c[u"seed"_s].toObject();
    const QJsonObject st = seed[sub].toObject(), bits = seed[u"bits"_s].toObject();
    const QJsonValue status = c[u"status"_s];
    if (sub == u"tws") return access::twsModel(st, bits, status);
    if (sub == u"futu") return access::futuModel(st, bits, status);
    if (sub == u"accounts") return access::accountsModel(st, status);
    if (sub == u"llm") return access::llmModel(st, c[u"llm"_s]);
    return access::followModel(st, status, kZone);
}

}  // namespace

class TestAccessRules : public QObject {
    Q_OBJECT
private slots:
    void pages_data() {
        QTest::addColumn<QJsonObject>("c");
        for (const QJsonValue& p : fixture()[u"pages"_s].toArray()) QTest::newRow(qPrintable(p[u"name"_s].toString())) << p.toObject();
    }
    void pages() {
        QFETCH(QJsonObject, c);
        const QJsonObject m = modelOf(c);
        compareTexts(normalize(access::pageTexts(c[u"sub"_s].toString(), m)), c[u"texts"_s].toArray());
        const QString sub = c[u"sub"_s].toString();
        const auto btn = [](const QString& text, bool loading = false, bool disabled = false, bool primary = false, bool danger = false) {
            return QJsonObject{{u"text"_s, text}, {u"loading"_s, loading}, {u"disabled"_s, disabled}, {u"primary"_s, primary}, {u"danger"_s, danger}};
        };
        const auto fromModel = [&](const QJsonValue& b) {
            return btn(b[u"text"_s].toString(), b[u"loading"_s].toBool(), b[u"disabled"_s].toBool(), b[u"kind"_s].toString() == u"primary");
        };
        const auto alertType = [](const QString& tone) { return tone == u"warn"_s ? u"warning"_s : tone == u"bad"_s ? u"error"_s : tone; };
        QJsonArray buttons, cards, notices, badges, tags, pills, ports, tones, checks, switches, inputs, primers;
        QJsonArray segments{QJsonValue(QJsonArray{sub == u"tws", sub == u"futu", sub == u"accounts", sub == u"llm", sub == u"follow"})};
        const auto cardsOf = [&](const QJsonValue& block) {
            for (const QJsonValue& cd : block[u"cards"_s].toArray()) {
                cards.append(cd[u"tone"_s].toString());
                if (cd[u"action"_s].isObject()) buttons.append(btn(cd[u"action"_s][u"text"_s].toString(), cd[u"action"_s][u"loading"_s].toBool()));
                for (const QJsonValue& r : cd[u"rows"_s].toArray()) badges.append(r[u"resolved"_s].toBool() ? u"success"_s : u"error"_s);
            }
        };
        if (sub == u"tws" || sub == u"futu") {
            const bool futu = sub == u"futu";
            if (futu) cardsOf(m[u"providers"_s]);
            for (const QJsonValue& n : m[u"notices"_s].toArray()) notices.append(alertType(n[u"tone"_s].toString()));
            if (futu) notices.append(u"info"_s);
            for (const QJsonValue& b : m[u"buttons"_s].toArray()) buttons.append(fromModel(b));
            cardsOf(m[u"apps"_s]);
            for (const QJsonValue& cell : m[u"ports"_s][u"cells"_s].toArray()) {
                ports.append(cell[u"open"_s].toBool() ? u"open"_s : u"closed"_s);
                badges.append(cell[u"open"_s].toBool() ? u"success"_s : u"default"_s);
            }
            cardsOf(m[u"diag"_s]);
            buttons.append(btn(m[u"connect"_s][u"text"_s].toString(), m[u"connect"_s][u"busy"_s].toBool()));
            if (futu) {
                buttons.append(btn(u"保存"_s, m[u"saving"_s].toBool()));
                buttons.append(btn(u"交易解锁"_s, m[u"unlocking"_s].toBool(), false, true));
                switches.append(m[u"isMd5"_s].toBool());
                inputs.append(QJsonObject{{u"type"_s, u"password"_s}, {u"value"_s, m[u"password"_s]}, {u"placeholder"_s, u"富途交易密码"_s}, {u"disabled"_s, false}, {u"checked"_s, false}});
            }
            primers.append(m[u"guide"_s][u"defaultOpen"_s].toBool());
        } else if (sub == u"accounts") {
            for (const QJsonValue& n : m[u"notices"_s].toArray()) notices.append(alertType(n[u"tone"_s].toString()));
            for (const QJsonValue& r : m[u"rows"_s].toArray()) {
                for (const QJsonValue& pl : r[u"pills"_s].toArray()) pills.append(u"var(--%1)"_s.arg(pl[u"tint"_s].toString()));
                buttons.append(btn(u"修改"_s));
                buttons.append(btn(u"删除"_s, false, m[u"busy"_s].toBool(), false, true));
            }
            if (m[u"draft"_s].isObject()) {
                const QJsonObject d = m[u"draft"_s].toObject();
                segments.append(QJsonArray{d[u"paper"_s].toBool(), !d[u"paper"_s].toBool()});
                segments.append(QJsonArray{d[u"makeDefault"_s].toBool(), !d[u"makeDefault"_s].toBool()});
                const QJsonObject txt{{u"type"_s, u"text"_s}, {u"disabled"_s, false}, {u"checked"_s, false}};
                if (!d[u"alias"_s].toString().isEmpty()) {
                    QJsonObject i = txt;
                    i[u"value"_s] = d[u"alias"_s]; i[u"placeholder"_s] = QString(); i[u"disabled"_s] = d[u"editing"_s].toBool();
                    inputs.append(i);
                }
                QJsonObject id = txt;
                id[u"value"_s] = d[u"accountId"_s]; id[u"placeholder"_s] = u"如 DU1234567"_s;
                inputs.append(id);
                buttons.append(fromModel(d[u"save"_s]));
                buttons.append(btn(u"取消"_s));
            } else buttons.append(fromModel(m[u"add"_s]));
        } else if (sub == u"llm") {
            notices.append(u"info"_s);
            QJsonArray seg;
            for (const QJsonValue& pv : m[u"providers"_s].toArray()) seg.append(pv[u"value"_s] == m[u"provider"_s]);
            segments.append(seg);
            const auto in = [&](const QString& type, const QJsonValue& value, const QString& placeholder) {
                const QString v = value.isDouble() ? QString::number(value.toDouble()) : value.toString();
                if (!v.isEmpty() || !placeholder.isEmpty())
                    inputs.append(QJsonObject{{u"type"_s, type}, {u"value"_s, v}, {u"placeholder"_s, placeholder}, {u"disabled"_s, false}, {u"checked"_s, false}});
            };
            in(u"text"_s, m[u"customModel"_s], u"如 deepseek-chat"_s);
            if (m[u"needsBaseUrl"_s].toBool()) in(u"text"_s, m[u"baseUrl"_s], u"https://api.example.com/v1"_s);
            in(u"password"_s, m[u"apiKey"_s], u"sk-..."_s);
            if (m[u"supportsTemperature"_s].toBool()) in(u"text"_s, m[u"temperature"_s], u"不发送"_s);
            in(u"text"_s, m[u"maxTokens"_s], QString());
            in(u"text"_s, m[u"timeout"_s], QString());
            badges.append(m[u"keyState"_s]);
            buttons.append(btn(u"保存"_s));
            buttons.append(btn(u"测试连接"_s, m[u"testing"_s].toBool()));
            buttons.append(btn(u"保存配置"_s, false, false, true));
            if (m[u"test"_s][u"card"_s].isObject()) cards.append(m[u"test"_s][u"card"_s][u"tone"_s]);
        } else if (!m.contains(u"loading"_s) && !m.contains(u"empty"_s)) {
            notices.append(u"warning"_s);
            for (const QJsonValue& a : m[u"authors"_s].toArray()) tags.append(QJsonObject{{u"color"_s, QString()}, {u"closable"_s, true}, {u"text"_s, a[u"text"_s]}});
            if (m[u"reader"_s][u"tag"_s].isObject())
                tags.append(QJsonObject{{u"color"_s, m[u"reader"_s][u"tag"_s][u"color"_s]}, {u"closable"_s, false}, {u"text"_s, m[u"reader"_s][u"tag"_s][u"text"_s]}});
            buttons.append(fromModel(m[u"saveToken"_s]));
            buttons.append(fromModel(m[u"reconnect"_s]));
            buttons.append(btn(u"添加"_s, false, !m[u"canAdd"_s].toBool()));
            for (const QJsonValue& sr : m[u"seen"_s].toArray()) {
                if (sr[u"local"_s].toBool()) tags.append(QJsonObject{{u"color"_s, QString()}, {u"closable"_s, false}, {u"text"_s, u"本地收件"_s}});
                if (sr[u"trusted"_s].toBool()) tags.append(QJsonObject{{u"color"_s, u"success"_s}, {u"closable"_s, false}, {u"text"_s, u"已信任"_s}});
                else buttons.append(btn(u"信任"_s));
            }
            const int pending = m[u"tracksPending"_s].toInt();
            if (pending > 0) tags.append(QJsonObject{{u"color"_s, QString()}, {u"closable"_s, false}, {u"text"_s, u"%1 只"_s.arg(pending)}});
            buttons.append(fromModel(m[u"save"_s]));
            for (const QJsonValue& r : m[u"recent"_s].toArray()) tags.append(QJsonObject{{u"color"_s, r[u"tone"_s] == u"default"_s ? QString() : r[u"tone"_s].toString()}, {u"closable"_s, false}, {u"text"_s, r[u"tag"_s]}});
            if (m[u"autoExecuteOff"_s].toBool()) notices.append(u"warning"_s);
            if (!m[u"problems"_s].toArray().isEmpty()) notices.append(u"warning"_s);
            tones = QJsonArray{u"link:"_s + m[u"link"_s][u"tone"_s].toString(), u"reader:"_s + m[u"reader"_s][u"tone"_s].toString(), u"inbox:"_s + m[u"inbox"_s][u"tone"_s].toString()};
            for (const QJsonValue& a : m[u"accounts"_s].toArray()) checks.append(a[u"checked"_s].toBool());
            switches = QJsonArray{m[u"localInbox"_s].toBool(), m[u"trackFly"_s].toBool(), m[u"enabled"_s].toBool()};
            primers = QJsonArray{m[u"setupOpen"_s].toBool(), false};
        }
        QCOMPARE(buttons, want(c, u"buttons"_s));
        QCOMPARE(cards, want(c, u"cards"_s));
        QCOMPARE(notices, want(c, u"notices"_s));
        QCOMPARE(badges, want(c, u"badges"_s));
        QCOMPARE(tags, want(c, u"tags"_s));
        QCOMPARE(pills, want(c, u"pills"_s));
        QCOMPARE(ports, want(c, u"ports"_s));
        QCOMPARE(tones, want(c, u"rowTones"_s));
        QCOMPARE(checks, want(c, u"checks"_s));
        QCOMPARE(switches, want(c, u"switches"_s));
        QCOMPARE(segments, want(c, u"segments"_s));
        QCOMPARE(primers, want(c, u"primers"_s));
        if (sub != u"follow") QCOMPARE(inputs, want(c, u"inputs"_s));
    }

    void followForms_data() {
        QTest::addColumn<QJsonObject>("c");
        int i = 0;
        for (const QJsonValue& p : fixture()[u"follow"_s][u"forms"_s].toArray()) QTest::newRow(qPrintable(QString::number(i++))) << p.toObject();
    }
    void followForms() {
        QFETCH(QJsonObject, c);
        const QJsonObject form = c[u"form"_s].toObject();
        QStringList want;
        for (const QJsonValue& p : c[u"problems"_s].toArray()) want << p.toString();
        QCOMPARE(access::follow::formProblems(form), want);
        QJsonObject cfg = c[u"config"_s].toObject();
        cfg.remove(u"__keys"_s);
        QCOMPARE(access::follow::toConfig(form), cfg);
        QJsonObject saved;
        for (const QJsonValue& p : fixture()[u"pages"_s].toArray())
            if (p[u"name"_s].toString() == u"跟单:默认") saved = p[u"seed"_s][u"follow"_s][u"status"_s][u"config"_s].toObject();
        QCOMPARE(access::follow::isDirty(form, saved), c[u"dirty"_s].toBool());
        QCOMPARE(access::follow::isDirty(form, QJsonValue::Null), c[u"dirtyNull"_s].toBool());
    }

    void followAuthors() {
        QJsonObject base;
        for (const QJsonValue& p : fixture()[u"pages"_s].toArray())
            if (p[u"name"_s].toString() == u"跟单:默认") base = access::follow::toForm(p[u"seed"_s][u"follow"_s][u"status"_s][u"config"_s]);
        for (const QJsonValue& c : fixture()[u"follow"_s][u"authors"_s].toArray())
            QCOMPARE(access::follow::addAuthor(base, c[u"id"_s].toString())[u"authorIds"_s].toArray(), c[u"after"_s].toArray());
    }

    void followReaders() {
        for (const QJsonValue& c : fixture()[u"follow"_s][u"readers"_s].toArray()) {
            QJsonObject want = c[u"out"_s].toObject();
            want.remove(u"__keys"_s);
            QCOMPARE(access::follow::readerText(c[u"reader"_s], c[u"channel"_s].toString()), want);
        }
    }

    void followQuotes() {
        for (const QJsonValue& c : fixture()[u"follow"_s][u"quotes"_s].toArray()) {
            const auto got = access::follow::quoteLine(c[u"entry"_s]);
            if (c[u"out"_s].isNull()) QVERIFY(!got);
            else QCOMPARE(got.value_or(u"(无)"_s), c[u"out"_s].toString());
        }
    }
};

QTEST_GUILESS_MAIN(TestAccessRules)
#include "tst_access_rules.moc"
