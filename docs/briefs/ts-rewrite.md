# 任务：把 dafritrade 交易引擎从 Python 重写为 TypeScript

## 背景

本仓库是一个自然语言交易指令引擎：把中英混合指令解析成结构化订单，经硬校验层后直连
IBKR（或富途 OpenD）执行，每笔从提交到终态 append-only 落库。当前架构是
**Electron 桌面端（JS）+ Python 引擎 sidecar**，两者走 stdio 上的 JSON-RPC 2.0。

先通读 `trade/README.md` —— 它不是普通 README，而是全项目的设计决策记录：每一条
"为什么这样做"（收盘确认突破、VIX 永不用 ETF 替身、平仓不过开仓限额、先落闩再发单……）
都是重写时**必须保留的行为规格**，不是可选的风味。

## 目标

把 `trade/src/ibkr_agent/`（27 个模块，约 1.3 万行 Python）重写为 TypeScript，
运行在 Node 上，最终桌面端与引擎统一为一种语言。重写完成的标准：

1. **RPC 协议面逐方法等价** —— 现有 renderer 不改一行也能对接新引擎
2. **SQLite 数据库格式兼容** —— 旧库文件直接打开，append-only 触发器照旧
3. **418 项测试全部移植并通过**，"必须拒绝"样本的召回率一条不丢
4. **纯函数核心与 Python 版对拍一致**（见阶段 0 的黄金基线）

这是一个跑真钱的系统。**行为等价优先于代码优雅**：Python 版里每一处"绕着写"的地方
几乎都对应一次真机踩坑（README 里有记录），重写时不许"顺手简化"掉。

---

## 最高优先级约束（动手前先读完这一节）

### 绝对禁止

- **禁止运行任何可能下真单的代码**。开发期不连实盘；需要联调时只用 paper 账户，
  且 `auto_execute` 保持 false。不确定某段代码会不会发单，就不要运行它。
- **禁止修改 `trade/prompts/` 下的任何文件**。提示词是带版本号的资产，指纹要落库；
  TS 侧原样读取渲染，指纹算法保持一致（同一提示词渲染出的指纹在两个实现里必须相同）。
- **禁止读取、打印或提交**任何真实账号、API Key、Keychain 内容、`config/settings.json`
  里的敏感字段。真实账号在 RPC 层只以掩码形式出现（`DU***321`），这条测试要一并移植。
- **禁止在重写中"顺手修 bug"或"顺手改逻辑"**。发现疑似问题写进 `FINDINGS.md`
  （格式沿用 type-safety-refactor-prompt.md 里那份），继续按原行为移植。
- **禁止把金额与触发价的比较逻辑换成不等价的浮点写法**。Python 侧怎么比、容差多少，
  TS 侧照抄；对拍测试会抓住任何偏差。
- **stdout 纪律**：引擎进程的 stdout 只跑 JSON-RPC 协议。任何依赖库往 stdout 打日志
  都要在进程级重定向到 stderr（Python 版 `rpc.main()` 有现成做法，照搬思路）。

### 必须保留的安全边界（§9 系列，代码级而非约定）

| 边界 | 落点 |
|---|---|
| 真实账号永不进提示词 | 渲染后扫描输出，命中任何配置里的真实账号即抛异常中止 |
| S2 数据白名单出网 | 只有指令文本 / 时间 / 行情快照 / 别名表与限额发往 LLM；账号、余额、持仓、成交永不出本机 |
| 三道执行闸门 | `auto_execute`（默认 false）+ CLI 显式确认旗标 + 实盘还要 `allow_live_trading` |
| 熔断是文件状态 | CLI / 引擎 / Electron 主进程看同一个开关，崩溃重启后依然生效，连续 N 次失败自动熔断 |
| 账户与连接配置不开放给界面 | `settings.patch` 显式拒绝 `accounts` / `connections` 字段 |
| 凭证只进 Keychain/DPAPI | 界面永不回读密钥；富途解锁密码只存 md5 |
| Electron 硬化 | contextIsolation / sandbox / IPC 白名单 / 发起方校验 / 严格 CSP / textContent-only，一条不松 |

