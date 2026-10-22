# svc1 簇:services/ 的第一批(跟单 follow、价位提醒 alerts、异动监控 anomaly、日内剧本 playbook;窄接口在 svc1_ports.h)
# 每个 service 一个子片段(svc1_<名字>.cmake),各改各的;先建文件再往子片段里列
target_sources(ibkr_orchestrate PRIVATE orchestrate/services/svc1_ports.h orchestrate/services/svc1_util.h)
target_link_libraries(ibkr_orchestrate PUBLIC ibkr_execution ibkr_domain ibkr_analysis)
foreach(frag svc1_alerts svc1_anomaly svc1_playbook svc1_follow)
    include(${CMAKE_CURRENT_LIST_DIR}/${frag}.cmake OPTIONAL)
endforeach()
