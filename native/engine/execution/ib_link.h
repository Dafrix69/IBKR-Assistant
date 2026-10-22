// ibLink.ts 逐句搬:IB 会话层的通断口径与日志小工具(账号掩码、读持仓要用哪些会话、此刻读得到持仓的账户、
// TWS↔IBKR 那一段的通断记账 UpstreamWatch)。期望值:tests/fixtures/gen_ib_link.mjs
//
// 与 TS 的对应与不同:
//   · logStderr → stderr 一行;测试用 setLogSinkForTests 接走(同 gen 里对 process.stderr.write 的截取)。
//   · TS 的 Map<string, IbSession> 按插入先后遍历 → vector<pair>(名字,会话),次序同。
//   · liveSessions 的 makeError 返回一个 Error 由它抛 → 这里返回 exception_ptr,由 liveSessions 重抛。
//   · `session.onLink?.(…)` 可选方法:会话没有(无 Cap::OnLink)就不挂。
//   · UpstreamWatch 的回调要活得比 watch() 的调用久:状态放在 shared_ptr 里,回调拿一份。
#pragma once

#include "contract/config_types.h"
#include "contract/ordered_map.h"
#include "execution/ib_link_down.h"  // ibLink.ts 的 LinkDownError 住在那里(ibsession 簇搬的),这里转引,一个 include 拿到 ibLink.ts 的全部
#include "execution/ib_types.h"

#include <QString>
#include <QStringList>

#include <exception>
#include <functional>
#include <memory>
#include <optional>
#include <utility>
#include <vector>

namespace ibkr::execution {

/// 日志里的账号一律掩码:长于 5 位留头两位与尾三位,否则全遮
QString redactForLog(const QString& accountId);
/// 一行写到 stderr(失败绝不影响交易路径)
void logStderr(const QString& message);
/// 测试用:接走 logStderr 的行(空函数 = 还原)
void setLogSinkForTests(std::function<void(const QString&)> sink);

using NamedSessions = std::vector<std::pair<QString, std::shared_ptr<IbSession>>>;
using ErrorMaker = std::function<std::exception_ptr(const QString&)>;

/// 读持仓要用的会话:连着的那些。一个都没连着就抛 makeError 给的错,不回空
std::vector<std::shared_ptr<IbSession>> liveSessions(const NamedSessions& sessions, const ErrorMaker& makeError);
/// 此刻读得到持仓的账户(别名),按首次出现的先后去重(TS 的 Set)
QStringList coveredAccounts(const std::vector<contract::AccountConfig>& accounts, const NamedSessions& sessions);

class UpstreamWatch {
public:
    UpstreamWatch();

    /// 某条连接的上游断着时,它收到的码(1100 / 2110;先断的那条连接的);都通着回空
    std::optional<int> lost() const;
    /// 新会话接到这条连接上。onLink:socket 自己的通断照旧交给调用方
    void watch(const QString& connection, const std::shared_ptr<IbSession>& session, std::function<void(bool)> onLink);
    void clear();

private:
    struct State {
        contract::OrderedMap<int> down;  // 连接名 → 断开时 TWS 给的码
    };
    std::shared_ptr<State> state_;
};

}  // namespace ibkr::execution
