#include "shell/fly_controller.h"
#include "shell/fly_store.h"
#include "shell/fly_rules.h"
#include <QFile>
#include <QJsonDocument>
#include <QTest>
#include <QQmlEngine>
#include <QQmlComponent>
#include <QQuickWindow>
#include <QQuickItem>
#include <QtQml/qqmlextensionplugin.h>
Q_IMPORT_QML_PLUGIN(Dafri_KitPlugin)
using namespace ibkr::shell;
using namespace Qt::StringLiterals;
QQuickItem* visual(QQuickItem* item,const QString& name) {
    if(item->objectName()==name)return item;
    for(auto child:item->childItems())if(auto found=visual(child,name))return found;
    return nullptr;
}
class TestFlyEntryUi:public QObject {
    Q_OBJECT
private slots:
    void reviewAndRender() {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/fly-plan.json"));QVERIFY(f.open(QIODevice::ReadOnly));
        const auto r=QJsonDocument::fromJson(f.readAll()).object()[u"store"].toArray()[2][u"result"].toObject();
        fly::StoreDeps d;d.nowMs=[&]{return r[u"now_ms"].toDouble();};
        FlyStore store(d);const auto form=fly::emptyForm();
        store.set({{u"form"_s,form},{u"resultFor"_s,fly::formKey(form)},{u"result"_s,r}});
        FlyController controller(&store,nullptr,nullptr,nullptr,nullptr,nullptr);controller.now=d.nowMs;
        controller.patchEntry({{u"mode"_s,u"up"_s},{u"regime"_s,u"bull"_s},{u"flow"_s,u"none"_s},{u"source"_s,u"演示数据 · 多帧 EHG 地形，10:12 ET"_s},
            {u"trigger"_s,u"7710"_s},{u"invalidation"_s,u"7700"_s},{u"barrier"_s,u"7755"_s},{u"budget"_s,u"1500"_s},{u"fees"_s,u"10"_s},{u"exitTime"_s,u"14:45"_s}});
        QQmlEngine engine;QStringList warnings;
        connect(&engine,&QQmlEngine::warnings,&engine,[&](const QList<QQmlError>& errors){for(const auto& e:errors)warnings<<e.toString();});
        QQmlComponent component(&engine,QUrl::fromLocalFile(QStringLiteral(ENTRY_QML_PATH)));
        std::unique_ptr<QObject> object(component.createWithInitialProperties({{u"controller"_s,QVariant::fromValue<QObject*>(&controller)}}));
        QVERIFY2(object,qPrintable(component.errorString()));auto item=qobject_cast<QQuickItem*>(object.get());QVERIFY(item);
        QQuickWindow window;window.resize(920,1300);item->setParentItem(window.contentItem());item->setWidth(880);item->setX(20);item->setY(20);window.show();
        QVERIFY(QTest::qWaitForWindowExposed(&window));QTest::qWait(150);
        auto toggle=visual(item,u"entryCheck_persistent"_s);QVERIFY(toggle);
        QTest::mouseClick(&window,Qt::LeftButton,Qt::NoModifier,toggle->mapToScene(QPointF(toggle->width()/2,toggle->height()/2)).toPoint());
        QTRY_VERIFY(controller.entry()[u"manual"].toArray()[0][u"checked"].toBool());
        auto write=visual(item,u"entryWrite"_s);QVERIFY(write);QVERIFY(!write->isEnabled());
        QTest::qWait(100);
        if(const QString path=qEnvironmentVariable("ENTRY_SCREENSHOT");!path.isEmpty())QVERIFY(window.grabWindow().save(path));
        QVERIFY2(warnings.isEmpty(),qPrintable(warnings.join(u'\n')));item->setParentItem(nullptr);
    }
};
QTEST_MAIN(TestFlyEntryUi)
#include "tst_fly_entry_ui.moc"
