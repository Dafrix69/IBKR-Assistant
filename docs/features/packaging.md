# 打包

macOS 安装包由 `native/tools/package_mac.sh` 出:一份能单独拷走的 `Datrix.app`,和装着它的 `Datrix-<版本>.dmg`。

## .app 里有什么

| 位置 | 内容 |
|---|---|
| `Contents/MacOS/Datrix` | 界面 |
| `Contents/MacOS/ibkr-engine` | 交易引擎(界面拉起的子进程) |
| `Contents/Resources/prompts/` | 提示词(`prompts/`) |
| `Contents/Resources/llm/` | 大模型输出的 schema(`native/spec/baseline/llm/`) |
| `Contents/Resources/legal/` | 条款文本(`docs/legal/`),同意页读它 |
| `Contents/Resources/settings.example.json` | 示例配置 |
| `Contents/Frameworks/`、`Contents/PlugIns/` | macdeployqt 带进来的 Qt 库与插件(含 TLS) |
| `Contents/Resources/Datrix.icns` | 图标,`native/tools/make_icon.swift` 现画 |

## 打包版与开发版的区别

- CMake 选项 `IBKR_PACKAGE`(预设 `mac-package`,Release)打开时定义 `IBKR_PACKAGED`:界面只从 `.app` 里找引擎、提示词、schema、条款、示例配置,
  不认编译时写进去的仓库路径;编译时的 `ibkr_bundle` 目标每次都把引擎与资源重拷进 `.app`。
- 开发版从编译目录拉引擎,提示词、schema、条款、示例配置读仓库里的。
- 两边的配置是同一份:userData 里的 `settings.json`(macOS 是 `~/Library/Application Support/Datrix/settings.json`),
  `--config` 与 `DAFRI_CONFIG` 照旧优先。第一次用到时那里还没有,按次序拷第一个找得到的:仓库里的 `config/settings.json`、
  改名前的 userData 目录(`IBKR-Assistant`、`Dafri Trading`)里的、示例配置。拷的是原文;旧的几份不删。
  旧目录里界面的偏好(`qt-settings.ini`)一并带过来。见 `native/shell/config_home.h`。

## 脚本做的事

1. `cmake --preset mac-package`,只编 `ibkr_bundle`(界面、引擎、拷资源),不编测试。
2. 拷到临时目录里加工,不动编译目录:画图标;`macdeployqt -qmldir=native/app -executable=…/ibkr-engine`,引擎是第二个可执行文件,要一起改引用;
   两个可执行文件里还引用 `/opt/homebrew` 的就失败退出。
3. ad-hoc 签名(`codesign --sign -`)并 `--verify --deep --strict`。
4. `hdiutil` 做 DMG(里面有 `Applications` 的快捷方式)。输出目录默认 `~/Developer/ibkr/work/dist`,只留这一份 `.app` 与它的 DMG。

`hdiutil` 在受限的沙箱里跑不了,脚本要在普通终端里跑。

## 当前状态

- 只有 macOS、只有 Apple Silicon(Homebrew 的 Qt 是 arm64)。Windows 还没有打包。
- 没有 Developer ID 签名与公证:别的 Mac 第一次打开会被拦,要「系统设置 → 隐私与安全性 → 仍要打开」。
- 没有第三方许可声明(`Contents/Resources/THIRD-PARTY-NOTICES.txt`):「关于 → 第三方许可声明」打不开。Qt 是 LGPL,正式分发前要补。
- 版本号取 `native/CMakeLists.txt` 的 `project(... VERSION)`。
