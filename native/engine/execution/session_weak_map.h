// TS 的 WeakMap<IbSession, number>:按会话记一个数,会话没了表项跟着没(qualifyGate / heldStreams 各记各的 stalledUntil)。
// 键是 weak_ptr:表项占着控制块,所以地址不会被新会话复用;每次写入顺手清掉已过期的项。
#pragma once

#include <memory>
#include <map>
#include <optional>

namespace ibkr::execution {

template <class S>
class SessionWeakMap {
public:
    std::optional<double> get(const std::shared_ptr<S>& session) const {
        const auto it = map_.find(session);
        if (it == map_.end()) return std::nullopt;
        return it->second;
    }
    bool has(const std::shared_ptr<S>& session) const { return map_.find(session) != map_.end(); }
    void set(const std::shared_ptr<S>& session, double value) {
        prune();
        map_[session] = value;
    }
    /// WeakMap.delete:有这一项并删掉了回 true
    bool erase(const std::shared_ptr<S>& session) {
        const auto it = map_.find(session);
        if (it == map_.end()) return false;
        map_.erase(it);
        return true;
    }

private:
    void prune() {
        for (auto it = map_.begin(); it != map_.end();) {
            if (it->first.expired()) it = map_.erase(it);
            else ++it;
        }
    }
    std::map<std::weak_ptr<S>, double, std::owner_less<std::weak_ptr<S>>> map_;
};

}  // namespace ibkr::execution