---

## 技术选型映射

| Python 侧 | TypeScript 侧 | 备注 |
|---|---|---|
| pydantic v2（strict、extra=forbid） | **zod**（`.strict()`），v4 可用 `z.toJSONSchema` 生成 structured outputs 的 schema | 单条坏订单降级成拒绝、不牵连其他订单的行为要保留 |
| anthropic SDK | `@anthropic-ai/sdk` | structured outputs 优先，`json_object` 降级路径与"界面明示已降级"都要保留；不发 temperature 给不支持采样参数的模型 |
| OpenAI 兼容端点（providers.py） | `openai` SDK 或裸 fetch | Base URL 强制 https、仅 127.0.0.1 放行 http |
| ib_insync / ib_async | **`@stoqey/ib`** | 这是风险最大的移植：没有 ib_insync 那层便利封装，qualify / BAG 组合单 / 原生条件单 / 事件流都要自己搭。合约确认必须带 12 秒硬超时（README「死锁事故」一节是血泪史） |
| futu-api（Python SDK） | npm 的官方 `futu-api`（protobuf） | 接口形状不同但语义映射照 `futu_broker.py`；五处能力差异（无组合单 / 无原生条件单 / 拉式回报 / 无 2 分钟线 / 无美股指数）原样保留为明确拒绝 |
| sqlite3 标准库 | **better-sqlite3** | 同一份 schema、同一组 append-only 触发器；先在旧库副本上验证兼容 |
| keychain.py（security CLI） | Electron `safeStorage`（桌面）；CLI 场景 macOS 走 `security` 命令、Windows 走 DPAPI | 按供应商分开存的行为保留 |
| pytest（418 项，全离线） | **vitest** | 测试与实现同阶段移植，不攒到最后 |
| JSON-RPC sidecar（rpc.py） | 独立 Node 进程，仍走 stdio | 见下面「架构决策」 |

**架构决策：保留进程边界。** 引擎写成独立的 Node 进程（stdio JSON-RPC），不并进
Electron 主进程。理由：renderer / preload / main.js 现有的安全模型与 RPC 白名单原样
可用；串行 RPC 被慢调用拖死的问题（README 已知未解决项）可以在 Node 侧顺势用
per-method 并发解决——这是唯一允许的"行为改进"，因为它只影响延迟不影响语义。
CLI（`ibkr-agent` 的 selftest / validate / parse / run / halt / records）用同一套核心，
入口独立。

**数值策略：** Python 版全程 float，TS 的 number 同为 IEEE 754 double，**语义天然一致
——不要引入 Decimal 库**，那会制造对拍差异。金额的舍入位置与容差逐处照抄。

---

## 阶段 0：勘察与黄金基线（最重要的一步）

1. 通读 `trade/README.md` 与 `trade/src/ibkr_agent/` 全部源码，输出模块依赖图与
   移植顺序表（叶子在前）。
2. 跑一遍现有测试确认基线：`.venv/bin/python -m pytest -q` 应为 418 通过。
3. **生成黄金对拍数据**：写 `scripts/gen_golden.py`，对下列纯函数模块，用现有测试
   fixture 及随机-但-固定种子的输入批量调用，把 (输入, 输出) 序列化到
   `baseline/golden/*.json`（浮点用 repr 全精度）：
   - `validator.py` —— 全部校验规则，通过与拒绝都要覆盖
   - `tracker.py` —— 盈亏、触发判断、跟踪止损峰值、乘数处理（avgCost 含乘数！）
   - `priceaction.py` —— 摆动结构 / BOS·CHoCH / 关键位 / FVG / 扫单 / 形态 / 打分（权重表写死）
   - `optionwall.py` —— 墙计算、整数关口合并、put-call parity 最小二乘反推现价（截距=S、斜率=−D、残差质量闸）
   - `backtest.py` —— 固定数据区间的完整回测输出
   - 定价纯函数（组合中间价、AUTO_MID 限价、行权价宽度、盘口流动性）
   - 提示词渲染指纹 —— 同一版本提示词 + 同一变量，指纹必须逐字节一致
