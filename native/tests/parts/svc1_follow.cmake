if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/tst_svc_follow.cpp)
    ibkr_test(tst_svc_follow js_fixture.h svc1_world.h)
    target_link_libraries(tst_svc_follow PRIVATE ibkr_orchestrate Qt6::Test)
endif()
