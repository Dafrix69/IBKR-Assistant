// 报一条提醒(shell/alerter)与提示音(shell/alert_tone):开关、退回系统通知、截断、记在本机;提示音是三个不同的系统音。
#include "shell/alert_tone.h"
#include "shell/alerter.h"
#include "shell/popup_rules.h"

#include <QFileInfo>
#include <QJsonArray>
#include <QSet>
#include <QSignalSpy>
#include <QTemporaryDir>
#include <QTest>


using namespace ibkr;
using namespace ibkr::shell;
using namespace Qt::StringLiterals;

namespace {

struct FakeOutputs : AlertOutputs {
    QStringList sounds;
    QList<QPair<QString, QString>> notices;
    bool supported = true;
    void playSound(const QString& name) override { sounds.append(name); }
    bool notify(const QString& t, const QString& b) override {
        notices.append({t, b});
        return supported;
    }
};

QJsonObject item(const QString& id) {
    return {{u"id"_s, id}, {u"kind"_s, u"event"_s}, {u"symbol"_s, u"SPX"_s}, {u"title"_s, u"正在公布 CPI"_s}, {u"body"_s, u"盯住现价"_s}, {u"tone"_s, u"info"_s}, {u"at"_s, 5}, {u"page"_s, u"trade"_s}};
}

}  // namespace

class TestAlerter : public QObject {
    Q_OBJECT
private slots:
    void announceGoesToSoundFeedAndPopup() {
        PopupQueue popup;
        FakeOutputs out;
        Alerter a(&popup, &out, {});
        QSignalSpy feed(&a, &Alerter::notified);
        a.announce(item(u"e:1"_s), u"down"_s);
        QCOMPARE(out.sounds.size(), 1);
        QCOMPARE(out.sounds[0], tone::soundFor(u"down"_s));
        QCOMPARE(feed.size(), 1);
        QCOMPARE(feed[0][0].toString(), u"正在公布 CPI"_s);
        QCOMPARE(popup.items().size(), 1);
        QCOMPARE(out.notices.size(), 0);  // 弹窗收下了,不补系统通知
        // 不写通知流的那一种(SPX 关口提醒)
        a.announce(item(u"e:2"_s), {}, false);
        QCOMPARE(feed.size(), 1);
    }

    void popupOffFallsBackToSystemNotification() {
        PopupQueue popup;
        FakeOutputs out;
        Alerter a(&popup, &out, {});
        a.setPopupEnabled(false);
        a.setSoundEnabled(false);
        out.sounds.clear();
        a.announce(item(u"e:1"_s), u"up"_s);
        QCOMPARE(out.sounds.size(), 0);  // 声音关着
        QVERIFY(popup.items().isEmpty());
        QCOMPARE(out.notices.size(), 1);
        QCOMPARE(out.notices[0].first, u"正在公布 CPI"_s);
        // 没有 id 的:清洗时整条丢掉,弹窗回 shown 0 / dropped 0。React 版的 popupCounts 也把它算成 dropped 0,
        // 不补系统通知(照原样搬;调用方都带 id)
        a.setPopupEnabled(true);
        popup.clear();
        out.notices.clear();
        a.announce(item(QString()), {});
        QCOMPARE(out.notices.size(), 0);
    }

    void turningOnGivesAProbe() {
        PopupQueue popup;
        FakeOutputs out;
        Alerter a(&popup, &out, {});
        a.setPopupEnabled(true);
        QCOMPARE(popup.items().at(0).toObject()[u"symbol"].toString(), u"DEMO"_s);  // 打开时弹一条示例
        a.setSoundEnabled(true);
        QCOMPARE(out.sounds.size(), 1);  // 打开时响一声
        out.sounds.clear();
        a.setSoundEnabled(false);
        a.previewTone();  // 试听不看开关
        QCOMPARE(out.sounds.size(), 1);
        QTRY_COMPARE(out.sounds.size(), 2);
        QCOMPARE(out.sounds[0], tone::soundFor(u"down"_s));
        QCOMPARE(out.sounds[1], tone::soundFor(u"up"_s));
    }

    void systemNotifyTruncates() {
        FakeOutputs out;
        Alerter a(nullptr, &out, {});
        QVERIFY(a.systemNotify(QString(200, u'标'), QString(500, u'正')));
        QCOMPARE(out.notices[0].first.size(), 120);
        QCOMPARE(out.notices[0].second.size(), 300);
        out.supported = false;
        QVERIFY(!a.systemNotify(u"x"_s, u"y"_s));
    }

    void prefsPersist() {
        QTemporaryDir dir;
        const QString ini = dir.filePath(u"qt-settings.ini"_s);
        {
            PopupQueue popup;
            FakeOutputs out;
            Alerter a(&popup, &out, ini);
            QVERIFY(a.popupOn() && a.soundOn());  // 默认开
            a.setPopupEnabled(false);
            a.setSoundEnabled(false);
            a.setUpdown(u"red-up"_s);
        }
        PopupQueue popup;
        FakeOutputs out;
        Alerter b(&popup, &out, ini);
        QVERIFY(!b.popupOn());
        QVERIFY(!b.soundOn());
        QCOMPARE(b.updown(), u"red-up"_s);
        b.announce(item(u"e:9"_s), u"up"_s);
        QCOMPARE(out.notices.size(), 1);
    }

    // 提示音:系统自带的提示音,三个方向各一个,互不相同(听声音分得出方向)
    void toneNames() {
        const QStringList names{tone::soundFor(u"up"_s), tone::soundFor(u"down"_s), tone::soundFor({})};
        QCOMPARE(QSet<QString>(names.begin(), names.end()).size(), 3);
        for (const QString& n : names) QVERIFY(QFileInfo::exists(u"/System/Library/Sounds/%1.aiff"_s.arg(n)) || !QFileInfo::exists(u"/System/Library/Sounds"_s));
    }
};

QTEST_GUILESS_MAIN(TestAlerter)
#include "tst_alerter.moc"
