# engine 簇的对拍测试(世界与夹具见 engine_world.h / fixtures/engine_world.mjs)
ibkr_test(tst_engine_world js_fixture.h engine_world.h)
target_link_libraries(tst_engine_world PRIVATE ibkr_orchestrate Qt6::Test)
ibkr_test(tst_engine_pure js_fixture.h engine_world.h)
target_link_libraries(tst_engine_pure PRIVATE ibkr_orchestrate Qt6::Test)
ibkr_test(tst_engine_guards js_fixture.h engine_world.h)
target_link_libraries(tst_engine_guards PRIVATE ibkr_orchestrate Qt6::Test)

# 推送提前醒与按跌速多让(C++ 先有,TS 版没有):期望值在测试里独立写出,不对着 TS 夹具
ibkr_test(tst_fly_fast_exit js_fixture.h)
target_link_libraries(tst_fly_fast_exit PRIVATE ibkr_orchestrate Qt6::Test)
ibkr_test(tst_earnings_tp js_fixture.h)
target_link_libraries(tst_earnings_tp PRIVATE ibkr_orchestrate Qt6::Test)

ibkr_test(tst_guard js_fixture.h)
target_link_libraries(tst_guard PRIVATE ibkr_orchestrate Qt6::Test)

# 下单时延模拟:真引擎 + 真会话,假 TWS 在 socket 层按时延表回话(sim_tws.h)
ibkr_test(tst_order_latency js_fixture.h sim_tws.h)
target_link_libraries(tst_order_latency PRIVATE ibkr_orchestrate Qt6::Test)
