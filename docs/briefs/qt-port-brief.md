# Qt 重写 · 阶段 2 移植助手的工作说明

给并行移植 TS 引擎模块到 `native/engine/` 的助手看。总纲在 `qt-rewrite.md`,这里只写"怎么干活"。
这份文件放在仓库里,不放 /tmp:/tmp 开机即清空(2026-10-19、10-20 各吃过一次)。

## 铁律

- 一行对一行移植 TS 行为,**不顺手改行为**。怀疑是 TS 的 bug:照搬,在头文件注释与交付报告里记成"TS 原样"。
- 不改 `engine-ts/` 的任何文件,不改 React 源码,不跑 `golden:update`,不提交、不推送。
- 测试全部离线:不连真券商、不发真单;不碰 `config/settings.json` 和 `~/Library/Application Support/dafri`(真库);
  要用户数据目录时设 `IBKR_USER_DATA_DIR` 到临时目录。真实账号不进日志、提示词、夹具。
- 钱路径载荷:数值是字符串,`''` = 不设,undefined 的键省略;`tracker.add` 是 `.strict()`。
- 不改共享文件(`engine/util/`、`engine/domain/`、`tests/js_fixture.h`、顶层 CMake)。缺什么共享的,在报告里提,由主会话加。

## 对拍(oracle)

- 期望值由原 TS 模块现跑生成:`tests/fixtures/gen_<x>.mjs`,import `engine-ts/dist` 里 tsc 编出来的模块(改过 engine-ts 先 `cd engine-ts && npx tsc`)。
- 运行时 = 打包应用的运行时 Electron 41(Node 24):
  `ELECTRON_RUN_AS_NODE=1 /Users/dafrix/Developer/ibkr/IBKR-Assistant/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron gen_x.mjs /Users/dafrix/Developer/ibkr/IBKR-Assistant/engine-ts`
- 夹具编码用 `tests/js_fixture.h` 的约定:`__NaN__` `__Inf__` `__-Inf__` `__neg0__` `__undefined__`(生成器用同一个 `enc()`)。
  比较是精确比较,不放容差。夹具 ≲ 3 MB,同一生成器跑两次必须逐字节相同(随机数用固定种子)。
- JS 数学:用 `util::jsmath`(log/exp/pow/…),不直接用 `std::pow` / `std::log`;`**` 与 `Math.pow` 一律 `jsmath::pow`。

## 文件与编译

- 源码 `engine/<layer>/<snake>.{h,cpp}`,测试 `tests/tst_<snake>.cpp`。
- 每个簇自己的 cmake 片段:`engine/<layer>/parts/<簇>.cmake` 与 `tests/parts/<簇>.cmake`;**先建文件再往片段里列**
  (列了不存在的文件会让所有人 configure 失败)。
- 自己的编译目录 `/Users/dafrix/Developer/ibkr/work/build-<簇>`(work/ 不在 iCloud、重启不丢);不要在别人的目录里编。
  变异脚本、日志等要留的东西放仓库(`native/tools/`)或 work/,不放 /tmp(开机即清空)。
- 编译器 `/Library/Developer/CommandLineTools/usr/bin/clang++`,`-DCMAKE_PREFIX_PATH=/opt/homebrew`,Ninja。

## 交付前必须做完

1. 测试全绿(Debug),自己文件零警告。
2. ASan/UBSan(`-DIBKR_SANITIZE=ON`)跑一遍零报告。
3. 变异检验**只在自己的私有副本里做**:`rsync -a --delete native/ /Users/dafrix/Developer/ibkr/work/mut-<簇>/native/`(旁边照验收那样放 desktop、engine-ts、docs、prompts 的符号链接),
   在副本里改、在副本里编。**绝不原地改项目里的源码**:别的助手、验收、审查随时在编项目,会把变异编进去(2026-10-20 出过两次:
   一次重启打断留下没还原的变异,一次验收编进了正在跑的变异)。
   变异检验:逐行改条件 / 边界 / 运算符,每个变异**在 finally 里还原并重编**(不重编会拿旧二进制给出假结果;
   make/ninja 按秒比时间戳,还原后把文件时间往后拨几秒)。幸存者要么补用例杀掉,要么写明为什么等价。
4. 交付报告:文件清单、夹具大小、变异计数与等价幸存者理由、照搬的 TS 怪行为、没移植 / 不确定的部分、对共享文件的请求。

## 位置

项目在 `~/Developer/ibkr`(2026-10-20 从 iCloud 同步的桌面搬过来)。旧的 `~/Desktop/ibkr-old` 只是备份,不读不写。

## 符号链接的坑(2026-10-20 吃过)

`work/accept/{desktop,docs,engine-ts,prompts}` 是指向**项目目录**的符号链接。**绝不通过它们 `rm`、`rsync --delete`、`mv` 或写入**:今天 21:23 项目里的
`desktop/node_modules/electron/dist/Electron.app` 被删掉了(所有对拍生成器因此跑不起来),很可能就是某个清理动作顺着这些链接删到了项目里。已从备份补回。
删东西之前先 `realpath` 确认目标在 `work/` 之内;`work/electron-backup/` 里留了一份 Electron.app,丢了就从那里 `cp -Rp` 回
`desktop/node_modules/electron/dist/`。

## 提速规则(2026-10-21,用户要求「加快速度,省略不必要的」)

钱路径(下单、改单、撤单、托管单、对账、回报落库、校验器、跟单授权、券商路由)**一条不省**。其余按下面走:

- **分级:** 钱路径 = 上面那些;其余(提醒、行情异动、情报、IV 记录、界面接口里的只读查询……)= 普通。
- **普通模块的变异检验:** 只做手挑的关键判断(约 15–30 个)+ 一轮机械变异的抽样,**不要跑全量、不要为每个幸存写理由、不要追着等价变异转圈**;幸存里有明显的测试缺口就补,其余一行带过。
- **普通模块的夹具:** 一次生成、读两次比对即可(不必留 3 个种子的放大版);大小超 3 MB 不用再裁。
- **ASan/UBSan:** 每个簇交付前跑一次(最终代码),之后改动不重跑,除非改了生命周期/线程代码。
- **报告:** 一页以内:文件、测试数、变异检验(捕获/幸存各几个)、与 TS 的差别、接口要求。别写流水账。
- **审查与验收:** 钱路径照旧两个都过;普通模块**只过一个**(验收,或审查,二选一,由我定),且只复核报告里的关键点,不再做放大 fuzz。
- **不等:** 依赖尚未交付的模块时,按头文件接口先写,不要停下来等对方的变异检验。
- 其余规则(私有副本里变异、不通过符号链接删东西、磁盘紧、Electron 备份)照旧。

