// 「板块」(shell/sectors_rules)对着原版现算的期望值(tests/fixtures/gen_sectors.mjs,本机时区 Asia/Shanghai、时钟 2026-08-21 21:50):
//   22 个页面场景,输入是那一刻各份 store 的快照;比整页的字、每个开关(开没开、转圈)、心跳那一行的状态点、
//   行里数字的着色(涨跌、量比、窗口量比的 hot / soft)、异动点的方向、读着的按钮(选股着、重算墙)。
#include "shell/sectors_rules.h"

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
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/sectors.json"));
        if (!f.open(QIODevice::ReadOnly)) qFatal("sectors.json 打不开");
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

void compareTexts(const QStringList& got, const QStringList& expected) {
    for (qsizetype i = 0; i < std::max(got.size(), expected.size()); ++i) {
        if (got.value(i) != expected.value(i))
            QFAIL(qPrintable(u"第 %1 段:期望「%2」,实际「%3」\n前后:%4"_s.arg(i).arg(expected.value(i), got.value(i), expected.mid(std::max<qsizetype>(0, i - 3), 6).join(u" | "_s))));
    }
}

}  // namespace

class TestSectorsRules : public QObject {
    Q_OBJECT

private slots:
    void pages_data() {
        QTest::addColumn<int>("index");
        const QJsonArray pages = fixture()[u"pages"_s].toArray();
        QVERIFY(pages.size() >= 20);
        for (qsizetype i = 0; i < pages.size(); ++i) QTest::newRow(qPrintable(pages[i][u"name"_s].toString())) << int(i);
    }
    void pages() {
        QFETCH(int, index);
        const QJsonObject c = fixture()[u"pages"_s].toArray()[index].toObject();
        const QJsonObject snap = c[u"snapshot"_s].toObject(), seed = c[u"seed"_s].toObject();
        sectors::PageInput in;
        in.sectors = snap[u"sectors"_s].toArray();
        in.quotes = snap[u"quotes"_s].toObject();
        in.quality = snap[u"quality"_s].toObject();
        in.alerts = snap[u"alerts"_s].toObject();
        in.status = snap[u"status"_s].toObject();
        in.popupOn = snap[u"popup"_s].toBool();
        in.soundOn = snap[u"sound"_s].toBool();
        for (const QJsonValue& id : seed[u"picking"_s].toArray()) in.picking.insert(id.toString());
        in.busy = seed[u"busy"_s].toObject();
        in.editingTag = seed[u"editingTag"_s].toString();
        in.nowMs = fixture()[u"now"_s].toDouble();
        in.zone = QTimeZone("Asia/Shanghai");
        const QJsonObject page = sectors::pageModel(in);
        QStringList want;
        for (const QJsonValue& x : c[u"texts"_s].toArray()) want << x.toString();
        compareTexts(normalize(sectors::pageTexts(page)), want);

        // 开关:每一行两个(带 aria-label),之后是提醒方式两个、触发条件的扣大盘、穿越确认、碰均线
        QJsonArray switches;
        for (const QJsonValue& s : page[u"sectors"_s].toArray())
            for (const QJsonValue& r : s[u"rows"_s].toArray()) {
                const QString sym = r[u"symbol"_s].toString();
                switches.append(QJsonObject{{u"label"_s, sym + u" 盯价位"_s}, {u"checked"_s, r[u"priceOn"_s]}, {u"loading"_s, r[u"priceBusy"_s]}});
                switches.append(QJsonObject{{u"label"_s, sym + u" 盯异动"_s}, {u"checked"_s, r[u"anomalyOn"_s]}, {u"loading"_s, r[u"anomalyBusy"_s]}});
            }
        const auto plain = [&](bool on) { switches.append(QJsonObject{{u"label"_s, u""_s}, {u"checked"_s, on}, {u"loading"_s, false}}); };
        plain(page[u"popupOn"_s].toBool());
        plain(page[u"soundOn"_s].toBool());
        if (page[u"conditions"_s].isObject()) plain(page[u"conditions"_s][u"marketAdjust"_s].toBool());
        plain(page[u"crossConfirm"_s].toBool());
        if (page[u"touch"_s].isObject()) plain(page[u"touch"_s][u"enabled"_s].toBool());
        QCOMPARE(switches, c[u"switches"_s].toArray());

        // 心跳的状态点
        QJsonArray badges;
        for (const QJsonValue& i : page[u"monitor"_s][u"items"_s].toArray())
            if (i.toObject().contains(u"badge"_s)) badges.append(i[u"badge"_s]);
        QCOMPARE(badges, c[u"badges"_s].toArray());

        // 行里的着色与异动点(照 DOM 次序:异动点在代码后面、数字在各自那一格)
        QJsonArray classes;
        for (const QJsonValue& s : page[u"sectors"_s].toArray())
            for (const QJsonValue& r : s[u"rows"_s].toArray()) {
                if (r[u"dot"_s].isObject()) classes.append(u"q-dot "_s + r[u"dot"_s][u"tone"_s].toString());
                if (r[u"chg"_s].isObject()) {
                    const QString tone = r[u"chg"_s][u"tone"_s].toString();
                    classes.append(tone.isEmpty() ? u"num"_s : u"num "_s + tone);
                }
                for (const QString& key : {u"rvol"_s, u"burst"_s}) {
                    const QJsonObject x = r[key].toObject();
                    if (x[u"kind"_s] != u"num"_s) continue;
                    classes.append(x[u"hot"_s].toBool() ? u"num hot"_s : x[u"soft"_s].toBool() ? u"num soft"_s : u"num"_s);
                }
            }
        QCOMPARE(classes, c[u"classes"_s].toArray());

        // 读着的按钮:选股着、重算墙 / 立刻算(价位在算)
        QStringList loading, wantLoading;
        for (const QJsonValue& b : c[u"buttons"_s].toArray())
            if (b[u"loading"_s].toBool()) wantLoading << b[u"text"_s].toString();
        for (const QJsonValue& s : page[u"sectors"_s].toArray()) {
            if (s[u"picking"_s].toBool()) loading << s[u"pickLabel"_s].toString();
            for (const QJsonValue& r : s[u"rows"_s].toArray()) {
                const QJsonObject lv = r[u"levels"_s].toObject();
                if (!lv[u"computing"_s].toBool()) continue;
                loading << (lv[u"kind"_s] == u"pending"_s ? u"立刻算"_s : u"计算中…"_s);
            }
        }
        QCOMPARE(loading, wantLoading);
    }

    void formats() {
        QCOMPARE(sectors::fmtPrice(QJsonValue(1234.5)), u"1,234.50"_s);
        QCOMPARE(sectors::fmtPrice(QJsonValue(0.0042)), u"0.0042"_s);
        QCOMPARE(sectors::fmtPrice(QJsonValue(0.5)), u"0.50"_s);
        QCOMPARE(sectors::fmtPrice(QJsonValue(0.12345)), u"0.1235"_s);
        QCOMPARE(sectors::fmtPrice(QJsonValue(-12.345)), u"-12.35"_s);
        QCOMPARE(sectors::fmtPrice(QJsonValue()), u"—"_s);
        QCOMPARE(sectors::fmtPrice(QJsonValue(u"12"_s)), u"—"_s);
    }
};

QTEST_GUILESS_MAIN(TestSectorsRules)
#include "tst_sectors_rules.moc"
