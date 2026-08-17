# IBKR 交易指令解析引擎

把中英混合的自然语言交易指令解析成结构化订单,经硬校验后直连 Interactive Brokers 执行,
并把每一笔从提交到终态自动落库。实现依据是 `ibkr_prompt_design_2.md` 设计方案。

核心原则照抄设计文档:**提示词负责理解,软件层负责最后防线;宁可拒绝,绝不猜测。**

---

## 当前进度

| 已实现 | 说明 |
|---|---|
| §2 §3 §4 提示词体系 | 系统提示词 / 用户消息模板 / 7 组少样本,全部带版本号放 `prompts/`,渲染后算指纹落库 |
| §5.1 输出 schema | pydantic 严格模型,多余字段直接失败;单条坏订单降级成拒绝,不牵连其他订单 |
| §5 硬校验层 | 限额复算、方向复核、账户映射、价差结构、时段策略、重复防抖、置信度闸门 |
| §6 交易记录 | SQLite **append-only**(触发器禁止 UPDATE/DELETE),状态与成交以事件追加,读取时折叠成文档 |
| §8 下单层 | ib_insync 封装:合约 qualify、BAG 组合、原生条件单(方式 A)、软件盯盘 + AUTO_MID(方式 B)、双连接账户路由 |
| §9 安全 | Keychain 凭证、账号永不进提示词(代码级检查)、日志脱敏、审计只增不改、全局熔断 |
| §10 Electron 桌面端 | 完整图形界面 + 硬化的主进程;Python 引擎作为 JSON-RPC sidecar |
| §11 落地 | 提示词版本化、别名表配置化、限额从小起步、三道执行闸门 |
| 未实现 | §7 复盘功能(设计上就是默认关闭的可选项);打包签名与公证需要你的开发者证书 |

## 快速开始(桌面端)

```bash
python3 -m venv .venv && .venv/bin/pip install -e ".[dev,broker]"
cd desktop && npm install && npm start
```

首次启动会自动从示例生成 `config/settings.json`。然后在右栏「大模型」面板选供应商、填 API Key
(写进 macOS Keychain,不落配置文件),在「连接」面板检测 TWS,在「设置」面板核对限额与执行闸门。

> 如果 `npm install` 卡在下载 Electron 二进制(几分钟没有进展),那是 `@electron/get`
> 偶发的挂起,不是网络问题。手动补上即可:
> ```bash
> V=$(node -p "require('electron/package.json').version")
> curl -L -o /tmp/e.zip "https://github.com/electron/electron/releases/download/v$V/electron-v$V-darwin-arm64.zip"
> unzip -q -o /tmp/e.zip -d node_modules/electron/dist
> printf 'Electron.app/Contents/MacOS/Electron' > node_modules/electron/path.txt
> ```

## 界面

侧栏导航,七个页面:

- **交易指令** — 输入框(⌘Enter 解析)与解析结果并排;「解析并校验(不下单)」/「发送到 IBKR」
  两个按钮,结果卡片含通过 / 排队 / 拒绝 / 警告与本次调用的模型、耗时、token 用量
- **订单看板** — 「排队等待触发」与「已提交」分列(§8.2b),下方是实时通知流;侧栏项带排队数徽标
- **交易记录** — 可筛选列表与完整详情、数据导出
- **TWS 连接 / 大模型 / 设置 / 关于** — 见后续各节

顶栏常驻:美东时间、市场状态、模型、TWS 连接状态、当前模式,以及**「暂停全部自动执行」熔断
按钮(⌘⇧H)**——§9.7 要求的那个总闸。

界面结构参照 Apple Design Resources 的 macOS UI Kit 应用模板:**统一工具栏 + 源列表侧栏 +
内容区**。侧栏分三组(工作区 / 接入 / 应用),七个页面:交易指令、订单看板(带排队徽标)、
交易记录、TWS 连接、大模型、设置、关于;选中项为强调色填充,图标是按 SF Symbols 几何手绘的
内联 SVG(描边 1.4,`currentColor`,不引外部字体,CSP 依旧只允许 'self')。

### 视觉:按 macOS HIG 来

- **系统字体与字号层级**(正文 13px / 说明 11px),不自造字号
- **系统语义色**(systemBlue/Red/Green/Orange),浅色 `#007AFF`、深色 `#0A84FF`
- **跟随系统深浅色**——macOS 应用不该强制一种外观
- **材质**:窗口开 `vibrancy`,界面用半透明底让模糊透出来;工具栏 `hiddenInset` + 拖拽区
- **AppKit 风格控件**:胶囊分段控件、开关(不是复选框)、System Settings 那种内嵌分组列表
- 0.5px 发丝分隔线、10px 圆角、克制的阴影

