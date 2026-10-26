#include <QTest>
#include <QSignalSpy>
#include <QJsonObject>
#include <QJsonArray>
#include <QQmlEngine>
#include <QQmlComponent>
#include <QQuickWindow>
#include <QQuickItem>
#include <QtQml/qqmlextensionplugin.h>
Q_IMPORT_QML_PLUGIN(Dafri_KitPlugin)
using namespace Qt::StringLiterals;
class TestEarningsUi:public QObject {
 Q_OBJECT
private slots:
 void panel() {
    QQmlEngine engine;QStringList warnings;
    connect(&engine,&QQmlEngine::warnings,&engine,[&](const QList<QQmlError>& errors){for(const auto& e:errors)warnings<<e.toString();});
    QQmlComponent component(&engine,QUrl::fromLocalFile(QStringLiteral(EARNINGS_QML_PATH)));
    QJsonObject report{{"status","available"},{"basis",u"演示数据 · NVDA · 非真实财报与行情。涨跌均相对财报前一交易日收盘。"_s},
        {"upcoming",QJsonObject{{"date","2026-11-18"},{"days_until",26},{"timing","AFTER MARKET"},{"status","CONFIRMED"}}},
        {"history",QJsonArray{QJsonObject{{"date","2026-08-26"},{"timing","AFTER MARKET"},{"gap",2.1},{"day1",3.4},{"day5",-1.2}},
           QJsonObject{{"date","2026-05-27"},{"timing","UNSPECIFIED"},{"gap",QJsonValue()},{"day1",QJsonValue()},{"day5",QJsonValue()},{"missing",u"发布时间缺失，不能用日线隔离反应"_s}}}}};
    std::unique_ptr<QObject> object(component.createWithInitialProperties({{u"report"_s,report}}));
    QVERIFY2(object,qPrintable(component.errorString()));auto* item=qobject_cast<QQuickItem*>(object.get());QVERIFY(item);
    QQuickWindow window;window.setColor(QColor("#ffffff"));window.resize(760,330);item->setParentItem(window.contentItem());item->setWidth(720);item->setX(20);item->setY(20);window.show();
    QVERIFY(QTest::qWaitForWindowExposed(&window));
    auto* toggle=object->findChild<QQuickItem*>(u"earningsToggle"_s);QVERIFY(toggle);
    QTest::mouseClick(&window,Qt::LeftButton,Qt::NoModifier,toggle->mapToScene(QPointF(toggle->width()/2,toggle->height()/2)).toPoint());
    QTRY_VERIFY(object->property("expanded").toBool());
    QSignalSpy frames(&window,&QQuickWindow::frameSwapped);
    window.requestUpdate();
    QTRY_VERIFY(frames.count()>0);
    QSignalSpy refresh(object.get(),SIGNAL(refresh()));auto* button=object->findChild<QQuickItem*>(u"earningsRefresh"_s);QVERIFY(button);
    QTest::mouseClick(&window,Qt::LeftButton,Qt::NoModifier,button->mapToScene(QPointF(button->width()/2,button->height()/2)).toPoint());
    QTRY_COMPARE(refresh.count(),1);QTest::qWait(150);
    if(const auto path=qEnvironmentVariable("EARNINGS_SCREENSHOT");!path.isEmpty())QVERIFY(window.grabWindow().save(path));
    report={{"status","missing"},{"message",u"IBKR WSH 请求超时，无法取得财报日期"_s},{"history",QJsonArray{}}};
    object->setProperty("report",report);QTest::qWait(30);
    QVERIFY2(warnings.isEmpty(),qPrintable(warnings.join(u'\n')));item->setParentItem(nullptr);
 }
};
QTEST_MAIN(TestEarningsUi)
#include "tst_earnings_ui.moc"
