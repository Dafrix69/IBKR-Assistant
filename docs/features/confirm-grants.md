# 确认凭据

会发单、授权发单、打开闸门、放宽限额、换券商的调用,主进程要拿到一张**一次性凭据**才放行。凭据只有一个来源:主进程自己弹出的原生确认框,
用户点了确认按钮。界面里即使跑进一段别人的脚本(例如某个依赖被投毒),直接调 `window.dafri.submit(…)` 也发不出单。

preload 给敏感调用带的 `__confirmed: true` 只说明调用是从这座桥上走的,不代表用户确认过。

## 哪些调用要凭据(`desktop/confirm-grants.js`)

| 用途(`purpose`) | 哪个调用要 | 绑着什么 |
|---|---|---|
| `instruction.submit` | `instruction.submit` 且 `execute: true` | 指令原文 + 账户别名列表 |
| `tracker.close_now` | `tracker.close_now` | 追踪 id |
| `tracker.add` | `tracker.add` 且带 `auto_close` 或 `host_at_broker` | 整个入参 |
| `broker.select` | `broker.select` | 券商名 |
| `gate.auto_execute` / `gate.allow_live_trading` | `settings.patch` 把这个闸门**从关改到开** | 无 |
| `limits.loosen` | `settings.patch` 把限额**往松了改** | 放宽的那几项与新值 |

不要凭据的:只解析不发单、只设提醒价位不授权发单的追踪、关闸门、收紧限额、熔断(不能挡)、删追踪、`tracker.update`。
主进程先检查条款同意(见 [条款同意](consent.md)),再检查凭据。新加会发单、授权发单、开闸门、放宽限额的通道,要进 `requiredGrants`。

## 规则

- **确认框最显眼的那一行由主进程按用途写**(`PURPOSES`),界面改不了;macOS 的消息框不显示 `title`,所以这一行放在 `message` 里。
- **发单的确认框**:第一行由主进程写,有实盘账户时写「发送真实订单(含实盘账户)」;下面先是界面提供的说明(截到 600 字),
  再是主进程写的「指令:」与「账户:」两行,指令取自绑定的那一份,账户是纸面还是实盘去问引擎(`system.status`)。
- **闸门与限额的确认框全部由主进程写**:限额从多少改到多少,按引擎此刻的设置计算。
- `tracker.close_now` 与 `broker.select` 的说明文字、追踪确认框上的价位几行由界面提供(要现取报价、现算),主进程只写标题;
  凭据绑的是整个入参,入参对不上照样不放行。
- **凭据绑的是摆给人看的那一份内容**:确认的是一句话、发的是另一句,不放行,那张凭据留给原来那句。
- **用一次作废,一分钟过期。** 一次调用要几张就得几张都在,差一张整个拒绝,已有的不浪费(`consumeAll`)。
- 键的顺序、值为 `undefined` 的键不影响指纹(`canonical`):界面拼的对象经过 IPC 后键的顺序不保证。

## 界面这一侧

调用之前先 `dafri.confirm({ purpose, binding, … })`,`binding` 和接下来那次调用的入参是同一份内容。`bridge.ts` 的 `ConfirmPurpose` 与主进程那张表由测试对照。
设置页保存:先过本地检查 → 要打开的闸门各确认一次(`auto_execute` 与 `allow_live_trading` 两个开关)
→ 有放宽的限额确认一次(没有放宽的主进程直接回 `true`,不弹框)→ `patchSettings`。

## 测试

- `tests/desktop-main.spec.ts` 把主进程真的跑起来:没同意条款不放行 → 同意了但没确认不放行 → 点了取消不发凭据 → 点了确认放行到引擎
  → 同一张凭据用不了第二次 → 改一个字不放行;开闸门与放宽限额的确认框上没有一个字来自界面。
- `tests/desktop-confirm-grants.spec.ts`:哪些调用要凭据、内容变了不放行、用途不通用、过期、`consumeAll`、界面与主进程算出的指纹相同;
  对着源码核对接线:核销在转给引擎之前、凭据在用户点了确认之后才发、确认框默认按钮是「取消」、界面上每个要凭据的调用之前都带着用途去确认。

## 还没做的

- **恢复一条暂停的追踪不用确认。** `tracker.update { enabled: true }` 会让一条带自动平仓的追踪重新生效;要不要每次暂停 / 恢复都弹一次框,是交互上的取舍,由用户决定。
- **确认的是原文,执行的是另一次解析。** 凭据绑的是指令原文,真正发出去的订单来自发送时的那一次解析;大模型两次解析同一句话可能不一样。
  根治要有一个"按已校验的那条记录发单"的引擎方法,要动 `engine.ts` 的 `handleInstruction`;方案见 `docs/reports/commercial-readiness-2026-09-28.md`。
