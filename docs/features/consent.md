# 条款同意

首次启动先看风险揭示、使用条款与隐私说明,三份都同意之后才进得去界面。这个软件会替人发真实订单,风险揭示要在用户开始依赖它之前看到。

## 三份文本

`docs/legal/` 下的 `risk-disclosure.md`(风险揭示)、`terms.md`(使用条款)、`privacy.md`(隐私说明)。界面显示的就是这三个文件:
`lib/legalText.ts` 用 Vite 的 `?raw` 原样引入,打包时也一并拷进 `resources/legal/`。

- 它们是草稿,没有经过律师审阅;发布者、联系方式、适用法律还是 `【发布前填写】`,`npm run release:check` 会拦住带着占位符的正式发布。
- 隐私说明里"发给谁、发什么"逐项对过代码。`tests/desktop-consent.spec.ts` 扫描引擎里会联网的六个文件,出现不在已知清单里的外部域名就失败,
  并检查隐私说明提到了 Yahoo Finance、Cboe、GitHub 与大模型服务商;引擎要连新的域名时,先改隐私说明,再把域名加进测试的清单。

## 同意的是某一版

- 三份文本第 3 行都是 `版本:YYYY-MM-DD`,三份一致,并且等于 `desktop/consent.js` 的 `TERMS_VERSION`。
- 用户同意时,界面把它显示的那一版的版本号交给主进程,对不上就不作数(界面上还是旧文本时这次同意无效)。
- 改任何一份的实质内容:三份的版本与 `TERMS_VERSION` 一起改成新日期,老用户下次启动会被要求重新确认。
- 记录在 `userData/consent.json`,只增不改:每同意一次追加一条(条款版本、时刻、当时的应用版本)。文件坏了按没同意过处理。

## 挡在哪

- **界面**(`shell/ConsentGate.tsx`):没同意现行条款之前,整个界面挡在同意页后面。三份都点开看过才能勾选,勾了才能点「同意并继续」;
  「不同意,退出」退出应用。
- **主进程**(`consent.blockedWithoutConsent`,在检查确认凭据之前):没同意之前,`instruction.submit`(`execute: true`)、`tracker.add` / `update` / `close_now`
  不放行;`settings.patch` 把任何一个执行闸门设成 `true` 也不放行。界面被绕过也过不去。
- 不挡:只解析不发单、只读的调用、连券商、熔断、关闸门。
- 引擎不知道条款这件事:已经打开自动执行的用户升级之后,引擎里的追踪照常运行,只是界面要先同意才进得去。
  命令行(`cli.js run`)有自己的 `--i-understand-this-places-real-orders`。

## 显示

不引 Markdown 库。`lib/docParse.ts` 只认五样东西(标题、段落、`-` 列表、`|` 表格、`**加粗**`),输出结构化的块,`lib/PlainDoc.tsx` 逐块画成 React 节点,
整条路上没有 `innerHTML`。条款里不能用别的语法(链接、图片、代码块、编号列表、引用),测试会拦下。

预览台地址后面加 `?consent=0` 看首次启动的样子;平时的演示数据当作已经同意过。
