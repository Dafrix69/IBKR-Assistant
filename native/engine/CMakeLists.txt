# 引擎按层分库,依赖只能往下(同 CLAUDE.md 的引擎分层):transport → execution → util。
# 只用 Qt Core / Network,没有界面:CI 与 Windows 不装 Qt Quick 也能编引擎与测试。

qt_add_library(ibkr_util STATIC
    util/earnings.h util/earnings.cpp
    util/jsnum.h util/jsnum.cpp
    util/jsformat.h util/jsformat.cpp
    util/jsvalue.h util/jsvalue.cpp
    util/intel_dateparse.h util/intel_dateparse.cpp
    util/market_js.h util/market_js.cpp
    util/ordered_json.h util/ordered_json.cpp
    util/v8json.h util/v8json.cpp
    util/jsobj.h util/jsobj.cpp
    util/zod.h util/zod.cpp
    util/jsmath.h util/jsmath.cpp util/stdlib_erf.cpp
    util/js_runtime.h util/js_runtime.cpp
    util/py.h util/py.cpp
    util/pyjson.h util/pyjson.cpp
    util/tz.h util/tz.cpp
    util/market_calendar.h util/market_calendar.cpp
    util/risk_budget.h util/risk_budget.cpp
    util/collate.h util/collate.cpp
    util/protections.h util/protections.cpp
    util/killswitch.h util/killswitch.cpp
    util/task.h
    util/rpc_error.h
    util/notify.h util/notify.cpp
    util/keychain.h util/keychain.cpp
    util/secrets.h util/secrets.cpp
    contract/ordered_map.h contract/settings.h
    util/error.h
    util/redact.h util/redact.cpp
    util/awake_clock.h util/awake_clock.cpp
    util/post.h util/post.cpp
    util/whatwg_url.h util/whatwg_url.cpp
)
target_include_directories(ibkr_util PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
# util/jsmath 是 V8 的 fdlibm,对的是打包版应用里跑 TS 引擎的那个 V8(Electron 自带的,按 Chromium 的配置编:不合成 FMA)。
# 所以这一个文件和引擎别的代码一样 -ffp-contract=off(全局已设)。别对它开 -march=native / -mfma / /arch:AVX2:
# 一开就会合成 FMA,末位和 Electron 对不上(Homebrew 的 node 在 arm64 上恰恰是合成了的,和 Electron 本来就差末位)。
target_link_libraries(ibkr_util PUBLIC Qt6::Core)
if(APPLE)
    target_link_libraries(ibkr_util PUBLIC "-framework Security" "-framework CoreFoundation")  # util/keychain
elseif(WIN32)
    target_link_libraries(ibkr_util PUBLIC Advapi32 Crypt32)  # 凭据管理器、DPAPI
endif()

qt_add_library(ibkr_domain STATIC
    contract/config_types.h
    domain/config.h domain/config.cpp
    util/sqlite.h util/sqlite.cpp
    domain/store_safety.h domain/store_safety.cpp
    domain/risk_queries.h domain/risk_queries.cpp
    domain/log_stores.h domain/log_stores.cpp
    domain/imported_trades.h domain/imported_trades.cpp
    domain/store.h domain/store.cpp
    domain/models.h domain/models.cpp
    domain/positions.h domain/positions.cpp
    domain/day_logs.h domain/day_logs.cpp
    domain/terrain_log.h domain/terrain_log.cpp
    domain/option_flow_log.h domain/option_flow_log.cpp
    domain/follow_inbox.h domain/follow_inbox.cpp
    domain/follow_reader.h domain/follow_reader.cpp
)
target_link_libraries(ibkr_domain PUBLIC ibkr_util ibkr_sqlite3 Qt6::Network)  # Network:QHostAddress(base_url 的 IPv6 主机)

# analysis 层:纯计算,不认识券商、引擎、RPC(同 TS 的分层)
qt_add_library(ibkr_analysis STATIC
    analysis/tracker_rules.h analysis/tracker_rules.cpp
    analysis/fly_model.h analysis/fly_model.cpp
    analysis/flyexit.h analysis/flyexit.cpp
    analysis/playbook.h analysis/playbook.cpp
    analysis/fly_plan.h analysis/fly_plan.cpp
    analysis/fly_entry_assist.h analysis/fly_entry_assist.cpp
    analysis/inference.h analysis/inference.cpp
    analysis/exec_quality.h analysis/exec_quality.cpp
)
target_link_libraries(ibkr_analysis PUBLIC ibkr_domain)
# analysis 层分几组同时搬:每组的源文件列在 analysis/parts/<组>.cmake 里(target_sources),各改各的,不碰这个文件
if(NOT IBKR_SKIP_PARTS)  # 分组还在搬的时候,主构建可以先不带它们(-DIBKR_SKIP_PARTS=ON)
    foreach(part review backtest market intel sweep)
        include(${CMAKE_CURRENT_SOURCE_DIR}/analysis/parts/${part}.cmake OPTIONAL)
    endforeach()
endif()

# parsing 层:本地速记、校验、提示词、模型的回包(同 TS 的分层:在 analysis 之上、execution 之下)
qt_add_library(ibkr_parsing STATIC
    parsing/shorthand.h parsing/shorthand.cpp
    parsing/prompts.h parsing/prompts.cpp
    parsing/follow.h parsing/follow.cpp
)
target_link_libraries(ibkr_parsing PUBLIC ibkr_analysis)
# parsing 层分组同时搬时,各组的源文件列在 parsing/parts/<组>.cmake 里
if(NOT IBKR_SKIP_PARTS)
    foreach(part validator llm)
        include(${CMAKE_CURRENT_SOURCE_DIR}/parsing/parts/${part}.cmake OPTIONAL)
    endforeach()
endif()

# orchestrate 层的纯计算部分(追踪的规则);引擎、托管单、对账接上 execution 之后再进来
qt_add_library(ibkr_orchestrate STATIC
    orchestrate/tracker.h orchestrate/tracker.cpp
    orchestrate/host.h orchestrate/host.cpp
)
target_link_libraries(ibkr_orchestrate PUBLIC ibkr_parsing)
# orchestrate 层分组同时搬时,各组的源文件列在 orchestrate/parts/<组>.cmake 里
if(NOT IBKR_SKIP_PARTS)
    foreach(part svc1 svc2 engine engine_core)
        include(${CMAKE_CURRENT_SOURCE_DIR}/orchestrate/parts/${part}.cmake OPTIONAL)
    endforeach()
endif()

qt_add_library(ibkr_execution STATIC
    execution/tws/codec.h execution/tws/codec.cpp
    execution/tws/transport.h execution/tws/transport.cpp
    execution/tws/client.h execution/tws/client.cpp
    execution/tws/recording.h execution/tws/recording.cpp
    execution/tws/positions_snapshot.h execution/tws/positions_snapshot.cpp
)
target_link_libraries(ibkr_execution PUBLIC ibkr_util Qt6::Core Qt6::Network)
# execution 层分组同时搬时,各组的源文件列在 execution/parts/<组>.cmake 里
if(NOT IBKR_SKIP_PARTS)
    foreach(part ibwire twsmisc ibsession execsupport broker)
        include(${CMAKE_CURRENT_SOURCE_DIR}/execution/parts/${part}.cmake OPTIONAL)
    endforeach()
endif()

qt_add_library(ibkr_transport STATIC
    transport/rpc_server.h transport/rpc_server.cpp
    transport/stdio.h transport/stdio.cpp
    transport/perf_log.h transport/perf_log.cpp
    transport/context.h transport/context.cpp
    transport/handlers/system.h transport/handlers/system.cpp
)
target_link_libraries(ibkr_transport PUBLIC ibkr_util Qt6::Core)
# transport 层分组同时搬时,各组的源文件列在 transport/parts/<组>.cmake 里
if(NOT IBKR_SKIP_PARTS)
    foreach(part contract transport handlers2 handlers1 engine_core)
        include(${CMAKE_CURRENT_SOURCE_DIR}/transport/parts/${part}.cmake OPTIONAL)
    endforeach()
endif()

qt_add_executable(ibkr-engine main.cpp)
target_link_libraries(ibkr-engine PRIVATE ibkr_transport ibkr_util)
# 命令行程序:不做成 .app 包,Windows 上要控制台
set_target_properties(ibkr-engine PROPERTIES MACOSX_BUNDLE FALSE WIN32_EXECUTABLE FALSE)
