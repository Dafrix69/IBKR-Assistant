// 图表的框架与叠加层(shell/chart_scale)对着浏览器里量出来的 React 版(tests/fixtures/chart_scale.json:native/tools/chart_harness.mjs 把原
// engine.ts + lightweight-charts 打成一页,chart_capture.js 量):24 个场景(5 份 spec × 4 种尺寸、太窄、数据不足、大价位、负数),
// 比可见范围、每根的 x、价格 ↔ y、窗格高、价格轴宽、时间轴高,以及画出来的每一段字(轴上的刻度、轴上的价格标签、叠加层的字、量能满格)。
// 量字用浏览器量出来的宽(同一段字、同一字号字重),这里比的是算法,不是字体。
#include "shell/chart_scale.h"

#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QTest>

#include <cmath>

using namespace ibkr;
using namespace ibkr::shell;
using namespace Qt::StringLiterals;

namespace {

QJsonArray load(const char* name) {
    QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/") + QLatin1StringView(name));
    if (!f.open(QIODevice::ReadOnly)) qFatal("%s 打不开", name);
    return QJsonDocument::fromJson(f.readAll()).array();
}

struct Captured {
    QString text;
    double x, y, px;
    bool bold;
    QString align;
    double w;
    double w0;
};

QList<Captured> texts(const QJsonValue& v) {
    QList<Captured> out;
    QSet<QString> seen;
    static const QRegularExpression font(uR"(^(bold )?([0-9.]+)px)"_s);
    for (const QJsonValue& t : v.toArray()) {
        const QString key = u"%1|%2|%3|%4"_s.arg(t[u"text"].toString()).arg(t[u"x"].toDouble()).arg(t[u"y"].toDouble()).arg(t[u"font"].toString());
        if (seen.contains(key)) continue;  // 两遍重画
        seen.insert(key);
        const auto m = font.match(t[u"font"].toString());
        out.append({t[u"text"].toString(), t[u"x"].toDouble(), t[u"y"].toDouble(), m.captured(2).toDouble(), !m.captured(1).isEmpty(),
                    t[u"align"].toString(), t[u"w"].toDouble(), t[u"w0"].toDouble()});
    }
    return out;
}

/// 量字:浏览器量过的按它;没量过的(轴宽估算用的那两个价)按同字号量过的字逐字平均
chart::Measure measureFrom(const QList<Captured>& all) {
    QHash<QString, double> known;
    QHash<QString, QPair<double, int>> perChar;
    for (const Captured& c : all) {
        known.insert(u"%1|%2|%3"_s.arg(c.text).arg(c.px).arg(c.bold), c.w);
        static const QRegularExpression digits(u"[1-9]"_s);
        known.insert(u"%1|%2|%3"_s.arg(QString(c.text).replace(digits, u"0"_s)).arg(c.px).arg(c.bold), c.w0);
        auto& p = perChar[u"%1|%2"_s.arg(c.px).arg(c.bold)];
        p.first += c.w;
        p.second += int(c.text.size());
    }
    return [known, perChar](const QString& text, double px, bool bold) {
        const auto it = known.constFind(u"%1|%2|%3"_s.arg(text).arg(px).arg(bold));
        if (it != known.cend()) return *it;
        const auto pc = perChar.value(u"%1|%2"_s.arg(px).arg(bold), {px * 0.6, 1});
        return pc.first / std::max(1, pc.second) * text.size();
    };
}

}  // namespace

