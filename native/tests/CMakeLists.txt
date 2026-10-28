# QtTest。全部离线:不连真券商,假 TWS 在字节层(fake_tws.h),回环上的那一条只连测试自己开的端口。

function(ibkr_test name)
    qt_add_executable(${name} ${name}.cpp ${ARGN})
    target_include_directories(${name} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
    target_compile_definitions(${name} PRIVATE
        IBKR_FIXTURES_DIR="${CMAKE_CURRENT_SOURCE_DIR}/fixtures"
        IBKR_CONTRACT_DIR="${IBKR_REPO_DIR}/native/spec/contract")
    set_target_properties(${name} PROPERTIES MACOSX_BUNDLE FALSE WIN32_EXECUTABLE FALSE)
    add_test(NAME ${name} COMMAND ${name})
endfunction()

ibkr_test(tst_jsnum)
target_link_libraries(tst_jsnum PRIVATE ibkr_util Qt6::Test)

ibkr_test(tst_jsformat)
target_link_libraries(tst_jsformat PRIVATE ibkr_util Qt6::Test)

ibkr_test(tst_py)
target_link_libraries(tst_py PRIVATE ibkr_util Qt6::Test)

ibkr_test(tst_pyjson)
target_link_libraries(tst_pyjson PRIVATE ibkr_util Qt6::Test)

ibkr_test(tst_tz)
target_link_libraries(tst_tz PRIVATE ibkr_util Qt6::Test)

ibkr_test(tst_market_calendar)
target_link_libraries(tst_market_calendar PRIVATE ibkr_util Qt6::Test)

ibkr_test(tst_risk_budget)
target_link_libraries(tst_risk_budget PRIVATE ibkr_util Qt6::Test)

ibkr_test(tst_protections)
target_link_libraries(tst_protections PRIVATE ibkr_util Qt6::Test)

ibkr_test(tst_killswitch)
target_link_libraries(tst_killswitch PRIVATE ibkr_util Qt6::Test)

ibkr_test(tst_v8json)
target_link_libraries(tst_v8json PRIVATE ibkr_util Qt6::Test)

ibkr_test(tst_store)
target_link_libraries(tst_store PRIVATE ibkr_domain Qt6::Test)

ibkr_test(tst_models)
target_link_libraries(tst_models PRIVATE ibkr_domain Qt6::Test)

ibkr_test(tst_positions)
target_link_libraries(tst_positions PRIVATE ibkr_domain Qt6::Test)

ibkr_test(tst_day_logs)
target_link_libraries(tst_day_logs PRIVATE ibkr_domain Qt6::Test)

ibkr_test(tst_follow_inbox)
target_link_libraries(tst_follow_inbox PRIVATE ibkr_domain Qt6::Test)

ibkr_test(tst_follow_reader)
target_link_libraries(tst_follow_reader PRIVATE ibkr_domain Qt6::Test)

ibkr_test(tst_tracker_rules)
target_link_libraries(tst_tracker_rules PRIVATE ibkr_analysis Qt6::Test)
ibkr_test(tst_fly_model)
target_link_libraries(tst_fly_model PRIVATE ibkr_analysis Qt6::Test)
ibkr_test(tst_flyexit)
target_link_libraries(tst_flyexit PRIVATE ibkr_analysis Qt6::Test)
ibkr_test(tst_playbook)
target_link_libraries(tst_playbook PRIVATE ibkr_analysis Qt6::Test)
ibkr_test(tst_fly_plan_engine)
target_link_libraries(tst_fly_plan_engine PRIVATE ibkr_analysis Qt6::Test)
ibkr_test(tst_inference)
target_link_libraries(tst_inference PRIVATE ibkr_analysis Qt6::Test)
ibkr_test(tst_exec_quality)
target_link_libraries(tst_exec_quality PRIVATE ibkr_analysis Qt6::Test)
ibkr_test(tst_shorthand)
target_link_libraries(tst_shorthand PRIVATE ibkr_parsing Qt6::Test)
ibkr_test(tst_follow)
target_link_libraries(tst_follow PRIVATE ibkr_parsing Qt6::Test)
ibkr_test(tst_follow_credit)
target_link_libraries(tst_follow_credit PRIVATE ibkr_orchestrate Qt6::Test)
ibkr_test(tst_tracker)
target_link_libraries(tst_tracker PRIVATE ibkr_orchestrate Qt6::Test)
ibkr_test(tst_prompts)
target_link_libraries(tst_prompts PRIVATE ibkr_parsing Qt6::Test)
target_compile_definitions(tst_prompts PRIVATE IBKR_PROMPTS_DIR="${IBKR_REPO_DIR}/prompts")

ibkr_test(tst_jsmath)
target_link_libraries(tst_jsmath PRIVATE ibkr_util Qt6::Test)

ibkr_test(tst_ib_runtime)
target_link_libraries(tst_ib_runtime PRIVATE ibkr_execution Qt6::Test Qt6::Network)

ibkr_test(tst_config)
target_link_libraries(tst_config PRIVATE ibkr_domain Qt6::Test)

ibkr_test(tst_task)
target_link_libraries(tst_task PRIVATE ibkr_util Qt6::Test)

ibkr_test(tst_secrets)
target_link_libraries(tst_secrets PRIVATE ibkr_util Qt6::Test)
target_compile_definitions(tst_secrets PRIVATE IBKR_ENGINE_PATH="$<TARGET_FILE:ibkr-engine>")
add_dependencies(tst_secrets ibkr-engine)

ibkr_test(tst_redact)
target_link_libraries(tst_redact PRIVATE ibkr_util Qt6::Test)

ibkr_test(tst_codec json_compare.h)
target_link_libraries(tst_codec PRIVATE ibkr_execution Qt6::Test)

ibkr_test(tst_client fake_tws.h)
target_link_libraries(tst_client PRIVATE ibkr_execution Qt6::Test Qt6::Network)

ibkr_test(tst_recording fake_tws.h)
target_link_libraries(tst_recording PRIVATE ibkr_execution Qt6::Test)

ibkr_test(tst_rpc json_compare.h)
target_link_libraries(tst_rpc PRIVATE ibkr_transport Qt6::Test)
target_compile_definitions(tst_rpc PRIVATE IBKR_ENGINE_PATH="$<TARGET_FILE:ibkr-engine>" IBKR_REPO_DIR="${IBKR_REPO_DIR}")
add_dependencies(tst_rpc ibkr-engine)

# 阶段 2 的进度表:engine-ts 的 96 步 RPC 回放对着 C++ 引擎(棘轮名单 fixtures/golden_rpc_passing.json 只许变长)
ibkr_test(tst_golden_rpc)
target_link_libraries(tst_golden_rpc PRIVATE Qt6::Test)
target_compile_definitions(tst_golden_rpc PRIVATE IBKR_ENGINE_PATH="$<TARGET_FILE:ibkr-engine>" IBKR_REPO_DIR="${IBKR_REPO_DIR}")
add_dependencies(tst_golden_rpc ibkr-engine)

ibkr_test(tst_tools)
target_link_libraries(tst_tools PRIVATE Qt6::Test Qt6::Network)
target_compile_definitions(tst_tools PRIVATE
    IBKR_TWS_POSITIONS_PATH="$<TARGET_FILE:tws-positions>"
    IBKR_TWS_REPLAY_PATH="$<TARGET_FILE:tws-replay>")
add_dependencies(tst_tools tws-positions tws-replay)

# 界面那一半(native/shell):对着假引擎测。假引擎是一个真的子进程,读 stdin 回 JSON,不连任何券商
qt_add_executable(fake_engine fake_engine.cpp)
target_link_libraries(fake_engine PRIVATE ibkr_transport)
set_target_properties(fake_engine PROPERTIES MACOSX_BUNDLE FALSE WIN32_EXECUTABLE FALSE)

foreach(name tst_engine_client tst_engine_supervisor tst_status_store tst_instance_guard tst_config_home tst_locale_format tst_bridge tst_preview_engine tst_consent_model tst_shell_actions tst_doc_parse tst_event_rules tst_macro_store tst_events_store tst_redactor tst_log_file tst_popup_rules tst_alerter tst_window_state tst_power_guard tst_config_guard tst_store_guard tst_diagnostics tst_accounts_setup tst_update_check tst_alert_rules tst_alerts_store tst_spot_store tst_feed_rules tst_feed_stores tst_update_store tst_track_rules tst_tracker_store tst_track_form tst_level_strip tst_track_card tst_tracker_page tst_track_actions tst_tracker_controller tst_trade_rules tst_trade_composer tst_trade_controller tst_fly_rules tst_fly_store tst_wall_store tst_fly_controller tst_order_rules tst_order_stores tst_records_rules tst_records_controller tst_chart_spec tst_chart_scale tst_market_rules tst_market_controller tst_ideas_rules tst_ideas_controller tst_sectors_rules tst_sectors_controller tst_screener_rules tst_screener_controller tst_backtest_rules tst_backtest_controller tst_review_rules tst_review_controller tst_performance_rules tst_performance_controller tst_intel_page_rules tst_intel_controller tst_access_rules tst_access_controller tst_settings_rules tst_settings_controller)
    ibkr_test(${name} shell_harness.h)
    target_link_libraries(${name} PRIVATE ibkr_shell Qt6::Test Qt6::Network)
    target_compile_definitions(${name} PRIVATE
        IBKR_FAKE_ENGINE_PATH="$<TARGET_FILE:fake_engine>"
        IBKR_REPO_DIR="${IBKR_REPO_DIR}")
    add_dependencies(${name} fake_engine)
endforeach()

# analysis 层分组搬时,各组的测试列在 parts/<组>.cmake 里
if(NOT IBKR_SKIP_PARTS)  # 分组还在搬的时候,主构建可以先不带它们(-DIBKR_SKIP_PARTS=ON)
    foreach(part review backtest market intel sweep ibwire twsmisc ibsession validator llm execsupport contract transport broker svc1 svc2 engine engine_core handlers2 handlers1)
        include(${CMAKE_CURRENT_SOURCE_DIR}/parts/${part}.cmake OPTIONAL)
    endforeach()
endif()

if(IBKR_BUILD_UI)
    ibkr_test(tst_qml_bridge shell_harness.h)
    target_link_libraries(tst_qml_bridge PRIVATE ibkr_qml_bridge Qt6::Test Qt6::Qml)
    target_compile_definitions(tst_qml_bridge PRIVATE IBKR_FAKE_ENGINE_PATH="$<TARGET_FILE:fake_engine>")
    add_dependencies(tst_qml_bridge fake_engine)

    ibkr_test(tst_support_service shell_harness.h)
    target_link_libraries(tst_support_service PRIVATE ibkr_support Qt6::Test Qt6::Network)
    target_compile_definitions(tst_support_service PRIVATE IBKR_FAKE_ENGINE_PATH="$<TARGET_FILE:fake_engine>" IBKR_REPO_DIR="${IBKR_REPO_DIR}")
    add_dependencies(tst_support_service fake_engine)

    ibkr_test(tst_icon_provider)
    target_include_directories(tst_icon_provider PRIVATE ${CMAKE_SOURCE_DIR}/app)
    target_link_libraries(tst_icon_provider PRIVATE ibkr_icons ibkr_kitplugin Qt6::Test)
    set_tests_properties(tst_icon_provider PROPERTIES ENVIRONMENT "QT_QPA_PLATFORM=offscreen")

    ibkr_test(tst_kit_controls ${CMAKE_SOURCE_DIR}/app/escape_watcher.h)
    target_include_directories(tst_kit_controls PRIVATE ${CMAKE_SOURCE_DIR}/app)
    target_link_libraries(tst_kit_controls PRIVATE ibkr_shell ibkr_kit ibkr_kitplugin Qt6::Quick Qt6::Qml Qt6::Test)
    set_tests_properties(tst_kit_controls PROPERTIES ENVIRONMENT "QT_QPA_PLATFORM=offscreen")

    ibkr_test(tst_shell)
    target_link_libraries(tst_shell PRIVATE ibkr_shell Qt6::Test)
    target_compile_definitions(tst_shell PRIVATE IBKR_APP_PATH="$<TARGET_FILE:ibkr_assistant>")
    add_dependencies(tst_shell ibkr_assistant)
endif()

ibkr_test(tst_terrain_log)
target_link_libraries(tst_terrain_log PRIVATE ibkr_domain Qt6::Test)
target_compile_definitions(tst_terrain_log PRIVATE TERRAIN_REPLAY_PATH="$<TARGET_FILE:terrain-replay>")
add_dependencies(tst_terrain_log terrain-replay)

ibkr_test(tst_terrain_controller)
target_link_libraries(tst_terrain_controller PRIVATE ibkr_shell Qt6::Test)

if(IBKR_BUILD_UI)
    ibkr_test(tst_terrain_ui)
    target_link_libraries(tst_terrain_ui PRIVATE ibkr_shell ibkr_kit ibkr_kitplugin Qt6::Quick Qt6::Qml Qt6::Test)
    target_compile_definitions(tst_terrain_ui PRIVATE TERRAIN_QML_PATH="${CMAKE_SOURCE_DIR}/app/pages/TerrainReplay.qml")
    set_tests_properties(tst_terrain_ui PROPERTIES ENVIRONMENT "QT_QPA_PLATFORM=offscreen")
endif()

ibkr_test(tst_fly_entry)
target_link_libraries(tst_fly_entry PRIVATE ibkr_shell Qt6::Test)
target_compile_definitions(tst_fly_entry PRIVATE IBKR_FIXTURES_DIR="${CMAKE_CURRENT_SOURCE_DIR}/fixtures")
if(IBKR_BUILD_UI)
    ibkr_test(tst_fly_entry_ui)
    target_link_libraries(tst_fly_entry_ui PRIVATE ibkr_shell ibkr_kit ibkr_kitplugin Qt6::Quick Qt6::Qml Qt6::Test)
    target_compile_definitions(tst_fly_entry_ui PRIVATE ENTRY_QML_PATH="${CMAKE_SOURCE_DIR}/app/pages/FlyEntry.qml" IBKR_FIXTURES_DIR="${CMAKE_CURRENT_SOURCE_DIR}/fixtures")
    set_tests_properties(tst_fly_entry_ui PROPERTIES ENVIRONMENT "QT_QPA_PLATFORM=offscreen")
endif()

ibkr_test(tst_earnings)
target_link_libraries(tst_earnings PRIVATE ibkr_util Qt6::Test)
ibkr_test(tst_entry_market)
target_link_libraries(tst_entry_market PRIVATE ibkr_shell ibkr_execution Qt6::Test)

if(IBKR_BUILD_UI)
    ibkr_test(tst_earnings_ui)
    target_link_libraries(tst_earnings_ui PRIVATE ibkr_kit ibkr_kitplugin Qt6::Quick Qt6::Qml Qt6::Test)
    target_compile_definitions(tst_earnings_ui PRIVATE EARNINGS_QML_PATH="${CMAKE_SOURCE_DIR}/app/pages/EarningsPanel.qml")
    set_tests_properties(tst_earnings_ui PROPERTIES ENVIRONMENT "QT_QPA_PLATFORM=offscreen")
endif()
