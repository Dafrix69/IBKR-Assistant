# datrix guard 部署

guard 做在 Datrix 的交易引擎里,所以"部署 guard"就是让 Datrix 一直开着、崩了自己起来、能把消息推到手机。
下面每一步都能照着做。**这些步骤在开发机上一步都没有真跑过**(沙箱里起不了图形界面,也装不了 launchd 任务),第一次请你自己照做并看结果。

## 1. 打开 guard

在应用数据目录的 `settings.json`(`~/Library/Application Support/Datrix/settings.json`)里加一段,存盘后重启 Datrix:

```json
"guard": {
  "enabled": true,
  "push": { "provider": "telegram", "telegram_chat_id": "你的 chat id" }
}
```

Pushover 写成 `"push": { "provider": "pushover", "pushover_user": "你的 user key" }`。其余各项不写就用默认值,含义见 `docs/features/guard.md`。

## 2. 推送

二选一,只需要一个。

### Telegram

1. 在 Telegram 里找 `@BotFather`,发 `/newbot`,按提示起名,拿到一串 bot token。
2. 给你的新 bot 随便发一句话。
3. 浏览器打开 `https://api.telegram.org/bot<token>/getUpdates`,在返回的 JSON 里找 `"chat":{"id":…}`,这个数就是 `telegram_chat_id`。

### Pushover

1. 在 pushover.net 注册,手机装 Pushover(一次性买断)。首页的 **User Key** 就是 `pushover_user`。
2. 在 「Create an Application/API Token」 建一个应用,拿到 **API Token**。

### 把 token 存进钥匙串

token 不写进 `settings.json`,只放钥匙串。在终端里:

```bash
security add-generic-password -U -s datrix-guard-push -a token -w '把 token 粘在这里'
```

第一次推送时 macOS 会弹窗问是否允许 `ibkr-engine` 读这条钥匙串,点 **始终允许**。引擎最多等 20 秒;没点就当这次没发出去,30 秒后再试。

### 试一下

往意图收件文件里写一行(交易库默认在 `~/Library/Application Support/dafri/`):

```bash
echo '{"push_test": true}' >> ~/Library/Application\ Support/dafri/guard/intents.jsonl
```

几秒内手机应当收到「Datrix:测试推送」。没收到就看同目录的 `heartbeat.json` 里 `push.last_error`(心跳 5 分钟写一次)。

## 3. 防睡眠

Datrix 开着时自己持有「不许空闲睡眠」的断言(`app/platform_mac.mm` 的 `preventAppSuspension`),不需要另外跑 `caffeinate`。
挡不住的是**合盖**:合上盖子 macOS 照样睡,睡着期间 Datrix 不盯盘、不推送。要合盖也不睡,只有两条路,都要你自己决定:

- 外接显示器 + 电源 + 键盘鼠标(合盖模式);
- `sudo pmset -a disablesleep 1`(彻底不睡,电池会耗尽;恢复用 `sudo pmset -a disablesleep 0`)。

## 4. 崩了自己起来(launchd)

Datrix 的界面进程崩了(或被强制结束),由 launchd 重新打开它;引擎子进程单独崩了,由界面自己约 3 秒内拉起(已有功能,不用配)。
两种情况重新起来后都会推一条「重启了」。

把下面存成 `~/Library/LaunchAgents/com.dafri.datrix.keepalive.plist`(路径按你装的位置改):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.dafri.datrix.keepalive</string>
  <key>ProgramArguments</key>
  <array><string>/Applications/Datrix.app/Contents/MacOS/Datrix</string></array>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
</dict>
</plist>
```

装之前**先 ⌘Q 退出正在开着的 Datrix**。Datrix 只许开一个:launchd 拉起来的那个发现已经有一个开着,会把它叫到前台然后自己正常退出(退出码 0),
launchd 就不再管了——你手动开的那个崩了不会有人拉。退出之后再装,装上就由 launchd 打开:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dafri.datrix.keepalive.plist
```

已经装过、想让 launchd 重新接手(比如中途手动开过一次):先 ⌘Q,再

```bash
launchctl kickstart -k gui/$(id -u)/com.dafri.datrix.keepalive
```

**要盯的一件事**:`kill -9` 之后单实例的锁是否会残留,没有核对过。如果被拉起来的 Datrix 在日志里只写一句「已经开着一个,叫它到前台」就退了、窗口没出来,
就是锁没放掉——把这个现象告诉我。

- `KeepAlive / SuccessfulExit = false`:只在**不是正常退出**时重新打开(崩溃、被 `kill -9`、退出码非 0)。你用 ⌘Q 正常退出,它不会再把 Datrix 打开。
  **前提是 ⌘Q 退出时退出码是 0,这一点没有核对过**:装好后 ⌘Q 一次,看 Datrix 是不是没被重新打开。
- `ThrottleInterval 10`:两次拉起至少隔 10 秒,所以 `kill -9` 之后 10–15 秒内会重新打开。
- `RunAtLoad`:登录时就打开。
- 要停掉这个任务(比如维护时):

```bash
launchctl bootout gui/$(id -u)/com.dafri.datrix.keepalive
```

- 不要同时在「系统设置 → 通用 → 登录项」里也加 Datrix,会开两遍(第二个会把第一个叫到前台然后自己退出,无害但多余)。

## 5. TWS

guard 只看得到 TWS 给的东西。TWS 自己每天会自动登出(你现在设在北京 23:45,冬令时是美东 10:45,在盘中),
登出后 guard 会在 2 分钟后推「IBKR 断开」——这是功能在起作用,不是坏了。想少收这一条,去 TWS 的「锁定与退出」里把自动登出挪到收盘后,
或者打开自动重启。已挂在券商的止损单不受 TWS 登出影响(见 `guard/README.md` 第 3 节)。

## 6. 验收(任务书 4.1)

- **拔网线 3 分钟**:推送和 IBKR 走的是同一根网线,线拔着时推送也发不出去。所以手机会在**插回网线之后**收到「IBKR 断开」与「IBKR 已恢复」,
  正文注明延迟了几分钟。判通过看的是:插回后一分钟内收到、写明断了约 3 分钟、`audit_log` 里有 `guard_disconnect` 与 `guard_reconnect`。
  要在断网当时就收到,得把 Datrix 放在另一台网络独立的机器上,或者给 Mac 接一条备用网络(手机热点)。
- **`kill -9` 界面进程**:`pkill -9 -x Datrix`,10–15 秒内 Datrix 重新打开,手机收到「Datrix重启了」。
- **`kill -9` 引擎**:`pkill -9 -x ibkr-engine`,约 3 秒内引擎被界面拉起,手机收到「交易引擎重启了」。

## 7. 放在 Windows 台式机上

Datrix 有 Windows 版。GUI 程序放进 NSSM 服务里跑没有桌面会话,窗口和托盘都起不来,不推荐。可行的是「任务计划程序」:

- 触发器:登录时;
- 操作:启动 `Datrix.exe`;
- 设置:勾「如果任务失败,重新启动」,间隔 1 分钟、最多 999 次;不勾「如果任务运行时间超过…则停止」。

台式机上要自己登 TWS(或在 Mac 的 TWS 里把台式机加进受信 IP)。推送的 token 要进 Windows 凭据管理器,
Datrix 在 Windows 上按什么名字去读、怎么从命令行写进去,没有核对过;这一节整体没有在 Windows 上试过。
