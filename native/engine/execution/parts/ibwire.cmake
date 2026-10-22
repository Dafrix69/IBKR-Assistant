# ibwire 组:TWS 线协议里引擎用到的请求与回报(照 @stoqey/ib 的 Encoder / Decoder)
target_sources(ibkr_execution PRIVATE
    execution/tws/wire_common.h
    execution/tws/wire_out.h execution/tws/wire_out.cpp
    execution/tws/wire_in.h execution/tws/wire_in.cpp)
