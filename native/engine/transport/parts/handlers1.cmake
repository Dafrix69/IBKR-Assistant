# handlers1 簇:rpc/handlers/{tracker,trading,connection,settings,system}.ts。端口在 handler_ports.h(引擎 / router / 服务的窄面)。
# 列出来的文件都存在才行(先建文件再列)。依赖往下:transport → orchestrate / parsing / execution / domain。
target_sources(ibkr_transport PRIVATE
    transport/handlers/handler_ports.h
    transport/handlers/handler_util.h
    transport/handlers/tracker_handlers.h transport/handlers/tracker_handlers.cpp
    transport/handlers/trading_handlers.h transport/handlers/trading_handlers.cpp
    transport/handlers/connection_handlers.h transport/handlers/connection_handlers.cpp
    transport/handlers/settings_handlers.h transport/handlers/settings_handlers.cpp
    transport/handlers/system_handlers.h transport/handlers/system_handlers.cpp
)
