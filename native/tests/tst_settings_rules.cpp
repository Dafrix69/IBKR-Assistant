// 「设置」与「关于」(shell/settings_rules)对着原版现算的期望值(tests/fixtures/gen_settings.mjs,本机时区 Asia/Shanghai):
//   · 设置 15 个页面场景:整页的字、按钮(读着、点不动、主次)、输入框(显示的数、占位字、点不动)、开关(开没开、点不动)、分段、玻璃滑杆;
//   · settingsForm.ts:设置 → 表单、保存前的检查、拼补丁(空着的格子照原值送回、按账户覆盖清掉时送 null)、改过没有;
//   · 关于 11 个页面场景:整页的字、版本信息那一张表、按钮、链接、发布说明与引擎日志、自动检查的开关。
#include "shell/jsvalue.h"
#include "shell/ordered_json.h"
#include "shell/settings_rules.h"

#include <QFile>
#include <QRegularExpression>
#include <QTest>

using namespace ibkr;
using namespace ibkr::shell;
using namespace Qt::StringLiterals;

namespace {

QJsonObject fixture() {
    static const QJsonObject j = [] {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/settings.json"));
        if (!f.open(QIODevice::ReadOnly)) qFatal("settings.json 打不开");
        const auto o = parseOJson(QString::fromUtf8(f.readAll()));
        if (!o) qFatal("settings.json 读不出来");
        return o->toQJson().toObject();
    }();
    return j;
}
const QTimeZone kZone("Asia/Shanghai");

void compareTexts(const QStringList& got, const QJsonArray& want) {
    QStringList expected;
    for (const QJsonValue& t : want) expected << t.toString();
    for (qsizetype i = 0; i < std::max(got.size(), expected.size()); ++i) {
        if (got.value(i) != expected.value(i))
            QFAIL(qPrintable(u"第 %1 段:期望「%2」,实际「%3」\n前后:%4"_s.arg(i).arg(expected.value(i), got.value(i), expected.mid(std::max<qsizetype>(0, i - 3), 6).join(u" | "_s))));
    }
}
QStringList simplified(const QStringList& in) {
    QStringList out;
    for (const QString& s : in) out << s.simplified();
    return out;
}

/// rc-input-number 显示的数:值本身的小数位与步长的小数位取大的那个(同 kit/InputNumber.qml 的 show)
int decimals(double x) {
    const QString s = jsNumberToString(x);
    const qsizetype dot = s.indexOf(u'.');
    return dot < 0 ? 0 : int(s.size() - dot - 1);
}
QString shown(const QJsonValue& v, double step) {
    if (!v.isDouble()) return {};
    return jsToFixed(v.toDouble(), std::max(decimals(v.toDouble()), decimals(step)));
}

settings::PageInput inputOf(const QJsonObject& c) {
    const QJsonObject seed = c[u"seed"_s].toObject();
    const QJsonObject s = seed[u"settings"_s].toObject(), d = seed[u"data"_s].toObject(), e = seed[u"eventscfg"_s].toObject();
    const QJsonObject a = c[u"appearance"_s].toObject();
    settings::PageInput in;
    in.saved = s.contains(u"saved"_s) ? s[u"saved"_s] : QJsonValue(QJsonValue::Null);
    in.form = s.contains(u"form"_s) ? s[u"form"_s] : QJsonValue(QJsonValue::Null);
    in.saving = s[u"saving"_s].toBool();
    in.checked = s[u"checked"_s].toBool();
    in.dataInfo = d.contains(u"info"_s) ? d[u"info"_s] : QJsonValue(QJsonValue::Null);
    in.dataError = d[u"error"_s].toString();
    in.dataBusy = d.contains(u"busy"_s) ? d[u"busy"_s] : QJsonValue(QJsonValue::Null);
    in.eventsDraft = e.contains(u"draft"_s) ? e[u"draft"_s] : QJsonValue(QJsonValue::Null);
    in.themeMode = a[u"themeMode"_s].toString();
    in.upDown = a[u"updown"_s].toString();
    in.glass = a[u"glass"_s].toDouble();
    return in;
}

/// 页面上的输入框按出现的次序(SSR 只留有值或有占位字的):风控限额、按账户覆盖、保护规则、风险预算、重要事件
QJsonArray inputsOf(const QJsonObject& m) {
    QJsonArray out;
    const auto add = [&out](const QJsonValue& value, double step, const QString& placeholder, bool disabled) {
        const QString text = shown(value, step);
        if (text.isEmpty() && placeholder.isEmpty()) return;
        out.append(QJsonObject{{u"type"_s, u"text"_s}, {u"value"_s, text}, {u"placeholder"_s, placeholder}, {u"disabled"_s, disabled}, {u"checked"_s, false}});
    };
    const auto rows = [&add](const QJsonArray& list) {
        for (const QJsonValue& v : list) {
            const QJsonObject r = v.toObject();
            if (r[u"kind"_s].toString() == u"number") add(r[u"value"_s], r[u"step"_s].toDouble(), r[u"placeholder"_s].toString(), r[u"disabled"_s].toBool());
        }
    };
    if (!m[u"loading"_s].toBool()) {
        rows(m[u"limits"_s].toArray());
        for (const QJsonValue& a : m[u"accounts"_s].toArray())
            for (const QJsonValue& f : a.toObject()[u"fields"_s].toArray()) add(f.toObject()[u"value"_s], f.toObject()[u"step"_s].toDouble(), u"同全局"_s, false);
        rows(m[u"protections"_s].toArray());
        rows(m[u"budget"_s].toArray());
    }
    if (m[u"events"_s].isArray()) rows(m[u"events"_s].toArray());
    return out;
}

QJsonArray switchesOf(const QJsonObject& m, bool disabled) {
    QJsonArray out;
    const auto rows = [&](const QJsonArray& list) {
        for (const QJsonValue& v : list)
            if (v.toObject()[u"kind"_s].toString() == u"switch") out.append(v.toObject()[disabled ? u"disabled"_s : u"checked"_s].toBool());
    };
    if (!m[u"loading"_s].toBool()) {
        rows(m[u"gates"_s].toArray());
        rows(m[u"protections"_s].toArray());
        rows(m[u"budget"_s].toArray());
    }
    if (m[u"events"_s].isArray()) rows(m[u"events"_s].toArray());
    return out;
}

QJsonArray segmentsOf(const QJsonObject& m) {
    const QJsonObject a = m[u"appearance"_s].toObject();
    const QString theme = a[u"themeMode"_s].toString(), ud = a[u"upDown"_s].toString();
    QJsonArray out{QJsonArray{theme == u"system", theme == u"light", theme == u"dark"}, QJsonArray{ud == u"green-up", ud == u"red-up"}};
    if (!m[u"loading"_s].toBool())
        for (const QJsonValue& v : m[u"protections"_s].toArray()) {
            const QJsonObject r = v.toObject();
            if (r[u"kind"_s].toString() != u"segment") continue;
            QJsonArray sel;
            for (const QJsonValue& o : r[u"options"_s].toArray()) sel.append(o.toObject()[u"value"_s] == r[u"selected"_s]);
            out.append(sel);
        }
    return out;
}

QJsonObject button(const QString& text, bool loading = false, bool disabled = false, bool primary = false) {
    return QJsonObject{{u"text"_s, text}, {u"loading"_s, loading}, {u"disabled"_s, disabled}, {u"primary"_s, primary}, {u"danger"_s, false}};
}

QJsonArray buttonsOf(const QJsonObject& m) {
    QJsonArray out;
    const bool saving = m[u"saving"_s].toBool();
    if (m[u"dirty"_s].toBool()) out.append(button(u"保存设置"_s, saving, false, true));
    if (!m[u"loading"_s].toBool()) {
        out.append(button(u"保存设置"_s, saving, false, true));
        out.append(button(u"打开配置文件所在位置"_s));
    }
    const QJsonObject d = m[u"data"_s].toObject();
    if (d[u"state"_s].toString() == u"error") out.append(button(u"重试"_s));
    if (d[u"state"_s].toString() == u"ready") {
        out.append(button(u"立即备份"_s, d[u"backupLoading"_s].toBool()));
        out.append(button(u"打开备份目录"_s));
        for (const QJsonValue& v : d[u"rows"_s].toArray()) out.append(button(u"恢复到这一份…"_s, v.toObject()[u"loading"_s].toBool(), v.toObject()[u"disabled"_s].toBool()));
    }
    return out;
}

settings::AboutInput aboutInputOf(const QJsonObject& c) {
    const QJsonObject seed = c[u"seed"_s].toObject();
    const QJsonObject about = seed[u"about"_s].toObject();
    settings::AboutInput in;
    in.info = about.contains(u"info"_s) ? about[u"info"_s] : QJsonValue(QJsonValue::Null);
    in.error = about[u"error"_s].toString();
    in.update = c[u"update"_s];
    in.log = c[u"log"_s].toString();
    in.supportBusy = seed[u"support"_s].toObject()[u"busy"_s].toBool();
    in.zone = kZone;
    return in;
}

}  // namespace

