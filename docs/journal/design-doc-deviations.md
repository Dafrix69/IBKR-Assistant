# 与设计文档的三处修正

写代码时对着当前 API 现状调整了三个地方,原因都写在对应模块的注释里:

1. **不发 `temperature=0`。** Claude Opus 5 / Sonnet 5 / Opus 4.8 及以后的模型已移除采样参数,
   发送会 400。确定性改由 structured outputs(API 层按 schema 约束输出)+ `effort` 提供;
   只有配置的模型确实接受采样参数时才发送(`llm.py: supports_sampling_params`)。
2. **用 structured outputs 而不是只靠提示词那句"只输出 JSON"。** 输出 schema 由 pydantic 模型
   生成并剥掉 API 不支持的关键字,数值约束仍在本地复校验——等于 schema 与语义两道防线。
3. **`ib_insync` 已停止维护**,维护分支 `ib_async` 需要 Python ≥3.10。`broker.py` 优先 import
   `ib_async`、回落 `ib_insync`,两者 API 同名,升级 Python 后无需改代码。

另外 §9.3 要求的 SQLCipher 静态加密需要专门编译的 sqlite3,标准库不带。当前退化为
数据库文件 0600 权限 + 依赖 FileVault;要满足原设计,需换 `pysqlcipher3` 并在
`TradeStore` 里加一句 `PRAGMA key`。
