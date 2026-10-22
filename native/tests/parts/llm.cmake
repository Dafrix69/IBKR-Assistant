# llm 簇的对拍测试(providers.ts / llm.ts / embeddings.ts 与两个官方 SDK 的 HTTP 那一层;假端点只在回环上)
ibkr_test(tst_llm js_fixture.h)
target_link_libraries(tst_llm PRIVATE ibkr_parsing Qt6::Test Qt6::Network)
target_compile_definitions(tst_llm PRIVATE IBKR_REPO_DIR="${IBKR_REPO_DIR}")