class TstSettingsRules : public QObject {
    Q_OBJECT
private slots:
    void toForm() {
        for (const QJsonValue& v : fixture()[u"form"_s].toObject()[u"toForm"_s].toArray()) {
            const QJsonObject c = v.toObject();
            QCOMPARE(settings::toForm(c[u"saved"_s]), c[u"form"_s].toObject());
        }
    }

    void problems() {
        for (const QJsonValue& v : fixture()[u"form"_s].toObject()[u"problems"_s].toArray()) {
            const QJsonObject c = v.toObject();
            QStringList want;
            for (const QJsonValue& p : c[u"problems"_s].toArray()) want << p.toString();
            QStringList order;
            for (const QJsonValue& a : c[u"order"_s].toArray()) order << a.toString();
            QCOMPARE(settings::formProblems(c[u"form"_s].toObject(), order), want);
        }
    }

    void patch() {
        int i = 0;
        for (const QJsonValue& v : fixture()[u"form"_s].toObject()[u"patch"_s].toArray()) {
            const QJsonObject c = v.toObject();
            const QJsonObject got = settings::toPatch(c[u"form"_s].toObject(), c[u"saved"_s]);
            if (got != c[u"patch"_s].toObject())
                QFAIL(qPrintable(u"第 %1 个补丁\n期望 %2\n实际 %3"_s.arg(i).arg(QString::fromUtf8(QJsonDocument(c[u"patch"_s].toObject()).toJson(QJsonDocument::Compact)),
                                                                     QString::fromUtf8(QJsonDocument(got).toJson(QJsonDocument::Compact)))));
            ++i;
        }
    }

