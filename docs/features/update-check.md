# 新版本检查

「关于」页多了一节「更新」,顶栏在有新版时多一个「新版本 x.y.z」的按钮。只**提示**、给下载链接,不下载、不安装、不替换文件。

## 为什么不是自动安装

`electron-updater` 那种静默下载 + 重启安装,在 macOS 上走 Squirrel.Mac:它要求新旧两版带**同一个 Developer ID 签名**,
ad-hoc 签名的包装不上去;Windows 包也没签名,自动替换一个没签名的可执行文件,SmartScreen 每次都会拦。
证书到手之前,"告诉你有新版 + 一键打开这台机器对应的安装包"是两个平台都成立的最大公约数。

证书到手后换成自动安装时,`update-check.js` 的版本比较与安装包挑选照样用得上;要改的只是"拿到结果以后做什么"。

## 口径

| 项 | 取值 | 为什么 |
|---|---|---|
| 数据源 | `GET https://api.github.com/repos/Dafrix69/IBKR-Assistant/releases/latest` | 本来就不含草稿与预发布版;不需要登录 |
| 什么时候问 | 启动 30 秒后一次,之后每 12 小时一次;开发态不自动问 | 不和启动时的连券商、拉行情抢;GitHub 未登录的额度是每 IP 每小时 60 次 |
| 主进程缓存 | 10 分钟(「检查更新」按钮带 `force` 跳过) | 连点按钮不该把额度点光 |
| 算不算新版 | 版本号按 semver 比,正式版比同号预发布版新;**认不出的版本号一律按"没有新版"** | 宁可少提示一次,也不拿一个比不出来的号去催人"升级"到旧版 |
| 安装包 | 按 `package.json` 的 `artifactName`:`-mac-arm64.dmg` / `-win-x64.exe`,`.blockmap` 与 `latest.yml` 不算 | Intel Mac 没有对应的包,这时只给发布页 |
| 忽略 | 按版本号忽略,存 `localStorage`;更新的版本出来照样亮 | 忽略的是"这一版",不是"以后都别提醒" |
| 关掉 | 「关于」页的「自动检查更新」;关了只有手动点才问 | 有人不希望应用自己联网 |

## 安全

- 请求只在**主进程**里发(`net.fetch`)。渲染层的 CSP 是 `connect-src 'none'`,不为这件事开口子。
- 返回给界面的链接**只认本仓库 releases 下的地址**:发布页必须以 `https://github.com/Dafrix69/IBKR-Assistant/releases/` 开头、
  安装包必须在它的 `download/` 下,不是的一律丢掉——发布页换成固定的 `releases/latest`,安装包直链干脆不给。
  响应被篡改、或者仓库改名后 API 回了别处的链接,最坏也只是把人带到我们自己的发布页。
- 发布说明按**纯文本**交出去(去掉 Markdown 的标题、粗体、链接与图片语法,截断到 1,200 字),界面当文本显示。
- 请求头只有 `Accept` 和 `User-Agent: IBKR-Assistant/<版本>`(GitHub 不带 UA 直接 403),不带任何账户或机器信息。
- 打开链接走现有的 `setWindowOpenHandler`:https 链接交给系统浏览器。

## 失败

检查失败不影响任何交易功能,也不弹横幅打扰人:自动检查失败只记在 store 里,「关于」页那一行看得到原因
(连不上 / 超时 8 秒 / 限频 / 还没有正式版 / HTTP 码)。

## 打包

`update-check.js` 是主进程 `require` 的本地模块,必须在 `desktop/package.json` 的 `build.files` 里,否则开发时一切正常、
装好的应用一启动就 `Cannot find module`。`tests/desktop-update.spec.ts` 顺着 `main.js` 的 `require('./…')` 把主进程会加载的
本地文件全找出来,逐个核对它们在 `build.files` 里、第三方包在 `dependencies` 里——以后新加的主进程模块也被这一条管着。

## 仓库改名 / 换发布渠道

地址写死在 `desktop/update-check.js` 顶上的 `RELEASES_REPO` 一处。改那一行,再改 `tests/desktop-update.spec.ts` 里的 `REPO`。

## 发布说明从哪来(2026-09-28)

「更新」一节显示的发布说明以前每一版都是同一段安装提示——发布任务里写死的。现在取自 `CHANGELOG.md` 里对应版本的那一节,
后面才是安装提示(`desktop/tools/check_release.js --notes`)。截断到 1,200 字的规矩不变,所以每一版的那一节要把最要紧的写在前面。

发布页上多了 `SHA256SUMS.txt`。挑安装包按文件名后缀认,它不会被误当成安装包。

已经发出去的版本不再覆盖(原来是 `--clobber`):同一个标签已经有 Release,发布任务就停下。见 [发版](release.md)。
