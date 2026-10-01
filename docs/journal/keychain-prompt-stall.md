# 换包之后钥匙串弹窗,引擎整个停住(2026-09-30,打包版,ad-hoc 签名)

20:15(北京时间)换上新打的 ad-hoc 签名包 `desktop/dist/mac-arm64/IBKR-Assistant.app`。启动后 macOS 的 SecurityAgent
弹出钥匙串访问确认,条目是 service=`dafri-llm-api-key`、account=`openai_compatible`,由上一个包写入。弹窗没人点的那段时间里,
引擎一个请求都没答。

## 经过

| 时刻 | 事 |
|---|---|
| 启动 | 界面加载时调 `llm.catalog`。它为「已配置」逐个供应商调 `keychain.hasSecret` → `getSecret` → `@napi-rs/keyring` 的同步 `Entry.getPassword()` |
| 同时 | macOS 弹窗:新包的签名和写入条目的旧包不同,访问控制不认它 |
| 之后 | 引擎进程(`ELECTRON_RUN_AS_NODE` 子进程)CPU 0%。`main.log`:`[watchdog] 引擎 38 秒没有回应`;`system.status`、`tracker.list`、`pending.list`、`macro.board`、`llm.catalog` 等全部 120 秒超时 |

## 根因

- `keychain.ts` 在引擎主线程上同步调原生库。弹窗没人点,调用不返回,事件循环停住:盯盘节拍(`pollTrackers`)、
  托管单对账、所有 RPC 一起停。手上有实盘持仓时,这段时间里止盈止损不工作。
- 触发它的只是想知道"存没存过"的查询,而这个查询把密钥解密了。当时的注释认为原生读一次只要几毫秒,不必另做一条不解密的路径;
  这个判断只在访问控制认得这个程序时成立。
- 钥匙串的访问控制认签名。ad-hoc 签名每打一次包就是一个新身份,所以每换一个包都会复现。
- 同一个原因让 `tests/golden-rpc.spec.ts` 与 `tests/llm-rpc.spec.ts` 在开发机的沙箱里一直挂住:测试里的 `llm.catalog`
  解密的是开发者本机真实的 Key,等的是一个沙箱里看不见的弹窗。

## 改了什么

设计写在 [系统凭证库](../features/credentials.md):

- 查"存没存过"不解密(macOS 用 `security find-generic-password` 只读属性),答案记在进程里;启动与打开页面不再碰密钥。
- 解密与写入挪进凭证子进程(引擎自己的可执行文件,钥匙串认的身份不变),调用方最多等 20 秒,到点报一句说清楚怎么办的错。
  子进程在 worker 线程里调原生库,引擎一退出它就跟着结束。
- `keychain.set` / `futu.set_password` 移到本地道,弹窗不挡交易道。
- `.dependency-cruiser.cjs` 加 `keychain-off-the-loop`:引擎里的模块再直接引 `keychain.ts` 就红。
- `tests/keychain-offloop.spec.ts`:假钥匙串永远不回话时,`system.status`、`tracker.list`、`llm.catalog` 照答,盯盘节拍照跑。
  golden-rpc 与 llm-rpc 在沙箱里不再挂住。

## 还没核对

真机:装上新包后,启动不弹窗;第一次解析指令时才弹,等着的时候「持仓追踪」的节拍照跳;点「始终允许」之后不再问。
有了 Developer ID 签名之后,升级前后是同一个身份,不再弹。
