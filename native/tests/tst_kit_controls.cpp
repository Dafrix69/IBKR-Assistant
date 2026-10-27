// 表单控件是受控的,列表按键原地更新——这两条直接决定"框里显示的"和"真正发出去的"是不是同一个数:
//   · InputNumber / Checkbox / Select 从不给自己的 value / checked 赋值(一赋值外面的绑定就断了:勾上「分档」把利润回撤清成 null,
//     框里却还显示 30);越界的数打完才夹、框里改写成真正的值;
//   · KeyedListModel 当 Repeater 的 model:数据变了 delegate 不重建(持仓每秒刷新时,卡片里展开着的表单不回初值)。
#include "shell/keyed_list_model.h"

#include <QAbstractItemModelTester>
#include <QJsonArray>
#include <QQmlComponent>
#include <QQmlContext>
#include <QQmlEngine>
#include <QQuickItem>
#include <QQuickView>
#include <QSignalSpy>
#include <QRegularExpression>
#include <QTest>

#include "escape_watcher.h"
#include "kit/chart_view.h"
#include "shell/chart_source.h"
#include <QtQml/qqmlextensionplugin.h>

Q_IMPORT_QML_PLUGIN(Dafri_KitPlugin)

using namespace ibkr;
using namespace Qt::StringLiterals;

namespace {

std::unique_ptr<QObject> make(QQmlEngine& engine, const QByteArray& qml) {
    QQmlComponent c(&engine);
    c.setData(qml, QUrl(u"inline.qml"_s));
    std::unique_ptr<QObject> o(c.create());
    if (!o) qFatal("%s", qPrintable(c.errorString()));
    return o;
}

QObject* child(QObject* root, const char* name) { return root->findChild<QObject*>(QString::fromLatin1(name)); }

const QByteArray kForm = R"(
import QtQuick
import Dafri.Kit
Item {
    id: root
    property var v: ({ x: null, c: false, s: "MKT" })
    function set(part) { var n = Object.assign({}, v); for (var k in part) n[k] = part[k]; v = n }
    property bool obey: true
    InputNumber { objectName: "num"; min: 0; max: 100; value: root.v.x; onValueEdited: function (x) { if (root.obey) root.set({ x: x }) } }
    Checkbox { objectName: "box"; checked: root.v.c; onToggled: function (on) { if (root.obey) root.set({ c: on }) } }
    Select { objectName: "sel"; value: root.v.s; options: [{ value: "MKT", label: "市价" }, { value: "LMT", label: "限价" }]
             onActivated: function (x) { if (root.obey) root.set({ s: x }) } }
}
)";

/// 页面那一侧的 set(part):外面改状态
void setState(QObject* root, const QVariantMap& part) { QMetaObject::invokeMethod(root, "set", Q_ARG(QVariant, QVariant(part))); }

void type(QObject* num, const QString& text) {
    num->setProperty("text", text);
    QMetaObject::invokeMethod(num, "edited", Q_ARG(QString, text));
}

}  // namespace

class TestKitControls : public QObject {
    Q_OBJECT
private slots:
    void rapidExitForm() {
        QQuickView view;
        QQmlComponent component(view.engine(), QUrl::fromLocalFile(QStringLiteral(IBKR_FIXTURES_DIR "/../../app/pages/TrackForm.qml")));
        std::unique_ptr<QObject> form(component.createWithInitialProperties({
            {u"position"_s, QVariantMap{{u"key"_s, u"paper|SPX|BAG"_s}, {u"symbol"_s, u"SPX"_s}, {u"sec_type"_s, u"BAG"_s},
                {u"quantity"_s, 1}, {u"account"_s, u"paper"_s}}}, {u"width"_s, 960}}));
        QVERIFY2(form, qPrintable(component.errorString()));
        auto* item = qobject_cast<QQuickItem*>(form.get());
        QVERIFY(item);
        item->setParentItem(view.contentItem());
        auto* fields = form->findChild<QObject*>(u"exitFields"_s);
        auto* window = form->findChild<QQuickItem*>(u"rapidWindowInput"_s);
        auto* pct = form->findChild<QQuickItem*>(u"rapidPctInput"_s);
        QVERIFY(fields && window && pct);
        fields->setProperty("open", true);
        QVERIFY(QMetaObject::invokeMethod(window, "valueEdited", Q_ARG(QVariant, QVariant(1.0))));
        QVERIFY(QMetaObject::invokeMethod(pct, "valueEdited", Q_ARG(QVariant, QVariant(5.0))));
        const QJSValue values = form->property("v").value<QJSValue>().property(u"exits"_s);
        QCOMPARE(values.property(u"rapidWindow"_s).toNumber(), 1.0);
        QCOMPARE(values.property(u"rapidPct"_s).toNumber(), 5.0);
        view.resize(960, 900);
        view.show();
        QVERIFY(QTest::qWaitForWindowExposed(&view));
        QTest::qWait(100);
        item->setY(-std::max(0.0, window->mapToItem(item, QPointF()).y() - 220));
        QTest::qWait(100);
        const QString shot = qEnvironmentVariable("DATRIX_RAPID_FORM_SCREENSHOT");
        if (!shot.isEmpty()) QVERIFY(view.grabWindow().save(shot));
    }
    void underlyingStopHostingForm() {
        QQuickView view;
        QQmlComponent component(view.engine(), QUrl::fromLocalFile(QStringLiteral(IBKR_FIXTURES_DIR "/../../app/pages/TrackForm.qml")));
        std::unique_ptr<QObject> form(component.createWithInitialProperties({
            {u"position"_s, QVariantMap{{u"key"_s, u"paper|SPX|BAG"_s}, {u"symbol"_s, u"SPX"_s}, {u"sec_type"_s, u"BAG"_s},
                {u"quantity"_s, 2}, {u"account"_s, u"paper"_s}}}, {u"width"_s, 960}}));
        QVERIFY2(form, qPrintable(component.errorString()));
        auto* item = qobject_cast<QQuickItem*>(form.get());
        QVERIFY(item);
        item->setParentItem(view.contentItem());
        setState(form.get(), {{u"stopBelow"_s, 6000}, {u"stopAbove"_s, 6200}, {u"brokerSpotStop"_s, true},
            {u"host"_s, true}, {u"autoPicked"_s, true}, {u"spotStopLimit"_s, 1.25}});
        QVERIFY(form->property("hostAllowed").toBool());
        QVERIFY(form->property("hostOn").toBool());
        QObject* hosting = nullptr;
        for (QObject* o : form->findChildren<QObject*>())
            if (o->property("label").toString() == u"止盈/止损托管到券商(IBKR)") hosting = o;
        QVERIFY(hosting);
        view.resize(960, 1500);
        view.show();
        QVERIFY(QTest::qWaitForWindowExposed(&view));
        QTest::qWait(100);
        const QString shot = qEnvironmentVariable("DATRIX_TRACK_FORM_SCREENSHOT");
        if (!shot.isEmpty()) QVERIFY(view.grabWindow().save(shot));
        QVERIFY(QMetaObject::invokeMethod(hosting, "toggled", Q_ARG(bool, false)));
        QVERIFY(!form->property("hostOn").toBool());
        const auto values = form->property("v").value<QJSValue>();
        QVERIFY(!values.property(u"brokerSpotStop"_s).toBool()); // 关闭托管不能仍显示为券商条件单
    }
    void scrolledHeaderSurvivesPageReplacement() {
        QQuickView view;
        QQmlComponent component(view.engine());
        component.setData(R"(
import QtQuick
import Dafri.Kit
Item {
    id: host
    width: 600; height: 300
    property bool pageOn: true
    Loader {
        anchors.fill: parent
        active: host.pageOn
        sourceComponent: Component {
            ScrollPage {
                objectName: "scrollPage"
                PageHead { objectName: "pageHead"; width: parent.width; title: "Header" }
                Repeater { model: 40; Rectangle { width: 400; height: 30; color: "lightgray" } }
            }
        }
    }
}
)", QUrl(u"inline-header.qml"_s));
        std::unique_ptr<QObject> root(component.create());
        QVERIFY2(root, qPrintable(component.errorString()));
        qobject_cast<QQuickItem*>(root.get())->setParentItem(view.contentItem());
        view.resize(600, 300);
        view.show();
        QVERIFY(QTest::qWaitForWindowExposed(&view));
        for (int i = 0; i < 20; ++i) {
            QObject* page = child(root.get(), "scrollPage");
            QVERIFY(page);
            QVERIFY(child(page, "pageHead"));
            page->setProperty("contentY", 140);
            QTest::qWait(20);
            view.resize(600 + i % 2, 300 + i % 3);
            page->setProperty("contentY", 0);
            QTest::qWait(10);
            root->setProperty("pageOn", false);
            QCoreApplication::sendPostedEvents(nullptr, QEvent::DeferredDelete);
            QCoreApplication::processEvents();
            root->setProperty("pageOn", true);
            QCoreApplication::processEvents();
        }
        QVERIFY(child(root.get(), "scrollPage"));
    }

