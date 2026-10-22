# engine_core 簇在 transport 层的部分:handlers1 端口 ← 真实现的适配(TradingEngine / BrokerRouter / AlertsService / BrokerLinkService),
# 以及 server.ts 的生命周期与装配(EngineServer)
target_sources(ibkr_transport PRIVATE
    transport/handlers/handlers1_adapters.h transport/handlers/handlers1_adapters.cpp
    transport/engine_server.h transport/engine_server.cpp
)
