# dafritrade/trade(ibkr_agent)优化审计报告

审计范围:`src/ibkr_agent/` 全部 22 个模块、`desktop/`(Electron 全部源码)、`prompts/system_v1.4.0.md`、tests、config、README。方法:三路并行深度审读(交易核心 / 基础设施与 LLM 层 / 桌面 UI),关键发现已二次人工复核。

## 总体评价

这是一个远超业余水准的项目:把 LLM 输出当不可信输入的三层校验(API 结构化输出 → pydantic `extra="forbid"` → 独立算术 Validator)、stdio JSON-RPC 而非本地端口、密钥只进 Keychain、prompt 版本化+sha256 指纹+账号 ID 永不进 prompt、SQLite 触发器强制 append-only 审计、默认 paper+双开关关闭、Electron 隔离三件套+全 `textContent` 渲染——这些设计在同类项目里是前 10% 的水平。

但缺陷的分布有一个清晰的模式:**校验层(下单前)非常成熟,执行层(下单后)明显不成熟**。最危险的问题全部聚集在"订单被批准之后":组合单方向语义、触发单补校验、事件回调竞态、熔断计数、以及 UI 那个装饰性的确认标记。当前状态应视为**仅限 paper 交易**;在修完下面的"必修清单"之前不要打开 `allow_live_trading`。

---

## 必修清单(开实盘前必须修,按危险度排序)

**C1. 信用组合单方向可能反向建仓 — broker.py:245-271, 441-463;models.py:153;validator.py:373-423**
腿的 action 已经表达了真实持仓方向,而信用结构又要求 order.action="SELL"——IBKR 对 BAG 的 SELL 语义是**反转每条腿的方向**,所以"SELL 铁鹰"实际卖出的是保护翼、买入的是中间腿,风险结构完全相反(或挂在荒谬价格上永不成交)。旁证:`combo_mid_price` 对信用组合算出负 mid,`auto_mid_limit(SELL)` 又把负值当"非正"拒绝——符号约定内部就不自洽;`OrderSpec.lmtPrice gt=0`(models.py:153)也让"BUY+负限价表示净收权利金"的标准写法无法表达。修法:统一为单一编码(推荐:BAG 一律 BUY、腿 action 表达真实方向、允许带符号限价),并在 paper 上完整跑一笔信用垂直价差和一笔铁鹰,核对成交后的持仓再谈实盘。

**C2. UI 确认标记形同虚设 — desktop/preload.js:66-79;main.js:232-237(已人工复核)**
main 进程检查 `__confirmed===true` 才放行敏感 RPC,但 preload 对每个敏感调用**无条件硬编码** `__confirmed: true`;确认对话框只是渲染层自觉调用的,主进程从未把"弹过框"和"放行"关联起来。README 安全表格宣称的保证并不存在。修法:把确认对话框搬进 main 进程——敏感方法由 main 自己弹 `dialog.showMessageBox`(展示解析后的订单要素),确认后才转发引擎;删掉 preload 里的 `__confirmed`。

**C3. 裸卖单腿期权按权利金算风险,无限风险轻松过闸 — validator.py:493-504;prompt 规则 6/7(两路审计独立发现)**
"卖 10 张 NVDA call @ 5.5" 的名义敞口按 10×100×5.5=5,500 计,远低于上限,而裸卖 call 的真实风险无上限。组合单被精心限制为"只许定义风险结构",风险大得多的裸卖单腿却从同一道闸门溜过去。修法:直接拒绝 `secType=OPT` 的裸 SELL(与组合单哲学一致),或按行权价×乘数×数量的最坏情况计敞口;prompt 同步改。

**C4. 触发单 fire 时不做任何补校验(TOCTOU) — engine.py:254-290**
10:00 校验通过的条件单,可能在熔断已触发、`allow_live_trading` 已关闭、市场已收盘之后 fire——fire 时唯一的检查是价格比较,连 killswitch 都不看(自动熔断不清空 `pending_triggers`,只有手动 halt 才清)。修法:每次 fire 前重查熔断状态、市场状态、名义限额。

**C5. 触发单异常处理可导致重复下单 — engine.py:263-270**
只捕获 `BrokerError`;若 `placeOrder` 已到达 TWS 之后才抛出其他异常(连接错、超时),`pending.fired` 仍是 False,下一轮 watch 会再下一单,且没有 orderRef 之类的幂等标识可去重。修法:place 前先置 in-flight 闩锁、捕获 `Exception`、给 order 打 `orderRef=record_id`,refire 前先对账 `ib.openTrades()`。