半透明只是装饰,不是可读性的前提:**macOS 打开「减弱透明度」辅助功能、或在 Windows 上没有
vibrancy 底材时,自动切换成实底**(`prefers-reduced-transparency` + 非 darwin 平台的
`data-vibrancy="off"`)。这一条是实测发现的——在没有底材的环境里,半透明面板背后是空的,
文字对比度会直接塌掉。

## 接入外部大模型

界面「大模型」面板可以直接配置解析引擎用哪个模型,不必改代码:

| | 说明 |
|---|---|
| 供应商 | **Anthropic(Claude)** 或 **OpenAI 兼容端点**(DeepSeek、通义、Kimi、智谱等都暴露这种端点) |
| 模型 | 预设下拉 + 自定义输入,填任意模型标识 |
| Base URL | 仅兼容端点需要;**强制 https**,只给 `127.0.0.1` 放行 http(§9.4) |
| API Key | 写入 macOS Keychain,**按供应商分开存**,换供应商不会用错上一把;界面只显示"已配置/未配置",永不回读密钥 |
| 调用参数 | `effort`(仅 Anthropic)、`temperature`、`max_tokens`、超时 |
| 测试连接 | 真打一次最小请求,报告延迟、token 用量、模型名,以及**结构化输出用的是哪种模式** |

换供应商不会松掉任何一条边界:

- **发出去的仍然只有 S2 级数据**——指令原文、当前时间、行情快照、别名表与限额。真实账号、余额、
  持仓、成交记录一概不出本机,和供应商是谁无关。
- **输出仍然要过 schema**。能用 `json_schema` 就用;端点只支持 `json_object` 时自动降级,
  把 schema 内嵌进系统提示词,并在界面上明确标出已降级——因为这会直接影响解析可靠性、抬高拒绝率。
- 无论模型多弱,§5 的硬校验层照样逐条复核限额、方向、账户与价差结构。模型再离谱也越不过这一层。

界面能改的只有上面那几项。`keychain_service` 之类的字段被 RPC 层显式拒绝,base_url 写错会
**回滚且不落盘**。

## TWS 连接:检测、诊断、引导

**本软件不接触你的 IBKR 账号密码。** IBKR 凭证是 §9.1 的 S0 级数据,只允许存在于 IBKR 自己的
程序里——登录在 TWS / IB Gateway 的窗口里完成,这里做的是它前后那几步:

| 面板分区 | 做什么 |
|---|---|
| 1 · 程序 | 检测 TWS / IB Gateway 是否安装、是否在运行;装了没开的可以一键启动(路径在引擎侧解析,界面传不了任意路径) |
| 2 · API 端口 | 探测 7496 / 7497 / 4001 / 4002 及配置里的自定义端口,标出每个端口对应哪条连接、是否已连接。纯 TCP 探测,不发协议帧,不打扰已有会话 |
| 3 · 握手与账户 | 真连一次(**只读连接**)读回服务器版本与账户列表,连完即断;同时核对**账户别名是否对得上真实账号** |
| 4 · 连接引擎 | 建立引擎真正用来下单的长连接 |
| 连不上时照着做 | 6 步指引,写死 TWS 的确切菜单路径,并按你的实际配置显示端口号 |

两个细节值得单独说:

**别名映射校验。** 配置里 `模拟 → DU7654321` 如果账号写错了,下单时 IBKR 不会报错,只会静默
落到错误账户。所以诊断会拿 `managedAccounts()` 的真实列表逐条比对,对不上就红字标出;
反过来,会话里能管到、但没写进别名表的账号也会列出来(那些账号 LLM 永远指不到,是设计使然)。

**错误翻译。** 连不上时给的是下一步该做什么,不是 traceback。最常见的一种——端口开着但握手
超时——会明确告诉你:要么「Enable ActiveX and Socket Clients」没勾,要么 TWS 正弹着
「接受传入连接」的确认框等你点 Yes。

## 命令行(不启动界面也能用)

```bash
python -m ibkr_agent selftest                              # 不联网:渲染提示词、检查配置
python -m ibkr_agent validate examples/fixture_spread.json --snapshot SPX=7462.35   # 不联网:跑硬校验
python -m ibkr_agent parse "买入 AAPL 100股 limit 230,理由:回调到位"                  # 调 LLM,永不下单
python -m ibkr_agent run "..." --i-understand-this-places-real-orders               # 真的发单
python -m ibkr_agent rpc                                   # 桌面端用的 JSON-RPC 模式
```

