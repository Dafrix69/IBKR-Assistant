# CLAUDE.md — Datrix 的工作规矩

这个文件只写**约束**,不写说明。项目是什么、怎么跑、每个功能怎么设计,看 `README.md`、`native/README.md` 与 `docs/features/`
(目录在 `docs/features/README.md`);动某个功能之前先读它对应的那份 feature 文档,改完把文档改成改动之后的样子。

## 仓库

- 只有一个应用:`native/` 里的 Qt 6 / C++ 版。`qt` 分支是主线。Electron 版(`desktop/`)与 TypeScript 引擎(`engine-ts/`)已删,
  **不要再建、不要往里加东西**;要看原来怎么写的,去 `main` 分支或 `archive/electron-final-2026-10-22`。
- `native/engine/` 交易引擎(`ibkr-engine`,C++ 子进程)、`native/shell/` 界面进程里不画界面的那一半(只用 Qt Core)、
  `native/app/` QML 界面、`native/spec/` 引擎与界面的契约类型(`spec/contract/*.ts`,只当数据读)与录制基线(`spec/baseline/`)。
- 引擎与界面之间只有 stdio JSON-RPC,没有端口。真实账号永远不进提示词、不进日志、不进仓库。
- TWS 线协议不照着 IB 的 GPL 源码写(见 `native/README.md` 的规矩)。

## 每次改完必须跑

```
cd native && cmake --preset mac-debug && cmake --build --preset mac-debug && ctest --preset mac-debug
```

动了线程、协程、生命周期的,再跑一遍 `mac-asan` 与 `mac-tsan`。

基线红了不等于代码错了,等于**行为变了**。先判断是不是刻意的:是,改期望值并在 commit 信息里说明改了哪个口径;不是,改代码。
绝不为了让基线过而改基线。`tests/fixtures/` 里的期望值原来由 TS / React 原版现算,原版已删,往后只能手改:改之前先写清楚新的口径。
`tests/fixtures/golden_rpc_passing.json` 只许变长。

## 加东西之前

- 新依赖:先读 `docs/features/dependencies.md` 的"刻意不引入的"表。要加,写清楚为什么现成的更对,以及打进安装包多大。
- 新指标 / 新数值算法:自己写,不引技术指标库——平滑口径不同就是换数,基线会全红。
- 新提示词:`prompts/` 按版本号只增不改,`config` 里 `prompt_version` 切换。
- 进定价的参数不写经验值:拿历史数据估,估的方法进纯函数并用已知答案的合成数据测,估出来的那一份写明样本、检验结果与局限。原始行情数据不进仓库。
- 新功能:`docs/features/<名字>.md` 一份,写设计决策与口径,不写操作手册,并在 `docs/features/README.md` 的目录里加一行。
  feature 文档只写现在的样子:不写日期、不写"以前 / 后来改成"、不写修过的缺陷与每一次真机核对的经过(历史在 git 里);
  哪些路径已在真机核对、哪些只有离线测试,写成一段当前状态。事故写 `docs/journal/`。
  用户看得见的改动还要进两处:`CHANGELOG.md` 的「未发布」,以及 `docs/user-guide/` 里对应的那一页。
- 会发单 / 授权发单 / 开闸门 / 放宽限额的新 RPC 方法,要进 `native/shell/rpc_policy` 的敏感表与 `confirm_grants` 的授权表。
- 改条款文本(`docs/legal/`)的实质内容:三份开头的「版本」与 `native/shell/consent` 的 `kTermsVersion` 一起改成新日期。
- 新的外部域名(引擎要连一个新的数据源):先改 `docs/legal/privacy.md`。
- 落盘的日志一律过脱敏(`engine/util/redact`);新加一种会进日志的敏感内容,先在那里加规则和测试。

## 不做的事

- 不接格式化工具,不重排别人手调过的对齐。
- 不在测试里连真券商、不发真单。`native/tests/` 全部离线,新测试也必须离线;起应用的测试设 `IBKR_USER_DATA_DIR` 指到临时目录。
- 不把 `config/settings.json`、`~/`、`.claude/`、真机录的 `*.twsrec` 提交进仓库。
- 不覆盖已经发出去的版本。要改就发新的补丁版本。
