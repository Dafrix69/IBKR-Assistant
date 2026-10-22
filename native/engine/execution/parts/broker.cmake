# broker 簇:broker.ts 的 BrokerRouter 与纯函数(broker_pricing 仍在 execsupport 片段里)
target_sources(ibkr_execution PRIVATE
    execution/broker.h execution/broker_internal.h
    execution/broker.cpp execution/broker_session.cpp execution/broker_quotes.cpp
    execution/broker_positions.cpp execution/broker_orders.cpp)
