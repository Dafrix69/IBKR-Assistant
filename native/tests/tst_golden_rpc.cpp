// 阶段 2 的完成标准之一:engine-ts/tests/golden-rpc.spec.ts 的 96 步 RPC 回放,C++ 引擎(ibkr-engine,stdio)答得和 TS 引擎一样。
// 输入与期望值就是 TS 那条测试用的那几份(engine-ts/baseline/rpc/requests.json、expected.json、base_config.json),这里不另存一份;
// 归一化(时间、id、路径、机器相关的键)与比较(数的容差 1e-12 / 1e-9、null 与缺键同一个"空"、键集合一致)逐行照 golden-rpc.spec.ts 与 tests/util.ts。
// 固定时钟与假大模型:TS 那边在进程里换(setClock、parserFactory);这里经环境变量告诉引擎
// (IBKR_ENGINE_CLOCK、IBKR_ENGINE_FAKE_LLM=golden-rpc,只有测试设,引擎读到才换)。
//
// 棘轮:C++ 引擎是一层一层搬过来的,96 步不会一下子全对。fixtures/golden_rpc_passing.json 记着已经对上的步;
// 那些步任何一步不对就红(回退了),新对上的打印出来,把它们加进那份名单(IBKR_GOLDEN_RPC_UPDATE=1 跑一次会自动写回)。名单只许变长。
#include <QDir>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QProcess>
#include <QRegularExpression>
#include <QSet>
#include <QTemporaryDir>
#include <QTest>

#include <cmath>

using namespace Qt::StringLiterals;

namespace {

const QString kRpcDir = QStringLiteral(IBKR_REPO_DIR "/engine-ts/baseline/rpc");
const QString kPassing = QStringLiteral(IBKR_FIXTURES_DIR "/golden_rpc_passing.json");

QJsonValue readJson(const QString& path) {
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly)) qFatal("读不了 %s", qPrintable(path));
    QJsonParseError e;
    const QJsonDocument d = QJsonDocument::fromJson(f.readAll(), &e);
    if (e.error != QJsonParseError::NoError) qFatal("%s 不是 JSON:%s", qPrintable(path), qPrintable(e.errorString()));
    return d.isArray() ? QJsonValue(d.array()) : QJsonValue(d.object());
}

// ---- 归一化(golden-rpc.spec.ts 的 normalize)----
const QSet<QString> kMask{u"latency_ms"_s, u"port_latency_ms"_s, u"now_et"_s, u"at"_s, u"analyzed_at"_s, u"fetched_at"_s, u"created_at"_s, u"updated_at"_s,
                          u"exported_at"_s, u"fired_at"_s, u"last_fired_at"_s, u"raw_response"_s, u"path"_s, u"config"_s, u"unlock_password_saved"_s,
                          u"key_configured"_s};
const QSet<QString> kDrop{u"ports"_s, u"apps"_s, u"connected"_s, u"sdk_installed"_s, u"running"_s, u"installed"_s};

QJsonValue normalize(const QJsonValue& v) {
    static const QRegularExpression uuid(u"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"_s);
    static const QRegularExpression iso(u"^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}"_s);
    static const QRegularExpression path(u"^([A-Za-z]:[\\\\/]|/)"_s);
    if (v.isArray()) {
        QJsonArray out;
        for (const QJsonValue& x : v.toArray()) out.append(normalize(x));
        return out;
    }
    if (v.isObject()) {
        QJsonObject out;
        const QJsonObject o = v.toObject();
        for (auto it = o.begin(); it != o.end(); ++it) {
            if (kMask.contains(it.key())) out.insert(it.key(), u"<VAR>"_s);
            else if (kDrop.contains(it.key())) out.insert(it.key(), u"<MACHINE>"_s);
            else out.insert(it.key(), normalize(it.value()));
        }
        return out;
    }
    if (v.isString()) {
        const QString masked = QString(v.toString()).replace(uuid, u"<ID>"_s);
        if (masked == u"<ID>") return masked;
        if (iso.match(masked).hasMatch()) return u"<TS>"_s;
        if (path.match(masked).hasMatch() && (masked.contains(u'\\') || masked.contains(u'/'))) return u"<PATH>"_s;
        return masked;
    }
    return v;
}

// ---- 比较(tests/util.ts 的 deepCompare + numbersClose)----
bool numbersClose(double a, double b) {
    if (a == b) return true;
    if (!std::isfinite(a) || !std::isfinite(b)) return std::isnan(a) && std::isnan(b);
    const double diff = std::fabs(a - b);
    return diff <= 1e-12 || diff <= 1e-9 * std::max(std::fabs(a), std::fabs(b));
}

QString compact(const QJsonValue& v) {
    if (v.isObject()) return QString::fromUtf8(QJsonDocument(v.toObject()).toJson(QJsonDocument::Compact));
    if (v.isArray()) return QString::fromUtf8(QJsonDocument(v.toArray()).toJson(QJsonDocument::Compact));
    return QString::fromUtf8(QJsonDocument(QJsonArray{v}).toJson(QJsonDocument::Compact)).mid(1).chopped(1);
}

