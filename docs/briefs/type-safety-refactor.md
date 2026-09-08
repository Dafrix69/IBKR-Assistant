# 任务：为 Python 量化交易系统接入类型安全与工程化基线

## 目标

在**不改变任何运行时行为**的前提下，为本项目接入：

1. **ruff** — 统一 lint 与格式化
2. **pyright strict** — 编译期类型检查，渐进式覆盖
3. **Pydantic v2** — 在所有 I/O 边界做运行时校验
4. **数值精度审计** — 金额相关计算脱离 float

这是一个跑真钱的交易系统。所有改动的正确性标准是：**回测结果逐字节一致**。

---

## 最高优先级约束（动手前先读完这一节）

### 绝对禁止

- **禁止修改任何业务逻辑**。包括但不限于：策略信号计算、仓位管理、订单构造、风控规则、指标计算公式、回测撮合逻辑。哪怕你确信某处有 bug，也不要改。
- **禁止运行任何可能下真单的代码**。只使用 paper account 或纯离线历史数据。如果不确定某段代码会不会连实盘，就不要运行它，改为静态阅读。
- **禁止读取、修改、打印或提交** `.env`、`secrets.*`、`credentials.*`、IBKR 账号配置、API key。如果这类值在代码里硬编码，记录位置到报告里，不要动它，也不要把值写进任何文件。
- **禁止用 `# type: ignore` 批量消除类型错误**。见下方「类型错误处理规则」。
- **禁止引入新的运行时依赖**，本文档明确列出的除外（pydantic、pandera）。开发期依赖（ruff、pyright、pandas-stubs、types-*）可以加。
- **禁止修改测试的断言**来让测试通过。测试挂了说明改坏了，回滚。

### 遇到疑似 bug 时

写进 `FINDINGS.md`，格式：

```
## [文件路径:行号] 一句话描述
**类型**：疑似逻辑错误 / 精度风险 / 时区问题 / 竞态 / 其他
**现状**：当前代码做了什么
**为什么可疑**：
**建议**：（不要实施）
```

发现了就记录，继续往下做。全部完成后一起汇报，由我决定改不改。

### 提交规则

- 每个阶段一个 commit，commit message 写清楚该阶段做了什么
- 每次 commit 前必须通过「验收闸门」（见下）
- 不要 push，不要开 PR，不要碰 main 以外的远程分支
- 先创建工作分支：`git checkout -b chore/type-safety-baseline`

---

## 阶段 0：勘察与建立安全网

### 0.1 摸清项目

输出一份简报，包含：

- Python 版本、依赖管理方式（requirements.txt / poetry / uv / conda）
- 目录结构与各模块职责，标出哪些是「策略与执行核心」，哪些是「外围工具」
- 现有测试在哪、怎么跑、当前通过率
- 现有的类型注解覆盖情况（粗略估计百分比）
- 是否已有 lint / format / CI 配置
- 所有外部 I/O 入口清单：IBKR 接口、数据库、配置文件、HTTP 请求、CSV/Parquet 读写、进程间通信

### 0.2 建立回测基线（这是整个任务最重要的一步）

找到项目里的回测入口。选一段**固定的历史数据区间**和**固定的随机种子**，跑一次完整回测，把以下内容序列化到 `baseline/run_0.json`：

- 每一笔信号（时间戳、标的、方向、强度）
- 每一笔订单（时间戳、标的、方向、数量、价格）
- 逐日或逐笔的净值曲线
- 最终统计指标（收益、夏普、最大回撤、交易次数）

浮点数序列化时保留完整精度（`repr` 而非格式化输出）。

同时写一个 `scripts/verify_baseline.py`，功能是重跑同样的回测并与 `baseline/run_0.json` 逐字段比对，有任何差异就非零退出并打印 diff。

**如果项目没有可复现的回测入口，或者结果本身不确定（有真随机、有实时数据依赖），立刻停下来告诉我，不要继续后面的阶段。** 没有对拍能力就没有安全网，这个改造不能盲做。

### 0.3 验收闸门定义

后续每个阶段结束时，以下三项全过才能 commit：

