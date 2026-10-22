#include "execution/tws_detect.h"

#include "domain/store.h"
#include "execution/ib_exec_history.h"
#include "execution/tws/codec.h"
#include "util/awake_clock.h"
#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsnum.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/market_js.h"

#include <QDir>
#include <QFileInfo>
#include <QPointer>
#include <QProcess>
#include <QSet>
#include <QTcpSocket>
#include <QTimer>

#include <algorithm>
#include <cmath>
#include <limits>

namespace ibkr::execution::twsdetect {

using namespace Qt::StringLiterals;
namespace js = util::js;

namespace {

#ifdef Q_OS_WIN
constexpr bool kWin = true;
#else
constexpr bool kWin = false;
#endif

/// Object.prototype 上的名字:TS 里 `key in {...}`、`obj[name]` 碰到它们会取到原型上的东西
const QSet<QString>& objectProtoNames() {
    static const QSet<QString> s{u"constructor"_s, u"__defineGetter__"_s, u"__defineSetter__"_s, u"hasOwnProperty"_s, u"__lookupGetter__"_s, u"__lookupSetter__"_s,
                                 u"isPrototypeOf"_s, u"propertyIsEnumerable"_s, u"toString"_s, u"valueOf"_s, u"__proto__"_s, u"toLocaleString"_s};
    return s;
}

/// JS 对象的键序:像数组下标的键按数值排在最前,其余按插入的先后
QStringList jsKeyOrder(const QStringList& inserted) {
    QStringList idx, rest;
    for (const QString& k : inserted) (util::jsArrayIndex(k) ? idx : rest).append(k);
    std::stable_sort(idx.begin(), idx.end(), [](const QString& a, const QString& b) { return *util::jsArrayIndex(a) < *util::jsArrayIndex(b); });
    return idx + rest;
}

QString portText(std::optional<double> port) { return port ? util::jsNumberToString(*port) : u"undefined"_s; }

/// 只认 ASCII 的不分大小写包含(JS 正则 /i 不带 u 时,非 ASCII 的字母不会折成 ASCII)
bool asciiContainsI(const QString& hay, const QString& needle) {
    const auto lower = [](QString s) {
        for (QChar& c : s)
            if (c >= u'A' && c <= u'Z') c = QChar(c.unicode() + 32);
        return s;
    };
    return lower(hay).contains(lower(needle));
}

[[maybe_unused]] QString winJoin(const QStringList& parts) {
    // path.win32.join 的近似:用反斜杠拼、去掉 . 与 ..(只在 Windows 上走)
    QString joined = parts.join(u'\\');
    joined.replace(u'/', u'\\');
    return QDir::toNativeSeparators(QDir::cleanPath(QDir::fromNativeSeparators(joined)));
}

QString pathJoin(const QString& a, const QString& b) {
    if constexpr (kWin) return winJoin({a, b});
    return posixJoin(a, b);
}

QString pathBasename(const QString& p) {
    if constexpr (kWin) {
        QString s = p;
        s.replace(u'\\', u'/');
        return posixBasename(s);
    }
    return posixBasename(p);
}

[[maybe_unused]] QString pathDirname(const QString& p) {
    if constexpr (kWin) return QDir::toNativeSeparators(QFileInfo(p).path());
    return posixDirname(p);
}

}  // namespace

// ---------------------------------------------------------------- 常量

const std::vector<Endpoint>& knownEndpoints() {
    static const std::vector<Endpoint> e{
        {7496, u"TWS 实盘"_s, u"tws"_s, false},
        {7497, u"TWS 模拟"_s, u"tws"_s, true},
        {4001, u"IB Gateway 实盘"_s, u"gateway"_s, false},
        {4002, u"IB Gateway 模拟"_s, u"gateway"_s, true},
    };
    return e;
}

contract::OrderedMap<QStringList> appCandidates() {
    contract::OrderedMap<QStringList> out;
    if constexpr (kWin) {
        const QString local = system().env(u"LOCALAPPDATA"_s).value_or(QString());
        out.insert(u"tws"_s, {u"C:/Jts/tws.exe"_s, u"C:/Jts/*/tws.exe"_s, u"~/Jts/tws.exe"_s, u"~/Jts/*/tws.exe"_s, winJoin({local, u"Jts"_s, u"tws.exe"_s})});
        out.insert(u"gateway"_s, {u"C:/Jts/ibgateway/*/ibgateway.exe"_s, u"C:/Jts/ibgateway.exe"_s, u"~/Jts/ibgateway/*/ibgateway.exe"_s,
                                  winJoin({local, u"Jts"_s, u"ibgateway"_s, u"*"_s, u"ibgateway.exe"_s})});
    } else {
        out.insert(u"tws"_s, {u"/Applications/Trader Workstation.app"_s, u"/Applications/Trader Workstation */Trader Workstation *.app"_s,
                              u"~/Applications/Trader Workstation.app"_s, u"~/Applications/Trader Workstation */Trader Workstation *.app"_s});
        out.insert(u"gateway"_s, {u"/Applications/IB Gateway.app"_s, u"/Applications/IB Gateway */IB Gateway *.app"_s, u"~/Applications/IB Gateway.app"_s,
                                  u"~/Applications/IB Gateway */IB Gateway *.app"_s});
    }
    return out;
}

contract::OrderedMap<QString> processPatterns() {
    contract::OrderedMap<QString> out;
    out.insert(u"tws"_s, kWin ? u"tws.exe"_s : u"Trader Workstation"_s);
    out.insert(u"gateway"_s, kWin ? u"ibgateway.exe"_s : u"ibgateway"_s);
    return out;
}

const std::vector<std::pair<QString, QString>>& ibkrErrorHints() {
    static const std::vector<std::pair<QString, QString>> h{
        {u"326"_s, u"clientId 已被占用。换一个 clientId,或关掉正在用同一 ID 的程序。"_s},
        {u"502"_s, u"无法连接到 TWS。多半是 API 没启用:TWS → Configure → API → Settings,"
                   u"勾上「Enable ActiveX and Socket Clients」,并确认 Socket port 与这里一致。"_s},
        {u"504"_s, u"未连接。请确认 TWS 已完成登录(登录界面停着是连不上的)。"_s},
        {u"1100"_s, u"与 IBKR 的连接已断开,TWS 正在重连。"_s},
        {u"2110"_s, u"与 IBKR 的连接暂时中断,TWS 会自动恢复。"_s},
    };
    return h;
}

// ---------------------------------------------------------------- JSON 形状

OJson PortStatus::toJson() const {
    return js::object({{u"port"_s, js::N(port)},
                       {u"label"_s, js::S(label)},
                       {u"kind"_s, js::S(kind)},
                       {u"paper"_s, paper ? js::B(*paper) : js::Null()},
                       {u"open"_s, js::B(open)},
                       {u"latency_ms"_s, js::NOrNull(latency_ms)},
                       {u"error"_s, error ? js::S(*error) : js::Null()},
                       {u"configured_as"_s, configured_as ? js::S(*configured_as) : js::Null()}});
}

OJson AppStatus::toJson() const {
    return js::object({{u"key"_s, js::S(key)}, {u"name"_s, js::S(name)}, {u"installed"_s, js::B(installed)}, {u"paths"_s, js::strings(paths)}, {u"running"_s, js::B(running)}});
}

OJson LaunchResult::toJson() const { return js::object({{u"launched"_s, js::B(launched)}, {u"path"_s, js::S(path)}}); }

OJson ExplainedError::toJson() const { return js::object({{u"reason"_s, js::S(reason)}, {u"hint"_s, js::S(hint)}, {u"code"_s, js::S(code)}}); }

OJson DiagnoseAccount::toJson() const {
    return js::object({{u"alias"_s, js::S(alias)},
                       {u"account_masked"_s, js::S(account_masked)},
                       {u"is_paper"_s, js::B(is_paper)},
                       {u"connection"_s, js::S(connection)},
                       {u"resolved"_s, js::B(resolved)},
                       {u"default"_s, js::B(isDefault)}});
}

OJson GuideStep::toJson() const { return js::object({{u"step"_s, js::N(step)}, {u"title"_s, js::S(title)}, {u"detail"_s, js::S(detail)}}); }

// ---------------------------------------------------------------- 路径

QString posixNormalize(const QString& p) {
    if (p.isEmpty()) return u"."_s;
    const bool absolute = p.startsWith(u'/');
    const bool trailing = p.endsWith(u'/');
    QStringList out;
    for (const QString& seg : p.split(u'/')) {
        if (seg.isEmpty() || seg == u".") continue;
        if (seg == u"..") {
            if (!out.isEmpty() && out.last() != u"..") out.removeLast();
            else if (!absolute) out.append(seg);
            continue;
        }
        out.append(seg);
    }
    QString s = out.join(u'/');
    if (s.isEmpty() && !absolute) s = u"."_s;
    if (!s.isEmpty() && trailing) s += u'/';
    return absolute ? u"/"_s + s : s;
}

QString posixJoin(const QString& a, const QString& b) {
    QString joined;
    for (const QString& part : {a, b}) {
        if (part.isEmpty()) continue;
        joined = joined.isEmpty() ? part : joined + u'/' + part;
    }
    if (joined.isEmpty()) return u"."_s;
    return posixNormalize(joined);
}

QString posixBasename(const QString& p) {
    qsizetype end = p.size();
    while (end > 0 && p[end - 1] == u'/') --end;
    if (end == 0) return {};
    const qsizetype slash = p.lastIndexOf(u'/', end - 1);
    return p.mid(slash + 1, end - slash - 1);
}

QString posixDirname(const QString& p) {
    // 同 Node 的 path.posix.dirname:从尾往前找第一个"前面有非斜杠"的斜杠,中间连着的斜杠不收
    if (p.isEmpty()) return u"."_s;
    const bool hasRoot = p[0] == u'/';
    qsizetype end = -1;
    bool matchedSlash = true;
    for (qsizetype i = p.size() - 1; i >= 1; --i) {
        if (p[i] == u'/') {
            if (!matchedSlash) {
                end = i;
                break;
            }
        } else {
            matchedSlash = false;
        }
    }
    if (end == -1) return hasRoot ? u"/"_s : u"."_s;
    if (hasRoot && end == 1) return u"//"_s;
    return p.left(end);
}

// ---------------------------------------------------------------- glob

namespace {

constexpr bool kNoCase =
#if defined(Q_OS_MACOS) || defined(Q_OS_WIN)
    true;
#else
    false;
#endif

bool sameChar(QChar a, QChar b) { return kNoCase ? a.toCaseFolded() == b.toCaseFolded() : a == b; }

/// 一段里的 [..]:返回是否匹配、走到哪儿;写坏的(没有收尾的 ])当普通字符
bool matchClass(const QString& pat, qsizetype& i, QChar c, bool& ok) {
    qsizetype j = i + 1;
    bool negate = false;
    if (j < pat.size() && (pat[j] == u'!' || pat[j] == u'^')) {
        negate = true;
        ++j;
    }
    bool hit = false;
    bool first = true;
    while (j < pat.size() && (first || pat[j] != u']')) {
        first = false;
        const QChar lo = pat[j];
        QChar hi = lo;
        if (j + 2 < pat.size() && pat[j + 1] == u'-' && pat[j + 2] != u']') {
            hi = pat[j + 2];
            j += 2;
        }
        const QChar cc = kNoCase ? c.toCaseFolded() : c;
        const QChar l = kNoCase ? lo.toCaseFolded() : lo, h = kNoCase ? hi.toCaseFolded() : hi;
        if (cc >= l && cc <= h) hit = true;
        ++j;
    }
    if (j >= pat.size()) {
        ok = false;  // 没有收尾:不是字符类
        return false;
    }
    ok = true;
    i = j + 1;
    return hit != negate;
}

bool matchSegment(const QString& pat, qsizetype pi, const QString& name, qsizetype ni) {
    while (pi < pat.size()) {
        const QChar c = pat[pi];
        if (c == u'*') {
            while (pi < pat.size() && pat[pi] == u'*') ++pi;
            if (pi == pat.size()) return true;
            for (qsizetype k = ni; k <= name.size(); ++k)
                if (matchSegment(pat, pi, name, k)) return true;
            return false;
        }
        if (ni >= name.size()) return false;
        if (c == u'?') {
            ++pi;
            ++ni;
            continue;
        }
        if (c == u'[') {
            qsizetype at = pi;
            bool ok = false;
            const bool hit = matchClass(pat, at, name[ni], ok);
            if (ok) {
                if (!hit) return false;
                pi = at;
                ++ni;
                continue;
            }
        }
        if (!sameChar(c, name[ni])) return false;
        ++pi;
        ++ni;
    }
    return ni == name.size();
}

bool hasMagic(const QString& seg) {
    return seg.contains(u'*') || seg.contains(u'?') || seg.contains(u'[');
}

/// {a,b} 展开(可以套着写)
QStringList expandBraces(const QString& p) {
    qsizetype open = -1;
    int depth = 0;
    for (qsizetype i = 0; i < p.size(); ++i) {
        if (p[i] == u'{') {
            if (depth++ == 0) open = i;
        } else if (p[i] == u'}' && depth > 0) {
            if (--depth == 0) {
                QStringList alts;
                int d = 0;
                qsizetype from = open + 1;
                for (qsizetype k = open + 1; k < i; ++k) {
                    if (p[k] == u'{') ++d;
                    else if (p[k] == u'}') --d;
                    else if (p[k] == u',' && d == 0) {
                        alts.append(p.mid(from, k - from));
                        from = k + 1;
                    }
                }
                alts.append(p.mid(from, i - from));
                if (alts.size() < 2) return {p};
                QStringList out;
                for (const QString& a : alts)
                    for (const QString& tail : expandBraces(p.mid(i + 1))) out += expandBraces(p.left(open) + a + tail);
                return out;
            }
        }
    }
    return {p};
}

QStringList entriesOf(const QString& dir) {
    QDir d(dir.isEmpty() ? u"."_s : dir);
    return d.entryList(QDir::AllEntries | QDir::Hidden | QDir::System | QDir::NoDotAndDotDot);
}

void walk(const QString& base, const QStringList& segs, qsizetype i, QStringList& out) {
    const auto child = [&](const QString& name) { return base.isEmpty() ? name : (base == u"/" ? base + name : base + u'/' + name); };
    if (i == segs.size()) {
        if (QFileInfo(base).exists() || QFileInfo(base).isSymLink()) out.append(base);
        return;
    }
    const QString& seg = segs[i];
    if (seg == u"**") {
        walk(base, segs, i + 1, out);  // 零层
        for (const QString& name : entriesOf(base)) {
            if (name.startsWith(u'.')) continue;
            const QFileInfo fi(child(name));
            // 真目录往下走(还在 ** 上);文件与链接只当作 ** 吃掉了它,接着比下一段
            if (fi.isDir() && !fi.isSymLink()) walk(child(name), segs, i, out);
            else walk(child(name), segs, i + 1, out);
        }
        return;
    }
    if (!hasMagic(seg)) {
        walk(child(seg), segs, i + 1, out);
        return;
    }
    for (const QString& name : entriesOf(base)) {
        if (name.startsWith(u'.') && !seg.startsWith(u'.')) continue;
        if (matchSegment(seg, 0, name, 0)) walk(child(name), segs, i + 1, out);
    }
}

}  // namespace

QStringList globFiles(const QString& pattern) {
    QStringList out;
    // 反斜杠当路径分隔符(Node 的 fs.glob 在这台机器上就是这样:"Ab\\?c.app" 什么也不中),不当转义
    QString pat = pattern;
    pat.replace(u'\\', u'/');
    for (const QString& one : expandBraces(pat)) {
        const QString norm = posixNormalize(one);
        const bool absolute = norm.startsWith(u'/');
        QStringList segs = norm.split(u'/', Qt::SkipEmptyParts);
        if (segs.size() == 1 && segs[0] == u".") segs.clear();
        walk(absolute ? u"/"_s : QString(), segs, 0, out);
    }
    QStringList unique;
    for (const QString& s : out)
        if (!unique.contains(s)) unique.append(s);
    return unique;
}

// ---------------------------------------------------------------- 外面的世界

TwsSystem realSystem() {
    TwsSystem s;
#if defined(Q_OS_MACOS)
    s.platform = u"darwin"_s;
#elif defined(Q_OS_WIN)
    s.platform = u"win32"_s;
#elif defined(Q_OS_LINUX)
    s.platform = u"linux"_s;
#else
    s.platform = u"unknown"_s;
#endif
    s.homedir = [] { return QDir::homePath(); };
    s.env = [](const QString& name) -> std::optional<QString> {
        if (!qEnvironmentVariableIsSet(name.toUtf8().constData())) return std::nullopt;
        return qEnvironmentVariable(name.toUtf8().constData());
    };
    s.globSync = globFiles;
    s.existsSync = [](const QString& p) { return QFileInfo::exists(p); };
    s.spawnSync = [](const QString& cmd, const QStringList& args, std::optional<int> timeoutMs) {
        SpawnResult r;
        QProcess proc;
        proc.start(cmd, args);
        if (!proc.waitForStarted()) return r;
        if (!proc.waitForFinished(timeoutMs.value_or(-1))) {
            proc.kill();
            proc.waitForFinished();
            return r;
        }
        r.stdoutText = QString::fromUtf8(proc.readAllStandardOutput());
        r.stderrText = QString::fromUtf8(proc.readAllStandardError());
        if (proc.exitStatus() == QProcess::NormalExit) r.status = proc.exitCode();
        return r;
    };
    s.spawnDetached = [](const QString& target, const QString& cwd) { QProcess::startDetached(target, {}, cwd); };
    return s;
}

TwsSystem& system() {
    static TwsSystem s = realSystem();
    return s;
}

// ---------------------------------------------------------------- 端口

Task<ProbeResult> probePort(std::optional<QString> host, std::optional<double> port, double timeoutMs) {
    const QString h = host.value_or(u"127.0.0.1"_s);
    const double p = port.value_or(7497);
    util::Deferred<ProbeResult> d;
    if (const auto bad = nodeBadPortMessage(p)) {
        d.reject(NamedError(*bad, u"RangeError"_s, u"ERR_SOCKET_BAD_PORT"_s));
        return d.task();
    }
    auto* holder = new QObject;
    auto* socket = new QTcpSocket(holder);
    const qint64 started = util::awakeMicros();
    auto done = std::make_shared<bool>(false);
    auto finish = [d, holder, socket, done](ProbeResult result) mutable {
        if (*done) return;
        *done = true;
        socket->abort();
        holder->deleteLater();
        d.resolve(std::move(result));
    };
    // socket.setTimeout(0) 是不设超时
    if (timeoutMs > 0) {
        QTimer::singleShot(static_cast<int>(std::min(timeoutMs, 2147483647.0)), holder, [finish]() mutable {
            finish(ProbeResult{false, std::nullopt, u"连接超时"_s});
        });
    }
    QObject::connect(socket, &QTcpSocket::connected, holder, [finish, started]() mutable {
        finish(ProbeResult{true, std::trunc(static_cast<double>(util::awakeMicros() - started) / 1000.0), std::nullopt});
    });
    QObject::connect(socket, &QTcpSocket::errorOccurred, holder, [finish, socket, h, p](QAbstractSocket::SocketError e) mutable {
        if (e == QAbstractSocket::ConnectionRefusedError) finish(ProbeResult{false, std::nullopt, u"端口未监听"_s});
        else finish(ProbeResult{false, std::nullopt, nodeSocketErrorMessage(e, h, static_cast<quint16>(p), socket->peerAddress().toString(), socket->errorString())});
    });
    socket->connectToHost(h, static_cast<quint16>(p));
    return d.task();
}

Task<std::vector<PortStatus>> scanPorts(const domain::Settings& settings, QString host, PortProber prober) {
    ConfiguredPorts configured;
    const auto conns = settings.connectionsFor(u"ibkr"_s);
    for (const QString& name : jsKeyOrder(conns.keys())) configured.emplace_back(conns.find(name)->port, name);
    return scanEndpoints(knownEndpoints(), std::move(configured), std::move(host), std::move(prober));
}

Task<std::vector<PortStatus>> scanEndpoints(std::vector<Endpoint> known, ConfiguredPorts configured, QString host, PortProber prober) {
    if (!prober) prober = [](std::optional<QString> h, std::optional<double> p) { return probePort(std::move(h), p); };
    // Record<number, string>:键是 String(port),后写的覆盖前写的,键序照 JS 对象
    QStringList inserted;
    QHash<QString, QString> byKey;
    for (const auto& [port, name] : configured) {
        const QString key = util::jsNumberToString(port);
        if (!byKey.contains(key)) inserted.append(key);
        byKey.insert(key, name);
    }
    std::vector<Endpoint> entries = known;
    QList<double> knownPorts;
    for (const Endpoint& e : entries) knownPorts.append(e.port);
    std::vector<double> ports;
    for (const QString& k : jsKeyOrder(inserted)) ports.push_back(util::jsStringToNumber(k));
    util::market::jsSort(ports, [](double a, double b) { return a - b; });  // V8 的排序走法:端口是 NaN 时次序看算法
    for (const double port : ports) {
        // Set.has 是 SameValueZero:NaN 认 NaN
        const bool has = std::any_of(knownPorts.begin(), knownPorts.end(), [&](double k) { return k == port || (std::isnan(k) && std::isnan(port)); });
        if (!has) entries.push_back(Endpoint{port, u"自定义端口(连接 %1)"_s.arg(byKey.value(util::jsNumberToString(port))), u"custom"_s, std::nullopt});
    }
    std::vector<PortStatus> results;
    for (const Endpoint& entry : entries) {
        const ProbeResult probe = co_await prober(host, entry.port);
        PortStatus s;
        s.port = entry.port;
        s.label = entry.label;
        s.kind = entry.kind;
        s.paper = entry.paper;
        s.open = probe.open;
        s.latency_ms = probe.latency_ms;
        s.error = probe.error;
        const QString key = util::jsNumberToString(entry.port);
        if (byKey.contains(key)) s.configured_as = byKey.value(key);
        results.push_back(s);
    }
    co_return results;
}

// ---------------------------------------------------------------- 应用检测与拉起

QStringList expandGlob(const QString& pattern) {
    QString p = pattern;
    TwsSystem& sys = system();
    if (p.startsWith(u'~')) p = pathJoin(sys.homedir(), p.mid(1));
    try {
        QStringList out;
        for (const QString& m : sys.globSync(p))
            if (sys.existsSync(m)) out.append(m);
        std::sort(out.begin(), out.end());
        return out;
    } catch (const util::JsError&) {
        return sys.existsSync(p) ? QStringList{p} : QStringList{};
    }
}

bool processRunning(const std::optional<QString>& pattern) {
    TwsSystem& sys = system();
    if constexpr (kWin) {
        const QString pat = pattern.value_or(u"undefined"_s);
        const SpawnResult proc = sys.spawnSync(u"tasklist"_s, {u"/FI"_s, u"IMAGENAME eq "_s + pat, u"/NH"_s, u"/FO"_s, u"CSV"_s}, 5000);
        if (proc.status != 0) return false;
        // pattern 是 undefined 时 TS 在 toLowerCase 上抛,被 catch 成 false
        if (!pattern) return false;
        return proc.stdoutText.toLower().contains(pattern->toLower());
    }
    if (sys.platform != u"darwin" && sys.platform != u"linux") return false;
    // spawnSync 的参数里有 undefined 会当场抛(ERR_INVALID_ARG_TYPE),被 catch 成 false
    if (!pattern) return false;
    try {
        const SpawnResult proc = sys.spawnSync(u"pgrep"_s, {u"-f"_s, *pattern}, 3000);
        return proc.status == 0 && !util::jsTrim(proc.stdoutText).isEmpty();
    } catch (const util::JsError&) {
        return false;
    }
}

std::vector<AppStatus> detectApps(const std::optional<contract::OrderedMap<QStringList>>& candidates, const std::optional<contract::OrderedMap<QString>>& patterns) {
    const contract::OrderedMap<QStringList> cands = candidates ? *candidates : appCandidates();
    const contract::OrderedMap<QString> pats = patterns ? *patterns : processPatterns();
    std::vector<AppStatus> apps;
    for (const QString& key : jsKeyOrder(cands.keys())) {
        QStringList found;
        for (const QString& pattern : *cands.find(key)) {
            // install4j 把「Trader Workstation 10.50 Uninstaller.app」放在本体旁边,通配符两个都中:滤掉
            if (pattern.isEmpty()) continue;
            for (const QString& p : expandGlob(pattern))
                if (!asciiContainsI(pathBasename(p), u"uninstall"_s)) found.append(p);
        }
        AppStatus app;
        app.key = key;
        app.name = key == u"tws" ? u"Trader Workstation"_s : u"IB Gateway"_s;
        app.installed = !found.isEmpty();
        app.paths = found.mid(0, 5);
        const QString* pat = pats.find(key);
        app.running = processRunning(pat ? std::optional<QString>(*pat) : std::nullopt);
        apps.push_back(app);
    }
    return apps;
}

LaunchResult launchApp(const QString& key) {
    if (!(appCandidates().contains(key) || objectProtoNames().contains(key)))
        throw util::JsError(u"只支持拉起 tws 或 gateway,收到:'%1'"_s.arg(key));
    TwsSystem& sys = system();
    if (sys.platform != u"darwin" && !kWin) throw util::JsError(u"当前平台不支持一键拉起,请手动启动 TWS / IB Gateway。"_s);
    for (const AppStatus& app : detectApps()) {
        if (app.key != key || app.paths.isEmpty()) continue;
        const QString target = app.paths.first();
        if constexpr (kWin) {
            // cwd 设为安装目录:TWS 启动器按相对路径找 jars/ 与 jts.ini
            sys.spawnDetached(target, pathDirname(target));
        } else {
            const SpawnResult proc = sys.spawnSync(u"open"_s, {u"-a"_s, target}, std::nullopt);
            if (proc.status != 0) {
                const QString err = util::jsTrim(proc.stderrText);
                throw util::JsError(u"启动失败:"_s + (err.isEmpty() ? u"未知错误"_s : err));
            }
        }
        return LaunchResult{true, target};
    }
    throw util::JsError(u"没有找到 %1 的安装。请先从 IBKR 官网下载安装。"_s.arg(key == u"tws" ? u"Trader Workstation"_s : u"IB Gateway"_s));
}

// ---------------------------------------------------------------- 握手诊断

ConnectErrorInfo errorInfoOf(const util::JsError& e) {
    ConnectErrorInfo info;
    info.message = e.message();
    if (const auto* named = dynamic_cast<const NamedError*>(&e)) {
        info.name = named->name();
        info.ctorName = named->name();
    }
    if (const auto* coded = dynamic_cast<const util::CodedError*>(&e)) info.code = coded->code();
    return info;
}

ExplainedError explainConnectError(const ConnectErrorInfo& exc, std::optional<double> port, bool portOpen) {
    // 对应 Python 的 type(exc).__name__:优先 err.name
    const QString name = exc.name.isEmpty() ? exc.ctorName : exc.name;
    const QString& text = exc.message;
    for (const auto& [code, hint] : ibkrErrorHints())
        if (text.contains(code)) return {text.isEmpty() ? name : text, hint, code};
    const QString lowered = text.toLower();
    if (exc.code == u"ECONNREFUSED" || lowered.contains(u"refused")) {
        return {u"端口 %1 拒绝连接"_s.arg(portText(port)),
                u"TWS / IB Gateway 没有在跑,或者它的 API 端口不是 %1。先启动并登录 TWS,再在 Configure → API → Settings 里核对 Socket port。"_s.arg(portText(port)),
                u"refused"_s};
    }
    if (lowered.contains(u"timeout") || name.toLower().contains(u"timeout")) {
        if (portOpen) {
            return {u"端口开着,但握手超时"_s,
                    u"程序在跑,API 没放行。两种常见情况:①「Enable ActiveX and Socket Clients」没勾;② TWS 弹出了「接受传入连接」的确认框,正等你点「Yes」。"_s,
                    u"handshake_timeout"_s};
        }
        return {u"连接超时"_s, u"确认 TWS / IB Gateway 已启动并**完成登录**,停在登录界面时 API 不会响应。"_s, u"timeout"_s};
    }
    return {name + u": "_s + text, u"详见引擎日志。"_s, u"unknown"_s};
}

std::pair<std::vector<DiagnoseAccount>, QStringList> checkAliasMapping(const domain::Settings& settings, const QStringList& managedAccounts,
                                                                       const std::optional<QString>& connectionName) {
    QStringList managed;  // Set:插入的先后、去重
    for (const QString& a : managedAccounts)
        if (!a.isEmpty() && !managed.contains(a)) managed.append(a);
    std::vector<DiagnoseAccount> rows;
    for (const auto& account : settings.accounts) {
        if (connectionName && account.connection != *connectionName) continue;
        rows.push_back(DiagnoseAccount{account.alias, domain::redactAccount(account.account_id), account.is_paper, account.connection,
                                       managed.contains(account.account_id), account.isDefault});
    }
    QSet<QString> configuredIds;
    for (const auto& a : settings.accounts) configuredIds.insert(a.account_id);
    QStringList unmapped;
    for (const QString& a : managed)
        if (!configuredIds.contains(a)) unmapped.append(a);
    std::sort(unmapped.begin(), unmapped.end());
    QStringList masked;
    for (const QString& a : unmapped) masked.append(domain::redactAccount(a));
    return {rows, masked};
}

namespace {

/// 默认握手的一趟(@stoqey/ib 的 IBApi 连一次:握手 → 报到 → 下一个订单号到了再要账户表)
class HandshakeRun : public QObject {
public:
    HandshakeRun(const QString& host, quint16 port, double clientId, double timeoutMs, util::Deferred<HandshakeInfo> d)
        : host_(host), port_(port), clientId_(clientId), deferred_(std::move(d)) {
        double after = timeoutMs;
        if (!(after >= 1 && after <= 2147483647.0)) after = 1;
        QTimer::singleShot(static_cast<int>(std::trunc(after)), this, [this] { reject(u"timeout"_s); });
        connect(&socket_, &QTcpSocket::connected, this, [this] { socket_.write(tws::handshake(tws::kMinVersion, tws::kMainMaxVersion)); });
        connect(&socket_, &QTcpSocket::readyRead, this, [this] { onData(socket_.readAll()); });
        connect(&socket_, &QTcpSocket::errorOccurred, this, [this](QAbstractSocket::SocketError e) {
            // 对方关了:库只记"断开",不报错(等超时)
            if (e == QAbstractSocket::RemoteHostClosedError) return;
            reject(u"502: "_s + nodeSocketErrorMessage(e, host_, port_, socket_.peerAddress().toString(), socket_.errorString()));
        });
        socket_.connectToHost(host_, port_);
    }

private:
    /// api.disconnect():先把没发完的发完再关(同 Node 的 socket.end),关完或两秒后删自己
    void close() {
        socket_.disconnectFromHost();
        if (socket_.state() == QAbstractSocket::UnconnectedState) {
            deleteLater();
            return;
        }
        connect(&socket_, &QTcpSocket::disconnected, this, &QObject::deleteLater);
        QTimer::singleShot(2000, this, &QObject::deleteLater);
    }
    void reject(const QString& message) {
        if (settled_) return;
        settled_ = true;
        close();
        deferred_.reject(util::JsError(message));
    }
    void finish(const QString& list) {
        if (settled_) return;
        settled_ = true;
        QStringList accounts;
        for (const QString& s : list.split(u','))
            if (const QString t = util::jsTrim(s); !t.isEmpty()) accounts.append(t);
        close();
        deferred_.resolve(HandshakeInfo{serverVersion_, std::nullopt, accounts});
    }
    void send(const QStringList& fields) { socket_.write(tws::frame(fields)); }
    void onData(const QByteArray& chunk) {
        if (settled_) return;
        buffer_ += chunk;
        if (buffer_.size() > 0xffffff) {
            reject(u"502: Message of size %1 exceeded max message length %2"_s.arg(buffer_.size()).arg(0xffffff));
            return;
        }
        const tws::SplitResult cut = tws::splitFrames(buffer_);
        buffer_.remove(0, cut.consumed);
        for (const QStringList& fields : cut.frames) {
            if (settled_) return;
            if (!serverVersion_) {
                serverVersion_ = util::jsParseInt(fields.value(0), 10);
                const double v = *serverVersion_;
                if (v < tws::kMinVersion || v > tws::kMainMaxVersion) return reject(u"506: Unsupported Version "_s + util::jsNumberToString(v));
                if (v >= 3) send({u"71"_s, u"2"_s, util::jsNumberToString(clientId_), QString()});
                continue;
            }
            const tws::Message m = tws::decode(fields, std::isnan(*serverVersion_) ? 0 : static_cast<int>(*serverVersion_));
            if (const auto* err = std::get_if<tws::ErrorMessage>(&m.body)) {
                // 连接级错误才终止;信息型代码(2104 等)忽略
                if (err->code >= 500 && err->code < 600) return reject(util::jsNumberToString(err->code) + u": "_s + err->message);
            } else if (std::get_if<tws::NextValidId>(&m.body)) {
                send({u"17"_s, u"1"_s});
            } else if (const auto* acc = std::get_if<tws::ManagedAccounts>(&m.body)) {
                return finish(acc->accounts);
            }
        }
    }

