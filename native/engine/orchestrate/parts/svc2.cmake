# svc2 簇:services/ 的第二批(后台循环与带状态的编排:成交同步、券商连接、事件、情报、行情缓存……)
# 源文件列在这里(target_sources),各簇各改各的片段,不碰 engine/CMakeLists.txt
target_link_libraries(ibkr_orchestrate PUBLIC ibkr_execution ibkr_domain ibkr_analysis)
target_sources(ibkr_orchestrate PRIVATE
    orchestrate/services/svc_runtime.h orchestrate/services/svc_runtime.cpp
    orchestrate/services/svc_host.h orchestrate/services/svc_host.cpp
    orchestrate/services/svc_util.h
    orchestrate/services/fill_sync.h orchestrate/services/fill_sync.cpp
    orchestrate/services/broker_link.h orchestrate/services/broker_link.cpp
    orchestrate/services/market_data.h orchestrate/services/market_data.cpp
    orchestrate/services/stock_trips.h orchestrate/services/stock_trips.cpp
    orchestrate/services/trade_history.h orchestrate/services/trade_history.cpp
    orchestrate/services/similar_context.h orchestrate/services/similar_context.cpp
    orchestrate/services/public_fetch.h orchestrate/services/public_fetch.cpp
    orchestrate/services/events.h orchestrate/services/events.cpp
    orchestrate/services/intel.h orchestrate/services/intel.cpp
    orchestrate/services/pool.h orchestrate/services/pool.cpp
    orchestrate/services/assignment_watch.h orchestrate/services/assignment_watch.cpp
    orchestrate/services/fly_planner.h orchestrate/services/fly_planner.cpp
    orchestrate/services/iv_recorder.h orchestrate/services/iv_recorder.cpp
    orchestrate/services/idea_semantic.h orchestrate/services/idea_semantic.cpp)