上面四条按危险程度递增:前两条完全不联网,第三条只调模型不下单,最后一条才会真的发单。

熔断与记录:

```bash
python -m ibkr_agent halt --reason "先停一下"    # 停新单
python -m ibkr_agent resume
python -m ibkr_agent records --limit 10
python -m ibkr_agent export ~/Desktop/my-trades.json
```

## 桌面端架构与安全边界(§10.1 / §10.2)

```
┌─ Electron ─────────────────────────────────────────┐
│  Renderer  指令输入 / 订单看板 / 记录浏览            │
│    ↕ contextBridge:只暴露具名方法,无通用调用通道    │
│  Main      IPC 白名单 + 发起方校验 + 系统对话框      │
└──────────────┬─────────────────────────────────────┘
               │ stdio 上的 JSON-RPC 2.0(无监听端口)
        ┌──────┴────────┐
        │ Python 交易引擎 │ ←→ TWS / IB Gateway(127.0.0.1)
        └───────────────┘
```

选 stdio 而不是 §10.1 画的 localhost 端口:没有监听端口,本机其他进程就没有可连的入口。

安全基线是代码级的,不是约定:

| 措施 | 落点 |
|---|---|
| `contextIsolation` / `nodeIntegration:false` / `sandbox:true` | `main.js` BrowserWindow |
| renderer 里 `require`、`process` 均为 `undefined` | 已用 CDP 实测验证 |
| IPC 方法白名单,不在表里直接拒绝 | `main.js: ALLOWED_RPC` |
| 每次 IPC 校验发起方(必须是主窗口主 frame) | `main.js: isTrustedSender` |
| 下单/改限额/连券商需带界面确认标记 | `main.js: SENSITIVE_RPC` + 系统级确认对话框 |
| 严格 CSP(无远程资源、无 eval)、拦截导航与新窗口 | `index.html` meta + `session` 响应头 |
| 生产构建关闭 DevTools | `devTools: DEV` |
| 账户与连接配置**不开放**给界面修改 | `rpc.py: settings.patch` 拒绝 `accounts`/`connections` |
| 真实账号只以掩码形式过 RPC(`DU***321`) | `rpc.py` + 测试断言 |
| 界面写 DOM 一律 `textContent`,绝不拼 `innerHTML` | `renderer/app.js` |

## 打包分发(dmg / exe)

```bash
cd desktop
npm run dist:mac    # → dist/DafriTrading-<版本>-mac-arm64.dmg
npm run dist:win    # → dist/DafriTrading-<版本>-win-x64.exe(NSIS 安装器)
```

两个包都是**未签名**的:

- macOS 首次打开会被 Gatekeeper 拦,右键 → 打开,或 `xattr -dr com.apple.quarantine "/Applications/Dafri Trading.app"`。
  要正式分发需要你的 Developer ID 证书 + 公证(配置里 `identity`/`notarize` 改回即可,
  Hardened Runtime 与 entitlements 已就位)。
- Windows 会弹 SmartScreen,「更多信息 → 仍要运行」。正式分发需要 Authenticode 证书。

### 升级安装(旧版存在时)

三个平台性根因都已处理:

| 场景 | 处理 |
|---|---|
| macOS · 从 DMG 双击运行 | 应用自己就是安装器:提出「移动到应用程序并打开」,已有旧版则先替换(此时旧版必然没在运行,否则会先走下一行),复制后去掉 quarantine、打开新副本、退出 DMG 里这份 |
| macOS/Win · 旧版还在运行 | 新副本启动被旧版的单实例锁挡下时,**旧版会弹窗说明**并提供「退出此版本」按钮——不再静默吞掉让人以为"装不上" |
| Windows · 安装目录被锁 | 两层:NSIS 装/卸载前 `taskkill` 结束在跑的旧版(`build/installer.nsh`);引擎子进程的 cwd 从安装目录挪到 userData——Windows 上进程 cwd 会锁目录,这正是"旧版存在时删不掉安装目录"的隐蔽根因 |
| 升级后依赖漂移 | userData 里的 venv 带依赖清单标记,升级后清单不符就自动补装一次 pip(幂等);venv 坏了(如底层 Python 被卸载)则推倒重建 |

**打包版的运行时布局**与开发版不同,都已实测:

| | 开发版 | 打包版 |
|---|---|---|
| 引擎源码 | 仓库 `src/` | `resources/engine/src`(extraResources,不进 asar) |
| 配置文件 | `config/settings.json` | `userData/settings.json`(应用包只读,首启从示例生成) |
| Python | 仓库 `.venv` | **首启引导**:找系统 Python → 在 userData 建专属 venv → pip 装依赖(约 1 分钟,需联网) |

