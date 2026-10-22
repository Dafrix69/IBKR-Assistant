# contract 簇的对拍测试:入参 schema(对着真的 TS zod schema)、rpc/params.ts、rpc/perfLog.ts
ibkr_test(tst_contract js_fixture.h)
target_link_libraries(tst_contract PRIVATE ibkr_transport Qt6::Test)
ibkr_test(tst_rpc_params js_fixture.h)
target_link_libraries(tst_rpc_params PRIVATE ibkr_transport Qt6::Test)
ibkr_test(tst_perf_log js_fixture.h)
target_link_libraries(tst_perf_log PRIVATE ibkr_transport Qt6::Test)
