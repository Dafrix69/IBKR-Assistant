// TWS / IB Gateway 连接检测与诊断(engine-ts/src/tws.ts 逐句搬)。
//
// 边界不变:不接触任何 IBKR 凭证。只做检测、诊断、拉起三件事。
// 碰外面的几样(读目录、起进程、平台、家目录、环境变量)都过 TwsSystem 这一层:默认是真的,测试整个换成假的
// (TS 测试换的是 node:fs / node:child_process / node:os,这里换的是同一组动作)。TCP 探测与真握手本来就能注入(prober / handshake)。
// 期望值:tests/fixtures/gen_tws_detect.mjs(原模块在同一组假的上面现跑)
#pragma once

#include "contract/ordered_map.h"
#include "domain/config.h"
#include "util/error.h"
#include "util/ordered_json.h"
#include "util/task.h"

#include <QString>
#include <QStringList>

#include <functional>
#include <optional>
#include <utility>
#include <vector>

namespace ibkr::execution::twsdetect {

using util::OJson;
using util::Task;

struct Endpoint {
    double port = 0;
    QString label;
    QString kind;
    std::optional<bool> paper;  // 空 = null
};

/// IBKR 的四个标准端口
const std::vector<Endpoint>& knownEndpoints();
/// 本平台去哪儿找 TWS / Gateway(Windows 与 macOS/Linux 两套,同 TS 的 APP_CANDIDATES)
contract::OrderedMap<QStringList> appCandidates();
contract::OrderedMap<QString> processPatterns();

struct ProbeResult {
    bool open = false;
    std::optional<double> latency_ms;
    std::optional<QString> error;
};

/// TS 的 PortProber:host / port 可能是 undefined(空的 optional;默认实现这时用 127.0.0.1 / 7497)
using PortProber = std::function<Task<ProbeResult>(std::optional<QString> host, std::optional<double> port)>;

/// 纯 TCP 探测:只看端口通不通,不发任何 IBKR 协议帧。端口不合格时抛 JsError(同 Node 的 RangeError)
Task<ProbeResult> probePort(std::optional<QString> host = std::nullopt, std::optional<double> port = std::nullopt, double timeoutMs = 600);

struct PortStatus {
    double port = 0;
    QString label;
    QString kind;
    std::optional<bool> paper;
    bool open = false;
    std::optional<double> latency_ms;
    std::optional<QString> error;
    std::optional<QString> configured_as;
    OJson toJson() const;
};

/// TS 的 Record<number, string>:端口 → 连接名(后写的覆盖前写的)
using ConfiguredPorts = std::vector<std::pair<double, QString>>;

Task<std::vector<PortStatus>> scanPorts(const domain::Settings& settings, QString host = QStringLiteral("127.0.0.1"), PortProber prober = {});
Task<std::vector<PortStatus>> scanEndpoints(std::vector<Endpoint> known, ConfiguredPorts configured, QString host, PortProber prober);

// ---------------------------------------------------------------- 外面的世界

struct SpawnResult {
    /// 退出码;超时被杀、没起来是空(Node 的 status: null)
    std::optional<int> status;
    QString stdoutText;
    QString stderrText;
};

struct TwsSystem {
    /// os.platform():darwin / win32 / linux …
    QString platform;
    std::function<QString()> homedir;
    /// process.env[name];没有是空的 optional
    std::function<std::optional<QString>(const QString& name)> env;
    /// fs.globSync:模式不合法抛 JsError
    std::function<QStringList(const QString& pattern)> globSync;
    std::function<bool(const QString& path)> existsSync;
    /// spawnSync(cmd, args, {encoding: "utf-8", timeout});timeoutMs 空 = 不限
    std::function<SpawnResult(const QString& cmd, const QStringList& args, std::optional<int> timeoutMs)> spawnSync;
    /// spawn(target, [], {cwd, detached: true, stdio: "ignore"}).unref()
    std::function<void(const QString& target, const QString& cwd)> spawnDetached;
};
/// 真的那一套
TwsSystem realSystem();
/// 此刻在用的那一套(测试换掉,用完换回来)
TwsSystem& system();

/// 真的 fs.globSync 的那一部分(* ? [..] {a,b} **,点开头的名字只有模式也以点开头才中;macOS / Windows 不分大小写)
QStringList globFiles(const QString& pattern);
/// path.posix.join / normalize / basename / dirname
QString posixNormalize(const QString& p);
QString posixJoin(const QString& a, const QString& b);
QString posixBasename(const QString& p);
QString posixDirname(const QString& p);

QStringList expandGlob(const QString& pattern);
/// pattern 空 = TS 的 undefined(配置里没给这个键的进程名)
bool processRunning(const std::optional<QString>& pattern);

struct AppStatus {
    QString key;
    QString name;
    bool installed = false;
    QStringList paths;
    bool running = false;
    OJson toJson() const;
};

/// candidates / patterns 空 = 用默认的 appCandidates() / processPatterns()
std::vector<AppStatus> detectApps(const std::optional<contract::OrderedMap<QStringList>>& candidates = std::nullopt,
                                  const std::optional<contract::OrderedMap<QString>>& patterns = std::nullopt);

struct LaunchResult {
    bool launched = false;
    QString path;
    OJson toJson() const;
};
/// 拉起 TWS / Gateway。只接受固定键,路径在这一侧解析
LaunchResult launchApp(const QString& key);

// ---------------------------------------------------------------- 握手诊断

/// IBKR 错误码 → 提示(Object.entries 的次序:数字键从小到大)
const std::vector<std::pair<QString, QString>>& ibkrErrorHints();

/// 一个 JS Error 里 explainConnectError 看得到的那几样
struct ConnectErrorInfo {
    QString name = QStringLiteral("Error");
    QString ctorName = QStringLiteral("Error");
    QString message;
    /// NodeJS.ErrnoException.code;没有是空串
    QString code;
};
/// 带 name 的错(TimeoutError、TypeError…);握手的替身也可以抛它
class NamedError : public util::CodedError {
public:
    NamedError(const QString& message, QString name, const QString& code = {}) : util::CodedError(message, code), name_(std::move(name)) {}
    const QString& name() const { return name_; }

private:
    QString name_;
};
ConnectErrorInfo errorInfoOf(const util::JsError& e);

struct ExplainedError {
    QString reason, hint, code;
    OJson toJson() const;
};
/// port 空 = undefined(话里写 "undefined")
ExplainedError explainConnectError(const ConnectErrorInfo& exc, std::optional<double> port, bool portOpen);

struct DiagnoseAccount {
    QString alias;
    QString account_masked;
    bool is_paper = false;
    QString connection;
    bool resolved = false;
    bool isDefault = false;
    OJson toJson() const;
};
/// 别名表与这个会话能管到的账号对不对得上。connectionName 空 = 不给(全核)
std::pair<std::vector<DiagnoseAccount>, QStringList> checkAliasMapping(const domain::Settings& settings, const QStringList& managedAccounts,
                                                                       const std::optional<QString>& connectionName = std::nullopt);

struct HandshakeArgs {
    std::optional<QString> host;
    std::optional<double> port;
    double clientId = 0;
    double timeoutMs = 0;
};
struct HandshakeInfo {
    std::optional<double> serverVersion;
    std::optional<QString> serverTime;
    QStringList managedAccounts;
};
using IbHandshake = std::function<Task<HandshakeInfo>(HandshakeArgs)>;

struct DiagnoseOptions {
    std::optional<double> clientId;
    std::optional<double> timeoutMs;
    PortProber prober;
    /// 没给 = 默认实现。TS 里显式传 null 也是默认实现(`options.handshake ?? 默认`),所以这里没有"null"这一种
    IbHandshake handshake;
};
/// 默认握手:只读连一次(v100..193,同 @stoqey/ib),读版本与账户,立刻断开
Task<HandshakeInfo> defaultHandshake(HandshakeArgs args);

/// settings 按值:协程跨 await 还要用它
Task<OJson> diagnose(domain::Settings settings, QString connectionName, DiagnoseOptions options = {});

struct GuideStep {
    double step = 0;
    QString title;
    QString detail;
    OJson toJson() const;
};
std::vector<GuideStep> connectionGuide(const domain::Settings& settings);

}  // namespace ibkr::execution::twsdetect
