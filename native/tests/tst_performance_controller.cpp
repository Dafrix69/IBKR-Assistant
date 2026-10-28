// 绩效体检页的接线(shell/performance_controller,照 pages/Performance.tsx、PerformanceExtras.tsx、PositionSizer.tsx、SignalScorecard.tsx):对着假引擎。
//   · 进页读一次;范围 / 品种 / 天数一换就重读(天数 0 不带)、记在本机;读着时上一次的结果留着;失败报错、结果不动;权益曲线跟着结果;
//   · 按建议填入:确认框上的字;取消不发;确认了只带那一条规则的 settings.patch,成了横幅 + 重新计算,失败横幅说设置未改动;
//   · 仓位计算器:本机记的权益 / 比例(不是正数当没填、比例兜底 1),每份最大亏损起手是账本中位数,中位数变了才回到它;
//   · 信号成绩单:点了才算,带天数;换天数不清;失败报错;
//   · 切走清空,晚到的回包不落地。
#include "shell/bridge.h"
#include "shell/chart_source.h"
#include "shell/consent.h"
#include "shell/engine_command.h"
#include "shell/performance_controller.h"
#include "shell/status_store.h"
#include "shell_harness.h"

#include <QFile>
#include <QJsonArray>
#include <QSettings>
#include <QTemporaryDir>

using namespace ibkr;
using namespace ibkr::test;
using namespace Qt::StringLiterals;