```bash
pytest                          # 全部通过，且通过数不少于基线
python scripts/verify_baseline.py   # 零差异
pyright                         # 错误数不多于该阶段开始时
```

---

## 阶段 1：ruff + 依赖管理

### 1.1 配置 ruff

在 `pyproject.toml` 写入（按项目实际 Python 版本调整 `target-version`）：

```toml
[tool.ruff]
target-version = "py311"
line-length = 100
src = ["src"]  # 按实际源码目录调整

[tool.ruff.lint]
select = [
    "E", "W",    # pycodestyle
    "F",         # pyflakes
    "I",         # isort
    "UP",        # pyupgrade
    "B",         # bugbear
    "SIM",       # simplify
    "C4",        # comprehensions
    "DTZ",       # flake8-datetimez —— 交易系统必开，抓 naive datetime
    "PD",        # pandas-vet
    "NPY",       # numpy 规范
    "RET",       # return 语句
    "PTH",       # 用 pathlib 替代 os.path
    "RUF",       # ruff 自有规则
]
ignore = [
    "E501",      # 行长交给 formatter
]

[tool.ruff.lint.per-file-ignores]
"tests/**" = ["S101"]

[tool.ruff.format]
quote-style = "double"
```

### 1.2 分两步执行

**第一步只跑 formatter**：`ruff format .`，单独 commit。格式化不改变语义，但 diff 会很大，混在一起后面没法 review。

**第二步跑 `ruff check --fix`**，只应用安全的自动修复。commit 前跑一次验收闸门。

`--unsafe-fixes` **不要用**。

### 1.3 剩余问题

`ruff check` 修不掉的告警，**不要手动逐个改**。按规则代码分类统计，写进报告。特别关注 `DTZ` 类告警——naive datetime 在交易系统里是真 bug 的高发区，但修它属于逻辑改动，走 `FINDINGS.md` 流程。

### 1.4 依赖锁定

如果项目还在用裸 `requirements.txt`，迁移到 `uv`：生成 `pyproject.toml` 的依赖段和 `uv.lock`。保持所有版本与当前环境**完全一致**，这一步不做任何升级。

---

## 阶段 2：pyright strict（渐进式）

### 2.1 先量化现状

配置：

```toml
[tool.pyright]
include = ["src"]
exclude = ["**/__pycache__", "notebooks", "research"]
pythonVersion = "3.11"
typeCheckingMode = "standard"
strict = []
reportMissingTypeStubs = false
```

装 `pandas-stubs`，以及 ruff/pyright 提示缺失的 `types-*` 包。

跑 `pyright`，按模块统计错误数，输出一张表。这张表决定推进顺序。

### 2.2 按依赖顺序逐模块转 strict

从**依赖最少的叶子模块**开始（工具函数、数据结构定义），最后才是策略核心。每次只把一个模块加进 `strict` 列表：

```toml
strict = ["src/utils", "src/models"]
```

修完该模块的错误，跑验收闸门，commit，再加下一个。

**不要一次性把整个项目切 strict。**

### 2.3 类型错误处理规则

按优先级：

1. **补真实的类型注解** —— 绝大多数情况应该走这条
2. **改用更精确的类型** —— 比如把 `dict` 换成 `TypedDict`，把字符串常量换成 `Literal` 或 `Enum`（注意：只改注解，不改运行时的值）
3. **`cast()` + 一行注释说明为什么安全** —— 用于类型系统表达不了但你能证明成立的情况
4. **`# type: ignore[具体错误码]` + 注释** —— 最后手段，必须带具体错误码，不许裸 ignore

规则 4 的每一次使用都要记进报告，包含文件、行号、错误码、原因。如果某个模块的 ignore 超过 5 处，停下来告诉我，说明这块可能需要重构而不是加注解。

### 2.4 pandas / numpy 的特殊处理

DataFrame 的列级类型 pyright 表达不了，不要硬凹。策略是：

- 函数签名标 `pd.DataFrame` / `pd.Series` 即可，不追求泛型参数
- **DataFrame 的 schema 校验交给阶段 3 的 pandera**，不是类型系统的工作
- numpy 数组用 `npt.NDArray[np.float64]` 这类标注，这个 pyright 支持得不错

