# handlers2 簇(engine-ts/src/rpc/handlers/ 的 ideas / review / sectors / quality / events / intel / alerts / backtest / follow / market / screener)的对拍测试。
# 世界:h2_world.h / fixtures/h2_world.mjs(底座 svc_world);夹具由 fixtures/gen_h2_*.mjs 对着 engine-ts/dist 现跑生成。
# small = events + intel + follow;quality = quality + alerts;其余一个域一份。
foreach(name small quality sectors ideas review market screener backtest)
    ibkr_test(tst_h2_${name} js_fixture.h svc_world.h h2_world.h)
    target_link_libraries(tst_h2_${name} PRIVATE ibkr_transport Qt6::Test Qt6::Network)
endforeach()

# golden-rpc 里属于本簇的步,进程内回放(真 RpcServer + makeHandlers2 + 真 service,没连券商)
ibkr_test(tst_h2_golden)
target_link_libraries(tst_h2_golden PRIVATE ibkr_transport Qt6::Test Qt6::Network)