4. TS 侧写对拍 runner：读 golden JSON，逐条断言。**浮点比较用 1e-9 相对容差**，
   超差即失败并打印 diff。

没有这套基线不许进阶段 1。

## 阶段 1：工程骨架

- `trade-ts/`（或与用户商定的目录）：pnpm + TypeScript strict + vitest + eslint。
- tsconfig：`strict: true`、`noUncheckedIndexedAccess: true`、`exactOptionalPropertyTypes: true`。
- 用 zod 定义 `config/settings.json` 的完整 schema（对照 `config.py` + settings.example.json），
  启动时校验，配置错了立刻失败。残缺配置不许让运行时半途崩（桌面端已有"缺哪格空哪格"的行为）。

## 阶段 2：纯函数核心

移植顺序（每个模块 = 实现 + 该模块的 pytest 移植 + golden 对拍全绿 = 一个 commit）：

`schema/models` → `validator` → `killswitch` → `tracker` → `priceaction` → `optionwall`
→ `market` → `macro` → `backtest` → `research` → `notify`

注意事项（全部来自现有实现的踩坑记录，漏一条就是回归）：

- validator：限额复算、方向复核、账户映射、价差结构、时段策略、重复防抖、置信度闸门；
  "必须拒绝"的测试样本多于"必须通过"，这个比例保持。
- tracker：多空方向设置时就拦；平仓数量 = 持仓绝对值，一股不多；`fired_at` 先落闩再发单；
  固定与跟踪止损并存取离现价更近者；峰值持久化。
- priceaction：突破一律收盘确认，影线穿透归扫单；打分权重写死在模块顶部并原样外显。
- optionwall：每价位独立报警状态机（穿过→报一次→落防→离开 band 且过冷却→重新上膛）、
  首次取价只登记不报警、价位重算后丢弃旧状态、状态入 SQLite。
- macro：`test_vix_and_10y_never_get_an_etf_stand_in` 这条测试原样移植。

## 阶段 3：存储层

- `store.ts`：同一份 SQL schema + append-only 触发器（禁 UPDATE/DELETE），状态与成交
  以事件追加、读取时折叠成文档。
- 兼容性验收：用**现有 Python 版生成的数据库文件副本**跑 TS 侧读取测试，折叠结果与
  Python 版 `records.list` / `records.get` 输出一致。
- 审计流水只增不改；导出 / 删除语义照旧。

## 阶段 4：LLM 层

- `prompts.ts`：装配、版本选择、模板变量、渲染后账号泄漏自检（抛异常路径要有测试）、
  指纹与 Python 版逐字节一致。
- `llm.ts` / `providers.ts`：Anthropic 与 OpenAI 兼容端点双通道；structured outputs
  优先、`json_object` 降级并上报；`supports_sampling_params` 逻辑照搬；拒绝/截断处理；
  缓存断点。
- `keychain.ts`：按供应商分开存、只报"已配置/未配置"。

## 阶段 5：券商层

- 先 `tws.ts` / `futu.ts`（检测 / 端口探测 / 诊断 / 拉起）——纯 TCP 探测不发协议帧、
  错误翻译成"下一步做什么"、别名映射与 `managedAccounts()` 比对，这些不碰下单，风险低。
- 再 `broker.ts`（IBKR）：qualify 带 12 秒硬超时；BAG 组合；原生条件单（方式 A）与
  软件盯盘 + AUTO_MID（方式 B）；1100/1101/1102 事件识别"socket 通但无上游"第三态；
  双连接账户路由。
