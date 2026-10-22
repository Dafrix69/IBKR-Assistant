# handlers2 簇:engine-ts/src/rpc/handlers/ 的 ideas / review / sectors / quality / events / intel / alerts / backtest / follow / market / screener。
# 对引擎、router、解析器、各 service 的窄接口在 handlers2_ports.h;引擎装配的人用 makeHandlers2(handlers2.h)造出它们。
# 依赖往下:transport → orchestrate(services)→ analysis / domain / parsing。
target_sources(ibkr_transport PRIVATE
    transport/handlers/handlers2_ports.h
    transport/handlers/handlers2_support.h transport/handlers/handlers2_support.cpp
    transport/handlers/handlers2.h transport/handlers/handlers2.cpp
    transport/handlers/handlers2_adapters.h transport/handlers/handlers2_adapters.cpp
    transport/handlers/ideas.h transport/handlers/ideas.cpp
    transport/handlers/review.h transport/handlers/review.cpp
    transport/handlers/sectors.h transport/handlers/sectors.cpp
    transport/handlers/quality.h transport/handlers/quality.cpp
    transport/handlers/events.h transport/handlers/events.cpp
    transport/handlers/intel.h transport/handlers/intel.cpp
    transport/handlers/alerts.h transport/handlers/alerts.cpp
    transport/handlers/backtest.h transport/handlers/backtest.cpp
    transport/handlers/follow.h transport/handlers/follow.cpp
    transport/handlers/market.h transport/handlers/market.cpp
    transport/handlers/screener.h transport/handlers/screener.cpp
)
target_link_libraries(ibkr_transport PUBLIC ibkr_orchestrate)
