# 接入外部大模型

界面「大模型」面板可以直接配置解析引擎用哪个模型,不必改代码:

| | 说明 |
|---|---|
| 供应商 | **Anthropic(Claude)** 或 **OpenAI 兼容端点**(DeepSeek、通义、Kimi、智谱等都暴露这种端点) |
| 模型 | 预设下拉 + 自定义输入,填任意模型标识 |
| Base URL | 仅兼容端点需要;**强制 https**,只给 `127.0.0.1` 放行 http(§9.4) |
| API Key | 写入系统凭证库(macOS Keychain / Windows 凭据管理器),**按供应商分开存**,换供应商不会用错上一把;界面只显示"已配置/未配置",永不回读密钥 |
| 调用参数 | `effort`(仅 Anthropic)、`temperature`、`max_tokens`、超时 |
| 测试连接 | 真打一次最小请求,报告延迟、token 用量、模型名,以及**结构化输出用的是哪种模式** |

换供应商不会松掉任何一条边界:

- **发出去的仍然只有 S2 级数据**——指令原文、当前时间、行情快照、别名表与限额。真实账号、余额、
  持仓、成交记录一概不出本机,和供应商是谁无关。
- **输出仍然要过 schema**。能用 `json_schema` 就用;端点只支持 `json_object` 时自动降级,
  把 schema 内嵌进系统提示词,并在界面上明确标出已降级——因为这会直接影响解析可靠性、抬高拒绝率。
- **发给 API 的 schema 是检入资产,不在运行时生成**(`baseline/llm/*_schema.json`,由 `loadSchemaAsset`
  读出来)。各家不支持的数值/长度约束(`minimum` `pattern` `minItems` 这一类)和 `additionalProperties:false`
  在**导出那一刻**就已经处理掉了,资产里逐个字段都是干净的,所以引擎侧没有、也不需要运行时的 schema 清洗;
  语义约束由 `models.ts` 在本地复校验。改 `models.ts` 要重跑导出脚本更新资产,别在发送前临时改形状——
  发出去的字节被黄金对拍钉着。
- 无论模型多弱,§5 的硬校验层照样逐条复核限额、方向、账户与价差结构。模型再离谱也越不过这一层。

界面能改的只有上面那几项。`keychain_service` 之类的字段被 RPC 层显式拒绝,base_url 写错会
**回滚且不落盘**。

## 两条路都走官方 SDK

Anthropic 走 `@anthropic-ai/sdk`,OpenAI 兼容端点走 `openai`(底层仍是同一条 `/chat/completions`,
请求体逐字段自己拼,SDK 只负责传输)。换掉手写 fetch 换来三件事:

- **429 / 5xx / 连接中断自动重试**(指数退避,最多两次)。原来一次网络抖动就是一条指令白发,
  而用户看到的只是"无法连接";4xx 不重试,`json_schema → json_object` 的降级路径照旧一次撞完。
- **降级判断看状态码**,不再在错误文字里找 "400"——正文里恰好带 400 的 500 错误不会再被误判成"端点不认 schema"。
- **「测试连接」说人话**:401 / 404 / 429 / 5xx 各有一句中文,不再把端点的原始报文甩到界面上。

`tests/provider-http.spec.ts` 起一个本机 http 端点把这条路真的走一遍(URL 拼接、Authorization、
按状态码降级、5xx 重试后成功、端点关着时的报错),全程离线。

**形状在引擎契约里**(`engine-ts/src/contract/llm.ts`):目录、当前配置、测试回执,界面从 `bridge.ts` 拿同一份。`llm.test` 测不通
不是 RPC 报错,是 `ok: false` 的回执;带一把没保存的 key 先试时用的就是那一把,试一下不等于保存(`tests/llm-rpc.spec.ts` 用本机假端点钉着)。
