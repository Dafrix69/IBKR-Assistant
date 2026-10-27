# 发版

发一个版本的步骤在 `docs/release-checklist.md`;这里写那些步骤背后的规则。

- **发出去的版本不再改。** 同一个标签已经有 Release 时不覆盖;要改就发新的补丁版本。
  悄悄换掉一个有人下载过的安装包,更新提示、问题复现都会对不上。
- **发布说明取自 CHANGELOG** 里对应版本的那一节;「关于 → 更新」显示的就是它,截断到 1,200 字,所以每一节把最要紧的写在前面。
- 发版不设自动闸门、不在 CI 里启动应用做冒烟、不附校验和文件:核对靠清单上的人工步骤。

## CI

`.github/workflows/native.yml` 一个任务:macOS 与 Windows 上配置、编译、跑 `ctest`(`QT_QPA_PLATFORM=offscreen`)。
令牌权限是 `contents: read`。ASan / UBSan 与 TSan 不在 CI 里跑,本机用 `mac-asan`、`mac-tsan` 两个 preset。

安装包怎么出见 [打包](packaging.md)。

## 还没做的

- **代码签名。** macOS 的 Developer ID、Windows 的证书都还没有。
  没有签名之前,每装一个新包,第一次用 API Key 时 macOS 会问一次钥匙串(见 [系统凭证库](credentials.md))。
- **自动更新。** 要先有签名;届时还要定:有追踪或托管单在运行时不自动重启。
