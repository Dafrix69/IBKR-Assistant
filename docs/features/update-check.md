# 新版本检查

「关于」页的「更新」一节与顶栏的「新版本 x.y.z」按钮:只提示有新版并给出下载链接,不下载、不安装、不替换文件。

自动安装要求签名:macOS 的 Squirrel.Mac 要求新旧两版带同一个 Developer ID 签名,ad-hoc 签名的包装不上去;Windows 包没签名,
自动替换未签名的可执行文件每次都会被 SmartScreen 拦下。证书到手之前,两个平台都成立的做法就是提示加上这台机器对应的安装包链接。
换成自动安装时,`desktop/update-check.js` 的版本比较与安装包挑选照样用得上。

## 规则

| 项 | 取值 | 原因 |
|---|---|---|
| 数据源 | `GET https://api.github.com/repos/Dafrix69/IBKR-Assistant/releases/latest` | 不含草稿与预发布版,不需要登录 |
| 什么时候问 | 启动 30 秒后一次,之后每 12 小时一次;`DAFRI_DEV=1` 的开发态不自动问 | 不和启动时的连券商、拉行情抢;GitHub 未登录的额度是每个 IP 每小时 60 次 |
| 主进程缓存 | 10 分钟(「检查更新」按钮带 `force` 跳过) | 连点按钮不该把额度点光 |
| 算不算新版 | 版本号按 semver 比较,正式版比同号预发布版新;认不出的版本号一律按"没有新版" | 宁可少提示一次 |
| 安装包 | 按 `package.json` 的 `artifactName` 认 `-mac-arm64.dmg` / `-win-x64.exe`,`.blockmap`、`latest.yml`、`SHA256SUMS.txt` 不算 | Intel Mac 没有对应的包,这时只给发布页 |
| 忽略 | 按版本号忽略,存 `localStorage`;更新的版本出来照样提示 | 忽略的是这一版 |
| 关掉 | 「关于」页的「自动检查更新」;关了只有手动点才问 | 有人不希望应用自己联网 |

## 安全

- 请求只在主进程里发(`net.fetch`);渲染层的 CSP 是 `connect-src 'none'`,不为这件事开口子。
- 交给界面的链接只认本仓库 releases 下的地址:发布页必须以 `https://github.com/Dafrix69/IBKR-Assistant/releases/` 开头,安装包必须在它的 `download/` 下;
  不是的一律丢掉,发布页换成固定的 `releases/latest`,安装包直链不给。
- 发布说明按纯文本交出去(去掉 Markdown 的标题、粗体、链接与图片语法,截断到 1,200 字),界面当文本显示;内容取自 CHANGELOG,见 [发版](release.md)。
- 请求头只有 `Accept` 与 `User-Agent: IBKR-Assistant/<版本>`(GitHub 不带 UA 直接 403),不带账户或机器信息。
- 打开链接走外链白名单:只开 `github.com` 与 `www.tradingview.com` 的 https 链接,交给系统浏览器。

## 失败

检查失败不影响任何交易功能,也不弹横幅:自动检查的失败只记在 store 里,「关于」页那一行写出原因(连不上 / 超时 8 秒 / 限频 / 还没有正式版 / HTTP 码)。

## 打包与改名

- `update-check.js` 是主进程 `require` 的本地模块,必须在 `desktop/package.json` 的 `build.files` 里。`tests/desktop-update.spec.ts` 顺着 `main.js` 的
  `require('./…')` 找出主进程会加载的全部本地文件,逐个核对它们在 `build.files` 里、第三方包在 `dependencies` 里。
- 地址写在 `update-check.js` 顶上的 `RELEASES_REPO` 一处;仓库改名或换发布渠道时改这一行,再改 `tests/desktop-update.spec.ts` 里的 `REPO`。