在这两个库的边界上花时间是浪费，把精力留给业务对象。

---

## 阶段 3：Pydantic 边界校验

这一步是整个任务里**收益最高**的部分。TS 也没有的东西就是它——运行时的数据校验。

### 3.1 识别所有边界

逐个处理阶段 0.1 里列出的 I/O 入口。对每一个：

- 定义 Pydantic v2 的 `BaseModel`，字段类型尽可能精确
- 在数据进入系统的第一时间做校验和转换
- 系统内部只传 model 实例，不传原始 dict

优先级从高到低：

| 边界 | 做法 |
|---|---|
| IBKR 返回的 contract / ticker / order / execution | 定义自有 model，从 ib 对象转换过来。不要在业务代码里直接用 ib 的对象 |
| 配置文件（YAML/JSON/TOML/env） | `pydantic-settings` 的 `BaseSettings`，启动时校验，配置错了立刻失败而不是半夜下错单 |
| 外部 HTTP 响应（新闻、情绪、行情） | `BaseModel` + 显式的可选字段处理 |
| 数据库读出的行 | `BaseModel`，注意 `Decimal` 字段 |
| 进程间 / 队列消息 | `BaseModel`，加 schema 版本字段 |
| CSV / Parquet 的 DataFrame | 用 **pandera** 的 `DataFrameSchema`，不是 pydantic |

### 3.2 校验模式

- 默认用 `model_config = ConfigDict(strict=True, extra="forbid")`。宽松模式会悄悄把 `"3.5"` 转成 `3.5`，在金融数据里这不是便利是隐患。
- 如果开 strict 后大量现有数据校验失败，**说明发现了真实的数据质量问题**，记进 `FINDINGS.md`，先临时放宽该字段并加 `# TODO` 注释，不要静默吞掉。

### 3.3 保持行为不变

Pydantic 会让原本能跑的脏数据报错。这是收益，但也是行为改变。所以：

- 每加一个 model，重跑 `verify_baseline.py`
- 如果基线因为校验失败而挂了，**不要放宽校验来让它过**，先查清楚是历史数据本身有问题还是 model 定义错了，结论写进报告

---

## 阶段 4：数值精度审计

**这一阶段只做审计与报告，不做修改。**

扫描全部代码，找出以下模式并记录到 `FINDINGS.md`：

- 用 `float` 表示价格、金额、手续费、盈亏
- float 的累加（盈亏累计、持仓成本），误差会滚雪球
- 用 `==` 比较浮点数
- 价格与数量相乘后没有做 tick size / lot size 对齐
- 跨进程或跨语言序列化时金额走了 float 而不是字符串
- `datetime` 没带时区，或时区在不同模块间不一致（配合阶段 1 的 DTZ 告警一起看）

每条注明影响范围和建议方案（改 `Decimal` / 改整数最小单位 / 加显式舍入）。

---

## 阶段 5：交付

### 5.1 CI 配置

添加 `.github/workflows/check.yml`（如果项目用别的 CI 就用对应格式）：

```yaml
name: check
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v3
      - run: uv sync --all-extras
      - run: uv run ruff check .
      - run: uv run ruff format --check .
      - run: uv run pyright
      - run: uv run pytest
```

不要在 CI 里跑 `verify_baseline.py`，它需要历史数据。

### 5.2 最终报告

写 `REFACTOR_REPORT.md`：

1. **各阶段完成情况**，每阶段的 commit hash
2. **pyright 覆盖进度**：哪些模块已 strict，剩余错误按模块和错误类型统计
3. **`type: ignore` 与 `cast` 清单**：位置、原因
4. **新增的 Pydantic model 清单**：覆盖了哪些边界，还有哪些边界没覆盖
5. **`FINDINGS.md` 摘要**：按严重程度排序，标出你认为最该先看的三条
6. **下一步建议**：如果继续投入，最高性价比的三件事

### 5.3 汇报方式

全部做完后不要自动继续。把报告给我，等我 review。

---

## 执行方式

先进入 plan mode，读完代码后给出你的执行计划和风险点，等我确认再开始。

阶段之间不要连续跑完，每个阶段结束后停下来简述结果，我确认后再进下一阶段。