**C6. 熔断器对"连续券商失败"实际失效 — engine.py:130(已人工复核);killswitch.py:70-84**
每次 LLM 解析成功就 `record_success()` 清零共享计数器,而券商失败发生在解析之后——于是"每条指令都下单失败"这种最需要熔断的场景,计数器永远在 0 和 1 之间震荡,阈值永远够不到。修法:解析失败与券商失败分开计数,只有**下单成功**才清券商计数。

**C7. 熔断触发后,同一批剩余订单照发 — engine.py:189-206**
第 N 单失败触发熔断并已通知用户"熔断",循环却 `continue` 把 N+1..5 单继续发出去。修法:`record_failure` 返回 engaged 即 break,剩余订单标记未提交。

**C8. 订单事件竞态 + errorEvent 无人监听 — engine.py:231-341;broker.py:454-455**
`placeOrder` 之后才注册 orderId→record 映射,而 `ib.sleep(0.5)` 期间事件已在派发——快速成交的 fill/佣金事件被静默丢弃,记录永远停在 Submitted;IBKR 大量拒单(110 价格档位、201 保证金)只走 `errorEvent`,而没有任何监听,拒单永远到不了终态。修法:先 `ib.client.getReqId()` 预留 orderId 并注册映射再下单(或缓存未匹配事件重放);订阅 `ib.errorEvent` 终态化记录。

**C9. 重复单去重在你的机器上大概率失效 — store.py:386-400(你人在 UTC+8,正中此雷)**
记录用机器本地时区(+08:00)写 ISO 时间戳,SQL 截止时间却用 ET(-04:00)渲染,`created_at >= ?` 是**字符串比较**,跨时区偏移不再是时间序——去重窗口要么放过真重复单(可能双倍下单),要么把几小时前的旧单误判为重复。修法:统一 UTC 存储与比较,并补一个 +08:00 记录 vs ET 截止的回归测试。

**C10. NaN 报价穿透全部防线 — broker.py:299-303, 53-88**
ib_insync 的 ticker 初始 bid/ask 是 `nan`,而 `ticker.bid or 0.0` 里 NaN 为真值、`nan<=0`/`nan<nan` 全为 False——所有"坏报价"守卫被跳过,最终提交 lmtPrice=NaN 的限价单(在最该成交的触发时刻死于 IBKR 拒单,而拒单又因 C8 无人听见)。修法:显式 `math.isnan` 检查 + `LegQuote.mid` 拒绝非有限值 + 用 `reqTickers`/有效性谓词等待代替固定 sleep 1s。

**C11. 条件单监控挂在渲染进程的 setInterval 上 — app.js:1720-1729;main.js:421-424**
"方式 B"软件盯盘由 renderer 每 10 秒轮询驱动:窗口最小化会被 Electron 节流,macOS 关窗触发 `engine.stop()` 后引擎连同全部待触发单静默死亡,而 UI 上它们还显示"排队等待触发"。修法:watch 循环移入 Python 引擎自己的定时线程;至少移到 main 进程 + `backgroundThrottling:false` + 关窗前警告"将停止 N 笔条件单监控"。

**C12. 用户确认的是原文,执行的是另一次解析 — app.js:135-148**
"发送到 IBKR"确认的是自然语言文本,点击后**重新**调用 LLM 解析——非确定性模型可能给出与预览不同的数量/行权价/账户。修法:两阶段——解析→展示结构化订单卡→按记录 ID 执行**已校验的那个订单对象**,确认框里写明账户(paper/LIVE)、数量、名义金额。

---

## 重要改进项(实盘前强烈建议,按模块)

**交易核心**:AUTO_MID 限价未按合约 minTick 取整,SPX 组合 0.05 档位必被 110 拒单(broker.py:88);TWS 重连后新建的 IB 会话不会重新挂事件监听,重连后成交全部失踪(broker.py:187-204 + engine.attach_listeners);`cancel_all_open` 只撤本 client 可见的单,重启/换 clientId 后的 GTC 单在"急停"时幸存——应改用 `reqGlobalCancel`(broker.py:488-497);`pending_triggers`/`_order_index` 纯内存,崩溃即静默丢失排队条件单,应持久化到 store 并在启动时对账(engine.py:65-68);风控只有单笔限额,无当日累计名义、最大持仓数、单标的集中度,pending 敞口也不计入(validator.py:475-535);触发条件的 symbol 不与所交易合约核对,"AAPL 到 230 就买 SPX 蝶"畅通无阻(validator.py:426-472);killswitch 状态文件三进程读改写、无锁无原子写,应 temp+`os.replace`+文件锁(killswitch.py:76-98);`managedAccounts()` 短暂为空时账户路由校验被跳过,应视为硬错误(broker.py:212-220)。

