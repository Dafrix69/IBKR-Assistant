// 交易指令页右栏的两面(shell/fly_rules)对着原版现算的期望值(tests/fixtures/gen_fly_plan.mjs,本机时区按 Asia/Shanghai):
//   · flyPlanForm.ts:表单的问题、引擎入参(过了引擎的 strict schema)、美东时钟与快捷时刻、写成一句指令、几个格式与词表;
//   · 蝴蝶测算整面的字(SSR 渲染原面板抽字,26 个场景)、盈亏曲线的 SVG 路径与线与标签;
//   · 日内剧本整面的字(11 个场景)。
#include "shell/fly_rules.h"

#include "shell/jsvalue.h"

#include <QFile>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QTest>

using namespace ibkr;
using namespace ibkr::shell;
using namespace Qt::StringLiterals;

namespace {

QJsonObject fixture() {
    static const QJsonObject j = [] {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/fly-plan.json"));
        if (!f.open(QIODevice::ReadOnly)) qFatal("fly-plan.json 打不开");
        return QJsonDocument::fromJson(f.readAll()).object();
    }();
    return j;
}

const QTimeZone kLocal("Asia/Shanghai");

QStringList list(const QJsonValue& v) {
    QStringList out;
    for (const QJsonValue& x : v.toArray()) out << x.toString();
    return out;
}

QStringList normalize(const QStringList& in) {
    QStringList out;
    static const QRegularExpression ws(u"\\s+"_s);
    for (const QString& s : in)
        for (const QString& part : s.split(u'\n')) {
            const QString t = QString(part).replace(ws, u" "_s).trimmed();
            if (!t.isEmpty()) out << t;
        }
    return out;
}

void compareTexts(const QStringList& got, const QStringList& expected) {
    for (qsizetype i = 0; i < std::max(got.size(), expected.size()); ++i) {
        if (got.value(i) != expected.value(i))
            QFAIL(qPrintable(u"第 %1 段:期望「%2」,实际「%3」\n前后:%4"_s.arg(i).arg(expected.value(i), got.value(i), expected.mid(std::max<qsizetype>(0, i - 3), 6).join(u" | "_s))));
    }
}

QString compact(const QJsonValue& v) { return QString::fromUtf8(QJsonDocument(QJsonArray{v}).toJson(QJsonDocument::Compact)); }

}  // namespace

class TestFlyRules : public QObject {
    Q_OBJECT
private slots:
    void form() {
        const QJsonArray cases = fixture()[u"form"].toArray();
        QVERIFY(cases.size() >= 15);
        for (const QJsonValue& c : cases) {
            const QJsonObject f = c[u"form"].toObject();
            QCOMPARE(fly::formProblems(f), list(c[u"problems"]));
            QCOMPARE(fly::formKey(f), c[u"key"].toString());
            if (c[u"params"].isObject()) {
                QCOMPARE(fly::toParams(f), c[u"params"].toObject());
                QCOMPARE(c[u"schema"].toString(), u"ok"_s);
            }
        }
        QCOMPARE(fly::formKey(fly::emptyForm()), fixture()[u"reset"][u"resultFor"].toString().isEmpty() ? fly::formKey(fixture()[u"reset"][u"form"].toObject()) : QString());
    }

    void clocks() {
        for (const QJsonValue& c : fixture()[u"clocks"].toArray()) {
            const fly::EtClock k = fly::etClock(c[u"ms"].toDouble());
            QCOMPARE(k.date, c[u"clock"][u"date"].toString());
            QCOMPARE(k.minutes, c[u"clock"][u"minutes"].toInt());
            const double ms = c[u"ms"].toDouble();
            QCOMPARE((QStringList{fly::minutesFromNow(ms, 30), fly::minutesFromNow(ms, 60), fly::minutesFromNow(ms, 120)}), list(c[u"chips"]));
        }
        for (const QJsonValue& h : fixture()[u"hhmm"].toArray()) QCOMPARE(fly::hhmm(h[u"m"].toDouble()), h[u"text"].toString());
    }

