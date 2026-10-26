# Qt Quick 界面。QML 模块的 URI(Dafri.Shell)故意和目标名不一样:大小写不敏感的盘上,
# 同名的模块目录和可执行文件会撞在一起。

# QML 到 shell::Bridge 的转接,单拎一个库:测试用真的 QML 引擎驱动它
qt_add_library(ibkr_qml_bridge STATIC qml_bridge.h qml_bridge.cpp)
target_include_directories(ibkr_qml_bridge PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(ibkr_qml_bridge PUBLIC ibkr_shell Qt6::Qml)

# 「支持与数据」那一组(导出诊断、账户、恢复交易库、检查更新):单拎一个库,测试对着假引擎与本机的假服务器跑它
qt_add_library(ibkr_support STATIC support_service.h support_service.cpp)
target_include_directories(ibkr_support PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(ibkr_support PUBLIC ibkr_shell Qt6::Qml Qt6::Network)

# 基础控件与主题(Dafri.Kit):按界面实际用到的 AntD 组件做,不搬 AntD 的接口。Theme 是单例
set_source_files_properties(kit/Theme.qml PROPERTIES QT_QML_SINGLETON_TYPE TRUE)
# QML 文件放在子目录(kit/、shell/)里:QTP0004 = 只在模块根上放 qmldir,子目录不另起模块
qt_policy(SET QTP0004 NEW)
# 图标:tools/gen_icons.mjs 从 React 版渲染出来的 SVG,由 icon_provider 按颜色现画
file(GLOB KIT_ICONS RELATIVE ${CMAKE_CURRENT_SOURCE_DIR} CONFIGURE_DEPENDS kit/icons/*.svg)
qt_add_library(ibkr_kit STATIC)
qt_add_qml_module(ibkr_kit
    URI Dafri.Kit
    VERSION 1.0
    OUTPUT_DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}/Dafri/Kit
    QML_FILES kit/Theme.qml kit/Card.qml kit/Dot.qml kit/Tag.qml kit/Banner.qml kit/Button.qml kit/Segmented.qml kit/Switch.qml kit/Input.qml
              kit/Icon.qml kit/Glass.qml kit/Tip.qml
              kit/Alert.qml kit/Modal.qml kit/Drawer.qml kit/Sparkline.qml
              kit/Pill.qml kit/SymBadge.qml kit/Ring.qml kit/PriceRail.qml kit/StatusCard.qml kit/Meta.qml kit/SectionTitle.qml kit/PageHead.qml
              kit/Label.qml kit/EmptyState.qml kit/Primer.qml kit/Hint.qml kit/LevelStrip.qml kit/ScrollPage.qml kit/InputNumber.qml kit/Select.qml kit/Checkbox.qml kit/TextArea.qml kit/StatTile.qml kit/WrapRow.qml kit/StagePath.qml kit/Widget.qml kit/Feed.qml kit/SearchInput.qml kit/Chart.qml kit/DateRangePicker.qml kit/AutoTable.qml kit/Pager.qml kit/CardGrid.qml kit/StepList.qml kit/Slider.qml kit/LoadingBlock.qml kit/RowList.qml
              kit/Group.qml kit/SwitchRow.qml kit/Working.qml kit/GroupRow.qml kit/NumberRow.qml
    SOURCES kit/text_metrics.h kit/text_metrics.cpp kit/chart_view.h kit/chart_view.cpp kit/secure_input.h kit/secure_input.cpp
    RESOURCES ${KIT_ICONS}
)
target_include_directories(ibkr_kit PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
# 生成的类型注册按文件名 include(chart_view.h)
target_include_directories(ibkr_kit PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/kit)
target_link_libraries(ibkr_kit PUBLIC ibkr_shell Qt6::Quick)
if(APPLE)
    target_link_libraries(ibkr_kit PUBLIC "-framework Carbon")  # 密码框的 Secure Event Input(kit/secure_input)
endif()
# 按颜色现画图标的那一份单拎出来:测试要能直接问它
qt_add_library(ibkr_icons STATIC icon_provider.h icon_provider.cpp)
target_link_libraries(ibkr_icons PUBLIC ibkr_kit Qt6::Quick Qt6::Svg)

qt_add_executable(ibkr_assistant main.cpp escape_watcher.h dev_charts.h native_prompter.h native_prompter.cpp text_dump.h text_dump.cpp
    platform.h popup_controller.h popup_controller.cpp desktop_shell.h desktop_shell.cpp power_controller.h power_controller.cpp fatal_dialogs.h fatal_dialogs.cpp)
if(APPLE)
    target_sources(ibkr_assistant PRIVATE platform_mac.mm)
    target_link_libraries(ibkr_assistant PRIVATE "-framework AppKit" "-framework UserNotifications" "-framework IOKit")
else()
    target_sources(ibkr_assistant PRIVATE platform_other.cpp)
endif()
set_target_properties(ibkr_assistant PROPERTIES
    OUTPUT_NAME "Datrix"
    MACOSX_BUNDLE TRUE
    MACOSX_BUNDLE_BUNDLE_NAME "Datrix"
    MACOSX_BUNDLE_GUI_IDENTIFIER "com.dafri.trading.qt"
    WIN32_EXECUTABLE TRUE
)
set_source_files_properties(shell/Nav.qml PROPERTIES QT_QML_SINGLETON_TYPE TRUE)
qt_add_qml_module(ibkr_assistant
    URI Dafri.Shell
    VERSION 1.0
    QML_FILES Main.qml shell/Nav.qml shell/Sidebar.qml shell/Topbar.qml shell/Notice.qml shell/MacroStrip.qml shell/EventStrip.qml shell/EventList.qml shell/EventActions.qml shell/PagePlaceholder.qml shell/ConsentGate.qml shell/AlertPopup.qml shell/DossierDrawer.qml shell/LookupModal.qml
              pages/TrackerPage.qml pages/PositionCard.qml pages/TrackCard.qml pages/TrackForm.qml
              pages/TradePage.qml pages/OrderTicket.qml pages/PayoffChart.qml pages/SimilarTrades.qml
              pages/FlyEntry.qml pages/FlyPlanner.qml pages/FlyResult.qml pages/FlyChart.qml pages/PlaybookPanel.qml pages/TerrainReplay.qml
              pages/BoardPage.qml pages/RecordsPage.qml pages/RecordDetail.qml
              pages/MarketPage.qml pages/PaCards.qml pages/BookBody.qml
              pages/IdeasPage.qml pages/SectorsPage.qml pages/EarningsPanel.qml pages/ScreenerPage.qml
              pages/BacktestPage.qml pages/BacktestResult.qml pages/SweepPanel.qml pages/RuleBuilder.qml
              pages/ReviewPage.qml pages/ReviewResult.qml pages/PerformancePage.qml pages/PerformanceParts.qml pages/ShareCard.qml pages/IntelPage.qml pages/IntelTimeline.qml pages/AccessPage.qml pages/AccessParts.qml pages/SettingsPage.qml pages/AboutPage.qml
)
target_link_libraries(ibkr_assistant PRIVATE ibkr_qml_bridge ibkr_support ibkr_shell ibkr_icons ibkr_kit ibkr_kitplugin Qt6::Gui Qt6::Quick Qt6::Svg Qt6::Widgets Qt6::Network)
# 开发时的默认位置:仓库里的配置与 TS 引擎、编出来的 C++ 引擎(打包后怎么找,阶段 1 结束时打包再定)
target_compile_definitions(ibkr_assistant PRIVATE
    IBKR_REPO_DIR="${IBKR_REPO_DIR}"
    IBKR_NATIVE_ENGINE_PATH="$<TARGET_FILE:ibkr-engine>")
add_dependencies(ibkr_assistant ibkr-engine)