**基础设施与 LLM**:RPC 的 `settings.patch` 可以直接打开 `allow_live_trading`/`auto_execute`、抬高全部限额——§9.6 说"账户与连接只许手改配置文件",这个理由对实盘开关至少同样成立,应加入 RPC 禁改集(rpc.py:746-761);`config._assert_account_connections` 里是一段死代码(`continue` 结尾),导致 `is_paper` 纯靠自觉——应校验 `DU` 前缀 ⇔ is_paper、端口 7496/7497 ⇔ 账户类型(config.py:387-393);2026 写死的节假日表过期后 fail-open,2027 年每个假日都算交易日,应改为该年无数据即拒市价单(config.py:141-159);keychain 把密钥放在 `security` 的 argv 里(进程列表可见),docstring 承诺的 `-T ""` 也没真加,CLI `set-key` 还会进 shell 历史(keychain.py:57-69);`data.export` 可写任意路径且含未脱敏账号 ID(rpc.py:773-780);backtest 完全无成本/滑点模型但 docstring 声称"可设单边成本",高换手策略结果系统性虚高,应加 `cost_bps` 参数+配套测试(backtest.py);LLM 无任何聚合成本控制(无日预算/调用频率上限),usage 收集了但从未累计(providers.py:151-226);prompt 默认值可叠加——"中心7520 25cm蝴蝶"七个字就能凑出一张完整的当日 0DTE SPX 订单,建议默认字段 ≥3 个时强制 UNCLEAR(system_v1.4.0.md 规则 1/5/121 行,与"绝不猜测"自相矛盾)。

**桌面 UI**:错误横幅被 5 秒一次的 `refreshStatus` 自动抹掉,实盘连接失败一眼没看到就消失了(app.js:103-107);没有逐单撤销——撤一笔排队条件单只能全局熔断或去 TWS,`ALLOWED_RPC` 里根本没有 cancel 方法;LIVE 模式只是顶栏一枚小橙色 chip,应有通栏红色横幅+确认框内写明账户类别(app.js:83-96);修改风控限额(如名义上限 5,000→5,000,000)无确认、无上界(app.js:1152-1196);解除熔断与暂停共用同一个按钮且一键无确认(app.js:1550-1563);`instruction.submit` 的 120s 超时会把"可能已成交"报成"调用失败",诱导重复提交——超时应显示"结果未知,正在对账"并轮询 records(rpc-client.js:19,286);首启 pip 装依赖只有下限锁,实盘软件应精确锁版本+hash(rpc-client.js:20);成交/熔断通知只进看板页 DOM,无系统通知(app.js:1201);记录时间戳本地时区、顶栏时钟美东,复盘要心算换时区(app.js:33-37);README 说"七个页面"实际十个,想法/板块/回测三个功能区未写进文档,安全表格对 `__confirmed` 的描述也需更正。

---

## 做得好的(保持)

LLM 三层不信任校验、组合单最大亏损口径的限额数学(且测试覆盖扎实)、账户路由多层防呆(别名映射+managedAccounts 复核+显式 order.account+双默认关闭)、stdio 传输天然消灭本地端口攻击面、prompt 版本化+指纹+账号永不出境、SQLite 触发器级 append-only 审计+清库需输入确认短语、Electron 隔离三件套+全 textContent 零 innerHTML+确认框默认焦点在取消、TWS 引导诊断的人话错误提示、fail-safe 的 killswitch 损坏文件处理。这些是项目的骨架,后续改动不要破坏。

## 建议修复顺序

第一批(改动小、危险高):C6、C7、C9、C10、C3 —— 五个都是局部小改。
第二批(执行层重构):C8(事件管线)→ C4/C5(触发单补校验+幂等)→ C1(组合单语义,paper 实测验证)。
第三批(UI 信任链):C2 + C12 一起做(确认搬进 main 进程、按记录 ID 执行)→ C11(watch 移入引擎)。
每批配套补测试:熔断跨指令计数、+08:00 去重回归、NaN 报价、fire_pending 熔断旁路、组合单方向断言——这些正是现有测试(validator 覆盖很密)完全没碰的执行层。

## 与订单簿知识的衔接

你的 AUTO_MID 定价本质上已经在消费 L1 订单簿(bid/ask/mid),而本报告的 C10、tick 取整、报价新鲜度三个问题,正是订单簿工程的入门课。已在 `docs/orderbook_primer.md` 放入订单簿知识手册;对本项目最直接的三个应用:(1) mid 换成 **microprice**(挂单量加权),对 SPX 组合腿定价更贴近真实成交;(2) 给所有报价带上**时间戳与延迟标记**,fire 触发与方向校验拒绝过期报价(直接对应 C4/C10 的修复);(3) 用记录到的真实 spread 校准 `auto_mid_limit` 的滑点余量与 backtest 的 `cost_bps`,替代拍脑袋常数。
