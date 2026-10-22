if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/tst_svc_playbook.cpp)
    ibkr_test(tst_svc_playbook js_fixture.h svc1_world.h svc1_playbook_world.h)
    target_link_libraries(tst_svc_playbook PRIVATE ibkr_orchestrate Qt6::Test)
endif()