- 最后 `futuBroker.ts`：接口与 broker.ts 完全一致；定价纯函数**引用同一实现文件**，
  不复制；五处能力差异 + 真机联调三结论（指数 `quote_capability` 闸门、模拟盘成交合成
  并标注、`is_paper` 与 `trd_env` 核对）全部保留；订单状态词表按 Python 版补全的那份抄全。
- 券商层的测试沿用 Python 版策略：全部 mock，离线跑；"接错就拒"（组合单进富途、
  未解锁实盘单、跨券商账户路由）逐条移植。

## 阶段 6：engine + rpc + CLI

- `engine.ts`：全流程编排、盯盘队列、回报入库（IBKR 推式与富途拉式归一成同形对象，
  两家的 `status_timeline` / `fills` 长得一样）。
- `rpc.ts`：**逐方法复刻现有协议面**（61 个方法，冻结清单）：

  alerts.create/delete/list/poll/refresh · backtest.parse_rules/run/strategies ·
  book.snapshot · breaker.halt/json/resume/state · broker.catalog/connect/disconnect/select ·
  data.export · futu.diagnose/launch/scan/set_password/unlock ·
  ideas.add/analyze/list/update · instruction.submit · keychain.set ·
  llm.catalog/patch/test · macro.board · options.wall · pa.analyze/comment/timeframes ·
  pending.list/poll · positions.list · records.get/list ·
  sectors.add/add_stock/delete/list/pick/quotes/remove_stock ·
  settings.get/patch · system.selftest/status ·
  tracker.add/close_now/delete/list/poll/update · tws.diagnose/launch/scan

  每个方法的参数与返回形状以 Python 版实际输出为准（必要时给 Python 版加临时脚本抓
  真实响应样本存进 `baseline/rpc_samples/`，作为 TS 侧契约测试的期望值）。
  `settings.patch` 的字段拒绝表、账号掩码、base_url 回滚不落盘，一条不少。
- CLI：五个子命令 + halt/resume/records/export，危险程度阶梯与确认旗标照旧。
- 验收：**现有 Electron renderer 不改任何代码**，把 main.js 里 sidecar 启动命令从
  `python -m ibkr_agent rpc` 换成 node 入口后，桌面端全部页面可用。

## 阶段 7：桌面端收尾与打包

- main.js / preload.js / rpc-client.js 迁移到 TS（行为不变，安全基线逐条核对 README
  那张表）；renderer 可留 JS，不在本次范围强制迁移。
- electron-builder：不再需要 Python 首启引导（找系统 Python / 建 venv / pip 装依赖
  整套删除），引擎打成 bundle 进 extraResources 或直接并入 asar——这是重写最大的
  分发红利，README 里那些 Python 引导的坑随之消失。
- 升级安装的三个平台性处理（单实例锁提示、NSIS taskkill、cwd 不锁安装目录）保留。

---

## 验收闸门（每阶段 commit 前全过）

```bash
pnpm vitest run          # 全部通过，且已移植测试数只增不减
pnpm exec tsc --noEmit   # 零错误
node scripts/golden-check.mjs   # 黄金对拍零超差（阶段 2 起）
```

阶段 6 起加一条：契约测试 —— TS 引擎对 `baseline/rpc_samples/` 全部方法回放一致。

## 交付

`REWRITE_REPORT.md`：各阶段 commit、模块移植对照表（Python 文件 → TS 文件）、
测试移植统计（Python 418 → TS 数量）、对拍覆盖率、`FINDINGS.md` 摘要、
已知不等价点清单（应为空；不为空则逐条说明为什么可接受）、遗留项
（如 renderer 的 TS 化、SQLCipher）。

## 执行方式

先进入 plan mode，读完 README 与源码后给出执行计划和你识别到的风险点（特别是
`@stoqey/ib` 与 ib_insync 的能力差距、futu-api npm 版的接口差异），等我确认再开始。
阶段之间停下来简述结果，我确认后再进下一阶段。
