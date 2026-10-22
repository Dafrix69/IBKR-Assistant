foreach(t tst_tradereview tst_ibtrades tst_stockreview tst_csv_imports tst_trade_outcomes tst_trade_similar)
    ibkr_test(${t})
    target_link_libraries(${t} PRIVATE ibkr_analysis Qt6::Test)
endforeach()
