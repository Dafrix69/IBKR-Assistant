# transport 簇:cli(transport/cli,engine-ts/src/cli.ts)——要 parsing 的 validator / llm、analysis 的 market 与三个 csv 解析,
# 这些本身就是 parts,所以 cli 也留在 part 里(-DIBKR_SKIP_PARTS=ON 时 cli 与 main.cpp 编不了)。
# rpc_server / perf_log / context 在 engine/CMakeLists.txt 的 ibkr_transport 里,orchestrate/host 在 ibkr_orchestrate 里:它们不依赖任何 part。
target_sources(ibkr_transport PRIVATE transport/cli.h transport/cli.cpp)
target_link_libraries(ibkr_transport PUBLIC ibkr_orchestrate)
