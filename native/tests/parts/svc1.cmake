# svc1 簇的对拍测试(services/ 第一批:世界与夹具见 svc1_world.h / fixtures/svc1_world.mjs)。每个 service 一个子片段
foreach(frag svc1_alerts svc1_anomaly svc1_playbook svc1_follow)
    include(${CMAKE_CURRENT_LIST_DIR}/${frag}.cmake OPTIONAL)
endforeach()