    // 复现 review 的那一条:输入 30 → 勾上「分档」把它清成 null → 框里也得空着,不能还显示 30
    void inputNumberFollowsTheState() {
        QQmlEngine engine;
        auto root = make(engine, kForm);
        QObject* num = child(root.get(), "num");
        type(num, u"30"_s);
        QCOMPARE(root->property("v").toMap().value(u"x"_s).toDouble(), 30.0);
        setState(root.get(), {{u"x"_s, QVariant::fromValue(nullptr)}});
        QCOMPARE(num->property("text").toString(), QString());
        // 绑定还活着:外面再给一个数,框里跟着变
        setState(root.get(), {{u"x"_s, 12.5}});
        QCOMPARE(num->property("text").toString(), u"12.5"_s);
        QCOMPARE(num->property("value").toDouble(), 12.5);
    }

    // 越界:打字途中不发;打完夹到范围里再发,框里改写成真正的值
    void inputNumberClampsOnFinish() {
        QQmlEngine engine;
        auto root = make(engine, kForm);
        QObject* num = child(root.get(), "num");
        QSignalSpy edited(num, SIGNAL(valueEdited(QVariant)));
        type(num, u"150"_s);
        QCOMPARE(edited.size(), 0);
        QVERIFY(root->property("v").toMap().value(u"x"_s).isNull());
        QMetaObject::invokeMethod(num, "editingFinished");
        QCOMPARE(edited.size(), 1);
        QCOMPARE(root->property("v").toMap().value(u"x"_s).toDouble(), 100.0);
        QCOMPARE(num->property("text").toString(), u"100"_s);
        // 敲到一半的(只剩一个点):打完改回真正的值
        type(num, u"."_s);
        QMetaObject::invokeMethod(num, "editingFinished");
        QCOMPARE(num->property("text").toString(), u"100"_s);
        // 清空 = 不设
        type(num, QString());
        QVERIFY(root->property("v").toMap().value(u"x"_s).isNull());
    }

    // min ≥ 0 时负号敲不进去
    void inputNumberRejectsMinusWhenMinIsZero() {
        QQmlEngine engine;
        auto root = make(engine, kForm);
        QObject* num = child(root.get(), "num");
        QObject* validator = num->property("validator").value<QObject*>();
        QVERIFY(validator);
        QVERIFY(!validator->property("regularExpression").toRegularExpression().match(u"-5"_s).hasMatch());
    }

    // 小数位同 rc-input-number:值的位数与步长的位数取大的(步长 0.05 的 0 是「0.00」)
    void inputNumberStepPrecision() {
        QQmlEngine engine;
        auto root = make(engine, R"(
import QtQuick
import Dafri.Kit
Item {
    property var v: 0
    InputNumber { objectName: "cost"; step: 0.05; value: parent.v }
    InputNumber { objectName: "half"; step: 0.5; value: parent.v }
    InputNumber { objectName: "one"; value: parent.v }
}
)");
        QObject *cost = child(root.get(), "cost"), *half = child(root.get(), "half"), *one = child(root.get(), "one");
        QCOMPARE(cost->property("text").toString(), u"0.00"_s);
        QCOMPARE(half->property("text").toString(), u"0.0"_s);
        QCOMPARE(one->property("text").toString(), u"0"_s);
        root->setProperty("v", 2.25);
        QCOMPARE(cost->property("text").toString(), u"2.25"_s);
        QCOMPARE(half->property("text").toString(), u"2.25"_s);
        root->setProperty("v", 0.1);
        QCOMPARE(cost->property("text").toString(), u"0.10"_s);
        root->setProperty("v", 30);
        QCOMPARE(one->property("text").toString(), u"30"_s);
        QCOMPARE(half->property("text").toString(), u"30.0"_s);
        root->setProperty("v", QVariant::fromValue(nullptr));
        QCOMPARE(cost->property("text").toString(), QString());
    }