QString deepCompare(const QJsonValue& actual, const QJsonValue& expected, const QString& at) {
    if (expected.isNull() || expected.isUndefined())
        return actual.isNull() || actual.isUndefined() ? QString() : u"%1: expected null, got %2"_s.arg(at, compact(actual));
    if (expected.isDouble()) {
        if (!actual.isDouble()) return u"%1: expected number %2, got %3"_s.arg(at, compact(expected), compact(actual));
        return numbersClose(actual.toDouble(), expected.toDouble()) ? QString() : u"%1: %2 !≈ %3"_s.arg(at, compact(actual), compact(expected));
    }
    if (expected.isString() || expected.isBool())
        return actual == expected ? QString() : u"%1: expected %2, got %3"_s.arg(at, compact(expected), compact(actual));
    if (expected.isArray()) {
        if (!actual.isArray()) return u"%1: expected array, got %2"_s.arg(at, compact(actual));
        const QJsonArray a = actual.toArray(), e = expected.toArray();
        if (a.size() != e.size()) return u"%1: array length %2 != %3"_s.arg(at).arg(a.size()).arg(e.size());
        for (qsizetype i = 0; i < e.size(); ++i) {
            const QString d = deepCompare(a[i], e[i], u"%1[%2]"_s.arg(at).arg(i));
            if (!d.isEmpty()) return d;
        }
        return {};
    }
    if (!actual.isObject()) return u"%1: expected object, got %2"_s.arg(at, compact(actual));
    const QJsonObject a = actual.toObject(), e = expected.toObject();
    QStringList ak, ek = e.keys();
    for (auto it = a.begin(); it != a.end(); ++it) ak << it.key();  // JSON 里没有 undefined:回包里的键都算
    if (ak != ek) {
        QStringList missing, extra;
        for (const QString& k : ek) if (!ak.contains(k)) missing << k;
        for (const QString& k : ak) if (!ek.contains(k)) extra << k;
        return u"%1: key mismatch (missing: %2; extra: %3)"_s.arg(at, missing.isEmpty() ? u"-"_s : missing.join(u'|'), extra.isEmpty() ? u"-"_s : extra.join(u'|'));
    }
    for (const QString& k : ek) {
        const QString d = deepCompare(a[k], e[k], at + u'.' + k);
        if (!d.isEmpty()) return d;
    }
    return {};
}

QJsonValue getPath(const QJsonValue& root, const QString& dotted) {
    QJsonValue cur = root;
    for (const QString& part : dotted.split(u'.')) cur = cur.isArray() ? cur.toArray().at(part.toInt()) : cur.toObject().value(part);
    return cur;
}

QJsonValue substitute(const QJsonValue& v, const QJsonObject& vars) {
    if (v.isArray()) {
        QJsonArray out;
        for (const QJsonValue& x : v.toArray()) out.append(substitute(x, vars));
        return out;
    }
    if (v.isObject()) {
        QJsonObject out;
        const QJsonObject o = v.toObject();
        for (auto it = o.begin(); it != o.end(); ++it) out.insert(it.key(), substitute(it.value(), vars));
        return out;
    }
    if (v.isString() && v.toString().startsWith(u'$')) {
        const QJsonValue got = vars.value(v.toString().mid(1));
        return got.isUndefined() || got.isNull() ? v : got;
    }
    return v;
}

}  // namespace