namespace {

QJsonObject perfData() {
    static const QJsonObject d = [] {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/performance.json"));
        if (!f.open(QIODevice::ReadOnly)) qFatal("performance.json 打不开");
        for (const QJsonValue& p : QJsonDocument::fromJson(f.readAll()).object()[u"pages"_s].toArray())
            if (p[u"name"_s].toString() == u"体检结果") return p[u"seed"_s][u"data"_s].toObject();
        qFatal("performance.json 里没有「体检结果」");
    }();
    return d;
}

QJsonObject signalsData() {
    static const QJsonObject d = [] {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/performance.json"));
        if (!f.open(QIODevice::ReadOnly)) qFatal("performance.json 打不开");
        for (const QJsonValue& p : QJsonDocument::fromJson(f.readAll()).object()[u"pages"_s].toArray())
            if (p[u"name"_s].toString() == u"信号:成绩单") return p[u"seed"_s][u"signals"_s].toObject();
        qFatal("performance.json 里没有「信号:成绩单」");
    }();
    return d;
}

struct Rig {
    QTemporaryDir dir;
    QString resultsPath = dir.filePath(u"results.json"_s);
    QString ini = dir.filePath(u"qt-settings.ini"_s);
    shell::EngineClient engine;
    QStringList logs;
    struct Asker : shell::Prompter {
        bool answer = true;
        QList<shell::ConfirmBox> boxes;
        void ask(const shell::ConfirmBox& b, std::function<void(bool)> d) override {
            boxes << b;
            d(answer);
        }
    } asker;
    shell::ConsentStore consent{dir.path()};
    shell::Bridge bridge{&engine, &asker, &consent};
    shell::StatusStore status{&engine, 60'000};
    QJsonObject results;

    explicit Rig(const QString& delays = {})
        : engine(fakeEngine({{u"FAKE_LOG_PARAMS"_s, u"1"_s}, {u"FAKE_RESULTS_FILE"_s, resultsPath}, {u"FAKE_DELAY_METHODS"_s, delays}}), 40) {
        QObject::connect(&engine, &shell::EngineClient::logLine, [this](const QString& l) { logs.append(l); });
        set(u"review.performance"_s, perfData());
        set(u"review.signals"_s, signalsData());
        set(u"settings.get"_s, QJsonObject{});
        set(u"settings.patch"_s, QJsonObject{{u"ok"_s, true}});
    }
    ~Rig() {
        shell::StopOptions o;
        o.drainMs = 0;
        stopSync(engine, o);
    }
    void set(const QString& method, const QJsonValue& result) {
        results.insert(method, result);
        QFile f(resultsPath);
        QVERIFY(f.open(QIODevice::WriteOnly));
        f.write(QJsonDocument(results).toJson(QJsonDocument::Compact));
    }
    int calls(const QString& method) const { return int(logs.filter(u"[fake] "_s + method + u' ').size()); }
    QStringList params(const QString& method) const {
        QStringList out;
        for (const QString& l : logs)
            if (l.startsWith(u"[fake] "_s + method + u' ')) out << l.mid(8 + method.size());
        return out;
    }
    QVariant setting(const QString& key) const { return QSettings(ini, QSettings::IniFormat).value(key); }
    void preset(const QString& key, const QString& value) {
        QSettings s(ini, QSettings::IniFormat);
        s.setValue(key, value);
    }
};

int specLines(QObject* chart) { return int(qobject_cast<shell::ChartSource*>(chart)->spec().lines.size()); }

}  // namespace

class TestPerformanceController : public QObject {
    Q_OBJECT
private slots:
    void loadsOnScopeKindDays() {
        Rig rig(u"review.performance=150"_s);
        rig.preset(u"perf/scope"_s, u"live"_s);
        rig.preset(u"perf/days"_s, u"30"_s);
        rig.preset(u"perf/kind"_s, u"bogus"_s);  // 认不出:全部品种
        shell::PerformanceController page(&rig.bridge, &rig.status, rig.ini);
        QCOMPARE(rig.calls(u"review.performance"_s), 0);  // 没挂上不读
        page.setVisible(true);
        QVERIFY(page.page()[u"working"_s].toBool());
        QTRY_VERIFY(page.page()[u"hasData"_s].toBool());
        QCOMPARE(rig.params(u"review.performance"_s).first(), u"{\"days\":30,\"kind\":\"all\",\"scope\":\"live\"}"_s);
        QVERIFY(!page.page()[u"loading"_s].toBool());
        QCOMPARE(specLines(page.equityChart()), 2);
        // 换品种:重读、记下;读着时上一次的结果留着(不是「正在翻账本」)
        page.setKind(u"butterfly"_s);
        QVERIFY(page.page()[u"loading"_s].toBool());
        QVERIFY(!page.page()[u"working"_s].toBool());
        QVERIFY(page.page()[u"hasData"_s].toBool());
        QTRY_COMPARE(rig.calls(u"review.performance"_s), 2);
        QCOMPARE(rig.setting(u"perf/kind"_s).toString(), u"butterfly"_s);
        page.setKind(u"butterfly"_s);  // 点已选中的:不读
        // 天数 0:不带 days
        page.setDays(0);
        QTRY_COMPARE(rig.calls(u"review.performance"_s), 3);
        QCOMPARE(rig.params(u"review.performance"_s).last(), u"{\"kind\":\"butterfly\",\"scope\":\"live\"}"_s);
        QCOMPARE(rig.setting(u"perf/days"_s).toString(), u"0"_s);
        page.setScope(u"paper"_s);
        QTRY_COMPARE(rig.calls(u"review.performance"_s), 4);
        QCOMPARE(rig.setting(u"perf/scope"_s).toString(), u"paper"_s);
        page.setScope(u"paper"_s);  // 点已选中的那一段:不读
        page.setDays(0);
        QTRY_VERIFY(!page.page()[u"loading"_s].toBool());
        // 失败:报错,上一次的结果不动
        rig.set(u"review.performance"_s, QJsonObject{{u"__error"_s, u"引擎没起来"_s}});
        page.reload();
        QTRY_COMPARE(page.page()[u"error"_s].toString(), u"引擎没起来"_s);
        QVERIFY(page.page()[u"hasData"_s].toBool());
        // 再成:报错清掉
        rig.set(u"review.performance"_s, perfData());
        page.reload();
        QVERIFY(page.page()[u"error"_s].toString().isEmpty());
        QTRY_VERIFY(!page.page()[u"loading"_s].toBool());
        QCOMPARE(rig.calls(u"review.performance"_s), 6);
    }

