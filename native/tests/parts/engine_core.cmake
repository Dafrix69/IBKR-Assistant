# engine_core 簇的对拍测试(世界与夹具见 engine_core_world.h / fixtures/engine_core_world.mjs)
ibkr_test(tst_engine_core js_fixture.h engine_core_world.h)
target_link_libraries(tst_engine_core PRIVATE ibkr_orchestrate Qt6::Test)
