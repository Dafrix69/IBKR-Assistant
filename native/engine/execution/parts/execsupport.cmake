# execsupport 簇:execution 层里挨着 IbSession 的小模块——
#   accountFeeds.ts / autoMid.ts(+ broker.ts 的纯定价那一小段)/ qualifyGate.ts / heldStreams.ts / ibLink.ts / optionMarks.ts / ibBars.ts
target_sources(ibkr_execution PRIVATE
    ${CMAKE_CURRENT_LIST_DIR}/../broker_pricing.h ${CMAKE_CURRENT_LIST_DIR}/../broker_pricing.cpp
    ${CMAKE_CURRENT_LIST_DIR}/../account_feeds.h ${CMAKE_CURRENT_LIST_DIR}/../account_feeds.cpp
    ${CMAKE_CURRENT_LIST_DIR}/../auto_mid.h ${CMAKE_CURRENT_LIST_DIR}/../auto_mid.cpp
    ${CMAKE_CURRENT_LIST_DIR}/../session_weak_map.h
    ${CMAKE_CURRENT_LIST_DIR}/../qualify_gate.h ${CMAKE_CURRENT_LIST_DIR}/../qualify_gate.cpp
    ${CMAKE_CURRENT_LIST_DIR}/../ib_link.h ${CMAKE_CURRENT_LIST_DIR}/../ib_link.cpp
    ${CMAKE_CURRENT_LIST_DIR}/../held_streams.h ${CMAKE_CURRENT_LIST_DIR}/../held_streams.cpp
    ${CMAKE_CURRENT_LIST_DIR}/../option_marks.h ${CMAKE_CURRENT_LIST_DIR}/../option_marks.cpp
    ${CMAKE_CURRENT_LIST_DIR}/../ib_bars.h ${CMAKE_CURRENT_LIST_DIR}/../ib_bars.cpp)