    void advicePatchesOneRuleWithoutAsking() {
        Rig rig;
        shell::PerformanceController page(&rig.bridge, &rig.status, rig.ini);
        page.setVisible(true);
        QTRY_VERIFY(page.page()[u"hasData"_s].toBool());
        // 点了就填:不弹框,只带这一条;成了横幅、刷新状态、重新计算
        rig.asker.answer = false;
        page.applyAdvice(u"stoploss_guard"_s);
        QTRY_COMPARE(rig.calls(u"settings.patch"_s), 1);
        QCOMPARE(rig.params(u"settings.patch"_s).first(),
                 u"{\"patch\":{\"protections\":{\"stoploss_guard\":{\"enabled\":true,\"lookback_minutes\":120,\"pause_minutes\":60,\"trigger_count\":3}}}}"_s);
        QTRY_COMPARE(rig.status.banner(), u"止损护栏已打开:120 分钟内止损 3 次 → 暂停 60 分钟"_s);
        QVERIFY(rig.status.bannerInfo());
        QTRY_COMPARE(rig.calls(u"review.performance"_s), 2);
        QVERIFY(rig.calls(u"system.status"_s) >= 1);
        QTRY_VERIFY(!page.page()[u"advice"_s].toArray()[1][u"busy"_s].toBool());
        // 失败:横幅说设置未改动,不重算
        rig.set(u"settings.patch"_s, QJsonObject{{u"__error"_s, u"写不进去"_s}});
        page.applyAdvice(u"daily_loss"_s);
        QTRY_COMPARE(rig.status.banner(), u"没填进去(设置未改动):写不进去"_s);
        QVERIFY(!rig.status.bannerInfo());
        QTest::qWait(100);
        QCOMPARE(rig.calls(u"review.performance"_s), 2);
        QVERIFY(!page.page()[u"advice"_s].toArray()[0][u"busy"_s].toBool());
        // 不认识的规则:什么都不发;从头到尾没弹过框
        const int patches = rig.calls(u"settings.patch"_s);
        page.applyAdvice(u"cooldown"_s);
        QTest::qWait(100);
        QCOMPARE(rig.calls(u"settings.patch"_s), patches);
        QVERIFY(rig.asker.boxes.isEmpty());
    }

    void adviceBusyWhilePatching() {
        Rig rig(u"settings.patch=200"_s);
        shell::PerformanceController page(&rig.bridge, &rig.status, rig.ini);
        page.setVisible(true);
        QTRY_VERIFY(page.page()[u"hasData"_s].toBool());
        page.applyAdvice(u"daily_loss"_s);
        QTRY_VERIFY(page.page()[u"advice"_s].toArray()[0][u"busy"_s].toBool());
        QVERIFY(!page.page()[u"advice"_s].toArray()[1][u"busy"_s].toBool());
        QTRY_VERIFY(!page.page()[u"advice"_s].toArray()[0][u"busy"_s].toBool());
    }

