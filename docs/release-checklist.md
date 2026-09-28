# 发一个版本

照着做。每一步为什么是这样,见 [发版](features/release.md)。

## 之前

- [ ] `main` 上的 CI 是绿的(`ci` 工作流四个任务;`engine-ts-platforms` 在观察期内可以是黄的,但要看一眼它为什么黄)。
- [ ] 这一版动了钱路径(`engine.ts` `tracker.ts` `broker.ts` `store.ts` `flyexit.ts` `engine/*`、主进程的放行逻辑)的话:
      在**模拟账户**上走一遍——发单与确认框、立即平仓、托管单、重启引擎后的对账、熔断。`cd engine-ts && npm run probe` 先跑。
- [ ] 动了交易库结构的话:拿一份上一版的库(从自己的备份目录里拷)用新版打开,确认留了 `upgrade` 备份、数据都在。

## 版本号与说明

- [ ] `desktop/package.json` 的 `version` 改成新版本号。`engine-ts/package.json` 的版本在引擎有改动时一起改。
- [ ] `CHANGELOG.md`:把「未发布」改成 `## [x.y.z] - 年-月-日`,上面再留一个空的「未发布」。
      最要紧的写在前面——应用里只显示前 1,200 字。
- [ ] 改过条款文本的话:三份开头的「版本」与 `desktop/consent.js` 的 `TERMS_VERSION` 是同一个新日期。
- [ ] `docs/user-guide/` 里受影响的页面改了。

## 闸门

```bash
cd desktop && npm run release:check
```

- [ ] 通过。它查:版本号、CHANGELOG 里有这一版、条款文本里没有 `【发布前填写】`、示例配置的闸门是关的、开源许可在白名单里。

## 打包

- [ ] 本机先打一个看看:`cd desktop && npm run dist:mac`(有证书用 `dist:mac:signed`)。装上,启动,
      看「关于」页的版本、「关于 → 支持 → 第三方许可声明」打得开、条款同意页正常、引擎起得来。
- [ ] 推标签:`git tag vx.y.z && git push origin vx.y.z`。`安装包` 工作流会打两个平台的包、各自启动 30 秒、过一遍闸门、
      算校验和、发到 Releases。**任何一步不过都不会发。**

## 之后

- [ ] 发布页上有三样:`.dmg`、`.exe`、`SHA256SUMS.txt`;更新说明是这一版的内容。
- [ ] 在一台装着上一版的机器上点「关于 → 检查更新」,看得到新版本;装上去,配置、交易库、备份都还在。
- [ ] 出了问题:**不要覆盖已经发出去的版本**。改版本号,发补丁版本。

## 第一次正式发售之前(一次性)

- [ ] 条款文本请律师审过,占位符填了(`docs/legal/README.md`)。
- [ ] 代码签名证书:macOS 的 Developer ID、Windows 的证书。配进仓库 Secrets(`package.yml` 开头写着要哪几个)。
- [ ] 产品名、许可方式、销售渠道定了(`docs/reports/commercial-readiness-2026-09-28.md` 的「要你来定的事」)。
- [ ] 支持渠道(邮箱或别的)定了,写进条款文本与「关于」页。
