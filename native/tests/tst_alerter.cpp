// 报一条提醒(shell/alerter)与提示音(shell/alert_tone):开关、退回系统通知、截断、记在本机;提示音的音高顺序与包络。
#include "shell/alert_tone.h"
#include "shell/alerter.h"
#include "shell/popup_rules.h"

#include <QJsonArray>
#include <QSignalSpy>
#include <QTemporaryDir>
#include <QTest>

#include <cmath>

using namespace ibkr;
using namespace ibkr::shell;
using namespace Qt::StringLiterals;

namespace {

struct FakeOutputs : AlertOutputs {
    QList<QByteArray> sounds;
    QList<QPair<QString, QString>> notices;
    bool supported = true;
    void playWav(const QByteArray& wav) override { sounds.append(wav); }
    bool notify(const QString& t, const QString& b) override {
        notices.append({t, b});
        return supported;
    }
};

QJsonObject item(const QString& id) {
    return {{u"id"_s, id}, {u"kind"_s, u"event"_s}, {u"symbol"_s, u"SPX"_s}, {u"title"_s, u"正在公布 CPI"_s}, {u"body"_s, u"盯住现价"_s}, {u"tone"_s, u"info"_s}, {u"at"_s, 5}, {u"page"_s, u"trade"_s}};
}

/// 某一时刻附近的最大振幅(0~1)
double peakAround(const QList<qint16>& s, double t, double window = 0.005) {
    int peak = 0;
    for (int i = int((t - window) * tone::kSampleRate); i < int((t + window) * tone::kSampleRate); ++i)
        if (i >= 0 && i < s.size()) peak = std::max(peak, std::abs(int(s[i])));
    return peak / 32767.0;
}

/// 一段里的过零次数 → 频率
double frequencyBetween(const QList<qint16>& s, double t0, double t1) {
    int crossings = 0;
    for (int i = int(t0 * tone::kSampleRate) + 1; i < int(t1 * tone::kSampleRate); ++i)
        if ((s[i - 1] < 0) != (s[i] < 0)) ++crossings;
    return crossings / 2.0 / (t1 - t0);
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
        QCOMPARE(out.sounds[0], tone::wav(u"down"_s));
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
        QCOMPARE(out.sounds[0], tone::wav(u"down"_s));
        QCOMPARE(out.sounds[1], tone::wav(u"up"_s));
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

    // 提示音:升调先低后高、降调先高后低、没有方向两声一样;包络 20ms 爬到 0.6、0.22 秒收掉;两个音隔 0.24 秒
    void toneShape() {
        const QList<qint16> up = tone::samples(u"up"_s);
        QVERIFY(std::abs(frequencyBetween(up, 0.03, 0.09) - 587.33) < 15);
        QVERIFY(std::abs(frequencyBetween(up, 0.27, 0.33) - 880.0) < 15);
        const QList<qint16> down = tone::samples(u"down"_s);
        QVERIFY(std::abs(frequencyBetween(down, 0.03, 0.09) - 880.0) < 15);
        QVERIFY(std::abs(frequencyBetween(down, 0.27, 0.33) - 587.33) < 15);
        const QList<qint16> flat = tone::samples({});
        QVERIFY(std::abs(frequencyBetween(flat, 0.03, 0.09) - frequencyBetween(flat, 0.27, 0.33)) < 15);
        QVERIFY(std::abs(peakAround(up, 0.06) - tone::kPeak) < 0.02);
        QVERIFY(peakAround(up, 0.002, 0.001) < 0.05);   // 起音不咔哒
        QVERIFY(peakAround(up, 0.225, 0.002) < 0.02);   // 收干净了
        QVERIFY(peakAround(up, 0.235, 0.004) < 0.001);  // 两个音之间是静的
        QCOMPARE(up.size(), int(std::ceil(0.47 * tone::kSampleRate)));
        const QByteArray w = tone::wav(u"up"_s);
        QVERIFY(w.startsWith("RIFF") && w.mid(8, 4) == "WAVE");
        QCOMPARE(w.size(), 44 + up.size() * 2);
    }
};

QTEST_GUILESS_MAIN(TestAlerter)
#include "tst_alerter.moc"