    void sizerReadsAndRemembers() {
        Rig rig;
        rig.preset(u"sizer/equity"_s, u"abc"_s);
        shell::PerformanceController page(&rig.bridge, &rig.status, rig.ini);
        page.setVisible(true);
        QTRY_VERIFY(page.page()[u"hasData"_s].toBool());
        const auto sizer = [&] { return page.page()[u"sizer"_s].toObject(); };
        QVERIFY(sizer()[u"equity"_s].isNull());
        QCOMPARE(sizer()[u"pct"_s].toDouble(), 1.0);
        QCOMPARE(sizer()[u"unit"_s].toDouble(), 450.0);  // 账本里蝶的每份风险中位数
        QVERIFY(!sizer().contains(u"tiles"_s));
        page.setSizerEquity(50000);
        QCOMPARE(rig.setting(u"sizer/equity"_s).toString(), u"50000"_s);
        QCOMPARE(sizer()[u"tiles"_s].toArray().size(), 4);
        page.setSizerPct(1.5);
        QCOMPARE(rig.setting(u"sizer/pct"_s).toString(), u"1.5"_s);
        page.setSizerPct(QVariant());
        QVERIFY(!rig.setting(u"sizer/pct"_s).isValid());
        QVERIFY(!sizer().contains(u"tiles"_s));
        page.setSizerPct(1);
        page.setSizerUnit(QVariant());
        QVERIFY(sizer()[u"unit"_s].isNull());
        // 同一份账本重算:中位数没变,清空的每份最大亏损不回来
        page.reload();
        QTRY_COMPARE(rig.calls(u"review.performance"_s), 2);
        QTRY_VERIFY(!page.page()[u"loading"_s].toBool());
        QVERIFY(sizer()[u"unit"_s].isNull());
        // 中位数变了:回到新的中位数
        QJsonObject d = perfData();
        QJsonArray trades;
        for (const QJsonValue& t : d[u"trades"_s].toArray())
            if (t[u"kind"_s].toString() != u"butterfly" || t[u"risk"_s].isNull() || t[u"risk"_s].toDouble() >= 450) trades << t;
        d[u"trades"_s] = trades;
        rig.set(u"review.performance"_s, d);
        page.reload();
        QTRY_VERIFY(!sizer()[u"unit"_s].isNull());
        QVERIFY(sizer()[u"unit"_s].toDouble() > 450);
        QCOMPARE(sizer()[u"equity"_s].toDouble(), 50000.0);
        // 回来照读
        page.setVisible(false);
        page.setVisible(true);
        QTRY_VERIFY(page.page()[u"hasData"_s].toBool());
        QCOMPARE(sizer()[u"equity"_s].toDouble(), 50000.0);
        QCOMPARE(sizer()[u"pct"_s].toDouble(), 1.0);
    }

    void signalsOnDemand() {
        Rig rig(u"review.signals=150"_s);
        shell::PerformanceController page(&rig.bridge, &rig.status, rig.ini);
        page.setVisible(true);
        QTRY_VERIFY(page.page()[u"hasData"_s].toBool());
        QCOMPARE(rig.calls(u"review.signals"_s), 0);  // 点了才算
        QCOMPARE(page.page()[u"signals"_s][u"button"_s].toString(), u"给信号打分"_s);
        page.setDays(90);
        page.scoreSignals();
        QVERIFY(page.page()[u"signals"_s][u"working"_s].toBool());
        QTRY_VERIFY(!page.page()[u"signals"_s][u"loading"_s].toBool());
        QCOMPARE(rig.params(u"review.signals"_s).first(), u"{\"days\":90}"_s);
        QCOMPARE(page.page()[u"signals"_s][u"button"_s].toString(), u"重新打分"_s);
        QVERIFY(!page.page()[u"signals"_s][u"groups"_s].toArray().isEmpty());
        // 换天数:成绩单留着
        page.setDays(0);
        QVERIFY(!page.page()[u"signals"_s][u"groups"_s].toArray().isEmpty());
        // 重新打分时不是「正在逐只取日线」;失败报错、上一次的留着
        rig.set(u"review.signals"_s, QJsonObject{{u"__error"_s, u"没连 TWS"_s}});
        page.scoreSignals();
        QVERIFY(!page.page()[u"signals"_s][u"working"_s].toBool());
        QTRY_COMPARE(page.page()[u"signals"_s][u"error"_s].toString(), u"没连 TWS"_s);
        QCOMPARE(rig.params(u"review.signals"_s).last(), u"{}"_s);
        QVERIFY(!page.page()[u"signals"_s][u"groups"_s].toArray().isEmpty());
    }