    void instructions() {
        for (const QJsonValue& c : fixture()[u"instr"].toArray())
            QCOMPARE(fly::instructionFor(c[u"r"].toObject(), c[u"today"].toString()), c[u"text"].toString());
    }

    void formats() {
        const QJsonObject f = fixture()[u"fmt"].toObject();
        for (const QJsonValue& x : f[u"signedUsd"].toArray()) QCOMPARE(fly::signedUsd(x[0].toDouble()), x[1].toString());
        for (const QJsonValue& x : f[u"signedPct"].toArray()) {
            QCOMPARE(fly::signedPct(x[0].toDouble()), x[1].toString());
            QCOMPARE(fly::signedPct(x[0].toDouble(), 0), x[2].toString());
        }
        for (const QJsonValue& x : f[u"pct"].toArray()) QCOMPARE(fly::pct(x[0].toDouble()), x[1].toString());
        const QJsonObject labels = f[u"labels"].toObject();
        for (auto [name, table] : {std::pair{"PACE_LABEL", &fly::paceLabel}, std::pair{"IV_SOURCE_LABEL", &fly::ivSourceLabel}, std::pair{"COST_SOURCE_LABEL", &fly::costSourceLabel}}) {
            const QJsonObject want = labels[QLatin1StringView(name)].toObject();
            QCOMPARE(table().size(), want.size());
            for (auto it = want.begin(); it != want.end(); ++it) QCOMPARE(table().value(it.key()), it.value().toString());
        }
    }

    void plannerTexts_data() {
        QTest::addColumn<QJsonObject>("c");
        const QJsonArray pages = fixture()[u"pages"].toArray();
        QVERIFY(pages.size() >= 25);
        for (const QJsonValue& c : pages) QTest::newRow(qPrintable(c[u"name"].toString())) << c.toObject();
    }
    void plannerTexts() {
        QFETCH(QJsonObject, c);
        fly::PlannerInput in;
        in.plan = c[u"fly"].toObject();
        in.spot = c[u"spot"].toObject();
        in.status = c[u"status"];
        in.events = c[u"events"][u"list"].toObject();
        in.eventsNow = c[u"events"][u"now"].toDouble();
        in.moreOpen = c[u"more"].toBool();
        in.localZone = kLocal;
        const QJsonObject model = fly::plannerModel(in);
        compareTexts(normalize(fly::plannerTexts(model)), list(c[u"texts"]));
        // 「测算」转不转圈(SSR 里那颗按钮带不带 ant-btn-loading):开着自动刷新时不转
        QCOMPARE(model[u"running"].toBool(), c[u"runLoading"].toBool());
    }