    // 下拉:值不在选项里时原样显示这个值(同 AntD);没有值时是占位字
    void selectShowsUnknownValue() {
        QQmlEngine engine;
        auto root = make(engine, R"(
import QtQuick
import Dafri.Kit
Select { property var v: "custom"; value: v; placeholder: "标的"; options: [{ value: "a", label: "甲" }] }
)");
        const auto shown = [&] {
            for (QQuickItem* t : root->findChildren<QQuickItem*>())
                if (t->inherits("QQuickText") && t->property("text").toString() != u"⌄"_s) return t->property("text").toString();
            return QString();
        };
        QCOMPARE(shown(), u"custom"_s);
        root->setProperty("v", u"a"_s);
        QCOMPARE(shown(), u"甲"_s);
        root->setProperty("v", QVariant());
        QCOMPARE(shown(), u"标的"_s);
    }

    // 下拉的长列表(复盘的候选能有 200 笔):弹层最高 256 + 上下 4、能滚,打开时选中的那一项在可见范围里;
    // 选项字是纯文本(用户起的账户名「IRA<旧>」不当标签吞掉),长字省略不溢出
    void selectLongListScrolls() {
        QQuickView view;
        QQmlComponent c(view.engine());
        c.setData(R"(
import QtQuick
import Dafri.Kit
Item {
    width: 900; height: 700
    Select {
        objectName: "sel"; x: 100; y: 60; width: 400
        value: "id150"
    }
}
)", QUrl(u"inline.qml"_s));
        std::unique_ptr<QObject> root(c.create());
        QVERIFY2(root, qPrintable(c.errorString()));
        qobject_cast<QQuickItem*>(root.get())->setParentItem(view.contentItem());
        view.resize(900, 700);
        view.show();
        QVERIFY(QTest::qWaitForWindowExposed(&view));
        QQuickItem* sel = root->findChild<QQuickItem*>(u"sel"_s);
        QVERIFY(sel);
        QVariantList options;
        for (int i = 0; i < 200; ++i)
            options << QVariantMap{{u"value"_s, u"id%1"_s.arg(i)},
                                   {u"label"_s, u"IRA<旧> · 10-08 10:31 · 买 1 SPX 6800/6810/6820 C 蝴蝶 · 到期 20261018 @ 1.25 · 未平仓 #%1"_s.arg(i)}};
        sel->setProperty("options", options);
        QObject* popup = nullptr;
        for (QObject* o : sel->findChildren<QObject*>())
            if (o->inherits("QQuickPopup")) popup = o;
        QVERIFY(popup);
        QMetaObject::invokeMethod(popup, "open");
        QTRY_VERIFY(popup->property("opened").toBool());
        QVERIFY2(popup->property("height").toReal() <= 256 + 8 + 0.5, qPrintable(QString::number(popup->property("height").toReal())));
        auto* list = qobject_cast<QQuickItem*>(popup->property("contentItem").value<QObject*>());
        QVERIFY(list && list->inherits("QQuickListView"));
        const qreal y = list->property("contentY").toReal();
        QVERIFY2(150 * 30 >= y && 151 * 30 <= y + list->height() + 0.5, qPrintable(QString::number(y)));
        // 显示字:纯文本、带着「<旧>」,省略在框里
        bool sawShown = false;
        for (QQuickItem* t : sel->findChildren<QQuickItem*>())
            if (t->inherits("QQuickText") && t->property("text").toString().endsWith(u"#150"_s) && t->parentItem() == sel) {
                sawShown = true;
                QCOMPARE(t->property("textFormat").toInt(), int(Qt::PlainText));
                QVERIFY(t->property("truncated").toBool());
            }
        QVERIFY(sawShown);
        for (QQuickItem* t : list->findChildren<QQuickItem*>())
            if (t->inherits("QQuickText")) {
                QCOMPARE(t->property("textFormat").toInt(), int(Qt::PlainText));
                QVERIFY(t->width() <= list->width());
            }
    }

