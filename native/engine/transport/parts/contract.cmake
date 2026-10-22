# contract 簇:RPC 的入参契约(contract/schema/*.ts + schema/index.ts)、rpc/params.ts、rpc/contractMethods.ts、rpc/perfLog.ts
# 源文件在 engine/contract/ 与 engine/transport/,都进 ibkr_transport。params.cpp 用 analysis 层的 flyexit 与 tracker_rules,
# 所以 transport 要连 ibkr_analysis(往下依赖,不成环)。
target_sources(ibkr_transport PRIVATE
    contract/kit.h contract/kit.cpp
    contract/schemas.h contract/schemas.cpp
    contract/registry.h contract/registry.cpp
    transport/contract_methods.h transport/contract_methods.cpp
    transport/params.h transport/params.cpp
)
target_link_libraries(ibkr_transport PUBLIC ibkr_analysis)