    void dirty() {
        for (const QJsonValue& v : fixture()[u"form"_s].toObject()[u"dirty"_s].toArray()) {
            const QJsonObject c = v.toObject();
            QCOMPARE(settings::isDirty(c[u"form"_s].toObject(), c[u"saved"_s]), c[u"dirty"_s].toBool());
        }
    }

    // 重复防抖窗口填 0 是允许的(确实要关就填 0),空着才不让存
    void dupeZeroIsAllowed() {
        QJsonObject f = settings::toForm(fixture()[u"form"_s].toObject()[u"toForm"_s].toArray()[0].toObject()[u"saved"_s]);
        f[u"dupe"_s] = 0;
        QVERIFY(!settings::formProblems(f).join(u'\n').contains(u"重复防抖窗口"_s));
        f[u"dupe"_s] = QJsonValue::Null;
        QVERIFY(settings::formProblems(f).join(u'\n').contains(u"重复防抖窗口"_s));
    }

    void bytes() {
        QCOMPARE(settings::fmtBytes(512), u"1 KB"_s);
        QCOMPARE(settings::fmtBytes(1843200), u"1.8 MB"_s);
        QCOMPARE(settings::fmtBytes(25 * 1024 * 1024 + 300000), u"25.3 MB"_s);
    }

    void pages_data() {
        QTest::addColumn<int>("index");
        const QJsonArray pages = fixture()[u"settings"_s].toArray();
        for (int i = 0; i < pages.size(); ++i) QTest::newRow(qPrintable(pages[i].toObject()[u"name"_s].toString())) << i;
    }
    void pages() {
        QFETCH(int, index);
        const QJsonObject c = fixture()[u"settings"_s].toArray()[index].toObject();
        const QJsonObject m = settings::pageModel(inputOf(c), kZone);
        compareTexts(simplified(settings::pageTexts(m)), c[u"texts"_s].toArray());
        QCOMPARE(buttonsOf(m), c[u"buttons"_s].toArray());
        QCOMPARE(inputsOf(m), c[u"inputs"_s].toArray());
        QCOMPARE(switchesOf(m, false), c[u"switches"_s].toArray());
        QCOMPARE(switchesOf(m, true), c[u"switchesDisabled"_s].toArray());
        QCOMPARE(segmentsOf(m), c[u"segments"_s].toArray());
        QCOMPARE(QJsonArray{m[u"appearance"_s].toObject()[u"glass"_s]}, c[u"sliders"_s].toArray());
        QJsonArray notices;
        if (!m[u"problems"_s].toArray().isEmpty()) notices.append(u"warning"_s);
        QCOMPARE(notices, c[u"notices"_s].toArray());
    }