class TestChartScale : public QObject {
    Q_OBJECT
private slots:
    void cases_data() {
        QTest::addColumn<QJsonObject>("c");
        QTest::addColumn<QJsonObject>("want");
        const QJsonArray cases = load("chart_scale_cases.json"), got = load("chart_scale.json");
        QCOMPARE(cases.size(), got.size());
        for (qsizetype i = 0; i < cases.size(); ++i) QTest::newRow(qPrintable(cases[i][u"name"].toString())) << cases[i].toObject() << got[i].toObject();
    }
    void cases() {
        QFETCH(QJsonObject, c);
        QFETCH(QJsonObject, want);
        const chart::Spec spec = chart::specFromJson(c[u"spec"].toObject());
        const chart::Normalized norm = chart::normalize(spec);
        const QList<Captured> captured = texts(want[u"texts"]);
        // 所有场景量过的字一起当字宽表(轴宽估算的那两个价未必在本场景里画过)
        QList<Captured> everyText;
        for (const QJsonValue& w : load("chart_scale.json")) everyText << texts(w[u"texts"]);
        const chart::Frame f = chart::layoutFrame(spec, norm, c[u"w"].toDouble(), c[u"h"].toDouble(), chart::View{}, measureFrom(everyText), std::nullopt, want[u"dpr"].toDouble(1));

        if (want[u"notice"].isString()) {
            QCOMPARE(f.notice, want[u"notice"].toString());
            return;
        }
        QVERIFY(f.ok);
        QCOMPARE(f.notice, QString());
        QCOMPARE(f.priceAxisW, want[u"priceScaleWidth"].toDouble());
        QCOMPARE(f.paneW, want[u"timeScale"][u"width"].toDouble());
        QCOMPARE(f.timeAxisH, want[u"timeScale"][u"height"].toDouble());
        QCOMPARE(f.paneH.size(), want[u"panes"].toArray().size());
        for (qsizetype i = 0; i < f.paneH.size(); ++i) QCOMPARE(f.paneH[i], want[u"panes"][i].toDouble());
        QVERIFY(std::abs(f.from - want[u"range"][u"from"].toDouble()) < 1e-9);
        QVERIFY(std::abs(f.to - want[u"range"][u"to"].toDouble()) < 1e-9);
        const QJsonArray xs = want[u"xs"].toArray();
        for (qsizetype i = 0; i < xs.size(); ++i)
            if (xs[i].isDouble()) QVERIFY2(std::abs(f.x(double(i)) - xs[i].toDouble()) < 1e-6, qPrintable(u"x(%1) %2 ≠ %3"_s.arg(i).arg(f.x(i)).arg(xs[i].toDouble())));
        for (const QJsonValue& p : want[u"priceAtY"].toArray()) {
            const double got = f.priceAt(p[0].toDouble()), exp = p[1].toDouble();
            QVERIFY2(std::abs(got - exp) <= 1e-9 * std::max(1.0, std::abs(exp)), qPrintable(u"price(%1) %2 ≠ %3"_s.arg(p[0].toDouble()).arg(got, 0, 'g', 17).arg(exp, 0, 'g', 17)));
        }
        for (const QJsonValue& p : want[u"yAtPrice"].toArray())
            if (p[1].isDouble()) QVERIFY2(std::abs(f.y(p[0].toDouble()) - p[1].toDouble()) < 1e-6, qPrintable(u"y(%1) %2 ≠ %3"_s.arg(p[0].toDouble()).arg(f.y(p[0].toDouble())).arg(p[1].toDouble())));

        // 画出来的字:两边逐段对(内容、对齐点、字号、加粗),位置差 0.6 以内
        QList<chart::TextItem> mine = f.texts;
        QStringList missing;
        for (const Captured& w : captured) {
            qsizetype hit = -1;
            for (qsizetype k = 0; k < mine.size(); ++k) {
                const chart::TextItem& t = mine[k];
                if (t.text == w.text && t.align == w.align && t.px == w.px && t.bold == w.bold && std::abs(t.x - w.x) <= 0.6 && std::abs(t.y - w.y) <= 0.6) {
                    hit = k;
                    break;
                }
            }
            if (hit < 0) missing << u"「%1」 %2 @%3,%4 %5px%6"_s.arg(w.text, w.align).arg(w.x).arg(w.y).arg(w.px).arg(w.bold ? u" bold"_s : QString());
            else mine.removeAt(hit);
        }
        QStringList extra;
        for (const chart::TextItem& t : mine) extra << u"「%1」 %2 @%3,%4"_s.arg(t.text, t.align).arg(t.x).arg(t.y);
        QVERIFY2(missing.isEmpty() && extra.isEmpty(), qPrintable(u"缺:\n  "_s + missing.join(u"\n  "_s) + u"\n多:\n  "_s + extra.join(u"\n  "_s)));
    }

