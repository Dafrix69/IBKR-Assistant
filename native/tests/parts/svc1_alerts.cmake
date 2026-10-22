if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/tst_svc_alerts.cpp)
    ibkr_test(tst_svc_alerts js_fixture.h svc1_world.h)
    target_link_libraries(tst_svc_alerts PRIVATE ibkr_orchestrate Qt6::Test)
endif()