    void about_data() {
        QTest::addColumn<int>("index");
        const QJsonArray pages = fixture()[u"about"_s].toArray();
        for (int i = 0; i < pages.size(); ++i) QTest::newRow(qPrintable(pages[i].toObject()[u"name"_s].toString())) << i;
    }
    void about() {
        QFETCH(int, index);
        const QJsonObject c = fixture()[u"about"_s].toArray()[index].toObject();
        const QJsonObject m = settings::aboutModel(aboutInputOf(c));
        compareTexts(simplified(settings::aboutTexts(m)), c[u"texts"_s].toArray());
        // 版本信息表 + 快捷键表(Descriptions):名字与内容
        QJsonArray descs;
        for (const QJsonValue& v : m[u"rows"_s].toArray())
            descs.append(QJsonObject{{u"label"_s, v.toObject()[u"label"_s]}, {u"value"_s, v.toObject()[u"value"_s].toString() + v.toObject()[u"link"_s].toString()}});
        for (const QJsonValue& v : m[u"shortcuts"_s].toArray()) {
            QString keys;
            for (const QJsonValue& k : v.toObject()[u"keys"_s].toArray()) keys += k.toString();
            descs.append(QJsonObject{{u"label"_s, keys}, {u"value"_s, v.toObject()[u"what"_s]}});
        }
        QCOMPARE(descs, c[u"descs"_s].toArray());
        // 按钮:下载与发布页是链接(<a>),不在按钮里
        QJsonArray buttons, links;
        if (!m[u"rows"_s].toArray().isEmpty()) links.append(QJsonObject{{u"href"_s, u"https://www.tradingview.com/"_s}, {u"text"_s, u"https://www.tradingview.com/"_s}});
        const QJsonObject u = m[u"update"_s].toObject();
        for (const QJsonValue& v : u[u"buttons"_s].toArray()) {
            const QJsonObject b = v.toObject();
            if (b[u"kind"_s].toString() == u"download" || b[u"kind"_s].toString() == u"page") links.append(QJsonObject{{u"href"_s, b[u"url"_s]}, {u"text"_s, b[u"text"_s]}});
            else buttons.append(button(b[u"text"_s].toString(), b[u"loading"_s].toBool()));
        }
        const bool busy = m[u"supportBusy"_s].toBool();
        buttons.append(button(u"导出诊断信息…"_s, busy, false, true));
        for (const QString& t : {u"拷贝概要"_s, u"打开日志所在位置"_s, u"打开配置文件所在位置"_s, u"查看条款"_s, u"第三方许可声明"_s, u"重启交易引擎"_s}) buttons.append(button(t));
        QCOMPARE(buttons, c[u"buttons"_s].toArray());
        QCOMPARE(links, c[u"links"_s].toArray());
        QJsonArray pres;
        if (!u[u"notes"_s].toString().isEmpty()) pres.append(QJsonObject{{u"cls"_s, u"log update-notes"_s}, {u"text"_s, u[u"notes"_s]}});
        pres.append(QJsonObject{{u"cls"_s, u"log"_s}, {u"text"_s, m[u"log"_s]}});
        QCOMPARE(pres, c[u"pres"_s].toArray());
        QCOMPARE(QJsonArray{u[u"auto"_s]}, c[u"switches"_s].toArray());
    }

    // Qt 版的版本信息:没有 Electron / Chromium / Node,换成 Qt 的版本
    void aboutQtRow() {
        settings::AboutInput in;
        in.info = QJsonObject{{u"app"_s, QJsonObject{{u"version"_s, u"0.5.2"_s}, {u"qt"_s, u"6.12.0"_s}, {u"configPath"_s, u"c"_s}}}, {u"self"_s, QJsonObject{}}};
        in.update = QJsonObject{{u"auto"_s, true}};
        const QJsonArray rows = settings::aboutModel(in)[u"rows"_s].toArray();
        QCOMPARE(rows[1].toObject()[u"label"_s].toString(), u"Qt"_s);
        QCOMPARE(rows[1].toObject()[u"value"_s].toString(), u"6.12.0"_s);
        QVERIFY(!settings::aboutTexts(settings::aboutModel(in)).contains(u"Electron"_s));
    }
};

QTEST_GUILESS_MAIN(TstSettingsRules)
#include "tst_settings_rules.moc"
