// engine-ts/src/rpc/handlers/sectors.ts 逐句搬:sectors.* 与 pool.set_watch——自定义板块(= 股票池)、AI 选股、成分股身上的两个开关。
#pragma once

#include "transport/context.h"
#include "transport/handlers/handlers2_ports.h"

namespace ibkr::rpc {

class SectorsHandlers : public HandlerBase {
public:
    SectorsHandlers(RpcContext& ctx, Handlers2Ports& ports) : HandlerBase(ctx), ports_(ports) {}
    MethodTable methods() override;

    static const QString kPickSystem;

private:
    util::OJson reread(const QString& sectorId);
    util::OJson sectorsList();
    util::OJson sectorsAdd(const util::OJson& params);
    util::OJson sectorsDelete(const util::OJson& params);
    util::Task<util::OJson> sectorsPick(util::OJson params);
    util::OJson sectorsAddStock(const util::OJson& params);
    util::OJson sectorsRemoveStock(const util::OJson& params);
    util::Task<util::OJson> sectorsQuotes();
    util::Task<util::OJson> sectorsEarnings(util::OJson params);
    util::OJson sectorsSetTag(const util::OJson& params);
    util::OJson poolSetWatch(const util::OJson& params);

    Handlers2Ports& ports_;
};

}  // namespace ibkr::rpc
