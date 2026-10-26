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