    QString host_;
    quint16 port_;
    double clientId_;
    util::Deferred<HandshakeInfo> deferred_;
    QTcpSocket socket_;
    QByteArray buffer_;
    std::optional<double> serverVersion_;
    bool settled_ = false;
};

}  // namespace

Task<HandshakeInfo> defaultHandshake(HandshakeArgs args) {
    util::Deferred<HandshakeInfo> d;
    // IBApi 的 host / port 是 undefined 时 net.connect 当场抛(库的配置文件与 IB_PORT 环境变量这里不读)
    if (!args.port) {
        d.reject(NamedError(u"The \"options\" or \"port\" or \"path\" argument must be specified"_s, u"TypeError"_s, u"ERR_MISSING_ARGS"_s));
        return d.task();
    }
    if (const auto bad = nodeBadPortMessage(*args.port)) {
        d.reject(NamedError(*bad, u"RangeError"_s, u"ERR_SOCKET_BAD_PORT"_s));
        return d.task();
    }
    new HandshakeRun(args.host.value_or(u"127.0.0.1"_s), static_cast<quint16>(*args.port), args.clientId, args.timeoutMs, d);
    return d.task();
}

Task<OJson> diagnose(domain::Settings settings, QString connectionName, DiagnoseOptions options) {
    const auto conns = settings.connectionsFor(u"ibkr"_s);
    const contract::ConnectionConfig* found = conns.find(connectionName);
    // Object.prototype 上的名字(toString…):TS 取到的是个函数,host / port / readonly / client_id 都是 undefined
    if (!found && !objectProtoNames().contains(connectionName))
        throw util::JsError(u"未定义的连接:%1(这里只在 IBKR 连接里查找)"_s.arg(connectionName));
    const std::optional<contract::ConnectionConfig> cfg = found ? std::optional(*found) : std::nullopt;
    const std::optional<QString> host = cfg ? std::optional(cfg->host) : std::nullopt;
    const std::optional<double> port = cfg ? std::optional(cfg->port) : std::nullopt;
    PortProber prober = options.prober;
    if (!prober) prober = [](std::optional<QString> h, std::optional<double> p) { return probePort(std::move(h), p); };
    const ProbeResult probe = co_await prober(host, port);
    const double clientId = options.clientId ? *options.clientId : (cfg ? cfg->client_id : std::nan("")) + 90;
    OJson result = js::object();
    result.set(u"connection"_s, js::S(connectionName));
    if (host) result.set(u"host"_s, js::S(*host));
    if (port) result.set(u"port"_s, js::N(*port));
    result.set(u"port_open"_s, js::B(probe.open));
    result.set(u"port_latency_ms"_s, js::NOrNull(probe.latency_ms));
    result.set(u"connected"_s, js::B(false));
    result.set(u"server_version"_s, js::Null());
    result.set(u"server_time"_s, js::Null());
    result.set(u"managed_accounts"_s, js::array());
    result.set(u"accounts"_s, js::array());
    result.set(u"unmapped_accounts"_s, js::array());
    if (cfg) result.set(u"readonly"_s, js::B(cfg->readonly));
    // 用一个偏移过的 clientId,避免和正在下单的那条连接抢 ID(IBKR 会报 326)
    result.set(u"client_id"_s, js::N(clientId));
    result.set(u"error"_s, js::Null());
    result.set(u"hint"_s, js::Null());

    if (!probe.open) {
        ConnectErrorInfo err;
        err.message = probe.error.value_or(QString());
        err.code = u"ECONNREFUSED"_s;
        const ExplainedError detail = explainConnectError(err, port, false);
        result.set(u"error"_s, js::S(detail.reason));
        result.set(u"hint"_s, js::S(detail.hint));
        co_return result;
    }
    // TS 在 @stoqey/ib 装不上时(import 失败)回「IBKR SDK(@stoqey/ib)不可用」;这里的默认握手是自带的,没有那一支
    const IbHandshake handshake = options.handshake ? options.handshake : IbHandshake(defaultHandshake);
    HandshakeInfo info;
    std::optional<ExplainedError> failed;
    try {
        info = co_await handshake(HandshakeArgs{host, port, clientId, options.timeoutMs.value_or(8000)});
    } catch (const util::JsError& exc) {
        failed = explainConnectError(errorInfoOf(exc), port, true);
    }
    if (failed) {
        result.set(u"error"_s, js::S(failed->reason));
        result.set(u"hint"_s, js::S(failed->hint));
        result.set(u"error_code"_s, js::S(failed->code));
        co_return result;
    }

    result.set(u"connected"_s, js::B(true));
    result.set(u"server_version"_s, js::NOrNull(info.serverVersion));
    result.set(u"server_time"_s, info.serverTime ? js::S(*info.serverTime) : js::Null());
    QStringList maskedManaged;
    for (const QString& a : info.managedAccounts) maskedManaged.append(domain::redactAccount(a));
    result.set(u"managed_accounts"_s, js::strings(maskedManaged));
    const auto [rows, unmapped] = checkAliasMapping(settings, info.managedAccounts, connectionName);
    OJson rowsJson = js::array();
    for (const DiagnoseAccount& r : rows) rowsJson.items.append(r.toJson());
    result.set(u"accounts"_s, rowsJson);
    result.set(u"unmapped_accounts"_s, js::strings(unmapped));
    if (!unmapped.isEmpty()) {
        result.set(u"hint"_s, js::S(u"这个会话还能管到 %1 个没写进别名表的账号(%2)。没写进表的账号 LLM 永远指不到,这是设计使然;如果你想用它们,请在配置里补别名。"_s.arg(
                                    util::jsNumberToString(static_cast<double>(unmapped.size())), unmapped.join(u"、"_s))));
    }
    QStringList missing;
    for (const DiagnoseAccount& r : rows)
        if (!r.resolved && r.connection == connectionName) missing.append(r.alias);
    if (!missing.isEmpty()) {
        result.set(u"error"_s, js::S(u"别名 %1 配的账号不在这条连接可管的账号里,继续下单会落到错误账户。"_s.arg(missing.join(u"、"_s))));
        result.set(u"hint"_s, js::S(u"请核对 config/settings.json 里这些别名的 account_id。"_s));
    }
    co_return result;
}

std::vector<GuideStep> connectionGuide(const domain::Settings& settings) {
    const auto conns = settings.connectionsFor(u"ibkr"_s);
    QStringList portList;
    for (const QString& name : jsKeyOrder(conns.keys())) portList.append(util::jsNumberToString(conns.find(name)->port));
    QString ports = portList.join(u"、"_s);
    if (ports.isEmpty()) ports = u"7497"_s;
    return {
        {1, u"启动 TWS 或 IB Gateway 并登录"_s, u"在 IBKR 自己的窗口里输入账号密码。本软件不接触、也不保存你的 IBKR 凭证。停在登录界面时 API 不会响应。"_s},
        {2, u"打开 API 开关"_s,
         u"TWS:Configure(齿轮)→ API → Settings,勾选「Enable ActiveX and Socket Clients」。IB Gateway:Configure → Settings → API → Settings。"_s},
        {3, u"核对 Socket port"_s,
         u"同一页的「Socket port」要和本软件配置里的端口一致(当前配置:%1)。IBKR 默认:TWS 实盘 7496 / 模拟 7497,Gateway 实盘 4001 / 模拟 4002。"_s.arg(ports)},
        {4, u"只信任本机"_s,
         u"同一页「Trusted IPs」只留 127.0.0.1,不要勾「Allow connections from localhost only」以外的放行(§9.2:API 端口绝不暴露到局域网)。"_s},
        {5, u"第一次连接时点「Yes」"_s, u"TWS 会弹出「Accept incoming connection attempt?」,点 Yes。不点的话这里会一直显示握手超时。"_s},
        {6, u"回到这里点「检测连接」"_s, u"检测会真握手一次并读回账户列表,同时核对你的账户别名是否对得上真实账号。"_s},
    };
}

}  // namespace ibkr::execution::twsdetect
