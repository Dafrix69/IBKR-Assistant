# intel 组的对拍测试
foreach(t tst_symbol_mentions tst_intel_dateparse tst_econ_calendar tst_cross_market tst_intel_items tst_idea_retrieval tst_open_risk tst_assignment_risk tst_optionwall)
    ibkr_test(${t})
    target_link_libraries(${t} PRIVATE ibkr_analysis Qt6::Test)
endforeach()
