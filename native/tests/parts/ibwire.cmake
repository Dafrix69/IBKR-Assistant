# ibwire 组的对拍测试(@stoqey/ib 的 Encoder / Decoder)
ibkr_test(tst_ib_wire js_fixture.h)
target_link_libraries(tst_ib_wire PRIVATE ibkr_execution Qt6::Test)
