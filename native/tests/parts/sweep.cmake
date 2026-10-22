# sweep 组的测试:扫描四件套对着原 TS 模块;网关对着 TS 的假 socket 脚本(再加回环上的一条真 WebSocket)
foreach(name tst_fly_exit_sweep_spec tst_fly_exit_sweep tst_fly_exit_sweep_stats tst_fly_exit_sweep_report)
    ibkr_test(${name})
    target_link_libraries(${name} PRIVATE ibkr_orchestrate Qt6::Test)
endforeach()

ibkr_test(tst_discord_gateway)
target_link_libraries(tst_discord_gateway PRIVATE ibkr_util Qt6::Test)
find_package(Qt6 QUIET COMPONENTS WebSockets)  # 导入目标只在调用它的目录里看得见
if(TARGET ibkr_discord_ws AND TARGET Qt6::WebSockets)
    target_link_libraries(tst_discord_gateway PRIVATE ibkr_discord_ws Qt6::WebSockets Qt6::Network)
    target_compile_definitions(tst_discord_gateway PRIVATE IBKR_HAVE_DISCORD_WS=1)
endif()