    // 日期区间:点两下(先起后止,倒着点就对调)交出去;晚于今天的点不动;预设按月往前推(月底夹住);敲日期认得出、不晚于今天才算
    void dateRangePicker() {
        QQuickView view;
        QQmlComponent c(view.engine());
        c.setData(R"(
import QtQuick
import Dafri.Kit
DateRangePicker {
    width: 300
    today: "2026-08-31"; pinToday: true
    start: "2025-08-31"; end: "2026-08-31"
    property var got: []
    onActivated: function (s, e) { got = [s, e]; start = s; end = e }
}
)", QUrl(u"inline.qml"_s));
        std::unique_ptr<QObject> root(c.create());
        QVERIFY2(root, qPrintable(c.errorString()));
        auto* item = qobject_cast<QQuickItem*>(root.get());
        item->setParentItem(view.contentItem());
        view.resize(1000, 500);
        view.show();
        QVERIFY(QTest::qWaitForWindowExposed(&view));
        const auto got = [&] { return root->property("got").toStringList(); };
        QMetaObject::invokeMethod(root.get(), "openAt", Q_ARG(QVariant, u"start"_s));
        QCOMPARE(root->property("viewY").toInt(), 2025);
        QCOMPARE(root->property("viewM").toInt(), 8);
        QMetaObject::invokeMethod(root.get(), "pick", Q_ARG(QVariant, u"2026-01-05"_s));
        QCOMPARE(root->property("active").toString(), u"end"_s);
        QMetaObject::invokeMethod(root.get(), "pick", Q_ARG(QVariant, u"2026-09-02"_s));  // 晚于今天:点不动
        QVERIFY(got().isEmpty());
        QMetaObject::invokeMethod(root.get(), "pick", Q_ARG(QVariant, u"2025-12-01"_s));  // 倒着点:对调
        QCOMPARE(got(), (QStringList{u"2025-12-01"_s, u"2026-01-05"_s}));
        // 从终点那头点开:起点不动,点一下就交出去
        QMetaObject::invokeMethod(root.get(), "openAt", Q_ARG(QVariant, u"end"_s));
        QMetaObject::invokeMethod(root.get(), "pick", Q_ARG(QVariant, u"2026-03-10"_s));
        QCOMPARE(got(), (QStringList{u"2025-12-01"_s, u"2026-03-10"_s}));
        // 预设:近半年 = 6 个月前(2 月没有 31 号,落到 28 号)
        QMetaObject::invokeMethod(root.get(), "preset", Q_ARG(QVariant, 6));
        QCOMPARE(got(), (QStringList{u"2026-02-28"_s, u"2026-08-31"_s}));
        // 敲日期:认不出 / 晚于今天的不算,退回原值
        QList<QQuickItem*> fields;
        for (QQuickItem* t : root->findChildren<QQuickItem*>())
            if (t->inherits("QQuickTextInput")) fields << t;
        QCOMPARE(fields.size(), 2);
        const auto typeIn = [](QQuickItem* f, const QString& t) {
            f->setProperty("text", t);
            QMetaObject::invokeMethod(f, "textEdited");
            QMetaObject::invokeMethod(f, "editingFinished");
        };
        typeIn(fields[0], u"2026-13-01"_s);
        QCOMPARE(fields[0]->property("text").toString(), u"2026-02-28"_s);
        typeIn(fields[1], u"2027-01-01"_s);
        QCOMPARE(got(), (QStringList{u"2026-02-28"_s, u"2026-08-31"_s}));
        typeIn(fields[0], u"2026-05-04"_s);
        QCOMPARE(got(), (QStringList{u"2026-05-04"_s, u"2026-08-31"_s}));
        // 敲的起点晚于终点:对调
        typeIn(fields[1], u"2026-01-02"_s);
        QCOMPARE(got(), (QStringList{u"2026-01-02"_s, u"2026-05-04"_s}));
        // review D1:点框(焦点留在框里)、在日历上选、再失焦——框里的字跟着新值,失焦不拿旧字回发
        fields[0]->forceActiveFocus();
        QMetaObject::invokeMethod(root.get(), "openAt", Q_ARG(QVariant, u"start"_s));
        QMetaObject::invokeMethod(root.get(), "pick", Q_ARG(QVariant, u"2026-03-02"_s));
        QMetaObject::invokeMethod(root.get(), "pick", Q_ARG(QVariant, u"2026-04-01"_s));
        QCOMPARE(got(), (QStringList{u"2026-03-02"_s, u"2026-04-01"_s}));
        QCOMPARE(fields[0]->property("text").toString(), u"2026-03-02"_s);
        QMetaObject::invokeMethod(fields[0], "editingFinished");
        QCOMPARE(got(), (QStringList{u"2026-03-02"_s, u"2026-04-01"_s}));
        // review R1:框里敲了一个合法的日期还没回车,就去日历上选 / 点预设——以选的为准,失焦不拿敲的字回发
        fields[0]->setProperty("text", u"2025-01-01"_s);
        QMetaObject::invokeMethod(fields[0], "textEdited");
        QMetaObject::invokeMethod(root.get(), "openAt", Q_ARG(QVariant, u"start"_s));
        QMetaObject::invokeMethod(root.get(), "pick", Q_ARG(QVariant, u"2026-05-02"_s));
        QMetaObject::invokeMethod(root.get(), "pick", Q_ARG(QVariant, u"2026-06-01"_s));
        QMetaObject::invokeMethod(fields[0], "editingFinished");
        QCOMPARE(got(), (QStringList{u"2026-05-02"_s, u"2026-06-01"_s}));
        QCOMPARE(fields[0]->property("text").toString(), u"2026-05-02"_s);
        fields[1]->setProperty("text", u"2025-02-02"_s);
        QMetaObject::invokeMethod(fields[1], "textEdited");
        QMetaObject::invokeMethod(root.get(), "preset", Q_ARG(QVariant, 3));
        QMetaObject::invokeMethod(fields[1], "editingFinished");
        QCOMPARE(got(), (QStringList{u"2026-05-31"_s, u"2026-08-31"_s}));
    }

    // 自动列宽:给了宽的列就是那么宽;多出来的按各列的宽按比例分给其余的列;合起来正好是表宽
    void autoTableWidths() {
        QQmlEngine engine;
        auto root = make(engine, R"(
import QtQuick
import Dafri.Kit
AutoTable {
    width: 600
    columns: [{ key: "a", title: "参数" }, { key: "b", title: "样本内", align: "right" }, { key: "c", title: "名次", align: "right", width: 90 }]
    rows: [{ key: "1", cells: { a: "fast=10 · slow=50", b: { text: "+1.5%", tone: "pos" }, c: "1" } }]
}
)");
        QTRY_VERIFY(root->property("widths").toList().size() == 3 && root->property("widths").toList().at(0).toDouble() > 0);
        const QVariantList w = root->property("widths").toList();
        QCOMPARE(w.at(2).toDouble(), 90.0);
        QVERIFY(std::abs(w.at(0).toDouble() + w.at(1).toDouble() + w.at(2).toDouble() - 600) < 0.01);
        QVERIFY(w.at(0).toDouble() > w.at(1).toDouble());
    }

    // 外面不收(状态没变):控件画的也不变——不能自己先翻过去
    void checkboxAndSelectAreControlled() {
        QQmlEngine engine;
        auto root = make(engine, kForm);
        root->setProperty("obey", false);
        QObject* box = child(root.get(), "box");
        QSignalSpy toggled(box, SIGNAL(toggled(bool)));
        QMetaObject::invokeMethod(box, "toggled", Q_ARG(bool, true));
        QCOMPARE(box->property("checked").toBool(), false);
        root->setProperty("obey", true);
        setState(root.get(), {{u"c"_s, true}});
        QCOMPARE(box->property("checked").toBool(), true);
        QObject* sel = child(root.get(), "sel");
        setState(root.get(), {{u"s"_s, u"LMT"_s}});
        QCOMPARE(sel->property("value").toString(), u"LMT"_s);
    }