    void charts() {
        int checked = 0;
        for (const QJsonValue& cv : fixture()[u"charts"].toArray()) {
            const QJsonObject c = cv.toObject();
            const QJsonObject m = fly::chartModel(c[u"result"].toObject());
            const QJsonObject d = m[u"d"].toObject();
            QCOMPARE(compact(QJsonArray{d[u"area"], d[u"area"]}), compact(QJsonArray{c[u"areas"][0][u"d"], c[u"areas"][1][u"d"]}));
            QCOMPARE(compact(QJsonArray{d[u"expiry"], d[u"now"], d[u"target"]}), compact(QJsonArray{c[u"paths"][0][u"d"], c[u"paths"][1][u"d"], c[u"paths"][2][u"d"]}));
            const auto num = [](const QJsonValue& v) { return jsNumberToString(v.toDouble()); };
            QJsonArray lines{QJsonObject{{u"x1"_s, u"0"_s}, {u"y1"_s, num(m[u"costY"])}, {u"x2"_s, u"600"_s}, {u"y2"_s, num(m[u"costY"])}, {u"stroke"_s, u"var(--label-tertiary)"_s}}};
            for (const QJsonValue& k : m[u"strikes"].toArray())
                lines.append(QJsonObject{{u"x1"_s, num(k[u"x"])}, {u"y1"_s, num(m[u"strikeY1"])}, {u"x2"_s, num(k[u"x"])}, {u"y2"_s, num(m[u"strikeY2"])}, {u"stroke"_s, u"var(--separator)"_s}});
            if (m[u"spot"].isObject())
                lines.append(QJsonObject{{u"x1"_s, num(m[u"spot"][u"x"])}, {u"y1"_s, num(m[u"markY1"])}, {u"x2"_s, num(m[u"spot"][u"x"])}, {u"y2"_s, num(m[u"markY2"])}, {u"stroke"_s, u"var(--label-secondary)"_s}});
            if (m[u"target"].isObject())
                lines.append(QJsonObject{{u"x1"_s, num(m[u"target"][u"x"])}, {u"y1"_s, num(m[u"markY1"])}, {u"x2"_s, num(m[u"target"][u"x"])}, {u"y2"_s, num(m[u"markY2"])}, {u"stroke"_s, u"var(--blue)"_s}});
            QCOMPARE(compact(lines), compact(c[u"lines"]));
            QJsonArray labels;
            for (const QJsonValue& k : m[u"strikes"].toArray()) labels.append(QJsonObject{{u"cls"_s, u"strike"_s}, {u"style"_s, u"left:"_s + k[u"leftText"].toString()}, {u"text"_s, k[u"label"]}});
            if (m[u"spot"].isObject())
                labels.append(QJsonObject{{u"cls"_s, u"mark spot"_s}, {u"style"_s, u"left:%1;top:%2px"_s.arg(m[u"spot"][u"leftText"].toString()).arg(m[u"spot"][u"top"].toInt())}, {u"text"_s, m[u"spot"][u"label"]}});
            if (m[u"target"].isObject())
                labels.append(QJsonObject{{u"cls"_s, u"mark target"_s}, {u"style"_s, u"left:"_s + m[u"target"][u"leftText"].toString()}, {u"text"_s, m[u"target"][u"label"]}});
            labels.append(QJsonObject{{u"cls"_s, u"cost"_s}, {u"style"_s, u"top:"_s + m[u"cost"][u"topText"].toString()}, {u"text"_s, m[u"cost"][u"label"]}});
            QCOMPARE(compact(labels), compact(c[u"labels"]));
            ++checked;
        }
        QVERIFY(checked >= 5);
    }

    void playbookTexts_data() {
        QTest::addColumn<QJsonObject>("c");
        const QJsonArray pages = fixture()[u"playbook"].toArray();
        QVERIFY(pages.size() >= 10);
        for (const QJsonValue& c : pages) QTest::newRow(qPrintable(c[u"name"].toString())) << c.toObject();
    }
    void playbookTexts() {
        QFETCH(QJsonObject, c);
        fly::PlaybookInput in;
        in.playbook = c[u"playbook"].toObject();
        in.status = c[u"status"];
        compareTexts(normalize(fly::playbookTexts(fly::playbookModel(in))), list(c[u"texts"]));
    }

    void statistic() {
        QCOMPARE(fly::statisticParts(u"13.69"_s), (QStringList{u"13"_s, u".69"_s}));
        QCOMPARE(fly::statisticParts(u"1234.5"_s), (QStringList{u"1,234"_s, u".5"_s}));
        QCOMPARE(fly::statisticParts(u"20"_s), QStringList{u"20"_s});
        QCOMPARE(fly::statisticParts(u"+$1,638 · +149%"_s), QStringList{u"+$1,638 · +149%"_s});
        QCOMPARE(fly::statisticParts(u"—"_s), QStringList{u"—"_s});
    }
};

QTEST_GUILESS_MAIN(TestFlyRules)
#include "tst_fly_rules.moc"
