# 发版:闸门、许可声明、打包加固、CI

2026-09-28 加的。发一个版本要做的事见 `docs/release-checklist.md`;这里讲那些事为什么是这样。

## 发版闸门(`desktop/tools/check_release.js`)

`npm run release:check`;CI 的 release 任务带着 `--tag` 与 `--notes` 跑。查五样:

1. 版本号合法,标签对得上——安装包文件名带的是 `package.json` 的版本;
2. `CHANGELOG.md` 里有这一版的一节、有日期、有内容;
3. 条款文本里没有留着 `【发布前填写】`,三份的版本与 `TERMS_VERSION` 一致;
4. 示例配置里三个执行闸门是关的、账号是占位的;
5. 随包的开源组件许可都在白名单里。

平时开发不跑它:条款里的占位符在正式发售前本来就该留着。

**发出去的版本不再改。** 同一个标签已经有 Release,发布任务就停下(原来是 `--clobber` 覆盖)。
悄悄换掉一个已经有人下载过的安装包,校验和、更新提示、问题复现都会对不上。要改就发一个新的补丁版本。

**更新说明取自 CHANGELOG。** 原来每一版的发布说明都是同一段安装提示,而「关于 → 更新」显示的就是它——
用户永远看不到这一版改了什么。

每个 Release 带一份 `SHA256SUMS.txt`。

## 第三方许可声明(`desktop/tools/gen_notices.js`)

MIT / BSD / ISC / Apache-2.0 都要求许可声明随副本一起走。安装包里有两百四十多个组件,而 Vite 把界面依赖打成一个文件时
只留下了 React 的版权头,引擎暂存时又把 `.md` 一律裁掉了(`LICENSE.md` 跟着没了)。

收的是**真的随包发出去的**:

| 范围 | 怎么算 |
|---|---|
| 引擎 | `engine-ts/package-lock.json` 里的生产依赖闭包,和暂存脚本同一个口径 |
| 主进程 | `desktop/package.json` 的 `dependencies` 及其依赖 |
| 界面 | 从界面直接 import 的几个库出发(`RENDERER_ROOTS`),顺着 lock 走到底 |
| Electron | 它自己;Chromium 的另有 `LICENSES.chromium.html`,一并拷进 `resources` |

界面 import 了没登记的第三方库会报出来。同一份许可全文只印一次,后面跟着用它的那些包。

**许可白名单只有宽松许可。** 出现 GPL / LGPL / AGPL / MPL、或者认不出许可的包,直接失败——那不是"记下来就行"的事,
得有人判断能不能带进一个要卖的软件里。判断过之后写进 `EXCEPTIONS`,带上理由。

打包脚本在 electron-builder 之前先跑它;主进程在 `resources/THIRD-PARTY-NOTICES.txt` 找它(从源码运行时在 `build/` 下,
要先 `npm run notices`)。

## 打包卫生(`desktop/tools/stage_engine_ts.js`、`package.json`)

| 问题 | 怎么发现的 | 现在 |
|---|---|---|
| 安装包里带着 `node_modules/resolve/.claude/settings.local.json` | 在 0.5.1 的包里量到:那个包把作者本机的工具配置也发了出来 | 点开头的目录一律不带 |
| `LICENSE.md` 被裁掉 | 按后缀裁 `.md` | 许可 / 声明文件不管什么后缀都带,这一条排在按后缀裁剪之前 |
| iCloud 的冲突副本(`index 2.html`)会进包 | 项目放在同步目录里,`dist/` 下真的冒出来过 | `files` 里排除,暂存时也排除 |
| 富途的接口库带着有安全通告的 protobufjs 6 | `npm audit` | `futu-api` 挪到开发依赖:适配桥没写完之前运行时用不到它。引擎不再去 import 它 |

## 加固

- **熔断丝**(`electronFuses`):关掉 `NODE_OPTIONS` 与 `--inspect` 两条从外面往进程里塞代码的路;只从 asar 加载应用。
  `runAsNode` 必须留着——引擎就是用应用本体带着 `ELECTRON_RUN_AS_NODE=1` 拉起来的。asar 完整性校验还没开,
  要在两个平台的安装包上实测过再开。
- **开发者工具**:装好的应用带着 `DAFRI_DEV=1` 启动也不开。
- **外链**:界面只打得开 `github.com`(发布页)与 `www.tradingview.com`(图表库署名)。
- **签名版的权限文件**(`entitlements.mac.signed.plist`):只有 `allow-jit`。同一个 Team 签的库过得了库校验,
  不再需要 `disable-library-validation`。ad-hoc 版那份不动——没有 Team ID,去掉它应用起不来。
- **Windows 安装器**:先不带 `/F` 地请旧版自己退出(它会等引擎停稳),6 秒后才强制结束。新旧两个进程名都认。

## Electron 停在 41

40 有一条 high 级的通告(沙箱 iframe 绕过弹窗限制),修在 41.10.3。这个应用不用 iframe、不开弹窗,实际够不着,
但卖出去的软件带着一条公开的 high 级通告说不过去。

**没有直接升到最新的大版本**:42 起 macOS 的系统通知改用 `UNNotification`,要求应用有正式签名——ad-hoc 签名的包
发不出通知,而价位提醒、"引擎没有回应"的告警都靠它。拿到 Developer ID 证书、出了签名版之后再升。
`.github/dependabot.yml` 里忽略了 Electron 的大版本更新,测试也钉着,到时候两处一起改。

## CI

| 任务 | 新加的 |
|---|---|
| `engine-ts` | — |
| `engine-ts-platforms` | macOS 与 Windows 上跑引擎测试。用户的机器是这两个平台,测试却一直只在 Linux 上跑。两个平台都必过(2026-09-28 起) |
| `desktop-ui` | 开源许可检查 |
| `audit` | 生产依赖 high 及以上的通告就红;Electron 单独查(它是开发依赖,却随包发出去) |

工作流的令牌权限收到 `contents: read`。Dependabot 每周开升级的 PR:小版本与补丁合成一个,大版本一个依赖一个;
哪些大版本刻意没升、卡在哪,见 [依赖选型](dependencies.md#刻意没升的大版本)。
改到两个工程依赖清单的 PR 会顺带跑一遍「安装包」工作流——引擎的生产依赖整包进安装包,`ci` 里的测试看不到
"装出来的应用起不起得来"。

## 还没做的

- **代码签名。** macOS 的路已经接好,等证书;Windows 的还没接(证书的形式没定:OV / EV 证书,或 Azure Trusted Signing)。
- **自动更新。** 要先有签名(macOS 的 Squirrel 要求新旧两版同一个签名)。届时还要定一条规矩:有追踪或托管单在跑时不自动重启。
- **SBOM 与构建来源证明。** `gen_notices.js` 已经有完整的组件清单,出一份 CycloneDX 不难;等有客户要的时候做。
- **界面 smoke 进 CI。** `capture_pages.js --check` 要在无头环境里跑 Electron,没有验证过,没敢加。
- 打包相关的改动(熔断丝、签名版权限、安装器、Electron 41)都要实际打一次包、装一次才验证得了。
