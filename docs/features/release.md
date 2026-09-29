# 发版

发一个版本的步骤在 `docs/release-checklist.md`;这里写那些步骤背后的规则:发版闸门、许可声明、打包的卫生与加固、CI。

## 发版闸门(`desktop/tools/check_release.js`)

`npm run release:check`;CI 的发布任务带 `--tag` 与 `--notes` 运行。检查五样:

1. 版本号合法、和标签对得上(安装包文件名带的是 `package.json` 的版本);
2. `CHANGELOG.md` 里有这一版的一节,有日期、有内容;
3. 条款文本里没有留着 `【发布前填写】`,三份的版本与 `TERMS_VERSION` 一致;
4. 示例配置里三个执行闸门是关的、账号是占位的;
5. 随包的开源组件许可都在白名单里。

平时开发不运行它:条款里的占位符在正式发售前本来就该留着。

- **发出去的版本不再改。** 同一个标签已经有 Release 时发布任务停下,不覆盖;要改就发新的补丁版本。
  悄悄换掉一个有人下载过的安装包,校验和、更新提示、问题复现都会对不上。
- **发布说明取自 CHANGELOG** 里对应版本的那一节,后面接安装提示;「关于 → 更新」显示的就是它,截断到 1,200 字,所以每一节把最要紧的写在前面。
- 每个 Release 带一份 `SHA256SUMS.txt`。

## 第三方许可声明(`desktop/tools/gen_notices.js`)

MIT / BSD / ISC / Apache-2.0 都要求许可声明随副本一起走,而 Vite 打包界面时只留下 React 的版权头,引擎暂存时又会裁掉 `.md` 文件。
所以单独收一份,只收**真的随包发出去的**:

| 范围 | 怎么算 |
|---|---|
| 引擎 | `engine-ts/package-lock.json` 的生产依赖闭包,与暂存脚本同一个算法 |
| 主进程 | `desktop/package.json` 的 `dependencies` 及其依赖 |
| 界面 | 从界面直接 import 的几个库出发(`RENDERER_ROOTS`),顺着 lock 走到底;界面 import 了没登记的第三方库会报出来 |
| Electron | 它自己;Chromium 的另有 `LICENSES.chromium.html`,一并拷进 `resources` |

同一份许可全文只印一次,后面跟着用它的那些包。**白名单只有宽松许可**:出现 GPL / LGPL / AGPL / MPL 或认不出许可的包直接失败,
判断过能带进要卖的软件之后写进 `EXCEPTIONS` 并写明理由。打包脚本在 electron-builder 之前先运行它;
主进程在 `resources/THIRD-PARTY-NOTICES.txt` 找它(从源码运行时在 `build/` 下,要先 `npm run notices`)。

## 打包卫生(`tools/stage_engine_ts.js`、`package.json`)

- 点开头的目录一律不带(第三方包里会夹着作者本机的工具配置)。
- 许可与声明文件不管什么后缀都带,这一条排在按后缀裁剪之前。
- iCloud 的冲突副本(`index 2.html` 这类)在 `files` 里排除,暂存时也排除。
- `futu-api` 是开发依赖,不进安装包;引擎不 import 它。

## 加固

- **熔断丝**(`electronFuses`):关掉 `NODE_OPTIONS` 与 `--inspect` 两条从外面往进程里塞代码的路,只从 asar 加载应用。
  `runAsNode` 保留:引擎就是用应用本体带着 `ELECTRON_RUN_AS_NODE=1` 拉起来的。asar 完整性校验没开,要在两个平台的安装包上实测过再开。
- **开发者工具**:装好的应用带着 `DAFRI_DEV=1` 启动也不开。
- **外链**:界面只打得开 `github.com`(发布页)与 `www.tradingview.com`(图表库署名)的 https 链接,其余一律拒绝。
- **签名版的权限文件**(`entitlements.mac.signed.plist`):只有 `allow-jit`。ad-hoc 版那份保留 `disable-library-validation`,没有 Team ID 时去掉它应用起不来。
- **Windows 安装器**:先不带 `/F` 请旧版自己退出(它会等引擎停稳),6 秒后才强制结束;新旧两个进程名都认。

## Electron 停在 41

41.10.3 起修了 40 那条 high 级通告。42 起 macOS 的系统通知改用 `UNNotification`,要求应用有正式签名,ad-hoc 签名的包发不出通知,
而价位提醒、"引擎没有回应"的告警都靠它。拿到 Developer ID 证书、出了签名版之后再升。
`.github/dependabot.yml` 忽略了 Electron 的大版本更新,测试也检查着,到时两处一起改。其余刻意没升的大版本见 [依赖选型](dependencies.md)。

## CI

| 任务 | 做什么 |
|---|---|
| `engine-ts` | lint、分层检查、类型检查、全套测试(Linux) |
| `engine-ts-platforms` | macOS 与 Windows 上的类型检查与全套测试,两个平台都必须通过 |
| `desktop-ui` | 界面的 lint、分层检查、类型检查、构建、开源许可检查 |
| `audit` | 生产依赖出现 high 及以上的通告就红;Electron 单独检查(它是开发依赖,却随包发出去) |

`ci.yml` 的令牌权限是 `contents: read`;「安装包」工作流只有发布任务拿 `contents: write`。「安装包」工作流(`.github/workflows/package.yml`)在手动触发、推 `v*` 标签、改到打包相关文件与依赖清单的 PR 上运行:
核对 DMG 完整性与原生模块的架构、用包里的 Electron 拉起包里的引擎、把应用真的启动 30 秒确认不闪退且引擎子进程起来了。
推 `v*` 标签时两个平台的包都通过了才挂到 Release。

## 还没做的

- **代码签名。** macOS 的路已经接好,等证书;Windows 的还没接(OV / EV 证书或 Azure Trusted Signing,形式没定)。
- **自动更新。** 要先有签名(macOS 的 Squirrel 要求新旧两版同一个签名);届时还要定:有追踪或托管单在运行时不自动重启。
- **SBOM 与构建来源证明。** `gen_notices.js` 已经有完整的组件清单,出一份 CycloneDX 不难,等有客户要时再做。
- **界面 smoke 进 CI。** `capture_pages.js --check` 要在无头环境里运行 Electron,没有验证过。
- 打包相关的改动(熔断丝、签名版权限、安装器、Electron 41)要实际打一次包、装一次才验证得了。