首启引导找 Python 时探测的是**绝对路径**(Homebrew、python.org 安装器、CLT),因为从
Finder 启动的 GUI 应用只有极简 PATH;连 `/usr/bin/python3` 被 Xcode 许可协议卡住的情况都
处理了(直接用 shim 背后的真实二进制)。机器上确实没有 Python 时,界面会给出明确的安装指引。

`build/entitlements.mac.plist` 里注明了为什么暂时没开 App Sandbox——它会禁止拉起 bundle 外的
Python 子进程,要开必须先把 Python 运行时整个打进包里(体积 +100MB 量级,留作后续选项)。

若 electron-builder 下载 Electron 二进制时卡住(和 `npm install` 同一个毛病),用
`-c.electronDist=<解压好的 dist 目录>` 指向手动下载的副本即可,README 上方有下载命令。
注意 electron-builder 会把 `electronDist` 目录的内容**搬走而不是复制**——每次构建前要
从 zip 重新解压一份,别复用上次的目录(空目录不报错,直到构建后段才以 ENOENT 失败)。

## 三道执行闸门

一条指令要真的变成 IBKR 上的订单,必须同时穿过:

1. `policies.auto_execute = true`(配置,默认 **false**)
2. `run` 子命令带 `--i-understand-this-places-real-orders`(CLI 显式确认)
3. 实盘账户还要 `policies.allow_live_trading = true`(默认 **false**,纸面账户不受此限)

外加一个随时可拉的总闸:熔断开关是**文件**状态,CLI、Python 引擎、将来的 Electron 主进程
看到的是同一个开关,软件崩溃重启后熔断依然有效。连续 N 次失败会自动熔断。

## 与设计文档的三处修正

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

## 数据流向(§9.1 的硬约束)

```
指令文本 + 当前时间 + 行情快照 + 别名表/限额   ──► LLM API   (唯一出网点,只有 S2)
真实账号 / 余额 / 持仓 / 成交记录             ──► 永不出本机
```

这条约束是代码级强制的,不是靠自觉:`prompts.py` 在每次渲染后扫描输出,
一旦出现配置里的任何真实账号就抛异常中止调用。`test_prompts_store_broker.py` 里有对应测试。

## 模块地图

| 文件 | 设计文档章节 | 职责 |
|---|---|---|
| `prompts.py` | §2 §3 §11 | 提示词装配、版本指纹、模板变量与账号泄漏自检 |
| `llm.py` | §2 §11 | Claude 调用、structured outputs、缓存断点、拒绝/截断处理 |
| `models.py` | §5.1 | 输出 schema,单条订单降级 |
| `validator.py` | §5 | 硬校验层(全部纯代码,可脱机单测) |
| `broker.py` | §8 | 合约 qualify、BAG、条件单、中间价定价、账户路由 |
| `store.py` | §6 §9.3 §9.6 | append-only 记录、审计、导出/删除 |
| `engine.py` | §1 §8.2b | 全流程编排、盯盘队列、IBKR 回报入库 |
| `killswitch.py` | §9.7 | 全局熔断 |
| `market.py` | §3 | 触发标的抽取与行情快照拼装 |
| `rpc.py` | §10.1 | 桌面端用的 JSON-RPC sidecar |
| `desktop/main.js` | §10.2 | Electron 主进程与安全基线 |
| `desktop/preload.js` | §10.2 | contextBridge 白名单 |
| `desktop/renderer/` | §10 | 界面 |

## 测试

```bash
.venv/bin/python -m pytest -q     # 133 项,全部离线,不需要 TWS 也不需要 API Key
```

覆盖重点对着 §9.8 的上线前清单:限额复算、触发方向复核、账户映射、价差结构、
提示注入样例、append-only 约束、成交回报入库、熔断行为。
拒绝规则的召回率比解析成功率更重要(§11),所以"必须拒绝"的样本比"必须通过"的多。

## 上线路径(§11 / §9.8)

- [x] 限额从小起步:示例配置 `MAX_ORDER_NOTIONAL = 5000`
- [x] Keychain 存凭证,`.gitignore` 覆盖本地配置与数据库
- [x] 提示注入对抗样例进回归测试集
- [x] 硬校验层单测:限额、方向复核、账户映射、价差结构
- [ ] **接纸面账户跑至少几周**,统计拒绝率与误解析率,再谈实盘
- [ ] 断网 / TWS 掉线场景下实测熔断
- [ ] 出站抓包核对只连 LLM API 域名

> 本仓库是软件实现,不构成任何投资建议。自动执行意味着解析错误会真金白银成交。
# trade
