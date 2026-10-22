# engine 簇:engine-ts/src/engine/*.ts(托管单、执行对账、回报落库、盯盘守卫、出场状态、账户风控、时段、本地速记、平仓识别、取价、心跳、时钟)
# orchestrate 在 execution 之上(account_feeds、ib_link_down、broker 的 BrokerError 都在 execution 层)
target_link_libraries(ibkr_orchestrate PUBLIC ibkr_execution)
target_sources(ibkr_orchestrate PRIVATE
    orchestrate/engine_ports.h orchestrate/engine_ports.cpp orchestrate/engine_time.h
    orchestrate/clock.h orchestrate/clock.cpp
    orchestrate/closing.h orchestrate/closing.cpp
    orchestrate/heartbeat.h orchestrate/heartbeat.cpp
    orchestrate/spot_stop.h orchestrate/spot_stop.cpp
    orchestrate/session_hours.h orchestrate/session_hours.cpp
    orchestrate/wake_guard.h orchestrate/wake_guard.cpp
    orchestrate/exits.h orchestrate/exits.cpp
    orchestrate/callbacks.h orchestrate/callbacks.cpp
    orchestrate/hosted.h orchestrate/hosted.cpp
    orchestrate/reconcile.h orchestrate/reconcile.cpp
    orchestrate/account_guard.h orchestrate/account_guard.cpp
    orchestrate/local_shorthand.h orchestrate/local_shorthand.cpp
)
