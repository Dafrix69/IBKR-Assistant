# 富途 OpenD

Qt 版不接富途。引擎只接 IBKR / TWS,界面上没有富途的入口。

## 现状

- 「接入」只有 TWS、账户、大模型、Discord 跟单四节,没有「富途 OpenD」那一节;本机记下的子页签是 `futu` 时回到 TWS。
- 账户表单里的连接一律标 `IBKR`,账号格式提示只写 `U` / `DU` 开头。
- 配置照旧读得进 `broker.futu`、`broker` 为 `futu` 的连接和挂在它上面的账户,不报错也不用:旧配置不用手改也能启动。
  `broker.provider` 写成 `futu` 时,连接券商那一步报「富途 OpenD 未移植」,TWS 页顶部提示把它改回 `ibkr`。
- 引擎里 `futu.scan` / `futu.diagnose` / `futu.launch` 仍答「富途接入不在这个版本里」,`futu.set_password` / `futu.unlock` 仍在;
  界面不再调用它们。它们留着是因为录制基线(`spec/baseline/rpc`)与对照夹具里有这些调用,删掉要连同基线一起改口径。
- 引擎与界面里按 `broker_provider == "futu"` 分支的几处(网关名写 `OpenD`、错误码 `FUTU_ERROR`、持仓核对跳过)只在配置写成 `futu` 时走到,
  而这种配置连不上券商,实际不会出现。
