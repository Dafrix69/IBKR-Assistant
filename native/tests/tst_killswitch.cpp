// engine/util/killswitch 对着原模块(engine-ts/src/killswitch.ts)在同一串操作上的结果(tests/fixtures/gen_killswitch.mjs):
// 9 种起始文件(没有、正常、类型不对、坏的、顶层标量、数组、空对象……)× 4 种阈值 × 4 串操作,每一步的返回、之后的 state()、文件里写了什么。
// at 是当时的钟:比"有没有"与形状(本机时区、到秒)。
#include "util/error.h"
#include "util/killswitch.h"

#include <QDir>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>
#include <QTemporaryDir>
#include <QTest>

using namespace ibkr::util;
using namespace Qt::StringLiterals;

namespace {
QJsonObject masked(const BreakerState& s) {
    QJsonObject o = s.toJson();
    o[u"at"_s] = s.at.isEmpty() ? QString() : u"<AT>"_s;
    return o;
}
QJsonValue maskedFile(const QString& path) {
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly)) return QJsonValue::Null;
    QString text = QString::fromUtf8(f.readAll());
    static const QRegularExpression at(u"\"at\":\"[^\"]*\""_s);
    text.replace(at, u"\"at\":\"<AT>\""_s);
    QJsonParseError err;
    const QJsonDocument doc = QJsonDocument::fromJson(("[" + text + "]").toUtf8(), &err);
    if (err.error != QJsonParseError::NoError) return QJsonObject{{u"raw"_s, text}};
    return QJsonObject{{u"json"_s, doc.array().at(0)}};
}
}  // namespace

class TestKillSwitch : public QObject {
    Q_OBJECT
private slots:
    void scripts() {
        QFile fx(QStringLiteral(IBKR_FIXTURES_DIR "/killswitch.json"));
        QVERIFY(fx.open(QIODevice::ReadOnly));
        const QJsonObject j = QJsonDocument::fromJson(fx.readAll()).object();
        const QJsonArray scripts = j[u"scripts"_s].toArray();
        int n = 0;
        for (const QJsonValue& v : j[u"cases"_s].toArray()) {
            QTemporaryDir dir;
            const QString file = dir.filePath(u"sub/breaker.json"_s);
            KillSwitch ks(file, v[u"threshold"_s].toDouble());
            if (!v[u"start"_s].isNull()) {
                QFile f(file);
                QVERIFY(f.open(QIODevice::WriteOnly));
                f.write(v[u"start"_s].toString().toUtf8());
            }
            const QJsonArray steps = v[u"steps"_s].toArray();
            const QString label = u"第 %1 串(起始 %2,阈值 %3)"_s.arg(n++).arg(v[u"start"_s].toString(), QString::number(v[u"threshold"_s].toDouble()));
            QVERIFY2(masked(ks.state()) == steps[0][u"state"_s].toObject(), qPrintable(label + u" 起始"_s));
            for (qsizetype i = 1; i < steps.size(); ++i) {
                const QJsonObject s = steps[i].toObject();
                const QString op = s[u"op"_s].toString();
                QJsonValue ret = QJsonValue::Null;
                if (op == u"engage") ret = masked(ks.engage(s[u"a"_s].toString(), s[u"b"_s].toBool()));
                else if (op == u"release") ret = masked(s[u"a"_s].isNull() ? ks.release() : ks.release(s[u"a"_s].toString()));
                else if (op == u"success") s[u"a"_s].isNull() ? ks.recordSuccess() : ks.recordSuccess(s[u"a"_s].toString());
                else {
                    const auto r = s[u"b"_s].isNull() ? ks.recordFailure(s[u"a"_s].toString()) : ks.recordFailure(s[u"a"_s].toString(), s[u"b"_s].toString());
                    if (r) ret = masked(*r);
                }
                const QString at = label + u" 第 %1 步 %2"_s.arg(i).arg(op);
                QVERIFY2(ret == s[u"ret"_s], qPrintable(at + u" 返回"_s));
                QVERIFY2(masked(ks.state()) == s[u"state"_s].toObject(), qPrintable(at + u" 状态"_s));
                QVERIFY2(maskedFile(file) == s[u"file"_s], qPrintable(at + u" 文件"_s));
            }
        }
        QCOMPARE(n, 144);
    }

    // 写不进去时 engage 必须抛(同 TS 的 writeFileSync 抛),而且文件里不能是已熔断——不然界面说熔断了,盯盘读到的却没熔断
    void writeFailureThrows() {
        QTemporaryDir dir;
        const QString sub = dir.path() + u"/ro"_s;
        QVERIFY(QDir().mkpath(sub));
        KillSwitch ks(sub + u"/breaker.json"_s, 3);
        QVERIFY(QFile::setPermissions(sub, QFileDevice::ReadOwner | QFileDevice::ExeOwner));
        bool threw = false;
        try {
            ks.engage(u"测试"_s);
        } catch (const JsError& e) {
            threw = true;
            QVERIFY2(e.message().startsWith(u"EACCES: permission denied, open '"_s), qPrintable(e.message()));
        }
        QVERIFY(threw);
        QVERIFY(!ks.state().engaged);
        threw = false;
        try {
            ks.recordFailure(u"x"_s);
        } catch (const JsError&) {
            threw = true;
        }
        QVERIFY(threw);
        QFile::setPermissions(sub, QFileDevice::ReadOwner | QFileDevice::WriteOwner | QFileDevice::ExeOwner);
    }

    void localIsoShape() {
        QVERIFY(QRegularExpression(u"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}[+-]\\d{2}:\\d{2}$"_s).match(localIsoSeconds()).hasMatch());
    }
};

QTEST_GUILESS_MAIN(TestKillSwitch)
#include "tst_killswitch.moc"
