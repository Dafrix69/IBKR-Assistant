// 订单的状态口径与「订单看板」(shell/order_rules)对着原版现算的期望值(tests/fixtures/gen_board.mjs,本机时区 Asia/Shanghai):
//   · 140 个终态 × 在途状态的组合:叫法、分在哪一档、着色、阶段路径停在哪一步(原组件 SSR 出来的 done / now);
//   · 整页的字(SSR 渲染原页面抽字)、每条阶段路径与每颗胶囊的着色。
#include "shell/order_rules.h"

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
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/board.json"));
        if (!f.open(QIODevice::ReadOnly)) qFatal("board.json 打不开");
        return QJsonDocument::fromJson(f.readAll()).object();
    }();
    return j;
}

QStringList normalize(const QStringList& in) {
    QStringList out;
    static const QRegularExpression ws(u"\\s+"_s);
    for (const QString& s : in) {
        const QString t = QString(s).replace(ws, u" "_s).trimmed();
        if (!t.isEmpty()) out << t;
    }
    return out;
}

/// SSR 里阶段路径的样子 → 走到第几步(done 的个数;now 那一步是 current)
QJsonObject stagesOf(int current, int count, const QString& tint) {
    QJsonArray steps;
    for (int i = 0; i < count; ++i) steps.append(i < current ? u"done"_s : i == current ? u"now"_s : u""_s);
    return {{u"tile"_s, tint}, {u"steps"_s, steps}};
}

}  // namespace

class TestOrderRules : public QObject {
    Q_OBJECT
private slots:
    void statuses() {
        const QJsonArray cases = fixture()[u"status"].toArray();
        QCOMPARE(cases.size(), 140);
        for (const QJsonValue& cv : cases) {
            const QJsonObject c = cv.toObject();
            const QJsonObject r{{u"final_status"_s, c[u"final_status"]}, {u"status"_s, c[u"status"]}};
            const QString where = u"%1 / %2"_s.arg(jsString(c[u"final_status"]), jsString(c[u"status"]));
            QVERIFY2(orders::statusLabel(r, u"—"_s) == c[u"label"].toString(), qPrintable(where));
            QVERIFY2(orders::statusBucket(r) == c[u"bucket"].toString(), qPrintable(where));
            QVERIFY2(orders::bucketTint(orders::statusBucket(r)) == c[u"tint"].toString(), qPrintable(where));
            QVERIFY2(orders::bucketLabel(orders::statusBucket(r)) == c[u"bucketLabel"].toString(), qPrintable(where));
            QVERIFY2(stagesOf(orders::stageCurrent(r), 3, c[u"tint"].toString()) == c[u"stages"].toObject(), qPrintable(where));
            QVERIFY2(c[u"pill"].toString() == c[u"tint"].toString(), qPrintable(where));
        }
    }

    void labels() {
        const QJsonObject l = fixture()[u"labels"].toObject();
        const QJsonObject ops = l[u"TRIGGER_OP_LABEL"].toObject();
        for (auto it = ops.begin(); it != ops.end(); ++it) QCOMPARE(orders::triggerOpLabel(QJsonValue(it.key())), it.value().toString());
        QCOMPARE(orders::triggerOpLabel(QJsonValue(u"crosses"_s)), u"crosses"_s);
        const QJsonObject finals = l[u"FINAL_STATUS_LABEL"].toObject();
        for (auto it = finals.begin(); it != finals.end(); ++it) QCOMPARE(orders::statusLabel({{u"final_status"_s, it.key()}}, u"—"_s), it.value().toString());
        const QJsonObject lives = l[u"LIVE_STATUS_LABEL"].toObject();
        for (auto it = lives.begin(); it != lives.end(); ++it) QCOMPARE(orders::statusLabel({{u"status"_s, it.key()}}, u"—"_s), it.value().toString());
        const QJsonObject actions = l[u"ACTION_LABEL"].toObject();
        for (auto it = actions.begin(); it != actions.end(); ++it) QCOMPARE(orders::actionLabel(QJsonValue(it.key())), it.value().toString());
    }

    void board_data() {
        QTest::addColumn<QJsonObject>("c");
        for (const QJsonValue& c : fixture()[u"pages"].toArray()) QTest::newRow(qPrintable(c[u"name"].toString())) << c.toObject();
    }
    void board() {
        QFETCH(QJsonObject, c);
        orders::BoardInput in;
        in.pending = c[u"pending"].toArray();
        in.pendingError = c[u"pendingError"];
        in.records = c[u"records"].toArray();
        in.recordsError = c[u"recordsError"];
        in.feed = c[u"feed"].toArray();
        in.nowMs = fixture()[u"now"].toDouble();
        in.localZone = QTimeZone("Asia/Shanghai");
        const QJsonObject m = orders::boardModel(in);
        const QStringList got = normalize(orders::boardTexts(m));
        QStringList expected;
        for (const QJsonValue& v : c[u"texts"].toArray()) expected << v.toString();
        for (qsizetype i = 0; i < std::max(got.size(), expected.size()); ++i)
            if (got.value(i) != expected.value(i))
                QFAIL(qPrintable(u"第 %1 段:期望「%2」,实际「%3」\n前后:%4"_s.arg(i).arg(expected.value(i), got.value(i), expected.mid(std::max<qsizetype>(0, i - 3), 6).join(u" | "_s))));
        // 阶段路径与胶囊的着色(条件单那一条恒为排队、橙色)
        QJsonArray stages, pills;
        for (const QJsonValue& p : m[u"pending"][u"cards"].toArray()) {
            Q_UNUSED(p);
            stages.append(stagesOf(0, 4, u"orange"_s));
        }
        for (const QJsonValue& cv : m[u"live"][u"cards"].toArray()) {
            stages.append(stagesOf(cv[u"stageCurrent"].toInt(), 3, cv[u"tint"].toString()));
            if (cv[u"side"].isObject()) pills.append(cv[u"side"][u"buy"].toBool() ? u"up"_s : u"down"_s);
            pills.append(cv[u"tint"]);
        }
        QCOMPARE(stages, c[u"stages"].toArray());
        QCOMPARE(pills, c[u"pills"].toArray());
    }

    void timeShort() {
        const double now = fixture()[u"now"].toDouble();
        const QTimeZone sh("Asia/Shanghai");
        QCOMPARE(orders::fmtTimeShort(QJsonValue(u"2026-08-21T13:30:00Z"_s), now, sh), u"21:30"_s);
        QCOMPARE(orders::fmtTimeShort(QJsonValue(u"2026-08-20T23:10:00Z"_s), now, sh), u"07:10"_s);  // 本机已是 21 日
        QCOMPARE(orders::fmtTimeShort(QJsonValue(u"2026-08-19T23:10:00Z"_s), now, sh), u"08-20 07:10"_s);
        QCOMPARE(orders::fmtTimeShort(QJsonValue(), now, sh), u"—"_s);
        QCOMPARE(orders::fmtTimeShort(QJsonValue(u"not a date"_s), now, sh), u"not a date"_s);
    }
};

QTEST_GUILESS_MAIN(TestOrderRules)
#include "tst_order_rules.moc"