    // 真窗口、逐键输入、不失焦就点按钮(review 第二轮的两个场景):
    //   A:止损框里敲 170,不离开就点价位 chip(填 172)→ 框里显示 172;再点「开始」→ 发的还是 172,不会被框里的 170 改回去;
    //   B:上限 100 的框里逐键敲 1、5、0,直接点「开始」→ 按下按钮时框先失焦、夹成 100,点击看到的是 100,框里也是 100
    void focusedTypingThenButton() {
        QQuickView view;
        QQmlComponent c(view.engine());
        c.setData(R"(
import QtQuick
import Dafri.Kit
Item {
    id: root
    width: 400; height: 200
    property var v: ({ sl: null, chase: null })
    function set(part) { var n = Object.assign({}, v); for (var k in part) n[k] = part[k]; v = n }
    property var sent: null
    InputNumber { objectName: "sl"; x: 0; y: 0; width: 120; min: 0; value: root.v.sl; onValueEdited: function (x) { root.set({ sl: x }) } }
    InputNumber { objectName: "chase"; x: 0; y: 50; width: 120; min: 0; max: 100; value: root.v.chase; onValueEdited: function (x) { root.set({ chase: x }) } }
    Button { objectName: "chip"; x: 200; y: 0; text: "172"; onClicked: root.set({ sl: 172 }) }
    Button { objectName: "start"; x: 200; y: 100; text: "开始"; onClicked: root.sent = JSON.parse(JSON.stringify(root.v)) }
}
)", QUrl(u"inline.qml"_s));
        std::unique_ptr<QObject> obj(c.create());
        QVERIFY2(obj, qPrintable(c.errorString()));
        auto* root = qobject_cast<QQuickItem*>(obj.get());
        root->setParentItem(view.contentItem());
        view.resize(400, 200);
        view.show();
        QVERIFY(QTest::qWaitForWindowExposed(&view));
        const auto center = [&](const char* name) {
            auto* it = qobject_cast<QQuickItem*>(child(root, name));
            return it->mapToScene(QPointF(it->width() / 2, it->height() / 2)).toPoint();
        };
        // A
        QTest::mouseClick(&view, Qt::LeftButton, {}, center("sl"));
        for (char ch : {'1', '7', '0'}) QTest::keyClick(&view, ch);
        QCOMPARE(root->property("v").toMap().value(u"sl"_s).toDouble(), 170.0);
        QTest::mouseClick(&view, Qt::LeftButton, {}, center("chip"));
        QCOMPARE(child(root, "sl")->property("text").toString(), u"172"_s);
        QTest::mouseClick(&view, Qt::LeftButton, {}, center("start"));
        QCOMPARE(root->property("sent").toMap().value(u"sl"_s).toDouble(), 172.0);
        // 框还聚焦着、外面改了值(不是经按钮,例如引擎回来的数):框里也照着改
        QTest::mouseClick(&view, Qt::LeftButton, {}, center("sl"));
        QTest::keyClick(&view, Qt::Key_Backspace);
        QCOMPARE(root->property("v").toMap().value(u"sl"_s).toDouble(), 17.0);
        QVERIFY(child(root, "sl")->property("focused").toBool());
        setState(root, {{u"sl"_s, 180}});
        QCOMPARE(child(root, "sl")->property("text").toString(), u"180"_s);
        // B
        QTest::mouseClick(&view, Qt::LeftButton, {}, center("chase"));
        for (char ch : {'1', '5', '0'}) QTest::keyClick(&view, ch);
        QCOMPARE(root->property("v").toMap().value(u"chase"_s).toDouble(), 15.0);
        QTest::mouseClick(&view, Qt::LeftButton, {}, center("start"));
        QCOMPARE(root->property("sent").toMap().value(u"chase"_s).toDouble(), 100.0);
        QCOMPARE(child(root, "chase")->property("text").toString(), u"100"_s);
    }

    void keyedModelDiffs() {
        shell::KeyedListModel model(u"key"_s);
        QAbstractItemModelTester tester(&model, QAbstractItemModelTester::FailureReportingMode::QtTest);
        const auto item = [](const char* k, int n) { return QJsonObject{{u"key"_s, QString::fromLatin1(k)}, {u"n"_s, n}}; };
        model.setItems({item("a", 1), item("b", 1), item("c", 1)});
        QCOMPARE(model.count(), 3);
        QSignalSpy inserted(&model, &QAbstractItemModel::rowsInserted);
        QSignalSpy removed(&model, &QAbstractItemModel::rowsRemoved);
        QSignalSpy changed(&model, &QAbstractItemModel::dataChanged);
        QSignalSpy moved(&model, &QAbstractItemModel::rowsMoved);
        // 只变了一个数:一行 dataChanged,不插不删
        model.setItems({item("a", 1), item("b", 2), item("c", 1)});
        QCOMPARE(changed.size(), 1);
        QCOMPARE(inserted.size() + removed.size() + moved.size(), 0);
        // 删一个、加一个、挪一个
        model.setItems({item("c", 1), item("a", 1), item("d", 1)});
        QCOMPARE(model.items(), (QJsonArray{item("c", 1), item("a", 1), item("d", 1)}));
        QCOMPARE(removed.size(), 1);
        QCOMPARE(inserted.size(), 1);
        // 同键出现两次、又只剩一次
        model.setItems({item("x", 1), item("x", 2)});
        model.setItems({item("x", 3)});
        QCOMPARE(model.items(), (QJsonArray{item("x", 3)}));
        model.setItems({});
        QCOMPARE(model.count(), 0);
    }

    // 外面改了多行输入框的字(「应对」写进一句、「写进指令」):光标在末尾,同浏览器的受控 textarea;接着敲不会插到句首
    void textAreaPutsTheCaretAtTheEnd() {
        QQmlEngine engine;
        auto root = make(engine, R"(
import QtQuick
import Dafri.Kit
Item {
    property string t: ""
    TextArea { objectName: "ta"; text: parent.t; width: 300 }
}
)");
        QObject* ta = child(root.get(), "ta");
        QVERIFY(ta);
        for (const QString& t : {u"买 1 张 SPX 7600P"_s, u"买 1 张 SPX 7600P,理由:突破"_s}) {
            root->setProperty("t", t);
            QCOMPARE(ta->property("cursorPosition").toInt(), int(t.size()));
        }
    }

