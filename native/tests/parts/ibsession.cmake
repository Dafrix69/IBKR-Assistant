# ibsession 组的对拍测试(ibSession.ts 跑在 @stoqey/ib 上,假 TWS 在 socket 层)
ibkr_test(tst_ib_session js_fixture.h)
target_link_libraries(tst_ib_session PRIVATE ibkr_execution Qt6::Test Qt6::Network)
