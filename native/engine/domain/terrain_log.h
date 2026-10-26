#pragma once
#include "domain/day_logs.h"

namespace ibkr::domain {
// 独立于交易底账的地形观察记录。只存白名单行情,不存账户、订单或原始错误消息。
class TerrainLog : public JsonlDayFiles {
public:
    using JsonlDayFiles::JsonlDayFiles;
    void record(double requestedAt, double receivedAt, const util::OJson* wall);
    QList<util::OJson> read(const QString& date, int* rejected = nullptr) const;
    // 只看 received_at <= asOf 的记录;刷新失败不会退回更早的成功帧。
    util::OJson replay(const QString& date, double asOf, double maxAgeMs) const;
};
}  // namespace ibkr::domain
