# sweep 组:蝶式出场参数的离线扫描(flyExitSweep / Spec / Stats / Report)与 Discord Gateway 的最小客户端
target_sources(ibkr_analysis PRIVATE
    analysis/fly_exit_sweep_spec.h analysis/fly_exit_sweep_spec.cpp
    analysis/fly_exit_sweep.h analysis/fly_exit_sweep.cpp
    analysis/fly_exit_sweep_stats.h analysis/fly_exit_sweep_stats.cpp
    analysis/fly_exit_sweep_report.h analysis/fly_exit_sweep_report.cpp
)
# 网关的核心只用 Qt Core(socket 与计时器都是递进来的),放在 util 层
target_sources(ibkr_util PRIVATE util/discord_gateway.h util/discord_gateway.cpp)
# 真 socket 那一面(QWebSocket)单独一个库:只有要连 Discord 的程序才链 Qt6::WebSockets
find_package(Qt6 QUIET COMPONENTS WebSockets)
if(TARGET Qt6::WebSockets)
    qt_add_library(ibkr_discord_ws STATIC util/discord_gateway_ws.h util/discord_gateway_ws.cpp)
    target_include_directories(ibkr_discord_ws PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
    target_link_libraries(ibkr_discord_ws PUBLIC ibkr_util Qt6::WebSockets)
endif()