    // Esc:页面在 window 上听(交易记录收起详情),只看不拦——抽屉、对话框拿着焦点时同一下也收得到(原版两边一起收)
    void escapeIsObservedNotSwallowed() {
        QQuickView view;
        QQmlComponent c(view.engine());
        c.setData(R"(
import QtQuick
Item {
    width: 200; height: 100
    property int drawerGot: 0
    Item { objectName: "drawer"; focus: true; Keys.onEscapePressed: parent.drawerGot += 1 }
}
)", QUrl(u"inline.qml"_s));
        std::unique_ptr<QObject> root(c.create());
        QVERIFY2(root, qPrintable(c.errorString()));
        auto* item = qobject_cast<QQuickItem*>(root.get());
        item->setParentItem(view.contentItem());
        view.show();
        QVERIFY(QTest::qWaitForWindowExposed(&view));
        child(root.get(), "drawer")->setProperty("focus", true);
        qobject_cast<QQuickItem*>(child(root.get(), "drawer"))->forceActiveFocus();
        app::EscapeWatcher watcher;
        qApp->installEventFilter(&watcher);
        QSignalSpy pressed(&watcher, &app::EscapeWatcher::pressed);
        QTest::keyClick(&view, Qt::Key_Escape);
        QCOMPARE(pressed.size(), 1);
        QCOMPARE(root->property("drawerGot").toInt(), 1);
        // 只听主窗口:别的窗口(提醒小窗、确认框)里按的不算
        QQuickWindow other;
        other.show();
        QVERIFY(QTest::qWaitForWindowExposed(&other));
        watcher.setWindow(&view);
        QTest::keyClick(&other, Qt::Key_Escape);
        QCOMPARE(pressed.size(), 1);
        QTest::keyClick(&view, Qt::Key_Escape);
        QCOMPARE(pressed.size(), 2);
        qApp->removeEventFilter(&watcher);
    }

    // 分组列表里的一行开关(kit/SwitchRow):整行是一个 label——点字、点开关本体都只翻一次(review 复现过点本体翻两次又翻回来)
    void switchRowTogglesOnce() {
        QQuickView view;
        QQmlComponent c(view.engine());
        c.setData(R"(
import QtQuick
import Dafri.Kit
SwitchRow {
    width: 400
    property int count: 0
    label: "只看正常交易时段"; sub: "说明"
    onToggled: function (on) { count += 1; checked = on }
}
)", QUrl(u"inline.qml"_s));
        std::unique_ptr<QObject> root(c.create());
        QVERIFY2(root, qPrintable(c.errorString()));
        auto* item = qobject_cast<QQuickItem*>(root.get());
        item->setParentItem(view.contentItem());
        view.resize(420, 120);
        view.show();
        QVERIFY(QTest::qWaitForWindowExposed(&view));
        // 开关本体:右边 16、46 宽,竖直居中
        const QPoint knob(int(item->width() - 16 - 23), int(item->height() / 2));
        QTest::mouseClick(&view, Qt::LeftButton, {}, knob);
        QTRY_COMPARE(root->property("count").toInt(), 1);
        QCOMPARE(root->property("checked").toBool(), true);
        // 点字
        QTest::mouseClick(&view, Qt::LeftButton, {}, QPoint(40, int(item->height() / 2)));
        QTRY_COMPARE(root->property("count").toInt(), 2);
        QCOMPARE(root->property("checked").toBool(), false);
    }

