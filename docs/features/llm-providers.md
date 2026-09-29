# 大模型接入

「接入 → 大模型」配置解析与分析用哪个模型,不用改代码。形状在 `contract/llm.ts`(目录、当前配置、测试回执)。

| 项 | 说明 |
|---|---|
| 供应商 | Anthropic(Claude),或 OpenAI 兼容端点(DeepSeek、通义、Kimi、智谱等) |
| 模型 | 预设下拉,也可以填任意模型标识 |
| Base URL | 只有兼容端点需要;强制 https,只给本机(`127.0.0.1`、`localhost`、`::1`)放行 http |
| API Key | 存系统凭证库(macOS Keychain / Windows 凭据管理器),按供应商分开存(换供应商时 `llm.patch` 把 `keychain_account` 改成供应商名);界面只显示"已配置 / 未配置",不回读密钥 |
| 调用参数 | `effort`(只有 Anthropic)、`temperature`、`max_tokens`、超时 |
| 测试连接 | 真打一次最小请求,报告延迟、token 用量、模型名,以及结构化输出用的是哪种模式 |

界面能改的只有这几项;`keychain_service` 之类的字段被 RPC 层拒绝,Base URL 写错时回滚且不写盘。

## 边界

- **下单解析发出去的只有指令原文、当前时间、行情快照、别名表。** 余额、持仓不出本机,和供应商是谁无关。
  想法的知识总结勾了「附带交易结果」时,会发出每笔交易的标的、结构、开平时间与价格、收益率(不发数量、金额、账户),见 [想法备忘](ideas.md)。
- **真实账号不进任何一次外发。** 解析器的两个出口都包了一层 `providers.guardAccountIds`(由 `RpcServer` 默认的解析器工厂装上):
  外发的文字里出现配置里的真实账号,这一次调用中止,报错里只提别名,不替用户改写内容;示例配置里全零的占位账号不算。
  下单解析在渲染提示词时先过一道 `prompts.ts` 的 `assertNoAccountIds`,这一道没有占位账号的例外。
- **输出要过 schema。** 能用 `json_schema` 就用;端点只支持 `json_object` 时自动降级,把 schema 写进系统提示词,并在界面上标出已降级
  (解析可靠性会变差、拒绝率会升高)。降级按(端点、模型、schema)记在进程里(`providers.ts` 的 `SCHEMA_REJECTED`):
  同一组合收到过一次 400,这一进程里之后直接走 `json_object`,每次调用新建的解析器(想法分析、AI 选股、行情解读、回测条件解析)也共用这份记录。
  键里带着 schema,一份 schema 撞的 400 只让这一份降级;换了端点或模型重新试;只在内存里,重启从头试。「测试连接」不看记下的降级,每次都先试 `json_schema`。
- **发给 API 的 schema 是检入的资产**(`engine-ts/baseline/llm/*_schema.json`,`loadSchemaAsset` 读出):各家不支持的数值与长度约束在资产里已经去掉,
  每个对象节点保留 `additionalProperties:false`,语义约束由 `models.ts` 在本地复校验。运行时唯一的改动是 `parseSchemaForPrompt`:
  提示词 v1.8.0 起从拒绝码的枚举里去掉 `EXCEEDS_LIMIT`(模型不再判断限额)。改 `models.ts` 时手工同步 schema 资产;
  `tests/golden-providers.spec.ts` 检查资产里没有不支持的约束、有 `additionalProperties:false`、定义的名字齐全,不逐字段对照 `models.ts`。
- 无论模型多弱,校验层照样逐条复核限额、方向、账户与价差结构,见 [交易指令](instruction.md)。校验层只用它能核实的字段算限额:
  期权与组合的乘数只认 100。

## 两条路都走官方 SDK

Anthropic 走 `@anthropic-ai/sdk`,兼容端点走 `openai`(请求体逐字段自己拼,SDK 只负责传输):

- 408 / 409 / 429 / 5xx / 连接中断自动重试,指数退避,最多两次;其余 4xx 不重试。
- 降级判断看状态码(只认 400),不在错误文字里找 "400"。
- 没有状态码的错误只能看文字,看之前先拿掉端点地址:地址里的数字(LiteLLM 默认端口 4000 这类)会被误读成状态码,
  一次连接失败就会被当成"端点不认 json_schema"而降级,或被「测试连接」说成 Key 失效 / 模型不存在 / 限流。
- 「测试连接」对 401 / 404 / 429 / 5xx 各给一句中文。

## 测试连接用的 Key

- `llm.test` 测不通时照常返回,回执里 `ok` 为 `false`。带一把没保存的 Key 测试时用的就是那一把,测试不会保存它。
- 临时覆盖只认 `llm.patch` 那七项(provider、model、base_url、effort、temperature、max_tokens、timeout_s),`keychain_*` 一律拒绝。
- **已保存的 Key 只发往保存它时的那个端点**:供应商或 Base URL 和已保存的不同时,这次调用必须带上 `api_key`。例外是只连自家官方端点的供应商(Anthropic,
  客户端不读 base_url)。否则一段注入界面的脚本可以把 base_url 指到别处,让引擎把钥匙串里的 Key 发过去(请求由引擎发出,绕开了界面 `connect-src 'none'` 的 CSP)。
  代价是兼容端点换了地址直接点「测试」时,要把 Key 再填一次,或先保存再测。

## 提示词版本

提示词在仓库根的 `prompts/`,按版本号只增不改;配置里 `"prompt_version": "latest"` 跟着软件带的最新一版走(按 `system_vX.Y.Z.md` 的版本号数值比较),
写成具体版本号就固定在那一版,回滚只改这一行。示例配置写的是 `latest`:配置文件首次启动时从示例拷出,之后软件不会再改写它。

## 测试

`provider-http.spec.ts`(起一个本机 http 端点:URL 拼接、Authorization、按状态码降级、降级在新建的解析器之间共用、换 schema 或模型重新试、
测试连接不看记下的降级、5xx 重试后成功、端点关着时的报错、地址里带状态码数字的端点连不上)、
`llm-rpc.spec.ts`(`llm.test` 用本机假端点)、`fix-llmtest-exfil.spec.ts` 与 `fix-llmtest-official.spec.ts`(Key 只发往保存它的端点)、
`llm-account-guard.spec.ts`(外发前的账号检查)、`prompt-latest.spec.ts`、`golden-providers.spec.ts`。全部离线。
