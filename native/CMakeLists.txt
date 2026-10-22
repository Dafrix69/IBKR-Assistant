# Datrix 的 Qt 6 / C++ 重写(docs/briefs/qt-rewrite.md)。
#
#   cmake --preset mac-debug && cmake --build --preset mac-debug && ctest --preset mac-debug
#
# 或者用 VS Code 打开 native/ 这个目录(见 native/README.md)。
cmake_minimum_required(VERSION 3.25)
project(IBKRAssistantNative VERSION 0.1.0 LANGUAGES C CXX)  # C:third_party/sqlite3

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(IBKR_BUILD_UI "编 Qt Quick 界面(要装 Qt Quick;只编引擎与测试时关掉)" ON)
option(IBKR_SANITIZE "AddressSanitizer + UndefinedBehaviorSanitizer" OFF)
option(IBKR_TSAN "ThreadSanitizer(和上一项二选一)" OFF)

set(IBKR_QT_COMPONENTS Core Network Test)
if(IBKR_BUILD_UI)
    # Widgets 只为原生的确认框(QMessageBox):页面全是 QML。Svg 画图标(app/icon_provider)
    list(APPEND IBKR_QT_COMPONENTS Gui Qml Quick Svg Widgets)
endif()
# 6.9 起才有 RectangularShadow(玻璃面的投影)与窗口的 ExpandedClientAreaHint(内容铺进标题栏)
find_package(Qt6 6.9 REQUIRED COMPONENTS ${IBKR_QT_COMPONENTS})
# macOS 的系统通知、提示音、Dock 提醒、浮动面板用 AppKit(app/platform_mac.mm)
if(APPLE AND IBKR_BUILD_UI)
    enable_language(OBJCXX)
endif()
qt_standard_project_setup(REQUIRES 6.5)

# 仓库根:测试要读 engine-ts/src/contract 里的契约
get_filename_component(IBKR_REPO_DIR "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)

if(MSVC)
    # 源码里的中文注释与字符串按 UTF-8 读
    add_compile_options(/W4 /permissive- /utf-8 /Zc:__cplusplus)
else()
    add_compile_options(-Wall -Wextra -Wpedantic -Wshadow)
    # 浮点照 JS 的算法一步一舍:不许把 a * b + c 合成一条 FMA(arm64 上 clang 默认会合)。
    # 合了以后末位不一样,对拍 TS 版的数(价位条的坐标、定价)就对不上
    add_compile_options(-ffp-contract=off)
endif()

if(IBKR_SANITIZE AND IBKR_TSAN)
    message(FATAL_ERROR "IBKR_SANITIZE 与 IBKR_TSAN 不能同时开")
endif()
if(IBKR_SANITIZE AND NOT MSVC)
    add_compile_options(-fsanitize=address,undefined -fno-omit-frame-pointer -fno-sanitize-recover=undefined)
    add_link_options(-fsanitize=address,undefined)
endif()
if(IBKR_TSAN AND NOT MSVC)
    # 界面线程与引擎线程之间、读 stdin 的线程与事件循环之间最容易出数据竞争
    add_compile_options(-fsanitize=thread -fno-omit-frame-pointer)
    add_link_options(-fsanitize=thread)
    # util/post.h 在这个编法里给跨线程投递加一把 TSan 看得见的锁(装的 QtCore 没有插桩)
    add_compile_definitions(IBKR_TSAN=1)
endif()

enable_testing()
add_subdirectory(third_party/sqlite3)
add_subdirectory(engine)
add_subdirectory(shell)
add_subdirectory(tools)
if(IBKR_BUILD_UI)
    add_subdirectory(app)
endif()
add_subdirectory(tests)
