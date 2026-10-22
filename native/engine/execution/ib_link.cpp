#include "execution/ib_link.h"

#include "util/error.h"

#include <QSet>

#include <cstdio>

namespace ibkr::execution {

using namespace Qt::StringLiterals;

namespace {

std::function<void(const QString&)>& sink() {
    static std::function<void(const QString&)> s;
    return s;
}

/// TWS 与 IBKR 服务器之间断了:1100,以及 TWS 断着时的另一种说法 2110
bool upstreamLost(int code) { return code == 1100 || code == 2110; }
/// 恢复了:1101(订阅丢了)/ 1102(订阅还在)
bool upstreamBack(int code) { return code == 1101 || code == 1102; }

}  // namespace

QString redactForLog(const QString& accountId) {
    return accountId.size() > 5 ? accountId.left(2) + u"***"_s + accountId.right(3) : u"***"_s;
}

void logStderr(const QString& message) {
    try {
        if (sink()) {
            sink()(message);
            return;
        }
        const QByteArray bytes = (message + u'\n').toUtf8();
        std::fwrite(bytes.constData(), 1, static_cast<size_t>(bytes.size()), stderr);
    } catch (...) {
        // 日志失败绝不影响交易路径
    }
}

void setLogSinkForTests(std::function<void(const QString&)> s) { sink() = std::move(s); }

std::vector<std::shared_ptr<IbSession>> liveSessions(const NamedSessions& sessions, const ErrorMaker& makeError) {
    std::vector<std::shared_ptr<IbSession>> live;
    for (const auto& [name, s] : sessions) {
        if (s->isConnected()) live.push_back(s);
    }
    if (!live.empty()) return live;
    QStringList names;
    for (const auto& [name, s] : sessions) names.append(name);
    const QString joined = names.join(u"、"_s);
    std::rethrow_exception(makeError(!joined.isEmpty() ? u"与 TWS 的连接(%1)已断开,正在自动重连;这一轮读不到持仓"_s.arg(joined)
                                                       : u"还没有连上任何 TWS 会话,读不到持仓"_s));
}

QStringList coveredAccounts(const std::vector<contract::AccountConfig>& accounts, const NamedSessions& sessions) {
    QStringList out;
    QSet<QString> seen;
    for (const auto& [name, session] : sessions) {
        if (!session->isConnected()) continue;
        const QStringList list = session->managedAccounts();
        const QSet<QString> managed(list.begin(), list.end());
        for (const contract::AccountConfig& acct : accounts) {
            if (managed.contains(acct.account_id) || (managed.isEmpty() && acct.connection == name)) {
                if (!seen.contains(acct.alias)) {
                    seen.insert(acct.alias);
                    out.append(acct.alias);
                }
            }
        }
    }
    return out;
}

UpstreamWatch::UpstreamWatch() : state_(std::make_shared<State>()) {}

std::optional<int> UpstreamWatch::lost() const {
    const auto& keys = state_->down.keys();
    if (keys.isEmpty()) return std::nullopt;
    return *state_->down.find(keys.first());
}

void UpstreamWatch::watch(const QString& connection, const std::shared_ptr<IbSession>& session, std::function<void(bool)> onLink) {
    state_->down.remove(connection);
    session->onConnectivity([state = state_, connection](int code) {
        if (upstreamLost(code)) state->down.insert(connection, code);
        else if (upstreamBack(code)) state->down.remove(connection);
    });
    if (session->has(Cap::OnLink)) {
        session->onLink([state = state_, connection, onLink = std::move(onLink)](bool up) {
            if (up) state->down.remove(connection);
            onLink(up);
        });
    }
}

void UpstreamWatch::clear() {
    state_->down = {};
}

}  // namespace ibkr::execution
