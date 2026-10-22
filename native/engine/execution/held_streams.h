// heldStreams.ts 逐句搬:持仓的常驻行情订阅的账——每条持仓期权腿、每只持仓正股各一条,订一次留着读。
// 管四件事:这条还能不能用(被拒、被撤、连着却太久没盘口)、订上并记下来、确认不了的合约不反复试、平掉的撤掉。
// 钱路径载荷:哪些行情流被当作活的、哪些被撤了重订,决定盯盘信任哪份数据。阈值(silenceLimitMs 的 30 秒 / 120 秒、
// kQualifyRetryMs 的 30 秒)照 TS 一个字不改。期望值:tests/fixtures/gen_held_streams.mjs
//
// 与 TS 的对应与不同:
//   · TS 的 `class HeldStreams extends Map<string, HeldStream>`:按插入先后遍历、重设已有的键位置不动、删了再设排到最后 →
//     contract::OrderedMap;Map 的 get / has / set / delete / size / keys 用 find / has / set / erase / size / keys。
//   · 模块级的 stalledUntil(WeakMap<IbSession, number>)是全局的,与 qualifyGate 那份各记各的(两张表,TS 里就是两张)。
//   · Date.now() → util::dateNow();日志走 ib_link 的 logStderr。
//   · TS 里 `error` 的真假按 JS 来:空串也是"没有错"。
//   · `qualifies` 的回值 boolean | "stalled" → QualifyKnown;target / qualifies 拿到的合约是同一个对象,qualifies 会写 conId,
//     随后订阅用的就是写过的那个(所以 qualifies 收引用)。
#pragma once

#include "contract/ordered_map.h"
#include "execution/ib_types.h"
#include "util/task.h"

#include <QString>

#include <functional>
#include <memory>
#include <optional>
#include <vector>

namespace ibkr::execution {

/// handle 为空 = 合约确认不了,记下来不反复重试。session 是订它的那个会话:撤要撤在同一个会话上(空 = TS 的 undefined)
struct HeldStream {
    std::shared_ptr<TickerHandle> handle;
    std::optional<IbContract> contract;
    std::shared_ptr<IbSession> session;
};

/// 连着却多久一笔盘口都没有,就当这条流死了(毫秒,0 = 不判):盘中 30 秒,盘外 / 盘前 / 盘后两分钟,休市与别的不判
double silenceLimitMs(const QString& status);
/// 这条流多久没来盘口(毫秒):从最近一笔盘口、或最近一次请求起算,取晚的那个;会话不报这两个时刻回空(不知道就不判它死)
std::optional<double> quoteSilenceMs(const TickerData& t, double now);

/// 合约确认的答案:认得(Yes)/ 认不出(No,记下来不反复重试)/ TWS 没回话(Stalled,不记账)
enum class QualifyKnown { No, Yes, Stalled };

class HeldStreams {
public:
    /// variant:出错重订之前撤哪一条。"" = 只撤不带 generic 的(正股),不给 = 撤这张合约的所有变体(期权腿)
    explicit HeldStreams(std::optional<QString> variant = std::nullopt) : variant_(std::move(variant)) {}

    // ---- Map 的那一半
    const HeldStream* find(const QString& key) const { return map_.find(key); }
    HeldStream* find(const QString& key) { return map_.find(key); }
    bool has(const QString& key) const { return map_.contains(key); }
    void set(const QString& key, HeldStream value) { map_.insert(key, value); }
    void erase(const QString& key) { map_.remove(key); }
    qsizetype size() const { return map_.size(); }
    const QStringList& keys() const { return map_.keys(); }

    /// 这个键上有没有一条还能用的;回 false 就是要调用方重订。确认不了的合约(handle 为空)算有,不重试。
    /// now 空 = util::dateNow()
    bool usable(const std::shared_ptr<IbSession>& session, const QString& key, double silentLimitMs = 0, std::optional<double> now = std::nullopt);
    void subscribe(const std::shared_ptr<IbSession>& session, const QString& key, const IbContract& contract);
    /// 这个键上备好一条能用的流,回"是不是新订的":新订的要等首笔 tick。target 只在需要重订时才拼
    util::Task<bool> ensure(std::shared_ptr<IbSession> session, QString key, std::function<IbContract()> target,
                            std::function<util::Task<QualifyKnown>(IbContract&)> qualifies, double silentLimitMs = 0);
    /// Map.clear 加上清掉"太久没盘口"的计数
    void clear();
    /// 撤掉不在 keep 里的(持仓里已经没有的),返回真的撤了几条线路。sharedWith:这个键对应的合约,别处的常驻订阅手里的句柄
    int release(const QStringList& keep, const std::function<std::vector<std::shared_ptr<TickerHandle>>(const QString&)>& sharedWith = {});

private:
    void noteSilent(const QString& key, double silence);
    void recovered(const QString& key, const TickerData& t);

    std::optional<QString> variant_;
    contract::OrderedMap<HeldStream> map_;
    /// 正处在"太久没盘口 → 撤掉重订"里的键 → 这一段重订了几次
    contract::OrderedMap<int> silent_;
};

}  // namespace ibkr::execution