    // 分享卡片的导出(main.js 的 image-export):只收 PNG 的 data URL、不超过 12 MB;拷贝写剪贴板;存盘的路径只来自保存对话框,起点是「下载」+ 安全的文件名;
    // 取消不提示;成败各一句
    void exportImage() {
        Rig rig;
        shell::PerformanceController page(&rig.bridge, &rig.status, rig.ini);
        QList<QPair<QByteArray, QString>> writes;
        QStringList asked;
        QString pick = u"/tmp/x/卡片.png"_s;
        page.imageWriter = [&](const QByteArray& png, const QString& path) { writes.append({png, path}); return QString(); };
        page.pickSavePath = [&](const QString& title, const QString& start, const QString& filter) { asked << title << start << filter; return pick; };
        page.downloadsDir = [] { return u"/Users/u/Downloads"_s; };
        const QByteArray png = QByteArray("\x89PNG\r\n\x1a\n", 8) + "fake";
        const QString url = u"data:image/png;base64,"_s + QString::fromLatin1(png.toBase64());
        // 不是 PNG 的 data URL、太大、坏的 base64:不写
        QCOMPARE(page.exportImage(u"copy"_s, u"data:image/jpeg;base64,AAAA"_s, {})[u"error"_s].toString(), u"图片不合法"_s);
        QCOMPARE(rig.status.banner(), u"拷贝失败:图片不合法"_s);
        QCOMPARE(page.exportImage(u"copy"_s, u"data:image/png;base64,"_s + QString(12 * 1024 * 1024, u'A'), {})[u"error"_s].toString(), u"图片不合法"_s);
        QCOMPARE(page.exportImage(u"copy"_s, u"data:image/png;base64,!!!"_s, {})[u"error"_s].toString(), u"图片不合法"_s);
        QCOMPARE(page.exportImage(u"print"_s, url, {})[u"error"_s].toString(), u"未知操作"_s);
        // 不是 PNG 的字节:弹保存框之前就拒(同 main.js 先 createFromDataURL)
        QCOMPARE(page.exportImage(u"save"_s, u"data:image/png;base64,"_s + QString::fromLatin1(QByteArray("GIF89a").toBase64()), {})[u"error"_s].toString(), u"图片不合法"_s);
        QVERIFY(asked.isEmpty());
        QVERIFY(writes.isEmpty());
        // 拷贝
        QCOMPARE(page.exportImage(u"copy"_s, url, u"交易体检-2026-10-19"_s), (QJsonObject{{u"ok"_s, true}}));
        QCOMPARE(writes.size(), 1);
        QCOMPARE(writes[0].first, png);
        QVERIFY(writes[0].second.isEmpty());
        QCOMPARE(rig.status.banner(), u"已拷贝到剪贴板,可以直接粘贴"_s);
        QVERIFY(asked.isEmpty());
        // 存盘:对话框的起点是「下载」+ 安全的文件名
        QCOMPARE(page.exportImage(u"save"_s, url, u"a/b:c"_s), (QJsonObject{{u"ok"_s, true}, {u"path"_s, pick}}));
        QCOMPARE(asked, (QStringList{u"保存分享卡片"_s, u"/Users/u/Downloads/a_b_c.png"_s, u"PNG 图片 (*.png)"_s}));
        QCOMPARE(writes.last().second, pick);
        QCOMPARE(rig.status.banner(), u"已保存:/tmp/x/卡片.png"_s);
        // 取消:不写、不提示
        pick.clear();
        rig.status.hideBanner();
        QCOMPARE(page.exportImage(u"save"_s, url, {}), (QJsonObject{{u"ok"_s, false}, {u"canceled"_s, true}}));
        QCOMPARE(writes.size(), 2);
        // 写不进去:说一声
        pick = u"/ro/x.png"_s;
        page.imageWriter = [](const QByteArray&, const QString&) { return u"写不进去:/ro/x.png"_s; };
        QCOMPARE(page.exportImage(u"save"_s, url, {})[u"error"_s].toString(), u"写不进去:/ro/x.png"_s);
        QCOMPARE(rig.status.banner(), u"保存失败:写不进去:/ro/x.png"_s);
    }

