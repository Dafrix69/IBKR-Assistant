# ibsession 组:ibSession.ts(IbSession 的默认实现)与它下面那层 @stoqey/ib IBApiNext 的搬法
target_sources(ibkr_execution PRIVATE
    ${CMAKE_CURRENT_LIST_DIR}/../ib_api_next.h ${CMAKE_CURRENT_LIST_DIR}/../ib_api_next.cpp
    ${CMAKE_CURRENT_LIST_DIR}/../ib_link_down.h
    ${CMAKE_CURRENT_LIST_DIR}/../ib_session.h ${CMAKE_CURRENT_LIST_DIR}/../ib_session.cpp)
