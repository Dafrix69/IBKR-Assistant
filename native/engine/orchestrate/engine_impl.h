// TradingEngine 的内部:子模块要的"宿主"面各自一个小适配类(同名方法在各面上返回类型不同,一个类接不全;engine_world.h 的老办法),
// 以及给 service 层的两个窄面。只有 engine*.cpp 包含它。
#pragma once

#include "orchestrate/engine.h"

namespace ibkr::orchestrate {

struct TradingEngine::Impl {
    explicit Impl(TradingEngine& e);
    ~Impl();
    std::unique_ptr<HostedHost> hostedHost;
    std::unique_ptr<ExitsHost> exitsHost;
    std::unique_ptr<AccountGuardHost> guardHost;
    std::unique_ptr<ReconcileHost> reconHost;
    std::unique_ptr<CallbackHost> cbHost;
    std::unique_ptr<ShorthandHost> shorthandHost;
    std::unique_ptr<HoursHost> hoursHost;
    std::unique_ptr<Svc1Engine> svc1;
    std::unique_ptr<NotifierPort> notifierPort;
    std::unique_ptr<SvcEngine> svc;
};

}  // namespace ibkr::orchestrate
