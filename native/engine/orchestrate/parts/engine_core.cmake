# engine_core 簇:engine-ts/src/engine.ts(TradingEngine:指令主线、条件单、盯盘节拍器、持仓追踪、熔断 / 保护、回报接线)
target_sources(ibkr_orchestrate PRIVATE
    orchestrate/engine_router.h
    orchestrate/engine_impl.h
    orchestrate/engine.h orchestrate/engine.cpp
    orchestrate/engine_tracker.cpp
    orchestrate/engine_hosts.cpp
    orchestrate/fast_exit.h orchestrate/fast_exit.cpp
)
