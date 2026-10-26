#include "shell/terrain_controller.h"
#include <QTest>
#include <QQmlEngine>
#include <QQmlComponent>
#include <QQuickWindow>
#include <QQuickItem>
#include <QtQml/qqmlextensionplugin.h>
Q_IMPORT_QML_PLUGIN(Dafri_KitPlugin)
using namespace Qt::StringLiterals;
class TestTerrainUi:public QObject {
    Q_OBJECT
private slots:
    void dragTimeline() {
        ibkr::shell::TerrainController controller(nullptr);
        controller.request=[](const QJsonObject&,ibkr::shell::Bridge::RpcDone done){
            QJsonArray records;
            for(int j=0;j<3;++j){QJsonArray rows;for(int i=0;i<15;++i)rows.append(QJsonObject{{u"strike"_s,5965+i*5},{u"net_gex"_s,double(i-7+j)*1e9}});
                records.append(QJsonObject{{u"received_at"_s,1792677600000.0+j*300000},{u"status"_s,u"observed"_s},{u"wall"_s,QJsonObject{{u"spot"_s,6000+j*5},{u"strikes"_s,rows}}}});}
            ibkr::shell::EngineReply r;r.ok=true;r.result=QJsonObject{{u"dates"_s,QJsonArray{u"2026-10-22"_s}},{u"records"_s,records},{u"demo"_s,true}};done(r);
        };
        controller.selectDate(u"2026-10-22"_s);
        QQmlEngine engine; QStringList warnings;
        connect(&engine,&QQmlEngine::warnings,&engine,[&](const QList<QQmlError>& errors){for(const auto& e:errors)warnings<<e.toString();});
        QQmlComponent component(&engine,QUrl::fromLocalFile(QStringLiteral(TERRAIN_QML_PATH)));
        std::unique_ptr<QObject> object(component.createWithInitialProperties({{u"controller"_s,QVariant::fromValue<QObject*>(&controller)}}));
        QVERIFY2(object,qPrintable(component.errorString()));
        auto item=qobject_cast<QQuickItem*>(object.get());QVERIFY(item);
        QQuickWindow window;window.resize(940,640);item->setParentItem(window.contentItem());item->setWidth(920);item->setX(10);item->setY(10);window.show();
        QVERIFY(QTest::qWaitForWindowExposed(&window));QTest::qWait(150);
        auto slider=object->findChild<QQuickItem*>(u"terrainTimeline"_s);QVERIFY(slider);
        const QPoint begin=slider->mapToScene(QPointF(1,6)).toPoint();
        const QPoint end=slider->mapToScene(QPointF(slider->width()-1,6)).toPoint();
        QTest::mousePress(&window,Qt::LeftButton,Qt::NoModifier,begin);
        QTest::mouseMove(&window,end,30);QTest::mouseRelease(&window,Qt::LeftButton,Qt::NoModifier,end);
        QVERIFY(controller.model()[u"cursor"].toDouble()>controller.model()[u"begin"].toDouble()+500000);
        QTest::qWait(100);
        const QString screenshot=qEnvironmentVariable("TERRAIN_SCREENSHOT");
        if(!screenshot.isEmpty())QVERIFY(window.grabWindow().save(screenshot));
        QVERIFY2(warnings.isEmpty(),qPrintable(warnings.join(u'\n')));
        item->setParentItem(nullptr);
    }
};
QTEST_MAIN(TestTerrainUi)
#include "tst_terrain_ui.moc"