    // 分享卡片走的路:界面把整张卡片抓成图写到 cardImagePath(),壳从那里读(读完删掉),同样只认 PNG
    void exportCardReadsTheTempFile() {
        Rig rig;
        shell::PerformanceController page(&rig.bridge, &rig.status, rig.ini);
        QList<QByteArray> writes;
        page.imageWriter = [&](const QByteArray& png, const QString&) { writes.append(png); return QString(); };
        const QString path = page.cardImagePath();
        QVERIFY(path.endsWith(u".png"_s));
        // 没有文件:不合法,不写
        QFile::remove(path);
        QCOMPARE(page.exportCard(u"copy"_s, {})[u"error"_s].toString(), u"图片不合法"_s);
        // 不是 PNG:不合法,文件照样删掉
        {
            QFile f(path);
            QVERIFY(f.open(QIODevice::WriteOnly));
            f.write("GIF89a");
        }
        QCOMPARE(page.exportCard(u"copy"_s, {})[u"error"_s].toString(), u"图片不合法"_s);
        QVERIFY(!QFile::exists(path));
        QVERIFY(writes.isEmpty());
        const QByteArray png = QByteArray("\x89PNG\r\n\x1a\n", 8) + "card";
        {
            QFile f(path);
            QVERIFY(f.open(QIODevice::WriteOnly));
            f.write(png);
        }
        QCOMPARE(page.exportCard(u"copy"_s, {}), (QJsonObject{{u"ok"_s, true}}));
        QCOMPARE(writes, QList<QByteArray>{png});
        QVERIFY(!QFile::exists(path));
        // 超过 12 MB 的不读(同 data URL 那条路的上限)
        {
            QFile f(path);
            QVERIFY(f.open(QIODevice::WriteOnly));
            f.write(png + QByteArray(12 * 1024 * 1024, 'x'));
        }
        QCOMPARE(page.exportCard(u"copy"_s, {})[u"error"_s].toString(), u"图片不合法"_s);
        QCOMPARE(writes.size(), 1);
        QVERIFY(!QFile::exists(path));
    }

    // 仓位计算器重挂(新挂上、或中位数变了)时权益与比例照本机记的重读;没有蝶(中位数是 null)时从没挂到挂上也算重挂
    void sizerRemountRereadsAndHandlesNullMedian() {
        Rig rig;
        QJsonObject noFly = perfData();
        QJsonArray stocks;
        for (const QJsonValue& t : noFly[u"trades"_s].toArray())
            if (t[u"kind"_s].toString() != u"butterfly") stocks << t;
        noFly[u"trades"_s] = stocks;
        rig.set(u"review.performance"_s, noFly);
        shell::PerformanceController page(&rig.bridge, &rig.status, rig.ini);
        page.setVisible(true);
        QTRY_VERIFY(page.page()[u"hasData"_s].toBool());
        const auto sizer = [&] { return page.page()[u"sizer"_s].toObject(); };
        QVERIFY(sizer()[u"unit"_s].isNull());
        page.setSizerUnit(175);
        // 换个空范围(卸载),本机改了权益;再回来(重挂):每份回到 null、权益读新的
        QJsonObject empty = noFly;
        QJsonObject st = empty[u"stats"_s].toObject();
        st[u"trades"_s] = 0;
        empty[u"stats"_s] = st;
        rig.set(u"review.performance"_s, empty);
        page.reload();
        QTRY_VERIFY(!page.page()[u"hasData"_s].toBool());
        rig.preset(u"sizer/equity"_s, u"80000"_s);
        rig.set(u"review.performance"_s, noFly);
        page.reload();
        QTRY_VERIFY(page.page()[u"hasData"_s].toBool());
        QVERIFY(sizer()[u"unit"_s].isNull());
        QCOMPARE(sizer()[u"equity"_s].toDouble(), 80000.0);
    }

    void hideDropsLateReplies() {
        Rig rig(u"review.performance=200,review.signals=200"_s);
        shell::PerformanceController page(&rig.bridge, &rig.status, rig.ini);
        page.setVisible(true);
        page.scoreSignals();
        QTRY_COMPARE(rig.calls(u"review.performance"_s), 1);
        page.setVisible(false);
        QTest::qWait(350);
        QVERIFY(!page.page()[u"hasData"_s].toBool());
        QVERIFY(!page.page()[u"loading"_s].toBool());
        QVERIFY(!page.page()[u"signals"_s][u"loading"_s].toBool());
        QCOMPARE(page.page()[u"signals"_s][u"button"_s].toString(), u"给信号打分"_s);
        QCOMPARE(specLines(page.equityChart()), 0);
    }
};

QTEST_GUILESS_MAIN(TestPerformanceController)
#include "tst_performance_controller.moc"