class TestGoldenRpc : public QObject {
    Q_OBJECT
private slots:
    void replay() {
        const QJsonArray requests = readJson(kRpcDir + u"/requests.json"_s).toArray();
        const QJsonArray expected = readJson(kRpcDir + u"/expected.json"_s).toArray();
        QCOMPARE(requests.size(), expected.size());
        QSet<int> passing;
        for (const QJsonValue& v : readJson(kPassing).toObject().value(u"passing").toArray()) passing.insert(v.toInt());

        QTemporaryDir dir;
        // 配置文件原样写(键序就是内容:别名表、板块次序会进提示词,QJsonObject 会把键排序),只在末尾补上 storage
        QByteArray configText;
        {
            QFile base(kRpcDir + u"/base_config.json"_s);
            QVERIFY(base.open(QIODevice::ReadOnly));
            configText = base.readAll();
        }
        const QByteArray dbPath = QJsonDocument(QJsonArray{dir.filePath(u"trades.db"_s)}).toJson(QJsonDocument::Compact);  // ["…"]:带转义的 JSON 串
        const qsizetype close = configText.lastIndexOf('}');
        QVERIFY(close > 0);
        configText.insert(close, ",\n  \"storage\": {\"db_path\": " + dbPath.mid(1, dbPath.size() - 2) + "}\n");
        const QString settingsPath = dir.filePath(u"settings.json"_s);
        {
            QFile f(settingsPath);
            QVERIFY(f.open(QIODevice::WriteOnly));
            f.write(configText);
        }
        QJsonObject vars{{u"EXPORT_PATH"_s, dir.filePath(u"export.json"_s)}};

        QProcess engine;
        QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
        env.insert(u"IBKR_ENGINE_CLOCK"_s, u"2026-08-14T10:32:00-04:00"_s);  // 同 TS 那条的 setClock:盘中
        env.insert(u"IBKR_ENGINE_FAKE_LLM"_s, u"golden-rpc"_s);
        env.insert(u"IBKR_USER_DATA_DIR"_s, dir.path());
        // 提示词与 JSON schema 资产:编译目录不在仓库里,可执行文件往上找不到,指给它(打包后的应用把它们放在资源目录里)
        env.insert(u"DAFRI_PROMPT_DIR"_s, QStringLiteral(IBKR_REPO_DIR "/prompts"));
        env.insert(u"DAFRI_SCHEMA_DIR"_s, QStringLiteral(IBKR_REPO_DIR "/engine-ts/baseline/llm"));
        engine.setProcessEnvironment(env);
        engine.setProcessChannelMode(QProcess::SeparateChannels);
        engine.start(QStringLiteral(IBKR_ENGINE_PATH), {u"--config"_s, settingsPath});
        QVERIFY2(engine.waitForStarted(5000), qPrintable(engine.errorString()));

        QByteArray buffer;
        const auto readReply = [&](int id) -> QJsonObject {
            for (;;) {
                const qsizetype nl = buffer.indexOf('\n');
                if (nl >= 0) {
                    const QByteArray line = buffer.left(nl);
                    buffer.remove(0, nl + 1);
                    const QJsonObject o = QJsonDocument::fromJson(line).object();
                    if (o.value(u"id").toInt(-1) == id) return o;
                    continue;  // 事件(没有 id 的)丢掉:契约只看回执
                }
                if (!engine.waitForReadyRead(20000)) return QJsonObject{{u"error"_s, QJsonObject{{u"message"_s, u"引擎没回话"_s}}}};
                buffer += engine.readAllStandardOutput();
            }
        };

        QList<int> matched, regressed;
        QStringList firstDiffs;
        for (int i = 0; i < requests.size(); ++i) {
            const QJsonObject step = requests[i].toObject();
            const QJsonObject req{{u"jsonrpc"_s, u"2.0"_s}, {u"id"_s, i}, {u"method"_s, step[u"method"_s]}, {u"params"_s, substitute(step[u"params"_s], vars)}};
            engine.write(QJsonDocument(req).toJson(QJsonDocument::Compact) + '\n');
            const QJsonObject response = readReply(i);
            const QJsonObject capture = step[u"capture"_s].toObject();
            for (auto it = capture.begin(); it != capture.end(); ++it)
                vars.insert(it.key(), getPath(QJsonObject{{u"result"_s, response.value(u"result")}}, it.value().toString()));
            QJsonObject picked;
            if (response.contains(u"result")) picked.insert(u"result"_s, response.value(u"result"));
            if (response.contains(u"error")) picked.insert(u"error"_s, response.value(u"error"));
            const QString diff = deepCompare(normalize(picked), expected[i], u"%1[%2]"_s.arg(step[u"method"_s].toString()).arg(i));
            if (diff.isEmpty()) matched << i;
            else {
                if (passing.contains(i)) regressed << i;
                if (firstDiffs.size() < 12) firstDiffs << diff.left(300);
            }
        }
        engine.closeWriteChannel();
        engine.waitForFinished(5000);

        QList<int> fresh;
        for (int i : matched) if (!passing.contains(i)) fresh << i;
        qInfo().noquote() << u"golden-rpc:对上 %1 / %2 步;名单里 %3 步"_s.arg(matched.size()).arg(requests.size()).arg(passing.size());
        if (!fresh.isEmpty()) {
            QStringList s;
            for (int i : fresh) s << QString::number(i);
            qInfo().noquote() << u"新对上的(加进 golden_rpc_passing.json):"_s + s.join(u", "_s);
        }
        for (const QString& d : firstDiffs) qInfo().noquote() << u"  差:"_s + d;
        if (qEnvironmentVariable("IBKR_GOLDEN_RPC_UPDATE") == u"1" && regressed.isEmpty()) {
            QJsonArray list;
            for (int i : matched) list.append(i);
            QFile f(kPassing);
            QVERIFY(f.open(QIODevice::WriteOnly));
            f.write(QJsonDocument(QJsonObject{{u"passing"_s, list}}).toJson(QJsonDocument::Indented));
        }
        QStringList bad;
        for (int i : regressed) bad << u"%1 %2"_s.arg(i).arg(requests[i][u"method"_s].toString());
        QVERIFY2(regressed.isEmpty(), qPrintable(u"名单里这些步不对了:"_s + bad.join(u", "_s)));
    }
};

QTEST_GUILESS_MAIN(TestGoldenRpc)
#include "tst_golden_rpc.moc"
