// 「交易记录」(shell/records_rules)对着原版现算的期望值(tests/fixtures/gen_records.mjs,本机时区 Asia/Shanghai、zh-CN 的排序):
//   · 36 个页面场景:整页的字(SSR 渲染原页面抽字)、行的次序与打开的那一行、两个 Segmented 选中 / 拦住的档位、
//     去向分段条每段的份量与着色、疏密;打开的详情一起比(原始记录照引擎的键序写,逐字比);
//   · ticketFromRecord 拼出来的票据。
#include "shell/records_rules.h"

#include "shell/jsvalue.h"
#include "shell/ordered_json.h"

#include <QFile>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QTest>

using namespace ibkr;
using namespace ibkr::shell;
using namespace Qt::StringLiterals;

namespace {

QByteArray fixtureBytes() {
    static const QByteArray bytes = [] {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/records.json"));
        if (!f.open(QIODevice::ReadOnly)) qFatal("records.json 打不开");
        return f.readAll();
    }();
    return bytes;
}
QJsonObject fixture() {
    static const QJsonObject j = QJsonDocument::fromJson(fixtureBytes()).object();
    return j;
}
/// 保序读一遍:详情的原始记录要照引擎(这里是生成器)写的键序
const OJson& orderedFixture() {
    static const OJson j = *parseOJson(QString::fromUtf8(fixtureBytes()));
    return j;
}

const QTimeZone kZone("Asia/Shanghai");
const QCollator& collator() {
    static const QCollator c(QLocale(u"zh_CN"_s));
    return c;
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

QString compact(const QJsonValue& v) { return QString::fromUtf8(QJsonDocument(QJsonArray{v}).toJson(QJsonDocument::Compact)); }

}  // namespace

class TestRecordsRules : public QObject {
    Q_OBJECT
private slots:
    void pages_data() {
        QTest::addColumn<int>("index");
        const QJsonArray pages = fixture()[u"pages"].toArray();
        QVERIFY(pages.size() >= 30);
        for (int i = 0; i < pages.size(); ++i) QTest::newRow(qPrintable(pages[i][u"name"].toString())) << i;
    }
    void pages() {
        QFETCH(int, index);
        const QJsonObject c = fixture()[u"pages"].toArray()[index].toObject();
        const QJsonObject seed = c[u"seed"].toObject();
        records::PageInput in;
        in.records = c[u"records"].toArray();
        in.error = c[u"recordsError"].toString();
        in.filter = seed.value(u"filter").toString(u"all"_s);
        in.keyword = seed.value(u"keyword").toString();
        in.compact = seed.value(u"density") == QJsonValue(u"compact"_s);
        if (seed.contains(u"sort")) in.sort = {seed[u"sort"][u"key"].toString(), seed[u"sort"][u"order"].toString()};
        in.openId = seed.value(u"openId").toString();
        in.nowMs = fixture()[u"now"].toDouble();
        in.zone = kZone;
        in.collator = &collator();
        const QJsonObject page = records::pageModel(in);

        QJsonObject detail;
        if (c[u"detail"].isObject()) {
            records::DetailInput d;
            d.state = c[u"detail"][u"state"].toString();
            d.error = c[u"detail"][u"error"].toString();
            const OJson* rec = orderedFixture().get(u"pages"_s);
            rec = rec ? &rec->items[index] : nullptr;
            rec = rec ? rec->get(u"detail"_s) : nullptr;
            rec = rec ? rec->get(u"record"_s) : nullptr;
            if (rec) d.record = *rec;
            d.zone = kZone;
            d.nowMs = in.nowMs;
            detail = records::detailModel(d);
            if (c[u"rawJson"].isString()) QCOMPARE(detail[u"raw"].toString(), c[u"rawJson"].toString());
        }
        compareTexts(normalize(records::pageTexts(page, detail)), normalize([&] {
            QStringList t;
            for (const QJsonValue& x : c[u"texts"].toArray()) t << x.toString();
            return t;
        }()));

        // 行的次序与打开的那一行
        QJsonArray rows;
        for (const QJsonValue& r : page[u"rows"].toArray()) rows.append(QJsonObject{{u"id"_s, r[u"id"]}, {u"open"_s, r[u"open"]}});
        QCOMPARE(compact(rows), compact(c[u"rows"]));
        // 两个 Segmented:疏密、筛选
        const QJsonArray seg = c[u"segments"].toArray();
        QCOMPARE(seg.size(), 2);
        QCOMPARE(compact(seg[0]), compact(QJsonArray{QJsonObject{{u"selected"_s, !in.compact}, {u"disabled"_s, false}},
                                                     QJsonObject{{u"selected"_s, in.compact}, {u"disabled"_s, false}}}));
        QJsonArray filters;
        for (const QJsonValue& f : page[u"filters"].toArray()) filters.append(QJsonObject{{u"selected"_s, f[u"selected"]}, {u"disabled"_s, f[u"disabled"]}});
        QCOMPARE(compact(filters), compact(seg[1]));
        QCOMPARE(page[u"compact"].toBool(), c[u"compact"].toBool());
        // 去向分段条
        if (c[u"segBar"].isNull()) {
            QVERIFY(page[u"mix"].isNull());
        } else {
            QJsonArray parts;
            for (const QJsonValue& p : page[u"mix"][u"parts"].toArray()) parts.append(QJsonObject{{u"grow"_s, p[u"grow"]}, {u"tint"_s, p[u"tint"]}, {u"title"_s, p[u"title"]}});
            QCOMPARE(compact(parts), compact(c[u"segBar"]));
        }
        // 每行两处悬停提示:时间列(fmtTime 的全写)、意图列(整句)
        QStringList titles;
        for (const QJsonValue& r : page[u"rows"].toArray()) titles << r[u"timeTitle"].toString() << r[u"intent"].toString();
        QStringList want;
        for (const QJsonValue& t : c[u"titles"].toArray()) want << t.toString();
        QCOMPARE(want.mid(0, titles.size()), titles);
    }