    // 交互:同一份 spec(K线 PA,1066 × 440,像素比 2)依次做库的鼠标处理器会做的事,每一步之后的视口与价格区间
    // 对着浏览器里调库的模型量出来的(tests/fixtures/chart_interactions.json,native/tools/chart_interactions.js)
    void interactions() {
        const QJsonObject c = load("chart_scale_cases.json")[0].toObject();
        chart::Spec spec = chart::specFromJson(c[u"spec"].toObject());
        chart::Normalized norm = chart::normalize(spec);
        QList<Captured> everyText;
        for (const QJsonValue& w : load("chart_scale.json")) everyText << texts(w[u"texts"]);
        const chart::Measure measure = measureFrom(everyText);
        const QJsonArray steps = load("chart_interactions.json");
        chart::View view;
        chart::Frame f;
        // 同 ChartView:每一帧之后记下此刻的视口(铺满、改尺寸缩放过的都落定)
        double width = 1066;
        const auto frame = [&] {
            f = chart::layoutFrame(spec, norm, width, 440, view, measure, std::nullopt, 2);
            if (f.ok) view = chart::viewOf(f, view);
        };
        frame();
        const auto check = [&](int k) {
            frame();
            const QJsonObject w = steps[k].toObject();
            const QString at = w[u"name"].toString();
            QVERIFY2(std::abs(f.from - w[u"from"].toDouble()) < 1e-6 && std::abs(f.to - w[u"to"].toDouble()) < 1e-6,
                     qPrintable(u"%1:范围 %2–%3 ≠ %4–%5"_s.arg(at).arg(f.from).arg(f.to).arg(w[u"from"].toDouble()).arg(w[u"to"].toDouble())));
            QVERIFY2(std::abs(f.barSpacing - w[u"barSpacing"].toDouble()) < 1e-9, qPrintable(at));
            QVERIFY2(view.priceRange.has_value() == !w[u"auto"].toBool(), qPrintable(at));
            const double top = f.priceAt(0), bottom = f.priceAt(f.paneH[0] - 1);
            QVERIFY2(std::abs(top - w[u"top"].toDouble()) < 1e-6 && std::abs(bottom - w[u"bottom"].toDouble()) < 1e-6,
                     qPrintable(u"%1:价 %2–%3 ≠ %4–%5"_s.arg(at).arg(bottom, 0, 'f', 6).arg(top, 0, 'f', 6).arg(w[u"bottom"].toDouble(), 0, 'f', 6).arg(w[u"top"].toDouble(), 0, 'f', 6)));
        };
        const auto zoom = [&](double x, double s) {
            const auto keep = view.priceRange;
            view = chart::zoomView(f, x, s);
            view.priceRange = keep;
            frame();
        };
        const auto scroll = [&](double from, double to) {
            view = chart::scrollView(f, view, from - to);
            frame();
        };
        check(0);
        zoom(500, 1); zoom(500, 1); zoom(500, 1);
        check(1);
        scroll(500, 600);
        check(2);
        scroll(500, 3000);
        check(3);
        scroll(500, 380);
        check(4);
        zoom(900, -1); zoom(900, -0.4);
        check(5);
        zoom(-50, 1);
        check(6);
        view = chart::scaleTimeView(f, view, 500, 400);
        check(7);
        view = chart::scaleTimeView(f, view, 300, 700);
        check(8);
        view.priceRange = chart::scalePriceRange(f, {f.minValue, f.maxValue}, 100, 150);
        check(9);
        view.priceRange = chart::shiftPriceRange(f, *view.priceRange, 200, 260);
        check(10);
        view = [&] { auto keep = view.priceRange; auto v = chart::scrollView(f, view, 1.5 * 80); v.priceRange = keep; return v; }();
        check(11);
        view.priceRange.reset();
        check(12);
        zoom(500, 1); zoom(500, 1);
        check(13);
        // 刷新:同一个 viewKey 多一根
        const auto refresh = [&](chart::Spec next) {
            const chart::Normalized nn = chart::normalize(next);
            const auto d = chart::keepViewport(norm, chart::viewKeyOf(spec, norm), chart::ViewRange{f.from, f.to}, nn, chart::viewKeyOf(next, nn));
            if (d.reset) {
                view = chart::View{};
            } else {
                chart::Frame probe = f;
                probe.base = int(nn.times.size()) - 1;
                const auto keep = view.priceRange;
                view = chart::viewForRange(probe, d.range.from, d.range.to);
                view.priceRange = keep;
            }
            spec = std::move(next);
            norm = nn;
            frame();
        };
        chart::Spec more = spec;
        more.bars << more.bars.last();
        more.bars.last().time = u"2026-08-21 10:10"_s;
        refresh(more);
        check(14);
        scroll(500, 700);
        check(15);
        chart::Spec more2 = more;
        more2.bars << more2.bars.last();
        more2.bars.last().time = u"2026-08-21 10:11"_s;
        refresh(more2);
        check(16);
        chart::Spec other = more;
        other.viewKey = u"other"_s;
        refresh(other);
        check(17);
        view = chart::View{};
        frame();
        check(18);
        // 改尺寸(lockVisibleTimeRangeOnResize + fixLeftEdge)
        width = 800;
        frame();
        check(19);
        zoom(400, 1); zoom(400, 1); zoom(400, 1);
        check(20);
        width = 1066;
        frame();
        check(21);
        scroll(500, 3000);
        check(22);
        width = 700;
        frame();
        check(23);
        QCOMPARE(steps.size(), 24);
        // 图区没有宽:不进计算(不会拿 0 去除),只说窗口太窄
        const chart::Frame zero = chart::layoutFrame(spec, norm, 0, 0, chart::View{}, measure);
        QVERIFY(!zero.ok);
        QCOMPARE(zero.notice, u"窗口太窄"_s);
        QVERIFY(!chart::layoutFrame(spec, norm, 60, 440, chart::View{}, measure).ok);
    }
};

QTEST_GUILESS_MAIN(TestChartScale)
#include "tst_chart_scale.moc"
