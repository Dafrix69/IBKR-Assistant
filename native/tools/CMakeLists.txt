# 诊断工具:不进安装包。只用 Qt Core / Network。

qt_add_library(ibkr_tools_common STATIC positions_json.h positions_json.cpp)
target_include_directories(ibkr_tools_common PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(ibkr_tools_common PUBLIC ibkr_execution)

foreach(tool tws-positions tws-replay)
    string(REPLACE "-" "_" source ${tool})
    qt_add_executable(${tool} ${source}.cpp)
    target_link_libraries(${tool} PRIVATE ibkr_tools_common)
    set_target_properties(${tool} PROPERTIES MACOSX_BUNDLE FALSE WIN32_EXECUTABLE FALSE)
endforeach()

qt_add_executable(terrain-replay terrain_replay.cpp)
target_link_libraries(terrain-replay PRIVATE ibkr_domain)
set_target_properties(terrain-replay PROPERTIES MACOSX_BUNDLE FALSE WIN32_EXECUTABLE FALSE)

qt_add_executable(option-flow-report option_flow_report.cpp)
target_link_libraries(option-flow-report PRIVATE ibkr_analysis)
set_target_properties(option-flow-report PROPERTIES MACOSX_BUNDLE FALSE WIN32_EXECUTABLE FALSE)

# 蝶式出场参数的离线扫描(读 fly-iv/ 底账,只出报告;口径见 docs/features/fly-exit-sweep.md)。判定用实盘追踪那一份,所以链编排层
qt_add_executable(fly-exit-sweep fly_exit_sweep.cpp)
target_link_libraries(fly-exit-sweep PRIVATE ibkr_orchestrate)
# --out 不许写进仓库:拿仓库根比
target_compile_definitions(fly-exit-sweep PRIVATE IBKR_REPO_DIR="${PROJECT_SOURCE_DIR}/..")
set_target_properties(fly-exit-sweep PROPERTIES MACOSX_BUNDLE FALSE WIN32_EXECUTABLE FALSE)
