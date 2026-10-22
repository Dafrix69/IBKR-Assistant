# backtest 组的测试
foreach(name tst_backtest tst_backtest_lab tst_research tst_screener tst_priceaction)
    ibkr_test(${name})
    target_link_libraries(${name} PRIVATE ibkr_analysis Qt6::Test)
endforeach()