    void tickets() {
        const QJsonArray cases = fixture()[u"tickets"].toArray();
        QVERIFY(cases.size() >= 6);
        for (const QJsonValue& cv : cases) {
            const QJsonObject c = cv.toObject();
            const QJsonValue got = records::ticketFromRecord(c[u"contract"], c[u"order"], c[u"trigger"]);
            QVERIFY2(compact(got) == compact(c[u"ticket"]), qPrintable(c[u"name"].toString() + u"\n"_s + compact(got) + u"\n"_s + compact(c[u"ticket"])));
        }
    }

    void sortCycle() {
        // antd:同一列 升 → 降 → 不排 → 升;换一列从升开始
        records::Sort s;
        s = records::nextSort(s, u"created_at"_s);
        QCOMPARE(s.order, QString());
        s = records::nextSort(s, u"created_at"_s);
        QCOMPARE(s.order, u"ascend"_s);
        s = records::nextSort(s, u"created_at"_s);
        QCOMPARE(s.order, u"descend"_s);
        s = records::nextSort(s, u"symbol"_s);
        QCOMPARE(s.key, u"symbol"_s);
        QCOMPARE(s.order, u"ascend"_s);
    }

    void fmtTime() {
        QCOMPARE(records::fmtTime(u"2026-08-20T16:00:05Z"_s, kZone), u"2026/8/21 00:00:05"_s);
        QCOMPARE(records::fmtTime(u"2026-08-21"_s, kZone), u"2026/8/21 08:00:00"_s);
        QCOMPARE(records::fmtTime(u"2026-08-21T13:41:02"_s, kZone), u"2026/8/21 13:41:02"_s);
        QCOMPARE(records::fmtTime(u"20260821"_s, kZone), u"20260821"_s);
        QCOMPARE(records::fmtTime(QJsonValue::Null, kZone), u"—"_s);
    }
};

QTEST_GUILESS_MAIN(TestRecordsRules)
#include "tst_records_rules.moc"