    // 图表的鼠标接线(kit/chart_view):滚轮没开时不收(交给外面的页面滚)、开了围着指针缩放;拖时间轴改间距;双击时间轴铺满;
    // 指针停在图里时第二行读数是那一根,离开回到图例。算法本身对着浏览器量的在 tst_chart_scale
    void chartViewMouse() {
        QQuickView view;
        view.resize(700, 340);
        shell::ChartSource source;
        shell::chart::Spec spec;
        for (int i = 0; i < 40; ++i) {
            const double o = 100 + i;
            spec.bars.append({u"2026-08-21 %1:%2"_s.arg(9 + (30 + i) / 60, 2, 10, QChar(u'0')).arg((30 + i) % 60, 2, 10, QChar(u'0')), o, o + 2, o - 1, o + 1, 1000 + i});
        }
        spec.legend.append({u"■"_s, u"up"_s, u"阳线"_s});
        source.setSpec(spec);
        kit::ChartView chart(view.contentItem());
        chart.setSize(QSizeF(600, 320));
        chart.setSource(&source);
        view.show();
        QVERIFY(QTest::qWaitForWindowExposed(&view));
        QVERIFY(chart.frame().ok);
        const double from0 = chart.frame().from, to0 = chart.frame().to;
        QCOMPARE(from0, 0.0);
        QCOMPARE(to0, 39.0);
        QCOMPARE(chart.legendRow().size(), 1);

        // 滚轮没开:不收
        QWheelEvent off(QPointF(300, 100), view.mapToGlobal(QPoint(300, 100)), {}, QPoint(0, 120), Qt::NoButton, Qt::NoModifier, Qt::NoScrollPhase, false);
        QCoreApplication::sendEvent(&chart, &off);
        QVERIFY(!off.isAccepted());
        QCOMPARE(chart.frame().to, to0);
        // 开了:放大一格
        chart.setWheel(true);
        QWheelEvent on(QPointF(300, 100), view.mapToGlobal(QPoint(300, 100)), {}, QPoint(0, 120), Qt::NoButton, Qt::NoModifier, Qt::NoScrollPhase, false);
        QCoreApplication::sendEvent(&chart, &on);
        QVERIFY(on.isAccepted());
        QVERIFY(chart.frame().to - chart.frame().from < to0 - from0);

        // 拖时间轴:往左拖,间距变大
        const double bs = chart.frame().barSpacing;
        const double axisY = chart.frame().paneH[0] + 1 + chart.frame().paneH[1] + 10;
        QTest::mousePress(&view, Qt::LeftButton, {}, QPoint(400, int(axisY)));
        QTest::mouseMove(&view, QPoint(300, int(axisY)));
        QTest::mouseRelease(&view, Qt::LeftButton, {}, QPoint(300, int(axisY)));
        QVERIFY(chart.frame().barSpacing > bs);

        // 双击时间轴:铺满
        QTest::mouseDClick(&view, Qt::LeftButton, {}, QPoint(200, int(axisY)));
        QCOMPARE(chart.frame().from, 0.0);
        QCOMPARE(chart.frame().to, 39.0);

        // 指针停在图里:第二行是那一根的读数(时间、开高低收…);离开回到图例
        QTest::mouseMove(&view, QPoint(300, 100));
        QTRY_VERIFY(!chart.readoutRow().isEmpty());
        QVERIFY(chart.readoutRow()[0].toMap()[u"text"_s].toString().startsWith(u"08-21 "_s));
        // 指针一动只换十字光标与读数行:轴上的字不重建
        QCOMPARE(chart.crossTexts().size(), 2);
        QSignalSpy frames(&chart, &kit::ChartView::frameChanged), hovers(&chart, &kit::ChartView::hoverChanged);
        QTest::mouseMove(&view, QPoint(320, 110));
        QTRY_VERIFY(hovers.count() > 0);
        QCOMPARE(frames.count(), 0);
        // 数据刷新:读数行是此刻指针下的那一根(库在 setData 时按像素重算十字光标)。掉了第一根、铺满:同一个像素下换成了别的一根
        const QString before = chart.readoutRow()[0].toMap()[u"text"_s].toString();
        spec.bars.removeFirst();
        source.setSpec(spec);
        QVERIFY(chart.frame().hoverIdx.has_value());
        QVERIFY(chart.readoutRow()[0].toMap()[u"text"_s].toString() != before);
        // 改尺寸(铺满时):拖窄了还是全部 K 线都看得见(lockVisibleTimeRangeOnResize),不是把最早那些裁掉
        chart.setSize(QSizeF(420, 320));
        QCOMPARE(chart.frame().from, 0.0);
        QCOMPARE(chart.frame().to, double(spec.bars.size() - 1));
        chart.setSize(QSizeF(600, 320));
        // 从 0 尺寸长出来(Loader 先建出 0×0 的项再排版):QML 读到的提示要跟着变回空
        chart.setSize(QSizeF(0, 0));
        QCOMPARE(chart.property("notice").toString(), u"窗口太窄"_s);
        // QML 是在 frameChanged 发出的那一刻去读 notice 的:那一刻就得是新帧的
        QStringList seen;
        const auto conn = connect(&chart, &kit::ChartView::frameChanged, &chart, [&] { seen << chart.property("notice").toString(); });
        chart.setSize(QSizeF(600, 0));
        chart.setSize(QSizeF(600, 320));
        disconnect(conn);
        QVERIFY(!seen.isEmpty());
        QCOMPARE(seen.last(), QString());
        QCOMPARE(chart.property("notice").toString(), QString());
        QVERIFY(chart.property("priceAxisWidth").toDouble() >= 64);
        QHoverEvent leave(QEvent::HoverLeave, QPointF(-1, -1), QPointF(-1, -1), QPointF(300, 100));
        QCoreApplication::sendEvent(&chart, &leave);
        QVERIFY(chart.readoutRow().isEmpty());
        QCOMPARE(chart.legendRow().size(), 1);
    }

    // Repeater 里的 delegate:数据变了还是同一个对象,modelData 跟着变
    // review B1–B3:行的模型只放键时,敲一个字(页面模型整份重算)这一行不重建,框里接着敲的字不落空;直接拿对象数组当模型就会重建
    void keysModelKeepsTypingRow() {
        QQmlEngine engine;
        auto root = make(engine, R"(
import QtQuick
import Dafri.Kit
Item {
    width: 400; height: 200
    property var m: ({ params: [{ key: "fast", label: "快线", value: 10 }, { key: "slow", label: "慢线", value: 50 }] })
    function set(key, v) {
        m = { params: m.params.map(function (p) { return p.key === key ? Object.assign({}, p, { value: v }) : Object.assign({}, p) }) }
    }
    Column {
        Repeater {
            objectName: "keyed"
            model: parent.parent.m.params.map(function (p) { return p.key })
            NumberRow {
                required property var modelData
                required property int index
                readonly property var p: parent.parent.m.params[index] || ({})
                width: 400; label: p.label || ""; value: p.value
                onValueEdited: function (v) { parent.parent.set(modelData, v) }
            }
        }
        Repeater {
            objectName: "naive"
            model: parent.parent.m.params
            Item { required property var modelData; width: 10; height: 10 }
        }
    }
}
)");
        auto* keyed = qobject_cast<QQuickItem*>(child(root.get(), "keyed"));
        auto* naive = qobject_cast<QQuickItem*>(child(root.get(), "naive"));
        QQuickItem *row = nullptr, *naiveRow = nullptr;
        QMetaObject::invokeMethod(keyed, "itemAt", Q_RETURN_ARG(QQuickItem*, row), Q_ARG(int, 0));
        QMetaObject::invokeMethod(naive, "itemAt", Q_RETURN_ARG(QQuickItem*, naiveRow), Q_ARG(int, 0));
        QObject* num = nullptr;
        for (QObject* o : row->findChildren<QObject*>())
            if (o->inherits("QQuickTextInput") || o->metaObject()->indexOfSignal("valueEdited(QVariant)") >= 0) { num = o; if (o->metaObject()->indexOfSignal("valueEdited(QVariant)") >= 0) break; }
        QVERIFY(num);
        // 全选 10 后敲「1」:页面模型变成 1;接着敲「5」:还是同一个框
        type(num, u"1"_s);
        QCOMPARE(root->property("m").toMap().value(u"params"_s).toList().at(0).toMap().value(u"value"_s).toDouble(), 1.0);
        QQuickItem *rowAfter = nullptr, *naiveAfter = nullptr;
        QMetaObject::invokeMethod(keyed, "itemAt", Q_RETURN_ARG(QQuickItem*, rowAfter), Q_ARG(int, 0));
        QMetaObject::invokeMethod(naive, "itemAt", Q_RETURN_ARG(QQuickItem*, naiveAfter), Q_ARG(int, 0));
        QCOMPARE(rowAfter, row);
        QVERIFY(naiveAfter != naiveRow);  // 对照:对象数组当模型,行被换掉了
        type(num, u"15"_s);
        QCOMPARE(root->property("m").toMap().value(u"params"_s).toList().at(0).toMap().value(u"value"_s).toDouble(), 15.0);
        QCOMPARE(num->property("text").toString(), u"15"_s);
    }

