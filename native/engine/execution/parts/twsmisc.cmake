# twsmisc 这一组(ibContracts.ts / ibExecHistory.ts / tws.ts)
target_sources(ibkr_execution PRIVATE
    execution/ib_contracts.h execution/ib_contracts.cpp
    execution/ib_exec_history.h execution/ib_exec_history.cpp
    execution/tws_detect.h execution/tws_detect.cpp
)
target_link_libraries(ibkr_execution PUBLIC ibkr_domain)
