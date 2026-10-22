# llm 簇:providers.ts / llm.ts / embeddings.ts(sdk_http 是两个官方 SDK 的 HTTP 那一层)
target_sources(ibkr_parsing PRIVATE
    parsing/sdk_http.h parsing/sdk_http.cpp
    parsing/providers.h parsing/providers.cpp
    parsing/llm.h
    parsing/embeddings.h parsing/embeddings.cpp
)
target_link_libraries(ibkr_parsing PUBLIC Qt6::Network)