    // 设置页的 RowList:每改一格页面模型整份重建(行是新对象),敲「1500」框还是那一个、模型里是 1500(不是 1)
    void rowListKeepsTypingRow() {
        QQmlEngine engine;
        auto root = make(engine, R"(
import QtQuick
import Dafri.Kit
Item {
    width: 600; height: 300
    property var rows: [{ kind: "number", key: "notional", label: "单笔名义金额上限", sub: "USD", value: 5000, min: 0, step: 100 },
                        { kind: "switch", key: "slGuard", label: "止损护栏", sub: "", checked: false }]
    property int edits: 0
    Column {
        width: parent.width
        RowList {
            objectName: "rows"
            rows: parent.parent.rows
            onEdited: function (key, kind, v) {
                parent.parent.edits++
                parent.parent.rows = parent.parent.rows.map(function (r) {
                    var c = Object.assign({}, r)
                    if (r.key === key) { if (kind === "number") c.value = v; else c.checked = v }
                    return c
                })
            }
        }
    }
}
)");
        auto* rows = qobject_cast<QQuickItem*>(child(root.get(), "rows"));
        QVERIFY(rows);
        QQuickItem* first = nullptr;
        QMetaObject::invokeMethod(rows, "itemAt", Q_RETURN_ARG(QQuickItem*, first), Q_ARG(int, 0));
        QVERIFY(first);
        QObject* num = nullptr;
        for (QObject* o : first->findChildren<QObject*>())
            if (o->metaObject()->indexOfSignal("valueEdited(QVariant)") >= 0 && o->inherits("QQuickItem") && o->property("step").isValid() && !o->property("label").isValid()) num = o;
        QVERIFY(num);
        // 一个键一个键地敲:每一下都让页面模型整份重建
        for (const QString& t : {u"1"_s, u"15"_s, u"150"_s, u"1500"_s}) type(num, t);
        QCOMPARE(root->property("rows").toList().at(0).toMap().value(u"value"_s).toDouble(), 1500.0);
        QQuickItem* after = nullptr;
        QMetaObject::invokeMethod(rows, "itemAt", Q_RETURN_ARG(QQuickItem*, after), Q_ARG(int, 0));
        QCOMPARE(after, first);
        QCOMPARE(num->property("text").toString(), u"1500"_s);
        QVERIFY(root->property("edits").toInt() >= 4);
    }

    // 拆页时不排东西:WrapRow / Meta 挂上、换模型、立刻卸载,30 轮。以前用 connect + Qt.callLater 重排,孩子拆掉时还发 widthChanged,
    // 排进去的函数落在正在销毁的上下文里(「attempted to evaluate a function in an invalid context」,AOT 编译的应用里会 abort)
    void wrapAndMetaTearDownCleanly() {
        QTest::failOnWarning(QRegularExpression(u"invalid context|delayed function evaluation|is not a function"_s));
        QQmlEngine engine;
        auto root = make(engine, R"(
import QtQuick
import Dafri.Kit
Item {
    width: 400; height: 300
    property int round: 0
    property var words: ["一", "二二", "三三三"]
    Loader {
        id: loader
        objectName: "loader"
        width: 300
        active: true
        sourceComponent: Column {
            width: 300
            WrapRow {
                width: parent.width; columnSpacing: 8; rowSpacing: 4
                Repeater { model: root_words(); Label { required property string modelData; text: modelData } }
            }
            Meta { width: parent.width; items: root_words().map(function (w) { return { text: w } }); trailing: Button { small: true; text: "刷新" } }
        }
    }
    function root_words() { return words }
}
)");
        auto* loader = child(root.get(), "loader");
        QVERIFY(loader);
        for (int i = 0; i < 30; ++i) {
            QStringList w;
            for (int k = 0; k <= i % 5; ++k) w << QString(k + 1, u'字');
            root->setProperty("words", w);
            loader->setProperty("active", false);
            QCoreApplication::processEvents();
            loader->setProperty("active", true);
            root->setProperty("words", QStringList{u"甲"_s});
            loader->setProperty("active", false);
            QCoreApplication::processEvents();
            loader->setProperty("active", true);
        }
        QTest::qWait(50);
    }

    void repeaterKeepsDelegates() {
        QQmlEngine engine;
        shell::KeyedListModel model(u"key"_s);
        model.setItems({QJsonObject{{u"key"_s, u"a"_s}, {u"price"_s, 1}}, QJsonObject{{u"key"_s, u"b"_s}, {u"price"_s, 1}}});
        engine.rootContext()->setContextProperty(u"cards"_s, &model);
        auto root = make(engine, R"(
import QtQuick
Item {
    property int made: 0
    Repeater {
        id: rep
        objectName: "rep"
        model: cards
        Item { required property var modelData; property real price: modelData.price; Component.onCompleted: parent.made++ }
    }
}
)");
        auto* rep = qobject_cast<QQuickItem*>(child(root.get(), "rep"));
        QVERIFY(rep);
        QCOMPARE(root->property("made").toInt(), 2);
        QQuickItem* first = nullptr;
        QMetaObject::invokeMethod(rep, "itemAt", Q_RETURN_ARG(QQuickItem*, first), Q_ARG(int, 0));
        model.setItems({QJsonObject{{u"key"_s, u"a"_s}, {u"price"_s, 2}}, QJsonObject{{u"key"_s, u"b"_s}, {u"price"_s, 1}}});
        QQuickItem* again = nullptr;
        QMetaObject::invokeMethod(rep, "itemAt", Q_RETURN_ARG(QQuickItem*, again), Q_ARG(int, 0));
        QCOMPARE(again, first);
        QCOMPARE(root->property("made").toInt(), 2);
        QCOMPARE(first->property("price").toDouble(), 2.0);
    }
};

QTEST_MAIN(TestKitControls)
#include "tst_kit_controls.moc"
