# 发一个版本

照着做。背后的规则见 [发版](features/release.md)。

## 之前

- [ ] `qt` 上的 CI(`native` 工作流,macOS 与 Windows 两路)是绿的。
- [ ] 这一版动了钱路径(`native/engine/orchestrate/`、`native/engine/broker/`、托管单与追踪)的话:
      在**模拟账户**上走一遍——发单、立即平仓、托管单、重启引擎后的对账。
- [ ] 动了交易库结构的话:拿一份上一版的库(从自己的备份目录里拷)用新版打开,确认留了 `upgrade` 备份、数据都在。

## 版本号与说明

- [ ] `native/CMakeLists.txt` 的 `project(... VERSION x.y.z)` 改成新版本号。
- [ ] `CHANGELOG.md`:把「未发布」改成 `## [x.y.z] - 年-月-日`,上面再留一个空的「未发布」。
      最要紧的写在前面——应用里只显示前 1,200 字。
- [ ] 改过条款文本的话:三份开头的「版本」与 `native/shell/consent.h` 的 `kTermsVersion` 是同一个新日期。
- [ ] `docs/user-guide/` 里受影响的页面改了。

## 发布

- [ ] 在普通终端里跑 `native/tools/package_mac.sh`(见 [打包](features/packaging.md)),出 `~/Developer/ibkr/work/dist/Datrix-<版本>.dmg`。
      装上,启动,看「关于」页的版本、条款同意页正常、引擎起得来。
- [ ] 推标签:`git tag vx.y.z && git push origin vx.y.z`,在 GitHub 上建 Release,挂上 DMG,说明取 CHANGELOG 里这一版的那一节。

## 之后

- [ ] 在一台装着上一版的机器上点「关于 → 检查更新」,看得到新版本;装上去,配置、交易库、备份都还在。
- [ ] 出了问题:**不要覆盖已经发出去的版本**。改版本号,发补丁版本。

## 第一次正式发售之前(一次性)

- [ ] 条款文本请律师审过,占位符填了(`docs/legal/README.md`)。
- [ ] 代码签名证书:macOS 的 Developer ID、Windows 的证书。
- [ ] 产品名、许可方式、销售渠道定了(`docs/reports/commercial-readiness-2026-09-28.md` 的「要你来定的事」)。
- [ ] 支持渠道(邮箱或别的)定了,写进条款文本与「关于」页。
